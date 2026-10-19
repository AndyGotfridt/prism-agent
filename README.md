# Prisma Agent

Vigila una carpeta de la computadora (**macOS o Windows**) y sube a **Por importar** (Modelos → Por importar) de Prisma 3D cada 3MF
sliceado que exportes ahí desde Bambu Studio u OrcaSlicer. En la web alguien revisa la
sugerencia y lo importa al catálogo (o lo descarta). El agente no analiza nada: sube y avisa.

Plan y decisiones: `docs/PLAN-SLICER-INBOX.md`. Detalle técnico del lado del server:
`docs/slicer-inbox.md`.

## Instalación (usuarios)

No hace falta Node ni el repo: en **Mi perfil → Prisma Agent → Conectar otra computadora**
está el comando de una línea con la URL ya puesta. Baja el ejecutable correcto, abre el
navegador para autorizar y lo deja andando al prender la computadora. Correrlo de nuevo
**actualiza** el agente.

```bash
curl -fsSL https://3d.prism.com.ar/agent/install.sh | sh        # macOS (Terminal)
# Windows (PowerShell; el SecurityProtocol prende TLS 1.2, sin eso PowerShell 5.1 no conecta)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://3d.prism.com.ar/agent/install.ps1 | iex
```

- macOS: queda en `~/.prisma-agent/bin/prisma-agent` (y se agrega al `PATH` en `~/.zshrc`).
  No está firmado por Apple: el instalador le pone una firma local y le saca la marca de
  «descargado de internet». Si lo bajás a mano desde el navegador, hacé lo mismo:
  `xattr -d com.apple.quarantine prisma-agent && codesign --force --sign - prisma-agent`.
- Windows: queda en `%LOCALAPPDATA%\prisma-agent\bin\prisma-agent.exe` (agregado al `PATH`
  del usuario). Sin permisos de administrador.

El token queda en el **Llavero** (macOS) o cifrado con **DPAPI** para tu usuario (Windows), y la
URL + el id del dispositivo en `~/.config/prisma-agent/config.json`. Cuando se publica una
versión nueva, el agente avisa.

## Publicar una versión

Las computadoras bajan el ejecutable **ya armado** desde Prisma: no necesitan Node ni Bun.
Armarlo hace falta una vez por versión del agente (cuando cambia `version` en `package.json`):

- **Desde la web** (admin): Administración → Prisma Agent → **Publicar versión**. Corre el build en
  el servidor en segundo plano y avisa en la campanita al terminar. El botón aparece solo
  cuando el código tiene una versión sin publicar.
- **A mano**, en el servidor: `docker compose exec -u www-data worker bash tools/prisma-agent/build.sh`
  (fuera de Docker: `bash tools/prisma-agent/build.sh`).

