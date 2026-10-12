# Changelog

## v0.4.0 - 2026-10-12

### Models
- Source captions now use `gpt-live-transcribe` (replaces `gpt-realtime-whisper`), with `languages`,
  optional keywords and context prompt. Translation stays on `gpt-realtime-translate`.
- Speech turns are committed by a client-side voice activity detector instead of every 900 ms.
- Option to take bilingual source text from the translation session (about half the audio cost).

### Fixes
- macOS: Export, Clear Transcript and Fullscreen now work; ⌘C/⌘V/⌘Q work (app now has a main menu).
- Transcript entries no longer repeat earlier segments; repeated characters (謝謝, 100%) are kept.
- Chinese conversion no longer changes 公里/皇后/划船…, and phrases split across deltas convert correctly.
- SRT cues are at most 7 s / 2 lines in every mode, bilingual cues stay aligned, no empty cues.
- Start no longer wipes the previous transcript; the timeline continues.
- Errors no longer leave connections running with Stop disabled; Stop during startup cancels it.
- Microphone selection is kept (and remembered) after testing or starting.
- Layout no longer breaks at the default window size; panels no longer overlap the toolbar.

### Security
- Dev server checks Host, Origin, Content-Type and a per-launch token (DNS rebinding / CSRF).
- macOS: Node.js removed; the native app serves static files only and handles the API key over a
  WKWebView bridge. Android: no local server or cleartext traffic; assets are served in-process.
- Microphone permission and navigation are limited to the app's own page.
- Optional "remember key" in the macOS Keychain / Android Keystore.

### Reliability & performance
- Automatic reconnect, rotation before the 60-minute session limit, graceful stop that keeps the last sentence.
- Audio processing moved to an AudioWorklet with an anti-aliased 24 kHz resampler.
- Transcript panel renders incrementally; captions render once per frame.
- Keeps the display awake while live; warns after 20 s without audio; auto-backup of the transcript.

### UI
- Consistent Traditional Chinese UI, single Start/Stop button, connection status, level meter, timer.
- Settings and transcript drawers, export menu, presentation mode, caption window for a second screen,
  keyboard shortcuts, 13 languages, configurable mic processing and noise reduction.

### Engineering
- Frontend split into ES modules; shared `realtime-config.json` for all backends.
- Tests: unit, server security, session controller, Swift↔Node contract, offscreen WKWebView bridge test.
- Version read from `VERSION` everywhere; universal macOS build (~2 MB, was 115 MB); non-relocatable pkg;
  optional Developer ID signing/notarization and stable Android release signing in CI; Node 24 in CI.

## v0.3.0 - 2026-06-04

- Added an Android app project using native Java Activity + WebView.
- Added an Android localhost server that mirrors the desktop security model:
  - API key is stored in memory only.
  - Server binds only to `127.0.0.1`.
  - Realtime client secrets are created inside the app-local server.
- Added Android microphone and network permissions.
- Added Android-friendly responsive UI refinements for smaller portrait screens.
- Added Android APK build script and GitHub Actions Android build steps.
- Updated Release workflow to attach both macOS `.pkg` and Android `.apk` assets.

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
