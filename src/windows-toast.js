import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDir } from './fs-util.js';
import { readLocalConfig } from './local-config.js';
import { log, warn } from './log.js';
import { openUrl } from './notify.js';
import { APP_TITLE, PROFILE, profiled } from './profile.js';
import { selfCommand } from './runtime.js';
import { STATE_DIR } from './state.js';
import { START_MENU_SHORTCUT, writeStartMenuShortcut } from './windows-service.js';

/**
 * Aviso nativo de Windows con botones (docs/PLAN-AGENT-NOTIFICATIONS.md, fase 2). Sin probar
 * en una PC con Windows al escribirlo.
 *
 * - Identidad propia: el acceso «Prisma Sync» del menú Inicio lleva un AppUserModelID
 *   (`PrismaAgent.Sync`); sin él, un toast de una app suelta sale a nombre de PowerShell o no sale.
 * - Los botones son de activación por protocolo: `prisma-agent://open?u=<url>` (HKCU, sin
 *   administrador) → handle-url.vbs (oculto, sin ventana de consola) → `prisma-agent handle-url`,
 *   que sólo abre URLs del origen del server al que está conectado el agente.
 *
 * `showNativeWindows()` devuelve true si el toast quedó mostrado; false si hay que usar la
 * ventanita (avisos desactivados para la app, PowerShell falló…). Nunca lanza.
 */

export const AUMID = profiled('PrismaAgent.Sync', '.');
export const SCHEME = profiled('prisma-agent');
const HANDLER_VBS = join(STATE_DIR, 'handle-url.vbs');
const MARKER = join(STATE_DIR, 'toast-identity.json');
const MARKER_VERSION = 1;

const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const vbs = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Corre un script de PowerShell con los datos por variables de entorno (nada que escapar). */
function powershell(script, env, timeoutMs = 20_000) {
    return new Promise((resolve) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { windowsHide: true, timeout: timeoutMs, env: { ...process.env, ...env } },
            (err, stdout) => resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout ?? '').trim() }),
        );
    });
}

/** .vbs del protocolo: pasa la URL por variable de entorno (nunca por la línea de comandos) y corre oculto. */
function handlerScript() {
    const launch = [...selfCommand(), 'handle-url'].map((a) => `"${a}"`).join(' ');
    const lines = [
        'If WScript.Arguments.Count = 0 Then WScript.Quit',
        'Set sh = CreateObject("WScript.Shell")',
        'Set env = sh.Environment("Process")',
        'env("PA_URL") = WScript.Arguments(0)',
    ];
    if (PROFILE) lines.push(`env("PRISMA_AGENT_PROFILE") = ${vbs(PROFILE)}`);
    lines.push(`sh.Run ${vbs(launch)}, 0, False`);

    return lines.join('\r\n') + '\r\n';
}

const IDENTITY_SCRIPT = String.raw`
$code = @'
using System;
using System.Runtime.InteropServices;
public static class PaShortcut {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
    interface IPersistFile {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr p;
    }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }
    public static void SetAppId(string lnk, string appId) {
        object link = new CShellLink();
        ((IPersistFile)link).Load(lnk, 2);
        var store = (IPropertyStore)link;
        var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        var pv = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) };
        store.SetValue(ref key, ref pv);
        store.Commit();
        ((IPersistFile)link).Save(lnk, true);
    }
}
'@
Add-Type -TypeDefinition $code
[PaShortcut]::SetAppId($env:PA_LNK, $env:PA_AUMID)

$k = 'HKCU:\Software\Classes\' + $env:PA_SCHEME
New-Item -Path $k -Force | Out-Null
Set-ItemProperty -Path $k -Name '(default)' -Value ('URL:' + $env:PA_TITLE)
New-ItemProperty -Path $k -Name 'URL Protocol' -Value '' -Force | Out-Null
New-Item -Path ($k + '\shell\open\command') -Force | Out-Null
Set-ItemProperty -Path ($k + '\shell\open\command') -Name '(default)' -Value $env:PA_COMMAND
`;

let identityReady = null;

/**
 * El acceso del menú Inicio con AUMID + el protocolo en HKCU. Se rehace si cambia el ejecutable o
 * si el acceso se recreó (otro mtime). Una vez por ejecución del agente.
 */
