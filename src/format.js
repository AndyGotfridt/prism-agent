/** Textos de tamaño y tiempo para la ventanita y la terminal. */

/** 12345678 → «11,8 MB». */
export function formatMb(bytes) {
    return `${(bytes / 1024 / 1024).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** « · faltan ~20 s» según la velocidad hasta ahora (nada el primer segundo: no hay con qué estimar). */
export function remaining(started, received, total) {
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed < 1 || received <= 0 || received >= total) return '';
    const seconds = Math.ceil(((total - received) / received) * elapsed);
    return seconds < 60 ? ` faltan ~${seconds} s` : ` faltan ~${Math.ceil(seconds / 60)} min`;
}
