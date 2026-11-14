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

## 1.1.26 (beta) — 2026-11-13

- Drive, bajada (`PullTask.download`, también usada por los dos sentidos): una bajada de `COORDENADAS3D.zip` (1,4 GB) terminó con 2,9 GB escritos
  («bajó 2911914436 de 1443459739 bytes») aunque Drive no cambió de tamaño. Causa sin confirmar (algún reintento con `Range` que llegó mal).
  Ahora: una respuesta 206 cuyo `Content-Range` no empieza en el `offset` pedido se descarta y se reintenta sin escribir; y si llegan más bytes
  que `entry.size` se corta con `Fatal('llegaron más bytes de los esperados')` en vez de seguir llenando el disco.
- Pendiente (no incluido): `BothTask.scan()` usa `plan.decided` sin revisar si la respuesta de `/both/reconcile` vino vacía (visto el 12/11
  19:56 tras 3 min de espera: «null is not an object (evaluating 'W.decided')»).

## 1.1.25 (beta) — 2026-11-12

- Puente: `ftp.put` sube con **`curl`** como proceso hijo (`uploadCurl`) en vez de `basic-ftp`. Con el mismo archivo curl subía 3 MB a «auma»
  a ~150 KB/s sin problema y `basic-ftp` dejaba a la impresora sin atender (MQTT mudo, subida que no terminaba, sin error). El access code va por
  stdin (`-K -`), nunca en los argumentos; el avance sale del medidor `-#`. Mantiene el perro guardián de 60 s, el chequeo de llegada por tamaño
  y el reintento por 550. Si no hay `curl` en el PATH cae a `basic-ftp` como antes.
- Cámara del puente: si abre y no llega ningún frame («no mandó datos»), esa impresora queda 10 min sin reintentos (`CameraService.cooldown`).
  Antes se abría cada ~1,5 min con el monitor abierto y cargaba a la impresora.
- Log `[ftp-debug]` cada 10 s durante la subida: bytes, velocidad y segundos desde el último avance (DIAGNÓSTICO, sacar cuando se entienda).

## 1.1.24 (beta) — 2026-11-12

- Log del puente: cada comando informado muestra su origen (`web: usuario · /ruta` o `cli: comando · clase`), que el server
  agrega al payload (`origin`). Sirve para saber quién pide cada `camera.watch` o `mqtt.*`.

## 1.1.23 (beta) — 2026-11-11

- Puente (DIAGNÓSTICO TEMPORAL, líneas `[mqtt-debug]` en el log): ciclo de vida del MQTT de cada impresora (connect, reconnect, disconnect, end, caída con
  segundos sin reportes), aviso cada 60 s si está «conectado» pero la A1 no manda reportes (no reconecta, sólo avisa), y cada `mqtt.publish` /
  `mqtt.request` con su comando, el estado del enlace y el resultado (publicado / respondió / sin respuesta). Para entender por qué la impresora queda
  «Sin conexión» tras una subida de archivo. Sacar cuando se entienda.

## 1.1.22 (beta) — 2026-11-11

- Puente: `ftp.put` y el resto de las operaciones FTPS fuerzan PASV clásico (`prepareTransfer = enterPassiveModeIPv4`), como el `curl` del server
  (`CURLOPT_FTP_USE_EPSV=false`); `basic-ftp` probaba EPSV primero y las Bambu lo manejan mal.
- Puente: terminados los bytes de `ftp.put`, mientras se espera el «226» se consulta el tamaño por otra conexión cada 10 s; con el archivo
  completo en 2 consultas seguidas se cierra el control y se da el envío por hecho (antes se esperaba hasta 5 min el «226» y recién ahí `arrivedIntact`).

## 1.1.21 (beta) — 2026-11-11

- Puente: si `ftp.put` da `Timeout (control socket)` (la A1 no contestó el «226» tras el último byte), antes de fallar se le pregunta el
  tamaño del archivo con una conexión nueva (hasta 6 veces, cada 10 s, `FtpService.arrivedIntact`). Si está completo se da el envío por
  hecho y sigue con el comando de imprimir; si no, falla como siempre. Visto 11/11: el archivo había llegado y hubo que reiniciar y reenviar.

## 1.1.20 (beta) — 2026-11-09

- Puente: se saca la pausa del `pushall` MQTT durante las transferencias (1.1.19): era una hipótesis sin evidencia y dejaba a las otras impresoras sin estado. Se mantiene el resto de la 1.1.19.

## 1.1.19 (beta) — 2026-11-09

- Puente: el progreso del envío informa dos pasos (`phase` en `POST /bridge/commands/{id}/progress`): `download` (server → puente) y `upload` (puente → impresora).
- Puente: durante `ftp.put`/`ftp.get` se pausa el `pushall` MQTT de todas las impresoras (`MqttLink.quiet()`); al terminar pide un estado completo. Una A1 con FTPS + MQTT + cámara dejaba de contestar.
- Puente: la cámara loguea «en vivo» recién con el primer frame (antes al abrir la sesión) y `camera.watch` falla si la impresora no está conectada por MQTT.
- Modo sólo puente (`PRISMA_AGENT_BRIDGE_ONLY=1`): `notify()` no hace nada y se descartan avisos de escritorio, selector de carpeta, demo, contadores y Drive que llegan de `/commands`.

