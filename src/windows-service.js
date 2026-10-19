import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ensureDir } from './fs-util.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLocalConfig } from './local-config.js';
import { mkcertCaPath } from './mkcert.js';
import { APP_TITLE, COMMAND, PROFILE, profiled } from './profile.js';
import { selfCommand } from './runtime.js';
import { STATE_DIR, clearPid, runningPid } from './state.js';
import { TRAY_ICON_ICO_BASE64 } from './tray-icon.js';

export const WINDOWS_LOG = join(STATE_DIR, `${profiled('prisma-agent')}.log`);
const PROGRAMS_DIR = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const STARTUP_DIR = join(PROGRAMS_DIR, 'Startup');
const LAUNCHER = join(STARTUP_DIR, `${profiled('prisma-agent')}.vbs`);
/** Lanzador para `start` con el inicio automático apagado (no está en Inicio: no arranca al iniciar sesión). */
const SESSION_LAUNCHER = join(STATE_DIR, 'run.vbs');
/** Acceso «Prisma Sync» del menú Inicio → open.vbs (corre `start` y avisa si no arrancó). */
const SHORTCUT = join(PROGRAMS_DIR, `${APP_TITLE}.lnk`);
const OPEN_SCRIPT = join(STATE_DIR, 'open.vbs');
const SHORTCUT_ICON = join(STATE_DIR, 'prisma.ico');

/** Literal de VBScript: comillas duplicadas. */
const vbs = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * El .vbs de la carpeta Inicio: lanza `prisma-agent run` oculto, sin ventana de consola. El
 * log lo escribe el agente (PRISMA_AGENT_LOG_FILE, ver log.js) para poder rotarlo; hasta
 * 0.4.x era `cmd /c "… >> log"`, y ese archivo no se puede recortar mientras corre.
 */
function launcherScript(url) {
    const lines = ['Set sh = CreateObject("WScript.Shell")', 'Set env = sh.Environment("Process")'];
    if (PROFILE) lines.push(`env("PRISMA_AGENT_PROFILE") = ${vbs(PROFILE)}`);
    lines.push(`env("PRISMA_AGENT_LOG_FILE") = ${vbs(WINDOWS_LOG)}`);

    // Sólo para pruebas contra https://*.test (mkcert).
    if (/\.test(:\d+)?$/i.test(new URL(url).host)) {
        const ca = mkcertCaPath();
        if (ca) {
            lines.push(`env("NODE_EXTRA_CA_CERTS") = ${vbs(ca)}`);
        } else {
            console.warn('⚠ La URL es .test pero no encontré la CA de mkcert (`mkcert -CAROOT`). El agente no va a poder conectarse.');
        }
    }

    const launch = selfCommand().map((a) => `"${a}"`).join(' ');
    lines.push(`sh.Run ${vbs(`${launch} run`)}, 0, False`);

    return lines.join('\r\n') + '\r\n';
}

/**
 * `prisma-agent install` en Windows: el .vbs en la carpeta Inicio del usuario (ver
 * launcherScript). Sin permisos de administrador ni servicios de Windows: el agente necesita
 * la sesión del usuario para el Administrador de credenciales, los avisos y el selector de
 * carpetas.
 */
export function installWindows() {
    const local = readLocalConfig();
    if (!local?.url) {
        throw new Error(`Primero \`${COMMAND} login\`.`);
    }

    ensureDir(STATE_DIR);
    ensureDir(STARTUP_DIR);
    writeFileSync(LAUNCHER, launcherScript(local.url));

    stopRunning();
    spawn('wscript.exe', [LAUNCHER], { stdio: 'ignore', detached: true, windowsHide: true }).unref();

    try {
        writeStartMenuShortcut();
    } catch (err) {
        console.warn(`⚠ No se pudo crear el acceso del menú Inicio: ${err.message}`);
    }

    console.log(`✔ Instalado (${LAUNCHER}). Arranca solo al iniciar sesión en Windows; ya quedó corriendo.`);
    console.log(`  Si lo cerrás, se vuelve a abrir con «${APP_TITLE}» en el menú Inicio.`);
    console.log(`  Logs: Get-Content -Wait "${WINDOWS_LOG}"`);
}

/**
 * Al arrancar el agente instalado: si el .vbs es de una versión anterior (sin
 * PRISMA_AGENT_LOG_FILE), lo reescribe. Vale desde el próximo arranque. Sólo si el lanzador
 * apunta a este mismo ejecutable: un `run` desde el código no tiene que pisar al instalado.
 */
export function refreshLauncherWindows(url) {
    try {
        if (!existsSync(LAUNCHER)) return;
        const current = readFileSync(LAUNCHER, 'utf8');
        if (!current.includes(process.execPath)) return;
        const fresh = launcherScript(url);
        if (current !== fresh) writeFileSync(LAUNCHER, fresh);
    } catch {
        // Sin permiso o en uso: se intenta en el próximo arranque.
    }
}

/** ¿Está el .vbs en la carpeta Inicio? */
export function isInstalledWindows() {
    return existsSync(LAUNCHER);
}

