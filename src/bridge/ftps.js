import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client } from 'basic-ftp';
import { log, warn } from '../log.js';

/**
 * Archivos de las impresoras Bambu por FTPS implícito (:990, usuario `bblp`, certificado autofirmado), lo que
 * hace `BambuLanUploader` en el server (docs/PLAN-AGENT-BRIDGE.md, fase 4). Lo que pide el server son seis
 * comandos de una lista cerrada: `ftp.size`, `ftp.list`, `ftp.head`, `ftp.delete`, `ftp.put`, `ftp.get`.
 *
 * Reglas:
 * - Una operación FTPS por impresora a la vez: los servidores de las Bambu se atragantan con conexiones en
 *   paralelo. Lo que espera en la cola respeta el vencimiento del comando (si ya venció, no se ejecuta).
 * - Las subidas y bajadas de archivos (`ftp.put`/`ftp.get`) van de a una en TODO el puente, no sólo por impresora:
 *   dos de 15 MB a la vez por el mismo Wi-Fi/máquina dejaban a las dos con «Timeout (control socket)».
 * - Mientras corre un comando FTP la cámara de esa impresora queda en pausa (`CameraService.hold`) y durante un
 *   `ftp.put`/`ftp.get` se pausan las de todas (`holdAll`): una A1/P1 saturada con FTPS + TLS de cámara + MQTT deja de contestar.
 * - `ftp.put` sólo escribe en la raíz (nombre plano). Ninguna ruta puede salirse con `..`.
 * - El access code no se loguea ni se escribe a disco.
 */
