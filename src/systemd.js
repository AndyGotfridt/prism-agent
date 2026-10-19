import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureDir } from './fs-util.js';
import { readLocalConfig } from './local-config.js';
import { COMMAND, PROFILE, profiled } from './profile.js';
import { selfCommand } from './runtime.js';
import { STATE_DIR } from './state.js';

/**
 * Prisma Agent como servicio de Linux: una unidad `systemd --user` (sin root), pensada para una
 * Raspberry Pi o una mini PC que hace de puente (docs/PLAN-AGENT-BRIDGE.md). Equivale a launchd en
 * macOS y a la carpeta Inicio en Windows. `loginctl enable-linger` hace que arranque al prender la
 * máquina aunque nadie inicie sesión.
 *
 * Logs: al archivo del estado (el agente lo rota solo) y también `journalctl --user -u <unidad>`.
 */
const UNIT_NAME = `${profiled('prisma-agent')}.service`;
const UNIT = join(homedir(), '.config', 'systemd', 'user', UNIT_NAME);
export const LINUX_LOG = join(STATE_DIR, `${profiled('prisma-agent')}.log`);

const isLinux = () => platform() === 'linux';

function systemctl(args, { ignoreErrors = false } = {}) {
    const res = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
    if (res.error) {
        if (ignoreErrors) return false;
        throw new Error('No se encontró systemctl: este Linux no usa systemd. Corré `' + COMMAND + ' run` con tu gestor de servicios.');
    }
    if (res.status !== 0 && !ignoreErrors) {
        throw new Error(`systemctl --user ${args.join(' ')}: ${(res.stderr || res.stdout).trim() || `código ${res.status}`}`);
    }

    return res.status === 0;
}

/** Comillas de systemd para ExecStart: cada argumento entre comillas dobles. */
const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1').replace(/%/g, '%%')}"`;

export function unitText() {
    const exec = [...selfCommand(), 'run'].map(q).join(' ');

    return `[Unit]
Description=Prisma Agent${PROFILE ? ` (${PROFILE})` : ''}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Environment=${q(`PRISMA_AGENT_PROFILE=${PROFILE ?? ''}`)}
Environment=${q(`PRISMA_AGENT_LOG_FILE=${LINUX_LOG}`)}
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
`;
}

/** `prisma-agent install`: escribe la unidad, la habilita y la levanta ya. */
export function installLinux() {
    if (!isLinux()) throw new Error('Este `install` es el de Linux (systemd).');
    if (!readLocalConfig()?.url) throw new Error(`Primero \`${COMMAND} login\`.`);

    ensureDir(dirname(UNIT));
    ensureDir(STATE_DIR);
    writeFileSync(UNIT, unitText());
    systemctl(['daemon-reload']);
    systemctl(['enable', '--now', UNIT_NAME]);

    // Sin esto, el servicio de usuario se detiene al cerrar la última sesión (SSH) y no arranca al prender la máquina.
    const linger = spawnSync('loginctl', ['enable-linger', userInfo().username], { encoding: 'utf8' });
    const lingerOk = !linger.error && linger.status === 0;

    console.log(`✔ Instalado (${UNIT}). Arranca solo.`);
    if (!lingerOk) {
        console.log(`  ⚠ Para que arranque al prender la máquina sin iniciar sesión: sudo loginctl enable-linger ${userInfo().username}`);
    }
    console.log(`  Logs: tail -f "${LINUX_LOG}"   ·   Estado: systemctl --user status ${UNIT_NAME}`);
}

export function uninstallLinux() {
    if (!isLinux()) return;
    systemctl(['disable', '--now', UNIT_NAME], { ignoreErrors: true });
    rmSync(UNIT, { force: true });
    systemctl(['daemon-reload'], { ignoreErrors: true });
    console.log(`✔ Desinstalado. (La sesión sigue: \`${COMMAND} logout\` para cerrarla.)`);
}

export function isInstalledLinux() {
    return isLinux() && existsSync(UNIT);
}

/** `prisma-agent start`: lo levanta si está instalado; si no, avisa cómo. */
export function startLinux() {
    if (!isInstalledLinux()) throw new Error(`No está instalado como servicio. Corré \`${COMMAND} install\` (o \`${COMMAND} run\` en primer plano).`);
    systemctl(['start', UNIT_NAME]);
}

/** Reinicia el servicio (tras actualizar). false si no está instalado. */
export function restartLinux() {
    if (!isInstalledLinux()) return false;
    systemctl(['restart', UNIT_NAME]);

    return true;
}

/** ¿Arranca con la máquina? (la unidad existe y está habilitada) */
export function isEnabledLinux() {
    return isInstalledLinux() && systemctl(['is-enabled', '--quiet', UNIT_NAME], { ignoreErrors: true });
}

/** ¿Lo lanzó systemd? (Restart=always lo relanza al salir.) */
export function runningUnderSystemd() {
    return isLinux() && Boolean(process.env.INVOCATION_ID) && Boolean(process.env.JOURNAL_STREAM || process.env.PRISMA_AGENT_LOG_FILE);
}

/** «Iniciar con la computadora» desde la web: habilita o deshabilita la unidad sin tocar el proceso que corre. */
export function setAutostartLinux(enabled) {
    if (!isInstalledLinux()) {
        if (enabled) {
            ensureDir(dirname(UNIT));
            writeFileSync(UNIT, unitText());
            systemctl(['daemon-reload'], { ignoreErrors: true });
        } else {
            return;
        }
    }
    systemctl([enabled ? 'enable' : 'disable', UNIT_NAME], { ignoreErrors: true });
}
