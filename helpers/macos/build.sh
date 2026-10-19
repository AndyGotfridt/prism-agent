#!/usr/bin/env bash
# Compila PrismaNotify.app (universal arm64 + x86_64, firma ad hoc) y la empaqueta en
# PrismaNotify.tar.gz, que se versiona y el build del agente embebe en el ejecutable.
# Hay que correrlo en una Mac (necesita swiftc). Sólo cuando cambie Sources/ o Info.plist.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/PrismaNotify"
OUT="$(mktemp -d)"
APP="$OUT/PrismaNotify.app"
mkdir -p "$APP/Contents/MacOS"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13.0" "$SRC/Sources/main.swift" -o "$OUT/PrismaNotify-$arch"
done
lipo -create "$OUT/PrismaNotify-arm64" "$OUT/PrismaNotify-x86_64" -output "$APP/Contents/MacOS/PrismaNotify"
cp "$SRC/Info.plist" "$APP/Contents/Info.plist"
# Mismo ícono que el lanzador del agente (src/app-icon.js).
mkdir -p "$APP/Contents/Resources"
node --input-type=module -e "import { APP_ICON_PNG_BASE64 as b } from '$HERE/../../src/app-icon.js'; process.stdout.write(Buffer.from(b, 'base64'))" > "$OUT/AppIcon.png"
sips -s format icns "$OUT/AppIcon.png" --out "$APP/Contents/Resources/AppIcon.icns" >/dev/null
codesign --force --sign - --identifier com.prisma3d.agent.notify "$APP"
# Sin atributos extendidos de macOS (COPYFILE_DISABLE) para que el tar sea portable.
COPYFILE_DISABLE=1 tar -C "$OUT" -czf "$HERE/PrismaNotify.tar.gz" PrismaNotify.app
shasum -a 256 "$HERE/PrismaNotify.tar.gz" | cut -d' ' -f1 > "$HERE/PrismaNotify.sha256"
rm -rf "$OUT"
echo "✔ $HERE/PrismaNotify.tar.gz ($(cut -c1-12 "$HERE/PrismaNotify.sha256"))"
