# Keynote Live Translator v0.6.0

**Share the translation with the audience.** Everyone in the room scans a QR code and reads the live
translation on their own phone — no app to install, view only.

- **分享 → 開始分享**, then **投影 QR Code** (or Q) to put a full-screen QR code on the projector. A small
  QR code can also stay in the corner of the captions.
- Phones get large, readable captions with the newest sentence highlighted, optional original text,
  adjustable text size and dark/light mode. They reconnect on their own, and people who arrive late
  see the recent sentences.
- You see how many people are watching, can **pause** sharing (nothing said while paused is sent),
  push an **announcement** to every phone, and **end** the share.
- The OpenAI cost doesn't change with the number of viewers: translation runs once on your Mac.

**One-time setup:** sharing runs on your own free Cloudflare relay. With a Cloudflare account, run
`npm run relay:deploy` in the repository, then paste the printed URL and publish key into the app's
分享 panel. See README → "Sharing With The Audience".

Install `KeynoteLiveTranslator-0.6.0.pkg` (macOS 12.3 or later; system audio needs macOS 14.2+).
