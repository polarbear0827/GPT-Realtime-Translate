#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(cat "$ROOT_DIR/VERSION")"

if ! command -v gradle >/dev/null 2>&1; then
  echo "Gradle not found. Use GitHub Actions or install Gradle + Android SDK locally." >&2
  exit 1
fi

gradle -p "$ROOT_DIR/android" assembleDebug
mkdir -p "$ROOT_DIR/build/v$VERSION"
cp "$ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk" "$ROOT_DIR/build/v$VERSION/KeynoteLiveTranslator-android-$VERSION-debug.apk"
echo "$ROOT_DIR/build/v$VERSION/KeynoteLiveTranslator-android-$VERSION-debug.apk"
