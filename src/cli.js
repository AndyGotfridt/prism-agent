import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { Api, ApiError } from './api.js';
import { getToken } from './keychain.js';
import { install as installMac, isInstalledMac, restartMac, startMac, uninstall as uninstallMac, LOG_PATH as MAC_LOG } from './launchd.js';
import { CONFIG_PATH, readLocalConfig } from './local-config.js';
import { login, logout } from './login.js';
import { mkcertCaPath } from './mkcert.js';
import { APP_TITLE, COMMAND, PROFILE } from './profile.js';
import { expandHome, run } from './run.js';
import { selfCommand } from './runtime.js';
import { windowsRootsPem } from './system-ca.js';
import { VERSION } from './version.js';
import { LINUX_LOG, installLinux, restartLinux, startLinux, uninstallLinux, isInstalledLinux } from './systemd.js';
import { handleUrl } from './windows-toast.js';
import { CHANNELS, updateChannel, writePrefs } from './prefs.js';
import { WINDOWS_LOG, installWindows, restartWindows, startWindows, uninstallWindows } from './windows-service.js';
import { canSelfUpdate, changeVerb, installUpdate, wantsChange } from './updater.js';
import { DEMO_ENABLED, DEMO_SCENARIOS, runDemo } from './demo.js';
import { formatMb, remaining } from './format.js';
import { startTray, stopTray, updateTray, useRunningHelper } from './progress-ui.js';
import { otherAgentPid } from './state.js';
import { syncCommand } from './sync-cli.js';
import { bridgeStatusCommand } from './bridge/bridge.js';

const IS_WINDOWS = platform() === 'win32';
const IS_LINUX = platform() === 'linux';
const LOG_PATH = IS_WINDOWS ? WINDOWS_LOG : IS_LINUX ? LINUX_LOG : MAC_LOG;

const DEFAULT_URL = 'https://3d.prism.com.ar';

const HELP = `Prisma Agent ${VERSION}:

Uso:
  prisma-agent login [--url ${DEFAULT_URL}] [--name "MacBook de Andy"] [--device]
                              --device: sin navegador, con un código que se ingresa en la web (automático en Linux sin pantalla)
  prisma-agent logout
  prisma-agent status
  prisma-agent sync           Sincronización Drive: ver estado, pausar, cambiar carpeta (sync help)
  prisma-agent run            Sincroniza la carpeta en primer plano (logs a la terminal)
  prisma-agent start          Lo abre en segundo plano si está cerrado (lo mismo que el acceso «Prisma Sync»)
${DEMO_ENABLED ? `  prisma-agent demo [${DEMO_SCENARIOS.join('|')}]
                              Muestra la ventanita con un caso de prueba (no sube nada)
` : ''}  prisma-agent channel [stable|beta]
                              Canal de actualizaciones de esta computadora (sin argumento: muestra el actual)
  prisma-agent update         Baja e instala la versión publicada en Prisma (y reinicia el servicio)
  prisma-agent install        Lo deja corriendo al iniciar sesión (macOS: launchd · Windows: carpeta Inicio · Linux: systemd --user)
  prisma-agent bridge status  Modo puente: impresoras que ve este agente, conexión y último reporte
  prisma-agent uninstall
  prisma-agent --version

Perfiles:
  prisma-agent --profile local login --url https://prism.com.ar
  prisma-agent --profile local install
  También con la variable PRISMA_AGENT_PROFILE=local. Cada perfil tiene su sesión, su
  servicio y sus logs; sin perfil es el agente de siempre.
`;

function parseArgs(argv) {
    // --profile ya lo resolvió profile.js (al importarse): acá se saca para no confundirlo con el comando.
    const args = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--profile') i++;
        else if (!argv[i].startsWith('--profile=')) args.push(argv[i]);
    }
    const [command, ...rest] = args;
    const opts = {};
    for (let i = 0; i < rest.length; i++) {
        const m = rest[i].match(/^--([a-z-]+)(?:=(.*))?$/);
        if (!m) continue;
        opts[m[1]] = m[2] ?? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true);
    }
    return { command, opts };
}

/**
 * NODE_EXTRA_CA_CERTS sólo se lee al arrancar: si hace falta una CA extra, se relanza el
 * proceso con ella.
 * - Windows: las raíces del almacén de Windows (antivirus que inspeccionan HTTPS, proxies de
 *   empresa; incluye la CA de mkcert si se instaló con `mkcert -install`). Ver system-ca.js.
 * - macOS/Linux contra https://*.test: la CA de mkcert, en la que Node no confía.
 * En producción (Cloudflare) el certificado es público y en macOS esto no corre.
 */
