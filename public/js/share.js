// Audience sharing: publishes caption sentences to a relay room (relay/) that viewers open by scanning a
// QR code. The source of truth is a "feed" TranscriptStore the session writes to whether or not the
// transcript is being recorded. Only sentences that change are sent, a few times per second, mostly as
// appended text; after a reconnect the relay gets the full recent state again.
//
// Privacy rules: nothing said before sharing started is sent, sentences that begin while sharing is
// paused are never sent, and the original text is only sent when the host allows viewers to see it.

// One relay room fans every update out to every viewer; measured on Cloudflare, about 2,000 viewer
// messages per second stays fast and 4,000 starts to queue. Larger audiences get fewer, larger updates.

import { captionText } from "./text.js";

export function flushInterval(viewers) {
  if (viewers > 1500) return 1000;
  if (viewers > 400) return 500;
  return 250;
}
const HEARTBEAT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const END_TIMEOUT_MS = 4_000;
const RECONNECT_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const KEEP_PUBLISHED = 300;
const FEED_LIMIT = 400;

const FAILURES = {
  4401: "分享權杖無效，請重新開始分享。",
  4404: "這場分享已不存在（可能已經結束或過期），請重新開始分享。",
  4409: "這場分享已經在另一個視窗或另一台電腦上繼續。",
};

export class SharePublisher {
  // `display(text, language)` converts text for display (Simplified → Traditional Chinese);
  // `languageInfo(code)` gives { lang, cjk, label, targetLabel }.
  constructor({ feed, display, languageInfo, onChange = () => {} }, deps = {}) {
    this.feed = feed;
    this.display = display;
    this.languageInfo = languageInfo;
    this.onChange = onChange;
    this.WebSocket = deps.WebSocket ?? globalThis.WebSocket;
    this.setTimeout = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.reset();
  }

  reset() {
    this.room = null;
    this.phase = "idle";
    this.error = "";
    this.viewers = 0;
    this.paused = false;
    this.note = "";
    this.sessionStatus = "idle";
    this.meta = null;
    this.ws = null;
    this.ready = false;
    this.attempt = 0;
    this.published = new Map();
    this.blocked = new Set();
    this.dirty = new Set();
    this.flushTimer = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connectTimer = null;
    this.lastSentAt = 0;
    this.endRequested = null;
    this.prefix = "";
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get active() {
    return this.phase !== "idle" && this.phase !== "ended" && this.phase !== "failed";
  }

  // room: { room, hostToken, viewerUrl, socketUrl } from the relay. meta: see buildMeta().
  start(room, { meta, sessionStatus = "idle", paused = false, note = "" }) {
    this.stopTimers();
    this.ws?.close();
    this.reset();
    this.room = room;
    this.meta = meta;
    this.sessionStatus = sessionStatus;
    this.paused = paused;
    this.note = note;
    // Entry ids restart in every page load; the prefix keeps a resumed room's old sentences apart.
    this.prefix = Math.floor(this.random() * 36 ** 4)
      .toString(36)
      .padStart(4, "0");
    // What was said before sharing started stays private.
    for (const entry of this.feed.entries) this.blocked.add(entry.id);
    this.unsubscribe = this.feed.subscribe((change) => this.onFeedChange(change));
    this.setPhase("connecting");
    this.connect();
  }

  setMeta(meta) {
    const previous = this.meta;
    this.meta = meta;
    if (!this.active || JSON.stringify(previous) === JSON.stringify(meta)) return;
    // Entries that are no longer wanted (the original was hidden) are deleted on the viewers' side.
    for (const id of this.published.keys()) this.dirty.add(id);
    this.send({ t: "meta", meta });
    this.flush();
  }

  setSessionStatus(status) {
    const next = status === "live" || status === "stopping" ? "live" : "idle";
    if (next === this.sessionStatus) return;
    this.sessionStatus = next;
    this.sendState();
  }

  setPaused(paused) {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      // Sentences already on viewers' screens are frozen as they are.
      const ops = [];
      for (const [id, sent] of this.published) {
        if (!sent.f) {
          sent.f = 1;
          ops.push({ i: this.prefix + id, f: 1 });
        }
        this.dirty.delete(id);
      }
      if (ops.length) this.send({ t: "up", e: ops });
      for (const entry of this.feed.entries) this.blocked.add(entry.id);
    }
    this.sendState();
    this.onChange();
  }

