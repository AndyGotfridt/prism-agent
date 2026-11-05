# Historial de cambios de Prisma Agent

Sólo para el equipo: **no se empaqueta en el ejecutable** (`build.sh` sólo copia `package.json`, `bin/` y `src/`) ni se
muestra en la web. Lo que ven las computadoras es el *changelog* que se escribe al publicar cada versión en Prisma
(Administración → Prisma Agent → Versiones). Acá va el detalle para nosotros.

## Cómo se numera

- Serie **1.1.x**, sumando de a un patch.
- **Las betas siguen la numeración de producción**: la próxima beta es siempre **mayor que la versión de la rama
  `production`** (la Estable) y que cualquier versión ya publicada; nunca se repite un número. Al promover una beta a
  Estable es la misma versión (no se vuelve a armar), y `production` queda igual a lo promovido.
- `development` = canal Beta · `production` = canal Estable. Proceso completo: skill `prism-agent-release` (repo de Prisma 3D,
  `.agents/skills/`).
- Una entrada por versión, la más nueva arriba. Formato: `## X.Y.Z (canal) — AAAA-MM-DD`.

## 1.1.11 (beta) — 2026-11-05

- Puente: `ftp.put` en **dos etapas**. Antes pasaba los bytes del server a la impresora en streaming, atado a la velocidad (y a los cortes) de
  la descarga. Ahora baja el archivo entero a un temporal del puente, verifica el tamaño, y recién ahí lo sube por FTPS desde el disco; el temporal
  se borra siempre. El avance informado es el de la subida a la impresora.
- Puente: el timeout del FTPS de `ftp.put` pasa de 60 s a 180 s: al terminar los datos la A1/P1 tarda en grabar antes de contestar «226», y el
  corte a los 60 s dejaba el envío en 99% con `Timeout (control socket)`.

## 1.1.10 (beta) — 2026-11-05

- Puente: las transferencias de archivos (`ftp.put`/`ftp.get`) van **de a una en todo el puente**, no sólo por impresora. Dos subidas de 15 MB
  a la vez dejaban a las dos A1 con `Timeout (control socket)` (y a veces «sin red» juntas).
- Puente: mientras se transfiere un archivo, la cámara de esa impresora queda en pausa (`CameraService.hold/release`): el stream se corta,
  `camera.watch` se ignora y `camera.snapshot` falla con «cámara en pausa». Una A1/P1 con FTPS + TLS de cámara + MQTT a la vez deja de contestar.

## 1.1.9 (beta) — 2026-11-05

- Actualización desde Prisma para los puentes (`GET /commands` trae `update: { auto, now }`):
  - `auto` («Actualizar solo», por computadora): el agente trata la versión de su canal como obligatoria, o sea instala sin preguntar apenas no
    tenga nada en curso. Antes, en un contenedor (sin ventanita) la pregunta nunca se contestaba y se posponía 24 h para siempre.
  - `now` («Actualizar ahora» desde Administración → Prisma Agent → Puentes): marca de tiempo que se atiende una sola vez; relee `/config` y
    cambia de versión sin preguntar (`handleUpdateCommand`).
- Contenedor del puente (`PRISMA_AGENT_BRIDGE_ONLY=1` + `/.dockerenv`): después de instalar, el proceso termina y Docker lo relanza
  (`restart: unless-stopped`); antes quedaba bajado pero sin usarse hasta reiniciar a mano. Con `PRISMA_VERSION` fijada en el contenedor el
  entrypoint descarta el binario nuevo al reiniciar: dejarla vacía para actualizar solo.

## 1.1.8 (beta) — 2026-11-04

- Se quita el servidor local de la balanza (`src/scale-local.js`, `127.0.0.1:47651`) que trajo la 1.1.7: dependía del permiso de «Red
  local» de macOS (el agente en segundo plano no lo tiene y el `fetch` al ESP32 daba `EHOSTUNREACH`) y de tener el agente en cada
  compu. La balanza ahora se maneja desde el server por el puente, con `http.poll` / `http.request` que el agente ya tenía (`BridgeHttp`,
  como los enchufes); no hay nada nuevo en el agente. Plan en `docs/PLAN-SCALE-BRIDGE.md` (repo de Prisma 3D).

## 1.1.7 (beta) — 2026-11-04