No depende de ninguna PC: corre en el servidor. El build usa [Bun](https://bun.sh), que compila
macOS (Apple e Intel) y Windows desde Linux. En Docker, Bun viene en la imagen del worker
(`docker/php/Dockerfile`); fuera de Docker, si no está instalado, el script lo baja solo a
`<destino>/.bun` (necesita `curl` y `unzip` o `python3`). Compila sobre una copia en
`<destino>/.work` (en el contenedor el código no es escribible) y deja los ejecutables en
`storage/app/private/agent-builds` (`PRISMA_AGENT_BUILDS_PATH`), fuera de git y en el volumen.
La primera vez tarda más: baja el runtime de cada plataforma. Detalle de Docker en
`docker/DEPLOY.md`.

## Instalación desde el repo (desarrollo)

Requiere **Node 24+**:

```bash
npm install --prefix tools/prisma-agent  # dependencias dentro de la carpeta
npm install -g ./tools/prisma-agent      # symlink → binario `prisma-agent` (un git pull lo actualiza)
prisma-agent login --url https://prisma-3d.test
prisma-agent run
```

## Uso

En el slicer: **Archivo → Exportar → Exportar archivo de placa sliceado** (o «Exportar todo
lo sliceado») a la carpeta que vigila el agente. Por defecto
`~/Documents/Impresiones/auto-sync`.

La carpeta y el resto de la configuración se cambian en la web, en **Mi perfil → Prisma
Agent → Configuración**. El botón **Elegir…** abre la ventana de carpetas nativa **en tu
computadora** (Finder en macOS, el diálogo de Windows; si tenés varias, te pregunta en cuál).
El navegador no puede dar la ruta absoluta de una carpeta, por eso la ventana la abre el
agente: tiene que estar corriendo (consulta pedidos de la web cada 10 s). El resto de la
configuración la relee cada 5 minutos.

> Windows con **Documentos en OneDrive**: `~/Documents` apunta a `C:\Users\vos\Documents`, que
> no es la carpeta que muestra el Explorador. Elegí la carpeta con **Elegir…**.

| Comando | Qué hace |
|---|---|
| `prisma-agent login [--url URL] [--name NOMBRE]` | Conecta este equipo (abre el navegador) |
| `prisma-agent logout` | Lo desconecta y borra el token del Keychain |
| `prisma-agent status` | Usuario, dispositivo, configuración efectiva y lo que quedó sin subir |
| `prisma-agent run` | Corre en primer plano con logs en la terminal (para probar) |
| `prisma-agent start` | Lo abre en segundo plano si está cerrado (sale con código 3 si ya estaba abierto). Es lo que corre el acceso «Prisma Sync» (ver Volver a abrirlo) |
| `prisma-agent demo [escenario]` | Muestra la ventanita con un caso de prueba (no sube nada). Sólo desarrollo, ver Probarla |
| `prisma-agent update` | Baja e instala la versión publicada en Prisma y reinicia el servicio |
| `prisma-agent [--profile P] …` | Cualquier comando, sobre el perfil `P` (ver Perfiles) |
| `prisma-agent install` / `uninstall` | Arranque al iniciar sesión. macOS: LaunchAgent `com.prisma3d.agent` (logs en `~/Library/Logs/prisma-agent.log`). Windows: `prisma-agent.vbs` en la carpeta Inicio, corre oculto (logs en `%LOCALAPPDATA%\prisma-agent\prisma-agent.log`). También se prende/apaga por computadora en Mi perfil → Prisma Agent («Iniciar con la computadora»): el agente escribe o borra ese mismo archivo sin frenarse y vale desde el próximo inicio de sesión |

Dentro de la carpeta:

- `Subidos/` — lo ya subido (si «Después de subir» es *Mover*).
- `Error/` — lo que el servidor rechazó, con un `.txt` al lado que explica el motivo.
- Los `.tmp` y archivos ocultos se ignoran (Bambu Studio escribe `x.gcode.3mf.tmp` y lo renombra).

## Volver a abrirlo

Después de **Salir** desde el ícono, el agente vuelve a arrancar solo en el próximo inicio de sesión
(si «Iniciar con la computadora» está prendido). Para abrirlo antes, sin terminal:

- **macOS**: **Prisma Sync** en Spotlight, Launchpad o `~/Applications` (se puede dejar en el
  Dock). Es `~/Applications/Prisma Sync.app`, un bundle mínimo cuyo ejecutable es un script que
  corre `prisma-agent start`: levanta el servicio de launchd (`kickstart` si está cargado; si no,
  `bootstrap` del plist de LaunchAgents o, con el inicio automático apagado, de una copia en
  `~/.config/prisma-agent/`, que no arranca al iniciar sesión). Si ya estaba abierto lo avisa con
  una notificación; si falla, muestra el error.
- **Windows**: **Prisma Sync** en el menú Inicio (se puede anclar a la barra de tareas). El acceso
  corre `%LOCALAPPDATA%\prisma-agent\open.vbs`, que llama a `prisma-agent start` oculto: lanza el
  `.vbs` de la carpeta Inicio o, con el inicio automático apagado, `run.vbs` (misma carpeta de
  estado). Si ya estaba abierto o falla, lo dice en un cuadro de mensaje.

Con perfil, el acceso se llama «Prisma Sync (local)». Lo crea `install` y, en las instalaciones
anteriores, el agente al arrancar (sólo el ejecutable instalado, no corriendo desde el código);
`uninstall` lo borra.

## Probar en local (`https://prisma-3d.test`)

Desde el código (Node 24), con el perfil `local`: no toca al agente instalado (el de
producción) ni su sesión, y cada cambio en `src/` se ve al reiniciarlo.

```bash
cd tools/prisma-agent
npm run local:login   # una vez: autoriza esta Mac en el Prisma local
npm run local         # corre en primer plano: logs, ventanita, ícono y «Probar» de la web
npm run local:demo    # la ventanita con todos los casos, sin pasar por la web
```

No uses `prisma-agent login --url https://prisma-3d.test` sin perfil: pisa la sesión del
agente de producción.

Node no confía en la CA de **mkcert**. Si `mkcert` está instalado, el agente se relanza solo
con `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`, e `install` lo escribe en el plist
cuando la URL guardada es `.test`. Sin mkcert en el `PATH`, exportalo a mano.

## Ventanita en el escritorio

El agente muestra una ventanita propia (abajo a la derecha en Windows, arriba a
la derecha en macOS) con el progreso de cada subida («Preparando…», «Subiendo - 45%»,
«Subido, verificando...»), los avisos («Importado correctamente» con un botón **Abrir** que
lleva al archivo en Por importar, errores) y la pregunta de actualizar con botones. No toma el foco y se cierra sola; la ✕ (o un click) la oculta hasta el
próximo cambio; en la pregunta de actualizar, la ✕ cuenta como «Más tarde». En macOS aparece en
la pantalla activa (la de la ventana con foco). Se apaga con «Mostrar el progreso y los avisos en la computadora» en Mi perfil (la
pregunta de actualizar se muestra igual).

Sin dependencias: el agente escribe el estado en `progress.json` (carpeta de estado) y un
proceso auxiliar lo dibuja — PowerShell + WinForms en Windows, `osascript -l JavaScript` +
Cocoa en macOS (`src/progress-ui.js`). En Windows reemplaza al toast del sistema, que depende
de que Windows tenga habilitada la «app» de PowerShell y en varias PCs no aparecía.

El porcentaje sale de subir cada parte en tajadas de 256 KB (`Api.putStream`, con
`Content-Length`). Si eso falla y el PUT de siempre anda, el agente sigue sin progreso hasta
reiniciarse.

### Ícono en la barra de menú (macOS) / bandeja (Windows)

Mientras el agente corre hay un ícono de Prisma: en macOS el cubo del logo (imagen «template»,
se adapta a claro/oscuro), en Windows el favicon de la app (`src/tray-icon.js`). Un punto
encima indica que está subiendo o que hay un problema, y un número las notificaciones sin
leer de Prisma (en macOS al lado del cubo; en Windows, círculo rojo). Mientras sube, un arco que gira
(verde en Windows); en pausa, dos barritas (⏸; ámbar en Windows); con un problema, un punto
(rojo en Windows). El menú,
por bloques:

1. **Cuenta**: usuario (en negrita), email y computadora (de `GET /me`).
2. **Estado**: «✅ Sincronizado», «Subiendo X - 40%», «⏸ Pausado · N en espera», «Sin sesión»…
3. **Prisma**: Ver en Prisma 3D (N por importar), Notificaciones (N sin leer) y **Últimos
   subidos** (submenú con los 5 últimos y su estado; click → ese archivo en Prisma; se guardan
   en `recent.json` y sobreviven reinicios).
4. **Esta computadora**: **Subir un archivo…** (selector nativo; un 3MF de cualquier lado, que no
   se mueve ni se borra después), Abrir carpeta y **Pausar / Reanudar sincronización** (lo nuevo
   queda en la cola hasta reanudar; no sobrevive un reinicio).
5. **El agente**: Configuraciones, **Buscar actualizaciones** (consulta ya y, si hay, pregunta;
   o «Actualización disponible: X» si ya se sabe) y **Ver registro** (el log del servicio).
6. **Salir** (deja de vigilar hasta el próximo inicio de sesión en la computadora; en macOS baja
   el servicio de launchd, que si no lo relanzaría) y la versión.

Los ítems llevan ícono (`icon` en cada ítem, mapa `TRAY_ICONS` en `src/progress-ui.js`): en
macOS un SF Symbol (macOS 11+) pasado a bitmap template, porque la imagen del símbolo tal cual
no se dibuja en ese menú (se adapta a claro/oscuro); en Windows un glifo de Segoe Fluent Icons /
Segoe MDL2 Assets dibujado en 16×16. Si el sistema no lo tiene, el ítem queda sin ícono.

En Windows, doble click abre Por importar. Los contadores vienen en `counts` de
`GET /commands` (cada 10 s). El auxiliar arma el menú a partir de una lista genérica (`menu` en
`tray.json`: separadores, submenús, ítems grisados o en negrita) que compone `Agent.trayMenu()`.

Sin sesión (venció, la revocaron o se hizo `logout`) el menú queda en «Sin sesión» con un solo
ítem, **Iniciar sesión…**, y el aviso de sesión vencida trae el mismo botón: abre el navegador
para autorizar (el login de siempre, contra el Prisma de ese agente) y, al volver, el agente
sigue solo, sin reiniciarse. Por eso `logout` deja la URL en `config.json` (sin dispositivo): el
agente instalado arranca igual y ofrece iniciar sesión.

En Windows el auxiliar es `tray-helper.ps1` en la carpeta de estado, lanzado con `-File` (por
`-EncodedCommand` el script superaba los 32.767 caracteres de la línea de comandos y no arrancaba).

Lo dibuja el mismo auxiliar de la ventanita, que queda abierto mientras corre el agente: el
agente renueva `tray.json` cada 15 s (si muere, a los 60 s el ícono se va) y los clicks
vuelven por `tray-action.json`. Cada auxiliar atiende sólo al agente que lo lanzó: al
reiniciarse (ej. tras actualizar), el viejo se cierra y no quedan dos íconos.

### Avisos de impresiones (con la foto de la cámara)

Cuando una impresión termina, falla o se cancela, Prisma le avisa en la ventanita a quien recibe el mail
de esa impresión y tiene el agente conectado: título («Terminó la impresión» en verde, «Falló» en rojo),
modelo · impresora · duración, la **foto de la cámara** grande y «Ver impresión». Llegan en el sondeo de
`/commands` (≤ 10 s, campo `alerts`); la foto se baja de `/alerts/{id}/image` a `<estado>/alerts/`
(quedan las últimas 10). Del lado del server, `docs/slicer-inbox.md` → «Avisos de escritorio».

Ojo al tocar el script de PowerShell de `progress-ui.js`: `bun build --minify` convierte lo no-ASCII
de un `String.raw` en `\uXXXX`, que PowerShell muestra tal cual. Fuera de los comentarios, sólo ASCII
(`[char]0x00B7` en vez de `·`).

### Ver el log desde la web

Mi perfil → Prisma Agent (las propias) y Administración → Prisma Agent (las de todos) tienen
**Ver log** en cada computadora **en línea**. La web deja un pedido (`send_log` en
`GET /commands`, cache en `App\Services\Agent\AgentLogRequest`), el agente lo levanta en su
sondeo (≤ 10 s), manda los últimos ~150 KB de su archivo de log con `POST /log` y la web los
muestra en un modal (no se guardan en la base: viven en cache 10 minutos). Dónde está el
archivo: macOS `~/Library/Logs/prisma-agent.log` · Windows `%LOCALAPPDATA%\prisma-agent\prisma-agent.log`
(rota a `.1` a los 5 MB). Corriendo en una terminal no hay archivo y el modal lo dice.

### Probarla

Sin subir ni instalar nada:

- **Desde la web**: Mi perfil → Prisma Agent → **Probar** en la computadora (subida con
  progreso, «Importado correctamente» con Abrir, error, pregunta de actualizar o todo seguido). Lo
  levanta el agente en su próximo sondeo (≤ 10 s). Sólo fuera de producción
  (`App\Services\Agent\AgentDemo`); en producción no aparece.
- **Desde la terminal**: `prisma-agent demo [upload|ready|error|pause|update|all]` (default `all`).

Es sólo para desarrollo (`DEMO_ENABLED` en `src/demo.js`): anda desde el código (`node`, `npm run
local:*`) o con un perfil (el `prisma-agent-local` que instala el Prisma local). El ejecutable de
producción sin perfil no tiene el comando ni atiende el «Probar» de la web.

## Actualizaciones

Cuando se publica una versión nueva (Administración → Prisma Agent → Versiones → **Publicar versión**), el agente la ve en
`/config` (cada 5 min) y, cuando no está subiendo nada, **pregunta** en la ventanita: «Actualizar» o «Más tarde».

El agente sigue a la versión **objetivo** que se elige en Versiones, no sólo a la más alta
(`wantsChange()` en `src/updater.js`):

- **Obligatoria** (`agent_update.mandatory`): cambia sin preguntar, apenas no esté subiendo nada.
  Si falla, reintenta a la hora.
- **Revertir**: si la objetivo es más vieja que la suya, vuelve a ella (obligatorio). La ventanita
  dice «Volviendo a…» y, al arrancar, «Volviste a la X».
- **Versión retirada** (`agent_blocked`): queda en «Esta versión fue retirada», no sube nada y cambia
  a la objetivo sin preguntar.
- Corriendo desde el código no baja de versión (no se reemplaza solo).

La numeración se reinició en la 1.0.0 (`php artisan prisma-agent:reset-releases`). Los agentes de la
numeración vieja anteriores a la 1.2.0 sólo suben de versión, así que no vuelven solos a la 1.0.0: se
reinstalan con la línea de Mi perfil.

- **Actualizar**: espera a que no haya nada subiéndose, baja el ejecutable (la ventanita muestra
  porcentaje, «12,3 MB de 62,0 MB · faltan ~20 s» y después «Verificando la descarga»; el ícono, el
  porcentaje; `prisma-agent update` lo muestra en la terminal), verifica tamaño y
  sha256 contra el manifest, lo pone en lugar del actual (macOS: firma ad-hoc; Windows: el
  viejo queda como `.old` y se borra en el arranque siguiente) y se reinicia. El agente nuevo
  avisa al arrancar si quedó bien o no.
- **Más tarde** (o no contestar en 10 min): vuelve a preguntar al día siguiente. Si la versión
  actual ya no puede subir (`PRISMA_AGENT_MIN_VERSION`), a la hora.
- Sin servicio instalado (`run` a mano) baja la versión y pide reiniciarlo. Instalado desde el
  repo (Node) no se actualiza solo: avisa con el comando de instalación, como antes.
- Desde la terminal: `prisma-agent update`.

Las versiones anteriores a 0.4.0 no saben actualizarse solas: esa primera vez hay que correr el
comando de instalación de Mi perfil.

## Perfiles: producción y local en la misma computadora

Cada **perfil** es un agente aparte: su sesión (`~/.config/prisma-agent-<perfil>/`), su
servicio (`com.prisma3d.agent.<perfil>`, logs en `~/Library/Logs/prisma-agent-<perfil>.log`;
en Windows `prisma-agent-<perfil>.vbs`) y su ejecutable. Sin perfil es el agente de siempre.

- **Instalador de una línea**: el Prisma que no es producción instala con perfil solo
  (`slicer_inbox.agent_profile`: el `APP_ENV`, o sea `local`; se cambia con
  `PRISMA_AGENT_INSTALL_PROFILE`). Queda en `~/.prisma-agent/local/` y el comando es
  `prisma-agent-local` (`prisma-agent-local status`, `prisma-agent-local uninstall`…).
- **A mano**: `--profile <nombre>` en cualquier comando, o `PRISMA_AGENT_PROFILE=<nombre>`.

```bash
prisma-agent --profile local login --url https://prisma-3d.test
prisma-agent --profile local install
```

Usá una carpeta de sincronización distinta en cada Prisma (Mi perfil → Prisma Agent): si
los dos vigilan la misma, cada 3MF termina en los dos Prismas.

## Problemas comunes

El log del servicio está en inglés, una línea por evento con hora local y nivel
(`2026-10-09 02:54:05 INFO  Lunara_Base.gcode.3mf: uploaded (#6)`; problemas con `WARN`):
`grep WARN` alcanza para ver qué falló. Lo que se ve en la terminal y los avisos siguen en español.

Se rota solo: al arrancar y cada hora, si pasa de 5 MB el actual pasa a `<log>.1` (se pisa el
anterior) y empieza de cero, así que nunca ocupa más de ~10 MB. En macOS el archivo lo abre
launchd y se recorta con copia + truncado (launchd escribe en modo append). En Windows lo escribe
el propio agente (`PRISMA_AGENT_LOG_FILE`, que pone el `.vbs`): con el `cmd /c … >> log` de antes
no se podía recortar. Un `.vbs` de una versión anterior se reescribe solo al arrancar, y vale
desde el inicio siguiente. Los errores que tiran abajo al agente también quedan en el log (`ERROR`).

| Síntoma | Causa / qué hacer |
|---|---|
| `certificado no confiable` contra `.test` | Falta la CA de mkcert (ver arriba). |
| `unable to verify the first certificate` en Windows contra producción | Un antivirus que inspecciona HTTPS o un proxy de empresa. Desde 0.3.1 el agente confía en las raíces de Windows (las exporta a `%LOCALAPPDATA%\prisma-agent\windows-roots.pem` y se relanza con `NODE_EXTRA_CA_CERTS`). Si sigue, la CA del antivirus no está en el almacén de Windows: excluí `3d.prism.com.ar` del escaneo HTTPS. |
| `Cloudflare bloqueó el pedido (challenge)` | Falta la regla de WAF para `/api/agent/*`: `docs/cloudflare-waf-agent.md`. |
| Notificación «La sesión del agente venció o fue revocada» | Se revocó el dispositivo en Mi perfil o pasó un año. `prisma-agent login`. Lo que quedó en la carpeta se sube solo después. |
| `Cannot find package 'chokidar'` (instalación desde el repo) | Faltan las dependencias: `npm install --prefix tools/prisma-agent`. |
| «Hay que actualizar Prisma Agent» | El server pide una versión más nueva (`PRISMA_AGENT_MIN_VERSION`). Corré de nuevo el comando de instalación de Mi perfil. |
| Un archivo terminó en `Error/` | Leé el `.txt` de al lado. Típico: «El 3MF no está sliceado» (se exportó el proyecto, no el sliceado). |
| No pasa nada al exportar | `prisma-agent status` (¿la carpeta es la que creés?) y los logs: `tail -f ~/Library/Logs/prisma-agent.log` (macOS) o `Get-Content -Wait $env:LOCALAPPDATA\prisma-agent\prisma-agent.log` (Windows). |
| «Elegir…» dice que el agente no respondió | El agente no está corriendo en esa computadora (`prisma-agent run` o `install`), o es una versión anterior a 0.2.0. |
| Windows: no aparecen avisos | Revisá que las notificaciones de «Windows PowerShell» estén habilitadas en Configuración → Sistema → Notificaciones. |

## Cómo sube

1. `sha256` del archivo → `POST /api/agent/v1/slicer-inbox/check`. Si ya está en la bandeja
   (lo haya subido quien sea), no lo vuelve a subir.
2. Subida **en partes** (`uploads` → `chunks/{n}` → `complete`): Cloudflare corta cualquier
   request de más de 100 MB. Cada parte se reintenta con backoff ante errores de red o 5xx;
   un 4xx no se reintenta y el archivo va a `Error/`.
3. Consulta el ítem hasta que el análisis termina y avisa «Importado correctamente».

## Carpetas a Drive

Desde la 1.1.0 el agente también sincroniza carpetas locales con Google Drive (sólo local → Drive). Se
agregan en **Mi perfil → Prisma Agent → Carpetas a Drive**: carpeta de esta computadora + carpeta de Drive.
El agente hace una revisión completa al arrancar y cada 6 horas, y vigila cambios en vivo; el contenido se
manda directo a Google por una sesión de subida resumible (el agente no guarda credenciales de Google). Con
«Reflejar borrados», lo que borrás en la carpeta va a la papelera de Drive. Código en `src/drive-sync.js`;
detalle y guardas en `docs/PLAN-AGENT-DRIVE-SYNC.md`.

Desde el **menú del ícono → Carpetas a Drive** se hace lo mismo con clics: por cada carpeta, «Sincronizar
ahora», pausar/reanudar, «Cambiar carpeta local…» (selector nativo), reflejar borrados sí/no, abrirla y
confirmar/mantener los borrados frenados. **«Configurar / agregar carpeta…»** abre una pantalla local
(`src/config-ui.js`, servidor en 127.0.0.1 con un secreto en la ruta; reenvía al server con el token del
agente, que la página nunca ve) donde se da de alta una carpeta nueva —nombre, carpeta local con el selector
nativo, destino explorando Drive o creando una carpeta— y se ajustan o quitan las existentes. La pestaña **Importación de modelos** edita la carpeta del slicer (sólo esta computadora o todas), qué hacer con lo ya subido y las opciones de siempre, igual que Mi perfil → Prisma Agent → Slicer (`GET/PUT /slicer-settings`). La pestaña **Logs** de esa misma pantalla (lo que abre «Ajustes → Ver logs») muestra el final del log con filtros por área (Drive / importación), nivel y texto, en vivo y con copiar. Y por terminal:

Ajustes rápidos desde la terminal, sin abrir la web (`prisma-agent sync help`): `sync` lista y muestra el
estado; `sync scan|pause|resume <id|nombre>`, `sync path <id> <carpeta>`, `sync mirror <id> on|off`,
`sync rename`, `sync confirm|keep` (borrados frenados). Cambian lo mismo que Mi perfil (el server es la
fuente de verdad). El alta de una carpeta nueva sigue en la web porque necesita explorar Drive. Mientras
sube, el menú del ícono muestra «subiendo 12 de 340 · archivo.jpg» (con «+» hasta terminar de recorrer).

**Avance de la sincronización** (v1.1.0): cada tarjeta de la pantalla de config muestra el porcentaje, una barra y
chips con procesados / pendientes / subidos / con error y el archivo actual (`GET api/progress`, se actualiza cada
segundo; el avance sale de `SyncTask.progress` en `drive-sync.js`). Además aparece una **ventanita flotante** con lo
mismo, sumando todas las carpetas. Si la cerrás con la ✕ no vuelve (se guarda en `prefs.json` de la carpeta de
estado, `drive_progress_popup`, por computadora); se reactiva con el switch «Mostrar el progreso en una ventanita» de
la pestaña Sincronización Drive. Un click en el cuerpo de la ventanita sólo la oculta hasta el próximo cambio.

## Linux (Raspberry Pi, mini PC)

`install.sh` sirve para macOS y Linux (x64 y ARM64; una Raspberry necesita el sistema de 64 bits). En Linux no hay
ventanita ni bandeja. `prisma-agent install` deja una unidad `systemd --user` (`src/systemd.js`) y activa
`loginctl enable-linger` para que arranque al prender la máquina sin iniciar sesión. Log en
`~/.config/prisma-agent/prisma-agent.log`. Sin `DISPLAY`/`WAYLAND_DISPLAY` (o con `login --device`), el login usa un
**código de dispositivo**: la terminal muestra `ABCD-2345`, se ingresa en `/agent/link` desde otro equipo y el
agente recibe el token solo. Binarios `linux-x64` / `linux-arm64` (`build.sh`).

## Modo puente (impresoras en la LAN)

Con el puente prendido desde la web (Administración → Prisma Agent → Puentes) este agente lee las impresoras
Bambu asignadas por MQTT (`src/bridge/`) y le manda el estado al server por HTTPS (`POST /bridge/reports`). Hoy es
sólo lectura (fase 1 de `docs/PLAN-AGENT-BRIDGE.md`). `prisma-agent bridge status` muestra qué ve. Pruebas en
`docs/PRUEBAS-AGENT-BRIDGE.md`; los spikes (MQTT, FTPS, cámara) en `spikes/`.
