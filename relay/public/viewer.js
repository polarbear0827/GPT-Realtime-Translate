// Audience page. Receives caption entries for one room and shows them; it can't send anything back
// except keep-alive pings. Reconnects on its own (phones drop connections when the screen locks or the
// network switches) and merges what it missed.

import { LIMITS, applyOp, cleanOp } from "./protocol.js";

const room = location.pathname.match(/^\/r\/([a-z0-9]{10,16})/)?.[1] ?? "";
const RECONNECT_MS = [1000, 2000, 4000, 8000, 15000];
const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const HOST_OFFLINE_GRACE_MS = 8_000;
const MAX_LINES = LIMITS.entries * 2;
const PREFS_KEY = "klt-viewer";

const $ = (id) => document.getElementById(id);
const els = {
  title: $("title"),
  languages: $("languages"),
  status: $("status"),
  statusText: $("statusText"),
  settingsBtn: $("settingsBtn"),
  note: $("note"),
  noteText: $("noteText"),
  feed: $("feed"),
  empty: $("empty"),
  emptyTitle: $("emptyTitle"),
  emptyHint: $("emptyHint"),
  lines: $("lines"),
  ended: $("ended"),
  jumpBtn: $("jumpBtn"),
  original: $("original"),
  originalLabel: $("originalLabel"),
  originalText: $("originalText"),
  scrim: $("scrim"),
  sheet: $("sheet"),
  closeSheetBtn: $("closeSheetBtn"),
  smallerBtn: $("smallerBtn"),
  largerBtn: $("largerBtn"),
  scaleInput: $("scaleInput"),
  originalRow: $("originalRow"),
  originalToggle: $("originalToggle"),
};

const view = {
  meta: { title: "", primary: "t", original: false, source: { label: "", lang: "und", cjk: false }, target: { label: "", lang: "und", cjk: false } },
  state: { status: "idle", note: "" },
  hostOnline: true,
  hostOfflineSince: 0,
  entries: new Map(),
  connection: "connecting",
  ended: false,
};
const nodes = new Map();
let highlighted = [];
let socket = null;
let attempt = 0;
let reconnectTimer = 0;
let pingTimer = 0;
let pongTimer = 0;
let offlineTimer = 0;
let wakeLock = null;
const prefs = loadPrefs();

applyPrefs();
bindControls();
if (room) connect();
else {
  view.connection = "gone";
  render();
}

// ---- connection ---------------------------------------------------------------------------------

