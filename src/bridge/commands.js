import { ApiError } from '../api.js';
import { httpRequest } from './plugs.js';
import { log, warn } from '../log.js';

/**
 * Comandos del server a las impresoras del puente (docs/PLAN-AGENT-BRIDGE.md §5, fases 2-5: MQTT, cámara, archivos por FTPS y enchufes). Los retira de
 * `GET /bridge/commands` y los ejecuta contra la conexión MQTT que el puente ya tiene abierta; devuelve el
 * resultado por `POST /bridge/commands/{id}/result`.
 *
 * Quién avisa: el timbre (`Realtime`) llama a `poke()` y se consulta al instante. Con el timbre conectado
 * igual se sondea cada 15 s (red de seguridad); sin él, cada 2 s.
 *
 * Qué NO hace: no decide nada ni arma tópicos. Una lista cerrada de tipos, sólo contra impresoras de su
 * config, sólo en `device/{serial}/request` (lo fija `MqttLink`). El vencimiento lo hace el server: un comando
 * vencido nunca se entrega, así que no depende del reloj de esta máquina.
 */
const POLL_WITH_BELL_MS = 15_000;
const POLL_WITHOUT_BELL_MS = 2_000;
const MAX_IN_FLIGHT = 8;
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Raíces del JSON que la impresora entiende; cualquier otra cosa se rechaza. */
const ALLOWED_ROOTS = new Set(['print', 'pushing', 'system', 'info', 'camera', 'xcam']);

/** @param {unknown} payload */
export function validatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'El comando no es un objeto';
    const keys = Object.keys(payload);
    if (keys.length === 0 || keys.some((k) => !ALLOWED_ROOTS.has(k))) return 'El comando tiene una sección que el puente no acepta';
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) return 'El comando es demasiado grande';

    return null;
}

export class CommandRunner {
    /**
     * @param {{ getApi: () => import('../api.js').Api | null, getLink: (printerId: number) => import('./mqtt-link.js').MqttLink | undefined, camera: import('./camera.js').CameraService, ftp: import('./ftps.js').FtpService, bellUp: () => boolean, onForbidden: () => void }} hooks
     */
    constructor({ getApi, getLink, camera, ftp, bellUp, onForbidden }) {
        this.getApi = getApi;
        this.getLink = getLink;
        this.camera = camera;
        this.ftp = ftp;
        this.bellUp = bellUp;
        this.onForbidden = onForbidden;
        this.running = false;
        this.timer = null;
        this.polling = false;
        this.again = false;
        this.inFlight = 0;
        this.seen = new Set(); // ids ya ejecutados (defensa contra una entrega repetida)
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.schedule(0);
    }

    stop() {
        this.running = false;
        clearTimeout(this.timer);
        this.timer = null;
    }

    /** Sonó el timbre (o se reconectó): consultar ya. */
    poke() {
        if (!this.running) return;
        if (this.polling) {
            this.again = true;

            return;
        }
        clearTimeout(this.timer);
        this.schedule(0);
    }

    schedule(ms) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.poll(), ms);
        this.timer.unref?.();
    }

    async poll() {
        if (!this.running || this.polling) return;
        this.polling = true;
        try {
            const api = this.getApi();
            if (api && this.inFlight < MAX_IN_FLIGHT) {
                const { data } = await api.get('/bridge/commands');
                for (const cmd of data?.commands ?? []) this.run(cmd);
            }
        } catch (err) {
            if (err instanceof ApiError && err.status === 403) this.onForbidden();
            else if (!(err instanceof ApiError && err.retryable)) warn(`Puente: no se pudo leer la cola de comandos: ${err.message}`);
        } finally {
            this.polling = false;
            if (this.running) {
                const again = this.again;
                this.again = false;
                this.schedule(again ? 0 : this.bellUp() ? POLL_WITH_BELL_MS : POLL_WITHOUT_BELL_MS);
            }
        }
    }

    /** Ejecuta sin esperar (puede tardar hasta el timeout del ack) y siempre informa el resultado. */
    run(cmd) {
        if (this.seen.has(cmd.id)) return;
        // Vencimiento relativo al momento en que llegó (no depende del reloj de esta computadora).
        cmd.deadline = Date.now() + (Number(cmd.ttl) || 30) * 1000;
        this.seen.add(cmd.id);
        if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);

        this.inFlight++;
        this.execute(cmd)
            .then((result) => this.report(cmd, { ok: true, result }))
            .catch((err) => {
                warn(`Puente: el comando ${cmd.type} (#${cmd.id}) falló: ${err.message}`);

                return this.report(cmd, { ok: false, error: String(err.message ?? err).slice(0, 500) });
            })
            .finally(() => {
                this.inFlight--;
                // Liberó un lugar: si había cola, seguir sin esperar al próximo sondeo.
                if (this.running) this.poke();
            });
    }

    /** @returns {Promise<object>} lo que va en `result` */
    async execute(cmd) {
        // Enchufes: no son de una impresora; los guarda la restricción a IPs privadas (plugs.js).
        if (cmd.type === 'http.request' || cmd.type === 'http.poll') return httpRequest(cmd.payload ?? {});

        const link = this.getLink(cmd.printer_id);
        if (!link) throw new Error('Esa impresora no es de este puente');

        switch (cmd.type) {
            case 'camera.watch':
                if (!link.printer.camera) throw new Error('Esa impresora no tiene cámara soportada');
                this.camera.watch(link.printer, Number(cmd.payload?.seconds) || 60);

                return {};
            case 'camera.snapshot':
                if (!link.printer.camera) throw new Error('Esa impresora no tiene cámara soportada');

                return this.camera.snapshot(link.printer, cmd.id);
            case 'ftp.size':
            case 'ftp.list':
            case 'ftp.head':
            case 'ftp.delete':
            case 'ftp.put':
            case 'ftp.get':
                return this.ftp.run(link.printer, cmd);
            case 'mqtt.publish':
            case 'mqtt.request':
                return this.executeMqtt(cmd, link);
            default:
                throw new Error(`El puente no conoce el comando «${cmd.type}»`);
        }
    }

    async executeMqtt(cmd, link) {
        const bad = validatePayload(cmd.payload?.payload);
        if (bad) throw new Error(bad);

        switch (cmd.type) {
            case 'mqtt.publish':
                await link.publish(cmd.payload.payload);

                return {};
            case 'mqtt.request': {
                const { ack_command: ack, sequence_id: seq } = cmd.payload;
                if (typeof ack !== 'string' || ack === '' || ack.length > 60) throw new Error('Falta el comando a esperar');
                const timeout = Math.min(30, Math.max(1, Number(cmd.payload.timeout) || 10));
                const print = await link.request(cmd.payload.payload, ack, String(seq ?? ''), timeout * 1000);

                return { print };
            }
            default:
                throw new Error(`El puente no conoce el comando «${cmd.type}»`);
        }
    }

    /** El resultado es idempotente en el server: reintentar es seguro. */
    async report(cmd, body) {
        for (let attempt = 1; attempt <= 4; attempt++) {
            const api = this.getApi();
            if (!api) return;
            try {
                await api.post(`/bridge/commands/${cmd.id}/result`, body);
                if (body.ok) log(`Puente: ${cmd.type} #${cmd.id} hecho`);

                return;
            } catch (err) {
                const retry = err instanceof ApiError && err.retryable;
                if (!retry || attempt === 4) return warn(`Puente: no se pudo informar el resultado de #${cmd.id}: ${err.message}`);
                await new Promise((r) => setTimeout(r, 1000 * attempt));
            }
        }
    }
}
