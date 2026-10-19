import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** rootCA.pem de mkcert, o null si mkcert no está instalado. */
export function mkcertCaPath() {
    try {
        const root = execFileSync('mkcert', ['-CAROOT'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const pem = join(root, 'rootCA.pem');
        return existsSync(pem) ? pem : null;
    } catch {
        return null;
    }
}
