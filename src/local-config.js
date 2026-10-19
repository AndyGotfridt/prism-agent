import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { ensureDir } from './fs-util.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { profiled } from './profile.js';

/**
 * Lo único que queda en la Mac (fuera del Keychain): la URL base y el id del dispositivo.
 * El resto de la configuración es del server (GET /api/agent/v1/config).
 */
export const CONFIG_PATH = join(homedir(), '.config', profiled('prisma-agent'), 'config.json');

export function readLocalConfig() {
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return null;
    }
}

export function writeLocalConfig(data) {
    ensureDir(dirname(CONFIG_PATH));
    writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function clearLocalConfig() {
    rmSync(CONFIG_PATH, { force: true });
}
