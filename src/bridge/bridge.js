import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, platform } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../api.js';
import { log, warn } from '../log.js';
import { STATE_DIR } from '../state.js';
import { VERSION } from '../version.js';
import { CameraService } from './camera.js';
import { CommandRunner } from './commands.js';
import { Discovery } from './discovery.js';
import { FtpService } from './ftps.js';
import { MqttLink } from './mqtt-link.js';
import { Realtime } from './realtime.js';

/**
 * Modo puente de Prisma Agent (docs/PLAN-AGENT-BRIDGE.md, fases 1-2). Con el puente prendido desde la
 * web, este agente se conecta por MQTT a las impresoras que el server le asignó, le manda su estado por
 * HTTPS saliente (`POST /bridge/reports`) y ejecuta los comandos que el server le pone en la cola
 * (`CommandRunner`; el `Realtime` es el timbre que avisa). No decide nada: el server sigue siendo la autoridad.
 *
 * Cadencia: 2 s por impresora mientras imprime, 10 s en reposo; y un latido cada 15 s aunque nada cambie,
 * para que el server sepa que el puente está vivo (`bridge:check` lo da por caído a los 3 minutos).
 */
/** Lo que lee `prisma-agent bridge status` desde otra terminal (sin credenciales). */
const STATUS_FILE = join(STATE_DIR, 'bridge-status.json');
const TICK_MS = 1_000;
const ACTIVE_EVERY_MS = 2_000;
const IDLE_EVERY_MS = 10_000;
const HEARTBEAT_MS = 15_000;

export class Bridge {
    /** @param {() => import('../api.js').Api | null} getApi */
    constructor(getApi) {
        this.getApi = getApi;
        this.links = new Map(); // printer id → MqttLink
        this.rev = null;
        this.timer = null;
        this.running = false;
        this.sending = false;
        this.lastSentAt = new Map(); // printer id → ms
        this.lastBeatAt = 0;
        this.lastError = null;
        this.statusAt = 0;
        this.discovery = new Discovery();
        this.discoveredAt = 0;
        this.camera = new CameraService({ getApi });
        this.runner = new CommandRunner({
            getApi,
            getLink: (id) => this.links.get(id),
            camera: this.camera,
            ftp: new FtpService({ getApi }),
            bellUp: () => this.realtime.connected,
            onForbidden: () => this.stop('el puente está apagado en el server'),
        });
        this.realtime = new Realtime({ getApi, onBell: () => this.runner.poke() });
    }

    /** Lo que dice `GET /commands` (`bridge: { enabled, rev }`): prende, apaga o relee la config. */
    async sync(cmd) {
        if (!cmd?.enabled) {
            if (this.running) this.stop('apagado desde la web');

            return;
        }
        if (!this.running) await this.start();
        if (this.running && cmd.rev !== this.rev) await this.loadConfig();
    }

    async start() {
        this.running = true;
        this.rev = null;
        log('Puente: prendido');
        this.timer = setInterval(() => this.tick().catch((err) => warn(`Puente: ${err.message}`)), TICK_MS);
        this.timer.unref?.();
        this.runner.start();
        this.discovery.start();
        await this.loadConfig();
    }

    stop(reason = 'detenido') {
        if (!this.running) return;
        this.running = false;
        clearInterval(this.timer);
        this.timer = null;
        this.runner.stop();
        this.realtime.stop();
        this.camera.stop();
        this.discovery.stop();
        for (const link of this.links.values()) link.stop();
        this.links.clear(); // las credenciales no quedan en memoria
        this.lastSentAt.clear();
        this.rev = null;
        rmSync(STATUS_FILE, { force: true });
        log(`Puente: ${reason}`);
    }

