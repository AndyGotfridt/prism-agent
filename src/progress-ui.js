import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { ensureDir } from './fs-util.js';
import { warn } from './log.js';
import { APP_TITLE } from './profile.js';
import { STATE_DIR } from './state.js';
import { TRAY_ICON_ICO_BASE64 } from './tray-icon.js';

/**
 * La ventanita de Prisma Agent en el escritorio: progreso de la subida («Subiendo… 45%»,
 * «Analizando…»), avisos («Listo para revisar», errores, actualizaciones) y preguntas con
 * botones («Hay una versión nueva» → Actualizar / Más tarde). Sin dependencias: el agente
 * escribe el estado en `progress.json`, un proceso auxiliar lo lee cada 250 ms y lo dibuja, y
 * el click en un botón vuelve en `progress-response.json`.
 *
 * - Windows: PowerShell + WinForms (viene con Windows), abajo a la derecha, siempre arriba y
 *   sin robar el foco. Reemplaza al toast de WinRT, que depende de que Windows tenga
 *   habilitada la «app» de PowerShell y en varias PCs no aparecía.
 * - macOS: JavaScript for Automation (osascript + Cocoa), arriba a la derecha.
 *
 * Prioridades: un aviso se queda sus segundos aunque siga llegando progreso (el progreso
 * se guarda y se muestra al terminar el aviso); una pregunta pendiente vuelve a aparecer
 * cuando se oculta el progreso. El auxiliar se cierra solo cuando el estado lleva un minuto
 * sin cambiar (o si el agente murió) y se relanza con el próximo cambio.
 */

const STATE = join(STATE_DIR, 'progress.json');
const RESPONSE = join(STATE_DIR, 'progress-response.json');
const TRAY = join(STATE_DIR, 'tray.json');
const TRAY_ACTION = join(STATE_DIR, 'tray-action.json');
const TRAY_HEARTBEAT_MS = 15_000;
const THROTTLE_MS = 150;

let helper = null;
let lastWrite = 0;
let pendingTimer = null;
let pendingState = null;
let messageUntil = 0;
let activePrompt = null; // { id, state, resolve, poll, timeout }
let messageAction = null; // { id, poll } del aviso con botón que se está mostrando
let tray = null; // { state, onAction, heartbeat, poll }
let spawnHelper = true;
const kindClosedHandlers = new Map(); // kind → () => void, cuando cierran con la ✕ una ventanita de ese tipo
let kindPoll = null;

/**
 * Otro proceso del agente ya tiene el auxiliar abierto (ej. `prisma-agent demo` con el
 * servicio corriendo): sólo se escribe el estado, sin lanzar otro auxiliar encima.
 */
export function useRunningHelper() {
    spawnHelper = false;
}

export const progressSupported = () => platform() === 'win32' || platform() === 'darwin';

/**
 * Progreso (o cualquier estado que se reemplaza seguido). Se escribe como mucho cada 150 ms.
 * @param {{ title: string, text?: string, pct?: number|null, bar?: boolean, tone?: string, closeInMs?: number }} state
 *   `pct` null con `bar` = barra indeterminada. `closeInMs` = se oculta sola después.
 */
export function showProgress(state, { force = false } = {}) {
    if (!progressSupported()) return;

    pendingState = state;
    const wait = Math.max(THROTTLE_MS - (Date.now() - lastWrite), messageUntil - Date.now());
    if (!force && wait > 0) {
        pendingTimer ??= setTimeout(flushPending, wait);
        return;
    }
    if (force && messageUntil > Date.now()) {
        pendingTimer ??= setTimeout(flushPending, messageUntil - Date.now());
        return;
    }
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingState = null;
    write(state);
}

function flushPending() {
    pendingTimer = null;
    if (messageUntil > Date.now()) {
        pendingTimer = setTimeout(flushPending, messageUntil - Date.now());
        return;
    }
    if (pendingState) {
        const state = pendingState;
        pendingState = null;
        write(state);
    } else if (activePrompt) {
        write(activePrompt.state);
    }
}

/**
 * Aviso corto: se queda 6 s (10 s si es un error, 12 s si tiene botón, 20 s con foto) aunque
 * llegue progreso mientras tanto. `action` = botón opcional ({ label, run }): al tocarlo corre
 * `run`. `image` = ruta de un JPEG/PNG local que se muestra grande debajo del texto (la foto de
 * la cámara al terminar una impresión). Devuelve cuánto se queda (ms).
 */
export function showMessage(title, text, tone = 'info', action = null, { image = null } = {}) {
    if (!progressSupported()) return 0;

    const duration = image ? 20_000 : action ? 12_000 : tone === 'error' ? 10_000 : 6_000;
    clearTimeout(pendingTimer);
    pendingTimer = null;
    messageUntil = 0;
    stopMessageAction();

    let prompt = null;
    if (action) {
        const id = randomUUID();
        prompt = { id, actions: [{ id: 'run', label: action.label }] };
        rmSync(RESPONSE, { force: true });
        const poll = setInterval(() => {
            const res = readResponse();
            if (res?.id !== id) return;
            stopMessageAction();
            try {
                action.run();
            } catch (err) {
                warn(`Popup error: ${err.message}`);
            }
        }, 300);
        messageAction = { id, poll, until: setTimeout(stopMessageAction, duration) };
    }

    write({ title, text, bar: false, tone, closeInMs: duration, prompt, image });
    messageUntil = Date.now() + duration;
    // Al terminar: lo que haya quedado de progreso, o la pregunta pendiente.
    pendingTimer = setTimeout(flushPending, duration);

    return duration;
}

/** Oculta el progreso (si hay una pregunta pendiente, vuelve a mostrarla). */
export function hideProgress() {
    if (!progressSupported() || lastWrite === 0) return;
    pendingState = null;
    if (messageUntil > Date.now()) return; // el aviso se cierra solo y después flushPending decide
    clearTimeout(pendingTimer);
    pendingTimer = null;
    write(activePrompt ? activePrompt.state : { title: '', closeInMs: 0 });
}

/**
 * Pregunta con botones. Devuelve el `id` de la acción elegida, o null si no contestaron en
 * `timeoutMs` (o si cerraron la ventanita). Una sola pregunta a la vez.
 * @param {{ title: string, text: string, actions: {id: string, label: string}[], timeoutMs?: number }} opts
 */
