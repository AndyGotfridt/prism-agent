import { execFileSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { ensureDir } from './fs-util.js';
import { join } from 'node:path';
import { STATE_DIR } from './state.js';

const PEM = join(STATE_DIR, 'windows-roots.pem');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Certificados raíz del almacén de Windows (equipo + usuario) en un PEM, para pasarlo como
 * NODE_EXTRA_CA_CERTS. El agente compilado sólo confía en la lista de CAs que trae Bun, no en
 * la de Windows: un antivirus que inspecciona HTTPS (Kaspersky, ESET, Avast…) o un proxy de
 * empresa firma con su propia CA, que el navegador acepta porque está en Windows, y el agente
 * no («unable to verify the first certificate»). Se regenera una vez por día.
 *
 * Devuelve la ruta del PEM, o null si no se pudo armar (el agente sigue sin él).
 */
export function windowsRootsPem() {
    try {
        if (Date.now() - statSync(PEM).mtimeMs < MAX_AGE_MS) return PEM;
    } catch {
        // No existe todavía.
    }

    const script = `$sb = New-Object Text.StringBuilder
Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root | ForEach-Object {
  [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
  [void]$sb.AppendLine([Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'))
  [void]$sb.AppendLine('-----END CERTIFICATE-----')
}
[Console]::Out.Write($sb.ToString())`;

    try {
        const pem = execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
        ).toString();
        if (!pem.includes('BEGIN CERTIFICATE')) return null;

        ensureDir(STATE_DIR);
        writeFileSync(PEM, pem);
        return PEM;
    } catch {
        return null;
    }
}
