# Keynote Live Translator v0.3.0

This release adds Android phone support.

## Highlights

- Android app project:
  - Native Java Activity.
  - Android WebView UI.
  - App-local `127.0.0.1` server.
- Android security model:
  - OpenAI API key is entered by the user.
  - API key stays in memory only.
  - API key is exchanged for short-lived Realtime client secrets.
  - No API key is embedded in the APK.
- Android microphone support:
  - Requests `RECORD_AUDIO`.
  - Grants WebView audio capture permission after Android microphone permission is approved.
- Mobile UI refinements:
  - Compact controls on portrait screens.
  - Collapsed usage guide by default.
  - Larger caption surface for phones.
- Release workflow now builds and uploads both:
  - macOS `.pkg`
  - Android debug `.apk`

## Android Install

Download `KeynoteLiveTranslator-android-0.3.0-debug.apk` from this release and install it on your Android phone.

If Android blocks the APK, allow installation from the browser or file manager you used to download it.

## macOS Install

Download `KeynoteLiveTranslator-0.3.0.pkg` and install it as before.

## Notes

- The Android APK is debug-signed for direct testing.
- For Play Store or enterprise deployment, create a properly signed release build.
- The app still requires an OpenAI API key entered by the user at runtime.