function reexecWithExtraCaIfNeeded(url, argv) {
    if (process.env.NODE_EXTRA_CA_CERTS || process.env.PRISMA_AGENT_REEXEC) return;

    let ca = null;
    if (IS_WINDOWS) {
        ca = windowsRootsPem();
    } else {
        let host;
        try {
            host = new URL(url).host;
        } catch {
            return;
        }
        if (!/\.test(:\d+)?$/i.test(host)) return;
        ca = mkcertCaPath();
    }
    if (!ca) return;

    const [cmd, ...pre] = selfCommand();
    const res = spawnSync(cmd, [...pre, ...argv], {
        stdio: 'inherit',
        env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, PRISMA_AGENT_REEXEC: '1' },
    });
    process.exit(res.status ?? 1);
}

export async function main(argv) {
    const { command, opts } = parseArgs(argv);
    const local = readLocalConfig();

    switch (command) {
        case 'login': {
            const url = typeof opts.url === 'string' ? opts.url : DEFAULT_URL;
            reexecWithExtraCaIfNeeded(url, argv);
            return login({ url, name: typeof opts.name === 'string' ? opts.name : null, quiet: opts.quiet === true, device: opts.device === true });
        }
        case 'logout':
            reexecWithExtraCaIfNeeded(local?.url, argv);
            return logout();
        case 'status':
            reexecWithExtraCaIfNeeded(local?.url, argv);
            return status(local);
        case 'run':
            reexecWithExtraCaIfNeeded(local?.url, argv);
            return run();
        case 'sync': {
            reexecWithExtraCaIfNeeded(local?.url, argv);
            const args = argv.filter((a, i) => a !== '--profile' && argv[i - 1] !== '--profile' && !a.startsWith('--profile='));

            return syncCommand(args.slice(args.indexOf('sync') + 1), local);
        }
        case 'bridge':
            return bridgeStatusCommand();
        case 'demo': {
            if (!DEMO_ENABLED) {
                console.log(HELP);
                process.exit(1);
            }
            const args = argv.filter((a, i) => a !== '--profile' && argv[i - 1] !== '--profile' && !a.startsWith('--profile='));
            const scenario = args[args.indexOf('demo') + 1] ?? 'all';
            // Con el servicio corriendo, su auxiliar ya está abierto y lee el mismo estado (y el
            // ícono es suyo: no se toca). Si no, la demo levanta su propio ícono mientras dura.
            let tray;
            if (otherAgentPid()) {
                useRunningHelper();
            } else {
                startTray({ status: 'Demo', icon: 'idle', menu: [{ label: 'Demo de Prisma Agent', disabled: true }] }, () => {});
                tray = { set: (status, icon) => updateTray({ status, icon, menu: [{ label: status, disabled: true }] }), restore: () => updateTray({ status: 'Demo', icon: 'idle' }) };
            }
            await runDemo(scenario, { inboxUrl: local?.url ? `${local.url.replace(/\/+$/, '')}/models/inbox` : undefined, tray });
            stopTray();
            process.exit(0); // el timer del sondeo de respuestas no deja terminar solo
        }
        case 'update':
            reexecWithExtraCaIfNeeded(local?.url, argv);
            return update(local);
        case 'start':
            // 3 = ya estaba abierto: el acceso de Aplicaciones / menú Inicio lo avisa distinto que un error.
            if (otherAgentPid()) {
                console.log('Ya está corriendo.');
                process.exit(3);
            }
            if (IS_WINDOWS) startWindows();
            else if (IS_LINUX) startLinux();
            else startMac();
            console.log('✔ Abierto.');
            return;
        case 'channel': {
            // Mismo filtrado que parseArgs: sin `--profile <x>`; [0] es «channel» y [1] el canal pedido.
            const rest = [];
            for (let i = 0; i < argv.length; i++) {
                if (argv[i] === '--profile') i++;
                else if (!argv[i].startsWith('--profile=')) rest.push(argv[i]);
            }
            const wanted = rest[1];
            if (wanted === undefined) {
                console.log(`Canal de actualizaciones: ${CHANNELS[updateChannel()]} (${updateChannel()})`);
                return;
            }
            if (!(wanted in CHANNELS)) throw new Error(`Canal inválido «${wanted}»: stable o beta.`);
            writePrefs({ update_channel: wanted });
            console.log(`✔ Canal ${CHANNELS[wanted]}. Se aplica en el próximo sondeo, o con «Comprobar actualizaciones» en el menú del agente (o \`${COMMAND} update\`).`);
            return;
        }
        case 'handle-url':
            // Lo corre el protocolo prisma-agent:// de Windows (botones de los avisos): sin salida, sin sesión.
            handleUrl(process.env.PA_URL);
            return;
        case 'install':
            return IS_WINDOWS ? installWindows() : IS_LINUX ? installLinux() : installMac();
        case 'uninstall':
            return IS_WINDOWS ? uninstallWindows() : IS_LINUX ? uninstallLinux() : uninstallMac();
        case '--version':
        case '-v':
        case 'version':
            console.log(VERSION);
            return;
        default:
            console.log(HELP);
    }
}

