import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { ensureDir } from './fs-util.js';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { watch } from 'chokidar';
import { Api, ApiError } from './api.js';
import { getToken } from './keychain.js';
import { readLocalConfig } from './local-config.js';
import { LOG_MAX_BYTES, log, ownLogFile, rotateLog, warn } from './log.js';
import { readLogTail } from './log-tail.js';
import { notify, openUrl } from './notify.js';
import { hideProgress, onKindClosed, showMessage, showProgress, startTray, stopTray, updateTray } from './progress-ui.js';
import { readPrefs, writePrefs } from './prefs.js';
import { Bridge } from './bridge/bridge.js';
import { isInstalledLinux, runningUnderSystemd, LINUX_LOG } from './systemd.js';
import { DEMO_ENABLED, runDemo } from './demo.js';
import { login } from './login.js';
import { pickFile, pickFolder } from './folder-picker.js';
import { APP_TITLE, COMMAND } from './profile.js';
import { STATE_DIR, clearPid, otherAgentPid, writePid } from './state.js';
import { canSelfUpdate, askToUpdate, changeVerb, cleanupOldBinary, consumePending, installUpdate, isSnoozed, markPending, snooze, wantsChange } from './updater.js';
import { formatMb, remaining } from './format.js';
import { uploadFile, waitForAnalysis } from './uploader.js';
import { DriveSyncRunner } from './drive-sync.js';
import { ConfigUi } from './config-ui.js';
import { LOG_PATH as MAC_LOG, isInstalledMac, runningUnderLaunchd, stopServiceUntilLogin, writeLauncherApp } from './launchd.js';
import { WINDOWS_LOG, refreshLauncherWindows, restartWindows, writeStartMenuShortcut } from './windows-service.js';
import { AUTOSTART_SUPPORTED, setAutostart } from './autostart.js';
import { PRODUCT_NAME, VERSION, compareVersions } from './version.js';

