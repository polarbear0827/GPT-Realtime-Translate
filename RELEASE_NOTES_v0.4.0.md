# Keynote Live Translator v0.4.0

This release switches source captions to `gpt-live-transcribe`, fixes the transcript and export bugs
found in v0.3, and rebuilds the macOS and Android hosts around a smaller, safer architecture.

## Highlights

- **Better source captions** — `gpt-live-transcribe` with optional keywords (speaker and product names)
  and a context description; speech turns are detected on the device.
- **Reliable long talks** — automatic reconnect, seamless rotation before the 60-minute session limit,
  and Stop now waits for the last sentence.
- **Correct transcripts and subtitles** — no duplicated segments, no dropped repeated characters,
  correct Traditional Chinese, SRT cues of at most 7 seconds and two lines.
- **macOS app is now ~2 MB** (was 115 MB), runs natively on Apple silicon and Intel, and Export,
  Clear Transcript, Fullscreen and ⌘V now work.
- **Presentation tools** — presentation mode, a caption window for a second screen, keyboard shortcuts,
  microphone level meter and "no audio" warning; the display stays awake while live.

## Upgrade notes

- The transcript is no longer cleared when you press Start again; use 設定 > 清除逐字稿.
- Settings from v0.3 carry over.

## Install

- macOS: `KeynoteLiveTranslator-0.4.0.pkg` (macOS 12.3 or later, Apple silicon and Intel).
