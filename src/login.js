import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname, platform, userInfo } from 'node:os';
import { Api } from './api.js';
import { deleteToken, getToken, setToken } from './keychain.js';
import { readLocalConfig, writeLocalConfig } from './local-config.js';
import { openUrl } from './notify.js';
import { VERSION, compareVersions } from './version.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * `prisma-agent login`: Authorization Code + PKCE con redirect a loopback (RFC 8252/7636).
 * Levanta un server sólo en 127.0.0.1 y sólo para /callback, abre el navegador en la
 * pantalla de consentimiento de Prisma y canjea el code por un token que va al Keychain.
 */
export async function login({ url, name, ...options }) {
    const baseUrl = url.replace(/\/+$/, '');
    const api = new Api(baseUrl);

    const { data: ping } = await api.get('/ping');
    if (ping?.app !== 'prisma-3d') {
        throw new Error(`${baseUrl} no parece ser Prisma 3D.`);
    }
    if (compareVersions(VERSION, ping.min_agent_version) < 0) {
        throw new Error(`Esta versión del agente (${VERSION}) es vieja: el servidor pide ${ping.min_agent_version} o más nueva.`);
    }

    // Puente vinculado desde el admin: código de enrolamiento ya aprobado, sin navegador ni código que ingresar.
    if (options.enroll) {
        return loginWithEnrollment({ api, baseUrl, code: options.enroll, options });
    }

    // Sin navegador en esta máquina (SSH, Raspberry Pi): código de dispositivo.
    if (options.device || (platform() === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) {
        return loginWithCode({ api, baseUrl, name, options });
    }

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    const deviceName = name || defaultDeviceName();

    const { server, port, result } = await startCallbackServer(state);
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const authorizeUrl = new URL(`${baseUrl}/agent/authorize`);
    authorizeUrl.search = new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        device_name: deviceName,
        hostname: hostname(),
    }).toString();

    console.log('Abriendo el navegador para autorizar el agente…');
    console.log(`Si no se abre, entrá a:\n  ${authorizeUrl}\n`);
    openUrl(authorizeUrl.toString());

    let code;
    try {
        code = await result;
    } finally {
        server.close();
    }

    const { data } = await api.post('/token', {
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        device_name: deviceName,
        hostname: hostname(),
        platform: platform(),
        agent_version: VERSION,
    });

    // Si había otra sesión en esta misma URL, se reemplaza (el dispositivo viejo queda
    // en la web para revocarlo).
    await setToken(baseUrl, data.token);
    writeLocalConfig({ url: baseUrl, device_id: data.device_id, device_name: data.device_name });

    console.log(`✔ Conectado como «${data.device_name}». El token vence el ${new Date(data.expires_at).toLocaleDateString()}.`);
    if (!options.quiet) {
        console.log('Siguiente paso: `prisma-agent run` para probar, o `prisma-agent install` para que arranque solo.');
    }
}

/**
 * Login por código (estilo RFC 8628) para computadoras sin navegador: muestra un código, la persona lo
 * ingresa en /agent/link desde cualquier otro equipo y esta terminal recibe el token sondeando.
 */
async function loginWithCode({ api, baseUrl, name, options }) {
    const deviceName = name || defaultDeviceName();
    const meta = { device_name: deviceName, hostname: hostname(), platform: platform(), agent_version: VERSION };
    const { data: flow } = await api.post('/device/code', meta);

    console.log('Esta computadora no tiene navegador. Para autorizarla, desde cualquier otro equipo:');
    console.log(`  1. Entrá a ${flow.verification_uri}`);
    console.log(`  2. Ingresá el código:  ${flow.user_code}`);
    console.log(`(Vence en ${Math.round(flow.expires_in / 60)} minutos. También sirve: ${flow.verification_uri}?code=${flow.user_code})\n`);

    const deadline = Date.now() + flow.expires_in * 1000;
    let data = null;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, (flow.interval ?? 5) * 1000));
        try {
            const { data: reply } = await api.post('/device/token', { device_code: flow.device_code });
            if (reply?.status === 'pending') continue; // 202: todavía no lo autorizaron
            data = reply;
            break;
        } catch (err) {
            if (err.status === 403) throw new Error('Se canceló la autorización en la web.');
            if (err.status === 410) throw new Error('El código venció. Volvé a correr el login.');
            if (err.retryable) continue; // red caída un momento
            throw err;
        }
    }
    if (!data) throw new Error('Pasaron 10 minutos sin autorizar. Volvé a intentar.');

    await setToken(baseUrl, data.token);
    writeLocalConfig({ url: baseUrl, device_id: data.device_id, device_name: data.device_name });

    console.log(`✔ Conectado como «${data.device_name}». El token vence el ${new Date(data.expires_at).toLocaleDateString()}.`);
    if (!options.quiet) {
        console.log('Siguiente paso: `prisma-agent install` para que arranque solo.');
    }
}