## 1.1.18 (beta) — 2026-11-09

- Puente: más paciencia al subir a la impresora. Tras el último byte de un `ftp.put` la A1 descomprime/graba el 3MF antes de contestar «226» y puede
  tardar más de 3 min (con la pantalla lenta o colgada y sin atender MQTT). El timeout del canal de control pasó de 180 s a 5 min
  (`CONTROL_TIMEOUT_PUT_MS`) y el tope duro de `ftp.put`/`ftp.get` de 6 a 9 min, para que no corte antes que el control.
- Motivo: en la prueba del 09/11 una subida de 1 MB a «Prisma» llegó al 100% y murió con «Timeout (control socket)» a los 3 min sin que el
  archivo se grabara; la impresora dejó de reportar por MQTT mientras duró. Si sigue pasando con 5 min, la causa es otra (ver el log del puente).

## 1.1.17 (beta) — 2026-11-09

- Puente: tope duro por comando FTP (`FtpService.withHardLimit`): 6 min para `ftp.put`/`ftp.get` y 90 s para el resto. Corre con `Promise.race`,
  sin depender de que `basic-ftp` rechace su promesa: al vencer cierra los clientes abiertos de esa impresora (`FtpService.clients`), devuelve un error
  claro y libera la cola única de transferencias (`exclusive`) y las pausas de cámara.
- Motivo: un `ftp.put` colgado (la subida «empieza» y no termina) dejaba trabada la cola para siempre y el puente no volvía a transferir hasta
  reiniciarlo. El perro guardián de 60 s de 1.1.15 no alcanzó en ese caso. La causa de fondo del cuelgue sigue sin confirmarse; si el tope
  salta, queda en el log («pasó el tope de … s») para investigarla.

## 1.1.16 (beta) — 2026-11-09

- Puente: las cámaras se cortan antes y durante los envíos de archivos. Cada comando `ftp.*` pausa la cámara de su impresora (antes sólo
  `ftp.put`/`ftp.get`, y el `ftp.size` previo a un envío la encontraba viva) y `ftp.put`/`ftp.get` pausan las de **todas** las
  impresoras del puente (`CameraService.holdAll`/`releaseAll`), porque hay una sola transferencia a la vez y un solo Wi-Fi/máquina.
- `CameraService`: las pausas pasan de `Set` a contador por impresora (`hold`/`release`) más un contador global, para que comandos FTP
  que se solapan no se suelten unos a otros. `watch` y `snapshot` consultan `isHeld()`.
- Motivo: tras un envío el siguiente no arrancaba sin reiniciar el puente (subida que empieza y no termina, con las cámaras de las dos
  impresoras reconectando cada ~13 s). Causa no confirmada: esta beta es para probarlo.

## 1.1.15 (beta) — 2026-11-08

- Puente: `ftp.put` ya no queda colgado cuando la impresora deja de recibir datos. **Perro guardián**: sin un solo byte nuevo en 60 s se
  cierra la conexión y falla con un mensaje claro (antes retenía la cola única de transferencias y la cámara de esa impresora hasta los
  180 s del control, y el server ya lo había dado por muerto a los 90 s: «dejó de informar avance»).
- **Latido cada 15 s** durante la subida (mismo `/progress` con lo último conocido), para que la espera legítima del «226» (la impresora
  graba el archivo) no se tome como envío muerto. Logs por etapa: conectado por FTPS / enviado, verificando tamaño.

## 1.1.14 (beta) — 2026-11-06

- Puente: **timeout en todos los pedidos a la API** (`Api.request`: 30 s; 5 min para subidas/bajadas de archivos y chunks). Antes
  un `fetch` sobre una conexión a medias (Wi-Fi, suspensión, red de Docker) no volvía nunca y dejaba `Bridge.sending` y
  `CommandRunner.polling` en `true` para siempre: sin latido (el server lo daba por caído a los 3 min) ni cola de comandos
  (impresiones que cargaban y no iniciaban), mientras la cámara seguía andando por su propio camino. Ahora el pedido vence con un
  `ApiError` reintentable («El servidor no contestó en N s») y el siguiente tick retoma solo.

## 1.1.13 (beta) — 2026-11-06

- Puente: cuando el MQTT de una impresora **no logra conectar**, el log ahora dice por qué:
  `«Prisma» no conecta por MQTT (IP:8883): <motivo> [código]`, una línea por cambio de motivo (no una cada 5 s). Antes `mqtt-link.js`
  reintentaba cada 5 s en silencio y sólo se logueaba perder una conexión ya establecida, así que una impresora con la cámara en vivo
  pero «sin datos» (MQTT caído) no dejaba ninguna pista en el log. Sin cambios de comportamiento: sólo diagnóstico.

## 1.1.12 (beta) — 2026-11-05

- Puente: ante un `550` de la impresora en `ftp.put` (rechazó escribir el archivo; típico de un homónimo a medias bloqueado tras un envío cortado)
  borra el archivo remoto y reintenta **una vez**. Si vuelve a rechazar, el error explica las causas probables (SD ausente/llena/protegida,
  impresora ocupada) en vez de mostrar sólo «550». `withClient` conserva el código FTP del error (`err.code`).

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
