import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ApiError } from './api.js';
import { pickFolder } from './folder-picker.js';
import { readLogTail } from './log-tail.js';
import { warn } from './log.js';

/**
 * Pantalla de configuración local de «Carpetas a Drive» (menú del ícono → Configurar…).
 *
 * Un servidor mínimo en 127.0.0.1 (puerto al azar, con un secreto en la ruta) que sirve una
 * página y reenvía sus pedidos a /api/agent/v1/drive-syncs con el token del agente: la página
 * nunca ve el token. Sirve para dar de alta carpetas nuevas (explorando Drive) y para los
 * ajustes de cada una sin abrir Prisma en la web. El server sigue siendo la fuente de verdad.
 */
export class ConfigUi {
    /** @param {() => import('./api.js').Api | null} getApi */
    constructor(getApi, { onChange, logPath, progress, prefs } = {}) {
        this.getApi = getApi;
        this.logPath = logPath ?? (() => null);
        this.progress = progress ?? (() => ({}));
        this.prefs = prefs ?? { get: () => ({}), set: () => ({}), onChange: () => {} };
        this.onChange = onChange ?? (() => {});
        this.server = null;
        this.secret = randomBytes(16).toString('hex');
        this.url = null;
    }

    /** Levanta el servidor la primera vez y devuelve la URL de la pantalla. */
    async ensure() {
        if (this.url) return this.url;

        await new Promise((resolve, reject) => {
            this.server = createServer((req, res) => this.handle(req, res).catch((err) => this.fail(res, 500, err.message)));
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.url = `http://127.0.0.1:${this.server.address().port}/${this.secret}/`;
                this.server.unref();
                resolve();
            });
        });

        return this.url;
    }

    close() {
        this.server?.close();
        this.server = null;
        this.url = null;
    }

    fail(res, status, message) {
        if (res.headersSent) return res.end();
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ message }));
    }

    async handle(req, res) {
        // Sólo desde este equipo y con el secreto: protege de otras páginas abiertas en el navegador
        // (Host: contra DNS rebinding; el secreto: contra pedidos a ciegas al puerto).
        const port = this.server.address().port;
        if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return this.fail(res, 403, 'Host no permitido.');

        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const prefix = `/${this.secret}/`;
        if (!url.pathname.startsWith(prefix)) return this.fail(res, 404, 'No encontrado.');
        const path = url.pathname.slice(prefix.length);

        if (path === '' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
            res.end(PAGE);
            return;
        }

        if (path === 'api/progress' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(this.progress()));
            return;
        }

        if (path === 'api/prefs' && ['GET', 'PUT'].includes(req.method)) {
            let body = this.prefs.get();
            if (req.method === 'PUT') {
                const chunks = [];
                for await (const c of req) chunks.push(c);
                body = this.prefs.set(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
                this.prefs.onChange();
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
            return;
        }

        if (path === 'api/log' && req.method === 'GET') {
            const file = this.logPath();
            let body;
            try {
                if (!file) throw new Error('Estás ejecutando en modo terminal: el log es la terminal donde corre el agente.');
                body = { ...readLogTail(file, 300_000), file };
            } catch (err) {
                body = { text: '', truncated: false, message: err.message };
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
            return;
        }

        if (path === 'api/pick-folder' && req.method === 'POST') {
            const picked = await pickFolder(null, { timeoutMs: 180_000 });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ path: picked }));
            return;
        }

        // Todo lo demás se reenvía al server (sólo /drive-syncs… y /slicer-settings).
        if ((path.startsWith('api/drive-syncs') || path === 'api/slicer-settings') && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            const api = this.getApi();
            if (!api) return this.fail(res, 401, 'Sin sesión en el agente.');

            let json;
            if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
                const chunks = [];
                for await (const c of req) chunks.push(c);
                const raw = Buffer.concat(chunks).toString('utf8');
                json = raw ? JSON.parse(raw) : {};
            }

            try {
                const target = `/${path.slice(4)}${url.search}`;
                const { data } = await api.request(req.method, target, json === undefined ? {} : { json });
                if (req.method !== 'GET') this.onChange();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(data ?? { ok: true }));
            } catch (err) {
                const status = err instanceof ApiError && err.status ? err.status : 502;
                warn(`Config UI: ${err.message}`);
                this.fail(res, status, err.message);
            }
            return;
        }

        this.fail(res, 404, 'No encontrado.');
    }
}

