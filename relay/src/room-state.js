// What a share room holds and how host messages change it. Pure logic with no Cloudflare APIs, so the
// Durable Object (worker.js) and the Node tests share it.
//
// Entries and the operations that change them are defined in public/protocol.js (shared with viewers).

import { LIMITS as ENTRY_LIMITS, applyOp, cleanOp } from "../public/protocol.js";

export { applyOp, cleanOp };

export const LIMITS = {
  ...ENTRY_LIMITS,
  opsPerMessage: 400,
  messageChars: 512 * 1024,
  titleChars: 80,
  noteChars: 240,
  labelChars: 40,
};

export const ROOM_ID_PATTERN = /^[a-z0-9]{10,16}$/;
const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const STATUSES = new Set(["idle", "live", "paused"]);

export function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

function cleanLanguage(value) {
  return {
    label: cleanText(value?.label, LIMITS.labelChars),
    lang: typeof value?.lang === "string" && LANG_TAG.test(value.lang) ? value.lang : "und",
    cjk: Boolean(value?.cjk),
  };
}

export function cleanMeta(value) {
  return {
    title: cleanText(value?.title, LIMITS.titleChars),
    primary: value?.primary === "s" ? "s" : "t",
    original: Boolean(value?.original),
    source: cleanLanguage(value?.source),
    target: cleanLanguage(value?.target),
  };
}

export function cleanState(value) {
  return {
    status: STATUSES.has(value?.status) ? value.status : "idle",
    note: cleanText(value?.note, LIMITS.noteChars),
  };
}

export class RoomState {
  constructor() {
    this.meta = cleanMeta({});
    this.state = cleanState({});
    this.entries = new Map();
    // False until the host has sent its full state since this object (re)started: in-memory entries
    // are lost when the Durable Object is evicted, and only the host can rebuild them.
    this.synced = false;
    this.snapshotCache = new Map();
  }

  // Meta and state are small and change rarely, so they are persisted; entries are not.
  load(saved) {
    if (saved?.meta) this.meta = cleanMeta(saved.meta);
    if (saved?.state) this.state = cleanState(saved.state);
  }

  saved() {
    return { meta: this.meta, state: this.state };
  }

  snapshotText(hostOnline) {
    const key = hostOnline ? "online" : "offline";
    let text = this.snapshotCache.get(key);
    if (!text) {
      text = JSON.stringify({ t: "snapshot", meta: this.meta, state: this.state, host: hostOnline, entries: [...this.entries.values()] });
      this.snapshotCache.set(key, text);
    }
    return text;
  }

  // Applies a parsed host message. Returns what to do next:
  //   broadcast – message for every viewer, reply – message for the host, persist – save meta/state.
  applyHost(message) {
    const result = { broadcast: null, reply: null, persist: false };
    switch (message?.t) {
      case "sync": {
        this.meta = cleanMeta(message.meta);
        this.state = cleanState(message.state);
        this.entries = new Map();
        const ops = Array.isArray(message.entries) ? message.entries.slice(-LIMITS.entries) : [];
        for (const raw of ops) {
          const op = cleanOp(raw);
          if (op && op.x !== undefined) applyOp(this.entries, op);
        }
        this.synced = true;
        result.broadcast = { t: "sync", meta: this.meta, state: this.state, entries: [...this.entries.values()] };
        result.persist = true;
        break;
      }
      case "up": {
        if (!this.synced) {
          result.reply = { t: "resync" };
          break;
        }
        const applied = [];
        let missing = false;
        const ops = Array.isArray(message.e) ? message.e.slice(0, LIMITS.opsPerMessage) : [];
        for (const raw of ops) {
          const op = cleanOp(raw);
          if (!op) continue;
          if (applyOp(this.entries, op)) applied.push(op);
          else missing = true;
        }
        if (applied.length) result.broadcast = { t: "up", e: applied };
        if (missing) result.reply = { t: "resync" };
        break;
      }
      case "meta":
        this.meta = cleanMeta(message.meta);
        result.broadcast = { t: "meta", meta: this.meta };
        result.persist = true;
        break;
      case "state":
        this.state = cleanState(message.state);
        result.broadcast = { t: "state", state: this.state };
        result.persist = true;
        break;
      default:
        break;
    }
    if (result.broadcast) this.snapshotCache.clear();
    return result;
  }
}
