import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Client } from 'basic-ftp';
import { log } from '../log.js';

/**
 * Archivos de las impresoras Bambu por FTPS implícito (:990, usuario `bblp`, certificado autofirmado), lo que
 * hace `BambuLanUploader` en el server (docs/PLAN-AGENT-BRIDGE.md, fase 4). Lo que pide el server son seis
 * comandos de una lista cerrada: `ftp.size`, `ftp.list`, `ftp.head`, `ftp.delete`, `ftp.put`, `ftp.get`.
 *
 * Reglas:
 * - Una operación FTPS por impresora a la vez: los servidores de las Bambu se atragantan con conexiones en
 *   paralelo. Lo que espera en la cola respeta el vencimiento del comando (si ya venció, no se ejecuta).
 * - `ftp.put` sólo escribe en la raíz (nombre plano). Ninguna ruta puede salirse con `..`.
 * - El access code no se loguea ni se escribe a disco.
 */
const CHUNK_BYTES = 32 * 1024 * 1024; // Cloudflare corta en 100 MB; mismas partes que «Por importar»
const MAX_HEAD_BYTES = 8 * 1024 * 1024;

/** Ruta remota segura: sin `..`, sin barras invertidas ni bytes raros. `flat` = sin carpetas (subidas). */
export function cleanRemote(name, { flat = false, allowEmpty = false } = {}) {
    const value = String(name ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (value === '') {
        if (allowEmpty) return '';
        throw new Error('Falta el nombre del archivo');
    }
    if (value.length > 240 || /[\0\\\r\n]/.test(value)) throw new Error('Nombre de archivo inválido');
    if (value.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) throw new Error('Ruta inválida');
    if (flat && value.includes('/')) throw new Error('Las subidas van a la raíz de la impresora');

    return value;
}

/** Corta una lectura al llegar al tope: se usa como señal para abortar el RETR. */
class HeadDone extends Error {}

export class FtpService {
    /** @param {{ getApi: () => import('../api.js').Api | null }} hooks */
    constructor({ getApi }) {
        this.getApi = getApi;
        this.chains = new Map(); // printer id → cola (promesa)
    }

    /** Ejecuta un comando FTP de esa impresora, de a uno por vez. */
    run(printer, cmd) {
        const prev = this.chains.get(printer.id) ?? Promise.resolve();
        const job = prev.catch(() => {}).then(() => {
            if (Date.now() > cmd.deadline) throw new Error('El comando venció esperando su turno en la cola de la impresora');

            return this.execute(printer, cmd);
        });
        const tail = job.catch(() => {});
        this.chains.set(printer.id, tail);
        tail.then(() => {
            if (this.chains.get(printer.id) === tail) this.chains.delete(printer.id);
        });

        return job;
    }

    async execute(printer, cmd) {
        const p = cmd.payload ?? {};
        switch (cmd.type) {
            case 'ftp.size':
                return this.withClient(printer, async (c) => {
                    try {
                        return { size: await c.size(cleanRemote(p.remote)) };
                    } catch {
                        return { size: null }; // no existe (o no se pudo preguntar)
                    }
                });
            case 'ftp.list':
                return this.withClient(printer, async (c) => {
                    const dir = cleanRemote(p.dir, { allowEmpty: true });
                    const entries = await c.list(dir === '' ? '/' : `/${dir}`);

                    return {
                        entries: entries.map((e) => ({
                            name: e.name,
                            size: e.isDirectory ? null : e.size,
                            is_dir: e.isDirectory,
                            raw_mtime: e.rawModifiedAt || null,
                        })),
                    };
                });
            case 'ftp.delete':
                return this.withClient(printer, async (c) => {
                    await c.remove(cleanRemote(p.remote));

                    return {};
                });
            case 'ftp.head':
                return this.head(printer, cleanRemote(p.remote), Math.min(MAX_HEAD_BYTES, Math.max(1024, Number(p.max_bytes) || 1024 * 1024)));
            case 'ftp.put':
                return this.put(printer, cmd, cleanRemote(p.remote, { flat: true }));
            case 'ftp.get':
                return this.get(printer, cmd, cleanRemote(p.remote));
            default:
                throw new Error(`El puente no conoce el comando «${cmd.type}»`);
        }
    }

    /** Una conexión FTPS por operación, siempre cerrada. */
    async withClient(printer, fn, timeoutMs = 30_000) {
        const client = new Client(timeoutMs);
        try {
            await client.access({
                host: printer.lan_ip,
                port: 990,
                user: 'bblp',
                password: printer.access_code,
                secure: 'implicit',
                secureOptions: { rejectUnauthorized: false, checkServerIdentity: () => undefined },
            });

            return await fn(client);
        } catch (err) {
            throw new Error(String(err.message ?? err).replaceAll(printer.access_code, '***'));
        } finally {
            client.close();
        }
    }

    /** Los primeros `max` bytes (el servidor FTP de Bambu no soporta REST: se lee desde el 0 y se corta). */
    async head(printer, remote, max) {
        const chunks = [];
        let total = 0;
        await this.withClient(printer, async (c) => {
            const sink = new Writable({
                write(chunk, _enc, cb) {
                    chunks.push(chunk);
                    total += chunk.length;
                    cb(total >= max ? new HeadDone() : undefined);
                },
            });
            try {
                await c.downloadTo(sink, remote);
            } catch (err) {
                if (!(err instanceof HeadDone) && total < max) throw err; // cortar a propósito no es un error
            }
        });

        return { data: Buffer.concat(chunks).subarray(0, max).toString('base64') };
    }

    /** Server → impresora: baja el archivo con el token y lo sube por FTPS, informando el avance. */
    async put(printer, cmd, remote) {
        const api = this.getApi();
        if (!api) throw new Error('Sin conexión con el server');
        const token = String(cmd.payload?.token ?? '');
        if (!/^[A-Za-z0-9]{20,100}$/.test(token)) throw new Error('Token de archivo inválido');

        const res = await api.request('GET', `/bridge/files/${token}`, { raw: true });
        if (!res.ok || !res.body) throw new Error(`El server no entregó el archivo (HTTP ${res.status})`);
        const expected = Number(cmd.payload?.size) || Number(res.headers.get('content-length')) || 0;

        const progress = this.progressReporter(api, cmd.id);
        log(`Puente: subiendo «${remote}» a «${printer.name}» (${Math.round(expected / 1024 / 1024)} MB)`);

        await this.withClient(printer, async (c) => {
            c.trackProgress((info) => progress(info.bytes, expected));
            try {
                await c.uploadFrom(Readable.fromWeb(res.body), remote);
            } finally {
                c.trackProgress();
            }
            const size = await c.size(remote).catch(() => null);
            if (expected && size !== null && size !== expected) throw new Error(`La impresora quedó con ${size} bytes y se esperaban ${expected}`);
        }, 60_000);
        await progress(expected, expected, true);

        return {};
    }

    /** Impresora → server: baja el archivo a un temporal y lo sube en partes de 32 MB con sha256. */
    async get(printer, cmd, remote) {
        const api = this.getApi();
        if (!api) throw new Error('Sin conexión con el server');
        const transfer = String(cmd.payload?.transfer ?? '');
        if (!/^[0-9a-f-]{36}$/.test(transfer)) throw new Error('Transferencia inválida');

        const tmp = join(tmpdir(), `prisma-bridge-${transfer}.part`);
        const progress = this.progressReporter(api, cmd.id);
        try {
            await this.withClient(printer, async (c) => {
                const total = await c.size(remote).catch(() => 0);
                c.trackProgress((info) => progress(info.bytes, total));
                try {
                    await c.downloadTo(createWriteStream(tmp), remote);
                } finally {
                    c.trackProgress();
                }
            }, 60_000);

            const { size } = statSync(tmp);
            const sha256 = await sha256Of(tmp);
            const chunks = Math.max(1, Math.ceil(size / CHUNK_BYTES));
            for (let i = 0; i < chunks; i++) {
                const start = i * CHUNK_BYTES;
                const body = await readRange(tmp, start, Math.min(size, start + CHUNK_BYTES) - 1);
                await retry(() => api.put(`/bridge/transfers/${transfer}/chunks/${i}`, body));
            }
            await retry(() => api.post(`/bridge/transfers/${transfer}/complete`, { chunks, size, sha256 }));
            await progress(size, size, true);

            return { size };
        } finally {
            rmSync(tmp, { force: true });
        }
    }

    /** Avance al server como mucho una vez por segundo (`force` manda el último sí o sí). */
    progressReporter(api, commandId) {
        let last = 0;

        return async (done, total, force = false) => {
            const now = Date.now();
            if (!force && now - last < 1_000) return;
            last = now;
            try {
                await api.post(`/bridge/commands/${commandId}/progress`, { done: Math.max(0, Math.floor(done)), total: Math.max(0, Math.floor(total)) });
            } catch {
                // el avance es cosmético: no corta la transferencia
            }
        };
    }
}

function sha256Of(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(path).on('data', (d) => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
    });
}

/** Lee [start, end] (inclusive) de un archivo. Una parte son 32 MB como mucho: entra en memoria. */
function readRange(path, start, end) {
    return new Promise((resolve, reject) => {
        const parts = [];
        createReadStream(path, { start, end }).on('data', (d) => parts.push(d)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
    });
}

async function retry(fn, attempts = 3) {
    for (let i = 1; ; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i >= attempts || err.status === 422 || err.status === 403) throw err;
            await new Promise((r) => setTimeout(r, 1000 * i));
        }
    }
}
