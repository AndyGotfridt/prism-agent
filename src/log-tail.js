import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Cola de un archivo de log, para «Ver log» desde la web (Mi perfil / Administración).
 * Lee sólo los últimos `maxBytes` y, si el archivo es más largo, descarta la primera línea
 * (casi seguro cortada a la mitad) para no mandar un renglón roto.
 *
 * @returns {{ text: string, truncated: boolean }}
 */
export function readLogTail(path, maxBytes = 150_000) {
    if (!existsSync(path)) throw new Error('El archivo de log todavía no existe.');

    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);

        let text = buffer.toString('utf8');
        const truncated = size > length;
        if (truncated) {
            const firstBreak = text.indexOf('\n');
            if (firstBreak !== -1) text = text.slice(firstBreak + 1);
        }

        return { text, truncated };
    } finally {
        closeSync(fd);
    }
}