export function askInPopup({ title, text, actions, timeoutMs = 10 * 60_000 }) {
    if (!progressSupported()) return Promise.resolve(null);
    if (activePrompt) finishPrompt(null);

    return new Promise((resolve) => {
        const id = randomUUID();
        rmSync(RESPONSE, { force: true });
        activePrompt = {
            id,
            resolve,
            state: { title, text, bar: false, tone: 'info', prompt: { id, actions } },
            poll: setInterval(() => {
                const res = readResponse();
                if (res?.id === id) finishPrompt(res.action ?? null);
            }, 300),
            timeout: setTimeout(() => finishPrompt(null), timeoutMs),
        };
        if (messageUntil <= Date.now()) write(activePrompt.state);
    });
}

function readResponse() {
    try {
        return JSON.parse(readFileSync(RESPONSE, 'utf8'));
    } catch {
        return null;
    }
}

function stopMessageAction() {
    if (!messageAction) return;
    clearInterval(messageAction.poll);
    clearTimeout(messageAction.until);
    messageAction = null;
}

function finishPrompt(action) {
    const prompt = activePrompt;
    if (!prompt) return;
    activePrompt = null;
    clearInterval(prompt.poll);
    clearTimeout(prompt.timeout);
    rmSync(RESPONSE, { force: true });
    if (messageUntil <= Date.now() && !pendingState) write({ title: '', closeInMs: 0 });
    prompt.resolve(action);
}

function write(state) {
    lastWrite = Date.now();
    const data = JSON.stringify({
        app: APP_TITLE,
        title: state.title,
        text: state.text ?? '',
        pct: typeof state.pct === 'number' ? Math.max(0, Math.min(100, Math.round(state.pct))) : null,
        bar: state.bar ?? true,
        tone: state.tone ?? 'progress',
        prompt: state.prompt ?? null,
        image: state.image ?? null,
        kind: state.kind ?? null,
        updated: lastWrite,
        closeAt: state.closeInMs !== undefined ? lastWrite + state.closeInMs : null,
    });

    try {
        ensureDir(STATE_DIR);
        const tmp = `${STATE}.tmp`;
        writeFileSync(tmp, data);
        try {
            renameSync(tmp, STATE);
        } catch {
            writeFileSync(STATE, data); // Windows: el auxiliar lo tenía abierto justo ahora
        }
    } catch (err) {
        warn(`Popup error: ${err.message}`);
        return;
    }

    if (state.closeInMs !== 0) ensureHelper();
    watchKindClose(state.kind && state.closeInMs !== 0);
}

/** Avisa cuando cierran con la ✕ una ventanita con `kind` (ej. 'drive'). Una sola vez por cierre. */
export function onKindClosed(kind, handler) {
    kindClosedHandlers.set(kind, handler);
}

function watchKindClose(active) {
    if (!active) {
        clearInterval(kindPoll);
        kindPoll = null;
        return;
    }
    if (kindPoll) return;
    kindPoll = setInterval(() => {
        const res = readResponse();
        if (res?.action !== 'close-kind') return;
        rmSync(RESPONSE, { force: true });
        try {
            kindClosedHandlers.get(res.kind)?.();
        } catch (err) {
            warn(`Popup error: ${err.message}`);
        }
    }, 400);
    kindPoll.unref?.();
}

// --- Ícono en la barra de menú (macOS) / bandeja (Windows) ------------------------------

/**
 * Ícono del agente con su menú. Mientras el agente corre, el auxiliar queda abierto (el agente
 * renueva `alive` cada 15 s); si el agente muere, a los 60 s se va el ícono.
 * @param {{ status: string, icon?: 'idle'|'busy'|'paused'|'error', menu: TrayItem[], default?: string, badge?: number }} state
 *   `status`: tooltip del ícono. `menu`: el menú entero, en orden. `default`: acción del doble
 *   click en Windows. `badge`: número sobre el ícono (notificaciones sin leer; 0 = sin número).
 * @param {(action: string) => void} onAction  click en un ítem del menú
 *
 * @typedef {{ label?: string, id?: string, icon?: keyof typeof TRAY_ICONS, disabled?: boolean, bold?: boolean, separator?: boolean, children?: TrayItem[] }} TrayItem
 */
export function startTray(state, onAction) {
    if (!progressSupported()) return;
    stopTray();
    tray = {
        state: { icon: 'idle', ...state },
        onAction,
        heartbeat: setInterval(writeTray, TRAY_HEARTBEAT_MS),
        poll: setInterval(() => {
            let res;
            try {
                res = JSON.parse(readFileSync(TRAY_ACTION, 'utf8'));
            } catch {
                return;
            }
            rmSync(TRAY_ACTION, { force: true });
            if (typeof res?.action === 'string') {
                try {
                    tray?.onAction(res.action);
                } catch (err) {
                    warn(`Tray error: ${err.message}`);
                }
            }
        }, 500),
    };
    rmSync(TRAY_ACTION, { force: true });
    writeTray();
}

/** Cambia estado / ícono / ítems del menú (sólo escribe si algo cambió). */
export function updateTray(partial) {
    if (!tray) return;
    const next = { ...tray.state, ...partial };
    if (JSON.stringify(next) === JSON.stringify(tray.state)) return;
    tray.state = next;
    writeTray();
}

export function stopTray() {
    if (!tray) return;
    clearInterval(tray.heartbeat);
    clearInterval(tray.poll);
    tray = null;
    rmSync(TRAY, { force: true });
}

/**
 * Íconos de los ítems del menú (`icon` de cada TrayItem). macOS: SF Symbols (macOS 11+,
 * template: se adaptan a claro/oscuro). Windows: glifo de Segoe Fluent Icons (Windows 11) o
 * Segoe MDL2 Assets (Windows 10), mismos códigos en las dos.
 */
const TRAY_ICONS = {
    login: { sf: 'person.crop.circle', glyph: 0xE77B },
    update: { sf: 'arrow.down.circle', glyph: 0xE896 },
    pause: { sf: 'pause.circle', glyph: 0xE769 },
    resume: { sf: 'play.circle', glyph: 0xE768 },
    inbox: { sf: 'tray.full', glyph: 0xE8A7 },
    notifications: { sf: 'bell', glyph: 0xEA8F },
    recent: { sf: 'clock.arrow.circlepath', glyph: 0xE81C },
    upload: { sf: 'square.and.arrow.up', glyph: 0xE898 },
    folder: { sf: 'folder', glyph: 0xE8B7 },
    cloud: { sf: 'icloud.and.arrow.up', glyph: 0xE753 },
    settings: { sf: 'gearshape', glyph: 0xE713 },
    check: { sf: 'arrow.clockwise', glyph: 0xE72C },
    log: { sf: 'doc.text', glyph: 0xE8A5 },
    quit: { sf: 'power', glyph: 0xE7E8 },
};

