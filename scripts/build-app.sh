#!/bin/zsh
# Builds "Keynote Live Translator.app": a universal (arm64 + x86_64) Swift binary plus the web UI.
# No Node.js runtime is bundled; the app serves the UI itself and calls OpenAI natively.
#
# Signing:
#   default                 ad-hoc signature (local testing)
#   CODESIGN_IDENTITY=...   e.g. "Developer ID Application: Name (TEAMID)" → hardened runtime + entitlements
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/version.sh"
APP_NAME="Keynote Live Translator"
OUTPUT_DIR="$ROOT_DIR/build/v$APP_VERSION"
APP_DIR="$OUTPUT_DIR/$APP_NAME.app"
WORK_DIR="$(mktemp -d)"
MIN_MACOS="12.3"
export COPYFILE_DISABLE=1
trap 'rm -rf "$WORK_DIR"' EXIT

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

SOURCES=("$ROOT_DIR"/src/macos/*.swift)
for ARCH in arm64 x86_64; do
  xcrun swiftc -O -target "$ARCH-apple-macos$MIN_MACOS" "${SOURCES[@]}" \
    -framework AppKit -framework WebKit -o "$WORK_DIR/KeynoteLiveTranslator-$ARCH"
done
lipo -create -output "$APP_DIR/Contents/MacOS/KeynoteLiveTranslator" \
  "$WORK_DIR/KeynoteLiveTranslator-arm64" "$WORK_DIR/KeynoteLiveTranslator-x86_64"

rsync -a --exclude ".DS_Store" "$ROOT_DIR/public/" "$APP_DIR/Contents/Resources/public/"
cp "$ROOT_DIR/src/macos/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"
sed -e "s/__VERSION__/$APP_VERSION/" -e "s/__BUILD_NUMBER__/$BUILD_NUMBER/" \
  "$ROOT_DIR/src/macos/Info.plist" > "$APP_DIR/Contents/Info.plist"
plutil -lint "$APP_DIR/Contents/Info.plist" >/dev/null

/usr/bin/xattr -cr "$APP_DIR" 2>/dev/null || true
if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp \
    --entitlements "$ROOT_DIR/src/macos/KeynoteLiveTranslator.entitlements" \
    --sign "$CODESIGN_IDENTITY" "$APP_DIR"
else
  codesign --force --sign - "$APP_DIR"
fi
codesign --verify --strict "$APP_DIR"

echo "$APP_DIR"
