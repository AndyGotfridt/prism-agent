import { log, warn } from '../log.js';

/**
 * El «timbre» del puente (docs/PLAN-AGENT-BRIDGE.md §3.2): un WebSocket a Reverb, que habla el protocolo de
 * Pusher, solo para enterarse al instante de que hay un comando esperando. No lleva datos: al sonar, el
 * agente consulta `GET /bridge/commands`. Son ~100 líneas a mano para no sumar `pusher-js` al binario.
 *
 * Si el WebSocket no anda (proxy, certificado, Reverb caído), el puente sigue funcionando: sondea cada 2 s.
 */
export class Realtime {
    /**
     * @param {{ getApi: () => import('../api.js').Api | null, onBell: () => void }} hooks
     */
    constructor({ getApi, onBell }) {
        this.getApi = getApi;
        this.onBell = onBell;
        this.cfg = null;
        this.ws = null;
        this.connected = false;
        this.stopped = true;
        this.attempt = 0;
        this.retryTimer = null;
        this.watchdog = null;
        this.lastSeen = 0;
    }

    /** `cfg` = `realtime` de `bridge/config`, o null para no usar WebSocket. Cambia sólo si cambió. */
    configure(cfg) {
        const same = JSON.stringify(cfg) === JSON.stringify(this.cfg) && !this.stopped;
        if (same) return;
        this.stop();
        this.cfg = cfg;
        if (!cfg?.host || !cfg?.key || !cfg?.channel) return;
        this.stopped = false;
        this.connect();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.retryTimer);
        clearInterval(this.watchdog);
        this.retryTimer = this.watchdog = null;
        this.connected = false;
        const ws = this.ws;
        this.ws = null;
        try {
            ws?.close();
        } catch {
            // ya estaba cerrado
        }
    }

    url() {
        const { scheme, host, port, key } = this.cfg;
        const tls = scheme === 'https' || scheme === 'wss';
        const defaultPort = tls ? 443 : 80;
        const hostPort = port && port !== defaultPort ? `${host}:${port}` : host;

        return `${tls ? 'wss' : 'ws'}://${hostPort}/app/${key}?protocol=7&client=prisma-agent&version=1&flash=false`;
    }

    connect() {
        if (this.stopped || typeof WebSocket === 'undefined') return;
        let ws;
        try {
            ws = new WebSocket(this.url());
        } catch (err) {
            return this.scheduleRetry(err.message);
        }
        this.ws = ws;
        this.lastSeen = Date.now();

        ws.onmessage = (ev) => {
            this.lastSeen = Date.now();
            this.handle(ws, String(ev.data)).catch((err) => warn(`Puente: timbre: ${err.message}`));
        };
        ws.onclose = () => {
            if (this.ws !== ws) return; // un socket viejo que ya reemplazamos
            const was = this.connected;
            this.connected = false;
            this.ws = null;
            clearInterval(this.watchdog);
            if (was) warn('Puente: se cortó el timbre (WebSocket); se sondea cada 2 s hasta que vuelva');
            this.scheduleRetry();
        };
        ws.onerror = () => {}; // el detalle llega en onclose
        clearInterval(this.watchdog);
        // Reverb manda un ping cada ~60 s; 150 s sin nada = conexión muerta (suspensión, NAT que se olvidó).
        this.watchdog = setInterval(() => {
            if (Date.now() - this.lastSeen > 150_000) {
                try {
                    ws.close();
                } catch {
                    // ya cerrado
                }
            }
        }, 30_000);
        this.watchdog.unref?.();
    }

    scheduleRetry() {
        if (this.stopped) return;
        this.attempt++;
        const wait = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempt, 6)) * (0.75 + Math.random() * 0.5);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), wait);
        this.retryTimer.unref?.();
    }

    async handle(ws, text) {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }
        switch (msg.event) {
            case 'pusher:connection_established': {
                const { socket_id: socketId } = JSON.parse(msg.data);
                const api = this.getApi();
                if (!api) return ws.close();
                const { data } = await api.post('/bridge/broadcasting/auth', { socket_id: socketId, channel_name: this.cfg.channel });
                if (this.ws !== ws) return;
                ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: this.cfg.channel, auth: data.auth } }));
                break;
            }
            case 'pusher_internal:subscription_succeeded':
                this.connected = true;
                this.attempt = 0;
                log('Puente: timbre conectado (los comandos llegan al instante)');
                this.onBell(); // por si sonó mientras estaba desconectado
                break;
            case 'pusher:ping':
                ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
                break;
            case 'pusher:error':
                warn(`Puente: el timbre respondió un error: ${typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)}`);
                break;
            case 'bridge.command':
                this.onBell();
                break;
            default:
        }
    }
}