/** `icon` → `sf` / `glyph` para el auxiliar de cada plataforma. */
function withIcons(items = []) {
    return items.map((it) => {
        const icon = TRAY_ICONS[it.icon];
        const out = icon ? { ...it, sf: icon.sf, glyph: String.fromCharCode(icon.glyph) } : it;
        return it.children ? { ...out, children: withIcons(it.children) } : out;
    });
}

function writeTray() {
    if (!tray) return;
    try {
        ensureDir(STATE_DIR);
        // `pid`: el auxiliar sólo atiende el ícono del agente que lo lanzó (si otro agente toma
        // la posta, el auxiliar viejo se cierra en vez de dejar dos íconos).
        writeFileSync(TRAY, JSON.stringify({ app: APP_TITLE, ...tray.state, menu: withIcons(tray.state.menu), pid: process.pid, alive: Date.now() }));
    } catch (err) {
        warn(`Tray error: ${err.message}`);
        return;
    }
    ensureHelper();
}

/**
 * Deja el script del auxiliar de Windows en la carpeta de estado y devuelve su ruta. Con BOM
 * UTF-8: sin él, PowerShell 5.1 lee el archivo como ANSI y rompe los acentos y los «…».
 */
function windowsHelperScript() {
    const file = join(STATE_DIR, 'tray-helper.ps1');
    const content = '\uFEFF' + WINDOWS_SCRIPT;
    try {
        if (readFileSync(file, 'utf8') === content) return file;
    } catch {
        // no existe todavía
    }
    ensureDir(STATE_DIR);
    writeFileSync(file, content, 'utf8');
    return file;
}

function ensureHelper() {
    if (!spawnHelper) return;
    if (helper && helper.exitCode === null && !helper.killed) return;

    try {
        const env = { ...process.env, PA_STATE: STATE, PA_RESPONSE: RESPONSE, PA_TRAY: TRAY, PA_TRAY_ACTION: TRAY_ACTION, PA_ICON: TRAY_ICON_ICO_BASE64, PA_OWNER: String(process.pid) };
        if (platform() === 'win32') {
            // Por archivo y no con -EncodedCommand: el script en base64 pasa de los 32.767
            // caracteres que admite la línea de comandos de Windows (CreateProcess falla y no
            // aparecen ni la ventanita ni el ícono de la bandeja).
            helper = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
                '-File', windowsHelperScript(),
            ], { env, stdio: 'ignore', windowsHide: false });
        } else {
            helper = spawn('osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT], { env, stdio: 'ignore' });
        }
        helper.on('exit', () => { helper = null; });
        helper.on('error', (err) => {
            helper = null;
            warn(`Popup error: ${err.message}`);
        });
    } catch (err) {
        helper = null;
        warn(`Popup error: ${err.message}`);
    }
}

