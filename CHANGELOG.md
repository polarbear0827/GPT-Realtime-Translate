# Changelog

## v0.2.0 - 2026-06-03

- Added a real macOS window using Swift AppKit and WKWebView.
- The app now opens inside its own desktop window instead of launching an external browser.
- Added source caption language selection for `gpt-realtime-whisper`.
- Added translation target language selection for `gpt-realtime-translate`.
- Added English and Traditional Chinese UI presets for source and target language selection.
- Updated caption modes to be language-agnostic:
  - Bilingual captions.
  - Translation only.
  - Source only.
- Updated transcript labels and SRT export to use selected languages.
- Added backend validation for supported translation and transcription language codes.

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
