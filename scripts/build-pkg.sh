#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
APP_PATH="$("$ROOT_DIR/scripts/build-app.sh")"
PKG_PATH="$BUILD_DIR/KeynoteLiveTranslator-0.1.0.pkg"

/usr/bin/xattr -cr "$APP_PATH" >/dev/null 2>&1 || true

/usr/bin/pkgbuild \
  --component "$APP_PATH" \
  --install-location /Applications \
  --identifier local.keynote-live-translator \
  --version 0.1.0 \
  "$PKG_PATH"

echo "$PKG_PATH"
