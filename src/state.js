import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ensureDir } from './fs-util.js';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { profiled } from './profile.js';

/**
 * Carpeta de estado del agente (PID y, en Windows, logs y lanzador).
 * macOS/Linux: ~/.config/prisma-agent · Windows: %LOCALAPPDATA%\prisma-agent
 * (con perfil: prisma-agent-<perfil>).
 */
export const STATE_DIR = platform() === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), profiled('prisma-agent'))
    : join(homedir(), '.config', profiled('prisma-agent'));

const PID_FILE = join(STATE_DIR, 'agent.pid');

export function writePid() {
    ensureDir(STATE_DIR);
    writeFileSync(PID_FILE, String(process.pid));
}

export function clearPid() {
    rmSync(PID_FILE, { force: true });
}

/** PID del agente que está corriendo, o null. */
export function runningPid() {
    try {
        const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10);
        if (!pid) return null;
        process.kill(pid, 0); // sólo verifica que exista
        return pid;
    } catch {
        return null;
    }
}

/**
 * PID de OTRO agente de este perfil que ya está corriendo, o null. Dos agentes sobre la misma
 * carpeta suben todo dos veces y se pisan la ventanita (la barra «avanza y retrocede»). Se
 * confirma que el PID sea de un proceso con el mismo ejecutable: un PID viejo reusado por
 * otro programa no tiene que impedir que arranque.
 */
export function otherAgentPid() {
    const pid = runningPid();
    if (!pid || pid === process.pid || pid === process.ppid) return null;

    const self = basename(process.execPath).toLowerCase();
    try {
        const name = platform() === 'win32'
            ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().split(',')[0].replace(/"/g, '')
            : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        return basename(name.trim()).toLowerCase() === self ? pid : null;
    } catch {
        return null; // sin forma de confirmarlo: mejor arrancar
    }
}
