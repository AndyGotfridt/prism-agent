import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './fs-util.js';
import { STATE_DIR } from './state.js';

/**
 * Preferencias de esta computadora (no del server): lo que se decide desde la ventanita o la
 * pantalla de configuración local. Hoy: si se muestra el progreso de Drive en la ventanita.
 */
const FILE = join(STATE_DIR, 'prefs.json');
const DEFAULTS = { drive_progress_popup: true };

export function readPrefs() {
    try {
        return { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, 'utf8')) };
    } catch {
        return { ...DEFAULTS };
    }
}

export function writePrefs(partial) {
    const next = { ...readPrefs() };
    for (const key of Object.keys(DEFAULTS)) if (typeof partial[key] === typeof DEFAULTS[key]) next[key] = partial[key];
    ensureDir(STATE_DIR);
    writeFileSync(FILE, JSON.stringify(next) + '\n');

    return next;
}
