#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
VERSION="$(cat "$ROOT_DIR/VERSION")"
APP_NAME="Keynote Live Translator"
VERSION_BUILD_DIR="$BUILD_DIR/v$VERSION"
APP_DIR="$VERSION_BUILD_DIR/$APP_NAME.app"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SWIFT_SRC="$ROOT_DIR/src/macos/KeynoteLiveTranslator.swift"
export COPYFILE_DISABLE=1

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js executable not found. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$VERSION_BUILD_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources/node/bin"

cp "$NODE_BIN" "$APP_DIR/Contents/Resources/node/bin/node"
cp -R "$ROOT_DIR/server" "$APP_DIR/Contents/Resources/server"
cp -R "$ROOT_DIR/public" "$APP_DIR/Contents/Resources/public"
/usr/bin/swiftc "$SWIFT_SRC" -framework AppKit -framework WebKit -o "$APP_DIR/Contents/MacOS/KeynoteLiveTranslator"

cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_TW</string>
  <key>CFBundleDisplayName</key>
  <string>Keynote Live Translator</string>
  <key>CFBundleExecutable</key>
  <string>KeynoteLiveTranslator</string>
  <key>CFBundleIdentifier</key>
  <string>local.keynote-live-translator</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Keynote Live Translator</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>VERSION_PLACEHOLDER</string>
  <key>CFBundleVersion</key>
  <string>2</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Keynote Live Translator 需要麥克風來產生即時字幕與翻譯。</string>
</dict>
</plist>
PLIST

/usr/bin/sed -i '' "s/VERSION_PLACEHOLDER/$VERSION/g" "$APP_DIR/Contents/Info.plist"

chmod +x "$APP_DIR/Contents/MacOS/KeynoteLiveTranslator"

/usr/bin/dot_clean -m "$APP_DIR" >/dev/null 2>&1 || true

/usr/bin/codesign --force --deep --sign - "$APP_DIR" >/dev/null

echo "$APP_DIR"
