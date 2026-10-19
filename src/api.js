import { platform } from 'node:os';
import { autostartEnabled } from './autostart.js';
import { VERSION } from './version.js';

export const USER_AGENT = `PrismaAgent/${VERSION} (${platform()})`;

/** Error de la API con el status HTTP. `retryable`: red caída, 5xx o 429. */
export class ApiError extends Error {
    constructor(message, { status = 0, retryable = false, body = null } = {}) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.body = body;
    }
}

/**
 * Cliente de /api/agent/v1. Manda siempre el User-Agent del agente (la regla de WAF de
 * Cloudflare saltea challenges para /api/agent/*) y detecta un challenge para reportarlo
 * claro en vez de «JSON inválido».
 */
export class Api {
    constructor(baseUrl, token = null) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.token = token;
    }

    url(path) {
        return `${this.baseUrl}/api/agent/v1${path}`;
    }

    async request(method, path, { json, body, headers = {}, raw = false, duplex } = {}) {
        const h = {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            'X-Agent-Version': VERSION,
            'X-Agent-Platform': platform(),
            ...headers,
        };
        // Estado real del inicio automático (Mi perfil lo muestra y lo puede cambiar).
        const autostart = autostartEnabled();
        if (autostart !== null) h['X-Agent-Autostart'] = autostart ? '1' : '0';
        if (this.token) h.Authorization = `Bearer ${this.token}`;
        if (json !== undefined) {
            h['Content-Type'] = 'application/json';
            body = JSON.stringify(json);
        }

        let res;
        try {
            res = await fetch(this.url(path), { method, headers: h, body, ...(duplex ? { duplex } : {}) });
        } catch (err) {
            const cause = err.cause?.code ?? err.cause?.message ?? err.message;
            const hint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(String(cause))
                ? process.platform === 'win32'
                    ? ' (certificado no confiable: probablemente un antivirus o proxy que inspecciona HTTPS con una CA que no está en Windows; ver README)'
                    : ' (certificado no confiable: para https://*.test usá NODE_EXTRA_CA_CERTS con la CA de mkcert, ver README)'
                : '';
            throw new ApiError(`No se pudo conectar con ${this.baseUrl}: ${cause}${hint}`, { retryable: true });
        }

        if (raw) return res;

        if (res.status === 304) return { status: 304, headers: res.headers, data: null };

        const type = res.headers.get('content-type') ?? '';
        const text = await res.text();

        if (!type.includes('application/json')) {
            if (res.headers.get('cf-mitigated') || (/cloudflare/i.test(res.headers.get('server') ?? '') && [403, 503].includes(res.status))) {
                throw new ApiError('Cloudflare bloqueó el pedido (challenge). Falta la regla de WAF para /api/agent/* (docs/cloudflare-waf-agent.md).', { status: res.status });
            }
            if (res.status === 413) {
                throw new ApiError('El servidor rechazó el tamaño del pedido (413).', { status: 413 });
            }
            throw new ApiError(`Respuesta inesperada del servidor (HTTP ${res.status}).`, {
                status: res.status,
                retryable: res.status >= 500 || res.status === 429,
            });
        }

        const data = text ? JSON.parse(text) : null;

        if (!res.ok) {
            const message = data?.message ?? `HTTP ${res.status}`;
            throw new ApiError(message, { status: res.status, retryable: res.status >= 500 || res.status === 429, body: data });
        }

        return { status: res.status, headers: res.headers, data };
    }

    get(path, opts) {
        return this.request('GET', path, opts);
    }

    post(path, json, opts = {}) {
        return this.request('POST', path, { ...opts, json });
    }

    put(path, body, opts = {}) {
        return this.request('PUT', path, { ...opts, body, headers: { 'Content-Type': 'application/octet-stream', ...(opts.headers ?? {}) } });
    }

    /**
     * PUT de un buffer en tajadas de 256 KB, avisando cuántos bytes ya salieron (`onBytes`):
     * fetch no informa el progreso de una subida, así que se mide lo que el socket va
     * aceptando. Con Content-Length explícito, para que no viaje como chunked.
     */
    putStream(path, buffer, onBytes, opts = {}) {
        const SLICE = 256 * 1024;
        let offset = 0;
        const body = new ReadableStream({
            pull(controller) {
                if (offset >= buffer.length) {
                    controller.close();
                    return;
                }
                const end = Math.min(buffer.length, offset + SLICE);
                controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, end - offset));
                offset = end;
                onBytes?.(offset);
            },
        });

        return this.request('PUT', path, {
            ...opts,
            body,
            duplex: 'half',
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length), ...(opts.headers ?? {}) },
        });
    }

    delete(path, opts) {
        return this.request('DELETE', path, opts);
    }
}
