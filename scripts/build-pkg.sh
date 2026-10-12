#!/bin/zsh
# Builds the installer package. The app bundle is marked non-relocatable so Installer always writes
# to /Applications, even if another copy with the same bundle ID exists elsewhere (e.g. build/).
#
# Optional signing / notarization:
#   INSTALLER_IDENTITY=...  e.g. "Developer ID Installer: Name (TEAMID)"
#   NOTARY_PROFILE=...      keychain profile created with `xcrun notarytool store-credentials`, or
#   NOTARY_KEY_PATH / NOTARY_KEY_ID / NOTARY_ISSUER  an App Store Connect API key (CI)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/version.sh"
APP_PATH="$("$ROOT_DIR/scripts/build-app.sh" | tail -n 1)"
PKG_PATH="$ROOT_DIR/build/v$APP_VERSION/KeynoteLiveTranslator-$APP_VERSION.pkg"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/root"
ditto "$APP_PATH" "$WORK_DIR/root/$(basename "$APP_PATH")"
pkgbuild --analyze --root "$WORK_DIR/root" "$WORK_DIR/components.plist" >/dev/null
plutil -replace 0.BundleIsRelocatable -bool NO "$WORK_DIR/components.plist"

UNSIGNED_PKG="$WORK_DIR/unsigned.pkg"
pkgbuild \
  --root "$WORK_DIR/root" \
  --component-plist "$WORK_DIR/components.plist" \
  --install-location /Applications \
  --identifier local.keynote-live-translator \
  --version "$APP_VERSION" \
  "$UNSIGNED_PKG" >/dev/null

if [[ -n "${INSTALLER_IDENTITY:-}" ]]; then
  productsign --sign "$INSTALLER_IDENTITY" "$UNSIGNED_PKG" "$PKG_PATH" >/dev/null
else
  cp "$UNSIGNED_PKG" "$PKG_PATH"
fi

if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$PKG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$PKG_PATH"
elif [[ -n "${NOTARY_KEY_ID:-}" && -n "${NOTARY_KEY_PATH:-}" ]]; then
  # App Store Connect API key (used in CI).
  xcrun notarytool submit "$PKG_PATH" --key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait
  xcrun stapler staple "$PKG_PATH"
fi

echo "$PKG_PATH"
