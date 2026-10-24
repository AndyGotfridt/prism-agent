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
