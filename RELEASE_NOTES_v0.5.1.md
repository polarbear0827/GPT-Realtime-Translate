# Keynote Live Translator v0.5.1

Fixes "翻譯連線逾時" (translation connection timed out) when translating audio playing on your Mac.

- System audio is now sent to gpt-realtime-translate over the app's own WebSocket instead of WebRTC,
  so translation works on any network where the source captions work.
- Microphone mode gets a more forgiving WebRTC connection and clearer error messages.

Install `KeynoteLiveTranslator-0.5.1.pkg` (macOS 12.3 or later; system audio needs macOS 14.2+).