const UPLOADED_DIR = 'Subidos';
const ERROR_DIR = 'Error';
const AUTH_RETRY_MS = 60_000;
const COMMANDS_EVERY_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const RECENT_FILE = join(STATE_DIR, 'recent.json');
const RECENT_MAX = 5;
const ALERTS_DIR = join(STATE_DIR, 'alerts');
const ALERT_IMAGES_KEEP = 10;
const RECENT_LABELS = { uploading: 'Subiendo…', verifying: 'Verificando…', ready: 'Listo', failed: 'Falló el análisis', duplicate: 'Ya estaba', error: 'No se subió' };
const SEP = { separator: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `~`, `~/x` y `~\\x` (Windows) → ruta absoluta en la home. */
export function expandHome(path) {
    if (path === '~') return homedir();
    return /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

/**
 * `prisma-agent run`: el ciclo del agente. Es «tonto» a propósito: vigila, sube y avisa;
 * todo el análisis vive en el server. La carpeta es la cola (sin base local): al arrancar
 * se procesa lo que haya quedado.
 */
export async function run() {
    const local = readLocalConfig();
    if (!local?.url) {
        throw new Error(`No hay sesión. Corré \`${COMMAND} login\` primero.`);
    }

    const other = otherAgentPid();
    if (other) {
        // Con launchd (KeepAlive) vuelve a intentar cada 30 s: toma la posta cuando el otro se cierra.
        warn(`Another agent is already running (PID ${other}); exiting`);
        process.exit(0);
    }
    writePid();

    keepLogSmall();
    if (process.platform === 'win32') refreshLauncherWindows(local.url);
    ensureOpenShortcut();

    log(`Prisma Agent ${VERSION} started (${local.url})`);
    reportPendingUpdate();

    const agent = new Agent(local.url);
    // Ícono en la barra de menú / bandeja: arranca ya, aunque falte la sesión (lo dice ahí).
    startTray(agent.trayState(), (action) => agent.onTrayAction(action));
    await agent.start();
}

/**
 * Acceso para volver a abrirlo después de «Salir» («Prisma Sync.app» en ~/Applications, o en el
 * menú Inicio de Windows). Lo crea `install`; acá, para los que instalaron antes de que
 * existiera y lo reciben con la actualización. Sólo el ejecutable instalado: corriendo desde el
 * código no tiene que dejar un acceso a Node.
 */
function ensureOpenShortcut() {
    if (!AUTOSTART_SUPPORTED || process.platform === 'linux') return; // sin acceso para abrirlo en Linux
    try {
        if (process.platform === 'win32') writeStartMenuShortcut();
        else writeLauncherApp();
    } catch (err) {
        warn(`Could not create the app shortcut: ${err.message}`);
    }
}

/**
 * Rotación del log del servicio: al arrancar y cada hora, si pasa de LOG_MAX_BYTES, el actual
 * va a `<log>.1` (se pisa el anterior) y se empieza de cero. En macOS el archivo es el que
 * abre launchd; en Windows, el que escribe el agente (log.js). En una terminal, nada que hacer.
 */
function keepLogSmall() {
    const path = ownLogFile() ?? (runningUnderLaunchd() ? MAC_LOG : null);
    if (!path) return;

    const check = () => {
        if (rotateLog(path)) log(`Log rotated (over ${LOG_MAX_BYTES / 1024 / 1024} MB; previous one in ${basename(path)}.1)`);
    };
    check();
    setInterval(check, HOUR_MS).unref();
}

/** Últimos subidos guardados (ver Agent.trackRecent). */
function loadRecent() {
    try {
        const list = JSON.parse(readFileSync(RECENT_FILE, 'utf8'));
        return Array.isArray(list) ? list.slice(0, RECENT_MAX) : [];
    } catch {
        return [];
    }
}

/** Si el agente arrancó después de actualizarse solo, avisa cómo salió (éxito o error). */
function reportPendingUpdate() {
    cleanupOldBinary();
    const pending = consumePending();
    if (!pending) return;

    if (VERSION === pending.to) {
        log(`Updated ${pending.from} → ${VERSION}`);
        if (compareVersions(pending.from, VERSION) > 0) {
            notify(`Volviste a la ${VERSION}`, 'Listo, ya está andando.', 'success');
        } else {
            notify(`Actualizado a la ${VERSION}`, 'Listo, ya está andando la versión nueva.', 'success');
        }
    } else {
        warn(`Update to ${pending.to} did not take; still on ${VERSION}`);
        notify(`No se pudo actualizar a la ${pending.to}`, `Sigue la ${VERSION}. Probá desde Mi perfil → Prisma Agent.`, 'error');
    }
}

class Agent {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.api = null;
        this.config = null;
        this.etag = null;
        this.watcher = null;
        this.watchKey = null;
        this.queue = [];
        this.queued = new Set();
        this.busy = false;
        this.blocked = null; // 'auth' | 'version' | null
        this.picking = false;
        this.authNotified = false;
        this.update = null; // agent_update de /config
        this.updateCommands = null;
        this.updating = false;
        this.uploadingName = null;
        this.me = null; // GET /me: usuario y dispositivo (para el menú del ícono)
        this.counts = { notifications: 0, inbox_pending: null }; // de GET /commands
        this.alertQueue = []; // avisos de escritorio del server, de a uno (ver enqueueAlerts)
        this.showingAlerts = false;
        this.trayStatus = 'Conectando…';
        this.trayIcon = 'idle';
        this.paused = false;
        this.checkingUpdates = false;
        this.manual = new Set(); // subidos con «Subir un archivo…»: no se mueven ni se borran
        this.recent = loadRecent();
        // Carpetas locales → Drive (config.drive_syncs). Corre aparte de la bandeja del slicer.
        this.driveSyncText = null; // «Drive · X: subiendo y.jpg» mientras sincroniza (menú del ícono)
        this.driveSyncList = []; // sincronizaciones de esta computadora (GET /drive-syncs), para el submenú del ícono
        this.driveSyncListAt = 0;
        this.driveSyncDenied = false; // sin permiso de Drive (403): el submenú no aparece
        // Pantalla local para dar de alta/ajustar carpetas sin abrir la web (se levanta al abrirla).
        this.configUi = new ConfigUi(() => this.api, {
            progress: () => this.driveSync.progress(),
            prefs: { get: readPrefs, set: writePrefs, onChange: () => this.showDriveProgress() },
            logPath: () => {
                const path = ownLogFile() ?? (process.platform === 'win32' ? WINDOWS_LOG : process.platform === 'linux' ? LINUX_LOG : MAC_LOG);

                return existsSync(path) ? path : null;
            },
            onChange: () => {
                this.etag = null;
                this.refreshConfig().then(() => this.loadDriveSyncs(true));
            },
        });
        this.driveSyncPopup = false;
        onKindClosed('drive', () => {
            writePrefs({ drive_progress_popup: false });
            this.driveSyncPopup = false;
            showMessage('Ventanita de Drive oculta', 'Para volver a verla: Configurar → Sincronización Drive.');
        });
        this.bridge = new Bridge(() => this.api); // puente con las impresoras de la LAN (si la web lo prende)
        this.driveSyncRev = null; // revisión de las sincronizaciones que informa GET /commands
        this.driveSync = new DriveSyncRunner({
            api: () => this.api,
            isPaused: () => this.paused || this.blocked !== null,
            status: (text) => {
                const ended = this.driveSyncText !== null && text === null;
                this.driveSyncText = text;
                this.showDriveProgress();
                this.refreshTray();
                if (ended) this.loadDriveSyncs(true);
            },
        });
    }

    /** Ventanita con el avance de Drive (suma de las carpetas que están sincronizando). */
    showDriveProgress() {
        const all = Object.values(this.driveSync.progress());
        if (this.driveSyncText === null || all.length === 0 || !readPrefs().drive_progress_popup) {
            if (this.driveSyncPopup) hideProgress();
            this.driveSyncPopup = false;

            return;
        }
        const sum = (k) => all.reduce((n, p) => n + (p[k] ?? 0), 0);
        const planned = sum('planned');
        const processed = sum('processed');
        const walking = all.some((p) => p.walking);
        const failed = sum('failed');
        const current = all.find((p) => p.current)?.current;
        this.driveSyncPopup = true;
        if (planned === 0) {
            showProgress({ kind: 'drive', title: walking ? 'Drive: revisando carpetas…' : 'Drive: todo al día', text: `${sum('seen')} archivos vistos`, pct: null });

            return;
        }
        const pct = Math.floor((processed / planned) * 100);
        showProgress({
            kind: 'drive',
            title: `Sincronizando con Drive - ${pct}%`,
            text: `${processed} de ${planned}${walking ? '+' : ''} procesados · ${Math.max(planned - processed, 0)} pendientes${failed ? ` · ${failed} con error` : ''}${current ? ` · ${current}` : ''}`,
            pct,
        });
    }

    async start() {
        // Primera config: si no hay token o es inválido, espera a que se haga login.
        // Si se inicia sesión desde el ícono, `wake()` corta la espera.
        while (!(await this.refreshConfig())) {
            await new Promise((resolve) => {
                this.wake = resolve;
                setTimeout(resolve, AUTH_RETRY_MS);
            });
        }

        const loop = async () => {
            for (;;) {
                await sleep(this.blocked ? AUTH_RETRY_MS : (this.config?.config_poll_seconds ?? 300) * 1000);
                await this.refreshConfig();
            }
        };
        loop();
        this.commandsLoop();

        const stop = async () => {
            log('Stopping');
            stopTray();
            await this.watcher?.close();
            this.bridge.stop('el agente se detiene');
            await this.driveSync.stopAll();
            clearPid();
            process.exit(0);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    }

    /** Relee /config (con ETag). Devuelve true si el agente puede trabajar. */
    async refreshConfig() {
        const token = await getToken(this.baseUrl);
        if (!token) {
            this.block('auth', `No hay sesión. Iniciala desde el ícono de Prisma o con \`${COMMAND} login\`.`, 'Not logged in; paused until login');
            return false;
        }

        this.api = new Api(this.baseUrl, token);

        let res;
        try {
            res = await this.api.get('/config', { headers: this.etag && !this.blocked ? { 'If-None-Match': this.etag } : {} });
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                this.block('auth', `Debe iniciar sesión para continuar`, 'Session expired or revoked (401); paused until login');
                return false;
            }
            warn(`Could not load config: ${err.message}`);
            return this.config !== null && !this.blocked;
        }

        const wasBlocked = this.blocked;

        if (res.status !== 304) {
            this.etag = res.headers.get('etag');
            const { config, min_agent_version: minVersion, agent_blocked: withdrawn } = res.data;
            this.update = res.data.agent_update ?? (res.data.latest_agent_version ? { version: res.data.latest_agent_version, files: {} } : null);
            this.updateCommands = res.data.update_commands;

            // Versión retirada desde Administración → Prisma Agent → Versiones: no sube nada y
            // cambia a la objetivo sin preguntar (también si es una anterior).
            if (withdrawn === true) {
                const target = this.update?.version;
                this.block('version', `Esta versión (${VERSION}) fue retirada${target ? `: cambiando a la ${target}` : ''}. No se sube nada hasta entonces.`, `Version ${VERSION} was withdrawn; paused until it changes to ${target ?? 'the target version'}`);
                this.maybeUpdate(true);
                return false;
            }
            if (compareVersions(VERSION, minVersion) < 0) {
                this.block('version', `Hay que actualizar Prisma Agent (${VERSION} → ${minVersion} o más nueva). No se sube nada hasta entonces.`, `Version ${VERSION} is below the minimum ${minVersion}; paused until updated`);
                this.maybeUpdate(true);
                return false;
            }

            this.config = config;
            this.inboxUrl = res.data.inbox_url;
            this.loadMe();
        }

        // En cada ciclo (también con 304): así un «Más tarde» vuelve a preguntar al vencer.
        this.maybeUpdate(false);

        this.blocked = null;
        this.authNotified = false;
        this.refreshTray();

        // Cambió la carpeta o cómo se vigila, o se recuperó la sesión: reiniciar el watcher
        // (al arrancar procesa lo que haya quedado en la carpeta).
        const key = JSON.stringify([this.config.watch_folder, this.config.recursive, this.config.stable_ms, this.config.extensions]);
        if (key !== this.watchKey || wasBlocked) {
            await this.startWatcher();
            this.watchKey = key;
        }

        // Carpetas → Drive: sólo reinicia las que cambiaron.
        await this.driveSync.configure(this.config.drive_syncs ?? []);

        return true;
    }

    /**
     * Pedidos de la web (hoy: «Elegir…» carpeta en Mi perfil). Sondeo liviano cada 10 s; el
     * diálogo nativo se abre acá porque el navegador no puede dar la ruta absoluta.
     */
    async commandsLoop() {
        // La primera vuelta sin esperar: los contadores del ícono aparecen apenas arranca.
        for (let first = true; ; first = false) {
            if (!first) await sleep(COMMANDS_EVERY_MS);
            if (this.blocked || this.picking) continue;

            let pick;
            let demo;
            let counts;
            let autostart;
            let sendLog;
            let alerts;
            let driveSync;
            let bridge;
            try {
                ({ data: { pick_folder: pick, demo, counts, autostart, send_log: sendLog, alerts, drive_sync: driveSync, bridge } } = await this.api.get('/commands'));
            } catch {
                continue; // Red caída: lo reintenta en el próximo sondeo.
            }
            await this.bridge.sync(bridge);
            // Carpetas → Drive: si cambió el conjunto en la web, se relee /config sin esperar los 5 min;
            // y «Sincronizar ahora» pedidos desde Mi perfil.
            if (driveSync) {
                if (driveSync.rev !== this.driveSyncRev) {
                    this.driveSyncRev = driveSync.rev;
                    this.etag = null;
                    await this.refreshConfig();
                    this.loadDriveSyncs(true);
                } else {
                    this.loadDriveSyncs();
                }
                for (const id of driveSync.scan ?? []) this.driveSync.requestScan(id);
            }
            // «Iniciar con la computadora» desde Mi perfil. El server lo repite hasta que el
            // header X-Agent-Autostart del próximo sondeo informa el estado pedido.
            if (typeof autostart === 'boolean') {
                try {
                    setAutostart(autostart, this.baseUrl);
                    log(autostart ? 'Autostart enabled from the web' : 'Autostart disabled from the web');
                } catch (err) {
                    warn(`Could not change autostart: ${err.message}`);
                }
            }
            if (counts && JSON.stringify(counts) !== JSON.stringify(this.counts)) {
                this.counts = counts;
                this.refreshTray();
            }
            // Avisos de escritorio (terminó/falló una impresión, con la foto de la cámara).
            if (Array.isArray(alerts) && alerts.length > 0) this.enqueueAlerts(alerts);
            // «Probar» desde Mi perfil: la ventanita con un escenario de prueba (no sube nada).
            if (demo && DEMO_ENABLED && !this.demoRunning) {
                this.demoRunning = true;
                runDemo(demo, {
                    inboxUrl: this.inboxUrl,
                    tray: { set: (status, icon) => this.setTrayStatus(status, icon), restore: () => this.refreshTray() },
                })
                    .catch((err) => warn(`Demo failed: ${err.message}`))
                    .finally(() => { this.demoRunning = false; });
            }
            // «Ver log» desde la web: se manda la cola del archivo de log de este equipo.
            if (sendLog) await this.sendLog(sendLog.tail_bytes);
            if (!pick) continue;

            this.picking = true;
            try {
                log('Folder picker requested from the web');
                const current = pick.current ? resolve(expandHome(pick.current)) : this.folder();
                let path = null;
                let error = null;
                try {
                    path = await pickFolder(current, { timeoutMs: (pick.timeout_seconds ?? 180) * 1000 });
                } catch (err) {
                    error = err.message;
                }
                await this.api.post('/folder', { path, error, purpose: pick.purpose ?? null });
                log(path ? `Folder picked: ${path}` : error ? `Folder picker failed: ${error}` : 'Folder picker cancelled');
                if (path) {
                    this.etag = null; // forzar relectura: cambió la carpeta del dispositivo
                    await this.refreshConfig();
                }
            } catch (err) {
                warn(`Folder picker failed: ${err.message}`);
            } finally {
                this.picking = false;
            }
        }
    }

    /**
     * Hay que cambiar de versión (wantsChange). Si es más nueva y no es obligatoria, pregunta
     * (diálogo nativo) y, si dicen que sí, se actualiza y se reinicia cuando no está subiendo
     * nada; «Más tarde» (o no contestar) vuelve a preguntar al día siguiente. Obligatoria
     * (`required`: por debajo de la mínima o versión retirada; o `mandatory` del server: revertir
     * o versión marcada obligatoria) cambia sin preguntar, apenas no esté subiendo nada. Sin
     * auto-actualización (instalado desde el repo) sólo avisa.
     * No se awaitea: el diálogo puede quedar abierto minutos y el agente sigue trabajando.
     */
    async maybeUpdate(required, { force = false } = {}) {
        const latest = this.update?.version;
        if (!wantsChange(this.update) || this.updating) return;

        if (!canSelfUpdate()) {
            this.notifyManualUpdate(latest);
            return;
        }
        const mandatory = required || this.update.mandatory === true;
        if (isSnoozed(latest, { onlyFailed: mandatory }) && !force) return;
        // Se pregunta con el agente quieto: subiendo, la ventanita está mostrando el progreso.
        if (!mandatory && (this.busy || this.queue.length > 0 || this.picking)) return;

        this.updating = true;
        try {
            if (mandatory) {
                log(`Mandatory change ${VERSION} → ${latest} (${this.update.reason ?? 'required'})`);
            } else {
                const yes = await askToUpdate({
                    headline: `Hay una versión nueva (${latest})`,
                    message: '¿La instalo ahora? Tarda menos de un minuto.',
                });
                if (!yes) {
                    snooze(latest, 24 * HOUR_MS);
                    log(`Update to ${latest} postponed`);
                    return;
                }
            }

            await this.applyUpdate(latest);
        } finally {
            this.updating = false;
        }
    }

    /** Baja, verifica e instala `latest` y reinicia (espera a que no se esté subiendo nada). */
    async applyUpdate(latest) {
        const verb = changeVerb(latest);
        try {
            while (this.busy || this.queue.length > 0 || this.picking) await sleep(2000);

            log(`Updating to ${latest}`);
            this.setTrayStatus(`${verb} la ${latest}…`, 'busy');
            showProgress({ title: `${verb} ${latest}…`, text: 'Bajando la versión nueva', pct: null }, { force: true });
            const started = Date.now();
            let lastTrayPct = -1;
            await installUpdate(this.update, {
                onProgress: (received, total) => {
                    if (!total) {
                        showProgress({ title: `${verb} ${latest}…`, text: `Bajando · ${formatMb(received)}`, pct: null });
                        return;
                    }
                    const pct = Math.min(100, (received / total) * 100);
                    showProgress({
                        title: `${verb} ${latest} - ${Math.floor(pct)}%`,
                        text: `${formatMb(received)} de ${formatMb(total)}${remaining(started, received, total)}`,
                        pct,
                    });
                    // El menú del ícono se rearma entero: alcanza con cada 10 %.
                    if (Math.floor(pct / 10) !== lastTrayPct) {
                        lastTrayPct = Math.floor(pct / 10);
                        this.setTrayStatus(`${verb} la ${latest} - ${Math.floor(pct)}%`, 'busy');
                    }
                },
                onVerify: () => showProgress({ title: `${verb} ${latest}…`, text: 'Verificando la descarga', pct: null }, { force: true }),
            });
            showProgress({ title: `${verb} ${latest}…`, text: 'Reiniciando', pct: null }, { force: true });
            markPending(VERSION, latest);
            await this.restartAfterUpdate(latest);
        } catch (err) {
            warn(`Update to ${latest} failed: ${err.message}`);
            notify(`No se pudo actualizar a la ${latest}`, `${err.message}. Vuelvo a intentar en una hora.`, 'error');
            snooze(latest, HOUR_MS, 'failed');
            this.refreshTray();
        }
    }

    /**
     * Arranca el ejecutable nuevo. Instalado como servicio: macOS lo relanza solo al salir
     * (KeepAlive de launchd); en Windows se vuelve a lanzar el .vbs de la carpeta Inicio. El
     * agente nuevo avisa al arrancar (reportPendingUpdate). Corriendo a mano, hay que reiniciarlo.
     */
    async restartAfterUpdate(latest) {
        // runningUnderLaunchd: con el inicio automático apagado desde Mi perfil no hay plist,
        // pero el servicio sigue cargado hasta cerrar sesión y KeepAlive lo relanza igual.
        const service = process.platform === 'win32' || isInstalledMac() || runningUnderLaunchd() || isInstalledLinux() || runningUnderSystemd();
        if (!service) {
            log(`Actualizado a ${latest}: reiniciá \`${COMMAND} run\` para usarla.`);
            notify(`Se bajó la ${latest}`, 'Reiniciá el agente para usarla.');
            return;
        }

        await this.watcher?.close();
            this.bridge.stop('el agente se detiene');
            await this.driveSync.stopAll();
        if (process.platform === 'win32' && !restartWindows()) {
            log(`Actualizado a ${latest}: reiniciá \`${COMMAND} run\` para usarla.`);
            notify(`Se bajó la ${latest}`, 'Reiniciá el agente para usarla.');
            await this.startWatcher();
            return;
        }

        log('Restarting into the new version');
        stopTray();
        process.exit(0);
    }

    /** Sin auto-actualización: avisa una vez por versión con el comando para actualizar. */
    notifyManualUpdate(latest) {
        if (this.updateNotified === latest) return;
        this.updateNotified = latest;
        const command = process.platform === 'win32' ? this.updateCommands?.windows : process.platform === 'linux' ? this.updateCommands?.linux : this.updateCommands?.mac;
        warn(`New version available: ${VERSION} → ${latest}${command ? ` (update with: ${command})` : ''}`);
        if (this.config?.notify_desktop ?? true) {
            notify(`Hay una versión nueva (${latest})`, 'Actualizalo desde Mi perfil → Prisma Agent.');
        }
    }

    /** @param {string} message  aviso para el usuario (español) · @param {string} logText  para el log (inglés) */
    block(reason, message, logText) {
        if (this.blocked !== reason || !this.authNotified) {
            warn(logText);
            // Sin sesión, el aviso trae el botón para iniciarla (la pregunta sale igual con los avisos apagados).
            const action = reason === 'auth' ? { label: 'Iniciar sesión', run: () => this.loginFromTray() } : null;
            if (action || (this.config?.notify_desktop ?? true)) notify(APP_TITLE, message, 'error', action);
            this.authNotified = true;
        }
        this.blocked = reason;
        if (reason === 'auth') this.me = null;
        this.refreshTray();
    }

    /** Usuario y dispositivo de esta sesión, para el menú del ícono. */
    async loadMe() {
        try {
            const { data } = await this.api.get('/me');
            this.me = data;
            this.refreshTray();
        } catch {
            // Sin /me el menú no muestra la cuenta; se reintenta con el próximo cambio de config.
        }
    }

    // --- Ícono en la barra de menú / bandeja ---------------------------------------------

    /** Estado completo del ícono (lo que lee el auxiliar): tooltip, ícono, número y menú. */
    trayState() {
        return {
            status: this.trayStatus,
            icon: this.trayIcon,
            badge: this.blocked === 'auth' ? 0 : this.counts?.notifications ?? 0,
            default: this.blocked === 'auth' ? 'login' : 'open_inbox',
            menu: this.trayMenu(),
        };
    }

    /**
     * El menú, por bloques: quién y en qué estado (y «Actualizar» si hay versión nueva) ·
     * Prisma (Por importar, notificaciones, últimos subidos) · esta computadora (subir,
     * carpeta, pausar) · Ajustes (lo de soporte, en un submenú) y Salir.
     */
    trayMenu() {
        const user = this.me?.user;
        const device = this.me?.device?.name;
        const header = [
            { label: user?.name ?? new URL(this.baseUrl).host, disabled: true, bold: true },
            { label: device && !this.blocked ? `${this.trayStatus} · ${device}` : this.trayStatus, disabled: true },
        ];
        const latest = this.update?.version;
        const hasUpdate = wantsChange(this.update);
        const updateLabel = `${compareVersions(VERSION, latest ?? VERSION) > 0 ? 'Volver a' : 'Actualizar a'} v${latest}`;
        const settings = {
            label: 'Ajustes',
            icon: 'settings',
            children: [
                ...(this.blocked === 'auth' ? [] : [{ id: 'settings', label: 'Configuraciónes', icon: 'settings' }]),
                hasUpdate
                    ? { id: 'update', label: updateLabel, icon: 'update', disabled: this.updating }
                    : { id: 'check_updates', label: this.checkingUpdates ? 'Buscando actualizaciones…' : 'Comprobar actualizaciones', icon: 'check', disabled: this.checkingUpdates },
                { id: 'open_log', label: 'Ver logs', icon: 'log' },
                SEP,
                ...(user ? [{ label: user.email, disabled: true }] : []),
                { label: `${APP_TITLE} ${VERSION}`, disabled: true },
            ],
        };
        const footer = [SEP, settings, { id: 'quit', label: 'Salir', icon: 'quit' }];

        // Sin sesión, lo único que sirve es iniciarla.
        if (this.blocked === 'auth') {
            return [...header, SEP, { id: 'login', label: this.loggingIn ? 'Iniciando sesión…' : 'Iniciar sesión', icon: 'login', disabled: this.loggingIn }, ...footer];
        }

        const pending = this.counts?.inbox_pending;
        const unread = this.counts?.notifications ?? 0;
        const recent = this.recent.length > 0
            ? this.recent.map((r, i) => ({ id: r.url ? `recent:${i}` : undefined, label: `${r.name} — ${RECENT_LABELS[r.status] ?? r.status}`, disabled: !r.url }))
            : [{ label: 'Todavía no se subió nada desde acá', disabled: true }];

        return [
            ...header,
            // La actualización, arriba y a la vista sólo cuando hay una.
            ...(hasUpdate ? [{ id: 'update', label: updateLabel, icon: 'update', disabled: this.updating }] : []),
            SEP,
            // Pausa global: frena la importación de modelos y la sincronización con Drive.
            { id: 'toggle_pause', label: this.paused ? 'Reanudar todo' : 'Pausar todo', icon: this.paused ? 'resume' : 'pause' },
            { id: 'open_notifications', label: `Notificaciones${unread ? ` (${unread})` : ''}`, icon: 'notifications' },
            SEP,
            // Importación de modelos: lo que sube el agente a «Por importar» desde el slicer.
            {
                label: `Importación de modelos${pending ? ` (${pending})` : ''}`,
                icon: 'inbox',
                children: [
                    { id: 'open_inbox', label: `Ver en Prisma 3D${pending ? ` (${pending})` : ''}`, icon: 'inbox' },
                    { id: 'slicer_config', label: 'Configurar carpeta…', icon: 'settings' },
                    { label: 'Últimos subidos', icon: 'recent', children: recent },
                    SEP,
                    { id: 'upload_file', label: 'Subir un archivo…', icon: 'upload', disabled: !this.config },
                    { id: 'open_folder', label: 'Abrir carpeta', icon: 'folder', disabled: !this.config },
                ],
            },
            ...this.driveSyncMenu(),
            ...footer,
        ];
    }

    /** Estado del ícono mientras pasa algo (subida, actualización); el menú lo repite arriba. */
    setTrayStatus(status, icon) {
        this.trayStatus = status;
        this.trayIcon = icon;
        updateTray(this.trayState());
    }

    /**
     * Estado «en reposo» (sin sesión, versión vieja, pausado o al día) y el resto del menú. Si
     * está subiendo, el estado lo maneja el progreso y acá sólo se refresca lo demás.
     */
    refreshTray() {
        if (!this.uploadingName) {
            if (this.blocked === 'auth') {
                this.trayStatus = this.loggingIn ? 'Esperando la autorización en el navegador…' : 'Sin sesión';
                this.trayIcon = 'error';
            } else if (this.blocked === 'version') {
                this.trayStatus = 'Hay que actualizar para seguir subiendo';
                this.trayIcon = 'error';
            } else if (this.paused) {
                this.trayStatus = `⏸ Pausado${this.queue.length ? ` · ${this.queue.length} en espera` : ''}`;
                this.trayIcon = 'paused';
            } else if (this.config) {
                this.trayStatus = this.driveSyncText ?? '✅ Sincronizado';
                this.trayIcon = this.driveSyncText ? 'busy' : 'idle';
            } else {
                this.trayStatus = 'Conectando…';
                this.trayIcon = 'idle';
            }
        }
        updateTray(this.trayState());
    }

    /** «Sincronización Drive»: una entrada por sincronización de esta computadora, con sus ajustes rápidos. */
    driveSyncMenu() {
        const mine = this.driveSyncList.filter((s) => s.this_device);
        if (this.driveSyncDenied) return [];

        const entries = mine.map((s) => {
            const running = this.driveSyncText?.startsWith(`Drive · ${s.name}:`);
            const state = this.paused || !s.enabled ? 'en pausa' : running ? this.driveSyncText.slice(`Drive · ${s.name}: `.length) : s.status_label.toLowerCase();
            const id = (a) => `dsync:${s.id}:${a}`;

            return {
                label: `${s.name} — ${state}`,
                children: [
                    { label: `${s.files_count} archivos · ${s.local_path}`, disabled: true },
                    ...(s.last_error ? [{ label: `⚠ ${s.last_error.slice(0, 80)}`, disabled: true }] : []),
                    SEP,
                    ...(s.blocked_deletions > 0
                        ? [
                              { id: id('confirm'), label: `Confirmar ${s.blocked_deletions} borrados en Drive`, icon: 'check' },
                              { id: id('keep'), label: 'Mantenerlos en Drive' },
                              SEP,
                          ]
                        : []),
                    { id: id('scan'), label: 'Sincronizar ahora', icon: 'resume', disabled: !s.enabled },
                    { id: id('path'), label: 'Cambiar carpeta local…', icon: 'folder' },
                    { id: id('mirror'), label: s.mirror_deletes ? 'Reflejar borrados: SÍ (desactivar)' : 'Reflejar borrados: no (activar)' },
                    { id: id('open'), label: 'Abrir carpeta' },
                ],
            };
        });

        return [{ label: 'Sincronización Drive', icon: 'cloud', children: [...(entries.length > 0 ? entries : [{ label: 'Ninguna en esta computadora', disabled: true }]), SEP, { id: 'dsync:config', label: 'Configurar', icon: 'settings' }, { id: 'dsync:web', label: 'Ver todas en la web…' }] }];
    }

    /** Relee las sincronizaciones del server para el submenú (como mucho cada 20 s, salvo `force`). */
    async loadDriveSyncs(force = false) {
        if (!this.api || this.blocked) return;
        if (!force && Date.now() - this.driveSyncListAt < 20_000) return;
        this.driveSyncListAt = Date.now();
        try {
            const { data } = await this.api.get('/drive-syncs');
            const next = data.data ?? [];
            if (JSON.stringify(next) !== JSON.stringify(this.driveSyncList)) {
                this.driveSyncList = next;
                this.refreshTray();
            }
            if (this.driveSyncDenied) {
                this.driveSyncDenied = false;
                this.refreshTray();
            }
        } catch (err) {
            // Sin permiso de Drive el submenú no aparece; sin red queda como estaba.
            if (err?.status === 403 && !this.driveSyncDenied) {
                this.driveSyncDenied = true;
                this.refreshTray();
            }
        }
    }

    async driveSyncAction(id, action) {
        const sync = this.driveSyncList.find((s) => s.id === id);
        if (!sync) return;
        const base = `/drive-syncs/${id}`;
        try {
            switch (action) {
                case 'scan':
                    await this.api.post(`${base}/scan`, {});
                    this.driveSync.requestScan(id);
                    notify('Sincronización Drive', `${sync.name}: comprobando…`, 'info');
                    break;
                case 'mirror':
                    await this.api.request('PATCH', base, { json: { mirror_deletes: !sync.mirror_deletes } });
                    break;
                case 'confirm':
                    await this.api.post(`${base}/confirm-deletions`, {});
                    break;
                case 'keep':
                    await this.api.post(`${base}/keep-deleted`, {});
                    break;
                case 'open':
                    openUrl(expandHome(sync.local_path));
                    return;
                case 'path': {
                    const path = await pickFolder(expandHome(sync.local_path));
                    if (!path) return;
                    await this.api.request('PATCH', base, { json: { local_path: path } });
                    notify('Sincronización Drive', `«${sync.name}» ahora sincroniza ${path}`, 'success');
                    break;
                }
            }
        } catch (err) {
            warn(`Drive sync action ${action}: ${err.message}`);
            notify('Sincronización Drive', err.message, 'error');
        }
        this.etag = null;
        await this.refreshConfig();
        await this.loadDriveSyncs(true);
    }

    onTrayAction(action) {
        const base = this.baseUrl.replace(/\/+$/, '');
        const dsync = /^dsync:(\d+):([a-z]+)$/.exec(action);
        if (dsync) {
            this.driveSyncAction(Number(dsync[1]), dsync[2]);

            return;
        }
        if (action === 'dsync:config' || action === 'slicer_config') {
            this.configUi
                .ensure()
                .then((url) => openUrl(`${url}#${action === 'slicer_config' ? 'slicer' : 'drive'}`))
                .catch((err) => notify('Sincronización Drive', `No se pudo abrir la configuración: ${err.message}`, 'error'));

            return;
        }
        if (action === 'dsync:web') {
            openUrl(`${base}/profile?section=agente`);

            return;
        }
        switch (action) {
            case 'open_inbox':
                openUrl(this.inboxUrl ?? `${base}/models/inbox`);
                break;
            case 'open_notifications':
                openUrl(this.me?.notifications_url ?? `${base}/notifications`);
                break;
            case 'open_folder':
                if (!this.config) break;
                ensureDir(this.folder());
                openUrl(this.folder());
                break;
            case 'settings':
                openUrl(`${base}/profile?section=agente`);
                break;
            case 'update':
                this.updateFromTray();
                break;
            case 'login':
                this.loginFromTray();
                break;
            case 'quit':
                this.quit();
                break;
            case 'toggle_pause':
                this.paused = !this.paused;
                log(this.paused ? 'Sync paused' : 'Sync resumed');
                this.refreshTray();
                if (!this.paused) {
                    this.drain();
                    this.driveSync.requestScanAll(); // la pausa cortó las revisiones de Drive en curso
                }
                break;
            case 'upload_file':
                this.uploadFromTray();
                break;
            case 'check_updates':
                this.checkUpdatesNow();
                break;
            case 'open_log':
                this.openLog();
                break;
            default:
                if (action.startsWith('recent:')) {
                    const url = this.recent[Number(action.slice(7))]?.url;
                    if (url) openUrl(url);
                }
        }
    }

    /**
     * «Iniciar sesión…» del ícono (o del aviso de sesión vencida): el mismo login de
     * `prisma-agent login` (abre el navegador para autorizar) contra el Prisma de este agente.
     * Al volver, retoma sin reiniciar: relee la config y arranca a vigilar.
     */
    async loginFromTray() {
        if (this.loggingIn) return;
        this.loggingIn = true;
        this.refreshTray();
        try {
            await login({ url: this.baseUrl, quiet: true });
            this.etag = null;
            this.authNotified = false;
            if (await this.refreshConfig()) {
                await this.loadMe(); // el nombre para el saludo (refreshConfig lo pide sin esperar)
                const user = this.me?.user?.name;
                notify(user ? `Bienvenido ${user}` : 'Bienvenido', 'Ya podes utilizar Prisma Sync', 'success');
            }
            this.wake?.();
        } catch (err) {
            warn(`Login failed: ${err.message}`);
            notify('No se pudo iniciar sesión', err.message, 'error');
        } finally {
            this.loggingIn = false;
            this.refreshTray();
        }
    }

    /** «Subir un archivo…»: un 3MF de cualquier lado (no se mueve ni se borra después). */
    async uploadFromTray() {
        if (!this.config || this.blocked) return;
        let path;
        try {
            path = await pickFile(this.folder());
        } catch (err) {
            notify('No se pudo abrir el selector', err.message, 'error');
            return;
        }
        if (!path) return;
        if (!/\.3mf$/i.test(path)) {
            notify('Sólo archivos .3mf', basename(path), 'error');
            return;
        }
        this.manual.add(path);
        this.enqueue(path);
        if (this.paused) notify('Sincronización en pausa', `${basename(path)} se sube al reanudar.`);
    }

    /** «Buscar actualizaciones»: consulta ya (sin esperar los 5 min) y, si hay, pregunta. */
    async checkUpdatesNow() {
        if (this.checkingUpdates) return;
        this.checkingUpdates = true;
        this.refreshTray();
        try {
            this.etag = null;
            await this.refreshConfig();
            const latest = this.update?.version;
            if (!wantsChange(this.update)) {
                notify('Estás al día', `Tenés la última versión v${VERSION}.`, 'success');
            } else if (this.busy || this.queue.length > 0) {
                notify(`Hay una versión nueva (${latest})`, 'Cuando termine de subir, usá «Actualización disponible» en el menú.');
            } else {
                await this.maybeUpdate(false, { force: true });
            }
        } finally {
            this.checkingUpdates = false;
            this.refreshTray();
        }
    }

    /**
     * «Ver log» desde Mi perfil o Administración: sube la cola del log del servicio. Corriendo
     * en una terminal no hay archivo (el log es la salida de la terminal) y se avisa.
     */
    async sendLog(tailBytes) {
        const path = ownLogFile() ?? (runningUnderLaunchd() ? MAC_LOG : null);
        let payload;
        try {
            if (!path) throw new Error('El agente corre en una terminal: no hay archivo de log, la salida está en esa terminal.');
            const { text, truncated } = readLogTail(path, Math.min(Number(tailBytes) || 150_000, 250_000));
            payload = { text: text || '(el log está vacío)', path, truncated };
        } catch (err) {
            payload = { error: err.message };
        }

        try {
            await this.api.post('/log', payload);
            log(payload.error ? `Log requested from the web, not sent: ${payload.error}` : 'Log sent to the web');
        } catch (err) {
            warn(`Could not send the log: ${err.message}`);
        }
    }

    /**
     * Avisos de escritorio del server (hoy: terminó, falló o se canceló una impresión, con la
     * foto de la cámara). Se muestran de a uno, cada uno su tiempo, sin frenar el sondeo.
     */
    enqueueAlerts(alerts) {
        this.alertQueue.push(...alerts);
        if (this.showingAlerts) return;
        this.showingAlerts = true;
        (async () => {
            while (this.alertQueue.length > 0) {
                const alert = this.alertQueue.shift();
                const image = alert.image ? await this.downloadAlertImage(alert) : null;
                log(`Desktop alert #${alert.id}${image ? ' (with photo)' : ''}`);
                const action = alert.url ? { label: 'Ver impresión', run: () => openUrl(alert.url) } : null;
                const ms = notify(alert.title, alert.text ?? '', alert.tone ?? 'info', action, { image });
                if (this.alertQueue.length > 0) await sleep(ms);
            }
        })()
            .catch((err) => warn(`Desktop alert failed: ${err.message}`))
            .finally(() => { this.showingAlerts = false; });
    }

    /** Baja la foto de un aviso a la carpeta de estado (quedan las últimas). null si no se pudo. */
    async downloadAlertImage(alert) {
        try {
            const res = await this.api.get(alert.image, { raw: true });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            ensureDir(ALERTS_DIR);
            const file = join(ALERTS_DIR, `${Number(alert.id)}.jpg`);
            writeFileSync(file, Buffer.from(await res.arrayBuffer()));
            this.pruneAlertImages();
            return file;
        } catch (err) {
            warn(`Could not download the alert photo: ${err.message}`);
            return null;
        }
    }

    pruneAlertImages() {
        try {
            readdirSync(ALERTS_DIR)
                .map((name) => ({ path: join(ALERTS_DIR, name), at: statSync(join(ALERTS_DIR, name)).mtimeMs }))
                .sort((a, b) => b.at - a.at)
                .slice(ALERT_IMAGES_KEEP)
                .forEach((f) => rmSync(f.path, { force: true }));
        } catch {
            // No pasa nada si quedan fotos de más.
        }
    }

    /** «Ver registro»: el log del servicio (instalado). Corriendo a mano, el log es la terminal. */
    openLog() {
        // La vista de logs de la pantalla local (con filtros); sin archivo avisa ahí mismo.
        this.configUi
            .ensure()
            .then((url) => openUrl(`${url}#logs`))
            .catch((err) => notify('Ver logs', `No se pudo abrir: ${err.message}`, 'error'));
    }

    /** Últimos subidos (para el menú): se guarda en la carpeta de estado, sobrevive reinicios. */
    trackRecent(name, patch) {
        let entry = this.recent.find((r) => r.name === name);
        if (!entry) {
            entry = { name };
            this.recent.unshift(entry);
            this.recent.splice(RECENT_MAX);
        }
        Object.assign(entry, patch, { at: Date.now() });
        try {
            ensureDir(STATE_DIR);
            writeFileSync(RECENT_FILE, JSON.stringify(this.recent));
        } catch {
            // Sin archivo, el menú igual los muestra hasta que se reinicie.
        }
        updateTray(this.trayState());
    }

    /**
     * «Cerrar» del ícono: deja de vigilar y se va el ícono. Lo que quede en la carpeta se sube
     * la próxima vez que arranque (al iniciar sesión en la computadora, o con `run`/`install`).
     */
    async quit() {
        log('Quit from the tray icon');
        stopTray();
        hideProgress();
        await this.watcher?.close();
            this.bridge.stop('el agente se detiene');
            await this.driveSync.stopAll();
        clearPid();
        if (runningUnderLaunchd()) stopServiceUntilLogin(); // si no, KeepAlive lo relanza
        process.exit(0);
    }

    /** «Actualizar a X» del menú: ya lo eligieron, no se pregunta. */
    async updateFromTray() {
        const latest = this.update?.version;
        if (!wantsChange(this.update) || this.updating) return;
        if (!canSelfUpdate()) {
            this.onTrayAction('settings'); // instalado desde el repo: el comando está en Mi perfil
            return;
        }
        this.updating = true;
        try {
            await this.applyUpdate(latest);
        } finally {
            this.updating = false;
        }
    }

    folder() {
        return resolve(expandHome(this.config.watch_folder));
    }

    async startWatcher() {
        await this.watcher?.close();
        // El watcher nuevo vuelve a emitir todo lo que hay en la carpeta: la cola arranca de cero.
        this.queue = [];
        this.queued.clear();

        const folder = this.folder();
        for (const dir of [folder, join(folder, UPLOADED_DIR), join(folder, ERROR_DIR)]) {
            ensureDir(dir);
        }

        const extensions = (this.config.extensions ?? ['3mf']).map((e) => `.${String(e).toLowerCase()}`);
        const skipDirs = [join(folder, UPLOADED_DIR), join(folder, ERROR_DIR)];

        const ignored = (path, stats) => {
            const name = basename(path);
            if (path === folder) return false;
            // Ocultos y temporales: Bambu Studio escribe `x.gcode.3mf.tmp` y lo renombra (spike F0).
            if (name.startsWith('.') || /\.(tmp|part|crdownload|download)$/i.test(name)) return true;
            if (skipDirs.some((d) => path === d || path.startsWith(d + sep))) return true;
            if (stats?.isFile()) return !extensions.includes(extname(name).toLowerCase());
            return false;
        };

        log(`Watching ${folder}${this.config.recursive ? ' (recursive)' : ''}`);

        this.watcher = watch(folder, {
            ignored,
            depth: this.config.recursive ? 20 : 0,
            ignoreInitial: false,
            awaitWriteFinish: { stabilityThreshold: Math.max(200, this.config.stable_ms ?? 1000), pollInterval: 200 },
        });

        this.watcher.on('add', (path) => this.enqueue(path));
        this.watcher.on('change', (path) => this.enqueue(path));
        this.watcher.on('error', (err) => warn(`Watcher error: ${err.message}`));
    }

    enqueue(path) {
        if (this.queued.has(path)) return;
        this.queued.add(path);
        this.queue.push(path);
        this.drain();
    }

    async drain() {
        if (this.busy) return;
        this.busy = true;
        try {
            while (this.queue.length > 0) {
                if (this.blocked || this.paused) {
                    this.refreshTray(); // «Pausado · N en espera»
                    return;
                }
                const path = this.queue.shift();
                try {
                    await this.process(path);
                } finally {
                    this.queued.delete(path);
                }
            }
        } finally {
            this.busy = false;
        }
    }

    async process(path) {
        if (!existsSync(path)) return;

        const name = basename(path);
        const cfg = this.config;
        log(`Uploading ${name}`);
        this.uploadingName = name;
        try {
            await this.upload(path, name, cfg);
        } finally {
            this.uploadingName = null;
            this.manual.delete(path);
            if (this.queue.length === 0) this.refreshTray();
        }
    }

    async upload(path, name, cfg) {
        // Ventanita de progreso (con los avisos activados en Mi perfil).
        const queued = () => (this.queue.length > 0 ? ` · ${this.queue.length} más en cola` : '');
        let shown = 0; // un reintento vuelve a mandar la parte: la barra no retrocede
        const onProgress = cfg.notify_desktop
            ? ({ phase, sent, total }) => {
                if (phase === 'hash') {
                    showProgress({ title: `Preparando…${queued()}`, text: name, pct: null });
                    this.setTrayStatus(`Preparando ${name}`, 'busy');
                    return;
                }
                const pct = Math.max(shown, total > 0 ? (sent * 100) / total : 100);
                // El ícono, de a 10 % (cada cambio reescribe su menú).
                if (Math.floor(pct / 10) !== Math.floor(shown / 10) || shown === 0) {
                    this.setTrayStatus(`Subiendo ${name} - ${Math.floor(pct / 10) * 10}%`, 'busy');
                }
                shown = pct;
                showProgress({ title: `Subiendo ${Math.floor(pct)}%${queued()}`, text: name, pct });
            }
            : undefined;

        // Subido con «Subir un archivo…»: no está en la carpeta, así que no se mueve ni se borra.
        const manual = this.manual.has(path);
        this.trackRecent(name, { status: 'uploading', url: null });

        let result;
        try {
            result = await uploadFile(this.api, path, { onProgress });
        } catch (err) {
            this.trackRecent(name, { status: 'error', url: null });
            if (err instanceof ApiError && err.status === 401) {
                // El archivo queda en la carpeta: se reprocesa al volver a iniciar sesión.
                this.block('auth', 'Debe iniciar sesión para continuar', `${name}: upload rejected (401); paused until login`);
                return;
            }
            if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
                if (!manual) this.moveToError(path, err.message);
                this.announce('No se pudo subir', `${name}: ${err.message}`, 'error');
                return;
            }
            // Red / servidor: queda en la carpeta y se reintenta en el próximo arranque del watcher.
            warn(`${name}: upload failed, will retry: ${err.message}`);
            this.announce('No se pudo subir', `${name}: ${err.message}`, 'error');
            return;
        }

        if (!manual) this.afterUpload(path);

        if (result.duplicate) {
            this.trackRecent(name, { status: 'duplicate', url: result.url ?? null });
            log(`${name}: already uploaded${result.uploaded_by ? ` by ${result.uploaded_by}` : ''}${result.item_id ? ` (#${result.item_id})` : ''}`);
            // Con `keep` el archivo sigue en la carpeta: avisar en cada arranque sería ruido.
            if (cfg.after_upload !== 'keep') {
                this.announce('Ya existen Prisma Sync', `${name}${result.uploaded_by ? ` (subido por ${result.uploaded_by})` : ''}`);
            } else if (!this.busyWithOthers(name)) {
                hideProgress();
            }
            return;
        }

        log(`${name}: uploaded (#${result.item_id})`);
        this.trackRecent(name, { status: 'verifying', url: result.url ?? null });
        // «Subido» + análisis en la ventanita; el aviso llega cuando queda listo para revisar.
        if (cfg.notify_desktop) showProgress({ title: 'Subido, verificando...', text: name, pct: null }, { force: true });

        // Esperar el análisis sin frenar la cola.
        waitForAnalysis(this.api, result.item_id)
            .then((item) => {
                if (!item) {
                    if (!this.busyWithOthers(name)) hideProgress();
                    return;
                }
                if (item.status === 'failed') {
                    this.trackRecent(name, { status: 'failed', url: item.url ?? result.url ?? null });
                    warn(`${name}: analysis failed: ${item.error ?? 'unknown error'}`);
                    this.announce('No se pudo analizar', `${name}: ${item.error ?? 'error'}`, 'error');
                    return;
                }
                log(`${name}: ready for review (#${result.item_id})`);
                const url = item.url ?? this.inboxUrl;
                this.trackRecent(name, { status: 'ready', url });
                // Con «abrir solo» activado ya se abre: el botón sería redundante.
                this.announce('Importado correctamente', name, 'success', cfg.open_inbox_on_ready || !url ? null : { label: 'Abrir', run: () => openUrl(url) });
                if (cfg.open_inbox_on_ready) openUrl(url);
            })
            .catch((err) => {
                warn(`${name}: ${err.message}`);
                if (!this.busyWithOthers(name)) hideProgress();
            });
    }

    /** ¿Se está subiendo (o espera en cola) otro archivo que no es `name`? */
    busyWithOthers(name) {
        return this.queue.length > 0 || (this.uploadingName !== null && this.uploadingName !== name);
    }

    /**
     * Aviso de un archivo en la ventanita (con los avisos activados). Se queda unos segundos
     * aunque haya otra subida; después la ventanita vuelve a su progreso.
     */
    announce(title, text, tone = 'info', action = null) {
        if (!(this.config?.notify_desktop ?? true)) return;
        notify(title, text, tone, action);
    }

    afterUpload(path) {
        const mode = this.config.after_upload;
        try {
            if (mode === 'delete') {
                rmSync(path, { force: true });
            } else if (mode === 'move') {
                renameSync(path, this.uniqueTarget(join(this.folder(), UPLOADED_DIR), basename(path)));
            }
        } catch (err) {
            warn(`Could not ${mode === 'delete' ? 'delete' : 'move'} ${basename(path)}: ${err.message}`);
        }
    }

    moveToError(path, reason) {
        try {
            const target = this.uniqueTarget(join(this.folder(), ERROR_DIR), basename(path));
            renameSync(path, target);
            writeFileSync(`${target}.txt`, `${new Date().toISOString()}\n${reason}\n`);
            warn(`${basename(path)}: rejected, moved to ${relative(this.folder(), target)}: ${reason}`);
        } catch (err) {
            warn(`Could not move ${basename(path)} to ${ERROR_DIR}: ${err.message}`);
        }
    }

    /** `x.gcode.3mf` → `x (2).gcode.3mf` si ya existe en el destino. */
    uniqueTarget(dir, name) {
        let target = join(dir, name);
        const match = name.match(/^(.*?)((?:\.gcode)?\.3mf)$/i) ?? [null, name, ''];
        for (let n = 2; existsSync(target); n++) {
            target = join(dir, `${match[1]} (${n})${match[2]}`);
        }
        return target;
    }
}
