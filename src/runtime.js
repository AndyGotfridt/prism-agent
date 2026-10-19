import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ¿Corre como ejecutable compilado (bun build --compile) o como `node bin/prisma-agent.js`?
 * Compilado, process.execPath ES el agente; con Node hay que pasarle el script.
 */
export const COMPILED = !/^(node|bun)(\.exe)?$/i.test(basename(process.execPath));

const SCRIPT = fileURLToPath(new URL('../bin/prisma-agent.js', import.meta.url));

/** Comando para volver a lanzar el agente (launchd, carpeta Inicio de Windows, re-exec). */
export function selfCommand() {
    return COMPILED ? [process.execPath] : [process.execPath, SCRIPT];
}
