import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { watch } from 'chokidar';
import { ApiError } from './api.js';
import { ensureDir } from './fs-util.js';
import { log, warn } from './log.js';
import { STATE_DIR } from './state.js';
import { sha256File, withRetry } from './uploader.js';

/**
 * Sincronización de carpetas locales con Google Drive (sólo local → Drive).
 *
 * El agente es «tonto»: recorre la carpeta, le cuenta al server qué hay (ruta, tamaño,
 * sha256) y sube lo que el server le pide. El contenido va **directo a Google** por una
 * sesión de subida resumible que abre el server: el agente no tiene credenciales de Google ni
 * el archivo pasa por Laravel. Las reglas (qué subir, qué borrar en Drive, guardas) viven en
 * App\Services\GoogleDrive\DriveSyncService. Detalle en docs/PLAN-AGENT-DRIVE-SYNC.md.
 */

/** 32 MiB: múltiplo de 256 KiB, como pide Google para las partes de una subida resumible. */
const CHUNK_BYTES = 128 * 262144;
const PLAN_BATCH = 100;
const FULL_SCAN_EVERY_MS = 6 * 60 * 60 * 1000;
const RETRY_SCAN_MS = 10 * 60 * 1000;
const DELETE_DEBOUNCE_MS = 5000;
const CACHE_DIR = join(STATE_DIR, 'drive-sync');
const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `~`, `~/x` y `~\x` (Windows) → ruta absoluta en la home. */
function expandHome(path) {
    if (path === '~') return homedir();
    return /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

/** Ocultos, temporales y archivos de bloqueo de Office: no se sincronizan. */
function ignoredName(name) {
    return name.startsWith('.') || name.startsWith('~$') || IGNORED_NAMES.has(name.toLowerCase()) || /\.(tmp|part|crdownload|download|partial)$/i.test(name);
}

/** Ruta relativa con `/` y en NFC (macOS devuelve nombres en NFD). */
function relPath(root, abs) {
    return relative(root, abs).split(sep).join('/').normalize('NFC');
}

async function* walk(root, onError) {
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            onError(dir, err);
            continue;
        }
        for (const entry of entries) {
            if (ignoredName(entry.name)) continue;
            const abs = join(dir, entry.name);
            if (entry.isDirectory()) stack.push(abs);
            else if (entry.isFile()) yield abs;
            // Enlaces simbólicos y archivos especiales: no se siguen.
        }
    }
}

function readPart(path, start, length) {
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
            const n = readSync(fd, buffer, read, length - read, start + read);
            if (n === 0) break;
            read += n;
        }
        return read === length ? buffer : buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}

class SessionExpired extends Error {}

/**
 * Sube `path` a la URL de una sesión resumible de Google, en partes. Devuelve el id del
 * archivo en Drive. Ante un corte pregunta a Google hasta dónde llegó y sigue de ahí.
 */
async function putResumable(sessionUrl, path, size, { onBytes } = {}) {
    let offset = 0;
    let failures = 0;

    const send = async (headers, body) => {
        const res = await fetch(sessionUrl, { method: 'PUT', headers, body });
        const text = await res.text();
        return { status: res.status, range: res.headers.get('range'), text };
    };

    const finished = (res) => {
        try {
            return JSON.parse(res.text).id;
        } catch {
            throw new Error('Google no devolvió el id del archivo.');
        }
    };

    // Dónde quedó la subida (también sirve para saber si ya terminó).
    const queryOffset = async () => {
        const res = await send({ 'Content-Range': `bytes */${size}` }, undefined);
        if (res.status === 200 || res.status === 201) return { done: finished(res) };
        if (res.status === 308) {
            const m = /bytes=0-(\d+)/.exec(res.range ?? '');
            return { offset: m ? Number(m[1]) + 1 : 0 };
        }
        if (res.status === 404 || res.status === 410) throw new SessionExpired('La sesión de subida venció.');
        throw new Error(`Google respondió ${res.status} al consultar la subida.`);
    };

    while (offset < size) {
        const end = Math.min(size, offset + CHUNK_BYTES);
        const part = readPart(path, offset, end - offset);

        let res;
        try {
            res = await send({ 'Content-Range': `bytes ${offset}-${end - 1}/${size}` }, part);
        } catch {
            res = { status: 0 }; // red caída
        }

        if (res.status === 200 || res.status === 201) return finished(res);

        if (res.status === 308) {
            const m = /bytes=0-(\d+)/.exec(res.range ?? '');
            offset = m ? Number(m[1]) + 1 : 0;
            failures = 0;
            onBytes?.(offset);
            continue;
        }

        if (res.status === 404 || res.status === 410) throw new SessionExpired('La sesión de subida venció.');

        // Red o 5xx de Google: reintento con backoff, retomando donde Google dice que quedó.
        if (res.status === 0 || res.status >= 500 || res.status === 429) {
            if (++failures > 6) throw new Error(`Google no respondió (${res.status || 'sin conexión'}).`);
            await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)));
            try {
                const state = await queryOffset();
                if (state.done) return state.done;
                offset = state.offset;
            } catch (err) {
                if (err instanceof SessionExpired) throw err;
                // Sigue sin responder: el próximo intento vuelve a probar.
            }
            continue;
        }

        throw new Error(`Google rechazó la subida (${res.status}).`);
    }

    // Todo enviado pero sin el 200 final (raro): se pregunta cómo quedó.
    const state = await queryOffset();
    if (state.done) return state.done;
    throw new Error('La subida no terminó en Google.');
}

