import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateIp } from './bridge/plugs.js';
import { warn } from './log.js';

/**
 * Balanza de la LAN para el navegador (docs/PLAN-SCALE-LOCAL.md). El peso en vivo y la tara no pueden dar la
 * vuelta por internet: la página (https) llama a este server en 127.0.0.1 y el agente le habla al ESP32.
 * No es un proxy genérico:
 *  - sólo 127.0.0.1, puerto fijo (la web tiene que encontrarlo);
 *  - sólo responde a páginas del server al que está vinculado el agente (Origin), con CORS de ese origen;
 *  - sólo `GET /weight`, `POST /tare`, `POST /calibrate` y `GET /ping`, hacia una IP/nombre de la red local.
 */
export const SCALE_LOCAL_PORT = 47651;
const TIMEOUT_MS = 2_500;
const MAX_BODY = 4 * 1024;
const ROUTES = { '/weight': 'GET', '/tare': 'POST', '/calibrate': 'POST' };

export class ScaleLocal {
    /** @param {() => string} baseUrl server al que está vinculado el agente */
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.server = null;
    }

    start() {
        if (this.server) return;
        const server = createServer((req, res) => this.handle(req, res).catch((err) => this.send(res, req, 500, { error: err.message })));
        server.on('error', (err) => {
            // Otro agente (otro perfil) ya lo tiene: no es grave, la web cae al server.
            warn(`Balanza local: no se pudo abrir 127.0.0.1:${SCALE_LOCAL_PORT}: ${err.code ?? err.message}`);
            this.server = null;
        });
        server.listen(SCALE_LOCAL_PORT, '127.0.0.1');
        this.server = server;
    }

    stop() {
        this.server?.close();
        this.server = null;
    }

    allowedOrigin() {
        try {
            return new URL(this.baseUrl()).origin;
        } catch {
            return null;
        }
    }

    send(res, req, status, body = null) {
        const origin = this.allowedOrigin();
        const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
        if (origin && req.headers.origin === origin) {
            headers['Access-Control-Allow-Origin'] = origin;
            headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
            headers['Access-Control-Allow-Headers'] = 'Content-Type';
            headers['Access-Control-Allow-Private-Network'] = 'true';
            headers['Access-Control-Max-Age'] = '600';
        }
        res.writeHead(status, headers);
        res.end(body === null ? '' : JSON.stringify(body));
    }

    async handle(req, res) {
        const origin = this.allowedOrigin();
        // Una página de otro sitio (o ninguna: curl, otro programa del equipo) no pasa.
        if (!origin || req.headers.origin !== origin) return this.send(res, req, 403, { error: 'origen no permitido' });
        if (req.headers.host !== `127.0.0.1:${SCALE_LOCAL_PORT}` && req.headers.host !== `localhost:${SCALE_LOCAL_PORT}`) {
            return this.send(res, req, 403, { error: 'host no permitido' });
        }
        if (req.method === 'OPTIONS') return this.send(res, req, 204);

        const url = new URL(req.url, `http://127.0.0.1:${SCALE_LOCAL_PORT}`);
        if (url.pathname === '/ping' && req.method === 'GET') return this.send(res, req, 200, { ok: true, scale: 1 });

        const method = ROUTES[url.pathname];
        if (!method || req.method !== method) return this.send(res, req, 404, { error: 'no existe' });

        const host = (url.searchParams.get('host') ?? '').trim();
        const port = Number(url.searchParams.get('port') ?? 80);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return this.send(res, req, 400, { error: 'puerto inválido' });
        const problem = await checkHost(host);
        if (problem) return this.send(res, req, 400, { error: problem });

        let path = url.pathname;
        if (path === '/calibrate') {
            const known = Number(url.searchParams.get('known_weight'));
            if (!Number.isFinite(known) || known <= 0) return this.send(res, req, 400, { error: 'peso conocido inválido' });
            path += `?known_weight=${known}`;
        }

        try {
            const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`, {
                method,
                redirect: 'error',
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const text = (await r.text()).slice(0, MAX_BODY);
            if (!r.ok) return this.send(res, req, 502, { error: `la balanza respondió ${r.status}` });
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                return this.send(res, req, 502, { error: 'respuesta inválida de la balanza' });
            }

            return this.send(res, req, 200, data);
        } catch (err) {
            return this.send(res, req, 502, { error: err.name === 'TimeoutError' ? 'la balanza no responde' : 'sin conexión con la balanza' });
        }
    }
}

/** '' si el host es de la red local (IP privada o un nombre que resuelve sólo a privadas, p. ej. prism-manager-XXXX.local). */
async function checkHost(host) {
    if (!host || host.length > 100 || /[\s/@?#]/.test(host)) return 'host inválido';
    let addresses;
    if (isIP(host)) addresses = [host];
    else {
        try {
            addresses = (await lookup(host, { all: true })).map((a) => a.address);
        } catch {
            return `no se pudo resolver «${host}»`;
        }
    }

    return addresses.length > 0 && addresses.every(isPrivateIp) ? '' : 'sólo se habla con la red local';
}