// Ventana sin bordes, siempre arriba, sin foco (WS_EX_NOACTIVATE) y fuera de la barra de
// tareas (WS_EX_TOOLWINDOW). C# 5 (el compilador de .NET Framework que usa Add-Type).
const WINDOWS_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System.Windows.Forms;
public class PrismaPopup : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008; return cp; }
    }
}
'@
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrismaNative {
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()

$path = $env:PA_STATE
$resp = $env:PA_RESPONSE
$W = 360; $H = 104
$f = New-Object PrismaPopup
$f.FormBorderStyle = 'None'; $f.ShowInTaskbar = $false; $f.TopMost = $true; $f.StartPosition = 'Manual'
$f.Size = New-Object Drawing.Size($W, $H); $f.BackColor = [Drawing.Color]::White
$wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f.Location = New-Object Drawing.Point(($wa.Right - $W - 16), ($wa.Bottom - $H - 16))
$f.Add_Paint({ $_.Graphics.DrawRectangle((New-Object Drawing.Pen([Drawing.Color]::FromArgb(209, 213, 219))), 0, 0, $f.Width - 1, $f.Height - 1) })

$app = New-Object Windows.Forms.Label
$app.Font = New-Object Drawing.Font('Segoe UI', 8); $app.ForeColor = [Drawing.Color]::FromArgb(107, 114, 128)
$app.Location = New-Object Drawing.Point(14, 10); $app.Size = New-Object Drawing.Size(($W - 48), 16)

$title = New-Object Windows.Forms.Label
$title.Font = New-Object Drawing.Font('Segoe UI Semibold', 10); $title.AutoEllipsis = $true
$title.Location = New-Object Drawing.Point(14, 27); $title.Size = New-Object Drawing.Size(($W - 28), 20)

$text = New-Object Windows.Forms.Label
$text.Font = New-Object Drawing.Font('Segoe UI', 9); $text.ForeColor = [Drawing.Color]::FromArgb(75, 85, 99); $text.AutoEllipsis = $true
$text.Location = New-Object Drawing.Point(14, 48); $text.Size = New-Object Drawing.Size(($W - 28), 18)

$bar = New-Object Windows.Forms.ProgressBar
$bar.Location = New-Object Drawing.Point(14, 78); $bar.Size = New-Object Drawing.Size(($W - 28), 10); $bar.Minimum = 0; $bar.Maximum = 100

# ✕ para cerrarla antes de tiempo (en una pregunta cuenta como «Más tarde»).
$close = New-Object Windows.Forms.Label
$close.Text = [string][char]0x2715; $close.Font = New-Object Drawing.Font('Segoe UI', 9)
$close.ForeColor = [Drawing.Color]::FromArgb(156, 163, 175); $close.TextAlign = 'MiddleCenter'; $close.Cursor = [Windows.Forms.Cursors]::Hand
$close.Location = New-Object Drawing.Point(($W - 30), 6); $close.Size = New-Object Drawing.Size(22, 22)
$close.Add_MouseEnter({ $close.ForeColor = [Drawing.Color]::FromArgb(55, 65, 81) })
$close.Add_MouseLeave({ $close.ForeColor = [Drawing.Color]::FromArgb(156, 163, 175) })

# Photo under the text (camera snapshot when a print finishes). The form grows by $script:extra
# and the bar/buttons move down. ASCII only in this script: bun --minify escapes the rest.
$IMG_H = 180; $IMG_GAP = 10
$pic = New-Object Windows.Forms.PictureBox
$pic.Location = New-Object Drawing.Point(14, 72); $pic.Size = New-Object Drawing.Size(($W - 28), $IMG_H)
$pic.SizeMode = 'Zoom'; $pic.BackColor = [Drawing.Color]::FromArgb(243, 244, 246); $pic.Visible = $false
$script:imgPath = $null
$script:extra = 0

$f.Controls.AddRange(@($close, $app, $title, $text, $bar, $pic))

# Click = ocultar hasta el próximo cambio de estado (con una pregunta, sólo los botones).
$script:dismissed = 0
$script:shownAt = 0
$script:kind = $null
$script:promptId = $null
$script:btns = @()
$script:closable = $true
$hide = { if ($script:closable) { $script:dismissed = $script:shownAt; $f.Hide() } }
$f.Add_Click($hide); $app.Add_Click($hide); $title.Add_Click($hide); $text.Add_Click($hide); $bar.Add_Click($hide); $pic.Add_Click($hide)
$close.Add_Click({
    if ($script:promptId -and -not $script:closable) {
        [IO.File]::WriteAllText($resp, (@{ id = $script:promptId; action = 'dismiss' } | ConvertTo-Json -Compress))
    } elseif ($script:kind -and -not $script:promptId) {
        # Una ventanita de un tipo (ej. el progreso de Drive): cerrarla con la X es un «no la quiero».
        [IO.File]::WriteAllText($resp, (@{ id = [guid]::NewGuid().ToString(); action = 'close-kind'; kind = [string]$script:kind } | ConvertTo-Json -Compress))
    }
    $script:dismissed = $script:shownAt
    $f.Hide()
})

function Set-Buttons($s) {
    $id = if ($s.prompt) { $s.prompt.id } else { $null }
    if ($id -eq $script:promptId) { return }
    foreach ($b in $script:btns) { $f.Controls.Remove($b); $b.Dispose() }
    $script:btns = @()
    $script:promptId = $id
    if (-not $id) { return }
    $x = $W - 14
    foreach ($a in @($s.prompt.actions)) {
        $b = New-Object Windows.Forms.Button
        $b.Text = $a.label; $b.Tag = $a.id; $b.FlatStyle = 'System'
        $b.Font = New-Object Drawing.Font('Segoe UI', 9)
        $w = [Math]::Max(96, $b.GetPreferredSize([Drawing.Size]::Empty).Width + 16)
        $x -= $w
        $b.Size = New-Object Drawing.Size($w, 28); $b.Location = New-Object Drawing.Point($x, (70 + $script:extra))
        $x -= 8
        $b.Add_Click({
            param($sender)
            [IO.File]::WriteAllText($resp, (@{ id = $script:promptId; action = [string]$sender.Tag } | ConvertTo-Json -Compress))
            $script:dismissed = $script:shownAt
            $f.Hide()
        })
        $f.Controls.Add($b)
        $script:btns += $b
    }
}

function Set-Image($p) {
    if ($p -eq $script:imgPath) { return }
    $script:imgPath = $p
    if ($pic.Image) { $old = $pic.Image; $pic.Image = $null; $old.Dispose() }
    $img = $null
    if ($p -and (Test-Path $p)) {
        # Copy to a Bitmap and close the stream: FromFile would keep the file locked.
        try {
            $ms = New-Object IO.MemoryStream(, [IO.File]::ReadAllBytes($p))
            $tmp = [Drawing.Image]::FromStream($ms)
            $img = New-Object Drawing.Bitmap($tmp)
            $tmp.Dispose(); $ms.Dispose()
        } catch { $img = $null }
    }
    $pic.Image = $img; $pic.Visible = [bool]$img
    $script:extra = if ($img) { $IMG_H + $IMG_GAP } else { 0 }
    $h = $H + $script:extra
    $f.Size = New-Object Drawing.Size($W, $h)
    $f.Location = New-Object Drawing.Point(($wa.Right - $W - 16), ($wa.Bottom - $h - 16))
    $bar.Top = 78 + $script:extra
    foreach ($b in $script:btns) { $b.Top = 70 + $script:extra }
    $f.Invalidate()
}

# --- Ícono en la bandeja (el de Prisma; con un punto de color si sube o hay un problema) ---
$trayPath = $env:PA_TRAY
$trayActionPath = $env:PA_TRAY_ACTION
$baseIcon = New-Object Drawing.Icon((New-Object IO.MemoryStream(, [Convert]::FromBase64String($env:PA_ICON))), 16, 16)
$ni = New-Object Windows.Forms.NotifyIcon
$ni.Icon = $baseIcon
$menu = New-Object Windows.Forms.ContextMenuStrip
$ni.ContextMenuStrip = $menu
$script:trayKey = ''
$script:trayIconState = ''
$script:spin = 0
$script:iconCache = @{} # un ícono por estado/número/cuadro: GetHicon no se libera, no regenerarlos
$script:trayFirst = $null

function Send-TrayAction($action) {
    [IO.File]::WriteAllText($trayActionPath, (@{ id = [guid]::NewGuid().ToString(); action = [string]$action } | ConvertTo-Json -Compress))
}
$ni.Add_MouseDoubleClick({ if ($script:trayFirst) { Send-TrayAction $script:trayFirst } })

function New-Brush($r, $g, $b) { return New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb($r, $g, $b)) }

