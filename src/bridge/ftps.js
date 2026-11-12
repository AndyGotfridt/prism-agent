import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, enterPassiveModeIPv4 } from 'basic-ftp';
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
// Tope duro por comando, pase lo que pase con la librería FTP: si una transferencia no termina, se cierra el cliente y se
// libera la cola (si no, un solo put colgado traba TODAS las transferencias y las cámaras hasta reiniciar el puente).
const HARD_LIMIT_HEAVY_MS = 9 * 60_000;
const HARD_LIMIT_LIGHT_MS = 90_000;
// Tras el último byte la impresora tarda en grabar/descomprimir antes de contestar «226»; una A1 con un 3MF pesado pasa de 3 min.
const CONTROL_TIMEOUT_PUT_MS = 5 * 60_000;
// Si el «226» no llega, el archivo suele haber quedado bien guardado igual: se le pregunta el tamaño a la impresora con una
// conexión nueva (a veces sigue ocupada grabando, de ahí los reintentos) antes de dar el envío por fallido.
const ARRIVAL_CHECK_TRIES = 6;
const ARRIVAL_CHECK_EVERY_MS = 10_000;


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

const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
let curlOk;
/** ¿Hay un `curl` en el PATH? (macOS, Linux y Windows 10+ lo traen). Se pregunta una vez. */
function hasCurl() {
    curlOk ??= spawnSync(CURL, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;

    return curlOk;
}

/** Corta una lectura al llegar al tope: se usa como señal para abortar el RETR. */
class HeadDone extends Error {}

export class FtpService {
    /** @param {{ getApi: () => import('../api.js').Api | null, camera?: import('./camera.js').CameraService }} hooks */
    constructor({ getApi, camera }) {
        this.getApi = getApi;
        this.camera = camera;
        this.chains = new Map(); // printer id → cola (promesa)
        this.clients = new Map(); // printer id → clientes FTP abiertos (para cortarlos si el comando pasa el tope duro)
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
            if (!heavy) return this.withCameraHeld(printer, () => this.withHardLimit(printer, cmd, HARD_LIMIT_LIGHT_MS, () => this.execute(printer, cmd)));

            return this.exclusive(async () => {
                expired(); // pudo vencer esperando la transferencia de la otra impresora
                // Una transferencia a la vez: se cortan las cámaras de TODAS las impresoras, no sólo la de ésta.
                this.camera?.holdAll();
                try {
                    return await this.withCameraHeld(printer, () => this.withHardLimit(printer, cmd, HARD_LIMIT_HEAVY_MS, () => this.execute(printer, cmd)));
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

    /**
     * Corre `fn` con un tope de tiempo que NO depende de que la librería FTP rechace su promesa: al vencer se cierran los
     * clientes abiertos de la impresora y se devuelve un error, así la cola y las pausas de cámara se liberan siempre.
     */
    async withHardLimit(printer, cmd, ms, fn) {
        let timer;
        const limit = new Promise((_, reject) => {
            timer = setTimeout(() => {
                warn(`Puente: ${cmd.type} #${cmd.id} a «${printer.name}» pasó el tope de ${Math.round(ms / 1000)} s; corto la conexión y libero la cola`);
                for (const client of this.clients.get(printer.id) ?? []) client.close();
                reject(new Error(`La impresora no terminó la operación en ${Math.round(ms / 1000)} s (se cortó la conexión). Reintentá; si sigue, reiniciala.`));
            }, ms);
        });
        const work = fn();
        work.catch(() => {}); // si el tope gana, el error tardío de `work` no queda sin atender

        try {
            return await Promise.race([work, limit]);
        } finally {
            clearTimeout(timer);
        }
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
        // PASV clásico, como el curl del server (CURLOPT_FTP_USE_EPSV=false): las Bambu manejan mal EPSV, que basic-ftp prueba primero.
        client.prepareTransfer = enterPassiveModeIPv4;
        const open = this.clients.get(printer.id) ?? new Set();
        open.add(client);
        this.clients.set(printer.id, open);
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
            open.delete(client);
            if (open.size === 0 && this.clients.get(printer.id) === open) this.clients.delete(printer.id);
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
     * se informa en las dos etapas (`phase`: `download` = server → puente, `upload` = puente → impresora) para que la web muestre el paso 1 y el 2.
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
            const downProgress = this.progressReporter(api, cmd.id, 'download');
            await downProgress(0, declared, true);
            let got = 0;
            const counter = new Transform({
                transform(chunk, _enc, cb) {
                    got += chunk.length;
                    downProgress(got, declared);
                    cb(null, chunk);
                },
            });
            await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmp));
            const expected = statSync(tmp).size;
            if (declared && expected !== declared) throw new Error(`Se bajaron ${expected} bytes del server y se esperaban ${declared}`);

            const progress = this.progressReporter(api, cmd.id, 'upload');
            await progress(0, expected, true);
            log(`Puente: subiendo «${remote}» a «${printer.name}» (${Math.round(expected / 1024 / 1024)} MB)`);

            // 5 min sin respuesta del control: al terminar los datos la impresora tarda en grabar el archivo antes de contestar «226».
            const uploadBasic = () => this.withClient(printer, async (c) => {
                // Latido: el server da por muerto un envío tras 90 s sin avance, y la impresora puede tardar más que eso en
                // grabar el archivo antes de contestar «226». Se avisa cada 15 s con lo último que se sabe.
                let sent = 0;
                let lastBytesAt = Date.now();
                let stalled = false;
                let arrived = false;
                let checking = false;
                let sameSize = 0;
                log(`Puente: conectado a «${printer.name}» por FTPS, empieza la subida de «${remote}»`);
                const beat = setInterval(() => progress(sent, expected, true), 15_000);
                // Diagnóstico: bytes y velocidad cada 10 s, para ver si la subida avanza lento o se frena del todo.
                const startedAt = Date.now();
                const trace = setInterval(() => {
                    const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
                    log(`[ftp-debug] «${printer.name}» ${remote}: ${sent}/${expected} bytes a los ${secs} s (${Math.round(sent / 1024 / secs)} KB/s), último byte hace ${Math.round((Date.now() - lastBytesAt) / 1000)} s`);
                }, 10_000);
                // Perro guardián: sin un solo byte nuevo en 60 s la subida se corta (si no, la cola única de transferencias y
                // la cámara de esa impresora quedan trabadas hasta los 180 s del control, o para siempre si el socket no avisa).
                const dog = setInterval(() => {
                    if (sent < expected && Date.now() - lastBytesAt > STALL_MS) {
                        stalled = true;
                        c.close();
                    }
                }, 5_000);
                // Terminados los datos la A1 tarda en grabar antes del «226»: en vez de esperarlo hasta 5 min, se le pregunta el
                // tamaño por otra conexión y, con el archivo completo en dos consultas seguidas, se da por enviado.
                const arrival = setInterval(async () => {
                    if (checking || arrived || sent < expected) return;
                    checking = true;
                    const size = await this.withClient(printer, (x) => x.size(remote), 15_000).catch(() => null);
                    checking = false;
                    sameSize = size === expected ? sameSize + 1 : 0;
                    if (sameSize >= 2 && !arrived) {
                        arrived = true;
                        warn(`Puente: «${printer.name}» ya tiene «${remote}» completo (${expected} bytes) y no confirma (226): se da por enviado`);
                        c.close();
                    }
                }, ARRIVAL_CHECK_EVERY_MS);
                c.trackProgress((info) => {
                    if (info.bytes > sent) lastBytesAt = Date.now();
                    sent = info.bytes;
                    progress(info.bytes, expected);
                });
                try {
                    await c.uploadFrom(createReadStream(tmp), remote);
                } catch (err) {
                    if (arrived) return;
                    if (stalled) throw new Error(`La impresora dejó de recibir datos a los ${sent} de ${expected} bytes (sin avance por ${STALL_MS / 1000} s). Revisá el Wi-Fi de la impresora o reiniciala.`);
                    throw err;
                } finally {
                    clearInterval(beat);
                    clearInterval(trace);
                    clearInterval(dog);
                    clearInterval(arrival);
                    c.trackProgress();
                }
                log(`Puente: «${remote}» enviado a «${printer.name}», verificando tamaño`);
                const size = await c.size(remote).catch(() => null);
                if (expected && size !== null && size !== expected) throw new Error(`La impresora quedó con ${size} bytes y se esperaban ${expected}`);
            }, CONTROL_TIMEOUT_PUT_MS);
            // curl, como el server: `basic-ftp` dejaba a la impresora sin atender (MQTT mudo, subida que no termina) con el mismo archivo que curl sube bien.
            const upload = hasCurl() ? () => this.uploadCurl(printer, tmp, remote, expected, progress) : uploadBasic;

            try {
                await upload();
            } catch (err) {
                if (/timeout/i.test(String(err.message)) && (await this.arrivedIntact(printer, remote, expected))) {
                    warn(`Puente: «${printer.name}» no confirmó (226) «${remote}», pero el archivo está completo (${expected} bytes): se da por enviado`);
                } else if (String(err.code) !== '550') {
                    throw err;
                } else {
                    await this.retryAfter550(printer, remote, err, upload);
                }
            }
            await progress(expected, expected, true);

            return {};
        } finally {
            rmSync(tmp, { force: true });
        }
    }

    /**
     * Sube `file` con `curl` (hijo): el access code viaja por stdin (`-K -`), nunca en los argumentos. El avance sale del
     * medidor `-#` (porcentaje); el perro guardián, el latido y el chequeo de llegada son los de la subida por librería.
     */
    async uploadCurl(printer, file, remote, expected, progress) {
        const q = (v) => `"${String(v).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
        const config = [
            `user = ${q(`bblp:${printer.access_code}`)}`,
            `url = ${q(`ftps://${printer.lan_ip}:990/${encodeURIComponent(remote)}`)}`,
            `upload-file = ${q(file)}`,
            'insecure',
            'disable-epsv',
            'progress-bar',
            `max-time = ${HARD_LIMIT_HEAVY_MS / 1000 - 30}`,
        ].join('\n');

        const child = spawn(CURL, ['-K', '-'], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
        const open = this.clients.get(printer.id) ?? new Set();
        const handle = { close: () => child.kill() }; // el tope duro lo corta como a un cliente FTP
        open.add(handle);
        this.clients.set(printer.id, open);

        let sent = 0;
        let lastBytesAt = Date.now();
        let stalled = false;
        let arrived = false;
        let checking = false;
        let sameSize = 0;
        let tail = '';
        const startedAt = Date.now();
        log(`Puente: conectado a «${printer.name}» por FTPS (curl), empieza la subida de «${remote}»`);
        child.stderr.on('data', (d) => {
            tail = (tail + d.toString()).slice(-2000);
            const pcts = [...tail.matchAll(/(\d+(?:\.\d+)?)%/g)];
            if (pcts.length === 0) return;
            const bytes = Math.min(expected, Math.round((Number(pcts[pcts.length - 1][1]) / 100) * expected));
            if (bytes > sent) lastBytesAt = Date.now();
            sent = Math.max(sent, bytes);
            progress(sent, expected);
        });
        const beat = setInterval(() => progress(sent, expected, true), 15_000);
        const trace = setInterval(() => {
            const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
            log(`[ftp-debug] «${printer.name}» ${remote}: ~${sent}/${expected} bytes a los ${secs} s (${Math.round(sent / 1024 / secs)} KB/s), último avance hace ${Math.round((Date.now() - lastBytesAt) / 1000)} s`);
        }, 10_000);
        const dog = setInterval(() => {
            if (sent < expected && Date.now() - lastBytesAt > STALL_MS) {
                stalled = true;
                child.kill();
            }
        }, 5_000);
        const arrival = setInterval(async () => {
            if (checking || arrived || sent < expected) return;
            checking = true;
            const size = await this.withClient(printer, (x) => x.size(remote), 15_000).catch(() => null);
            checking = false;
            sameSize = size === expected ? sameSize + 1 : 0;
            if (sameSize >= 2 && !arrived) {
                arrived = true;
                warn(`Puente: «${printer.name}» ya tiene «${remote}» completo (${expected} bytes) y no confirma (226): se da por enviado`);
                child.kill();
            }
        }, ARRIVAL_CHECK_EVERY_MS);

        try {
            child.stdin.on('error', () => {});
            child.stdin.end(config);
            const code = await new Promise((resolve, reject) => {
                child.on('error', reject);
                child.on('close', (c) => resolve(c));
            });
            if (arrived || code === 0) return;
            if (stalled) throw new Error(`La impresora dejó de recibir datos cerca de los ${sent} de ${expected} bytes (sin avance por ${STALL_MS / 60_000} min). Revisá el Wi-Fi de la impresora o reiniciala.`);
            const msg = tail.replaceAll(printer.access_code, '***').replace(/[#\s]*\d+(?:\.\d+)?%/g, '').trim().slice(-300);
            const err = new Error(`curl terminó con código ${code}${msg ? `: ${msg}` : ''}`);
            if (/\b550\b/.test(tail)) err.code = '550';
            else if (code === 28) err.message = `Timeout: ${err.message}`;
            throw err;
        } finally {
            clearInterval(beat);
            clearInterval(trace);
            clearInterval(dog);
            clearInterval(arrival);
            child.kill();
            open.delete(handle);
            if (open.size === 0 && this.clients.get(printer.id) === open) this.clients.delete(printer.id);
        }
    }

    /**
     * ¿Quedó el archivo completo en la impresora aunque el control FTP no confirmó? Pregunta el tamaño con conexiones nuevas,
     * hasta ARRIVAL_CHECK_TRIES veces: una A1 que sigue grabando no contesta o devuelve un tamaño parcial. Nunca lanza.
     */
    async arrivedIntact(printer, remote, expected) {
        if (!expected) return false;
        for (let i = 0; i < ARRIVAL_CHECK_TRIES; i++) {
            if (i > 0) await new Promise((resolve) => setTimeout(resolve, ARRIVAL_CHECK_EVERY_MS));
            const size = await this.withClient(printer, (c) => c.size(remote), 20_000).catch(() => null);
            if (size === expected) return true;
        }

        return false;
    }

    /** `550` = la impresora rechazó escribir (homónimo a medias bloqueado): se borra y se reintenta UNA vez. */
    async retryAfter550(printer, remote, err, upload) {
        // Lo más común es un homónimo a medias de un envío cortado (queda bloqueado). Si sigue, el motivo real es la SD o la impresora.
        warn(`Puente: «${printer.name}» rechazó la subida de «${remote}» (${err.message}); borro el archivo anterior y reintento una vez`);
        await this.withClient(printer, (c) => c.remove(remote).catch(() => {}));
        try {
            await upload();
        } catch (again) {
            if (String(again.code) !== '550') throw again;
            throw new Error(`La impresora rechazó guardar «${remote}» (${again.message}). Revisá que tenga tarjeta SD, que no esté llena ni protegida, y que no esté ocupada; si sigue, reiniciala.`);
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
    progressReporter(api, commandId, phase = null) {
        let last = 0;

        return async (done, total, force = false) => {
            const now = Date.now();
            if (!force && now - last < 1_000) return;
            last = now;
            try {
                await api.post(`/bridge/commands/${commandId}/progress`, { done: Math.max(0, Math.floor(done)), total: Math.max(0, Math.floor(total)), ...(phase ? { phase } : {}) });
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
