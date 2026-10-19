import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ensureDir } from './fs-util.js';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { APP_ICON_PNG_BASE64 } from './app-icon.js';
import { readLocalConfig } from './local-config.js';
import { mkcertCaPath } from './mkcert.js';
import { APP_TITLE, COMMAND, PROFILE, profiled } from './profile.js';
import { selfCommand } from './runtime.js';
import { STATE_DIR } from './state.js';
import { VERSION } from './version.js';

const LABEL = profiled('com.prisma3d.agent', '.');
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library', 'Logs', `${profiled('prisma-agent')}.log`);
/** Plist para `start` con el inicio automático apagado: fuera de LaunchAgents, no arranca al iniciar sesión. */
const SESSION_PLIST = join(STATE_DIR, `${LABEL}.plist`);
/** «Prisma Sync.app» en ~/Applications: lo encuentran Spotlight y Launchpad, y se puede dejar en el Dock. */
const APP = join(homedir(), 'Applications', `${APP_TITLE}.app`);
const APP_LAUNCHER = join(APP, 'Contents', 'MacOS', 'launcher');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(args, { ignoreErrors = false } = {}) {
    try {
        execFileSync('launchctl', args, { stdio: 'pipe' });
    } catch (err) {
        if (!ignoreErrors) throw new Error(`launchctl ${args.join(' ')}: ${err.stderr?.toString().trim() || err.message}`);
    }
}

/** El plist del LaunchAgent: arranca con la sesión y se reinicia si se cae. */
function plistXml(url) {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' };
    if (PROFILE) env.PRISMA_AGENT_PROFILE = PROFILE;

    // Sólo para pruebas contra https://*.test (mkcert): Node no confía en esa CA.
    if (/\.test(:\d+)?$/i.test(new URL(url).host)) {
        const ca = mkcertCaPath();
        if (ca) {
            env.NODE_EXTRA_CA_CERTS = ca;
        } else {
            console.warn('⚠ La URL es .test pero no encontré la CA de mkcert (`mkcert -CAROOT`). El agente no va a poder conectarse.');
        }
    }

    const envXml = Object.entries(env)
        .map(([k, v]) => `            <key>${xml(k)}</key>\n            <string>${xml(v)}</string>`)
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
    <dict>
        <key>Label</key>
        <string>${LABEL}</string>
        <key>ProgramArguments</key>
        <array>
${[...selfCommand(), 'run'].map((a) => `            <string>${xml(a)}</string>`).join('\n')}
        </array>
        <key>EnvironmentVariables</key>
        <dict>
${envXml}
        </dict>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <true/>
        <key>ThrottleInterval</key>
        <integer>30</integer>
        <key>StandardOutPath</key>
        <string>${xml(LOG)}</string>
        <key>StandardErrorPath</key>
        <string>${xml(LOG)}</string>
    </dict>
</plist>
`;
}

function writePlist(url) {
    ensureDir(dirname(PLIST));
    ensureDir(dirname(LOG));
    writeFileSync(PLIST, plistXml(url));
}

/** `prisma-agent install`: escribe el LaunchAgent y lo levanta ya. */
export function install() {
    if (platform() !== 'darwin') {
        throw new Error('Este `install` es el de macOS (launchd).');
    }

    const local = readLocalConfig();
    if (!local?.url) {
        throw new Error(`Primero \`${COMMAND} login\`.`);
    }

    writePlist(local.url);

    const domain = `gui/${process.getuid()}`;
    launchctl(['bootout', `${domain}/${LABEL}`], { ignoreErrors: true });
    launchctl(['bootstrap', domain, PLIST]);

    try {
        writeLauncherApp();
    } catch (err) {
        console.warn(`⚠ No se pudo crear ${APP}: ${err.message}`);
    }

    console.log(`✔ Instalado (${PLIST}). Arranca solo al iniciar sesión.`);
    console.log(`  Si lo cerrás, se vuelve a abrir con «${APP_TITLE}» (Spotlight, Launchpad o ~/Applications).`);
    console.log(`  Logs: tail -f "${LOG}"`);
}

export function uninstall() {
    if (platform() !== 'darwin') return;

    launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`], { ignoreErrors: true });
    if (existsSync(PLIST)) rmSync(PLIST);
    rmSync(SESSION_PLIST, { force: true });
    rmSync(APP, { recursive: true, force: true });

    console.log(`✔ Desinstalado. (La sesión sigue: \`${COMMAND} logout\` para cerrarla.)`);
}

/** ¿Está instalado como servicio (LaunchAgent)? */
export function isInstalledMac() {
    return platform() === 'darwin' && existsSync(PLIST);
}

/**
 * «Iniciar con la computadora» desde Mi perfil, con el agente ya corriendo: sólo escribe o
 * borra el plist, sin `bootstrap`/`bootout`. Este proceso sigue como está (si lo lanzó
 * launchd, el servicio queda cargado hasta cerrar sesión) y el cambio vale desde el próximo
 * inicio de sesión. Un bootout acá lo mataría, y un bootstrap lanzaría un segundo agente.
 */
export function setAutostartMac(enabled, url) {
    if (enabled) {
        writePlist(url);
    } else if (existsSync(PLIST)) {
        rmSync(PLIST);
    }
}

/**
 * `prisma-agent start` (lo que corre «Prisma Sync.app»): levanta el servicio si está cerrado.
 * Cargado (corriendo, o esperando el ThrottleInterval) → kickstart sin -k, que no reinicia uno
 * que ya anda. Si no, bootstrap del plist de LaunchAgents o, con el inicio automático apagado,
 * de uno igual fuera de esa carpeta: corre como servicio (KeepAlive, «Salir» lo baja) pero no
 * vuelve a arrancar al iniciar sesión.
 */
