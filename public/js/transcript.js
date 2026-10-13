// Transcript store. Source and translation are kept as independent tracks of timed entries:
// - transcription items (one per committed speech turn) are keyed by the API item_id
// - streamed text (translation output, translate input transcript) is split into phrases here: at
//   sentence ends, when the speech pauses (the translation often has no punctuation), and at a clause
//   when a phrase runs long. Each entry is one caption line.
// Exporters align the two tracks by time, so a lagging translation never shifts the source text.
// Text is stored as received (possibly Simplified Chinese); conversion happens at display/export time.

import { lastSentenceBoundary } from "./text.js";

const STREAM_MAX_CHARS = { cjk: 36, other: 140 };
// A gap this long between deltas ends the phrase, once it has a few words.
const PAUSE_SPLIT_MS = 900;
const PAUSE_MIN_CHARS = { cjk: 6, other: 16 };

export class TranscriptStore {
  constructor() {
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.entries = [];
    this.byId = new Map();
    this.byItem = new Map();
    this.streams = new Map();
    this.epochPerf = null;
    this.epochWall = null;
    this.nextId = 1;
    this.revision = 0;
    this.savedRevision = 0;
    this.emit({ type: "reset" });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change) {
    if (change.type !== "reset") this.revision += 1;
    for (const listener of this.listeners) listener(change);
  }

  // The timeline starts at the first recording and keeps running across Stop/Start, so a resumed
  // session continues the same transcript instead of restarting at 00:00.
  ensureEpoch(nowPerf, nowWall = Date.now()) {
    if (this.epochPerf === null) {
      this.epochPerf = nowPerf;
      this.epochWall = nowWall;
    }
  }

  // Whole milliseconds: sub-millisecond float noise is meaningless for subtitles.
  relative(nowPerf) {
    return this.epochPerf === null ? 0 : Math.max(0, Math.round(nowPerf - this.epochPerf));
  }

  get isEmpty() {
    return !this.entries.some((entry) => entry.text.trim());
  }

  get hasUnsavedChanges() {
    return this.revision !== this.savedRevision && !this.isEmpty;
  }

  markSaved() {
    this.savedRevision = this.revision;
  }

  track(name) {
    return this.entries.filter((entry) => entry.track === name && entry.text.trim());
  }

  create(fields) {
    const seq = this.nextId++;
    const entry = { id: `e${seq}`, seq, final: false, text: "", ...fields };
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.emit({ type: "add", entry });
    return entry;
  }

  remove(entry) {
    this.entries = this.entries.filter((item) => item !== entry);
    this.byId.delete(entry.id);
    this.emit({ type: "remove", entry });
  }

  // Transcription items: deltas append, the completed transcript replaces.
  upsertItem(itemKey, { track = "source", language, startMs, endMs, delta, transcript }) {
    let entry = this.byItem.get(itemKey);
    if (!entry) {
      const start = startMs ?? endMs ?? 0;
      entry = this.create({ track, language, startMs: start, endMs: Math.max(start, endMs ?? start) });
      this.byItem.set(itemKey, entry);
    }
    if (typeof delta === "string") entry.text += delta;
    if (typeof transcript === "string") {
      entry.text = transcript;
      entry.final = true;
    }
    // Times are authoritative when given: the VAD knows the turn's real start/end once it's committed.
    if (typeof startMs === "number") entry.startMs = startMs;
    if (typeof endMs === "number") entry.endMs = endMs;
    entry.endMs = Math.max(entry.endMs, entry.startMs + 300);
    if (entry.final && !entry.text.trim()) {
      this.byItem.delete(itemKey);
      this.remove(entry);
      return null;
    }
    this.emit({ type: "update", entry });
    return entry;
  }

  // Streamed text: deltas are appended verbatim (repeated characters such as 謝謝 are kept) and the
  // stream is cut into sentence entries at confirmed sentence boundaries.
  appendStream(streamKey, { track, language, delta, atMs, cjk }) {
    if (!delta) return;
    let entry = this.openStream(streamKey);
    const minChars = cjk ? PAUSE_MIN_CHARS.cjk : PAUSE_MIN_CHARS.other;
    if (entry && atMs - entry.endMs >= PAUSE_SPLIT_MS && entry.text.trim().length >= minChars) {
      this.sealStream(streamKey);
      entry = null;
    }
    if (!entry) {
      entry = this.create({ track, language, startMs: atMs, endMs: atMs, text: "" });
      this.streams.set(streamKey, entry);
    }
    const previousLength = entry.text.length;
    const previousEnd = entry.endMs;
    entry.text += delta;
    entry.endMs = Math.max(entry.endMs, atMs);

    const boundary = lastSentenceBoundary(entry.text);
    const maxChars = cjk ? STREAM_MAX_CHARS.cjk : STREAM_MAX_CHARS.other;
    if (boundary > 0) {
      // A sentence end is only confirmed by the next delta; the sentence itself ended when its
      // terminator arrived, not when the following sentence started.
      this.splitStream(streamKey, entry, boundary, atMs, boundary <= previousLength ? previousEnd : atMs);
    } else if (entry.text.length > maxChars) {
      this.splitStream(streamKey, entry, softBreak(entry.text, maxChars, cjk), atMs, atMs);
    } else {
      this.emit({ type: "update", entry });
    }
  }

