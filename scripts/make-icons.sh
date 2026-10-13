#!/bin/zsh
# Regenerates every icon from assets/logo.png (see scripts/make-icons.swift).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

xcrun swiftc -O "$ROOT_DIR/scripts/make-icons.swift" -o "$WORK_DIR/make-icons"
"$WORK_DIR/make-icons" "$ROOT_DIR" "$WORK_DIR"
iconutil -c icns "$WORK_DIR/AppIcon.iconset" -o "$ROOT_DIR/src/macos/AppIcon.icns"
cp "$WORK_DIR/AppIcon-1024.png" "$ROOT_DIR/assets/app-icon.png"
echo "src/macos/AppIcon.icns, assets/app-icon.png, public/icons/, relay/public/ icons updated"