function ensureIdentity() {
    if (identityReady) return identityReady;
    identityReady = (async () => {
        ensureDir(STATE_DIR);
        writeStartMenuShortcut();
        if (!existsSync(START_MENU_SHORTCUT)) return false;

        const handler = utf16(handlerScript());
        if (!existsSync(HANDLER_VBS) || !readFileSync(HANDLER_VBS).equals(handler)) writeFileSync(HANDLER_VBS, handler);

        const command = `"${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')}" "${HANDLER_VBS}" "%1"`;
        let marker = {};
        try { marker = JSON.parse(readFileSync(MARKER, 'utf8')); } catch { /* sin marca */ }
        const mtime = statSync(START_MENU_SHORTCUT).mtimeMs;
        if (marker.v === MARKER_VERSION && marker.command === command && marker.aumid === AUMID && marker.mtime === mtime) return true;

        const res = await powershell(IDENTITY_SCRIPT, {
            PA_LNK: START_MENU_SHORTCUT,
            PA_AUMID: AUMID,
            PA_SCHEME: SCHEME,
            PA_TITLE: APP_TITLE,
            PA_COMMAND: command,
        }, 60_000);
        if (!res.ok) {
            warn('Could not register the toast identity (shortcut AUMID / protocol)');
            return false;
        }
        writeFileSync(MARKER, JSON.stringify({ v: MARKER_VERSION, command, aumid: AUMID, mtime: statSync(START_MENU_SHORTCUT).mtimeMs }));
        log(`Toast identity registered (${AUMID}, ${SCHEME}://)`);

        return true;
    })().catch((err) => {
        warn(`Toast identity unavailable: ${err.message}`);

        return false;
    });

    return identityReady;
}

const TOAST_SCRIPT = String.raw`
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:PA_AUMID)
if ([string]$notifier.Setting -ne 'Enabled') { Write-Output ('setting:' + $notifier.Setting); exit 2 }
$a = $env:PA_SPEC | ConvertFrom-Json
function esc($s) { [System.Security.SecurityElement]::Escape([string]$s) }
$launch = ''
$buttons = ''
foreach ($b in @($a.actions)) {
    if ($launch -eq '') { $launch = ' launch="' + (esc $b.args) + '" activationType="protocol"' }
    $buttons += '<action content="' + (esc $b.label) + '" arguments="' + (esc $b.args) + '" activationType="protocol"/>'
}
$img = ''
if ($a.image) { $img = '<image placement="hero" src="' + (esc $a.image) + '"/>' }
$xml = '<toast' + $launch + '><visual><binding template="ToastGeneric"><text>' + (esc $a.title) + '</text><text>' + (esc $a.text) + '</text>' + $img + '</binding></visual>'
if ($buttons -ne '') { $xml += '<actions>' + $buttons + '</actions>' }
$xml += '</toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($doc))
Write-Output 'shown'
`;

/**
 * @param {{title: string, text?: string, image?: string|null, actions?: Array<{label: string, kind: string, url?: string}>}} alert
 */
export async function showNativeWindows({ title, text = '', image = null, actions = [] }) {
    try {
        if (!(await ensureIdentity())) return false;

        const spec = {
            title,
            text,
            image: image && existsSync(image) ? pathToFileURL(image).href : '',
            actions: actions
                .filter((a) => a.kind === 'open' && a.url)
                .slice(0, 3)
                .map((a) => ({ label: a.label, args: `${SCHEME}://open?u=${encodeURIComponent(a.url)}` })),
        };
        const res = await powershell(TOAST_SCRIPT, { PA_AUMID: AUMID, PA_SPEC: JSON.stringify(spec) });
        if (res.out.startsWith('setting:')) {
            log(`Windows notifications are off for the app (${res.out.slice(8)}): using the agent window`);
        }

        return res.ok && res.out.endsWith('shown');
    } catch (err) {
        warn(`Windows toast failed: ${err.message}`);

        return false;
    }
}

/**
 * `prisma-agent handle-url "<prisma-agent://open?u=…>"` (lo corre el protocolo, ver handlerScript).
 * Sólo abre URLs del origen del server al que está conectado este agente.
 */
export function handleUrl(raw = process.env.PA_URL) {
    try {
        const link = new URL(String(raw ?? ''));
        if (link.protocol !== `${SCHEME}:`) return false;
        const target = new URL(link.searchParams.get('u') ?? '');
        const server = readLocalConfig()?.url;
        if (!server || target.origin !== new URL(server).origin) return false;

        return openUrl(target.href);
    } catch {
        return false;
    }
}