/**
 * `login --enroll <código>`: el código lo genera un admin en Administración → Prisma Agent → Puentes y ya viene
 * aprobado (un solo uso, 24 h). Se canjea directo en `device/token`; el dispositivo nace con el puente prendido.
 */
async function loginWithEnrollment({ api, baseUrl, code, options }) {
    let data;
    try {
        ({ data } = await api.post('/device/token', { device_code: String(code).trim() }));
    } catch (err) {
        if (err.status === 410 || err.status === 403) throw new Error('El código de enrolamiento venció o ya se usó. Generá otro en Administración → Prisma Agent → Puentes.');
        throw err;
    }
    if (!data?.token) throw new Error('El código de enrolamiento no es válido.');

    await setToken(baseUrl, data.token);
    writeLocalConfig({ url: baseUrl, device_id: data.device_id, device_name: data.device_name });

    console.log(`✔ Puente vinculado como «${data.device_name}». El token vence el ${new Date(data.expires_at).toLocaleDateString()}.`);
    if (!options.quiet) {
        console.log('Siguiente paso: `prisma-agent run`.');
    }
}

export async function logout() {
    const local = readLocalConfig();
    if (!local?.url) {
        console.log('No había sesión iniciada.');
        return;
    }

    const token = await getToken(local.url);
    if (token) {
        try {
            await new Api(local.url, token).delete('/token');
        } catch (err) {
            console.warn(`No se pudo avisar al servidor (${err.message}); igual se borra la sesión local. Revocalo desde Mi perfil → Prisma Agent.`);
        }
    }

    await deleteToken(local.url);
    // Queda sólo la URL (sin dispositivo): así el agente instalado puede ofrecer «Iniciar
    // sesión…» desde su ícono en vez de no arrancar.
    writeLocalConfig({ url: local.url });
    console.log('✔ Sesión cerrada.');
}

function defaultDeviceName() {
    const host = hostname().replace(/\.local$/i, '');
    return host || `Equipo de ${userInfo().username}`;
}

/** Server efímero en loopback: sólo /callback, se apaga solo a los 5 minutos. */
function startCallbackServer(expectedState) {
    return new Promise((resolveStart, rejectStart) => {
        let settle;
        const result = new Promise((resolve, reject) => {
            settle = { resolve, reject };
        });

        const page = (title, text) =>
            `<!doctype html><meta charset="utf-8"><title>Prisma Agent</title><body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2937"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body>`;

        const server = createServer((req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname !== '/callback') {
                res.writeHead(404).end();
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

            if (url.searchParams.get('state') !== expectedState) {
                res.end(page('No se pudo conectar', 'La respuesta no corresponde a este inicio de sesión. Volvé a correr <code>prisma-agent login</code>.'));
                settle.reject(new Error('El parámetro state no coincide.'));
                return;
            }

            if (url.searchParams.get('error')) {
                res.end(page('⚠️ Cancelado', 'No se conectó el agente. Podés cerrar esta pestaña.'));
                settle.reject(new Error('Autorización cancelada en el navegador.'));
                return;
            }

            const code = url.searchParams.get('code');
            if (!code) {
                res.end(page('❌ No se pudo conectar', 'Faltó el código de autorización.'));
                settle.reject(new Error('Faltó el código de autorización.'));
                return;
            }

            res.end(page('✅ Listo', 'Prisma Agent quedó conectado. Ya podés cerrar esta pestaña.'));
            settle.resolve(code);
        });

        const timer = setTimeout(() => settle.reject(new Error('Pasaron 5 minutos sin autorizar. Volvé a intentar.')), LOGIN_TIMEOUT_MS);
        result.finally(() => clearTimeout(timer)).catch(() => {});

        server.on('error', rejectStart);
        server.listen(0, '127.0.0.1', () => {
            resolveStart({ server, port: server.address().port, result });
        });
    });
}
