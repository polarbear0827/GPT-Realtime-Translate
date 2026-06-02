#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
APP_NAME="Keynote Live Translator"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
export COPYFILE_DISABLE=1

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js executable not found. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources/node/bin"

cp "$NODE_BIN" "$APP_DIR/Contents/Resources/node/bin/node"
cp -R "$ROOT_DIR/server" "$APP_DIR/Contents/Resources/server"
cp -R "$ROOT_DIR/public" "$APP_DIR/Contents/Resources/public"

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
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Keynote Live Translator 需要麥克風來產生即時字幕與翻譯。</string>
</dict>
</plist>
PLIST

cat > "$APP_DIR/Contents/MacOS/KeynoteLiveTranslator" <<'LAUNCHER'
#!/bin/zsh
set -euo pipefail

APP_CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$APP_CONTENTS/Resources/node/bin/node"
SERVER="$APP_CONTENTS/Resources/server/index.mjs"
PORT="${KEYNOTE_TRANSLATOR_PORT:-8787}"
LOG_DIR="$HOME/Library/Logs/KeynoteLiveTranslator"
LOG_FILE="$LOG_DIR/server.log"
URL="http://127.0.0.1:$PORT/"

mkdir -p "$LOG_DIR"

if /usr/bin/curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  /usr/bin/open "$URL"
  exit 0
fi

PORT="$PORT" "$NODE" "$SERVER" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  /bin/kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for _ in {1..60}; do
  if /usr/bin/curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    /usr/bin/open "$URL"
    wait "$SERVER_PID"
    exit $?
  fi
  /bin/sleep 0.25
done

/usr/bin/osascript -e 'display alert "Keynote Live Translator 啟動失敗" message "本機 server 無法啟動，請查看 ~/Library/Logs/KeynoteLiveTranslator/server.log。"'
exit 1
LAUNCHER

chmod +x "$APP_DIR/Contents/MacOS/KeynoteLiveTranslator"

/usr/bin/dot_clean -m "$APP_DIR" >/dev/null 2>&1 || true

/usr/bin/codesign --force --deep --sign - "$APP_DIR" >/dev/null

echo "$APP_DIR"
