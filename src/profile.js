import { PRODUCT_NAME } from './version.js';

/**
 * Perfil del agente: permite tener más de un Prisma Agent en la misma computadora (ej.
 * producción y local), cada uno con su sesión, su servicio y su carpeta de estado.
 *
 * Se elige con `--profile <nombre>` o con la variable PRISMA_AGENT_PROFILE (la que usan el
 * servicio de launchd / el lanzador de Windows y los instaladores). Sin perfil es el agente
 * de siempre: mismas rutas y mismo servicio que antes de que existieran los perfiles.
 *
 * Se resuelve al importar el módulo porque las rutas (config, estado, servicio) son
 * constantes de módulo; este archivo sólo importa version.js (que no importa nada del
 * agente), así se evalúa primero.
 */
function resolve() {
    const argv = process.argv;
    let value = process.env.PRISMA_AGENT_PROFILE ?? '';
    for (let i = 0; i < argv.length; i++) {
        const m = argv[i].match(/^--profile(?:=(.*))?$/);
        if (m) value = m[1] ?? argv[i + 1] ?? '';
    }

    value = value.trim().toLowerCase();
    if (value === 'default') value = '';
    // Para los procesos hijos (re-exec con la CA de mkcert, selector de carpetas).
    process.env.PRISMA_AGENT_PROFILE = value;
    if (value === '') return null;
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) {
        console.error(`✖ Perfil inválido «${value}»: sólo letras, números y guiones (ej. local).`);
        process.exit(1);
    }

    return value;
}

/** Nombre del perfil, o null para el agente por defecto. */
export const PROFILE = resolve();

/** `prisma-agent` → `prisma-agent-local` con perfil; para carpetas, archivos y servicios. */
export function profiled(name, separator = '-') {
    return PROFILE ? `${name}${separator}${PROFILE}` : name;
}

/** Comando para los mensajes: los instaladores dejan `prisma-agent-<perfil>` en el PATH. */
export const COMMAND = profiled('prisma-agent');

/** Título de los avisos de escritorio (productName de package.json), con el perfil si hay. */
export const APP_TITLE = PROFILE ? `${PRODUCT_NAME} (${PROFILE})` : PRODUCT_NAME;