/** `prisma-agent update`: lo mismo que acepta el diálogo del agente, desde la terminal. */
async function update(local) {
    if (!local?.url) throw new Error(`Sin sesión. Corré \`${COMMAND} login\`.`);
    const token = await getToken(local.url);
    if (!token) throw new Error(`No hay token. Corré \`${COMMAND} login\`.`);

    const { data } = await new Api(local.url, token).get('/config');
    const latest = data.agent_update?.version ?? data.latest_agent_version;
    // A una anterior sólo si el server la marca obligatoria (revertir o versión retirada).
    if (!wantsChange(data.agent_update ?? (latest ? { version: latest } : null))) {
        console.log(`Ya está en la versión que corresponde (${VERSION}).`);
        return;
    }
    if (!canSelfUpdate()) {
        const command = IS_WINDOWS ? data.update_commands?.windows : IS_LINUX ? data.update_commands?.linux : data.update_commands?.mac;
        console.log(`Hay una versión nueva (${VERSION} → ${latest}), pero esta instalación no se actualiza sola.${command ? `\nCorré: ${command}` : ''}`);
        return;
    }

    console.log(`${changeVerb(latest)} ${latest} (desde ${VERSION})…`);
    const started = Date.now();
    let lastLine = 0;
    await installUpdate(data.agent_update, {
        onProgress: (received, total) => {
            // En una terminal, una sola línea que se reescribe (cada 200 ms); redirigido, nada.
            if (!process.stdout.isTTY || Date.now() - lastLine < 200) return;
            lastLine = Date.now();
            const line = total
                ? `  ${Math.floor((received / total) * 100)}% · ${formatMb(received)} de ${formatMb(total)}${remaining(started, received, total)}`
                : `  ${formatMb(received)}`;
            process.stdout.write(`\r\x1b[K${line}`);
        },
        onVerify: () => {
            if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
            console.log('Verificando la descarga…');
        },
    });

    // El ejecutable ya quedó reemplazado: si reiniciar falla, la actualización igual está hecha.
    let restarted = false;
    try {
        restarted = IS_WINDOWS ? restartWindows() : IS_LINUX ? isInstalledLinux() && restartLinux() : isInstalledMac() && restartMac();
    } catch (err) {
        console.log(`✔ Actualizado a ${latest}, pero no se pudo reiniciar el servicio (${err.message}).`);
        console.log(`  Abrilo con «${APP_TITLE}» o corré \`${COMMAND} start\`.`);
        return;
    }
    console.log(`✔ Actualizado a ${latest}${restarted ? '; el servicio ya se reinició' : ''}.`);
}

async function status(local) {
    console.log(`Prisma Agent ${VERSION}`);
    console.log(`Perfil:       ${PROFILE ?? 'por defecto'}`);
    console.log(`Config local: ${CONFIG_PATH}`);

    if (!local?.url) {
        console.log(`Sin sesión. Corré \`${COMMAND} login\`.`);
        return;
    }

    console.log(`Servidor:     ${local.url}`);
    const token = await getToken(local.url);
    if (!token) {
        console.log(`Token:        no hay (corré \`${COMMAND} login\`)`);
        return;
    }

    const api = new Api(local.url, token);
    try {
        const { data: me } = await api.get('/me');
        const { data: cfg } = await api.get('/config');
        const folder = expandHome(cfg.config.watch_folder);

        console.log(`Usuario:      ${me.user.name} <${me.user.email}>`);
        console.log(`Dispositivo:  ${me.device.name} (#${me.device.id})`);
        console.log(`Token vence:  ${me.token_expires_at ? new Date(me.token_expires_at).toLocaleDateString() : 'nunca'}`);
        console.log(`Prisma Sync: ${me.inbox_url}`);
        console.log('Configuración efectiva:');
        for (const [k, v] of Object.entries(cfg.config)) {
            console.log(`  ${k.padEnd(20)} ${JSON.stringify(v)}`);
        }

        let pending = [];
        try {
            pending = readdirSync(folder).filter((f) => /\.3mf$/i.test(f) && statSync(join(folder, f)).isFile());
        } catch {
            // La carpeta todavía no existe: la crea `run`.
        }
        console.log(`En la carpeta (sin subir): ${pending.length}${pending.length ? `\n  - ${pending.join('\n  - ')}` : ''}`);
        console.log(`Logs del servicio: ${LOG_PATH}`);
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
            console.log(`Token:        inválido o revocado (corré \`${COMMAND} login\`)`);
            return;
        }
        throw err;
    }
}
