#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
VERSION="$(cat "$ROOT_DIR/VERSION")"
APP_PATH="$("$ROOT_DIR/scripts/build-app.sh")"
PKG_PATH="$BUILD_DIR/v$VERSION/KeynoteLiveTranslator-$VERSION.pkg"

/usr/bin/xattr -cr "$APP_PATH" >/dev/null 2>&1 || true

/usr/bin/pkgbuild \
  --component "$APP_PATH" \
  --install-location /Applications \
  --identifier local.keynote-live-translator \
  --version "$VERSION" \
  "$PKG_PATH"

echo "$PKG_PATH"