/** Una carpeta local sincronizada: revisión completa + watcher + borrados. */
class SyncTask {
    constructor(host, spec) {
        this.host = host;
        this.spec = spec;
        this.id = spec.id;
        this.name = spec.name;
        this.root = resolve(expandHome(spec.local_path));
        this.stopped = false;
        this.watcher = null;
        this.chain = Promise.resolve();
        this.pending = new Set(); // rutas absolutas con add/change
        this.removed = new Set(); // rutas absolutas con unlink
        this.removeTimer = null;
        this.cache = this.loadCache();
        this.cacheDirty = false;
        this.progress = null; // { seen, planned, processed, uploaded, failed, walking, current } durante una revisión
        this.scanTimer = null;
        this.retryTimer = null;
        this.scanning = false;
        this.scanQueued = false;
    }

    api() {
        return this.host.api();
    }

    path(suffix) {
        return `/drive-sync/${this.id}${suffix}`;
    }

    // --- Ciclo de vida --------------------------------------------------------------------

    start() {
        log(`Drive sync «${this.name}»: ${this.root}`);
        this.startWatcher();
        // La primera revisión, apenas arranca el agente (con el resto de las tareas ya en marcha).
        setTimeout(() => this.requestScan('start'), 3000).unref();
        this.scanTimer = setInterval(() => this.requestScan('periodic'), FULL_SCAN_EVERY_MS);
        this.scanTimer.unref();
    }

    async stop() {
        this.stopped = true;
        clearInterval(this.scanTimer);
        clearTimeout(this.retryTimer);
        clearTimeout(this.removeTimer);
        await this.watcher?.close();
        this.saveCache();
    }

    shouldStop() {
        return this.stopped || this.host.isPaused();
    }

    /** Encadena trabajo para que revisión y eventos del watcher no se pisen. */
    enqueue(fn) {
        this.chain = this.chain.then(fn).catch((err) => warn(`Drive sync «${this.name}»: ${err.message}`));
        return this.chain;
    }

    requestScan(reason) {
        if (this.stopped) return;
        if (this.scanning || this.scanQueued) {
            this.scanQueued = true;
            return;
        }
        this.scanQueued = true;
        this.enqueue(async () => {
            this.scanQueued = false;
            await this.scan(reason);
        });
    }

    // --- Caché local (ruta → tamaño, mtime, sha256) ---------------------------------------

    cacheFile() {
        return join(CACHE_DIR, `${this.id}.json`);
    }

    loadCache() {
        try {
            const data = JSON.parse(readFileSync(this.cacheFile(), 'utf8'));
            return data.root === this.root ? data.files ?? {} : {};
        } catch {
            return {};
        }
    }

    saveCache() {
        if (!this.cacheDirty) return;
        try {
            ensureDir(CACHE_DIR);
            writeFileSync(this.cacheFile(), JSON.stringify({ root: this.root, files: this.cache }));
            this.cacheDirty = false;
        } catch (err) {
            warn(`Drive sync «${this.name}»: no se pudo guardar el caché: ${err.message}`);
        }
    }

