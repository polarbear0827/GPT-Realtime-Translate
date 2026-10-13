<p align="center"><img src="assets/app-icon.png" width="128" height="128" alt="Keynote Live Translator icon" /></p>

# Keynote Live Translator

Local-first realtime subtitles for keynote talks, demos, and live presentations.

- Source captions from `gpt-live-transcribe` (live transcription, with optional keywords and context).
- Translated captions from `gpt-realtime-translate`.
- Bilingual, translation-only, or source-only captions; 13 source and 13 target languages.
- Transcript recording with SRT (source / translation / bilingual), Markdown, text and JSON export.
- Translate what the Mac is playing (YouTube, meetings) without speakers, shown as floating captions
  over any app, including full-screen video (macOS 14.2+).
- Share the captions with the audience: people scan a QR code and read the translation live on their
  own phones (no app to install, view only). Runs on your own free Cloudflare relay; load-tested on
  Cloudflare with 1,000 simulated viewers (every update delivered, 95% within 0.35 s).
- Light and dark appearance (follows the system by default).
- macOS app (universal, ~2 MB), plus a browser version for development.

## Current Version

`0.6.3` — see [CHANGELOG.md](CHANGELOG.md).

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

Audience sharing (optional):

```
Mac app ──one WebSocket, text only──▶ relay (Cloudflare Worker + one Durable Object per room) ──▶ phones
```

- The app publishes caption sentences (a few updates per second, mostly appended text) to a room on a
  relay you deploy from [`relay/`](relay). The relay fans them out to every viewer, so the venue's
  upload carries one stream however many people watch, and viewers on mobile data work too.
- Viewers open `https://<relay>/r/<room>` from the QR code: a static page that only receives. Late
  joiners get the recent sentences; dropped connections reconnect and catch up.
- Translation runs once on the Mac, so the OpenAI cost doesn't depend on the number of viewers.

## Security Model

- The OpenAI API key is entered by the user at runtime and is never embedded in the app.
- By default the key lives in memory only. In the macOS app the user can opt in to "記住金鑰", which
  stores it in the login Keychain.
- The key is validated against OpenAI when saved, and only exchanged for short-lived Realtime client
  secrets; the page never sees the long-lived key.
- The dev server rejects requests whose `Host` isn't `127.0.0.1`/`localhost` (DNS rebinding), whose
  `Origin` is foreign, that aren't `application/json`, or that lack the per-launch token embedded in the page.
- The macOS app doesn't expose the API over HTTP at all; the bridge only accepts calls from the app's own page.
- Sharing: only holders of the relay's publish key (stored in the Keychain / dev-server memory, never
  in the page) can create rooms; each room has its own host token. Viewer connections can't send
  anything. The page's Content-Security-Policy allows exactly the configured relay. Nothing said before
  sharing starts or while it's paused is sent, the original text is only sent if you allow it, and the
  relay keeps captions in memory only — ending a share deletes the room.

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

## Sharing With The Audience

Let everyone in the room read the translation on their own phone by scanning a QR code.

**One-time setup (about 5 minutes):**

1. Create a free Cloudflare account at <https://dash.cloudflare.com/sign-up>.
2. In this repository run:

   ```bash
   npm run relay:deploy
   ```

   The first time, a browser window asks you to log in to Cloudflare and allow Wrangler (Cloudflare's
   deploy tool), and Cloudflare may ask you to pick a `workers.dev` name.
3. When the relay is up, the app (0.6.2+) asks **連接分享伺服器？** — press **連接**. Nothing to copy:
   the script hands the relay's address and publish key to the app through a
   `keynote-live-translator://share-setup` link, and the key is stored in the Keychain.

The publish key is what stops strangers from using your relay (its address is in every QR code). It's
generated for you, kept in `relay/.publish-key` (don't commit or share it) and only ever sent to
Cloudflare and the app. `npm run relay:connect` reconnects the app (for example after reinstalling)
without deploying; the panel's 手動輸入 section accepts the values by hand.

**At the event:**

1. **分享 → 開始分享** (optionally set the event name shown on phones, and whether viewers may see the
   original). Sharing can start before the talk; phones show "等待講者開始".
2. **投影 QR Code** (or Q) shows a full-screen QR code — on the caption window too if it's open. A small
   QR code can also stay in the corner of the captions.
3. **暫停分享** for off-the-record parts: what's said while paused is never sent, even after resuming.
   **公告** pushes a short message to every phone (for example a break).
4. **結束分享** when done: phones show "已結束" and the link stops working. Quitting the app doesn't end
   the share; reopening within 12 hours offers to continue the same room, so nobody has to rescan.

The free Cloudflare plan is enough for typical events (an hour-long talk with 1,000 viewers uses a
small part of the daily allowance).

Capacity, measured on Cloudflare with simulated viewers (from one Mac): up to about 1,000 viewers every
update arrives within the network round trip (95% within 0.35 s). The app sends fewer, larger updates
as the audience grows (4 per second up to 400 viewers, 2 up to 1,500, then 1), because one room
handles about 2,000 viewer messages per second comfortably. At 1,500–2,000 viewers everything still
arrives, but a few percent of updates take 1–3 s. To test your relay:

```bash
npm run relay:load-test -- --url https://klt-relay.<you>.workers.dev --viewers 1000 --seconds 30
```

## Using It

1. Open the app and enter your OpenAI API key (it's verified immediately).
2. Pick the mode and languages, then **設定 > 收音 > 測試麥克風** to check the level.
3. Optional: add keywords (speaker names, product names, jargon) and a short context description.
4. Press **開始** (or Space). Use **投影模式** (F) for a clean caption screen, or
   **開啟字幕視窗（第二螢幕）** to put captions on a projector while you keep the controls.
5. After the talk, **匯出** the transcript or SRT. Subtitles are split into cues of at most 7 seconds
   and two lines; use **SRT 時間偏移** to align them with a recording.

Shortcuts: Space start/stop · P pause display · M new paragraph · F presentation mode · T transcript ·
Q project the share QR code · +/− caption size · Esc close panels.

The transcript is auto-saved on the device while recording (can be turned off in settings) and offered
for restore after an unexpected close.

## Install On macOS

Download `KeynoteLiveTranslator-<version>.pkg` from GitHub Releases and open it. The app is installed to
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

npm run relay:dev    # sharing relay locally at http://127.0.0.1:8788 (needs relay/.dev.vars with PUBLISH_KEY=kltp_…)
npm run relay:test   # relay end-to-end tests in wrangler dev
npm run relay:load-test -- --viewers 2000   # simulated audience against a local relay
zsh scripts/make-icons.sh   # regenerate the app icon, favicons and touch icon from assets/logo.png
```

The dev server picks up a relay from `KLT_RELAY_URL` and `KLT_RELAY_KEY`, or from the 分享 panel.

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
