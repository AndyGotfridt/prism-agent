import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, createWriteStream, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { ensureDir } from './fs-util.js';
import { arch, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { USER_AGENT } from './api.js';
import { APP_TITLE } from './profile.js';
import { askInPopup, progressSupported } from './progress-ui.js';
import { COMPILED } from './runtime.js';
import { STATE_DIR } from './state.js';
import { VERSION, compareVersions } from './version.js';

/**
 * Actualización del agente: el server informa en /config la versión publicada y, por
 * plataforma, la URL y el sha256 del ejecutable (`agent_update`). El agente pregunta con un
 * diálogo nativo y, si le dicen que sí, baja, verifica, reemplaza su propio ejecutable y se
 * reinicia. Sólo el ejecutable compilado se actualiza solo: instalado con npm desde el repo,
 * se avisa como antes.
 */

const SNOOZE_FILE = join(STATE_DIR, 'update-snooze.json');
const PENDING_FILE = join(STATE_DIR, 'update-pending.json');

/** Clave de plataforma del server (AgentBuilds::TARGETS), o null si no hay ejecutable para esta. */
export function updateTarget() {
    if (platform() === 'darwin') return arch() === 'arm64' ? 'macos-arm64' : 'macos-x64';
    if (platform() === 'win32' && arch() === 'x64') return 'windows-x64';
    if (platform() === 'linux') return arch() === 'arm64' ? 'linux-arm64' : arch() === 'x64' ? 'linux-x64' : null;
    return null;
}

export function canSelfUpdate() {
    return COMPILED && updateTarget() !== null;
}

/**
 * ¿Hay que cambiar a la versión de `update` (agent_update de /config)? A una más nueva, siempre
 * (preguntando, salvo obligatoria). A una anterior, sólo si el server la marca obligatoria
 * (revertir o versión retirada) y este agente se reemplaza solo: corriendo desde el código no.
 */
export function wantsChange(update) {
    const target = update?.version;
    if (!target) return false;
    const cmp = compareVersions(VERSION, target);
    return cmp < 0 || (cmp > 0 && update.mandatory === true && canSelfUpdate());
}

/** «Actualizando a» o, si es una versión anterior (revertir), «Volviendo a». */
export function changeVerb(target) {
    return compareVersions(VERSION, target) > 0 ? 'Volviendo a' : 'Actualizando a';
}

// --- «Más tarde» -------------------------------------------------------------------------

/**
 * ¿Se pospuso esta versión y todavía no venció? `kind`: 'later' («Más tarde») o 'failed' (falló
 * al bajar o instalar). Una obligatoria sólo respeta el 'failed': si no, reintentaría cada 5 min.
 */
export function isSnoozed(version, { onlyFailed = false } = {}) {
    try {
        const s = JSON.parse(readFileSync(SNOOZE_FILE, 'utf8'));
        return s.version === version && Date.now() < s.until && (!onlyFailed || s.kind === 'failed');
    } catch {
        return false;
    }
}

export function snooze(version, ms, kind = 'later') {
    try {
        ensureDir(STATE_DIR);
        writeFileSync(SNOOZE_FILE, JSON.stringify({ version, until: Date.now() + ms, kind }));
    } catch {
        // Sin archivo vuelve a preguntar en el próximo ciclo: molesto, no grave.
    }
}

// --- Aviso después de reiniciar ----------------------------------------------------------

/** Antes de reiniciar: el agente nuevo confirma al arrancar si quedó en la versión esperada. */
export function markPending(from, to) {
    ensureDir(STATE_DIR);
    writeFileSync(PENDING_FILE, JSON.stringify({ from, to, at: Date.now() }));
}

/** @returns {{from: string, to: string}|null} la actualización que quedó por confirmar (y la borra). */
export function consumePending() {
    try {
        const pending = JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
        rmSync(PENDING_FILE, { force: true });
        return pending;
    } catch {
        return null;
    }
}

/**
 * Windows no deja borrar un .exe en uso: el anterior queda como `.old` (o `.old-{fecha}` si
 * el `.old` de una actualización previa todavía está en uso) y se borra al arrancar.
 */
export function cleanupOldBinary() {
    if (!COMPILED) return;
    const dir = dirname(process.execPath);
    const prefix = `${basename(process.execPath)}.old`;

    for (const name of safeReaddir(dir)) {
        if (!name.startsWith(prefix)) continue;
        try {
            rmSync(join(dir, name), { force: true });
        } catch {
            // Todavía lo usa el proceso viejo, que está terminando: se borra en el próximo arranque.
        }
    }
}

function safeReaddir(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/**
 * Dónde dejar el .exe que corre para poder poner el nuevo en su lugar. Si el `.old` de una
 * actualización anterior sigue en uso (un agente viejo que no terminó de cerrarse), no se
 * puede borrar ni pisar («ya existe»): se usa otro nombre y cleanupOldBinary() lo limpia después.
 */
function oldBinaryPath(target) {
    const old = `${target}.old`;
    try {
        rmSync(old, { force: true });
        return old;
    } catch {
        return `${old}-${Date.now()}`;
    }
}

// --- Preguntar ---------------------------------------------------------------------------

/**
 * «¿Actualizar?» con botones Actualizar / Más tarde, en la ventanita del agente
 * (progress-ui.js); donde no hay ventanita, diálogo del sistema. Devuelve true sólo si
 * eligieron Actualizar; «Más tarde» o no contestar en `timeoutSeconds` es false.
 */
export async function askToUpdate({ headline, message, timeoutSeconds = 600 }) {
    if (progressSupported()) {
        const action = await askInPopup({
            title: headline,
            text: message,
            actions: [{ id: 'update', label: 'Actualizar' }, { id: 'later', label: 'Más tarde' }],
            timeoutMs: timeoutSeconds * 1000,
        });
        return action === 'update';
    }
    return askNative({ title: APP_TITLE, message: `${headline}. ${message}`, timeoutSeconds });
}

function askNative({ title, message, timeoutSeconds }) {
    return new Promise((resolve) => {
        if (platform() === 'darwin') {
            const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            execFile('osascript', [
                '-e', 'activate',
                '-e', `display dialog "${esc(message)}" with title "${esc(title)}" buttons {"Más tarde", "Actualizar"} default button "Actualizar" cancel button "Más tarde" with icon note giving up after ${timeoutSeconds}`,
            ], (err, stdout) => {
                const out = String(stdout);
                resolve(!err && out.includes('Actualizar') && !out.includes('gave up:true'));
            });
            return;
        }

        if (platform() === 'win32') {
            // Popup de WScript: tiene timeout (MessageBox no). 4 = Sí/No, 32 = pregunta,
            // 4096 = siempre arriba. Devuelve 6 = Sí, 7 = No, -1 = no contestó.
            const script = `$r = (New-Object -ComObject WScript.Shell).Popup($env:PA_MESSAGE, ${timeoutSeconds}, $env:PA_TITLE, 4 + 32 + 4096)
[Console]::Out.Write($r)`;
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
                windowsHide: true,
                env: { ...process.env, PA_TITLE: String(title), PA_MESSAGE: String(message) },
            }, (err, stdout) => resolve(!err && String(stdout).trim() === '6'));
            return;
        }

        resolve(false);
    });
}

