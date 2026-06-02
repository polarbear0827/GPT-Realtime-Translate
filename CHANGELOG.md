# Changelog

## v0.1.0 - 2026-06-02

- Initial public release.
- Added dual-track realtime captions:
  - `gpt-realtime-whisper` for English source captions.
  - `gpt-realtime-translate` for Traditional Chinese translation.
- Added three caption modes:
  - Bilingual captions.
  - Traditional Chinese translation only.
  - English captions only.
- Added transcript recording and export:
  - Markdown.
  - Text.
  - JSON.
  - SRT Traditional Chinese.
  - SRT English.
  - SRT bilingual.
- Added local-only API key handling through short-lived Realtime client secrets.
- Added macOS `.app` and `.pkg` build scripts.
- Added OpenCC Traditional Chinese conversion fallback.
