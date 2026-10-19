import { connect as tlsConnect } from 'node:tls';
import { ApiError } from '../api.js';
import { log, warn } from '../log.js';

/**
 * Cámara de cabina de las Bambu A1/P1 (protocolo `chamber_image`, TCP 6000 con TLS; no es RTSP). Igual que
 * `BambuCameraClient` en PHP: un paquete de auth de 80 bytes (header de 4 enteros LE 0x40, 0x3000, 0, 0 +
 * usuario `bblp` en 32 bytes + access code en 32) y después un stream de frames, cada uno con un header de 16
 * bytes cuyo primer entero LE es el tamaño del JPEG que sigue.
 *
 * Los frames sólo suben al server mientras alguien mira (docs/PLAN-AGENT-BRIDGE.md §6): el server contesta 409
 * cuando nadie mira y ahí se corta el stream. El access code vive sólo en memoria y no se loguea.
 */
const PORT = 6000;
const MAX_FRAME_BYTES = 6_000_000;
const CONNECT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 10_000;

/** Paquete de autenticación de 80 bytes. */
export function authPacket(accessCode) {
    const buf = Buffer.alloc(80);
    buf.writeUInt32LE(0x40, 0);
    buf.writeUInt32LE(0x3000, 4);
    buf.write('bblp', 16, 32, 'ascii');
    buf.write(String(accessCode), 48, 32, 'ascii');

    return buf;
}

/** Arma frames JPEG a partir de los pedazos que llegan del socket. Tira error si el stream se desincroniza. */
export class FrameParser {
    constructor() {
        this.buf = Buffer.alloc(0);
    }

    /** @returns {Buffer[]} los frames completos que ya se pueden entregar */
    push(chunk) {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        const frames = [];
        while (this.buf.length >= 16) {
            const size = this.buf.readUInt32LE(0);
            if (size <= 0 || size > MAX_FRAME_BYTES) throw new Error(`Tamaño de frame inverosímil: ${size}`);
            if (this.buf.length < 16 + size) break;
            const jpeg = this.buf.subarray(16, 16 + size);
            this.buf = this.buf.subarray(16 + size);
            if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[size - 2] !== 0xff || jpeg[size - 1] !== 0xd9) throw new Error('El frame no es un JPEG válido');
            frames.push(Buffer.from(jpeg)); // copia: no retener el buffer grande
        }

        return frames;
    }
}

/**
 * Abre la cámara y llama a `onFrame(jpeg)` por cada frame hasta que devuelva false (o se cierre).
 * Resuelve al terminar; rechaza si no pudo conectar o el stream falló.
 *
 * @param {{ lan_ip: string, access_code: string }} printer
 * @param {(jpeg: Buffer) => boolean | void | Promise<boolean | void>} onFrame
 * @param {{ signal?: AbortSignal }} [opts]
 */