function connect() {
  clearTimeout(reconnectTimer);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/api/rooms/${room}/live`);
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    view.connection = "open";
    // An immediate ping confirms the path works end to end (answered by the relay without waking it).
    ws.send("ping");
    startPing(ws);
    requestWakeLock();
    renderStatus();
  };
  ws.onmessage = ({ data }) => {
    clearTimeout(pongTimer);
    if (data === "pong") return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    handle(message);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    stopPing();
    if (view.ended || view.connection === "gone") return;
    view.connection = "reconnecting";
    renderStatus();
    scheduleReconnect();
  };
}

// Jittered so a full room doesn't reconnect in lockstep after a relay restart.
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const base = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
  attempt += 1;
  reconnectTimer = setTimeout(connect, base * (0.6 + Math.random() * 0.8));
}

function startPing(ws) {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send("ping");
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => ws.close(), PONG_TIMEOUT_MS);
  }, PING_MS);
}

function stopPing() {
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  requestWakeLock();
  // Background tabs lose their connection without noticing; reconnect right away on return.
  if (!socket && !view.ended && view.connection !== "gone" && room) connect();
});

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock || view.ended || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

// ---- messages -----------------------------------------------------------------------------------

function handle(message) {
  switch (message.t) {
    case "snapshot":
      view.meta = message.meta ?? view.meta;
      view.state = message.state ?? view.state;
      setHostOnline(message.host !== false);
      merge(message.entries);
      render();
      break;
    case "sync":
      view.meta = message.meta ?? view.meta;
      view.state = message.state ?? view.state;
      merge(message.entries);
      render();
      break;
    case "up":
      applyOps(message.e);
      break;
    case "meta":
      view.meta = message.meta ?? view.meta;
      render();
      break;
    case "state":
      view.state = message.state ?? view.state;
      renderStatus();
      break;
    case "host":
      setHostOnline(Boolean(message.online));
      renderStatus();
      break;
    case "end":
      finish("ended");
      break;
    case "gone":
      finish(view.entries.size ? "ended" : "gone");
      break;
    default:
      break;
  }
}

function finish(kind) {
  if (kind === "gone") view.connection = "gone";
  else view.ended = true;
  // Nothing is being typed any more.
  for (const entry of view.entries.values()) entry.f = 1;
  for (const node of nodes.values()) node.classList.remove("live");
  clearTimeout(reconnectTimer);
  stopPing();
  wakeLock?.release().catch(() => {});
  socket?.close();
  socket = null;
  render();
}

function setHostOnline(online) {
  view.hostOnline = online;
  clearTimeout(offlineTimer);
  if (online) {
    view.hostOfflineSince = 0;
    return;
  }
  view.hostOfflineSince ||= Date.now();
  // A short blip (the app reconnecting) shouldn't flash a warning.
  offlineTimer = setTimeout(renderStatus, HOST_OFFLINE_GRACE_MS + 50);
}

// Snapshots and resyncs are merged: entries this page already has stay, updated ones change, and new
// ones (missed while disconnected) are appended in order.
function merge(list) {
  if (!Array.isArray(list)) return;
  for (const raw of list) {
    const op = cleanOp(raw);
    if (op && op.x !== undefined) applyOp(view.entries, op, MAX_LINES);
  }
}

function applyOps(list) {
  if (!Array.isArray(list)) return;
  const follow = isNearBottom();
  const primary = view.meta.primary;
  let sourceChanged = false;
  for (const raw of list) {
    const op = cleanOp(raw);
    if (!op || !applyOp(view.entries, op, MAX_LINES)) continue;
    const entry = view.entries.get(op.i);
    if (!entry) {
      nodes.get(op.i)?.remove();
      nodes.delete(op.i);
      sourceChanged = true;
    } else if (entry.k === primary) {
      renderLine(entry);
    } else {
      sourceChanged = true;
    }
  }
  pruneLines();
  afterLinesChanged(follow);
  if (sourceChanged) renderOriginal();
}

// ---- rendering ----------------------------------------------------------------------------------

function render() {
  const { meta } = view;
  els.title.textContent = meta.title || "即時翻譯";
  document.title = meta.title ? `${meta.title} · 即時翻譯` : "即時翻譯";
  const source = meta.source.label;
  const target = meta.target.label;
  els.languages.textContent =
    meta.primary === "s" ? (source ? `${source}・即時字幕` : "即時字幕") : source && target ? `${source} → ${target}` : "即時翻譯";
  els.originalRow.hidden = !(meta.original && meta.primary === "t");
  els.originalLabel.textContent = source ? `原文・${source}` : "原文";

  const follow = isNearBottom();
  els.lines.replaceChildren();
  nodes.clear();
  highlighted = [];
  for (const entry of view.entries.values()) {
    if (entry.k === meta.primary) renderLine(entry);
  }
  pruneLines();
  afterLinesChanged(follow);
  renderOriginal();
  renderStatus();
}

function renderLine(entry) {
  let node = nodes.get(entry.i);
  if (!entry.x.trim()) {
    node?.remove();
    nodes.delete(entry.i);
    return;
  }
  const language = entry.k === "t" ? view.meta.target : view.meta.source;
  if (!node) {
    node = document.createElement("p");
    node.className = "line";
    els.lines.append(node);
    nodes.set(entry.i, node);
  }
  node.lang = entry.l || language.lang;
  node.classList.toggle("cjk", Boolean(language.cjk));
  node.classList.toggle("live", !entry.f);
  if (node.textContent !== entry.x) node.textContent = entry.x;
}

function pruneLines() {
  while (nodes.size > MAX_LINES) {
    const [id, node] = nodes.entries().next().value;
    node.remove();
    nodes.delete(id);
  }
}

// The newest line is brightest; the two before it stay readable; older ones fade back.
function afterLinesChanged(follow) {
  for (const node of highlighted) node.classList.remove("latest", "recent");
  const all = els.lines.children;
  highlighted = [all[all.length - 1], all[all.length - 2], all[all.length - 3]].filter(Boolean);
  highlighted[0]?.classList.add("latest");
  highlighted[1]?.classList.add("recent");
  highlighted[2]?.classList.add("recent");
  renderEmpty();
  if (follow) scrollToBottom();
  else if (nodes.size) els.jumpBtn.hidden = false;
}

function renderOriginal() {
  const { meta } = view;
  const show = meta.original && meta.primary === "t" && prefs.original;
  const sources = [...view.entries.values()].filter((entry) => entry.k === "s" && entry.x.trim()).slice(-2);
  els.original.hidden = !show || sources.length === 0;
  if (!els.original.hidden) {
    els.originalText.textContent = sources.map((entry) => entry.x.trim()).join(meta.source.cjk ? "" : " ");
    els.originalText.lang = sources.at(-1)?.l || meta.source.lang;
  }
  document.documentElement.style.setProperty("--original-height", `${els.original.hidden ? 0 : els.original.offsetHeight}px`);
}

function currentStatus() {
  if (view.connection === "gone") return ["ended", "找不到分享"];
  if (view.ended) return ["ended", "已結束"];
  if (view.connection === "connecting") return ["connecting", "連線中"];
  if (view.connection === "reconnecting") return ["reconnecting", "重新連線中"];
  if (!view.hostOnline && Date.now() - view.hostOfflineSince >= HOST_OFFLINE_GRACE_MS) return ["offline", "講者端離線"];
  if (view.state.status === "paused") return ["paused", "暫停分享"];
  if (view.state.status === "live") return ["live", "直播中"];
  return ["waiting", nodes.size ? "暫停中" : "等待開始"];
}

function renderStatus() {
  const [state, text] = currentStatus();
  els.status.dataset.state = state;
  els.statusText.textContent = text;
  const note = view.ended || view.connection === "gone" ? "" : view.state.note;
  els.note.hidden = !note;
  if (note && els.noteText.textContent !== note) els.noteText.textContent = note;
  els.ended.hidden = !(view.ended && nodes.size);
  renderEmpty(state);
}

const EMPTY_STATES = {
  connecting: ["連線中…", "正在連到這場分享。", "spin"],
  reconnecting: ["重新連線中…", "網路恢復後會自動接續。", "spin"],
  ended: ["分享已結束", "感謝收看。", "still"],
  gone: ["找不到這場分享", "可能已經結束，或連結有誤。請重新掃描現場的 QR Code。", "still"],
  offline: ["講者端暫時離線", "恢復連線後會自動接續。", "spin"],
  paused: ["講者暫停分享中", "稍後會繼續。", "still"],
  live: ["正在聆聽…", "講者開口後，翻譯會出現在這裡。", "spin"],
  waiting: ["等待講者開始", "翻譯會即時出現在這裡，請保持這個畫面開著。", "spin"],
};

function renderEmpty(state = currentStatus()[0]) {
  const empty = nodes.size === 0;
  els.empty.hidden = !empty;
  if (!empty) return;
  const key = view.connection === "gone" ? "gone" : state;
  const [title, hint, kind] = EMPTY_STATES[key] ?? EMPTY_STATES.waiting;
  els.emptyTitle.textContent = title;
  els.emptyHint.textContent = hint;
  els.empty.dataset.kind = kind;
}

function isNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = els.feed;
  return scrollHeight - scrollTop - clientHeight < 80;
}

function scrollToBottom() {
  els.feed.scrollTop = els.feed.scrollHeight;
  els.jumpBtn.hidden = true;
}

// ---- settings -----------------------------------------------------------------------------------

function loadPrefs() {
  const defaults = { scale: 1, theme: "dark", original: true };
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      scale: Number.isFinite(stored.scale) ? Math.min(2, Math.max(0.8, stored.scale)) : defaults.scale,
      theme: ["dark", "light", "auto"].includes(stored.theme) ? stored.theme : defaults.theme,
      original: typeof stored.original === "boolean" ? stored.original : defaults.original,
    };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode: settings last for this visit only.
  }
}

function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.style.setProperty("--scale", String(prefs.scale));
  els.scaleInput.value = String(prefs.scale);
  els.originalToggle.checked = prefs.original;
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-checked", String(button.dataset.themeChoice === prefs.theme));
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#111311");
}

function setScale(value) {
  const follow = isNearBottom();
  prefs.scale = Math.round(Math.min(2, Math.max(0.8, value)) * 10) / 10;
  savePrefs();
  applyPrefs();
  if (follow) scrollToBottom();
}

function setSheetOpen(open) {
  els.sheet.hidden = !open;
  els.scrim.hidden = !open;
  els.settingsBtn.setAttribute("aria-expanded", String(open));
}

function bindControls() {
  els.settingsBtn.addEventListener("click", () => setSheetOpen(els.sheet.hidden));
  els.closeSheetBtn.addEventListener("click", () => setSheetOpen(false));
  els.scrim.addEventListener("click", () => setSheetOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setSheetOpen(false);
  });
  els.smallerBtn.addEventListener("click", () => setScale(prefs.scale - 0.1));
  els.largerBtn.addEventListener("click", () => setScale(prefs.scale + 0.1));
  els.scaleInput.addEventListener("input", () => setScale(Number(els.scaleInput.value)));
  els.originalToggle.addEventListener("change", () => {
    prefs.original = els.originalToggle.checked;
    savePrefs();
    renderOriginal();
  });
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.addEventListener("click", () => {
      prefs.theme = button.dataset.themeChoice;
      savePrefs();
      applyPrefs();
    });
  }
  els.jumpBtn.addEventListener("click", scrollToBottom);
  els.feed.addEventListener("scroll", () => {
    if (isNearBottom()) els.jumpBtn.hidden = true;
  });
  window.addEventListener("resize", () => renderOriginal());
}