# El ícono se dibuja entero en vectores (espacio de 32x32, como public/favicon.svg) al tamaño que
# pide la bandeja. Antes se partía de $baseIcon.ToBitmap(): con el ICO de entradas PNG sale ruido
# (puntitos de colores) y encima se pintaba en 16 px fijos aunque la pantalla pida más.
function Get-TrayIcon($state, $badge, $frame) {
    $size = [Windows.Forms.SystemInformation]::SmallIconSize.Width
    if ($size -lt 16) { $size = 16 }
    $bmp = New-Object Drawing.Bitmap($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([Drawing.Color]::Transparent)
    $g.ScaleTransform($size / 32.0, $size / 32.0)

    # Fondo índigo redondeado + cubo blanco (el favicon).
    $gp = New-Object Drawing.Drawing2D.GraphicsPath
    $gp.AddArc(0, 0, 14, 14, 180, 90); $gp.AddArc(18, 0, 14, 14, 270, 90)
    $gp.AddArc(18, 18, 14, 14, 0, 90); $gp.AddArc(0, 18, 14, 14, 90, 90)
    $gp.CloseFigure()
    $g.FillPath((New-Brush 79 70 229), $gp)
    $pen = New-Object Drawing.Pen([Drawing.Color]::White, 1.8)
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    $cube = [Drawing.PointF[]]@(
        (New-Object Drawing.PointF(25, 10.5)), (New-Object Drawing.PointF(16, 6)), (New-Object Drawing.PointF(7, 10.5)),
        (New-Object Drawing.PointF(7, 21.5)), (New-Object Drawing.PointF(16, 26)), (New-Object Drawing.PointF(25, 21.5)))
    $g.DrawPolygon($pen, $cube)
    $g.DrawLines($pen, [Drawing.PointF[]]@((New-Object Drawing.PointF(7, 10.5)), (New-Object Drawing.PointF(16, 15)), (New-Object Drawing.PointF(25, 10.5))))
    $g.DrawLine($pen, 16, 15, 16, 26)

    if ($state -eq 'paused') {
        # Pausa: disco ámbar con dos barras blancas, abajo a la derecha.
        $g.FillEllipse((New-Brush 255 255 255), 13, 13, 19, 19)
        $g.FillEllipse((New-Brush 245 158 11), 14.5, 14.5, 16, 16)
        $g.FillRectangle((New-Brush 255 255 255), 18.5, 18.5, 3, 8)
        $g.FillRectangle((New-Brush 255 255 255), 23.5, 18.5, 3, 8)
    } elseif ($state -eq 'busy') {
        # Subiendo: disco blanco con un arco verde que gira (un cuadro por cada 250 ms).
        $g.FillEllipse((New-Brush 255 255 255), 13, 13, 19, 19)
        $arc = New-Object Drawing.Pen([Drawing.Color]::FromArgb(22, 163, 74), 3.2)
        $arc.StartCap = 'Round'; $arc.EndCap = 'Round'
        $g.DrawArc($arc, 17, 17, 11, 11, ($frame * 45), 250)
    } elseif ($state -eq 'error') {
        $g.FillEllipse((New-Brush 255 255 255), 13, 13, 19, 19)
        $g.FillEllipse((New-Brush 220 38 38), 14.5, 14.5, 16, 16)
        $g.FillRectangle((New-Brush 255 255 255), 21, 18, 3, 6.5)
        $g.FillEllipse((New-Brush 255 255 255), 20.8, 25, 3.4, 3.4)
    }
    if ($badge -gt 0) {
        # Notificaciones sin leer: círculo rojo con el número arriba a la derecha.
        $txt = if ($badge -gt 9) { '9+' } else { [string]$badge }
        $g.FillEllipse((New-Brush 255 255 255), 15, -1, 18, 18)
        $g.FillEllipse((New-Brush 220 38 38), 16, 0, 16, 16)
        $font = New-Object Drawing.Font('Segoe UI', $(if ($txt.Length -gt 1) { 8 } else { 10 }), [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
        $sf = New-Object Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
        $g.DrawString($txt, $font, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF(16, 0, 16, 16)), $sf)
    }
    $g.Dispose()
    $hicon = $bmp.GetHicon()
    $icon = [Drawing.Icon]::FromHandle($hicon).Clone()
    [PrismaNative]::DestroyIcon($hicon) | Out-Null
    $bmp.Dispose()
    return $icon
}

# Íconos de los ítems: un glifo de la fuente de íconos de Windows dibujado en 16x16.
$script:glyphFont = $null
$families = (New-Object Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
foreach ($name in @('Segoe Fluent Icons', 'Segoe MDL2 Assets')) {
    if ($families -contains $name) { $script:glyphFont = New-Object Drawing.Font($name, 9, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Point); break }
}
$script:glyphCache = @{}
function Get-MenuGlyph([string]$ch) {
    if (-not $script:glyphFont -or -not $ch) { return $null }
    if (-not $script:glyphCache.ContainsKey($ch)) {
        $bmp = New-Object Drawing.Bitmap(16, 16)
        $g = [Drawing.Graphics]::FromImage($bmp)
        $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $sf = New-Object Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
        $g.DrawString($ch, $script:glyphFont, (New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(55, 65, 81))), (New-Object Drawing.RectangleF(0, 0, 16, 16)), $sf)
        $g.Dispose()
        $script:glyphCache[$ch] = $bmp
    }
    return $script:glyphCache[$ch]
}

function Add-TrayItems($coll, $items) {
    foreach ($it in @($items)) {
        if ($it.separator) { [void]$coll.Add((New-Object Windows.Forms.ToolStripSeparator)); continue }
        $mi = New-Object Windows.Forms.ToolStripMenuItem([string]$it.label)
        if ($it.glyph) { $img = Get-MenuGlyph ([string]$it.glyph); if ($img) { $mi.Image = $img } }
        if ($it.bold) { $mi.Font = New-Object Drawing.Font($mi.Font, [Drawing.FontStyle]::Bold) }
        if ($it.children) { Add-TrayItems $mi.DropDownItems $it.children }
        elseif ($it.id) {
            $mi.Tag = [string]$it.id
            $mi.Add_Click({ param($sender) Send-TrayAction $sender.Tag })
        }
        if ($it.disabled) { $mi.Enabled = $false }
        [void]$coll.Add($mi)
    }
}

function Update-Tray($t, $alive) {
    if (-not $alive) { $ni.Visible = $false; return }
    # [char] y no el punto medio ni los tres puntos escritos: bun build --minify pasa lo no-ASCII
    # de un String.raw a escapes u+XXXX y PowerShell los mostraba tal cual en el tooltip.
    $tip = "$($t.app) $([char]0x00B7) $($t.status)"
    $ni.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 62) + [char]0x2026 } else { $tip }
    $state = if ($t.icon) { [string]$t.icon } else { 'idle' }
    $badge = if ($t.badge) { [int]$t.badge } else { 0 }
    if ($state -eq 'busy') { $script:spin = ($script:spin + 1) % 8 } else { $script:spin = 0 }
    $iconKey = "$state|$badge|$($script:spin)"
    if ($iconKey -ne $script:trayIconState) {
        if (-not $script:iconCache.ContainsKey($iconKey)) { $script:iconCache[$iconKey] = Get-TrayIcon $state $badge $script:spin }
        $ni.Icon = $script:iconCache[$iconKey]
        $script:trayIconState = $iconKey
    }
    $script:trayFirst = $t.default
    $key = $t.menu | ConvertTo-Json -Compress -Depth 8
    if ($key -ne $script:trayKey) {
        $script:trayKey = $key
        $menu.Items.Clear()
        Add-TrayItems $menu.Items $t.menu
    }
    $ni.Visible = $true
}

function Close-All { $timer.Stop(); $ni.Visible = $false; $ni.Dispose(); $f.Close(); $ctx.ExitThread() }

