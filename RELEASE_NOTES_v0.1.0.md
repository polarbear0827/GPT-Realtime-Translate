# Keynote Live Translator v0.1.0

First release of Keynote Live Translator, a local-first realtime caption tool for keynote and presentation use.

## Highlights

- Bilingual realtime subtitles:
  - English source captions from `gpt-realtime-whisper`.
  - Traditional Chinese translation from `gpt-realtime-translate`.
- Three display modes:
  - Bilingual.
  - Traditional Chinese only.
  - English only.
- Transcript recording with SRT export for video editing.
- Local-only API key handling:
  - The API key is accepted by a localhost server.
  - It is kept in memory only.
  - It is exchanged for short-lived Realtime client secrets.
  - It is not written to disk or browser storage.
- macOS `.pkg` installer.

## Install

Download `KeynoteLiveTranslator-0.1.0.pkg` from this release, open it, and install the app into `/Applications`.

## Before a keynote

1. Open `Keynote Live Translator`.
2. Paste your own OpenAI API key.
3. Select the caption mode.
4. Click `測試麥克風`.
5. Click `Start`.
6. Use `Export` to save SRT or transcript files after the session.

## Notes

- This package uses an ad-hoc local signature. If macOS blocks the first launch, open it from Finder with right-click > Open.
- Browser microphone permission is required because the app opens a local browser UI.
- The installer is not notarized yet.
