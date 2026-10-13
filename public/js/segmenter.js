// Semantic line breaks for live captions. The open phrase of each caption stream is sent to a small
// language model (through the backend), which marks where phrases end by meaning and tone; the text
// itself is never changed. Every phrase but the last (which may still be growing) becomes its own line.
// One request per stream is in flight at a time; text that arrived meanwhile is sent when it returns.

import { alignBreaks, headsAt } from "./phrases.js";

// Not worth asking about less text than this…
const MIN_CHARS = { cjk: 5, other: 16 };
// …or about fewer new characters, unless the text then stops changing for SETTLE_MS.
const MIN_GROWTH = { cjk: 3, other: 10 };
const SETTLE_MS = 600;
const RETRY_MS = 20_000;
const MAX_FAILURES = 3;
// A model that keeps rewriting the text instead of only breaking it is set aside for a while too.
const MAX_MISMATCHES = 3;
// Errors that won't go away by retrying (bad key, no access to the model).
const PERMANENT = new Set([401, 403, 404]);

export class PhraseSegmenter {
  // request({ text, language, context }) → Promise<string[]> (the model's lines)
  // read(key) → { text, language, cjk, context } for the stream's open phrase, or null
  // apply(key, heads) cuts the open phrase after each of the finished phrases `heads`
  constructor({ request, read, apply, onDisabled = () => {} }, deps = {}) {
    this.request = request;
    this.read = read;
    this.apply = apply;
    this.onDisabled = onDisabled;
    this.now = deps.now ?? (() => performance.now());
    this.setTimeout = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.enabled = true;
    this.disabled = false;
    this.closed = false;
    this.failures = 0;
    this.mismatches = 0;
    this.retryAt = 0;
    this.streams = new Map();
  }

  // False while the model can't be used: the caller then breaks long phrases by rule.
  get active() {
    return this.enabled && !this.disabled && !this.closed && this.now() >= this.retryAt;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  // Called whenever a stream's open phrase changed.
  update(key, { settled = false } = {}) {
    if (!this.active) return;
    const state = this.state(key);
    if (state.busy) return;
    const phrase = this.read(key);
    const text = phrase?.text.trim() ?? "";
    if (!text || text === state.sent) return;
    if (text.length < (phrase.cjk ? MIN_CHARS.cjk : MIN_CHARS.other)) return;
    const growth = text.startsWith(state.sent) ? text.length - state.sent.length : Infinity;
    if (!settled && growth < (phrase.cjk ? MIN_GROWTH.cjk : MIN_GROWTH.other)) {
      state.timer ||= this.setTimeout(() => {
        state.timer = 0;
        this.update(key, { settled: true });
      }, SETTLE_MS);
      return;
    }
    this.send(key, state, phrase, text);
  }

  send(key, state, phrase, text) {
    this.clearTimeout(state.timer);
    state.timer = 0;
    state.busy = true;
    state.sent = text;
    Promise.resolve()
      .then(() => this.request({ text, language: phrase.language, context: phrase.context }))
      .then(
        (lines) => {
          if (this.closed) return;
          this.failures = 0;
          // A model that echoed a label or the previous line gets one more chance without it.
          const breaks = Array.isArray(lines) ? (alignBreaks(text, lines) ?? alignBreaks(text, lines.slice(1))) : null;
          if (!breaks) {
            this.mismatches += 1;
            if (this.mismatches >= MAX_MISMATCHES) {
              this.mismatches = 0;
              this.retryAt = this.now() + RETRY_MS;
            }
            return;
          }
          this.mismatches = 0;
          if (breaks.length) this.apply(key, headsAt(text, breaks));
        },
        (error) => {
          if (this.closed) return;
          this.failures += 1;
          this.retryAt = this.now() + RETRY_MS;
          if (PERMANENT.has(error?.status) || this.failures >= MAX_FAILURES) {
            this.disabled = true;
            this.onDisabled(error);
          }
        },
      )
      .finally(() => {
        state.busy = false;
        if (!this.closed) this.update(key);
      });
  }

  state(key) {
    let state = this.streams.get(key);
    if (!state) {
      state = { busy: false, sent: "", timer: 0 };
      this.streams.set(key, state);
    }
    return state;
  }

  close() {
    this.closed = true;
    for (const state of this.streams.values()) this.clearTimeout(state.timer);
    this.streams.clear();
  }
}
