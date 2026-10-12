#!/bin/zsh
# Single source of truth for the version: the VERSION file.
#   APP_VERSION   e.g. 0.4.0
#   BUILD_NUMBER  monotonically increasing integer (major*10000 + minor*100 + patch), also used as the
#                 Android versionCode and the macOS CFBundleVersion.
set -euo pipefail

VERSION_ROOT="$(cd "$(dirname "${(%):-%x}")/.." && pwd)"
APP_VERSION="$(tr -d '[:space:]' < "$VERSION_ROOT/VERSION")"
if [[ ! "$APP_VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  echo "VERSION must look like 1.2.3 (got: $APP_VERSION)" >&2
  exit 1
fi
IFS=. read -r VERSION_MAJOR VERSION_MINOR VERSION_PATCH <<< "$APP_VERSION"
BUILD_NUMBER=$(( VERSION_MAJOR * 10000 + VERSION_MINOR * 100 + VERSION_PATCH ))
export APP_VERSION BUILD_NUMBER
