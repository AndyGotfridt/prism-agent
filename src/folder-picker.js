import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { sep } from 'node:path';

const PROMPT = 'Elegí la carpeta a sincronizar';

/**
 * Abre el selector de carpetas nativo del sistema y devuelve la ruta elegida, o null si se
 * canceló. Lo pide la web («Elegir…» en Mi perfil → Prisma Agent): el navegador no puede dar
 * la ruta absoluta de una carpeta, así que el diálogo se abre acá.
 *
 * - macOS: `choose folder` de AppleScript (osascript, sin dependencias).
 * - Windows: FolderBrowserDialog de .NET por PowerShell (viene con Windows).
 * - Linux: zenity, si está instalado.
 */
export async function pickFolder(current, { timeoutMs = 180_000 } = {}) {
    const start = current && existsSync(current) ? current : homedir();

    switch (platform()) {
        case 'darwin':
            return pickMac(start, timeoutMs);
        case 'win32':
            return pickWindows(start, timeoutMs);
        default:
            return pickLinux(start, timeoutMs);
    }
}

/** `/Users/andy/Documents/x` → `~/Documents/x` (más legible en la web y portable entre Macs). */
export function contractHome(path) {
    const home = homedir();
    return path === home ? '~' : path.startsWith(home + sep) ? '~' + path.slice(home.length).replace(/\\/g, '/') : path;
}

function run(cmd, args, { timeoutMs, env } = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, ...env }, windowsHide: false }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, killed: err?.killed ?? false, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
        });
    });
}

async function pickMac(start, timeoutMs) {
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // `activate` trae el diálogo al frente aunque el agente corra en segundo plano (launchd).
    const res = await run('osascript', [
        '-e', 'activate',
        '-e', `POSIX path of (choose folder with prompt "${esc(PROMPT)}" default location (POSIX file "${esc(start)}"))`,
    ], { timeoutMs });

    if (res.code === 0 && res.stdout) return contractHome(res.stdout.replace(/\/+$/, ''));
    if (/-128/.test(res.stderr) || res.killed) return null; // cancelado o vencido
    throw new Error(res.stderr || 'No se pudo abrir el selector de carpetas.');
}

async function pickWindows(start, timeoutMs) {
    // La ruta inicial va por variable de entorno: así no hay que escapar nada en el script.
    const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${PROMPT}'
$d.ShowNewFolderButton = $true
if ($env:PRISMA_PICK_START -and (Test-Path -LiteralPath $env:PRISMA_PICK_START)) { $d.SelectedPath = $env:PRISMA_PICK_START }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath; exit 0 }
exit 2
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const res = await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        timeoutMs,
        env: { PRISMA_PICK_START: start },
    });

    if (res.code === 0 && res.stdout) return res.stdout;
    if (res.code === 2 || res.killed) return null;
    throw new Error(res.stderr || 'No se pudo abrir el selector de carpetas.');
}

async function pickLinux(start, timeoutMs) {
    const res = await run('zenity', ['--file-selection', '--directory', `--title=${PROMPT}`, `--filename=${start}/`], { timeoutMs });

    if (res.code === 0 && res.stdout) return contractHome(res.stdout);
    if (res.code === 1 || res.killed) return null;
    throw new Error('No hay selector de carpetas (instalá zenity) o falló al abrirse.');
}

/**
 * «Subir un archivo…» del ícono: selector de archivos nativo para un 3MF que no está en la
 * carpeta de sincronización. Devuelve la ruta absoluta, o null si se canceló.
 */
export async function pickFile(start, { timeoutMs = 300_000 } = {}) {
    const dir = start && existsSync(start) ? start : homedir();
    const prompt = 'Elegí el 3MF a subir';

    switch (platform()) {
        case 'darwin': {
            const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const res = await run('osascript', [
                '-e', 'activate',
                '-e', `POSIX path of (choose file with prompt "${esc(prompt)}" default location (POSIX file "${esc(dir)}"))`,
            ], { timeoutMs });
            if (res.code === 0 && res.stdout) return res.stdout;
            if (/-128/.test(res.stderr) || res.killed) return null;
            throw new Error(res.stderr || 'No se pudo abrir el selector de archivos.');
        }
        case 'win32': {
            const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '${prompt}'
$d.Filter = '3MF (*.3mf)|*.3mf|Todos los archivos (*.*)|*.*'
if ($env:PRISMA_PICK_START -and (Test-Path -LiteralPath $env:PRISMA_PICK_START)) { $d.InitialDirectory = $env:PRISMA_PICK_START }
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName; exit 0 }
exit 2
`;
            const res = await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
                timeoutMs,
                env: { PRISMA_PICK_START: dir },
            });
            if (res.code === 0 && res.stdout) return res.stdout;
            if (res.code === 2 || res.killed) return null;
            throw new Error(res.stderr || 'No se pudo abrir el selector de archivos.');
        }
        default: {
            const res = await run('zenity', ['--file-selection', `--title=${prompt}`, '--file-filter=*.3mf', `--filename=${dir}/`], { timeoutMs });
            if (res.code === 0 && res.stdout) return res.stdout;
            if (res.code === 1 || res.killed) return null;
            throw new Error('No hay selector de archivos (instalá zenity) o falló al abrirse.');
        }
    }
}