    async loadConfig() {
        const api = this.getApi();
        if (!api) return;
        try {
            const { data } = await api.get('/bridge/config');
            const wanted = new Map(data.printers.map((p) => [p.id, p]));

            for (const [id, link] of this.links) {
                const next = wanted.get(id);
                const p = link.printer;
                if (!next || next.lan_ip !== p.lan_ip || next.access_code !== p.access_code || next.serial !== p.serial) {
                    link.stop();
                    this.links.delete(id);
                    this.camera.sessions.get(id)?.ctl.abort(); // ya no es de este puente
                }
            }
            for (const [id, printer] of wanted) {
                if (this.links.has(id)) continue;
                const link = new MqttLink(printer);
                this.links.set(id, link);
                link.start();
            }
            this.rev = data.rev;
            this.realtime.configure(data.realtime ?? null);
            log(`Puente: ${this.links.size} impresora(s) asignada(s)`);
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) return this.stop('el puente está apagado en el server');
            warn(`Puente: no se pudo leer la configuración: ${err.message}`);
        }
    }

    info() {
        const ips = Object.values(networkInterfaces())
            .flat()
            .filter((n) => n && n.family === 'IPv4' && !n.internal)
            .map((n) => n.address);

        return { version: VERSION, platform: platform(), ips, printers: [...this.links.values()].map((l) => l.summary()) };
    }

    writeStatus(now) {
        if (now - this.statusAt < 3_000) return;
        this.statusAt = now;
        try {
            writeFileSync(STATUS_FILE, JSON.stringify({ at: now, pid: process.pid, last_report_to_server_at: this.lastBeatAt || null, last_error: this.lastError, bell: this.realtime.connected, in_flight: this.runner.inFlight, ...this.info(), names: Object.fromEntries([...this.links].map(([id, l]) => [id, l.printer.name])) }));
        } catch {
            // Sin carpeta de estado no hay estado que mostrar; no es motivo para cortar el puente.
        }
    }

    /** Impresoras vistas en la LAN (SSDP): lo nuevo enseguida y todo cada 10 minutos. No bloquea el tick. */
    reportDiscovered(api, now) {
        if (this.reportingDiscovered || now < (this.discoveredRetryAt ?? 0)) return;
        const refresh = now - this.discoveredAt > 10 * 60_000;
        const list = this.discovery.take(refresh);
        if (list.length === 0) return;
        if (refresh) this.discoveredAt = now;

        this.reportingDiscovered = true;
        api.post('/bridge/discovered', { printers: list })
            .catch((err) => {
                this.discovery.putBack(list); // se reintenta más tarde
                this.discoveredRetryAt = Date.now() + 30_000;
                if (!(err instanceof ApiError && err.retryable)) warn(`Puente: no se pudo informar lo detectado: ${err.message}`);
            })
            .finally(() => {
                this.reportingDiscovered = false;
            });
    }

    async tick() {
        if (!this.running || this.sending) return;
        const api = this.getApi();
        if (!api) return;

        const now = Date.now();
        this.writeStatus(now);
        const batch = [];
        const taken = [];
        for (const [id, link] of this.links) {
            if (!link.dirty) continue;
            if (now - (this.lastSentAt.get(id) ?? 0) < (link.active ? ACTIVE_EVERY_MS : IDLE_EVERY_MS)) continue;
            const print = link.takeIfDirty();
            if (print) {
                batch.push({ printer_id: id, print });
                taken.push(link);
            }
        }
        this.reportDiscovered(api, now);
        if (batch.length === 0 && now - this.lastBeatAt < HEARTBEAT_MS) return;

        this.sending = true;
        try {
            const { data } = await api.post('/bridge/reports', { reports: batch, info: this.info() });
            this.lastBeatAt = now;
            this.lastError = null;
            for (const r of batch) this.lastSentAt.set(r.printer_id, now);
            // Ya no son de este puente: se suelta cuando cambie la config.
            if (data?.unknown?.length) await this.loadConfig();
        } catch (err) {
            this.lastError = err.message;
            // Sin acumular: lo último de cada impresora se reintenta en el próximo tick.
            for (const link of taken) link.markDirty();
            if (err instanceof ApiError && err.status === 403) this.stop('el puente está apagado en el server');
            else if (!(err instanceof ApiError && err.retryable)) warn(`Puente: no se pudo mandar el estado: ${err.message}`);
        } finally {
            this.sending = false;
        }
    }
}

/** `prisma-agent bridge status`: lo que el agente en marcha informa del puente (lee el archivo de estado). */
export function bridgeStatusCommand() {
    let s;
    try {
        s = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    } catch {
        console.log('El puente no está activo en este agente (se prende en Administración → Prisma Agent → Puentes) o el agente no está corriendo.');
        return;
    }
    const ago = (ms) => (ms ? `hace ${Math.max(0, Math.round((Date.now() - ms) / 1000))} s` : 'nunca');
    if (Date.now() - s.at > 30_000) console.log('⚠ El estado es viejo: el agente no está corriendo.');
    console.log(`Puente de Prisma Agent ${s.version} (${s.platform}) · IPs: ${s.ips.join(', ') || '—'}`);
    console.log(`Último envío al server: ${ago(s.last_report_to_server_at)}${s.last_error ? ` · error: ${s.last_error}` : ''}`);
    console.log(`Comandos: timbre ${s.bell ? 'conectado (llegan al instante)' : 'desconectado (se sondea cada 2 s)'} · en curso: ${s.in_flight ?? 0}`);
    if (s.printers.length === 0) console.log('Sin impresoras asignadas.');
    for (const p of s.printers) {
        console.log(`  ${p.connected ? '●' : '○'} ${s.names[p.id] ?? `#${p.id}`}  ${p.connected ? 'conectada' : p.error ?? 'sin conexión'} · último reporte ${ago(p.last_report_at)}`);
    }
}
