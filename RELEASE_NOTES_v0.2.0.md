# Keynote Live Translator v0.2.0

This release turns Keynote Live Translator into a true macOS desktop window and adds configurable English/Chinese language modes.

## Highlights

- Real macOS app window:
  - Built with Swift AppKit and WKWebView.
  - No longer opens an external browser on launch.
  - The local server still runs privately inside the app flow.
- Language selection:
  - Source captions can be set to English or Chinese.
  - Translation output can be set to Traditional Chinese or English.
  - The architecture keeps the translation target language setting compatible with the official 13-language Realtime Translation output list.
- Language-agnostic display modes:
  - Bilingual captions.
  - Translation only.
  - Source only.
- Transcript and SRT exports now use the selected source/target language labels.

## Install

Download `KeynoteLiveTranslator-0.2.0.pkg`, install it, then open `Keynote Live Translator` from `/Applications`.

## Important Notes

- The app uses a WKWebView desktop window, so microphone permission belongs to `Keynote Live Translator` itself.
- If macOS blocks microphone access, open `System Settings > Privacy & Security > Microphone` and enable `Keynote Live Translator`.
- This package is ad-hoc signed and not notarized yet. If macOS blocks launch, open it from Finder with right-click > Open.

## Before a keynote

1. Open `Keynote Live Translator`.
2. Paste your OpenAI API key.
3. Pick source caption language.
4. Pick translation target language.
5. Click `測試麥克風`.
6. Click `Start`.
7. Use `Export` to save SRT or transcript files after the session.
