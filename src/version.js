import pkg from '../package.json' with { type: 'json' };

export const VERSION = pkg.version;

/** Nombre que se muestra en la ventanita y los avisos (`productName` de package.json). */
export const PRODUCT_NAME = pkg.productName || 'Prisma Agent';

/** Compara versiones x.y.z. Devuelve <0, 0 o >0. */
export function compareVersions(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
}