    /** Tamaño, mtime y sha256 de un archivo; el hash sólo se recalcula si cambió. */
    async fileInfo(abs) {
        const st = await stat(abs);
        const rel = relPath(this.root, abs);
        const cached = this.cache[rel];
        let sha256 = cached && cached[0] === st.size && cached[1] === st.mtimeMs ? cached[2] : null;

        if (sha256 === null) {
            sha256 = await sha256File(abs);
            this.cache[rel] = [st.size, st.mtimeMs, sha256];
            this.cacheDirty = true;
        }

        return { abs, path: rel, size: st.size, mtimeMs: st.mtimeMs, sha256 };
    }

    // --- Revisión completa ----------------------------------------------------------------

    async scan(reason) {
        if (this.shouldStop()) return;
        this.scanning = true;
        const scanId = randomUUID();
        let incomplete = false;
        let aborted = false;
        let uploaded = 0;
        let failed = 0;
        let seen = 0;
        let processed = 0;
        let planned = 0; // archivos que el server pidió subir (crece mientras se recorre la carpeta)
        let walking = true;
        let error = null;
        const publish = (current = null) => {
            this.progress = { seen, planned, processed, uploaded, failed, walking, current };
        };

        try {
            if (!existsSync(this.root) || !statSync(this.root).isDirectory()) {
                await withRetry('drive-sync error', () => this.api().post(this.path('/error'), { message: `La carpeta ${this.spec.local_path} no existe en esta computadora.` }));
                warn(`Drive sync «${this.name}»: la carpeta no existe`);
                this.scheduleRetry();

                return;
            }

            this.startWatcher(); // si la carpeta recién apareció (disco montado después)
            log(`Drive sync «${this.name}»: scan (${reason})`);
            publish();
            this.host.status(`Drive · ${this.name}: comprobando…`);
            await withRetry('drive-sync scan', () => this.api().post(this.path('/scan'), { scan_id: scanId }));

            const batch = [];
            const flush = async () => {
                if (batch.length === 0) return;
                const files = batch.splice(0);
                const { data } = await withRetry('drive-sync plan', () =>
                    this.api().post(this.path('/plan'), { scan_id: scanId, files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })) }),
                );
                const wanted = new Set(data.upload);
                planned += wanted.size;
                for (const file of files) {
                    if (!wanted.has(file.path)) continue;
                    if (this.shouldStop()) {
                        aborted = true;

                        return;
                    }
                    // «12 de 340+»: el «+» hasta terminar de recorrer (el total todavía puede crecer).
                    publish(basename(file.path));
                    const pct = Math.floor((processed / Math.max(planned, 1)) * 100);
                    this.host.status(`Drive · ${this.name}: ${pct}% · subiendo ${processed + 1} de ${planned}${walking ? '+' : ''} · ${basename(file.path)}`);
                    const result = await this.pushFile(file);
                    processed++;
                    if (result === 'uploaded') uploaded++;
                    else if (result === 'failed') failed++;
                    publish(basename(file.path));
                }
            };

            for await (const abs of walk(this.root, (dir, err) => {
                incomplete = true;
                warn(`Drive sync «${this.name}»: no se pudo leer ${dir}: ${err.message}`);
            })) {
                if (this.shouldStop()) {
                    aborted = true;
                    break;
                }
                try {
                    batch.push(await this.fileInfo(abs));
                    seen++;
                    if (seen % 25 === 0) publish();
                } catch (err) {
                    // Un archivo ilegible se vería como borrado: la pasada no puede borrar nada.
                    incomplete = true;
                    warn(`Drive sync «${this.name}»: no se pudo leer ${abs}: ${err.message}`);
                    continue;
                }
                if (batch.length >= PLAN_BATCH) await flush();
                if (aborted) break;
            }
            walking = false;
            if (!aborted) await flush();
        } catch (err) {
            incomplete = true;
            error = err instanceof ApiError ? err.message : `Error en la revisión: ${err.message}`;
            warn(`Drive sync «${this.name}»: ${error}`);
        } finally {
            this.scanning = false;
            this.progress = null;
            this.saveCache();
            this.host.status(null);
        }

        // Sin conexión con el server, el aviso final tampoco llega: se reintenta más tarde.
        try {
            await withRetry('drive-sync finish', () =>
                this.api().post(this.path('/scan/finish'), {
                    scan_id: scanId,
                    complete: !incomplete && !aborted,
                    aborted,
                    uploaded,
                    failed,
                    seen,
                    error,
                }),
            );
            log(`Drive sync «${this.name}»: ${seen} files, ${uploaded} uploaded, ${failed} failed${aborted ? ' (interrupted)' : ''}${incomplete ? ' (incomplete)' : ''}`);
        } catch (err) {
            warn(`Drive sync «${this.name}»: could not report the end of the scan: ${err.message}`);
        }

        if (error !== null || failed > 0) this.scheduleRetry();
    }

    scheduleRetry() {
        if (this.stopped) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.requestScan('retry'), RETRY_SCAN_MS);
        this.retryTimer.unref();
    }

    // --- Un archivo -----------------------------------------------------------------------

    /** @returns {Promise<'uploaded'|'skipped'|'failed'|'changed'>} */
    async pushFile(file) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const { data: start } = await withRetry(`${file.path} start`, () =>
                    this.api().post(this.path('/files/start'), { path: file.path, size: file.size, sha256: file.sha256 }),
                );

                if (start.action === 'done') return 'uploaded';

                const driveId = await putResumable(start.session_url, file.abs, file.size);

                // Cambió mientras se subía: no se da por sincronizado (la próxima pasada lo repite).
                const after = await stat(file.abs);
                if (after.size !== file.size || after.mtimeMs !== file.mtimeMs) return 'changed';

                await withRetry(`${file.path} complete`, () =>
                    this.api().post(this.path('/files/complete'), { path: file.path, size: file.size, sha256: file.sha256, file_id: driveId }),
                );

                return 'uploaded';
            } catch (err) {
                // La sesión venció: se pide una nueva (una sola vez).
                if (err instanceof SessionExpired && attempt === 1) continue;
                warn(`Drive sync «${this.name}»: ${file.path}: ${err.message}`);

                return 'failed';
            }
        }

        return 'failed';
    }

    // --- Watcher --------------------------------------------------------------------------

    /** Sólo con la carpeta presente: crearla sería dar por vacía una carpeta que no está montada. */
    startWatcher() {
        const root = this.root;
        if (this.watcher || !existsSync(root)) return;

        this.watcher = watch(root, {
            ignored: (path) => path !== root && ignoredName(basename(path)),
            ignoreInitial: true,
            followSymlinks: false,
            depth: 99,
            awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
        });

        const changed = (path) => {
            this.removed.delete(path);
            this.pending.add(path);
            this.enqueue(() => this.processPending());
        };
        this.watcher.on('add', changed);
        this.watcher.on('change', changed);
        this.watcher.on('unlink', (path) => {
            this.pending.delete(path);
            this.removed.add(path);
            clearTimeout(this.removeTimer);
            // Un guardado «atómico» de un editor borra y vuelve a crear: se espera antes de avisar.
            this.removeTimer = setTimeout(() => this.enqueue(() => this.processRemoved()), DELETE_DEBOUNCE_MS);
        });
        this.watcher.on('error', (err) => warn(`Drive sync «${this.name}»: watcher: ${err.message}`));
    }

    async processPending() {
        if (this.pending.size === 0) return;
        // En pausa se espera: los eventos quedan en la cola hasta que se reanude.
        while (this.host.isPaused() && !this.stopped) await sleep(5000);
        if (this.stopped) return;

        const paths = [...this.pending];
        this.pending.clear();

        const infos = [];
        for (const abs of paths) {
            try {
                infos.push(await this.fileInfo(abs));
            } catch {
                // Desapareció entre el evento y ahora: lo cubre el unlink.
            }
        }

        for (let i = 0; i < infos.length; i += PLAN_BATCH) {
            const files = infos.slice(i, i + PLAN_BATCH);
            try {
                const { data } = await withRetry('drive-sync plan', () =>
                    this.api().post(this.path('/plan'), { scan_id: null, files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })) }),
                );
                const wanted = new Set(data.upload);
                let n = 0;
                for (const file of files) {
                    if (!wanted.has(file.path)) continue;
                    this.host.status(`Drive · ${this.name}: subiendo ${++n} de ${wanted.size} · ${basename(file.path)}`);
                    const result = await this.pushFile(file);
                    if (result === 'failed') this.scheduleRetry();
                    if (result === 'changed') this.pending.add(file.abs);
                }
            } catch (err) {
                warn(`Drive sync «${this.name}»: ${err.message}`);
                // Se re-encolan para la próxima revisión (no se pierde: la pasada completa los ve).
                this.scheduleRetry();
            } finally {
                this.host.status(null);
            }
        }

        this.saveCache();
        if (this.pending.size > 0) this.enqueue(() => this.processPending());
    }

    async processRemoved() {
        if (this.removed.size === 0 || !this.spec.mirror_deletes) {
            this.removed.clear();

            return;
        }
        while (this.host.isPaused() && !this.stopped) await sleep(5000);
        if (this.stopped) return;

        // Sólo lo que sigue sin existir (si volvió a aparecer, no se toca).
        const gone = [...this.removed].filter((abs) => !existsSync(abs));
        this.removed.clear();
        if (gone.length === 0) return;

        for (const abs of gone) delete this.cache[relPath(this.root, abs)];
        this.cacheDirty = true;
        this.saveCache();

        const paths = gone.map((abs) => relPath(this.root, abs));
        for (let i = 0; i < paths.length; i += 500) {
            try {
                const { data } = await withRetry('drive-sync delete', () => this.api().post(this.path('/files/delete'), { paths: paths.slice(i, i + 500) }));
                if (data.blocked) warn(`Drive sync «${this.name}»: muchos borrados juntos, esperan confirmación en Mi perfil`);
            } catch (err) {
                // Si no llega, la próxima revisión completa los detecta igual.
                warn(`Drive sync «${this.name}»: no se pudo avisar de los borrados: ${err.message}`);
            }
        }
    }
}