export function startMac() {
    const local = readLocalConfig();
    if (!local?.url) {
        throw new Error(`Sin sesión: corré \`${COMMAND} login\` en la Terminal.`);
    }

    const domain = `gui/${process.getuid()}`;
    if (serviceLoaded()) {
        launchctl(['kickstart', `${domain}/${LABEL}`]);
        return;
    }

    let plist = PLIST;
    if (!existsSync(PLIST)) {
        ensureDir(dirname(SESSION_PLIST));
        ensureDir(dirname(LOG));
        writeFileSync(SESSION_PLIST, plistXml(local.url));
        plist = SESSION_PLIST;
    }
    launchctl(['bootstrap', domain, plist]);
}

function serviceLoaded() {
    try {
        execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Script de «Prisma Sync.app»: corre `start` y, si no arrancó, lo dice en un aviso del sistema. */
function launcherScript() {
    const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const command = [...selfCommand(), 'start'].map(sh).join(' ');

    return `#!/bin/sh
# Generado por \`${COMMAND} install\`: abre ${APP_TITLE} si está cerrado.
${PROFILE ? `export PRISMA_AGENT_PROFILE=${sh(PROFILE)}\n` : ''}out=$(${command} 2>&1)
case $? in
  0) ;;
  3) osascript - ${sh(APP_TITLE)} <<'EOF'
on run argv
  display notification "Ya está abierto: el ícono está en la barra de menú." with title (item 1 of argv)
end run
EOF
  ;;
  *) osascript - ${sh(APP_TITLE)} "$out" <<'EOF'
on run argv
  display alert ("No se pudo abrir " & item 1 of argv) message (item 2 of argv) as critical
end run
EOF
  ;;
esac
`;
}

function infoPlist() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
    <dict>
        <key>CFBundleExecutable</key>
        <string>launcher</string>
        <key>CFBundleIdentifier</key>
        <string>${LABEL}.launcher</string>
        <key>CFBundleName</key>
        <string>${xml(APP_TITLE)}</string>
        <key>CFBundleDisplayName</key>
        <string>${xml(APP_TITLE)}</string>
        <key>CFBundleIconFile</key>
        <string>AppIcon</string>
        <key>CFBundlePackageType</key>
        <string>APPL</string>
        <key>CFBundleShortVersionString</key>
        <string>${VERSION}</string>
        <key>LSUIElement</key>
        <true/>
    </dict>
</plist>
`;
}

/**
 * Crea (o actualiza) «Prisma Sync.app»: un bundle mínimo cuyo ejecutable es launcherScript().
 * Lo hace `install` y, para los que instalaron antes de que existiera, el agente al arrancar.
 * Se reescribe sólo si cambió (ej. otra ruta o versión) para no tocar el bundle en cada arranque.
 */
export function writeLauncherApp() {
    const script = launcherScript();
    const plist = infoPlist();
    const plistPath = join(APP, 'Contents', 'Info.plist');
    const same = (path, content) => existsSync(path) && readFileSync(path, 'utf8') === content;
    if (same(APP_LAUNCHER, script) && same(plistPath, plist)) return;

    ensureDir(dirname(APP_LAUNCHER));
    writeFileSync(APP_LAUNCHER, script);
    chmodSync(APP_LAUNCHER, 0o755);
    writeFileSync(plistPath, plist);

    const resources = join(APP, 'Contents', 'Resources');
    ensureDir(resources);
    const png = join(resources, 'AppIcon.png');
    try {
        writeFileSync(png, Buffer.from(APP_ICON_PNG_BASE64, 'base64'));
        execFileSync('sips', ['-s', 'format', 'icns', png, '--out', join(resources, 'AppIcon.icns')], { stdio: 'ignore' });
    } catch {
        // Sin ícono la app anda igual (queda el genérico).
    } finally {
        rmSync(png, { force: true });
    }
    // Que Finder / Launchpad tomen el ícono y el nombre nuevos.
    try {
        execFileSync('touch', [APP]);
    } catch {
        // No importa.
    }
}

/**
 * Reinicia el servicio (después de actualizar el ejecutable desde la terminal). `kickstart -k`
 * sólo anda con el servicio cargado: si está instalado pero no corre (se cerró desde el ícono,
 * o el plist lo escribió «Iniciar con la computadora» sin bootstrap), lo levanta con el plist.
 * Devuelve false si no hay nada instalado que levantar.
 */
export function restartMac() {
    const domain = `gui/${process.getuid()}`;

    if (serviceLoaded()) {
        launchctl(['kickstart', '-k', `${domain}/${LABEL}`]);
        return true;
    }

    if (!existsSync(PLIST)) return false;

    launchctl(['bootstrap', domain, PLIST]);
    return true;
}

/**
 * ¿Este proceso lo lanzó el servicio de launchd de este perfil? (launchd pone el label del
 * servicio en XPC_SERVICE_NAME.) Corriendo a mano (`run`, `npm run local`) es false.
 */
export function runningUnderLaunchd() {
    return platform() === 'darwin' && process.env.XPC_SERVICE_NAME === LABEL;
}

/**
 * «Cerrar» desde el ícono con el servicio corriendo: lo baja de launchd (si sólo se saliera,
 * KeepAlive lo relanzaría). El plist queda: vuelve a arrancar en el próximo inicio de sesión.
 * launchd le manda SIGTERM a este proceso, que se cierra con su handler.
 */
export function stopServiceUntilLogin() {
    launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`], { ignoreErrors: true });
}

export const LOG_PATH = LOG;