$ctx = New-Object Windows.Forms.ApplicationContext
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    $t = $null
    if (Test-Path $trayPath) { try { $t = [IO.File]::ReadAllText($trayPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $t = $null } }
    $fresh = $t -and ($now - $t.alive) -lt 60000
    # Otro agente (ej. el reiniciado tras actualizar) tiene su propio auxiliar: éste sobra.
    if ($fresh -and [int]$t.pid -ne [int]$env:PA_OWNER) { Close-All; return }
    $trayAlive = $fresh
    # Un error armando el menú no puede tirar abajo el auxiliar (se iría el ícono y la ventanita).
    try { Update-Tray $t $trayAlive } catch { }

    $s = $null
    if (Test-Path $path) { try { $s = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { return } }
    # Sin cambios en un minuto (salvo una pregunta abierta) y sin ícono vivo: el agente terminó o murió.
    $idle = (-not $s) -or ((-not $s.prompt -or $s.closeAt -ne $null) -and ($now - $s.updated) -gt 60000)
    if ($idle -and -not $trayAlive) { Close-All; return }
    if ($idle) { if ($f.Visible) { $f.Hide() }; return }
    $closed = ($s.closeAt -ne $null) -and ($now -ge $s.closeAt)
    if ($closed -or $s.updated -le $script:dismissed) { if ($f.Visible) { $f.Hide() }; return }

    $script:shownAt = $s.updated
    $script:kind = $s.kind
    # Una pregunta sólo se cierra con sus botones; un aviso con botón, también con un click.
    $script:closable = (-not $s.prompt) -or ($s.closeAt -ne $null)
    $app.Text = $s.app
    $title.Text = $s.title
    $text.Text = $s.text
    $title.ForeColor = switch ($s.tone) { 'error' { [Drawing.Color]::FromArgb(185, 28, 28) } 'success' { [Drawing.Color]::FromArgb(4, 120, 87) } default { [Drawing.Color]::FromArgb(17, 24, 39) } }
    Set-Image $s.image
    Set-Buttons $s
    $bar.Visible = [bool]$s.bar -and -not $s.prompt
    if ($bar.Visible) {
        if ($s.pct -eq $null) { $bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 30 }
        else {
            if ($bar.Style -ne 'Continuous') { $bar.MarqueeAnimationSpeed = 0; $bar.Style = 'Continuous' }
            # Windows anima cada subida de valor y la barra queda atrás, a los saltos. Bajar
            # se dibuja al instante: se pasa uno de largo y se vuelve.
            $v = [int]$s.pct
            if ($v -lt 100) { $bar.Value = $v + 1; $bar.Value = $v }
            else { $bar.Value = 100; $bar.Value = 99; $bar.Value = 100 }
        }
    }
    if (-not $f.Visible) { $f.Show() }
})
$timer.Start()
[Windows.Forms.Application]::Run($ctx)
`;

// Panel flotante sin activar la app, en todos los Escritorios. El timer y los botones usan
// un objeto propio como target (JXA no pasa bloques a NSTimer de forma confiable).
const MAC_SCRIPT = String.raw`
ObjC.import('Cocoa');
const env = $.NSProcessInfo.processInfo.environment;
const path = env.objectForKey('PA_STATE').js;
const resp = env.objectForKey('PA_RESPONSE').js;
const trayPath = env.objectForKey('PA_TRAY').js;
const trayActionPath = env.objectForKey('PA_TRAY_ACTION').js;
const owner = env.objectForKey('PA_OWNER').js;
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

const W = 340, H = 100, M = 14;
// Con foto (la de la cámara al terminar una impresión) el panel crece IMG_H + IMG_GAP hacia abajo.
const IMG_H = 180, IMG_GAP = 10;
let curH = H;
// Siempre en la pantalla de la barra de menú (la primera de NSScreen.screens), no en la que
// tiene la ventana activa (mainScreen): con varios monitores, el aviso queda en un lugar fijo.
function menuBarRect() {
    const vf = $.NSScreen.screens.objectAtIndex(0).visibleFrame;
    return $.NSMakeRect(vf.origin.x + vf.size.width - W - 16, vf.origin.y + vf.size.height - curH - 12, W, curH);
}
const rect = menuBarRect();
const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(rect, $.NSWindowStyleMaskBorderless | $.NSWindowStyleMaskNonactivatingPanel, $.NSBackingStoreBuffered, false);
panel.level = $.NSStatusWindowLevel;
panel.opaque = false;
panel.backgroundColor = $.NSColor.clearColor;
panel.hasShadow = true;
panel.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary;

const bg = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
bg.material = $.NSVisualEffectMaterialPopover;
bg.state = $.NSVisualEffectStateActive;
bg.wantsLayer = true;
bg.layer.cornerRadius = 12;
bg.layer.masksToBounds = true;
panel.contentView = bg;

function label(y, h, font, color) {
    const l = $.NSTextField.labelWithString($(''));
    l.frame = $.NSMakeRect(M, y, W - 2 * M, h);
    l.font = font;
    l.textColor = color;
    l.lineBreakMode = $.NSLineBreakByTruncatingMiddle;
    bg.addSubview(l);
    return l;
}
const appL = label(H - 24, 14, $.NSFont.systemFontOfSize(11), $.NSColor.secondaryLabelColor);
appL.frame = $.NSMakeRect(M, H - 24, W - 2 * M - 22, 14); // lugar para la ✕
const titleL = label(H - 44, 18, $.NSFont.boldSystemFontOfSize(13), $.NSColor.labelColor);
const textL = label(H - 62, 16, $.NSFont.systemFontOfSize(12), $.NSColor.secondaryLabelColor);
// Una barra nueva cada vez que cambia entre porcentaje e indeterminada: si se reusa la misma,
// AppKit (desde JXA) sigue animando la indeterminada aunque ya tenga porcentaje.
let bar = null;
function makeBar(indet) {
    if (bar) bar.removeFromSuperview;
    bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(M, 12, W - 2 * M, 12));
    bar.style = $.NSProgressIndicatorStyleBar;
    bar.minValue = 0;
    bar.maxValue = 100;
    bar.indeterminate = indet;
    bg.addSubview(bar);
    if (indet) bar.startAnimation(null);
}

let visible = false;
let indeterminate = null;
let prompt = null;
let dismissed = 0;
let shownAt = 0;
let kind = null;

function hide() {
    if (visible) { panel.orderOut(null); visible = false; }
}

