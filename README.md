# Keynote Live Translator

Local-first realtime subtitles for keynote talks, demos, and live presentations.

The app supports:

- Source captions from `gpt-realtime-whisper`.
- Realtime translation from `gpt-realtime-translate`.
- Bilingual captions, translation-only captions, or source-only captions.
- macOS desktop window builds.
- Android WebView app builds.

## Current Version

`0.3.0`

## Security Model

- The OpenAI API key is entered by the user at runtime.
- The API key is kept in memory only.
- The API key is not embedded in the app.
- The API key is not written to disk.
- The API key is not stored in browser/WebView localStorage.
- The local server listens only on `127.0.0.1`.
- The local server exchanges the API key for short-lived Realtime client secrets.
- The UI connects to OpenAI with short-lived client secrets, not the long-lived API key.

## Caption Modes

### Bilingual Captions

Runs both realtime tracks:

- `gpt-realtime-whisper` creates source captions.
- `gpt-realtime-translate` creates translated captions.

### Translation Only

Runs only `gpt-realtime-translate` and displays the selected translation language.

### Source Only

Runs only `gpt-realtime-whisper` and displays source-language captions.

## Language Options

The UI currently exposes:

- Source captions: English, Chinese.
- Translation target: Traditional Chinese, English.

The backend keeps a whitelist for the official `gpt-realtime-translate` output languages, so more target languages can be added later without changing the architecture.

## Install On macOS

1. Go to GitHub Releases.
2. Download `KeynoteLiveTranslator-0.3.0.pkg`.
3. Open the `.pkg` file.
4. Install `Keynote Live Translator` into `/Applications`.
5. Open the app.

If macOS blocks the app because it is not notarized yet:

1. Open Finder.
2. Go to `/Applications`.
3. Right-click `Keynote Live Translator`.
4. Choose `Open`.
5. Confirm launch.

### macOS Microphone Permission

1. Open `System Settings > Privacy & Security > Microphone`.
2. Enable `Keynote Live Translator`.
3. Restart the app.
4. Click `測試麥克風`.
5. Click `Start`.

## Install On Android

1. Go to GitHub Releases.
2. Download `KeynoteLiveTranslator-android-0.3.0-debug.apk`.
3. Open the APK on your Android phone.
4. If Android asks for permission to install unknown apps, allow it for the file manager or browser you are using.
5. Install and open `Keynote Live Translator`.

This APK is a debug-signed build for direct installation and testing. For Play Store or enterprise distribution, create a properly signed release build.

### Android Microphone Permission

1. Open the app.
2. Allow microphone permission when Android asks.
3. If permission was denied, open `Settings > Apps > Keynote Live Translator > Permissions`.
4. Enable `Microphone`.
5. Reopen the app and click `測試麥克風`.

## First Run

1. Open `Keynote Live Translator`.
2. Click `輸入金鑰`.
3. Paste your OpenAI API key.
4. Select caption mode.
5. Select source caption language.
6. Select translation target language.
7. Open `進階設定`.
8. Click `測試麥克風`.
9. Click `Start`.

## Export

Use `Export` to save:

- Markdown transcript.
- Plain text transcript.
- JSON transcript.
- SRT source captions.
- SRT translation captions.
- SRT bilingual captions.

## Local Development

Requirements:

- Node.js 20 or newer for the web/local server.
- macOS + Swift toolchain for macOS packaging.
- Android SDK + Gradle for local Android APK builds.

Run the local web app:

```bash
npm run start
```

Check JavaScript syntax:

```bash
npm run check
```

Build macOS pkg:

```bash
npm run build:pkg
```

Build Android APK locally:

```bash
npm run build:android
```

If Gradle or Android SDK is not installed locally, use GitHub Actions. The CI workflow builds the Android APK on Ubuntu.

## Release Flow

1. Update `VERSION`.
2. Update `package.json`.
3. Update Android `versionName` / `versionCode` in `android/app/build.gradle`.
4. Update `CHANGELOG.md`.
5. Add release notes, for example `RELEASE_NOTES_v0.3.0.md`.
6. Commit changes.
7. Tag the release, for example `v0.3.0`.
8. Push `main` and the tag.
9. GitHub Actions builds and uploads macOS pkg plus Android APK to the release.

## Notes

- Realtime Translation source language is detected automatically by the model.
- `gpt-realtime-whisper` uses the selected source caption language.
- If Chinese output appears Simplified, add the missing phrase to the fallback map in `public/app.js`.
- Keep API keys and private transcripts out of git.
