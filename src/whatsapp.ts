import makeWASocket, {areJidsSameUser, delay, DisconnectReason, fetchLatestWaWebVersion, isJidGroup, useMultiFileAuthState, WAMessageStatus, WASocket} from "baileys";
import pino from "pino";
import path from "path";
import * as fs from "fs";
import {Boom} from "@hapi/boom";
import signale from "signale";
import * as os from "os";
import mime from 'mime';
import {readPhoneNumber} from "./utils";
import * as QRCode from 'qrcode-terminal';

export const globalOptions = {
    logLevel: 'trace',
    connectTimeoutMs: 3_000,
    defaultQueryTimeoutMs: 6_000
}

export const mudslideFooter = '\u2B50 Please star Mudslide on GitHub! https://github.com/robvanderleek/mudslide';

export function getAuthStateCacheFolderLocation() {
    if (process.env.MUDSLIDE_CACHE_FOLDER) {
        return process.env.MUDSLIDE_CACHE_FOLDER;
    } else {
        const homedir = os.homedir();
        if (process.platform === 'win32') {
            return path.join(homedir, 'AppData', 'Local', 'mudslide', 'Data');
        } else {
            return path.join(homedir, '.local', 'share', 'mudslide');
        }
    }
}

function clearCacheFolder() {
    const folder = initAuthStateCacheFolder();
    fs.readdirSync(folder).forEach(f => f.endsWith(".json") && fs.rmSync(`${folder}/${f}`));
}

function initAuthStateCacheFolder() {
    const folderLocation = getAuthStateCacheFolderLocation();
    if (!fs.existsSync(folderLocation)) {
        fs.mkdirSync(folderLocation, {recursive: true});
        signale.log(`Created mudslide cache folder: ${folderLocation}`);
    }
    return folderLocation;
}

export async function initWASocket(message?: string): Promise<WASocket> {
    const {state, saveCreds} = await useMultiFileAuthState(initAuthStateCacheFolder());
    const os = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
    const {version} = await fetchLatestWaWebVersion({});
    const socket = makeWASocket({
        connectTimeoutMs: globalOptions.connectTimeoutMs,
        defaultQueryTimeoutMs: globalOptions.defaultQueryTimeoutMs,
        logger: pino({level: globalOptions.logLevel}),
        auth: state,
        browser: [os, 'Chrome', '10.15.0'],
        version: version,
        syncFullHistory: false,
        getMessage: async _ => {
            return {
                conversation: message
            }
        }
    });
    socket.ev.on('creds.update', async () => await saveCreds());
    return socket;
}

// A pairwise session can sit forever with libsignal's `pendingPreKey` still set if the
// recipient device never confirms the handshake (haveOpenSession() treats it as valid
// regardless — see libsignal's session_record.js). Worse, Baileys' own group-send fanout
// (messages-send.js) decides whether to (re)send a device the group's SenderKeyDistribution
// Message purely from a *separate* `sender-key-memory` flag ("have I already sent this
// device the key"), not from whether the underlying session actually succeeded — so once
// that flag is set true (e.g. from an attempt whose session never got confirmed), Baileys
// will keep skipping that device forever, even on a fully fresh session. Both pieces of
// state have to be cleared together for a stuck device to actually get re-keyed:
//  1. The dead session itself, via signalRepository.deleteSession — so Baileys' own (non-
//     forced) assertSessions() call during the next send fetches a real fresh prekey bundle
//     instead of reusing session state that was never confirmed.
//  2. This group's sender-key-memory entry for that device — otherwise Baileys believes the
//     key was already delivered and never re-sends it, no matter how fresh the session is.
export async function forceRekeyIfSessionUnconfirmed(socket: any, groupJid: string, participantJids: string[]) {
    if (!participantJids.length) {
        return [];
    }
    // Group fanout happens per-device (e.g. 5007965425843:35@lid), not per-participant — this
    // is the same lookup Baileys itself uses to decide who needs the SenderKeyDistributionMessage.
    const devices: Array<{ jid: string }> = await socket.getUSyncDevices(participantJids, false, false);
    const staleDeviceJids: string[] = [];
    for (const {jid: deviceJid} of devices) {
        try {
            const addr = socket.signalRepository.jidToSignalProtocolAddress(deviceJid);
            const {[addr]: record} = await socket.authState.keys.get('session', [addr]);
            const sessions = record?._sessions ? Object.values(record._sessions) : [];
            const hasUnconfirmedPreKey = sessions.some((s: any) => !!s?.pendingPreKey);
            signale.log(`Session check for ${deviceJid} (addr ${addr}): ${
                !record ? 'no session on file' : hasUnconfirmedPreKey ? 'UNCONFIRMED (pendingPreKey set)' : 'confirmed'
            }`);
            if (hasUnconfirmedPreKey) {
                staleDeviceJids.push(deviceJid);
            }
        } catch (err) {
            signale.warn(`Could not inspect session for ${deviceJid}, skipping stale-session check for it: ${err}`);
        }
    }
    if (staleDeviceJids.length) {
        signale.warn(`Unconfirmed session(s) found — clearing dead session + sender-key-memory flag so Baileys re-delivers the group key to: ${staleDeviceJids.join(', ')}`);
        await socket.signalRepository.deleteSession(staleDeviceJids);
        const {[groupJid]: existingSenderKeyMap} = await socket.authState.keys.get('sender-key-memory', [groupJid]);
        const updatedSenderKeyMap = {...(existingSenderKeyMap || {})};
        for (const deviceJid of staleDeviceJids) {
            delete updatedSenderKeyMap[deviceJid];
        }
        await socket.authState.keys.set({'sender-key-memory': {[groupJid]: updatedSenderKeyMap}});
        signale.success(`Cleared stale session + sender-key-memory state for: ${staleDeviceJids.join(', ')} — this send should now re-deliver the group key.`);
    }
    return staleDeviceJids;
}

