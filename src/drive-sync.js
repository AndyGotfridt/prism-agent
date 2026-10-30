import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { watch } from 'chokidar';
import { ApiError } from './api.js';
import { ensureDir } from './fs-util.js';
import { log, warn } from './log.js';
import { STATE_DIR } from './state.js';
import { sha256File, withRetry } from './uploader.js';

/**
 * Sincronización de carpetas locales con Google Drive, en una dirección por carpeta:
 * `SyncTask` (local → Drive), `PullTask` (Drive → local) y `BothTask` (los dos sentidos), en ese orden de aparición.
 *
 * Local → Drive. El agente es «tonto»: recorre la carpeta, le cuenta al server qué hay (ruta, tamaño,
 * sha256) y sube lo que el server le pide. El contenido va **directo a Google** por una
 * sesión de subida resumible que abre el server: el agente no tiene credenciales de Google ni
 * el archivo pasa por Laravel. Las reglas (qué subir, qué borrar en Drive, guardas) viven en
 * App\Services\GoogleDrive\DriveSyncService. Detalle en docs/PLAN-AGENT-DRIVE-SYNC.md.
 *
 * Drive → local. El server arma el manifiesto (qué hay en Drive, con md5) y sirve el contenido (el
 * agente sigue sin credenciales de Google); acá se decide qué bajar según el estado local, se verifica
 * el md5, y lo que se pisa o se borra va a `.prisma-papelera` (nunca se pierde nada sin red).
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

/** Una carpeta local sincronizada hacia Drive: revisión completa + watcher + borrados. */
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

// ============================================================================================
// Drive → computadora
// ============================================================================================

const PULL_EVERY_MS = 15 * 60 * 1000;
const TRASH_DIR = '.prisma-papelera';
const TRASH_KEEP_DAYS = 30;
const MASS_DELETE_MIN = 20;
const MASS_DELETE_RATIO = 0.5;

class Aborted extends Error {}

/** Un error que no tiene sentido reintentar. */
class Fatal extends Error {}

/** md5 de un archivo local (Drive publica md5, no sha256). */
function md5File(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash('md5');
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/** Ruta relativa que manda el server → segmentos seguros, o null (vacía, `..`, absoluta o dentro de la papelera). */
function safeSegments(path) {
    if (typeof path !== 'string') return null;
    const segments = path.normalize('NFC').split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) return null;
    if (segments[0] === TRASH_DIR) return null;

    return segments;
}

/** Una carpeta de Drive que se baja a una carpeta local: Drive manda; revisión completa cada 15 minutos. */
class PullTask {
    constructor(host, spec) {
        this.host = host;
        this.spec = spec;
        this.id = spec.id;
        this.name = spec.name;
        this.root = resolve(expandHome(spec.local_path));
        this.stopped = false;
        this.chain = Promise.resolve();
        this.state = this.loadState(); // ruta → { id, md5, size, mtimeMs } de lo que bajó este agente
        this.stateDirty = false;
        this.progress = null; // { seen, planned, processed, uploaded (= bajados), failed, walking, current }
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
        log(`Drive pull «${this.name}»: ${this.root}`);
        setTimeout(() => this.requestScan('start'), 3000).unref();
        this.scanTimer = setInterval(() => this.requestScan('periodic'), PULL_EVERY_MS);
        this.scanTimer.unref();
    }

    async stop() {
        this.stopped = true;
        clearInterval(this.scanTimer);
        clearTimeout(this.retryTimer);
        this.saveState();
    }

    shouldStop() {
        return this.stopped || this.host.isPaused();
    }

    enqueue(fn) {
        this.chain = this.chain.then(fn).catch((err) => warn(`Drive pull «${this.name}»: ${err.message}`));

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

    scheduleRetry() {
        if (this.stopped) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.requestScan('retry'), RETRY_SCAN_MS);
        this.retryTimer.unref();
    }

    // --- Estado local (lo que ya se bajó) -------------------------------------------------

    stateFile() {
        return join(CACHE_DIR, `pull-${this.id}.json`);
    }

    loadState() {
        try {
            const data = JSON.parse(readFileSync(this.stateFile(), 'utf8'));

            return data.root === this.root ? data.files ?? {} : {};
        } catch {
            return {};
        }
    }

