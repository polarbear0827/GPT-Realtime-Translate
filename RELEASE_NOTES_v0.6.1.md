# Keynote Live Translator v0.6.1

Audience sharing, tuned on a real Cloudflare relay.

- **Smooth with 1,000 viewers.** The app now sends fewer, larger updates as the audience grows
  (4 per second up to 400 viewers, 2 up to 1,500, then 1). In a load test on Cloudflare with 1,000
  simulated viewers, every update arrived and 95% arrived within 0.35 s (the network round trip).
- **Easier relay setup.** `npm run relay:deploy` no longer pauses on an unrelated Wrangler question.

Install `KeynoteLiveTranslator-0.6.1.pkg` (macOS 12.3 or later; system audio needs macOS 14.2+).
No need to redeploy the relay for this update.