// Group-send entry point for the check above: resolves the group's participants and
// runs the stale-session check/fix against all of their devices except our own.
export async function forceRekeyStaleGroupSessions(socket: any, whatsappId: string) {
    if (!isJidGroup(whatsappId)) {
        return [];
    }
    const metadata = await socket.groupMetadata(whatsappId);
    const participantJids = (metadata?.participants || [])
        .map((p: any) => p.id)
        .filter((jid: string) => !areJidsSameUser(jid, socket.user?.id));
    return forceRekeyIfSessionUnconfirmed(socket, whatsappId, participantJids);
}

export async function terminate(socket: any, waitSeconds = 1) {
    if (waitSeconds > 0) {
        signale.await(`Closing WA connection, waiting for ${waitSeconds} second(s)...`);
    }
    await delay(waitSeconds * 1000);
    socket.end(undefined);
    if (socket.ws && socket.ws.isOpen) {
        await socket.ws.close();
    }
    console.info(mudslideFooter);
    process.exit();
}

export function checkLoggedIn() {
    if (!fs.existsSync(path.join(initAuthStateCacheFolder(), 'creds.json'))) {
        signale.error('Not logged in');
        process.exit(1);
    }
}

export function checkValidFile(path: string) {
    if (!(fs.existsSync(path) && fs.lstatSync(path).isFile())) {
        signale.error(`Could not read image file: ${path}`);
        process.exit(1);
    }
}