/**
 * «Iniciar con la computadora» desde Mi perfil, con el agente ya corriendo: sólo escribe o
 * borra el .vbs, sin lanzar ni frenar nada. Vale desde el próximo inicio de sesión.
 */
export function setAutostartWindows(enabled, url) {
    if (enabled) {
        ensureDir(STATE_DIR);
        ensureDir(STARTUP_DIR);
        writeFileSync(LAUNCHER, launcherScript(url));
    } else if (existsSync(LAUNCHER)) {
        rmSync(LAUNCHER);
    }
}

export function uninstallWindows() {
    if (existsSync(LAUNCHER)) rmSync(LAUNCHER);
    for (const path of [SESSION_LAUNCHER, SHORTCUT, OPEN_SCRIPT, SHORTCUT_ICON]) rmSync(path, { force: true });
    stopRunning();

    console.log(`✔ Desinstalado. (La sesión sigue: \`${COMMAND} logout\` para cerrarla.)`);
}

/**
 * Reinicia el agente instalado: frena el que corre (si no es este proceso) y vuelve a lanzar
 * el .vbs. Devuelve false si no está instalado (no hay lanzador en la carpeta Inicio).
 */
export function restartWindows() {
    if (!existsSync(LAUNCHER)) return false;

    stopRunning();
    spawn('wscript.exe', [LAUNCHER], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    return true;
}

/**
 * `prisma-agent start` (lo que corre el acceso del menú Inicio): lanza el agente oculto con el
 * .vbs de la carpeta Inicio o, con el inicio automático apagado, con uno igual fuera de ella.
 * Que no haya otro corriendo lo verifica cli.js antes.
 */
export function startWindows() {
    const local = readLocalConfig();
    if (!local?.url) {
        throw new Error(`Sin sesión: corré \`${COMMAND} login\` en PowerShell.`);
    }

    let launcher = LAUNCHER;
    if (!existsSync(LAUNCHER)) {
        ensureDir(STATE_DIR);
        writeFileSync(SESSION_LAUNCHER, launcherScript(local.url));
        launcher = SESSION_LAUNCHER;
    }
    spawn('wscript.exe', [launcher], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

/**
 * open.vbs: corre `start` oculto y espera el código de salida (3 = ya estaba abierto). Va en
 * UTF-16 con BOM para que wscript lea bien los acentos (y rutas con caracteres no ASCII).
 */
function openScript() {
    const launch = [...selfCommand(), 'start'].map((a) => `"${a}"`).join(' ');
    const lines = ['Set sh = CreateObject("WScript.Shell")'];
    if (PROFILE) lines.push('Set env = sh.Environment("Process")', `env("PRISMA_AGENT_PROFILE") = ${vbs(PROFILE)}`);
    lines.push(
        `rc = sh.Run(${vbs(launch)}, 0, True)`,
        'If rc = 3 Then',
        `    MsgBox "Ya está abierto: el ícono está en la bandeja, junto al reloj.", 64, ${vbs(APP_TITLE)}`,
        'ElseIf rc <> 0 Then',
        `    MsgBox "No se pudo abrir. Para ver el motivo, corré en PowerShell:" & vbCrLf & vbCrLf & ${vbs(`${COMMAND} start`)}, 16, ${vbs(APP_TITLE)}`,
        'End If',
    );
    return lines.join('\r\n') + '\r\n';
}

const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

/**
 * Acceso «Prisma Sync» en el menú Inicio (se busca con la tecla Windows y se puede anclar a
 * la barra de tareas). Lo crea `install` y, para los que instalaron antes, el agente al
 * arrancar. El .lnk se arma por COM (WScript.Shell) desde PowerShell; las rutas van por
 * variables de entorno, sin nada que escapar.
 */
export function writeStartMenuShortcut() {
    ensureDir(STATE_DIR);
    const script = utf16(openScript());
    const scriptChanged = !existsSync(OPEN_SCRIPT) || !readFileSync(OPEN_SCRIPT).equals(script);
    if (scriptChanged) writeFileSync(OPEN_SCRIPT, script);
    if (!existsSync(SHORTCUT_ICON)) writeFileSync(SHORTCUT_ICON, Buffer.from(TRAY_ICON_ICO_BASE64, 'base64'));
    if (!scriptChanged && existsSync(SHORTCUT)) return;

    const ps = `
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:PA_LNK)
$s.TargetPath = $env:PA_WSCRIPT
$s.Arguments = '"' + $env:PA_SCRIPT + '"'
$s.IconLocation = $env:PA_ICO + ',0'
$s.Description = $env:PA_DESC
$s.Save()
`;
    ensureDir(PROGRAMS_DIR);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
        stdio: 'ignore',
        windowsHide: true,
        env: {
            ...process.env,
            PA_LNK: SHORTCUT,
            PA_WSCRIPT: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'),
            PA_SCRIPT: OPEN_SCRIPT,
            PA_ICO: SHORTCUT_ICON,
            PA_DESC: `Abre ${APP_TITLE} si está cerrado`,
        },
    });
}

function stopRunning() {
    const pid = runningPid();
    if (pid && pid !== process.pid) {
        try {
            process.kill(pid);
        } catch {
            // Ya no estaba.
        }
    }
    clearPid();
}
