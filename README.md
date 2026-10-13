# Keynote Live Translator

Local-first realtime subtitles for keynote talks, demos, and live presentations.

- Source captions from `gpt-live-transcribe` (live transcription, with optional keywords and context).
- Translated captions from `gpt-realtime-translate`.
- Bilingual, translation-only, or source-only captions; 13 source and 13 target languages.
- Transcript recording with SRT (source / translation / bilingual), Markdown, text and JSON export.
- Translate what the Mac is playing (YouTube, meetings) without speakers, shown as floating captions
  over any app, including full-screen video (macOS 14.2+).
- Light and dark appearance (follows the system by default).
- macOS app (universal, ~2 MB), plus a browser version for development.

## Current Version

`0.5.2` — see [CHANGELOG.md](CHANGELOG.md).

## Architecture

| Host | UI served from | API key & OpenAI calls | Local network port |
|---|---|---|---|
| macOS app | Swift static server on `127.0.0.1` | Native Swift via `WKScriptMessageHandlerWithReply` | Static files only (Host-checked) |
| Browser (`npm start`) | Node dev server on `127.0.0.1` | Node, behind a per-launch token | Yes (Host/Origin/token-checked) |

Both backends implement the same rules from [`public/realtime-config.json`](public/realtime-config.json)
(models, languages, limits). `tests/contract.test.mjs` checks that the Node and Swift implementations
produce identical OpenAI payloads and validation errors.

Realtime flow:

- Translation: WebRTC to `/v1/realtime/translations/calls` with a short-lived client secret.
- Transcription: WebSocket to `/v1/realtime` (`type: "transcription"`, `gpt-live-transcribe`). Audio is
  converted to 24 kHz PCM16 in an AudioWorklet and committed at the end of each speech turn by a
  client-side voice activity detector (the model has no server VAD).
- Both connections reconnect automatically and are rotated before the 60-minute Realtime session limit.
- Stop drains the last sentence (`session.close` → `session.closed`, and waiting for the final transcript).

## Security Model

- The OpenAI API key is entered by the user at runtime and is never embedded in the app.
- By default the key lives in memory only. In the macOS app the user can opt in to "記住金鑰", which
  stores it in the login Keychain.
- The key is validated against OpenAI when saved, and only exchanged for short-lived Realtime client
  secrets; the page never sees the long-lived key.
- The dev server rejects requests whose `Host` isn't `127.0.0.1`/`localhost` (DNS rebinding), whose
  `Origin` is foreign, that aren't `application/json`, or that lack the per-launch token embedded in the page.
- The macOS app doesn't expose the API over HTTP at all; the bridge only accepts calls from the app's own page.

## Caption Modes

- **雙語字幕** — source + translation. The source track comes from `gpt-live-transcribe` (more accurate,
  supports keywords) or, if chosen in 設定 > 辨識, from the translation session's own input transcript
  (about half the audio cost).
- **只顯示翻譯** — `gpt-realtime-translate` only. The source transcript is still recorded for export.
- **只顯示原文** — `gpt-live-transcribe` only.

## Translating Videos Playing On Your Mac

1. In the toolbar choose **音源 > 電腦播放的聲音** (macOS app, macOS 14.2+).
2. Pick **只顯示翻譯** (the spoken language is detected automatically) or 雙語, and the target language.
3. Press **開始** and play the video. The floating caption window opens on top of everything,
   including full-screen video; drag it where you like.
4. Resize the floating captions from any edge or the corner grip — the text grows with the window.
   Hover it to change the size in steps, the background opacity (down to fully transparent), lock it
   (clicks pass through to the video) or close it. More options (1–3 lines, show/hide the original,
   reset position) are in 設定 > 懸浮字幕. ⌘⇧O shows/hides it and ⌘⇧L locks/unlocks it.

The audio is captured digitally with a Core Audio process tap, so it works with headphones and with
the speakers off. The app streams it to gpt-realtime-translate over its own WebSocket (no WebRTC). Optionally enable 設定 > 收音 > 把原本的聲音靜音 to silence the original while
reading. The first time, macOS asks to allow "System Audio Recording"; if captions stay empty, enable
it under System Settings > Privacy & Security > Screen & System Audio Recording and reopen the app.

## Using It

1. Open the app and enter your OpenAI API key (it's verified immediately).
2. Pick the mode and languages, then **設定 > 收音 > 測試麥克風** to check the level.
3. Optional: add keywords (speaker names, product names, jargon) and a short context description.
4. Press **開始** (or Space). Use **投影模式** (F) for a clean caption screen, or
   **開啟字幕視窗（第二螢幕）** to put captions on a projector while you keep the controls.
5. After the talk, **匯出** the transcript or SRT. Subtitles are split into cues of at most 7 seconds
   and two lines; use **SRT 時間偏移** to align them with a recording.

Shortcuts: Space start/stop · P pause display · M new paragraph · F presentation mode · T transcript ·
+/− caption size · Esc close panels.

The transcript is auto-saved on the device while recording (can be turned off in settings) and offered
for restore after an unexpected close.

## Install On macOS

Download `KeynoteLiveTranslator-0.4.0.pkg` from GitHub Releases and open it. The app is installed to
`/Applications` and runs on Apple silicon and Intel Macs with macOS 12.3 or later.

If the release isn't notarized and macOS blocks it: Finder → `/Applications` → right-click
`Keynote Live Translator` → Open.

Microphone: `System Settings > Privacy & Security > Microphone` → enable Keynote Live Translator.

## Local Development

Requirements: Node.js 22+ (see `.nvmrc`), macOS + Xcode command line tools for the macOS app.

```bash
npm start            # dev server at http://127.0.0.1:8787 (add ?debug to expose internals in the console)
npm run check        # syntax check
npm test             # unit, server security, session controller and Swift↔Node contract tests
npm run test:macos   # runs the real UI in an offscreen WKWebView against the native bridge
npm run build:pkg    # universal macOS app + installer in build/v<version>/
```

## Release Flow

1. Update `VERSION` (the only place the version is written; the macOS build and the UI read it) and
   `package.json` (a test checks they match).
2. Add a `CHANGELOG.md` entry and `RELEASE_NOTES_v<version>.md`.
3. Commit, tag `v<version>`, push. GitHub Actions verifies the tag matches `VERSION`, runs the tests and
   publishes the macOS pkg.

### Signing (optional, recommended)

Repository secrets used by the release workflow when present:

- macOS: `MACOS_CERTIFICATES_P12` (base64 .p12 with Developer ID Application + Installer),
  `MACOS_CERTIFICATES_PASSWORD`, `MACOS_CODESIGN_IDENTITY`, `MACOS_INSTALLER_IDENTITY`, and for
  notarization `NOTARY_KEY_BASE64` (App Store Connect API key .p8), `NOTARY_KEY_ID`, `NOTARY_ISSUER`.

## Notes

- `gpt-realtime-translate` detects the spoken language automatically; the source language setting is
  used for `gpt-live-transcribe` and for labels.
- Chinese output is converted to Taiwan Traditional Chinese with OpenCC at display/export time.
- Keep API keys and private transcripts out of git.