export function isLoggedOutDisconnect(lastDisconnect: any): boolean {
    return (lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.loggedOut;
}

export function parseGeoLocation(latitude: string, longitude: string): Array<number> {
    const latitudeFloat = parseFloat(latitude);
    const longitudeFloat = parseFloat(longitude);
    if (isNaN(latitudeFloat) || isNaN(longitudeFloat)) {
        signale.error(`Invalid geo location: ${latitude}, ${longitude}`);
        process.exit(1);
    }
    return [parseFloat(latitudeFloat.toFixed(7)), parseFloat(longitudeFloat.toFixed(7))];
}

export async function waitForKey(message: string) {
    signale.pause(message);
    if (process.stdin.isTTY)
        process.stdin.setRawMode(true);
    return new Promise(resolve => process.stdin.once('data', () => {
        if (process.stdin.isTTY)
            process.stdin.setRawMode(false);
        resolve(undefined);
    }));
}

async function loginSecondPass() {
    signale.info('Restart required, logging in again...');
    const socket = await initWASocket();
    socket.ev.on('connection.update', async (update) => {
        const {connection} = update;
        if (connection === 'open') {
            await waitForKey("Wait until WhatsApp finishes connecting, then press any key to exit");
            await terminate(socket);
            signale.success('Logged in');
        }
    });
}

export async function loginWithPairingCode() {
    const number = await readPhoneNumber();
    const socket = await initWASocket();
    socket.ev.on('connection.update', async (update) => {
        const {connection, lastDisconnect} = update;
        if (connection == "connecting") {
            signale.await('Waiting 5 seconds before requesting pairing code');
            await delay(5000);
            const pairingCode = await socket.requestPairingCode(number);
            if (pairingCode && pairingCode.length === 8) {
                signale.info('In the WhatsApp mobile app go to "Settings > Connected Devices > ');
                signale.info('Connect Device" and enter the following pairing code:');
                signale.info(pairingCode.substring(0, 4) + '-' + pairingCode.substring(4, 8));
            }
        } else if (connection === 'close') {
            if ((lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.restartRequired) {
                await loginSecondPass();
            } else {
                signale.error('Device was disconnected from WhatsApp, use "logout" command first');
                return;
            }
        }
    });
}

export async function loginWithQrCode() {
    const socket = await initWASocket();
    socket.ev.on('connection.update', async (update) => {
        const {connection, lastDisconnect, qr} = update;
        if (qr) {
            signale.info('In the WhatsApp mobile app go to "Settings > Connected Devices > ');
            signale.info('Connect Device" and scan the QR code below');
            QRCode.generate(qr, {small: true});
        }
        if (connection === 'close') {
            if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
                await loginSecondPass();
            } else {
                signale.error('Device was disconnected from WhatsApp, use "logout" command first');
                return;
            }
        }
    });
}

export async function logout() {
    checkLoggedIn();
    const socket = await initWASocket();
    let exiting = false;
    socket.ev.on('connection.update', async (update) => {
        const {connection} = update
        if (exiting) {
            return;
        } else if ((update.connection === undefined && update.qr) || connection === 'close') {
            exiting = true;
            clearCacheFolder();
            signale.success(`Logged out`);
            await terminate(socket);
        } else if (connection === 'open') {
            exiting = true;
            await socket.logout();
            clearCacheFolder();
            signale.success(`Logged out`);
            await terminate(socket);
        }
    });
    process.on('exit', clearCacheFolder);
}

export function onConnectionOpen(socket: any, onOpen: () => Promise<void>) {
    const onConnectionUpdate = async (update: any) => {
        const {connection, lastDisconnect} = update;
        if (connection === 'open') {
            socket.ev.off('connection.update', onConnectionUpdate);
            await onOpen();
        } else if (connection === 'close') {
            signale.error(isLoggedOutDisconnect(lastDisconnect) ? 'Device unlinked from WhatsApp' : 'Connection closed unexpectedly');
            socket.end(undefined);
            process.exit(1);
        }
    };
    socket.ev.on('connection.update', onConnectionUpdate);
}

export async function getWhatsAppId(socket: any, recipient: string) {
    if (recipient.startsWith('+')) {
        recipient = recipient.substring(1);
    }
    if (recipient.endsWith('@s.whatsapp.net') || recipient.endsWith('@g.us')) {
        return recipient;
    } else if (recipient === 'me') {
        const user = await socket.user;
        if (user) {
            const phoneNumber = user.id.substring(0, user.id.indexOf(':'));
            return `${phoneNumber}@s.whatsapp.net`;
        }
    }
    return `${recipient}@s.whatsapp.net`;
}

export type SendChecksOptions = {
    liveCheck?: boolean,
    typing?: number,
    waitAck?: number
}

export async function checkNumberExistsOnWhatsApp(socket: any, whatsappId: string): Promise<boolean> {
    const result = await socket.onWhatsApp(whatsappId);
    return !!result?.[0]?.exists;
}

export async function simulateTyping(socket: any, whatsappId: string, ms: number) {
    await socket.sendPresenceUpdate('composing', whatsappId);
    await delay(ms);
    await socket.sendPresenceUpdate('paused', whatsappId);
}

export async function waitForDeliveryAck(socket: any, key: any, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const cleanup = () => {
            clearTimeout(timer);
            socket.ev.off('messages.update', onUpdate);
        };
        const onUpdate = (updates: any[]) => {
            for (const {key: updateKey, update} of updates) {
                if (updateKey.id === key.id && update.status >= WAMessageStatus.DELIVERY_ACK) {
                    cleanup();
                    resolve(true);
                    return;
                }
            }
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);
        socket.ev.on('messages.update', onUpdate);
    });
}

export async function sendPayload(socket: any, whatsappId: string, payload: any, options: SendChecksOptions = {}) {
    if (options.liveCheck) {
        const exists = await checkNumberExistsOnWhatsApp(socket, whatsappId);
        if (!exists) {
            signale.error(`Recipient does not exist on WhatsApp: ${whatsappId}`);
            socket.end(undefined);
            process.exit(1);
        }
    }
    if (options.typing) {
        await simulateTyping(socket, whatsappId, options.typing);
    }
    const result = await socket.sendMessage(whatsappId, payload);
    signale.log('DEBUG sendPayload result', JSON.stringify({whatsappId, result}));
    signale.success('Done');
    if (options.waitAck) {
        const delivered = await waitForDeliveryAck(socket, result.key, options.waitAck);
        if (delivered) {
            signale.success('Delivered');
        } else {
            signale.error(`No delivery acknowledgement within ${options.waitAck}ms`);
        }
    }
    await terminate(socket, 3);
}

export async function sendImageHelper(socket: any, whatsappId: string, filePath: string, options: {
    caption: string | undefined
} & SendChecksOptions) {
    const payload = {image: fs.readFileSync(filePath), caption: handleNewlines(options.caption)}
    await sendPayload(socket, whatsappId, payload, options);
}

export async function sendFileHelper(socket: any, whatsappId: string, filePath: string,
                                     options: { caption: string | undefined, type: 'audio' | 'video' | 'document' } & SendChecksOptions) {
    const payload: any = {
        mimetype: mime.getType(filePath),
        caption: handleNewlines(options.caption)
    };
    switch (options.type) {
        case "audio":
            payload['audio'] = fs.readFileSync(filePath);
            break;
        case "video":
            payload['video'] = fs.readFileSync(filePath);
            break;
        default:
            payload['document'] = fs.readFileSync(filePath);
            payload['fileName'] = path.basename(filePath)
    }
    await sendPayload(socket, whatsappId, payload, options);
}

export function handleNewlines(s?: string): string | undefined {
    if (s) {
        return s.replace(/\\n/g, '\n');
    }
}