const PAGE = String.raw`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sincronización Drive · Prisma Agent</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%234f46e5'/%3E%3Cg fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M25 10.5 16 6 7 10.5v11L16 26l9-4.5v-11Z'/%3E%3Cpath d='M7 10.5 16 15l9-4.5'/%3E%3Cpath d='M16 15v11'/%3E%3C/g%3E%3C/svg%3E">
<style>
 :root{--b:#e5e7eb;--t:#111827;--m:#6b7280;--p:#4f46e5}
 *{box-sizing:border-box} body{font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--t);background:#f9fafb;margin:0;padding:32px 16px}
 main{max-width:768px;margin:0 auto}
 h1{font-size:18px;font-weight:500;margin:0 0 4px;display:flex;align-items:center;gap:10px}h1 img{width:24px;height:24px}
 .sub{color:#4b5563;margin:0 0 20px;font-size:14px}
 .card{background:#fff;border:1px solid var(--b);border-radius:8px;padding:16px 20px;margin-bottom:12px}
 .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center} .grow{flex:1;min-width:0}
 .name{font-weight:500;font-size:14px} .path{color:var(--m);font-size:12px;word-break:break-all;margin-top:2px}
 .pill{font-size:12px;font-weight:500;padding:2px 8px;border-radius:999px;background:#f3f4f6;color:#4b5563}
 .pill.run{background:#eef2ff;color:#4338ca}.pill.err{background:#fef2f2;color:#b91c1c}.pill.warn{background:#fffbeb;color:#b45309}
 button{font:inherit;font-size:12px;font-weight:500;text-transform:uppercase;height:36px;padding:0 12px;border-radius:8px;border:0;background:#fff;color:#4b5563;
  box-shadow:inset 0 0 0 1px #e5e7eb;cursor:pointer;display:inline-flex;align-items:center;transition:background .15s}
 button:hover{background:#f9fafb;color:#111827} button.primary{height:40px;padding:0 16px;background:var(--p);color:#fff;box-shadow:none;font-weight:600;letter-spacing:.1em}
 button.primary:hover{background:#4338ca} button.danger{color:#dc2626;box-shadow:inset 0 0 0 1px #fecaca}button.danger:hover{background:#fef2f2}
 button:disabled{opacity:.4;cursor:default}
 input[type=text]{font:inherit;width:100%;height:40px;padding:0 12px;border:1px solid #d1d5db;border-radius:8px;background:#fff}
 input[type=text]:focus{outline:2px solid #c7d2fe;border-color:var(--p)}
 label.l{display:block;font-weight:500;font-size:14px;color:#374151;margin:16px 0 4px}.hint{color:var(--m);font-size:12px;font-weight:400}
 .folders{border:1px solid var(--b);border-radius:8px;max-height:220px;overflow:auto;margin-top:6px}
 .folders div{padding:8px 12px;border-bottom:1px solid #f3f4f6;cursor:pointer;display:flex;align-items:center}.folders div:last-child{border:0}.folders div:hover{background:#f9fafb}
 .crumbs{font-size:14px}.crumbs a{color:var(--p);cursor:pointer}.msg{padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:14px}
 .msg.ok{background:#ecfdf5;color:#065f46}.msg.bad{background:#fef2f2;color:#991b1b}
 .ic{width:16px;height:16px;flex:none;margin-right:6px}.folders .ic{color:#fbbf24;margin-right:10px}h1 .ic{margin:0}
 /* Mismo switch que x-toggle de la app: 44×24, perilla de 20, índigo. */
 .sw{position:relative;display:inline-block;width:44px;height:24px;flex:none}
 .sw input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1}
 .sw i{position:absolute;inset:0;border-radius:999px;background:#d1d5db;transition:background .15s}
 .sw i:before{content:"";position:absolute;left:2px;top:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s}
 .sw input:checked+i{background:#4f46e5}.sw input:checked+i:before{transform:translateX(20px)}
 .sw input:disabled{cursor:default}.sw input:disabled+i{opacity:.5}
 label.opt{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border:1px solid var(--b);border-radius:8px;font-size:14px;cursor:pointer}
 label.opt:has(input:checked){border-color:#6366f1;background:#eef2ff;color:#312e81}
 .tabs{display:flex;gap:4px;border-bottom:1px solid var(--b);margin-bottom:16px}
 .tabs a{padding:8px 12px;font-size:14px;color:#6b7280;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer;display:inline-flex;align-items:center;text-decoration:none}
 .tabs a:hover{color:#374151;border-color:#d1d5db}.tabs a.on{color:#4338ca;font-weight:500;border-color:#4f46e5}
 .logbox{background:#111827;color:#e5e7eb;border-radius:8px;padding:12px 14px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-word}
 .logbox .ln{display:block}.logbox .ts{color:#6b7280}.logbox .WARN{color:#fbbf24}.logbox .ERROR{color:#f87171}.logbox .INFO .lv{color:#34d399}
 .tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
 select{font:inherit;font-size:14px;color:#111827;height:36px;border:1px solid #d1d5db;border-radius:8px;padding:0 34px 0 12px;cursor:pointer;
  appearance:none;-webkit-appearance:none;
  background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%236b7280' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 7.5 5 5 5-5'/%3E%3C/svg%3E") no-repeat right 10px center/16px;
  transition:border-color .15s,box-shadow .15s}
 select:hover{border-color:#9ca3af}
 select:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.2)}
 select option{color:#111827;background:#fff}
 .prog{margin-top:12px}
 .prog .top{display:flex;align-items:baseline;gap:8px;font-size:14px;color:#374151}
 .prog .pct{font-size:22px;font-weight:600;color:#4338ca;font-variant-numeric:tabular-nums}
 .prog .bar{height:8px;border-radius:999px;background:#e5e7eb;overflow:hidden;margin:6px 0 8px}
 .prog .bar i{display:block;height:100%;background:#4f46e5;border-radius:999px;transition:width .4s ease}
 .prog .bar.ind i{width:40%;animation:ind 1.2s ease-in-out infinite}
 @keyframes ind{0%{margin-left:-40%}100%{margin-left:100%}}
 .prog .stats{display:flex;gap:8px;flex-wrap:wrap}
 .prog .stat{background:#f3f4f6;border-radius:8px;padding:4px 10px;font-size:13px;color:#374151;font-variant-numeric:tabular-nums}
 .prog .stat b{font-weight:600;color:#111827}.prog .stat.bad{background:#fef2f2;color:#991b1b}.prog .stat.bad b{color:#991b1b}
 .prog .cur{margin-top:6px;font-size:12px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .tools input[type=text]{width:220px;height:36px}
 .swrow{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:14px;color:#374151}
</style></head><body><main>
<h1><img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%234f46e5'/%3E%3Cg fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M25 10.5 16 6 7 10.5v11L16 26l9-4.5v-11Z'/%3E%3Cpath d='M7 10.5 16 15l9-4.5'/%3E%3Cpath d='M16 15v11'/%3E%3C/g%3E%3C/svg%3E">Sincronización Drive</h1>
<p class="sub">Sincronizá carpetas de esta computadora con Google Drive (sólo de acá hacia Drive).</p>
<div class="tabs"><a id="tab-slicer" class="on"></a><a id="tab-folders"></a><a id="tab-logs"></a></div>
<div id="msg"></div>
<section id="view-slicer">
 <div class="card">
  <strong>Importación de modelos</strong>
  <div class="hint" style="margin-top:2px">Lo que exportás del slicer a esta carpeta se sube solo a «Por importar».</div>
  <label class="l">Carpeta de sincronización</label>
  <div class="row"><input class="grow" type="text" id="sPath"><button id="sPick"></button></div>
  <label class="l">Aplicar a</label>
  <div class="row" id="sScope">
   <label class="opt"><input type="radio" name="sScope" value="device" checked> Sólo esta computadora</label>
   <label class="opt"><input type="radio" name="sScope" value="all"> Todas mis computadoras</label>
  </div>
  <label class="l">Cuando un archivo ya se subió</label>
  <div class="row" id="sAfter"></div>
  <div id="sSwitches"></div>
  <details style="margin-top:14px"><summary class="hint" style="cursor:pointer">Avanzado</summary>
   <label class="l">Esperar antes de subir <span class="hint">milisegundos sin cambios para darlo por terminado</span></label>
   <input type="text" id="sStable" style="max-width:160px">
  </details>
  <div class="row" style="margin-top:16px"><button class="primary" id="sSave"></button><span class="hint">Se aplica en unos segundos y en tus otras computadoras en unos minutos.</span></div>
 </div>
</section>
<section id="view-folders" hidden>
<div class="card">
 <div class="swrow" style="margin:0"><span class="sw"><input type="checkbox" id="pPopup"><i></i></span><span>Mostrar el progreso en una ventanita <span class="hint">· si la cerrás con la ✕ no vuelve a aparecer hasta que la actives acá</span></span></div>
</div>
<div id="list"></div>
<div class="card" id="new">
 <div class="row"><strong class="grow">Nueva carpeta</strong><button id="toggleNew"></button></div>
 <div id="form" hidden>
  <label class="l">Qué hace</label>
  <select id="fDir"><option value="upload">Subir a Drive (computadora → Drive)</option><option value="download">Bajar de Drive (Drive → computadora)</option><option value="both">Los dos sentidos (computadora ⇄ Drive)</option></select>
  <label class="l">Nombre</label><input type="text" id="fName" placeholder="Fotos del taller">
  <label class="l">Carpeta de esta computadora</label>
  <div class="row"><input class="grow" type="text" id="fPath" placeholder="~/Documents/…"><button id="pick"></button></div>
  <label class="l"><span id="fDriveLbl">Destino en Drive</span> <span class="hint">entrá a una carpeta y elegila</span></label>
  <div class="crumbs" id="crumbs"></div>
  <div class="folders" id="folders"></div>
  <div class="row" style="margin-top:8px"><button id="mk"></button><span class="grow"></span><span id="chosen" class="path"></span></div>
  <div class="swrow"><span class="sw"><input type="checkbox" id="fMirror"><i></i></span><span>Reflejar borrados <span class="hint" id="fMirrorHint">· lo que borres acá va a la papelera de Drive</span></span></div>
  <div class="row" style="margin-top:14px"><button class="primary" id="create"></button><button id="cancel">Cancelar</button></div>
 </div>
</div>
</section>
<section id="view-logs" hidden>
 <div class="tools">
  <select id="lArea"><option value="">Todo</option><option value="drive">Sincronización Drive</option><option value="import">Importación de modelos</option></select>
  <select id="lLevel"><option value="">Todos los niveles</option><option value="warn">Avisos y errores</option><option value="error">Sólo errores</option></select>
  <input type="text" id="lSearch" placeholder="Buscar…">
  <span class="grow"></span>
  <span class="swrow" style="margin:0"><span class="sw"><input type="checkbox" id="lLive" checked><i></i></span><span>En vivo</span></span>
  <button id="lCopy"></button><button id="lRefresh"></button>
 </div>
 <div class="path" id="lInfo" style="margin:0 0 8px"></div>
 <div class="logbox" id="logbox">Cargando…</div>
</section>
</main>
<script>
var BASE = location.pathname.replace(/\/$/, '') + '/api/';
var state = { parent: '', trail: [], folders: [], chosen: null, syncs: [], prog: {} };
function $(id){ return document.getElementById(id); }
// Heroicons outline (los mismos de la app).
var ICONS = {
 folder:'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
 'folder-plus':'M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
 sync:'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
 pause:'M15.75 5.25v13.5m-7.5-13.5v13.5',
 play:'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z',
 trash:'m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0',
 check:'m4.5 12.75 6 6 9-13.5',
 warn:'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
 doc:'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
 copy:'M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75',
 inbox:'M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z',
 up:'M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z'
};
function ic(name){
  var s = document.createElementNS('http://www.w3.org/2000/svg','svg');
  s.setAttribute('viewBox','0 0 24 24'); s.setAttribute('fill','none'); s.setAttribute('stroke','currentColor');
  s.setAttribute('stroke-width','1.5'); s.setAttribute('class','ic');
  var p = document.createElementNS('http://www.w3.org/2000/svg','path');
  p.setAttribute('d', ICONS[name]); p.setAttribute('stroke-linecap','round'); p.setAttribute('stroke-linejoin','round');
  s.appendChild(p); return s;
}
function lab(b, icon, text){ b.replaceChildren(ic(icon), document.createTextNode(text)); }
// Switch estilo iOS.
function sw(checked, onchange){
  var w = el('span',{className:'sw'}); var i = el('input',{type:'checkbox',checked:checked});
  i.onchange = function(){ onchange(i.checked); };
  w.append(i, el('i')); return w;
}
function el(tag, props, kids){ var e=document.createElement(tag); Object.assign(e, props||{}); (kids||[]).forEach(function(k){ e.append(k); }); return e; }
function show(text, bad){ var m=$('msg'); m.className='msg '+(bad?'bad':'ok'); m.textContent=text; setTimeout(function(){ if(m.textContent===text){ m.textContent=''; m.className=''; } }, 6000); }
async function call(method, path, body){
  var r = await fetch(BASE + path, { method: method, headers: {'Content-Type':'application/json'}, body: body===undefined?undefined:JSON.stringify(body) });
  var data = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw new Error(data.message || ('Error ' + r.status));
  return data;
}
async function act(p){ try { var r = await p; await load(); return r; } catch(e){ show(e.message, true); } }

function pill(s){
  if(!s.enabled) return el('span',{className:'pill off',textContent:'En pausa'});
  var cls = s.status==='error' ? 'err' : s.status==='blocked' ? 'warn' : (s.status==='scanning'||s.status==='syncing') ? 'run' : '';
  return el('span',{className:'pill '+cls,textContent:s.status_label});
}
function stat(label, n, bad){ return el('span',{className:'stat'+(bad?' bad':'')},[el('b',{textContent:String(n)}),' '+label]); }
function progBox(s){
  var b = el('div',{className:'prog'}); b.dataset.id = s.id; fillProg(b, state.prog[s.id]); return b;
}
function fillProg(b, p){
  b.replaceChildren(); b.hidden = !p;
  if(!p) return;
  var pending = Math.max(p.planned - p.processed, 0);
  var pct = p.planned > 0 ? Math.min(100, Math.floor(p.processed * 100 / p.planned)) : null;
  var top = el('div',{className:'top'});
  if(pct === null){
    top.append(el('span',{textContent: p.walking ? 'Revisando la carpeta… ' + p.seen + ' archivos vistos' : 'Todo al día'}));
  } else {
    top.append(el('span',{className:'pct',textContent:pct+'%'}), el('span',{textContent:'sincronizado'}));
  }
  var bar = el('div',{className:'bar'+(pct===null?' ind':'')},[el('i',{style:pct===null?'':'width:'+pct+'%'})]);
  b.append(top, bar);
  if(pct !== null){
    var st = el('div',{className:'stats'},[ stat('procesados', p.processed + ' de ' + p.planned + (p.walking?'+':'')), stat('pendientes', pending), stat('subidos', p.uploaded) ]);
    if(p.failed > 0) st.append(stat('con error', p.failed, true));
    b.append(st);
    if(p.current) b.append(el('div',{className:'cur',textContent:'Ahora: ' + p.current}));
  }
}
async function loadProgress(){
  try {
    state.prog = await call('GET','progress');
    document.querySelectorAll('.prog[data-id]').forEach(function(b){ fillProg(b, state.prog[b.dataset.id]); });
  } catch(e){}
}
function card(s){
  var c = el('div',{className:'card'});
  var head = el('div',{className:'row'},[
    el('div',{className:'grow'},[ el('div',{className:'name',textContent:s.name}), el('div',{className:'path',textContent:(s.direction==='both' ? s.local_path+'  ⇄  '+(s.drive_path||'Drive') : s.direction==='download' ? (s.drive_path||'Drive')+'  →  '+s.local_path : s.local_path+'  →  '+(s.drive_path||'Drive'))}) ]),
    pill(s)
  ]);
  c.append(head);
  c.append(progBox(s));
  c.append(el('div',{className:'path',textContent:s.files_count+' archivos'+(s.last_error?' · ⚠ '+s.last_error:'')+(s.this_device?'':' · en '+s.device)}));
  if(s.conflicts_count>0){
    c.append(el('div',{className:'msg bad',textContent:s.conflicts_count+(s.conflicts_count===1?' archivo cambió':' archivos cambiaron')+' en la computadora y en Drive. Elegí cuál queda desde Mi perfil → Prisma Agent en la web.'}));
  }
  if(s.direction!=='download' && s.blocked_deletions>0){
    c.append(el('div',{className:'msg bad',textContent: s.direction==='both' ? s.blocked_deletions+' archivos desaparecieron de un lado. ¿Borrarlos también del otro?' : s.blocked_deletions+' archivos locales desaparecieron. ¿Mandarlos a la papelera de Drive?'}));
  }
  var r = el('div',{className:'row',style:'margin-top:12px'});
  function btn(icon,t,fn,cls){ var b=el('button',{className:cls||''}); lab(b,icon,t); b.onclick=fn; r.append(b); }
  if(s.direction!=='download' && s.blocked_deletions>0){
    btn('trash','Confirmar borrados', function(){ act(call('POST','drive-syncs/'+s.id+'/confirm-deletions',{})); }, 'danger');
    btn('check', s.direction==='both' ? 'Conservarlos' : 'Mantenerlos en Drive', function(){ act(call('POST','drive-syncs/'+s.id+'/keep-deleted',{})); });
  }
  btn('sync','Sincronizar ahora', function(){ act(call('POST','drive-syncs/'+s.id+'/scan',{}).then(function(){ show('Revisión pedida.'); })); });
  btn(s.enabled?'pause':'play', s.enabled?'Pausar':'Reanudar', function(){ act(call('PATCH','drive-syncs/'+s.id,{enabled:!s.enabled})); });
  if(s.this_device) btn('folder','Cambiar carpeta…', async function(){
    var p = await call('POST','pick-folder',{}).catch(function(){ return {}; });
    if(p.path) act(call('PATCH','drive-syncs/'+s.id,{local_path:p.path}).then(function(){ show('Carpeta cambiada.'); }));
  });
  btn('trash','Quitar', function(){ if(confirm('¿Dejar de sincronizar «'+s.name+'»? '+(s.direction==='both' ? 'Lo que hay en la computadora y en Drive queda como está.' : s.direction==='download' ? 'Lo que ya se bajó queda en la computadora.' : 'Lo que ya está en Drive no se toca.'))) act(call('DELETE','drive-syncs/'+s.id)); }, 'danger');
  c.append(el('div',{className:'swrow'},[
    sw(s.mirror_deletes, function(v){ act(call('PATCH','drive-syncs/'+s.id,{mirror_deletes:v})); }),
    el('span',{},[s.direction==='both' ? 'Propagar borrados ' : 'Reflejar borrados ', el('span',{className:'hint',textContent: s.direction==='both' ? '· lo que borres en un lado va a la papelera del otro' : s.direction==='download' ? '· lo que se borre de Drive va a la papelera de esta carpeta' : '· lo que borres acá va a la papelera de Drive'})])
  ]));
  c.append(r);
  return c;
}
async function load(){
  try {
    var d = await call('GET','drive-syncs');
    state.syncs = d.data;
    var list = $('list'); list.replaceChildren();
    if(!d.data.length) list.append(el('div',{className:'card',textContent:'Todavía no hay carpetas. Agregá la primera abajo.'}));
    d.data.forEach(function(s){ list.append(card(s)); });
  } catch(e){ show(e.message, true); }
}

async function browse(parent){
  try {
    var d = await call('GET','drive-syncs/folders'+(parent?('?parent='+encodeURIComponent(parent)):''));
    state.trail = d.trail; state.folders = d.folders; state.parent = d.trail[d.trail.length-1].id;
    state.chosen = { id: state.parent, path: d.trail.map(function(t){ return t.name; }).join(' / ') };
    var c = $('crumbs'); c.replaceChildren();
    d.trail.forEach(function(t,i){
      if(i) c.append(' / ');
      var a = el('a',{textContent:t.name}); a.onclick=function(){ browse(t.id); }; c.append(a);
    });
    var f = $('folders'); f.replaceChildren();
    if(!d.folders.length) f.append(el('div',{textContent:'Sin subcarpetas.',style:'color:#6b7280;cursor:default'}));
    d.folders.forEach(function(x){ var row = el('div',{},[ic('folder'), document.createTextNode(x.name)]); row.onclick=function(){ browse(x.id); }; f.append(row); });
    $('chosen').textContent = 'Destino: ' + state.chosen.path;
  } catch(e){ show(e.message, true); }
}

$('toggleNew').onclick = function(){ var f=$('form'); f.hidden=!f.hidden; if(!f.hidden && !state.chosen) browse(''); };
$('cancel').onclick = function(){ $('form').hidden = true; };
$('fDir').onchange = function(){
  var dir = $('fDir').value, down = dir === 'download', both = dir === 'both';
  $('fDriveLbl').textContent = down ? 'Carpeta de Drive a bajar' : both ? 'Carpeta de Drive' : 'Destino en Drive';
  $('fMirrorHint').textContent = both ? '· lo que borres en un lado va a la papelera del otro' : down ? '· lo que se borre de Drive va a la papelera de esta carpeta' : '· lo que borres acá va a la papelera de Drive';
  $('fMirror').checked = false;
};
$('pick').onclick = async function(){
  var b=$('pick'); b.disabled=true;
  try { var p = await call('POST','pick-folder',{}); if(p.path){ $('fPath').value=p.path; if(!$('fName').value) $('fName').value=p.path.split(/[\\/]/).filter(Boolean).pop()||''; } }
  catch(e){ show(e.message,true); } finally { b.disabled=false; }
};
$('mk').onclick = async function(){
  var name = prompt('Nombre de la carpeta nueva en Drive');
  if(!name) return;
  try { var f = await call('POST','drive-syncs/folders',{parent:state.parent,name:name}); await browse(f.id); }
  catch(e){ show(e.message,true); }
};
$('create').onclick = async function(){
  try {
    if(!state.chosen) throw new Error('Elegí la carpeta de Drive.');
    await call('POST','drive-syncs',{ name:$('fName').value, local_path:$('fPath').value, gdrive_folder_id:state.chosen.id, direction:$('fDir').value, mirror_deletes:$('fMirror').checked });
    show('Listo: el agente empieza a sincronizar en unos segundos.');
    $('form').hidden = true; $('fName').value=''; $('fPath').value=''; state.chosen=null;
    await load();
  } catch(e){ show(e.message,true); }
};
// --- Pestañas y logs ---
var logTimer = null, logLines = [];
function setTab(t){
  var logs = t === 'logs';
  ['slicer','folders','logs'].forEach(function(n){ $('view-'+n).hidden = n !== t; $('tab-'+n).className = n === t ? 'on' : ''; });
  if(history.replaceState) history.replaceState(null, '', t === 'folders' ? '#drive' : '#' + t);
  if(t === 'slicer') loadSlicer();
  clearInterval(logTimer);
  if(logs){ loadLog(); logTimer = setInterval(function(){ if($('lLive').checked) loadLog(); }, 3000); }
}
$('tab-slicer').onclick = function(){ setTab('slicer'); };
$('tab-folders').onclick = function(){ setTab('folders'); };
$('tab-logs').onclick = function(){ setTab('logs'); };
function isDrive(t){ return /drive[ -]sync/i.test(t); }
function renderLog(){
  var area = $('lArea').value, level = $('lLevel').value, q = $('lSearch').value.toLowerCase();
  var box = $('logbox'), atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  var out = logLines.filter(function(l){
    if(area==='drive' && !isDrive(l.raw)) return false;
    if(area==='import' && isDrive(l.raw)) return false;
    if(level==='warn' && l.level!=='WARN' && l.level!=='ERROR') return false;
    if(level==='error' && l.level!=='ERROR') return false;
    return !q || l.raw.toLowerCase().indexOf(q) !== -1;
  }).slice(-600);
  box.replaceChildren();
  if(!out.length){ box.textContent = logLines.length ? 'Nada coincide con el filtro.' : (state.logMsg || 'El log está vacío.'); return; }
  out.forEach(function(l){
    var row = el('span',{className:'ln '+l.level});
    if(l.ts){ row.append(el('span',{className:'ts',textContent:l.ts+' '}), el('span',{className:'lv',textContent:l.level.padEnd(5)+' '})); }
    row.append(document.createTextNode(l.msg)); box.append(row);
  });
  if(atEnd) box.scrollTop = box.scrollHeight;
}
async function loadLog(){
  try {
    var d = await call('GET','log');
    state.logMsg = d.message || '';
    logLines = (d.text||'').split('\n').filter(Boolean).map(function(raw){
      var m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (INFO|WARN|ERROR)\s+(.*)$/.exec(raw);
      return m ? {raw:raw, ts:m[1], level:m[2], msg:m[3]} : {raw:raw, ts:'', level:'INFO', msg:raw};
    });
    $('lInfo').textContent = d.file ? (d.file + (d.truncated ? ' · mostrando el final' : '')) : '';
    renderLog();
  } catch(e){ $('logbox').textContent = e.message; }
}
['lArea','lLevel'].forEach(function(i){ $(i).onchange = renderLog; });
$('lSearch').oninput = renderLog;
$('lRefresh').onclick = loadLog;
$('lCopy').onclick = function(){
  var t = $('logbox').innerText;
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function(){ show('Log copiado.'); }, function(){ show('No se pudo copiar.', true); });
};
// --- Importación de modelos ---
var SW = [['only_sliced','Sólo aceptar archivos sliceados'],['recursive','Incluir subcarpetas'],['notify_desktop','Mostrar el progreso y los avisos en la computadora'],['open_inbox_on_ready','Abrir «Prisma Sync» cuando un archivo esté listo']];
var sl = null;
async function loadSlicer(){
  try {
    sl = await call('GET','slicer-settings');
    $('sPath').value = sl.device_folder || sl.values.watch_folder;
    document.querySelector('input[name=sScope][value=' + (sl.device_folder ? 'device' : 'all') + ']').checked = true;
    var after = $('sAfter'); after.replaceChildren();
    Object.keys(sl.after_upload_options).forEach(function(k){
      var l = el('label',{className:'opt'}); var i = el('input',{type:'radio',name:'sAfterV',value:k,checked:sl.values.after_upload===k});
      l.append(i, document.createTextNode(sl.after_upload_options[k])); after.append(l);
    });
    var box = $('sSwitches'); box.replaceChildren();
    SW.forEach(function(p){
      var i = el('input',{type:'checkbox',id:'sw_'+p[0],checked:!!sl.values[p[0]]});
      var w = el('span',{className:'sw'}); w.append(i, el('i'));
      box.append(el('div',{className:'swrow'},[w, el('span',{textContent:p[1]})]));
    });
    $('sStable').value = sl.values.stable_ms;
  } catch(e){ show(e.message, true); }
}
$('sPick').onclick = async function(){
  var b=$('sPick'); b.disabled=true;
  try { var p = await call('POST','pick-folder',{}); if(p.path) $('sPath').value = p.path; }
  catch(e){ show(e.message,true); } finally { b.disabled=false; }
};
$('sSave').onclick = async function(){
  try {
    var body = {
      watch_folder: $('sPath').value,
      folder_scope: document.querySelector('input[name=sScope]:checked').value,
      after_upload: (document.querySelector('input[name=sAfterV]:checked')||{}).value,
      stable_ms: parseInt($('sStable').value, 10) || 0
    };
    SW.forEach(function(p){ body[p[0]] = $('sw_'+p[0]).checked; });
    await call('PUT','slicer-settings',body);
    show('Guardado. El agente toma el cambio en unos segundos.');
    await loadSlicer();
  } catch(e){ show(e.message, true); }
};
lab($('sPick'),'folder','Elegir…'); lab($('sSave'),'check','Guardar');
lab($('tab-slicer'),'inbox','Importación de modelos'); lab($('tab-folders'),'up','Sincronización Drive'); lab($('tab-logs'),'doc','Logs');
lab($('lCopy'),'copy','Copiar'); lab($('lRefresh'),'sync','Actualizar');
lab($('toggleNew'),'folder-plus','Agregar…'); lab($('pick'),'folder','Elegir…');
lab($('mk'),'folder-plus','Nueva carpeta de Drive aquí…'); lab($('create'),'up','Crear y sincronizar');
$('pPopup').onchange = function(){
  call('PUT','prefs',{drive_progress_popup:$('pPopup').checked}).catch(function(e){ show(e.message,true); });
};
async function loadPrefs(){ try { var p = await call('GET','prefs'); if(document.activeElement!==$('pPopup')) $('pPopup').checked = p.drive_progress_popup !== false; } catch(e){} }
loadPrefs(); setInterval(loadPrefs, 4000);
load(); setInterval(load, 5000); loadProgress(); setInterval(loadProgress, 1000);
setTab(location.hash === '#logs' ? 'logs' : location.hash === '#drive' ? 'folders' : 'slicer');
</script></body></html>`
    // bun build pasa lo no-ASCII de un String.raw a escapes \uXXXX y String.raw los deja literales
    // (se veía «Sincronizaci\u00F3n»): se decodifican acá. La página no usa \u a propósito.
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