    saveState() {
        if (!this.stateDirty) return;
        try {
            ensureDir(CACHE_DIR);
            writeFileSync(this.stateFile(), JSON.stringify({ root: this.root, files: this.state }));
            this.stateDirty = false;
        } catch (err) {
            warn(`Drive pull «${this.name}»: no se pudo guardar el estado: ${err.message}`);
        }
    }

    remember(rel, entry, st) {
        this.state[rel] = { id: entry.file_id, md5: entry.md5, size: st.size, mtimeMs: st.mtimeMs };
        this.stateDirty = true;
    }

    // --- Revisión completa ----------------------------------------------------------------

    async scan(reason) {
        if (this.shouldStop()) return;
        this.scanning = true;
        const scanId = randomUUID();
        const p = { seen: 0, planned: 0, processed: 0, uploaded: 0, failed: 0, walking: true, current: null };
        this.progress = p;
        const seenPaths = new Set();
        let skippedFiles = 0;
        let incomplete = false;
        let aborted = false;
        let deleted = 0;
        let skippedDeletions = 0;
        let error = null;

        try {
            if (!this.ensureRoot()) {
                await withRetry('drive-sync error', () => this.api().post(this.path('/error'), { message: `La carpeta ${this.spec.local_path} no existe en esta computadora y no se pudo crear (falta su carpeta padre).` }));
                warn(`Drive pull «${this.name}»: la carpeta no existe`);
                this.scheduleRetry();

                return;
            }

            log(`Drive pull «${this.name}»: scan (${reason})`);
            this.host.status(`Drive · ${this.name}: comprobando…`);
            await withRetry('drive-sync scan', () => this.api().post(this.path('/scan'), { scan_id: scanId }));

            let cursor = null;
            do {
                const query = `?scan_id=${scanId}${cursor !== null ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
                const { data } = await withRetry('drive-sync manifest', () => this.api().get(this.path(`/pull/manifest${query}`)));
                cursor = data.cursor ?? null;
                skippedFiles += data.skipped ?? 0;

                for (const entry of data.entries) {
                    if (this.shouldStop()) {
                        aborted = true;
                        break;
                    }
                    const segments = safeSegments(entry.path);
                    if (segments === null) {
                        incomplete = true; // una ruta que no se puede usar: no se puede asegurar el espejo
                        warn(`Drive pull «${this.name}»: ruta inválida ${entry.path}`);
                        continue;
                    }
                    const rel = segments.join('/');
                    seenPaths.add(rel);
                    p.seen++;
                    try {
                        await this.processEntry(entry, rel, segments, p);
                    } catch (err) {
                        if (err instanceof Aborted) {
                            aborted = true;
                            break;
                        }
                        p.failed++;
                        warn(`Drive pull «${this.name}»: ${rel}: ${err.message}`);
                    }
                }
                this.saveState();
            } while (cursor !== null && !aborted);

            p.walking = false;

            // Borrados reflejados: sólo con el manifiesto completo y nada ilegible.
            if (!aborted && !incomplete) {
                ({ deleted, skippedDeletions } = this.reconcileDeletions(seenPaths, p.seen));
                this.purgeTrash();
            }
        } catch (err) {
            incomplete = true;
            error = err instanceof ApiError ? err.message : `Error en la revisión: ${err.message}`;
            warn(`Drive pull «${this.name}»: ${error}`);
        } finally {
            this.scanning = false;
            this.progress = null;
            this.saveState();
            this.host.status(null);
        }

        try {
            await withRetry('drive-sync finish', () =>
                this.api().post(this.path('/pull/finish'), {
                    scan_id: scanId,
                    complete: !incomplete && !aborted,
                    aborted,
                    downloaded: p.uploaded,
                    failed: p.failed,
                    deleted,
                    skipped_deletions: skippedDeletions,
                    skipped: skippedFiles,
                    error,
                }),
            );
            log(`Drive pull «${this.name}»: ${p.seen} files, ${p.uploaded} downloaded, ${p.failed} failed, ${deleted} removed${skippedFiles > 0 ? `, ${skippedFiles} skipped (Google docs, shortcuts)` : ''}${aborted ? ' (interrupted)' : ''}${incomplete ? ' (incomplete)' : ''}`);
        } catch (err) {
            warn(`Drive pull «${this.name}»: could not report the end of the scan: ${err.message}`);
        }

        if (error !== null || p.failed > 0) this.scheduleRetry();
    }

    /** La carpeta local se crea sólo si existe su carpeta padre (un disco sin montar no se llena en el del sistema). */
    ensureRoot() {
        if (existsSync(this.root)) return statSync(this.root).isDirectory();
        const parent = dirname(this.root);
        if (!existsSync(parent) || !statSync(parent).isDirectory()) return false;
        mkdirSync(this.root);

        return true;
    }

    // --- Un archivo -----------------------------------------------------------------------

    async processEntry(entry, rel, segments, p) {
        const abs = join(this.root, ...segments);
        if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new Error('la ruta sale de la carpeta sincronizada');

        const known = this.state[rel];
        let local = null;
        if (existsSync(abs)) {
            const st = statSync(abs);
            if (!st.isFile()) throw new Error('en la computadora hay una carpeta con ese nombre');
            const md5 = known && known.size === st.size && known.mtimeMs === st.mtimeMs ? known.md5 : await md5File(abs);
            local = { st, md5 };
        }

        // Ya es igual a lo que hay en Drive.
        if (local && local.md5 === entry.md5) {
            this.remember(rel, entry, local.st);

            return;
        }

        // Alguien lo editó acá y Drive no cambió desde la última bajada: se respeta lo local.
        if (local && known && known.md5 === entry.md5) return;

        p.planned++;
        p.current = basename(rel);
        const pct = Math.floor((p.processed / Math.max(p.planned, 1)) * 100);
        this.host.status(`Drive · ${this.name}: ${pct}% · bajando ${p.processed + 1} de ${p.planned}${p.walking ? '+' : ''} · ${basename(rel)}`);

        const part = `${abs}.part`;
        try {
            ensureDir(dirname(abs));
            await this.download(entry, part);

            // Lo local que no es una versión de Drive ya conocida (lo editó alguien, o ya existía) no se pisa sin red.
            if (local && local.md5 !== known?.md5) this.toTrash(abs, rel);

            renameSync(part, abs);
            const when = entry.modified_at ? new Date(entry.modified_at) : null;
            if (when && !Number.isNaN(when.getTime())) utimesSync(abs, new Date(), when);
            this.remember(rel, entry, statSync(abs));
            p.uploaded++;
        } catch (err) {
            rmSync(part, { force: true });
            throw err;
        } finally {
            p.processed++;
        }
    }

    /** Baja el contenido a `part`, reanudando con Range ante cortes, y verifica tamaño y md5. */
    async download(entry, part) {
        rmSync(part, { force: true });
        const fd = openSync(part, 'w');
        const hash = createHash('md5');
        let offset = 0;
        let failures = 0;

        try {
            while (entry.size > 0 && offset < entry.size) {
                if (this.shouldStop()) throw new Aborted();
                try {
                    const res = await this.api().get(this.path(`/pull/files/${encodeURIComponent(entry.file_id)}`), {
                        raw: true,
                        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
                    });

                    if (res.status !== 200 && res.status !== 206) {
                        const text = await res.text().catch(() => '');
                        let message = `HTTP ${res.status}`;
                        try {
                            message = JSON.parse(text).message ?? message;
                        } catch {
                            // cuerpo que no es JSON
                        }
                        throw new ApiError(message, { status: res.status, retryable: res.status >= 500 || res.status === 429 });
                    }

                    // Pedimos desde `offset` y el server devolvió todo: no se puede seguir sin duplicar bytes.
                    if (res.status === 200 && offset > 0) throw new Fatal('El server no respondió al Range: no se puede reanudar la bajada.');

                    for await (const chunk of res.body) {
                        if (this.shouldStop()) throw new Aborted();
                        writeSync(fd, chunk);
                        hash.update(chunk);
                        offset += chunk.length;
                    }
                    failures = 0;
                } catch (err) {
                    if (err instanceof Aborted || err instanceof Fatal) throw err;
                    // Un 4xx no se reintenta; la red caída, un 5xx o un corte a mitad del cuerpo sí (retoma con Range).
                    if (++failures > 5 || (err instanceof ApiError && !err.retryable)) throw err;
                    await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)));
                }
            }
        } finally {
            try {
                closeSync(fd);
            } catch {
                // ya cerrado
            }
        }

        if (offset !== entry.size) throw new Error(`bajó ${offset} de ${entry.size} bytes`);
        const md5 = entry.size === 0 ? 'd41d8cd98f00b204e9800998ecf8427e' : hash.digest('hex');
        if (md5 !== entry.md5) throw new Error('el contenido bajado no coincide con el de Drive (md5)');
    }

    // --- Papelera local y borrados --------------------------------------------------------

    /** Mueve un archivo a `<carpeta>/.prisma-papelera/AAAA-MM-DD/<ruta>` (nunca se borra de verdad). */
    toTrash(abs, rel) {
        const day = new Date().toISOString().slice(0, 10);
        let dest = join(this.root, TRASH_DIR, day, ...rel.split('/'));
        if (existsSync(dest)) dest = `${dest}.${Date.now()}`;
        ensureDir(dirname(dest));
        renameSync(abs, dest);
    }

    /**
     * Lo que bajó este agente y Drive ya no tiene. Con «reflejar» va a la papelera local; sin él, simplemente
     * se deja de seguir. Una baja masiva (o un manifiesto vacío) no se aplica: se avisa y se espera.
     */
    reconcileDeletions(seenPaths, seen) {
        const known = Object.keys(this.state);
        const gone = known.filter((rel) => !seenPaths.has(rel));
        if (gone.length === 0) return { deleted: 0, skippedDeletions: 0 };

        if (this.spec.mirror_deletes) {
            const massive = (gone.length >= MASS_DELETE_MIN && gone.length > known.length * MASS_DELETE_RATIO) || (seen === 0 && known.length > 0);
            if (massive) return { deleted: 0, skippedDeletions: gone.length };
        }

        let deleted = 0;
        for (const rel of gone) {
            if (this.spec.mirror_deletes) {
                const abs = join(this.root, ...rel.split('/'));
                try {
                    if (existsSync(abs)) {
                        this.toTrash(abs, rel);
                        deleted++;
                    }
                } catch (err) {
                    warn(`Drive pull «${this.name}»: no se pudo mover ${rel} a la papelera: ${err.message}`);
                    continue; // se sigue siguiendo: la próxima pasada lo reintenta
                }
            }
            delete this.state[rel];
            this.stateDirty = true;
        }

        return { deleted, skippedDeletions: 0 };
    }

    /** Vacía de la papelera lo que tiene más de 30 días. */
    purgeTrash() {
        const base = join(this.root, TRASH_DIR);
        if (!existsSync(base)) return;
        const limit = Date.now() - TRASH_KEEP_DAYS * 24 * 60 * 60 * 1000;
        try {
            for (const day of readdirSync(base)) {
                const time = Date.parse(day);
                if (/^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(time) && time < limit) rmSync(join(base, day), { recursive: true, force: true });
            }
        } catch (err) {
            warn(`Drive pull «${this.name}»: no se pudo limpiar la papelera: ${err.message}`);
        }
    }
}

// ============================================================================================
// Los dos sentidos (computadora ⇄ Drive)
// ============================================================================================

/** `nombre.ext` → `nombre (conflicto 2026-10-29).ext`, sin pisar uno que ya exista. */
function conflictName(abs) {
    const day = new Date().toISOString().slice(0, 10);
    const dir = dirname(abs);
    const name = basename(abs);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = join(dir, `${stem} (conflicto ${day})${ext}`);
    for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${stem} (conflicto ${day} ${i})${ext}`);

    return candidate;
}

/**
 * Una carpeta de la computadora y una de Drive que se mantienen iguales en los dos sentidos. El agente sólo
 * cuenta qué hay de cada lado (ruta, tamaño, md5, fecha) y ejecuta lo que el server decide comparando con la
 * base de la última vez que coincidían (App\Services\GoogleDrive\DriveSyncReconciler): subir, bajar, borrar en la
 * computadora o conservar las dos. Lo que cambió en los dos lados queda congelado hasta que alguien elige en la
 * web; acá no se resuelve nada. Revisión completa a los 3 s, cada 15 minutos y con «Sincronizar ahora».
 */
class BothTask extends PullTask {
    // Subir un archivo es lo mismo que en SyncTask (start → PUT a Google → complete): sólo usa api(), path() y name.
    pushFile = SyncTask.prototype.pushFile;

    // El estado es un caché de md5 por tamaño+mtime (`md5`, `size`, `mtimeMs`) y el md5 de la última versión que quedó
    // igual en los dos lados (`synced`): con eso se sabe si lo local cambió desde entonces antes de pisarlo.
    stateFile() {
        return join(CACHE_DIR, `both-${this.id}.json`);
    }

    start() {
        log(`Drive both «${this.name}»: ${this.root}`);
        setTimeout(() => this.requestScan('start'), 3000).unref();
        this.scanTimer = setInterval(() => this.requestScan('periodic'), PULL_EVERY_MS);
        this.scanTimer.unref();
    }

    remember(rel, entry, st) {
        this.state[rel] = { id: entry.file_id, md5: entry.md5, size: st.size, mtimeMs: st.mtimeMs, synced: entry.md5 };
        this.stateDirty = true;
    }

    log(message) {
        log(`Drive both «${this.name}»: ${message}`);
    }

    async scan(reason) {
        if (this.shouldStop()) return;
        this.scanning = true;
        const scanId = randomUUID();
        const p = { seen: 0, planned: 0, processed: 0, uploaded: 0, failed: 0, walking: true, current: null };
        this.progress = p;
        const done = { uploaded: 0, downloaded: 0, deleted: 0 };
        let skippedFiles = 0;
        let incomplete = false;
        let aborted = false;
        let error = null;

        try {
            if (!this.ensureRoot()) {
                await withRetry('drive-sync error', () => this.api().post(this.path('/error'), { message: `La carpeta ${this.spec.local_path} no existe en esta computadora y no se pudo crear (falta su carpeta padre).` }));
                warn(`Drive both «${this.name}»: la carpeta no existe`);
                this.scheduleRetry();

                return;
            }

            this.log(`scan (${reason})`);
            this.host.status(`Drive · ${this.name}: comprobando…`);
            await withRetry('drive-sync scan', () => this.api().post(this.path('/scan'), { scan_id: scanId }));

            // 1. Lo que hay en Drive: el server arma el índice mientras se recorre (no hace falta nada de las entradas).
            let cursor = null;
            do {
                if (this.shouldStop()) throw new Aborted();
                const query = `?scan_id=${scanId}${cursor !== null ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
                const { data } = await withRetry('drive-sync manifest', () => this.api().get(this.path(`/pull/manifest${query}`)));
                cursor = data.cursor ?? null;
                p.seen += data.entries.length;
                skippedFiles += data.skipped ?? 0;
            } while (cursor !== null);

            // 2. Lo que hay en la computadora.
            const localOk = await this.sendLocal(scanId, p);

            // 3. El server decide. Con una mitad incompleta no decide ni borra nada.
            const { data: plan } = await withRetry('drive-sync reconcile', () =>
                this.api().post(this.path('/both/reconcile'), { scan_id: scanId, local_complete: localOk, remote_complete: true }),
            );
            if (!localOk) incomplete = true;

            if (plan.decided) {
                const c = plan.counts ?? {};
                p.planned = (c.download ?? 0) + (c.keep_both ?? 0) + (c.upload ?? 0) + (c.delete_local ?? 0);
                p.walking = false;
                this.log(`${p.seen} in Drive, ${p.planned} to do, ${plan.conflicts} conflicts${plan.held ? `, ${plan.held} deletions held` : ''}`);

                // 4. Ejecutar. Bajar primero (nunca se pierde nada local sin papelera), subir, y por último borrar acá.
                await this.runActions(scanId, 'download', p, done);
                await this.runActions(scanId, 'keep_both', p, done);
                await this.runActions(scanId, 'upload', p, done);
                await this.runActions(scanId, 'delete_local', p, done);
                this.purgeTrash();
            }
            p.walking = false;
        } catch (err) {
            if (err instanceof Aborted) {
                aborted = true;
            } else {
                incomplete = true;
                error = err instanceof ApiError ? err.message : `Error en la revisión: ${err.message}`;
                warn(`Drive both «${this.name}»: ${error}`);
            }
        } finally {
            this.scanning = false;
            this.progress = null;
            this.saveState();
            this.host.status(null);
        }

        try {
            await withRetry('drive-sync finish', () =>
                this.api().post(this.path('/both/finish'), {
                    scan_id: scanId,
                    complete: !incomplete && !aborted,
                    aborted,
                    uploaded: done.uploaded,
                    downloaded: done.downloaded,
                    deleted: done.deleted,
                    failed: p.failed,
                    skipped: skippedFiles,
                    error,
                }),
            );
            this.log(`${done.uploaded} uploaded, ${done.downloaded} downloaded, ${done.deleted} removed, ${p.failed} failed${skippedFiles > 0 ? `, ${skippedFiles} skipped (Google docs, shortcuts)` : ''}${aborted ? ' (interrupted)' : ''}${incomplete ? ' (incomplete)' : ''}`);
        } catch (err) {
            warn(`Drive both «${this.name}»: could not report the end of the scan: ${err.message}`);
        }

        if (error !== null || p.failed > 0) this.scheduleRetry();
    }

    // --- La computadora -------------------------------------------------------------------

    /** Recorre la carpeta y manda (ruta, tamaño, md5, fecha) en lotes. Devuelve false si algo no se pudo leer. */
    async sendLocal(scanId, p) {
        let complete = true;
        const seen = new Set();
        const batch = [];
        const flush = async () => {
            if (batch.length === 0) return;
            const files = batch.splice(0);
            await withRetry('drive-sync local', () => this.api().post(this.path('/both/local'), { scan_id: scanId, files }));
        };

        for await (const abs of walk(this.root, (dir, err) => {
            complete = false; // una carpeta ilegible se vería como «borrada»
            warn(`Drive both «${this.name}»: no se pudo leer ${dir}: ${err.message}`);
        })) {
            if (this.shouldStop()) throw new Aborted();
            const rel = relPath(this.root, abs);
            try {
                const st = await stat(abs);
                const known = this.state[rel];
                const md5 = known && known.size === st.size && known.mtimeMs === st.mtimeMs ? known.md5 : await md5File(abs);
                if (!known || known.md5 !== md5 || known.size !== st.size || known.mtimeMs !== st.mtimeMs) {
                    this.state[rel] = { id: known?.id ?? null, md5, size: st.size, mtimeMs: st.mtimeMs, synced: known?.synced ?? null };
                    this.stateDirty = true;
                }
                seen.add(rel);
                batch.push({ path: rel, size: st.size, md5, mtime_ms: Math.floor(st.mtimeMs) });
                p.current = basename(rel);
                this.host.status(`Drive · ${this.name}: leyendo la carpeta… ${seen.size} archivos`);
                if (batch.length >= PLAN_BATCH) await flush();
            } catch (err) {
                if (err?.code === 'ENOENT') continue; // se borró mientras se recorría: la próxima pasada lo ve
                complete = false;
                warn(`Drive both «${this.name}»: ${rel}: ${err.message}`);
            }
        }
        await flush();

        if (complete) {
            // El caché sólo vale para lo que sigue existiendo.
            for (const rel of Object.keys(this.state)) if (!seen.has(rel)) delete this.state[rel];
            this.stateDirty = true;
        }
        this.saveState();

        return complete;
    }

    // --- Ejecutar lo decidido -------------------------------------------------------------

    /** Pide por páginas los archivos con esa acción pendiente y los ejecuta de a uno; informa lo aplicado en lotes. */
    async runActions(scanId, type, p, done) {
        const applied = [];
        const report = async () => {
            if (applied.length === 0) return;
            const items = applied.splice(0);
            await withRetry('drive-sync applied', () => this.api().post(this.path('/both/applied'), { items }));
        };

        let after = 0;
        do {
            const { data } = await withRetry('drive-sync actions', () => this.api().get(this.path(`/both/actions?type=${type}&after=${after}`)));
            after = data.next ?? null;

            for (const entry of data.entries) {
                if (this.shouldStop()) {
                    await report();
                    throw new Aborted();
                }

                p.current = basename(entry.path);
                const pct = Math.floor((p.processed / Math.max(p.planned, 1)) * 100);
                const verb = type === 'upload' ? 'subiendo' : type === 'delete_local' ? 'quitando' : 'bajando';
                this.host.status(`Drive · ${this.name}: ${pct}% · ${verb} ${p.processed + 1} de ${p.planned} · ${p.current}`);

                try {
                    const result = await this.applyOne(type, entry);
                    if (result) {
                        applied.push(result);
                        if (type === 'upload') done.uploaded++;
                        else if (type === 'delete_local') done.deleted++;
                        else done.downloaded++;
                        p.uploaded++;
                    }
                } catch (err) {
                    if (err instanceof Aborted) {
                        await report();
                        throw err;
                    }
                    p.failed++;
                    warn(`Drive both «${this.name}»: ${entry.path}: ${err.message}`);
                } finally {
                    p.processed++;
                }

                if (applied.length >= PLAN_BATCH) await report();
            }
        } while (after !== null);

        await report();
    }

    /** @returns {Promise<{path: string, action: string, md5?: string, size?: number}|null>} null = nada que informar (falló o cambió). */
    async applyOne(type, entry) {
        const segments = safeSegments(entry.path);
        if (segments === null) throw new Error('ruta inválida');
        const rel = segments.join('/');
        const abs = join(this.root, ...segments);
        if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new Error('la ruta sale de la carpeta sincronizada');

        if (type === 'delete_local') {
            if (existsSync(abs)) this.toTrash(abs, rel);
            delete this.state[rel];
            this.stateDirty = true;

            return { path: rel, action: type };
        }

        if (type === 'upload') return this.applyUpload(rel, abs);

        return this.applyDownload(entry, rel, abs, type === 'keep_both');
    }

    async applyUpload(rel, abs) {
        if (!existsSync(abs)) return null; // desapareció: la próxima pasada lo decide de nuevo
        const st = statSync(abs);
        if (!st.isFile()) throw new Error('en la computadora hay una carpeta con ese nombre');

        const [md5, sha256] = await Promise.all([md5File(abs), sha256File(abs)]);
        const result = await this.pushFile({ abs, path: rel, size: st.size, mtimeMs: st.mtimeMs, sha256 });
        if (result === 'failed') throw new Error('no se pudo subir');
        if (result === 'changed') return null; // cambió mientras subía: se repite en la próxima pasada

        this.state[rel] = { id: this.state[rel]?.id ?? null, md5, size: st.size, mtimeMs: st.mtimeMs, synced: md5 };
        this.stateDirty = true;

        return { path: rel, action: 'upload', md5, size: st.size };
    }

    /** Baja el archivo de Drive. `keepLocal`: el local queda al lado como «nombre (conflicto fecha)». */
    async applyDownload(entry, rel, abs, keepLocal) {
        let local = null;
        if (existsSync(abs)) {
            const st = statSync(abs);
            if (!st.isFile()) throw new Error('en la computadora hay una carpeta con ese nombre');
            const known = this.state[rel];
            const md5 = known && known.size === st.size && known.mtimeMs === st.mtimeMs ? known.md5 : await md5File(abs);
            local = { st, md5 };
        }

        // Ya es igual a Drive: sólo queda fijar la base.
        if (local && local.md5 === entry.md5) {
            this.remember(rel, entry, local.st);

            return { path: rel, action: keepLocal ? 'keep_both' : 'download', md5: entry.md5, size: entry.size };
        }

        const part = `${abs}.part`;
        try {
            ensureDir(dirname(abs));
            await this.download(entry, part);

            if (local && keepLocal) {
                renameSync(abs, conflictName(abs)); // se sube como archivo nuevo en la próxima pasada
            } else if (local && local.md5 !== this.state[rel]?.synced) {
                this.toTrash(abs, rel); // lo editado acá (o que ya estaba) nunca se pierde sin red
            }

            renameSync(part, abs);
            const when = entry.modified_at ? new Date(entry.modified_at) : null;
            if (when && !Number.isNaN(when.getTime())) utimesSync(abs, new Date(), when);
            this.remember(rel, entry, statSync(abs));
        } catch (err) {
            rmSync(part, { force: true });
            throw err;
        }

        return { path: rel, action: keepLocal ? 'keep_both' : 'download', md5: entry.md5, size: entry.size };
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
            if (!spec || JSON.stringify([spec.local_path, spec.mirror_deletes, spec.direction ?? 'upload']) !== entry.key) {
                await entry.task.stop();
                this.tasks.delete(id);
            }
        }

        for (const [id, spec] of wanted) {
            if (this.tasks.has(id)) {
                this.tasks.get(id).task.spec = spec;
                continue;
            }
            const Task = spec.direction === 'both' ? BothTask : spec.direction === 'download' ? PullTask : SyncTask;
            const task = new Task(
                {
                    api: () => this.host.api(),
                    isPaused: () => this.host.isPaused(),
                    status: (text) => this.setStatus(text),
                },
                spec,
            );
            this.tasks.set(id, { key: JSON.stringify([spec.local_path, spec.mirror_deletes, spec.direction ?? 'upload']), task });
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