ObjC.registerSubclass({
    name: 'PrismaPopupTicker',
    methods: {
        'tick:': { types: ['void', ['id']], implementation: function () { tick(); } },
        // ✕: cerrarla antes de tiempo (en una pregunta cuenta como «Más tarde»).
        'closeClicked:': {
            types: ['void', ['id']],
            implementation: function () {
                if (prompt && currentCloseAt === null) {
                    $(JSON.stringify({ id: prompt.id, action: 'dismiss' })).writeToFileAtomicallyEncodingError(resp, true, $.NSUTF8StringEncoding, null);
                } else if (kind && !prompt) {
                    // Una ventanita de un tipo (ej. el progreso de Drive): cerrarla con la X es un «no la quiero».
                    $(JSON.stringify({ id: String(Date.now()) + Math.random(), action: 'close-kind', kind: kind })).writeToFileAtomicallyEncodingError(resp, true, $.NSUTF8StringEncoding, null);
                }
                dismissed = shownAt;
                hide();
            },
        },
        'trayClicked:': {
            types: ['void', ['id']],
            implementation: function (sender) {
                const id = trayActions[sender.tag];
                if (id) sendTrayAction(id);
            },
        },
        'clicked:': {
            types: ['void', ['id']],
            implementation: function (sender) {
                const action = prompt && prompt.actions[sender.tag];
                if (!action) return;
                $(JSON.stringify({ id: prompt.id, action: action.id })).writeToFileAtomicallyEncodingError(resp, true, $.NSUTF8StringEncoding, null);
                dismissed = shownAt;
                hide();
            },
        },
    },
});
const ticker = $.PrismaPopupTicker.alloc.init;

// Dos botones a la derecha: [1] [0] (la primera acción es la principal).
const closeBtn = $.NSButton.alloc.initWithFrame($.NSMakeRect(W - 30, H - 28, 22, 22));
closeBtn.bordered = false;
closeBtn.title = $('✕');
closeBtn.font = $.NSFont.systemFontOfSize(12);
closeBtn.contentTintColor = $.NSColor.secondaryLabelColor;
closeBtn.target = ticker;
closeBtn.action = 'closeClicked:';
bg.addSubview(closeBtn);
let currentCloseAt = null;

const imgV = $.NSImageView.alloc.initWithFrame($.NSMakeRect(M, 44, W - 2 * M, IMG_H));
imgV.imageScaling = $.NSImageScaleProportionallyUpOrDown;
imgV.wantsLayer = true;
imgV.layer.cornerRadius = 8;
imgV.layer.masksToBounds = true;
imgV.hidden = true;
bg.addSubview(imgV);
let imgPath = null;

// Foto debajo del texto: el panel crece y lo de arriba (app, título, texto, ✕) sube; la barra
// y los botones quedan abajo, donde estaban.
function setImage(p) {
    if (p === imgPath) return;
    imgPath = p;
    let img = null;
    if (p) {
        const i = $.NSImage.alloc.initWithContentsOfFile($(p));
        if (i && !i.isNil()) img = i;
    }
    imgV.image = img || $();
    imgV.hidden = !img;
    curH = H + (img ? IMG_H + IMG_GAP : 0);
    bg.frame = $.NSMakeRect(0, 0, W, curH);
    appL.frame = $.NSMakeRect(M, curH - 24, W - 2 * M - 22, 14);
    titleL.frame = $.NSMakeRect(M, curH - 44, W - 2 * M, 18);
    textL.frame = $.NSMakeRect(M, curH - 62, W - 2 * M, 16);
    closeBtn.frame = $.NSMakeRect(W - 30, curH - 28, 22, 22);
    if (visible) panel.setFrameDisplay(menuBarRect(), true);
}

const btns = [0, 1].map((i) => {
    const b = $.NSButton.alloc.initWithFrame($.NSMakeRect(W - M - 100 * (i + 1) - 8 * i, 6, 100, 30));
    b.bezelStyle = $.NSBezelStyleRounded;
    b.tag = i;
    b.target = ticker;
    b.action = 'clicked:';
    b.hidden = true;
    bg.addSubview(b);
    return b;
});

// --- Ícono en la barra de menú: el cubo del logo de Prisma, como imagen «template» (se
// adapta a claro/oscuro), con un punto si está subiendo o hay un problema. ---
let statusItem = null;
let trayKey = '';
let trayIconState = '';
let trayBadge = null;
let spin = 0;
let trayActions = []; // tag del NSMenuItem → id de la acción

function sendTrayAction(action) {
    $(JSON.stringify({ id: String(Date.now()) + Math.random(), action })).writeToFileAtomicallyEncodingError(trayActionPath, true, $.NSUTF8StringEncoding, null);
}

const iconCache = {}; // un NSImage por estado/cuadro

function cubeImage(state, frame) {
    const cacheKey = state + '|' + frame;
    if (iconCache[cacheKey]) return iconCache[cacheKey];
    const S = 18;
    const img = $.NSImage.alloc.initWithSize($.NSMakeSize(S, S));
    img.lockFocus;
    // Mismo dibujo que public/favicon.svg (viewBox 32, el cubo ocupa ~6..26): escalado a 18 pt.
    const k = S / 22, ox = 5, oy = 5;
    const pt = (x, y) => $.NSMakePoint((x - ox) * k, S - (y - oy) * k);
    const path = $.NSBezierPath.bezierPath;
    path.lineWidth = 1.5;
    path.lineJoinStyle = $.NSLineJoinStyleRound;
    path.lineCapStyle = $.NSLineCapStyleRound;
    const poly = (pts, close) => {
        path.moveToPoint(pt(pts[0][0], pts[0][1]));
        pts.slice(1).forEach((p) => path.lineToPoint(pt(p[0], p[1])));
        if (close) path.closePath;
    };
    poly([[25, 10.5], [16, 6], [7, 10.5], [7, 21.5], [16, 26], [25, 21.5]], true);
    poly([[7, 10.5], [16, 15], [25, 10.5]], false);
    poly([[16, 15], [16, 26]], false);
    $.NSColor.blackColor.setStroke;
    path.stroke;
    if (state !== 'idle') {
        // Se borra la esquina antes de dibujar la marca, para que no se pise con las líneas del cubo.
        $.NSGraphicsContext.currentContext.compositingOperation = $.NSCompositingOperationClear;
        $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(S - 9, -1, 10, 10)).fill;
        $.NSGraphicsContext.currentContext.compositingOperation = $.NSCompositingOperationSourceOver;
        $.NSColor.blackColor.setFill;
        if (state === 'paused') {
            // Pausa: dos barras.
            $.NSBezierPath.fillRect($.NSMakeRect(S - 7, 0.5, 2.4, 7));
            $.NSBezierPath.fillRect($.NSMakeRect(S - 3, 0.5, 2.4, 7));
        } else if (state === 'busy') {
            // Subiendo: un arco que gira (un cuadro por tick de 250 ms).
            $.NSColor.blackColor.setStroke;
            const arc = $.NSBezierPath.bezierPath;
            arc.lineWidth = 1.6;
            arc.lineCapStyle = $.NSLineCapStyleRound;
            arc.appendBezierPathWithArcWithCenterRadiusStartAngleEndAngle($.NSMakePoint(S - 3.5, 3.5), 2.8, -frame * 45, -frame * 45 + 270);
            arc.stroke;
        } else {
            $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(S - 7, 0, 7, 7)).fill;
        }
    }
    img.unlockFocus;
    img.template = true;
    iconCache[cacheKey] = img;
    return img;
}