const CHUNK_BYTES = 32 * 1024 * 1024; // Cloudflare corta en 100 MB; mismas partes que «Por importar»
const MAX_HEAD_BYTES = 8 * 1024 * 1024;
const STALL_MS = 60_000; // sin bytes nuevos durante la subida a la impresora: se corta


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
    /** @param {{ getApi: () => import('../api.js').Api | null, camera?: import('./camera.js').CameraService }} hooks */
    constructor({ getApi, camera }) {
        this.getApi = getApi;
        this.camera = camera;
        this.chains = new Map(); // printer id → cola (promesa)
        this.heavyTail = Promise.resolve(); // cola única de put/get de todas las impresoras
    }

    /** Una transferencia de archivo a la vez en todo el puente. */
    exclusive(fn) {
        const turn = this.heavyTail.then(fn);
        this.heavyTail = turn.catch(() => {});

        return turn;
    }

    /** Ejecuta un comando FTP de esa impresora, de a uno por vez. */
    run(printer, cmd) {
        const prev = this.chains.get(printer.id) ?? Promise.resolve();
        const expired = () => {
            if (Date.now() > cmd.deadline) throw new Error('El comando venció esperando su turno en la cola de la impresora');
        };
        const heavy = cmd.type === 'ftp.put' || cmd.type === 'ftp.get';
        const job = prev.catch(() => {}).then(() => {
            expired();
            if (!heavy) return this.withCameraHeld(printer, () => this.execute(printer, cmd));

            return this.exclusive(async () => {
                expired(); // pudo vencer esperando la transferencia de la otra impresora
                // Una transferencia a la vez: se cortan las cámaras de TODAS las impresoras, no sólo la de ésta.
                this.camera?.holdAll();
                try {
                    return await this.withCameraHeld(printer, () => this.execute(printer, cmd));
                } finally {
                    this.camera?.releaseAll();
                }
            });
        });
        const tail = job.catch(() => {});
        this.chains.set(printer.id, tail);
        tail.then(() => {
            if (this.chains.get(printer.id) === tail) this.chains.delete(printer.id);
        });

        return job;
    }

    /** Corta la cámara de esa impresora mientras dure un comando FTP (el `ftp.size` previo a un envío ya la molestaba). */
    async withCameraHeld(printer, fn) {
        this.camera?.hold(printer.id);
        try {
            return await fn();
        } finally {
            this.camera?.release(printer.id);
        }
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
            const wrapped = new Error(String(err.message ?? err).replaceAll(printer.access_code, '***'));
            wrapped.code = err.code; // el código FTP (550…) sirve a quien decide si reintentar
            throw wrapped;
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

    /**
     * Server → impresora en DOS etapas: primero baja el archivo entero al puente (temporal), y recién ahí lo sube por
     * FTPS desde el disco, a la velocidad de la red local. En una sola etapa (streaming) la impresora quedaba atada
     * a la velocidad de la descarga: con el stream lento o cortado, el canal de control moría en `Timeout`. El avance
     * que ve el usuario es el de la subida a la impresora (lo único lento e incierto); bajar al puente no informa.
     */
    async put(printer, cmd, remote) {
        const api = this.getApi();
        if (!api) throw new Error('Sin conexión con el server');
        const token = String(cmd.payload?.token ?? '');
        if (!/^[A-Za-z0-9]{20,100}$/.test(token)) throw new Error('Token de archivo inválido');

        const tmp = join(tmpdir(), `prisma-bridge-put-${cmd.id}.part`);
        try {
            const res = await api.request('GET', `/bridge/files/${token}`, { raw: true });
            if (!res.ok || !res.body) throw new Error(`El server no entregó el archivo (HTTP ${res.status})`);
            const declared = Number(cmd.payload?.size) || Number(res.headers.get('content-length')) || 0;

            log(`Puente: bajando «${remote}» del server (${Math.round(declared / 1024 / 1024)} MB)`);
            await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
            const expected = statSync(tmp).size;
            if (declared && expected !== declared) throw new Error(`Se bajaron ${expected} bytes del server y se esperaban ${declared}`);

            const progress = this.progressReporter(api, cmd.id);
            log(`Puente: subiendo «${remote}» a «${printer.name}» (${Math.round(expected / 1024 / 1024)} MB)`);

            // 180 s sin respuesta del control: al terminar los datos la impresora tarda en grabar el archivo antes de contestar «226».
            const upload = () => this.withClient(printer, async (c) => {
                // Latido: el server da por muerto un envío tras 90 s sin avance, y la impresora puede tardar más que eso en
                // grabar el archivo antes de contestar «226». Se avisa cada 15 s con lo último que se sabe.
                let sent = 0;
                let lastBytesAt = Date.now();
                let stalled = false;
                log(`Puente: conectado a «${printer.name}» por FTPS, empieza la subida de «${remote}»`);
                const beat = setInterval(() => progress(sent, expected, true), 15_000);
                // Perro guardián: sin un solo byte nuevo en 60 s la subida se corta (si no, la cola única de transferencias y
                // la cámara de esa impresora quedan trabadas hasta los 180 s del control, o para siempre si el socket no avisa).
                const dog = setInterval(() => {
                    if (sent < expected && Date.now() - lastBytesAt > STALL_MS) {
                        stalled = true;
                        c.close();
                    }
                }, 5_000);
                c.trackProgress((info) => {
                    if (info.bytes > sent) lastBytesAt = Date.now();
                    sent = info.bytes;
                    progress(info.bytes, expected);
                });
                try {
                    await c.uploadFrom(createReadStream(tmp), remote);
                } catch (err) {
                    if (stalled) throw new Error(`La impresora dejó de recibir datos a los ${sent} de ${expected} bytes (sin avance por ${STALL_MS / 1000} s). Revisá el Wi-Fi de la impresora o reiniciala.`);
                    throw err;
                } finally {
                    clearInterval(beat);
                    clearInterval(dog);
                    c.trackProgress();
                }
                log(`Puente: «${remote}» enviado a «${printer.name}», verificando tamaño`);
                const size = await c.size(remote).catch(() => null);
                if (expected && size !== null && size !== expected) throw new Error(`La impresora quedó con ${size} bytes y se esperaban ${expected}`);
            }, 180_000);

            try {
                await upload();
            } catch (err) {
                if (String(err.code) !== '550') throw err;
                // 550 = la impresora rechazó escribir ese archivo. Lo más común es un homónimo a medias de un envío cortado
                // (queda bloqueado): se borra y se reintenta UNA vez. Si sigue, el motivo real es la SD o la impresora.
                warn(`Puente: «${printer.name}» rechazó la subida de «${remote}» (${err.message}); borro el archivo anterior y reintento una vez`);
                await this.withClient(printer, (c) => c.remove(remote).catch(() => {}));
                try {
                    await upload();
                } catch (again) {
                    if (String(again.code) !== '550') throw again;
                    throw new Error(`La impresora rechazó guardar «${remote}» (${again.message}). Revisá que tenga tarjeta SD, que no esté llena ni protegida, y que no esté ocupada; si sigue, reiniciala.`);
                }
            }
            await progress(expected, expected, true);

            return {};
        } finally {
            rmSync(tmp, { force: true });
        }
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
