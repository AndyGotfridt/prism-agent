import { mkdirSync, statSync } from 'node:fs';

/**
 * `mkdir -p` que no falla si la carpeta ya existe. En Windows, el mkdirSync recursivo del
 * ejecutable (Bun) tira EEXIST sobre carpetas especiales que ya existen (visto con la carpeta
 * Inicio de AppData\Roaming), en vez de no hacer nada como Node.
 */
export function ensureDir(dir) {
    try {
        mkdirSync(dir, { recursive: true });
    } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        if (!statSync(dir).isDirectory()) throw err;
    }
}
