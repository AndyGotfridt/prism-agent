import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ensureDir } from './fs-util.js';
import { platform } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR } from './state.js';

/**
 * Dónde queda el token, sin dependencias nativas (así el agente se compila a un solo
 * ejecutable):
 *
 * - macOS: Llavero, con /usr/bin/security (misma entrada `prisma-agent` / URL que usaba
 *   @napi-rs/keyring, así que una sesión vieja se sigue leyendo).
 * - Windows: archivo cifrado con DPAPI del usuario (ConvertTo/ProtectedData vía PowerShell):
 *   sólo ese usuario de Windows lo puede descifrar.
 * - Linux: archivo con permisos 0600.
 *
 * Una entrada por URL base: cambiar de entorno no pisa el token del otro. El token nunca va
 * por línea de comandos (se ve en `ps`): va por stdin o por variable de entorno.
 */
const SERVICE = 'prisma-agent';

function run(cmd, args, { input, env } = {}) {
    return new Promise((resolve) => {
        const child = execFile(cmd, args, { env: { ...process.env, ...env }, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
        });
        if (input !== undefined) child.stdin.end(input);
    });
}

const fileFor = (baseUrl, ext) => join(STATE_DIR, `token-${createHash('sha256').update(baseUrl).digest('hex').slice(0, 16)}.${ext}`);

const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

export async function getToken(baseUrl) {
    switch (platform()) {
        case 'darwin': {
            const res = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', baseUrl, '-w']);
            return res.ok && res.stdout ? res.stdout : null;
        }
        case 'win32': {
            let data;
            try {
                data = readFileSync(fileFor(baseUrl, 'dpapi'), 'utf8').trim();
            } catch {
                return null;
            }
            const res = await powershell(
                `Add-Type -AssemblyName System.Security
$b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:PA_DATA), $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))`,
                { PA_DATA: data },
            );
            return res.ok && res.stdout ? res.stdout : null;
        }
        default:
            try {
                return readFileSync(fileFor(baseUrl, 'token'), 'utf8').trim() || null;
            } catch {
                return null;
            }
    }
}

export async function setToken(baseUrl, token) {
    switch (platform()) {
        case 'darwin': {
            // `security -i` lee el comando por stdin: el token no queda en la lista de procesos.
            const res = await run('/usr/bin/security', ['-i'], {
                input: `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(baseUrl)} -w ${quote(token)}\n`,
            });
            if (!res.ok || /error/i.test(res.stderr)) throw new Error(`No se pudo guardar el token en el Llavero: ${res.stderr}`);
            return;
        }
        case 'win32': {
            const res = await powershell(
                `Add-Type -AssemblyName System.Security
$b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:PA_SECRET), $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($b))`,
                { PA_SECRET: token },
            );
            if (!res.ok || !res.stdout) throw new Error(`No se pudo cifrar el token: ${res.stderr}`);
            ensureDir(STATE_DIR);
            writeFileSync(fileFor(baseUrl, 'dpapi'), res.stdout);
            return;
        }
        default:
            ensureDir(STATE_DIR);
            writeFileSync(fileFor(baseUrl, 'token'), token, { mode: 0o600 });
    }
}

export async function deleteToken(baseUrl) {
    if (platform() === 'darwin') {
        await run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', baseUrl]);
        return;
    }
    rmSync(fileFor(baseUrl, platform() === 'win32' ? 'dpapi' : 'token'), { force: true });
}

function powershell(script, env) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env });
}
