#!/usr/bin/env bash
# Arma los ejecutables de Prisma Agent (las computadoras que lo instalan no necesitan Node ni
# Bun: bajan el ejecutable ya armado) y los deja donde Prisma los sirve: /agent/install.sh,
# /agent/install.ps1 y /agent/download/*.
#
# Lo corre el botón «Publicar versión» de Mi perfil → Prisma Agent (job BuildPrismaAgent), o a
# mano en el servidor:
#
#   bash tools/prisma-agent/build.sh                 # → storage/app/private/agent-builds/<versión>
#   bash tools/prisma-agent/build.sh /otra/carpeta   # destino alternativo (/otra/carpeta/<versión>)
#
# Usa Bun (https://bun.sh) para compilar macOS (Apple e Intel), Windows y Linux (x64 y ARM) desde cualquier
# sistema. En Docker viene en la imagen (docker/php/Dockerfile); si no está, se baja solo a
# <destino>/.bun (no toca el sistema).
#
# Trabaja sobre una copia en <destino>/.work: en el contenedor el código es de root y el
# worker corre como www-data; storage/ sí se puede escribir (es un volumen).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$REPO/storage/app/private/agent-builds}"
BUN_VERSION="bun-v1.2.21"
LOCAL_BUN="$OUT/.bun"
WORK="$OUT/.work"

mkdir -p "$OUT"

# Corriendo desde la cola, HOME puede no existir o no ser escribible: cachés dentro de .bun.
if [ -z "${HOME:-}" ] || [ ! -w "${HOME:-/nonexistent}" ]; then export HOME="$LOCAL_BUN/home"; mkdir -p "$HOME"; fi
export BUN_INSTALL_CACHE_DIR="$LOCAL_BUN/cache"

if command -v bun >/dev/null; then
  BUN="$(command -v bun)"
elif [ -x "$LOCAL_BUN/bin/bun" ]; then
  BUN="$LOCAL_BUN/bin/bun"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) ASSET=bun-darwin-aarch64 ;;
    Darwin-x86_64) ASSET=bun-darwin-x64 ;;
    Linux-aarch64|Linux-arm64) ASSET=bun-linux-aarch64 ;;
    Linux-x86_64) ASSET=bun-linux-x64 ;;
    *) echo "No sé bajar Bun para $(uname -s)-$(uname -m): instalalo a mano (https://bun.sh)."; exit 1 ;;
  esac
  echo "Bajando Bun ($BUN_VERSION, $ASSET) a $LOCAL_BUN…"
  mkdir -p "$LOCAL_BUN/bin"
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/$BUN_VERSION/$ASSET.zip" -o "$TMP/bun.zip"
  if command -v unzip >/dev/null; then unzip -q "$TMP/bun.zip" -d "$TMP"; else python3 -m zipfile -e "$TMP/bun.zip" "$TMP"; fi
  mv "$TMP/$ASSET/bun" "$LOCAL_BUN/bin/bun"
  chmod +x "$LOCAL_BUN/bin/bun"
  rm -rf "$TMP"
  BUN="$LOCAL_BUN/bin/bun"
fi

# Copia de trabajo (el código puede no ser escribible).
rm -rf "$WORK"
mkdir -p "$WORK"
cp -R "$HERE/package.json" "$HERE/bin" "$HERE/src" "$WORK/"
cd "$WORK"
"$BUN" install --production
VERSION="$("$BUN" -e 'console.log(require("./package.json").version)')"
# Cada versión en su carpeta y sin pisar: se puede volver a una anterior desde Administración →
# Prisma Agent → Versiones. Una versión publicada no se rearma: subí la de package.json.
case "$VERSION" in
  *[!0-9.]*|.*|*.|*..*|"") echo "Versión inválida en package.json: «$VERSION» (tiene que ser x.y.z)."; exit 1 ;;
esac
DEST="$OUT/$VERSION"
if [ -f "$DEST/manifest.json" ] || grep -qs "\"version\":\"$VERSION\"" "$OUT/manifest.json"; then
  echo "La versión $VERSION ya está publicada: subí la versión en tools/prisma-agent/package.json."
  exit 1
fi
mkdir -p "$DEST"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
size() { wc -c < "$1" | tr -d ' '; }

# clave:target de Bun:archivo (sin arrays asociativos: la bash de macOS es la 3.2)
TARGETS="macos-arm64:bun-darwin-arm64:prisma-agent-macos-arm64
macos-x64:bun-darwin-x64:prisma-agent-macos-x64
windows-x64:bun-windows-x64:prisma-agent-windows-x64.exe
linux-x64:bun-linux-x64:prisma-agent-linux-x64
linux-arm64:bun-linux-arm64:prisma-agent-linux-arm64"

FILES=""
while IFS=: read -r key bun_target file; do
  echo "→ $key ($bun_target)"
  rm -f "$DEST/$file.tmp" "$DEST/$file.tmp.exe"
  "$BUN" build ./bin/prisma-agent.js --compile --minify --target="$bun_target" --outfile "$DEST/$file.tmp" < /dev/null  # sin stdin: si no, se comería la lista del while
  # Bun agrega .exe a los de Windows si el nombre no lo trae: se normaliza.
  if [ -f "$DEST/$file.tmp.exe" ]; then mv "$DEST/$file.tmp.exe" "$DEST/$file.tmp"; fi
  mv "$DEST/$file.tmp" "$DEST/$file"
  FILES="$FILES\"$key\":{\"file\":\"$file\",\"sha256\":\"$(sha "$DEST/$file")\",\"size\":$(size "$DEST/$file")},"
done <<< "$TARGETS"

printf '{"version":"%s","built_at":"%s","files":{%s}}\n' "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${FILES%,}" > "$DEST/manifest.json"

echo "✔ Prisma Agent $VERSION listo en $DEST"
