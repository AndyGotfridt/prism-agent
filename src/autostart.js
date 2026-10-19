import { platform } from 'node:os';
import { isInstalledMac, setAutostartMac } from './launchd.js';
import { isEnabledLinux, setAutostartLinux } from './systemd.js';
import { COMPILED } from './runtime.js';
import { isInstalledWindows, setAutostartWindows } from './windows-service.js';

/**
 * «Iniciar con la computadora», manejable desde Mi perfil por dispositivo. Es lo mismo que
 * `install`/`uninstall` (LaunchAgent en macOS, .vbs en la carpeta Inicio de Windows) pero sin
 * tocar el proceso que está corriendo: el cambio vale desde el próximo inicio de sesión.
 *
 * Sólo el ejecutable compilado: corriendo desde el código (`npm run local`) el servicio
 * apuntaría a node + el script, y no se informa (la web muestra el interruptor deshabilitado).
 */
export const AUTOSTART_SUPPORTED = COMPILED && ['darwin', 'win32', 'linux'].includes(platform());

/** true/false, o null si este agente no lo maneja. Se informa en cada pedido (X-Agent-Autostart). */
let cached = { at: 0, value: null };

export function autostartEnabled() {
    if (!AUTOSTART_SUPPORTED) return null;
    // En Linux es un `systemctl`: se pregunta como mucho cada 30 s (se informa en cada pedido a la API).
    if (platform() === 'linux') {
        if (Date.now() - cached.at > 30_000) cached = { at: Date.now(), value: isEnabledLinux() };

        return cached.value;
    }
    return platform() === 'win32' ? isInstalledWindows() : isInstalledMac();
}

export function setAutostart(enabled, url) {
    if (!AUTOSTART_SUPPORTED) return;
    cached.at = 0;
    if (platform() === 'linux') {
        setAutostartLinux(enabled);
    } else if (platform() === 'win32') {
        setAutostartWindows(enabled, url);
    } else {
        setAutostartMac(enabled, url);
    }
}
