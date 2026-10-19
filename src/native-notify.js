import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir } from './fs-util.js';
import { log, warn } from './log.js';
import { STATE_DIR } from './state.js';
import { showNativeWindows } from './windows-toast.js';

/**
 * Aviso nativo del sistema con botones (docs/PLAN-AGENT-NOTIFICATIONS.md). macOS: por el
 * ayudante PrismaNotify.app (UNUserNotificationCenter), que abre él mismo las URLs de los
 * botones `open` (sólo del origen del server). Windows: toast por PowerShell (windows-toast.js). `showNative()` devuelve true si el aviso quedó
 * posteado; false si hay que usar la ventanita (otra plataforma, sin ayudante, sin permiso,
 * modo concentración que el ayudante no ve, error). Nunca lanza.
 */

const HELPER_DIR = join(STATE_DIR, 'helpers');
const HELPER_APP = join(HELPER_DIR, 'PrismaNotify.app');
const HELPER_BIN = join(HELPER_APP, 'Contents', 'MacOS', 'PrismaNotify');
const HASH_FILE = join(HELPER_DIR, 'PrismaNotify.sha256');
// Largo: la primera vez macOS espera a que la persona responda el permiso de notificaciones.
const START_TIMEOUT_MS = 90_000;

let helperReady = null;
let helperDenied = false;

/** El tar.gz del ayudante: embebido en el ejecutable (build.sh) o, en desarrollo, el del repo. */
async function helperArchive() {
    try {
        const embedded = (await import('./embedded-helper.js')).default;
        if (embedded) return readFileSync(embedded);
    } catch {
        // Sin embebido (desarrollo con Node): se lee del repo.
    }
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'macos', 'PrismaNotify.tar.gz');

    return existsSync(file) ? readFileSync(file) : null;
}

function run(cmd, args, timeoutMs = 20_000) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', () => resolve({ code: -1, out }));
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

/** Extrae el ayudante si falta o cambió (por hash) y comprueba que arranca. */
async function ensureHelper() {
    if (helperReady !== null) return helperReady;
    helperReady = (async () => {
        const archive = await helperArchive();
        if (!archive) return false;
        const hash = createHash('sha256').update(archive).digest('hex');
        const current = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, 'utf8').trim() : '';
        if (current !== hash || !existsSync(HELPER_BIN)) {
            rmSync(HELPER_APP, { recursive: true, force: true });
            ensureDir(HELPER_DIR);
            const tar = join(HELPER_DIR, 'PrismaNotify.tar.gz');
            writeFileSync(tar, archive);
            const res = await run('tar', ['-xzf', tar, '-C', HELPER_DIR]);
            rmSync(tar, { force: true });
            if (res.code !== 0 || !existsSync(HELPER_BIN)) {
                warn('Could not extract the notification helper');
                return false;
            }
            writeFileSync(HASH_FILE, hash);
        }
        const check = await run(HELPER_BIN, ['--check'], 10_000);
        if (!check.out.includes('"ok":true')) {
            warn('The notification helper does not start');
            return false;
        }

        return true;
    })().catch((err) => {
        warn(`Notification helper unavailable: ${err.message}`);

        return false;
    });

    return helperReady;
}

/**
 * @param {{title: string, text?: string, image?: string|null, actions?: Array<{id: string, label: string, kind: string, url?: string}>, origin: string}} alert
 */
export async function showNative({ title, text = '', image = null, actions = [], origin }) {
    if (platform() === 'win32') return showNativeWindows({ title, text, image, actions });
    if (platform() !== 'darwin' || helperDenied) return false;
    try {
        if (!(await ensureHelper())) return false;

        const spec = { title, body: text, image, origin, wait: 300, actions: actions.filter((a) => a.kind === 'open').slice(0, 3) };
        return await new Promise((resolve) => {
            // Queda vivo hasta 5 min esperando un botón; sólo importa la primera línea.
            const child = spawn(HELPER_BIN, ['--post', JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
            let settled = false;
            const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
            const timer = setTimeout(() => { child.kill(); done(false); }, START_TIMEOUT_MS);
            let buf = '';
            child.stdout.on('data', (d) => {
                buf += d;
                const line = buf.split('\n')[0];
                if (!buf.includes('\n')) return;
                let status = 'error';
                try { status = JSON.parse(line).status; } catch { /* queda error */ }
                if (status === 'denied') {
                    helperDenied = true;
                    log('Native notifications are not allowed for the helper: using the agent window');
                }
                done(status === 'posted');
            });
            child.on('error', () => done(false));
            child.on('close', () => done(false));
            child.unref();
        });
    } catch (err) {
        warn(`Native notification failed: ${err.message}`);

        return false;
    }
}
