import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Requests HTTP a enchufes de la LAN del taller (`http.request` / `http.poll`, docs/PLAN-AGENT-BRIDGE.md §8).
 * El agente NO es un proxy: sólo GET/POST/PUT, sólo a IPs privadas (RFC 1918, link-local, ULA IPv6) —el propio
 * equipo (loopback) no—, sin seguir redirecciones, con timeout corto y la respuesta acotada a 64 KB.
 * Un nombre (`shelly.local`) se resuelve y TODAS sus direcciones tienen que ser privadas.
 */
const METHODS = new Set(['GET', 'POST', 'PUT']);
const TIMEOUT_MS = 5_000;
const MAX_BODY = 64 * 1024;
const MAX_REQUEST_BODY = 16 * 1024;

/** ¿IP de la red local? (privada, link-local o ULA). Loopback, públicas y reservadas dan false. */
export function isPrivateIp(ip) {
    const v = isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split('.').map(Number);

        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    if (v === 6) {
        const x = ip.toLowerCase();
        if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7)); // IPv4 mapeada

        return /^f[cd][0-9a-f]{2}:/.test(x) || /^fe[89ab][0-9a-f]:/.test(x);
    }

    return false;
}

/** @returns {Promise<string>} mensaje si la URL no se puede pedir; si está bien, devuelve '' */
async function check(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return 'URL inválida';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Sólo http/https';
    if (u.username || u.password) return 'La URL no puede llevar usuario y clave';

    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    if (isIP(host)) addresses = [host];
    else {
        try {
            addresses = (await lookup(host, { all: true })).map((a) => a.address);
        } catch {
            return `No se pudo resolver «${host}»`;
        }
    }
    if (addresses.length === 0 || !addresses.every(isPrivateIp)) return 'El puente sólo habla con direcciones de la red local';

    return '';
}

/**
 * @param {{ method: string, url: string, headers?: Record<string, unknown>, body?: string | null, content_type?: string | null }} p
 * @returns {Promise<{ status: number, content_type: string, body: string }>}
 */
export async function httpRequest(p) {
    const method = String(p.method ?? '').toUpperCase();
    if (!METHODS.has(method)) throw new Error('Método no permitido');
    const bad = await check(String(p.url ?? ''));
    if (bad) throw new Error(bad);
    if (p.body && Buffer.byteLength(p.body) > MAX_REQUEST_BODY) throw new Error('El cuerpo es demasiado grande');

    const headers = {};
    for (const [k, v] of Object.entries(p.headers ?? {})) {
        if (/^[A-Za-z0-9-]{1,64}$/.test(k) && !/^(host|content-length|connection|transfer-encoding)$/i.test(k)) headers[k] = String(v).slice(0, 1024);
    }
    if (p.body && p.content_type && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = p.content_type;

    let res;
    try {
        res = await fetch(p.url, { method, headers, body: p.body || undefined, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        throw new Error(err.name === 'TimeoutError' ? 'El dispositivo no contestó a tiempo' : `No se pudo conectar: ${err.cause?.code ?? err.message}`);
    }

    // Una redirección es un 3xx: se devuelve tal cual (el server lo trata como falla), nunca se sigue.
    const reader = res.body?.getReader();
    const parts = [];
    let size = 0;
    while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) {
            await reader.cancel();
            break;
        }
        parts.push(value);
    }

    return { status: res.status, content_type: res.headers.get('content-type') ?? 'text/plain', body: Buffer.concat(parts).toString('utf8') };
}
