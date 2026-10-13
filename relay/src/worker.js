// Keynote Live Translator relay: the app publishes caption text to a room, and audience phones that
// scan the room's QR code receive it. One Durable Object per room fans the text out over WebSockets,
// so the app uploads a single stream no matter how many people watch.
//
// Routes
//   GET  /r/<room>               viewer page
//   POST /api/rooms              create a room (Authorization: Bearer <PUBLISH_KEY>)
//   GET  /api/verify             check the publish key
//   GET  /api/rooms/<room>/host  WebSocket for the app (authenticates with the room's host token)
//   GET  /api/rooms/<room>/live  WebSocket for viewers (receive only)

import { DurableObject } from "cloudflare:workers";
import { LIMITS, ROOM_ID_PATTERN, RoomState, cleanText } from "./room-state.js";

const VERSION = "1.0.0";
const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const ROOM_ID_LENGTH = 12;
const ALARM_EVERY_MS = 60 * 60 * 1000;
// A room whose host has been gone this long is deleted (the app can resume a room after a restart).
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const VIEWER_COUNT_DELAY_MS = 1000;
const RESYNC_RETRY_MS = 5000;
const OPEN = 1;

const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/") return page(request, env, "/index.html");
    if (pathname === "/go") {
      const code = url.searchParams.get("code")?.trim().toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
      return Response.redirect(new URL(ROOM_ID_PATTERN.test(code) ? `/r/${code}` : "/?missing=1", url), 303);
    }
    let match = pathname.match(/^\/r\/([a-z0-9]{10,16})\/?$/);
    if (match) return page(request, env, "/viewer.html");

    if (pathname === "/api/health") return json({ ok: true, version: VERSION });
    if (pathname === "/api/verify" && request.method === "GET") {
      const denied = await authorize(request, env);
      return denied ?? json({ ok: true, version: VERSION });
    }
    if (pathname === "/api/rooms" && request.method === "POST") {
      const denied = await authorize(request, env);
      return denied ?? createRoom(request, env, url);
    }
    match = pathname.match(/^\/api\/rooms\/([a-z0-9]{10,16})\/(host|live)$/);
    if (match) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "需要 WebSocket 連線。" }, 426);
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    return json({ error: "Not found." }, 404);
  },
};

