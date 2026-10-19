import { formatMb, remaining } from './format.js';
import { log } from './log.js';
import { openUrl } from './notify.js';
import { PROFILE } from './profile.js';
import { askInPopup, hideProgress, progressSupported, showMessage, showProgress } from './progress-ui.js';
import { COMPILED } from './runtime.js';
import { VERSION } from './version.js';

/**
 * «Probar» la ventanita sin subir ni instalar nada: lo pide la web (Mi perfil → Prisma Agent
 * → Probar, vía GET /commands) o `prisma-agent demo [escenario]` en la terminal. Escenarios
 * iguales a App\Services\Agent\AgentDemo::SCENARIOS.
 */
export const DEMO_SCENARIOS = ['upload', 'ready', 'error', 'pause', 'update', 'all'];

/**
 * La demo es sólo para desarrollo: desde el código (`node`/`npm run local:*`) o en un agente con
 * perfil (el que instala un Prisma que no es producción, ej. `prisma-agent-local`). El ejecutable
 * de producción sin perfil no tiene el comando ni atiende el pedido de la web (que producción
 * igual nunca manda: ver AgentDemo::allowed()).
 */
export const DEMO_ENABLED = !COMPILED || PROFILE !== null;

/** Sin ícono que manejar (ej. `demo` con el servicio corriendo: el ícono es del servicio). */
const NO_TRAY = { set() {}, restore() {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = 'Prueba_Prisma_Agent.gcode.3mf';

/**
 * @param {string|undefined} inboxUrl  a dónde lleva el botón Abrir (si no hay, no se muestra)
 * @param {{ set: (status: string, icon: string) => void, restore: () => void }} [tray]  el ícono
 *   de la barra / bandeja: la demo lo hace girar, lo pausa o lo marca con error, y lo devuelve.
 */
export async function runDemo(scenario, { inboxUrl, tray = NO_TRAY } = {}) {
    if (!progressSupported()) {
        log('The popup only exists on macOS and Windows');
        return;
    }
    if (!DEMO_SCENARIOS.includes(scenario)) {
        throw new Error(`Escenario desconocido: ${scenario}. Opciones: ${DEMO_SCENARIOS.join(', ')}.`);
    }
    log(`Demo: ${scenario}`);

    const steps = scenario === 'all' ? ['upload', 'ready', 'error', 'pause', 'update'] : [scenario];
    try {
        for (const step of steps) {
            await STEPS[step](inboxUrl, tray);
            if (steps.length > 1) await sleep(1500);
        }
    } finally {
        tray.restore();
    }
}

const STEPS = {
    async upload(inboxUrl, tray) {
        tray.set(`Preparando ${FILE}`, 'busy'); // el ícono gira mientras «sube»
        showProgress({ title: 'Preparando…', text: FILE, pct: null }, { force: true });
        await sleep(1200);
        for (let pct = 0; pct <= 100; pct += 4) {
            if (pct % 20 === 0) tray.set(`Subiendo ${FILE} - ${pct}%`, 'busy');
            showProgress({ title: `Subiendo - ${pct}% · 1 más en cola`, text: FILE, pct });
            await sleep(120);
        }
        showProgress({ title: 'Subido, verificando...', text: FILE, pct: null }, { force: true });
        await sleep(2500);
        hideProgress();
        tray.restore();
    },

    async ready(inboxUrl) {
        showMessage('Importado correctamente', FILE, 'success', inboxUrl ? { label: 'Abrir', run: () => openUrl(inboxUrl) } : null);
        await sleep(inboxUrl ? 12_500 : 6_500);
    },

    async error(inboxUrl, tray) {
        tray.set('No se pudo subir (prueba)', 'error');
        showMessage('No se pudo subir', `${FILE}: el archivo no es un 3MF sliceado (prueba)`, 'error');
        await sleep(10_500);
        tray.restore();
    },

    async pause(inboxUrl, tray) {
        tray.set('⏸ Pausado · 1 en espera (prueba)', 'paused');
        showMessage('Sincronización en pausa (prueba)', 'Mirá el ícono: dos barritas.');
        await sleep(6_500);
        tray.restore();
    },

    async update() {
        const action = await askInPopup({
            title: 'Hay una versión nueva (prueba)',
            text: '¿La instalo ahora? Es una prueba: no se instala nada.',
            actions: [{ id: 'update', label: 'Actualizar' }, { id: 'later', label: 'Más tarde' }],
            timeoutMs: 60_000,
        });
        const chosen = action === 'update' ? 'Actualizar' : action === 'later' ? 'Más tarde' : action === 'dismiss' ? 'cerrar (✕)' : 'nada (se venció)';
        if (action === 'update') {
            // La descarga como la muestra applyUpdate (run.js), con un tamaño típico del ejecutable.
            const total = 62 * 1024 * 1024;
            const started = Date.now();
            for (let received = 0; received <= total; received += total / 40) {
                const pct = (received / total) * 100;
                showProgress({ title: `Actualizando a 9.9.9 - ${Math.floor(pct)}%`, text: `${formatMb(received)} de ${formatMb(total)}${remaining(started, received, total)}`, pct });
                await sleep(150);
            }
            showProgress({ title: 'Actualizando a 9.9.9…', text: 'Verificando la descarga', pct: null }, { force: true });
            await sleep(1500);
            hideProgress();
        }
        showMessage(`Elegiste: ${chosen}`, `Prueba terminada. Sigue la ${VERSION}.`, action === 'update' ? 'success' : 'info');
        await sleep(6_500);
    },
};