function updateTray(t, alive) {
    if (!alive) {
        if (statusItem) {
            $.NSStatusBar.systemStatusBar.removeStatusItem(statusItem);
            statusItem = null;
            trayKey = '';
            trayIconState = '';
            trayBadge = null;
        }
        return;
    }
    if (!statusItem) statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
    const state = t.icon || 'idle';
    spin = state === 'busy' ? (spin + 1) % 8 : 0;
    const iconKey = state + '|' + spin;
    if (iconKey !== trayIconState) {
        statusItem.button.image = cubeImage(state, spin);
        statusItem.button.imagePosition = $.NSImageLeft;
        trayIconState = iconKey;
    }
    // Notificaciones sin leer: el número al lado del cubo (como hacen otras apps de la barra).
    const badge = t.badge > 0 ? (t.badge > 99 ? '99+' : String(t.badge)) : '';
    if (badge !== trayBadge) {
        statusItem.button.title = $(badge ? ' ' + badge : '');
        trayBadge = badge;
    }
    statusItem.button.toolTip = $(t.app + ' · ' + t.status);
    const key = JSON.stringify(t.menu);
    if (key === trayKey) return;
    trayKey = key;
    trayActions = [];
    const menu = $.NSMenu.alloc.init;
    menu.autoenablesItems = false;
    addTrayItems(menu, t.menu || []);
    statusItem.menu = menu;
}

/**
 * SF Symbol (macOS 11+) para un ítem del menú. La imagen del símbolo tal cual no se dibuja en
 * el menú de un ícono de la barra (probado: el ítem queda sin ícono), así que se pasa a un
 * bitmap y se marca template: así sí, y se adapta a claro/oscuro y a los ítems grisados.
 * null si el sistema no tiene el símbolo (o el método, en un macOS más viejo).
 */
const menuIcons = {};
function menuIcon(name) {
    if (name in menuIcons) return menuIcons[name];
    let img = null;
    try {
        // $() = nil: un null de JS llega como NSNull y Cocoa tira excepción.
        const sym = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription($(name), $());
        if (sym && !sym.isNil()) {
            const size = sym.size;
            const rect = $.NSMakeRect(0, 0, size.width, size.height);
            img = $.NSImage.alloc.initWithSize(size);
            img.lockFocus;
            sym.drawInRectFromRectOperationFraction(rect, $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
            $.NSColor.blackColor.set;
            $.NSRectFillUsingOperation(rect, $.NSCompositingOperationSourceAtop);
            img.unlockFocus;
            img.template = true;
        }
    } catch (e) {
        img = null;
    }
    menuIcons[name] = img;
    return img;
}

function addTrayItems(menu, items) {
    items.forEach((it) => {
        if (it.separator) {
            menu.addItem($.NSMenuItem.separatorItem);
            return;
        }
        const actionable = it.id && !it.children;
        const mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($(it.label), actionable ? 'trayClicked:' : null, $(''));
        if (it.children) {
            const sub = $.NSMenu.alloc.init;
            sub.autoenablesItems = false;
            addTrayItems(sub, it.children);
            mi.submenu = sub;
        } else if (actionable) {
            mi.target = ticker;
            mi.tag = trayActions.length;
            trayActions.push(it.id);
        }
        if (it.sf) {
            const img = menuIcon(it.sf);
            if (img) mi.image = img;
        }
        // «bold» no se aplica en macOS: NSAttributedString no está expuesto en JXA (probado).
        if (it.disabled) mi.enabled = false;
        menu.addItem(mi);
    });
}

function readJson(file) {
    const raw = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
    return raw && !raw.isNil() ? JSON.parse(raw.js) : null;
}

function tick() {
    const now = Date.now();
    let t = null;
    try { t = readJson(trayPath); } catch (e) { t = null; }
    const fresh = !!t && now - t.alive < 60000;
    // Otro agente (ej. el reiniciado tras actualizar) tiene su propio auxiliar: éste sobra.
    if (fresh && String(t.pid) !== owner) {
        app.terminate(null);
        return;
    }
    const trayAlive = fresh;
    // Un error armando el menú no puede tirar abajo el auxiliar (se iría el ícono y la ventanita).
    try {
        updateTray(t, trayAlive);
    } catch (e) {
        console.log('Tray error: ' + e);
    }

    let s = null;
    try {
        s = readJson(path);
    } catch (e) {
        return;
    }
    // Sin cambios en un minuto (salvo una pregunta abierta) y sin ícono vivo: el agente terminó o murió.
    const idle = !s || ((!s.prompt || s.closeAt !== null) && now - s.updated > 60000);
    if (idle && !trayAlive) {
        app.terminate(null);
        return;
    }
    if (idle) {
        hide();
        return;
    }
    if ((s.closeAt !== null && now >= s.closeAt) || s.updated <= dismissed) {
        hide();
        return;
    }
    shownAt = s.updated;
    kind = s.kind || null;
    prompt = s.prompt;
    currentCloseAt = s.closeAt;
    appL.stringValue = $(s.app);
    titleL.stringValue = $(s.title);
    textL.stringValue = $(s.text);
    titleL.textColor = s.tone === 'error' ? $.NSColor.systemRedColor : s.tone === 'success' ? $.NSColor.systemGreenColor : $.NSColor.labelColor;
    setImage(s.image || null);
    btns.forEach((b, i) => {
        const a = prompt && prompt.actions[i];
        b.hidden = !a;
        if (a) b.title = $(a.label);
    });
    const indet = s.pct === null;
    if (indet !== indeterminate) {
        makeBar(indet);
        indeterminate = indet;
    }
    bar.hidden = !s.bar || !!prompt;
    if (!indet) bar.doubleValue = s.pct;
    if (!visible) {
        panel.setFrameDisplay(menuBarRect(), true); // por si se enchufó / cambió un monitor
        panel.orderFrontRegardless;
        visible = true;
    }
}

$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.25, ticker, 'tick:', $(), true);
tick();
app.run;
`;