  setNote(note) {
    const text = String(note ?? "").trim().slice(0, 240);
    if (text === this.note) return;
    this.note = text;
    this.sendState();
    this.onChange();
  }

  // Ends the room for everyone. Resolves once the relay confirmed (or after a timeout).
  end() {
    if (!this.room || this.phase === "ended") return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        this.clearTimeout(timer);
        this.stopTimers();
        const ws = this.ws;
        this.ws = null;
        ws?.close();
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.setPhase("ended");
        resolve();
      };
      const timer = this.setTimeout(finish, END_TIMEOUT_MS);
      this.endRequested = finish;
      if (this.ready) this.send({ t: "end" });
      else if (!this.ws) this.connect();
    });
  }

  // Stops publishing without ending the room (tests; the page going away).
  dispose() {
    this.stopTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ---- connection ---------------------------------------------------------------------------

  connect() {
    this.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    let ws;
    try {
      ws = new this.WebSocket(this.room.socketUrl);
    } catch (error) {
      this.fail(`無法連線到分享伺服器：${error.message}`);
      return;
    }
    this.ws = ws;
    this.ready = false;
    ws.onopen = () => {
      if (this.ws === ws) ws.send(JSON.stringify({ t: "auth", token: this.room.hostToken }));
    };
    ws.onmessage = ({ data }) => {
      if (this.ws !== ws) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      this.onMessage(message);
    };
    ws.onclose = ({ code }) => {
      if (this.ws === ws) this.onClose(code);
    };
    ws.onerror = () => {};
    this.clearTimeout(this.connectTimer);
    this.connectTimer = this.setTimeout(() => {
      if (this.ws === ws && !this.ready) ws.close();
    }, CONNECT_TIMEOUT_MS);
  }

  onMessage(message) {
    switch (message.t) {
      case "welcome":
        this.ready = true;
        this.attempt = 0;
        this.clearTimeout(this.connectTimer);
        this.viewers = Number(message.viewers) || 0;
        if (this.endRequested) {
          this.send({ t: "end" });
          return;
        }
        this.setPhase("live");
        this.sendSync();
        this.flush();
        this.scheduleHeartbeat();
        break;
      case "viewers":
        this.viewers = Number(message.n) || 0;
        this.onChange();
        break;
      case "resync":
        if (this.ready) this.sendSync();
        break;
      case "gone":
        this.onClose(4404);
        break;
      case "error":
        if (message.code === "auth") this.onClose(4401);
        break;
      default:
        break;
    }
  }

  onClose(code) {
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    ws?.close();
    this.stopTimers();
    if (this.endRequested) {
      this.endRequested();
      return;
    }
    if (code === 4000) {
      // Ended elsewhere (the relay expired the room).
      this.unsubscribe?.();
      this.setPhase("ended");
      return;
    }
    if (FAILURES[code]) {
      this.fail(FAILURES[code]);
      return;
    }
    if (!this.active) return;
    this.setPhase("reconnecting");
    const base = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)];
    this.attempt += 1;
    this.reconnectTimer = this.setTimeout(() => this.connect(), base);
  }

  fail(message) {
    this.error = message;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopTimers();
    this.setPhase("failed");
  }

  setPhase(phase) {
    this.phase = phase;
    if (phase !== "failed") this.error = "";
    this.onChange();
  }

  stopTimers() {
    for (const name of ["flushTimer", "reconnectTimer", "heartbeatTimer", "connectTimer"]) {
      this.clearTimeout(this[name]);
      this[name] = null;
    }
  }

  send(message) {
    if (!this.ready || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(message));
      this.lastSentAt = this.now();
      return true;
    } catch {
      return false;
    }
  }

  // Keeps the relay's room awake (and the connection's NAT mapping fresh) during long silences.
  scheduleHeartbeat() {
    this.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.setTimeout(() => {
      if (this.now() - this.lastSentAt >= HEARTBEAT_MS - 50) this.send({ t: "hb" });
      if (this.ready) this.scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  // ---- captions ---------------------------------------------------------------------------

  stateMessage() {
    return { status: this.paused ? "paused" : this.sessionStatus, note: this.note };
  }

  sendState() {
    this.send({ t: "state", state: this.stateMessage() });
  }

  sendSync() {
    const entries = [...this.published].map(([id, sent]) => ({ i: this.prefix + id, k: sent.k, x: sent.x, ...(sent.f ? { f: 1 } : {}), l: sent.l }));
    this.send({ t: "sync", meta: this.meta, state: this.stateMessage(), entries });
  }

  onFeedChange(change) {
    if (!change.entry) return;
    const id = change.entry.id;
    if (this.blocked.has(id)) return;
    if (this.paused) {
      if (!this.published.has(id)) this.blocked.add(id);
      return;
    }
    this.dirty.add(id);
    if (!this.flushTimer) this.flushTimer = this.setTimeout(() => this.flush(), flushInterval(this.viewers));
  }

  wants(entry) {
    const kind = entry.track === "translation" ? "t" : "s";
    if (kind === this.meta?.primary) return true;
    return kind === "s" && this.meta?.primary === "t" && Boolean(this.meta?.original);
  }

  // Lines are shown one per phrase, like the live captions; the original strip joins phrases.
  lineText(entry) {
    const text = this.display(entry.text, entry.language).trim();
    const kind = entry.track === "translation" ? "t" : "s";
    return kind === this.meta?.primary ? captionText(text) : text;
  }

  flush() {
    this.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    // While disconnected, changes wait; the next sync and flush send them.
    if (!this.ready) return;
    const ops = [];
    for (const id of this.dirty) {
      const entry = this.feed.byId.get(id);
      const sent = this.published.get(id);
      const text = entry && this.wants(entry) ? this.lineText(entry) : "";
      if (!text) {
        if (sent) {
          ops.push({ i: this.prefix + id, d: 1 });
          this.published.delete(id);
        }
        continue;
      }
      // Frozen by a pause: viewers keep the sentence as it was.
      if (this.blocked.has(id)) continue;
      const final = entry.final ? 1 : 0;
      if (!sent) {
        const kind = entry.track === "translation" ? "t" : "s";
        const lang = this.languageInfo(entry.language).lang;
        ops.push({ i: this.prefix + id, k: kind, x: text, ...(final ? { f: 1 } : {}), l: lang });
        this.published.set(id, { k: kind, x: text, f: final, l: lang });
        continue;
      }
      const op = { i: this.prefix + id };
      if (sent.x !== text) {
        if (text.startsWith(sent.x)) op.a = text.slice(sent.x.length);
        else op.x = text;
        sent.x = text;
      }
      if (final && !sent.f) {
        op.f = 1;
        sent.f = 1;
      }
      if (op.a !== undefined || op.x !== undefined || op.f) ops.push(op);
    }
    this.dirty.clear();
    while (this.published.size > KEEP_PUBLISHED) this.published.delete(this.published.keys().next().value);
    this.feed.trim(FEED_LIMIT);
    if (this.blocked.size > FEED_LIMIT * 2) {
      for (const id of this.blocked) if (!this.feed.byId.has(id)) this.blocked.delete(id);
    }
    if (ops.length) this.send({ t: "up", e: ops });
  }
}

// What viewers see in the header and how their lines are labeled.
export function buildMeta({ title, mode, sourceLanguage, targetLanguage, original, languageInfo }) {
  const source = languageInfo(sourceLanguage);
  const target = languageInfo(targetLanguage);
  return {
    title: String(title ?? "").trim().slice(0, 80),
    primary: mode === "source" ? "s" : "t",
    original: mode !== "source" && Boolean(original),
    source: { label: source.label, lang: source.lang, cjk: source.cjk },
    target: { label: target.targetLabel, lang: target.lang, cjk: target.cjk },
  };
}