/**
 * Administra las tareas de sincronización de esta computadora según `drive_syncs` de /config.
 * `host`: { api(), isPaused(), status(text|null) }.
 */
export class DriveSyncRunner {
    constructor(host) {
        this.host = host;
        this.tasks = new Map(); // id → { key, task }
        this.statusText = null;
    }

    /** Avance de las revisiones en curso: id de la sincronización → progreso. */
    progress() {
        const out = {};
        for (const [id, { task }] of this.tasks) if (task.progress) out[id] = task.progress;

        return out;
    }

    /** Idempotente: sólo reinicia las tareas cuya definición cambió. */
    async configure(syncs) {
        const wanted = new Map((Array.isArray(syncs) ? syncs : []).map((s) => [s.id, s]));

        for (const [id, entry] of this.tasks) {
            const spec = wanted.get(id);
            if (!spec || JSON.stringify([spec.local_path, spec.mirror_deletes]) !== entry.key) {
                await entry.task.stop();
                this.tasks.delete(id);
            }
        }

        for (const [id, spec] of wanted) {
            if (this.tasks.has(id)) {
                this.tasks.get(id).task.spec = spec;
                continue;
            }
            const task = new SyncTask(
                {
                    api: () => this.host.api(),
                    isPaused: () => this.host.isPaused(),
                    status: (text) => this.setStatus(text),
                },
                spec,
            );
            this.tasks.set(id, { key: JSON.stringify([spec.local_path, spec.mirror_deletes]), task });
            task.start();
        }
    }

    /** «Sincronizar ahora» desde la web. */
    requestScan(id) {
        this.tasks.get(id)?.task.requestScan('requested');
    }

    /** Al reanudar la pausa global: la pausa cortó las revisiones en curso, hay que retomarlas. */
    requestScanAll(reason = 'resumed') {
        for (const { task } of this.tasks.values()) task.requestScan(reason);
    }

    async stopAll() {
        await Promise.all([...this.tasks.values()].map((e) => e.task.stop()));
        this.tasks.clear();
    }

    setStatus(text) {
        if (text === this.statusText) return;
        this.statusText = text;
        this.host.status(text);
    }
}