  splitStream(streamKey, entry, index, atMs, headEndMs) {
    const rest = entry.text.slice(index).trimStart();
    entry.text = entry.text.slice(0, index).trim();
    entry.endMs = Math.max(entry.startMs, headEndMs);
    entry.final = true;
    this.emit({ type: "update", entry });
    if (rest) {
      const next = this.create({ track: entry.track, language: entry.language, startMs: atMs, endMs: atMs, text: rest });
      this.streams.set(streamKey, next);
    } else {
      this.streams.delete(streamKey);
    }
  }

  openStream(streamKey) {
    return this.streams.get(streamKey) ?? null;
  }

  // Ends the open sentence of a stream (speaker paused or paragraph marked).
  sealStream(streamKey) {
    const entry = this.streams.get(streamKey);
    if (!entry) return;
    this.streams.delete(streamKey);
    entry.text = entry.text.trim();
    entry.final = true;
    if (!entry.text) this.remove(entry);
    else this.emit({ type: "update", entry });
  }

  sealAll() {
    for (const key of [...this.streams.keys()]) this.sealStream(key);
    for (const [itemKey, entry] of this.byItem) {
      if (!entry.final && entry.text.trim()) {
        entry.final = true;
        this.emit({ type: "update", entry });
      }
      this.byItem.delete(itemKey);
    }
  }

  // Drops the oldest finished entries beyond `max`, without notifying listeners. Used by the audience
  // sharing feed, which only needs recent sentences however long the event runs.
  trim(max) {
    if (this.entries.length <= max) return;
    const open = new Set(this.streams.values());
    let excess = this.entries.length - max;
    const kept = [];
    for (const entry of this.entries) {
      if (excess > 0 && entry.final && !open.has(entry)) {
        excess -= 1;
        this.byId.delete(entry.id);
        for (const [key, item] of this.byItem) {
          if (item === entry) this.byItem.delete(key);
        }
      } else {
        kept.push(entry);
      }
    }
    this.entries = kept;
  }

  toJSON() {
    return {
      format: "keynote-live-translator/transcript",
      version: 1,
      startedAt: this.epochWall ? new Date(this.epochWall).toISOString() : null,
      entries: this.entries
        .filter((entry) => entry.text.trim())
        .map(({ id, track, language, startMs, endMs, text, final }) => ({ id, track, language, startMs, endMs, text, final })),
    };
  }

  restore(data, nowPerf) {
    if (data?.format !== "keynote-live-translator/transcript" || !Array.isArray(data.entries)) return false;
    this.reset();
    const entries = data.entries.filter((entry) => typeof entry?.text === "string" && entry.text.trim());
    for (const entry of entries) {
      this.create({
        track: entry.track === "translation" ? "translation" : "source",
        language: String(entry.language || ""),
        startMs: Number(entry.startMs) || 0,
        endMs: Number(entry.endMs) || 0,
        text: entry.text,
        final: true,
      });
    }
    const lastEnd = Math.max(0, ...this.entries.map((entry) => entry.endMs));
    this.epochPerf = nowPerf - lastEnd - 1000;
    this.epochWall = data.startedAt ? Date.parse(data.startedAt) || Date.now() : Date.now();
    return true;
  }
}

// Where to cut a phrase that ran past `maxChars`: after the last clause mark, or (in space-separated
// languages) the last space, if that keeps at least a third of it; otherwise at the end.
function softBreak(text, maxChars, cjk) {
  const marks = ["，", "、", "；", "：", ", ", "; "].map((mark) => {
    const index = text.lastIndexOf(mark);
    return index < 0 ? -1 : index + mark.trimEnd().length;
  });
  if (!cjk) marks.push(text.lastIndexOf(" "));
  const cut = Math.max(...marks);
  return cut > maxChars / 3 ? cut : text.length;
}
