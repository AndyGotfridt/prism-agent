import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { progressSupported, showMessage } from './progress-ui.js';

/**
 * Aviso en el escritorio, sin dependencias. Nunca rompe si falla (queda el log).
 * En macOS y Windows va a la ventanita del agente (progress-ui.js), la misma del progreso y
 * de la pregunta de actualizar. El toast de WinRT por PowerShell (abajo) quedó sólo como
 * respaldo: depende de que Windows tenga habilitada la «app» de PowerShell y en varias PCs
 * no aparecía. `tone`: info | success | error (color del título). `action`: botón opcional
 * ({ label, run }) e `image` (ruta de una foto local), sólo en la ventanita. Devuelve cuánto
 * se queda la ventanita (ms; 0 sin ventanita).
 */
export function notify(title, message, tone = 'info', action = null, { image = null } = {}) {
    if (progressSupported()) {
        return showMessage(title, message, tone, action, { image });
    }
    try {
        if (platform() === 'darwin') {
            const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            spawn('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], {
                stdio: 'ignore',
                detached: true,
            }).unref();
        } else if (platform() === 'win32') {
            // Título y texto por variables de entorno: nada que escapar en el script.
            const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:PA_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:PA_MESSAGE)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
`;
            spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
                stdio: 'ignore',
                detached: true,
                windowsHide: true,
                env: { ...process.env, PA_TITLE: String(title), PA_MESSAGE: String(message) },
            }).unref();
        }
    } catch {
        // Sin notificación no pasa nada.
    }
    return 0;
}

/** Abre una URL en el navegador por defecto. */
export function openUrl(url) {
    try {
        if (platform() === 'darwin') {
            spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
        } else if (platform() === 'win32') {
            // rundll32 y no `cmd /c start`: con `&` en la query, cmd corta la URL.
            spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
        } else {
            spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
        }
        return true;
    } catch {
        return false;
    }
}
