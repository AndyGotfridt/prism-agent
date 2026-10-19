import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './fs-util.js';
import { STATE_DIR } from './state.js';

/**
 * Preferencias de esta computadora (no del server): lo que se decide desde la ventanita o la
 * pantalla de configuración local: si se muestra el progreso de Drive en la ventanita y el canal
 * de actualizaciones (estable o beta; se informa al server en cada pedido, X-Agent-Channel).
 */
const FILE = join(STATE_DIR, 'prefs.json');
/** Canales de actualización (valores en inglés, como en el server; la etiqueta es de la UI). */
export const CHANNELS = { stable: 'Estable', beta: 'Beta' };
const DEFAULTS = { drive_progress_popup: true, update_channel: 'stable' };

/** Canal elegido en esta computadora (`stable` si falta o es inválido). Se lee del archivo cada vez: el CLI lo cambia desde otro proceso. */
export function updateChannel() {
    const channel = readPrefs().update_channel;

    return channel in CHANNELS ? channel : 'stable';
}

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
    if (!(next.update_channel in CHANNELS)) next.update_channel = DEFAULTS.update_channel;
    ensureDir(STATE_DIR);
    writeFileSync(FILE, JSON.stringify(next) + '\n');

    return next;
}