- **Balanza de la LAN para el navegador** (`src/scale-local.js`): server en `127.0.0.1:47651` (puerto fijo) que hace de puente entre la
  web y el ESP32 (`GET /ping`, `GET /weight`, `POST /tare`, `POST /calibrate` con `?host=&port=`). El peso en vivo y la tara dejan de dar
  la vuelta por internet (el modo nube tardaba ~3,4 s por ciclo). Sólo responde si el `Origin` es el del server al que está vinculado
  el agente (CORS de ese origen + `Access-Control-Allow-Private-Network`), sólo a IPs privadas (reusa `isPrivateIp`), rutas fijas,
  sin redirecciones, timeout 2,5 s. Si el puerto está tomado (otro perfil) avisa en el log y la web cae al server. Se arranca en
  `start()` y se frena junto al puente. Plan en `docs/PLAN-SCALE-LOCAL.md` (repo de Prisma 3D).
- Drive: el log de las sincronizaciones de bajada y de los dos sentidos cuenta los archivos que el server omite (documentos de Google,
  accesos directos).

## 1.1.6 (beta) — 2026-10-30

- **Enrolamiento de puentes**: `login --enroll <código>` canjea en `device/token` un código de un solo uso (24 h) que un admin
  genera en Administración → Prisma Agent → Puentes → «Vincular un puente nuevo». El dispositivo nace con el puente prendido, sin
  navegador ni `/agent/link`. Pensado para el contenedor (`PRISMA_ENROLL_CODE`).
- **Modo sólo puente**: `PRISMA_AGENT_BRIDGE_ONLY=1` hace que `startWatcher()` no haga nada y no se configuren las carpetas a Drive
  (`driveSync.configure`). Siguen el puente, los comandos y el auto-update.

## 1.1.5 (beta) — 2026-10-29

- **Sincronización en los dos sentidos** (`direction: both`, `BothTask` en `src/drive-sync.js`). Cuenta lo que hay en cada lado
  (md5), el server decide con la base de la última sincronización y el agente ejecuta: bajar, subir, quitar en la computadora
  o conservar las dos. Lo que cambió en los dos lados no se toca: queda como conflicto para resolver en la web. Sin watcher
  (revisión a los 3 s, cada 15 min y con «Sincronizar ahora»). Pantalla local y `sync list` muestran la nueva dirección.
  El server no le manda carpetas `both` a un agente anterior a `DriveSyncService::BOTH_MIN_AGENT`.

## 1.1.4 (beta) — 2026-10-24

- **Sincronización Drive → computadora.** Cada carpeta sincronizada tiene una dirección, elegida al crearla: *subir* (lo de
  siempre) o *bajar* (`PullTask` en `src/drive-sync.js`). Nunca los dos sentidos a la vez.
- Bajada: el server arma el manifiesto de la carpeta de Drive (con md5) y sirve el contenido; el agente sigue sin credenciales de
  Google. Baja sólo lo distinto, reanuda con `Range` ante cortes y verifica tamaño y md5.
- Seguridad de lo local: lo que se pisa (no es una versión de Drive ya conocida) o se borra va a
  `<carpeta>/.prisma-papelera/AAAA-MM-DD/` (se vacía a los 30 días). Si alguien editó un archivo local y Drive no cambió, se respeta.
- «Reflejar borrados» en bajada (nace apagado): lo que desaparece de Drive va a esa papelera; una baja masiva o un manifiesto
  vacío no se aplican y se avisa. Sólo toca lo que bajó el propio agente.
- La pantalla local del agente y `prisma-agent sync` muestran la dirección y permiten crear carpetas de bajada.
- Requiere en Prisma: migración `2026_10_24_160000` (`direction`, `md5`, `remote_modified_at`). Un agente anterior a la 1.1.4 no
  recibe las carpetas de bajada.

## 1.1.3 (beta) — 2026-10-20

- Avisos con acciones: botones que llaman a la API y campo de texto en macOS (`PrismaNotify`).

## 1.1.2 (beta) — 2026-10-19

- Avisos nativos con botones (macOS y Windows).
- Canales de actualización (Estable / Beta) elegibles desde el agente (`prisma-agent channel`).

## 1.1.1 (estable) — 2026-10-19

- Versión de producción de partida de este historial. Lo anterior (1.0.x, 1.1.0) no está detallado acá.