export function streamFrames(printer, onFrame, { signal } = {}) {
    return new Promise((resolve, reject) => {
        const sock = tlsConnect({ host: printer.lan_ip, port: PORT, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS }, () => {
            sock.setTimeout(READ_TIMEOUT_MS);
            sock.write(authPacket(printer.access_code));
        });
        const parser = new FrameParser();
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            signal?.removeEventListener('abort', onAbort);
            sock.destroy();
            err ? reject(err) : resolve();
        };
        const onAbort = () => finish();
        signal?.addEventListener('abort', onAbort);
        if (signal?.aborted) return finish();

        sock.on('timeout', () => finish(new Error('La cámara no mandó datos (¿Developer Mode / modo LAN?)')));
        sock.on('error', (err) => finish(new Error(err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ETIMEDOUT' ? 'Cámara apagada o fuera de la red' : err.message)));
        sock.on('close', () => finish());
        sock.on('data', (chunk) => {
            if (done) return;
            try {
                for (const jpeg of parser.push(chunk)) {
                    if (onFrame(jpeg) === false) return finish();
                }
            } catch (err) {
                finish(err);
            }
        });
    });
}

/** Un frame suelto (conexión corta). Rechaza si no llega en `timeoutMs`. */
export async function snapshotOnce(printer, timeoutMs = 8_000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let frame = null;
    try {
        await streamFrames(printer, (jpeg) => {
            frame = jpeg;

            return false;
        }, { signal: ctl.signal });
    } finally {
        clearTimeout(timer);
    }
    if (!frame) throw new Error('La cámara no mandó ningún frame');

    return frame;
}

/**
 * Cámara en vivo bajo demanda: una sesión por impresora que sube 1 frame por segundo mientras el server
 * siga pidiéndolo (`watch` la renueva) y hasta que `until` venza. Un 409 del server (nadie mira) la corta.
 */
export class CameraService {
    /** @param {{ getApi: () => import('../api.js').Api | null }} hooks */
    constructor({ getApi }) {
        this.getApi = getApi;
        this.sessions = new Map(); // printer id → { until, ctl }
    }

    /** Empieza (o extiende) el stream de una impresora durante `seconds`. */
    watch(printer, seconds) {
        const until = Date.now() + Math.min(300, Math.max(5, seconds)) * 1000;
        const current = this.sessions.get(printer.id);
        if (current) {
            current.until = Math.max(current.until, until);

            return;
        }
        const session = { until, ctl: new AbortController() };
        this.sessions.set(printer.id, session);
        this.run(printer, session).finally(() => {
            if (this.sessions.get(printer.id) === session) this.sessions.delete(printer.id);
        });
    }

    async run(printer, session) {
        log(`Puente: cámara de «${printer.name}» en vivo`);
        let lastUp = 0;
        let uploading = false;
        let backoff = 2_000;

        while (Date.now() < session.until && !session.ctl.signal.aborted) {
            try {
                await streamFrames(printer, (jpeg) => {
                    backoff = 2_000;
                    if (Date.now() >= session.until) return false;
                    const now = Date.now();
                    // 1 fps y de a un POST: si el anterior sigue en vuelo, este frame se descarta.
                    if (uploading || now - lastUp < 1_000) return true;
                    uploading = true;
                    lastUp = now;
                    this.upload(printer, jpeg)
                        .then((keep) => {
                            if (!keep) session.ctl.abort();
                        })
                        .catch((err) => {
                            if (!(err instanceof ApiError && err.retryable)) warn(`Puente: no se pudo subir el frame de «${printer.name}»: ${err.message}`);
                        })
                        .finally(() => {
                            uploading = false;
                        });

                    return true;
                }, { signal: session.ctl.signal });
            } catch (err) {
                warn(`Puente: cámara de «${printer.name}»: ${err.message}`);
            }
            if (session.ctl.signal.aborted || Date.now() >= session.until) break;
            await new Promise((r) => setTimeout(r, backoff));
            backoff = Math.min(15_000, backoff * 2);
        }
        log(`Puente: cámara de «${printer.name}» cortada`);
    }

    /** @returns {Promise<boolean>} false si el server ya no quiere frames (409) */
    async upload(printer, jpeg, commandId = null) {
        const api = this.getApi();
        if (!api) return false;
        try {
            await api.request('POST', `/bridge/printers/${printer.id}/frame`, {
                body: jpeg,
                headers: { 'Content-Type': 'image/jpeg', ...(commandId ? { 'X-Bridge-Command': String(commandId) } : {}) },
            });

            return true;
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) return false;
            throw err;
        }
    }

    /** `camera.snapshot`: un frame suelto subido con el id del comando (el server lo acepta aunque nadie mire). */
    async snapshot(printer, commandId) {
        const jpeg = await snapshotOnce(printer);
        await this.upload(printer, jpeg, commandId);

        return { bytes: jpeg.length };
    }

    stop() {
        for (const s of this.sessions.values()) s.ctl.abort();
        this.sessions.clear();
    }
}
