#!/bin/zsh
# Runs the macOS host in an offscreen WKWebView with the real web UI and checks the native bridge and
# the static server (see tests/macos/main.swift).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

xcrun swiftc \
  "$ROOT_DIR/src/macos/StaticServer.swift" \
  "$ROOT_DIR/src/macos/RealtimeBackend.swift" \
  "$ROOT_DIR/src/macos/KeychainStore.swift" \
  "$ROOT_DIR/src/macos/NativeBridge.swift" \
  "$ROOT_DIR/src/macos/CaptionOverlay.swift" \
  "$ROOT_DIR/src/macos/SystemAudioCapture.swift" \
  "$ROOT_DIR/src/macos/TranslationSocket.swift" \
  "$ROOT_DIR/tests/macos/main.swift" \
  -framework AppKit -framework WebKit -o "$WORK_DIR/bridge-harness"
"$WORK_DIR/bridge-harness" "$ROOT_DIR/public"
