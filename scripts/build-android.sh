#!/bin/zsh
# Builds the Android APK. With ANDROID_KEYSTORE_FILE (+ passwords/alias) set, builds a release APK signed
# with that stable key; otherwise a debug APK (debug keys differ per machine, so it can't upgrade an
# install signed elsewhere).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/scripts/version.sh"
OUTPUT_DIR="$ROOT_DIR/build/v$APP_VERSION"

if ! command -v gradle >/dev/null 2>&1; then
  echo "Gradle not found. Use GitHub Actions or install Gradle + Android SDK locally." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
if [[ -n "${ANDROID_KEYSTORE_FILE:-}" ]]; then
  gradle -p "$ROOT_DIR/android" assembleRelease
  OUTPUT="$OUTPUT_DIR/KeynoteLiveTranslator-android-$APP_VERSION.apk"
  cp "$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk" "$OUTPUT"
else
  gradle -p "$ROOT_DIR/android" assembleDebug
  OUTPUT="$OUTPUT_DIR/KeynoteLiveTranslator-android-$APP_VERSION-debug.apk"
  cp "$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk" "$OUTPUT"
fi
echo "$OUTPUT"