// --- Bajar y reemplazar ------------------------------------------------------------------

const sha256File = (path) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});

/**
 * Baja el ejecutable de `update` (agent_update de /config), verifica tamaño y sha256 y lo
 * pone en lugar del actual. No reinicia: eso lo decide quien llama.
 *
 * @param {(received: number, total: number|null) => void} [onProgress]  bytes bajados (y el
 *   total, del manifest o del Content-Length) a medida que llegan; una vez más con 0 al empezar.
 * @param {() => void} [onVerify]  ya bajó: verifica e instala (unos segundos, sin progreso).
 */
export async function installUpdate(update, { onProgress, onVerify } = {}) {
    const file = update?.files?.[updateTarget()];
    if (!file?.url || !file?.sha256) {
        throw new Error('El servidor no tiene un ejecutable publicado para esta plataforma.');
    }

    const target = process.execPath;
    const tmp = join(dirname(target), `.prisma-agent-update-${process.pid}${platform() === 'win32' ? '.exe' : ''}`);

    try {
        const res = await fetch(file.url, { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok || !res.body) throw new Error(`no se pudo bajar (HTTP ${res.status})`);
        const total = file.size || Number(res.headers.get('content-length')) || null;
        let received = 0;
        onProgress?.(0, total);
        const counter = new Transform({
            transform(chunk, _enc, done) {
                received += chunk.length;
                onProgress?.(received, total);
                done(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmp));
        onVerify?.();

        if (statSync(tmp).size !== file.size) throw new Error('el archivo bajado está incompleto');
        if ((await sha256File(tmp)) !== file.sha256) throw new Error('el archivo bajado no coincide con el publicado (sha256)');

        if (platform() === 'darwin') {
            chmodSync(tmp, 0o755);
            // Igual que el instalador: sin marca de «descargado» y con firma local (ad-hoc).
            try { execFileSync('xattr', ['-d', 'com.apple.quarantine', tmp], { stdio: 'ignore' }); } catch { /* no la tenía */ }
            try { execFileSync('codesign', ['--force', '--sign', '-', tmp], { stdio: 'ignore' }); } catch { /* sin codesign corre igual en Intel */ }
            renameSync(tmp, target); // el proceso que corre sigue con el archivo viejo (inode aparte)
        } else if (platform() === 'linux') {
            // rename() sobre el ejecutable en uso anda en Linux (el proceso sigue con el inodo viejo).
            chmodSync(tmp, 0o755);
            renameSync(tmp, target);
        } else {
            // Un .exe en uso no se puede pisar pero sí renombrar.
            const old = oldBinaryPath(target);
            renameSync(target, old);
            try {
                renameSync(tmp, target);
            } catch (err) {
                renameSync(old, target);
                throw err;
            }
        }
    } finally {
        rmSync(tmp, { force: true });
    }
}