async function page(request, env, asset) {
  const response = await env.ASSETS.fetch(new Request(new URL(asset, request.url), request));
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
  headers.set("Cache-Control", "no-cache");
  return new Response(response.body, { status: response.status, headers });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function authorize(request, env) {
  if (!env.PUBLISH_KEY) return json({ error: "分享伺服器還沒有設定發佈金鑰（PUBLISH_KEY）。" }, 503);
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return (await sameSecret(given, env.PUBLISH_KEY)) ? null : json({ error: "發佈金鑰不正確。" }, 401);
}

async function sameSecret(a, b) {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(left, right);
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function randomRoomId() {
  let id = "";
  const limit = 256 - (256 % ROOM_ALPHABET.length);
  while (id.length < ROOM_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && id.length < ROOM_ID_LENGTH) id += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
    }
  }
  return id;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createRoom(request, env, url) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is fine.
  }
  const room = randomRoomId();
  const hostToken = randomToken();
  await env.ROOMS.get(env.ROOMS.idFromName(room)).create({
    tokenHash: hex(await sha256(hostToken)),
    title: cleanText(body?.title, LIMITS.titleChars),
  });
  const socketOrigin = url.origin.replace(/^http/, "ws");
  return json({
    room,
    hostToken,
    viewerUrl: `${url.origin}/r/${room}`,
    socketUrl: `${socketOrigin}/api/rooms/${room}/host`,
  });
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = new RoomState();
    this.info = null;
    this.viewerTimer = null;
    this.lastViewerCount = -1;
    this.resyncAskedAt = -Infinity;
    // Viewers ping to keep mobile connections alive; answering them doesn't wake this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get(["info", "saved"]);
      this.info = stored.get("info") ?? null;
      this.room.load(stored.get("saved"));
    });
  }

  async create({ tokenHash, title }) {
    const now = Date.now();
    this.info = { tokenHash, createdAt: now, lastHostAt: now };
    this.room = new RoomState();
    this.room.meta.title = title;
    await this.ctx.storage.put({ info: this.info, saved: this.room.saved() });
    await this.ctx.storage.setAlarm(now + ALARM_EVERY_MS);
  }

  async fetch(request) {
    const role = new URL(request.url).pathname.endsWith("/host") ? "host" : "viewer";
    const [client, server] = Object.values(new WebSocketPair());
    if (!this.info) {
      // Accept, explain and close: a failed upgrade would look like a network error to the browser,
      // which would keep retrying.
      server.accept();
      server.send(JSON.stringify({ t: "gone" }));
      server.close(4404, "room not found");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, [role]);
    if (role === "viewer") {
      server.send(this.room.snapshotText(this.hostOnline()));
      if (!this.room.synced) this.askResync();
      this.scheduleViewerCount();
    } else {
      server.serializeAttachment({ authed: false });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // Viewers only receive. Anything they send (other than the auto-answered ping) is ignored.
    if (this.ctx.getTags(ws)[0] !== "host" || !this.info) return;
    if (typeof message !== "string" || message.length > LIMITS.messageChars) {
      ws.close(1009, "message too large");
      return;
    }
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (!ws.deserializeAttachment()?.authed) {
      const token = typeof data?.token === "string" ? data.token : "";
      if (data?.t !== "auth" || !(await sameSecret(hex(await sha256(token)), this.info.tokenHash))) {
        ws.send(JSON.stringify({ t: "error", code: "auth", message: "分享權杖不正確。" }));
        ws.close(4401, "unauthorized");
        return;
      }
      ws.serializeAttachment({ authed: true });
      // One host per room: a newer connection (for example after the app restarts) replaces the old one.
      for (const other of this.ctx.getWebSockets("host")) {
        if (other !== ws) other.close(4409, "replaced");
      }
      this.info.lastHostAt = Date.now();
      await this.ctx.storage.put("info", this.info);
      ws.send(JSON.stringify({ t: "welcome", viewers: this.viewerCount(), synced: this.room.synced }));
      this.broadcast({ t: "host", online: true });
      return;
    }

    if (data?.t === "end") {
      await this.end();
      return;
    }
    const result = this.room.applyHost(data);
    if (data?.t === "sync") this.resyncAskedAt = -Infinity;
    if (result.reply?.t === "resync") this.askResync();
    else if (result.reply) ws.send(JSON.stringify(result.reply));
    if (result.broadcast) this.broadcast(result.broadcast);
    if (result.persist) await this.ctx.storage.put("saved", this.room.saved());
  }

  async webSocketClose(ws, code, reason) {
    this.closed(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws) {
    this.closed(ws);
  }

  closed(ws) {
    if (this.ctx.getTags(ws)[0] === "viewer") {
      this.scheduleViewerCount();
      return;
    }
    if (!this.info || !ws.deserializeAttachment()?.authed || this.hostOnline(ws)) return;
    this.broadcast({ t: "host", online: false });
    this.info.lastHostAt = Date.now();
    this.ctx.storage.put("info", this.info);
  }

  async alarm() {
    if (!this.info) return;
    const now = Date.now();
    if (this.hostOnline()) {
      this.info.lastHostAt = now;
      await this.ctx.storage.put("info", this.info);
    }
    if (now - this.info.lastHostAt > ROOM_TTL_MS) {
      await this.end();
      return;
    }
    await this.ctx.storage.setAlarm(now + ALARM_EVERY_MS);
  }

  async end() {
    this.broadcast({ t: "end" });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4000, "ended");
      } catch {
        // Already closed.
      }
    }
    this.info = null;
    this.room = new RoomState();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  hostOnline(except = null) {
    return this.ctx.getWebSockets("host").some((ws) => ws !== except && ws.readyState === OPEN && ws.deserializeAttachment()?.authed);
  }

  viewerCount() {
    return this.ctx.getWebSockets("viewer").filter((ws) => ws.readyState === OPEN).length;
  }

  // After an eviction only the host can rebuild the captions. Asked at most every few seconds, however
  // many viewers join meanwhile.
  askResync() {
    const now = Date.now();
    if (now - this.resyncAskedAt < RESYNC_RETRY_MS) return;
    this.resyncAskedAt = now;
    this.sendToHost({ t: "resync" });
  }

  sendToHost(message) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets("host")) {
      if (!ws.deserializeAttachment()?.authed) continue;
      try {
        ws.send(text);
      } catch {
        // The close handler cleans up.
      }
    }
  }

  // Serialized once, sent to every viewer.
  broadcast(message) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets("viewer")) {
      try {
        ws.send(text);
      } catch {
        // The close handler cleans up.
      }
    }
  }

  // Joins and leaves arrive in bursts (a room filling up); the host gets at most one count per second.
  scheduleViewerCount() {
    if (this.viewerTimer) return;
    this.viewerTimer = setTimeout(() => {
      this.viewerTimer = null;
      const count = this.viewerCount();
      if (count === this.lastViewerCount) return;
      this.lastViewerCount = count;
      this.sendToHost({ t: "viewers", n: count });
    }, VIEWER_COUNT_DELAY_MS);
  }
}
