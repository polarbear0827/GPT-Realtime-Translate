# Keynote Live Translator

Keynote Live Translator is a local-first realtime subtitle tool for talks, demos, and keynote presentations.

It listens to an English speaker and can show:

- English source captions.
- Traditional Chinese translation.
- Bilingual English + Traditional Chinese captions.

The app uses OpenAI Realtime models:

- `gpt-realtime-whisper` for English source captions.
- `gpt-realtime-translate` for Traditional Chinese translation.

## Features

- Three caption modes:
  - Bilingual captions.
  - Translation only.
  - Source captions only.
- Source caption language selector:
  - English.
  - Chinese.
- Translation target language selector:
  - Traditional Chinese.
  - English.
- Resizable subtitle layout.
- Adjustable English and Chinese font sizes.
- Auto-scroll captions to the latest text.
- Transcript side panel.
- Export formats:
  - Markdown.
  - Text.
  - JSON.
  - SRT Traditional Chinese.
  - SRT English.
  - SRT bilingual.
- Local macOS `.app` and `.pkg` build scripts.
- API key is entered by the user at runtime and is not embedded in the app.

## Security Model

This project is designed for live presentation use where API key handling must stay simple and safe.

- The server listens only on `127.0.0.1`.
- The OpenAI API key is stored in memory only.
- The API key is not written to files.
- The API key is not stored in browser localStorage/sessionStorage.
- The API key is exchanged for short-lived Realtime client secrets.
- The desktop window connects to OpenAI with short-lived client secrets, not the long-lived API key.
- Static files are served with restrictive security headers.

Do not commit API keys, `.env` files, logs, or exported transcripts that contain private content.

## Installation From GitHub Releases

1. Go to the GitHub Releases page for this repository.
2. Download `KeynoteLiveTranslator-0.2.0.pkg`.
3. Open the `.pkg` file.
4. Follow the installer steps. The app will be installed to `/Applications`.
5. Open `Keynote Live Translator` from `/Applications`.

If macOS blocks the app because it is not notarized yet:

1. Open Finder.
2. Go to `/Applications`.
3. Right-click `Keynote Live Translator`.
4. Choose `Open`.
5. Confirm that you want to open it.

## First Run

1. Open `Keynote Live Translator`.
2. The app opens its own desktop window.
3. Click `輸入金鑰`.
4. Paste your OpenAI API key.
5. Choose a caption mode:
   - `雙語字幕`
   - `只顯示翻譯`
   - `只顯示原文`
6. Choose source caption language:
   - `English`
   - `中文`
7. Choose translation target language:
   - `繁體中文`
   - `English`
8. Open `進階設定`.
9. Click `測試麥克風`.
10. If the microphone test succeeds, click `Start`.

## Recommended Keynote Setup

Before going on stage:

1. Plug in the microphone or audio interface you will use.
2. Open the app.
3. Paste the OpenAI API key.
4. Select `雙語字幕` for English + Traditional Chinese.
5. Use `測試麥克風` to confirm macOS microphone permission.
6. Speak for 10-20 seconds and verify:
   - English appears in the top caption area.
   - Traditional Chinese appears in the bottom caption area.
   - Chinese output is Traditional Chinese.
7. Use `Fullscreen` for the presentation display.
8. Keep `Record` enabled if you need transcripts or SRT export.

## Caption Modes

### Bilingual Captions

Runs both realtime tracks:

- `gpt-realtime-whisper` creates source-language captions.
- `gpt-realtime-translate` creates target-language translation.

This mode is best for live audience subtitles and post-event video editing.

### Translation Only

Runs only `gpt-realtime-translate`.

This mode is cheaper than bilingual mode and keeps the display focused on the selected translation target language.

### Source Only

Runs only `gpt-realtime-whisper`.

This mode is useful when you only need source captions or want a clean source-language transcript.

## Exporting Transcripts And SRT

After or during a session, use the `Export` menu:

- `Markdown`: bilingual readable transcript.
- `Text`: plain bilingual transcript.
- `JSON`: structured transcript data.
- `SRT 繁中`: Traditional Chinese subtitles.
- `SRT English`: English subtitles.
- `SRT 雙語`: English and Traditional Chinese subtitles in one SRT.

For video editing, use one of the SRT formats.

## Microphone Permissions

The app opens a real macOS desktop window. Microphone permission is controlled by macOS for `Keynote Live Translator`.

If you see a permission error:

1. On macOS, open `系統設定 > 隱私權與安全性 > 麥克風`.
2. Enable microphone access for `Keynote Live Translator`.
3. Restart the app.
4. Click `測試麥克風`.
5. Click `Start` again.

If the microphone is still unavailable, close other apps that may be using the microphone, such as conferencing apps or recording tools.

## Local Development

Requirements:

- macOS for `.app` and `.pkg` builds.
- Node.js 20 or newer.

Start the local web app:

```bash
npm run start
```

Open:

```text
http://127.0.0.1:8787/
```

Run syntax checks:

```bash
npm run check
```

Build the macOS app:

```bash
npm run build:app
```

Build the installer package:

```bash
npm run build:pkg
```

The generated files are placed in `build/`.

## Build Notes

The `.app` contains:

- A Swift AppKit/WKWebView desktop launcher.
- The local Node.js server.
- The static responsive UI.
- A bundled Node.js runtime copied from the build machine.

The `.pkg` installs the `.app` into `/Applications`.

This first release uses an ad-hoc local signature. For public distribution outside trusted machines, use a Developer ID certificate and notarize the package.

## Versioning

This repository uses semantic versioning.

- Current version: `0.2.0`.
- Version source: `package.json` and `VERSION`.
- Release notes: `RELEASE_NOTES_v0.2.0.md`.
- Changelog: `CHANGELOG.md`.

Release flow:

1. Update `package.json`.
2. Update `VERSION`.
3. Update `CHANGELOG.md`.
4. Add release notes for the new version.
5. Build the `.pkg`.
6. Tag the release, for example `v0.2.0`.
7. Upload the `.pkg` to GitHub Releases.

## Troubleshooting

### The API key modal appears every time

This is expected after restarting the local server. The API key is kept in memory only for security.

### Chinese output is Simplified Chinese

The app runs local Traditional Chinese conversion before displaying and exporting text. If you still see Simplified Chinese terms, add them to the fallback conversion map in `public/app.js`.

### English captions do not appear

Use `雙語字幕` or `純英文字幕`. English captions are generated by the Whisper realtime track, not by the translation track.

### The app opens but Start fails

Check:

- API key is valid.
- Microphone permission is granted.
- Internet access to `api.openai.com` is available.
- No other app is locking the microphone.

## License

Private/internal project unless a license is added.
