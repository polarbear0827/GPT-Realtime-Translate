// Audience sharing: settings for the relay (a Cloudflare Worker the user deploys, see relay/) and the
// page's Content-Security-Policy, which must allow exactly that relay. Mirrored by ShareRules in
// src/macos/RealtimeBackend.swift; tests/contract.test.mjs keeps the two in sync.

import { ValidationError } from "./realtime.mjs";

export const PUBLISH_KEY_PATTERN = /^kltp_[A-Za-z0-9_-]{32,96}$/;
export const ROOM_TITLE_MAX_CHARS = 80;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const BASE_CONNECT_SOURCES = "'self' https://api.openai.com wss://api.openai.com";

export function contentSecurityPolicy(relayOrigin = null) {
  const relay = relayOrigin ? ` ${relayOrigin} ${relayOrigin.replace(/^http/, "ws")}` : "";
  return (
    `default-src 'self'; connect-src ${BASE_CONNECT_SOURCES}${relay}; media-src 'self' blob:; ` +
    "img-src 'self' data:; style-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'; " +
    "base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
  );
}

// Accepts "https://host", "host" (https is assumed) or a full link to the relay; returns its origin.
// Plain http is only allowed for a relay running on this computer (wrangler dev).
export function normalizeRelayUrl(value) {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ValidationError("請輸入分享伺服器網址。");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ValidationError("分享伺服器網址格式不正確。");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local)) || !url.hostname || url.username || url.password) {
    throw new ValidationError("分享伺服器網址必須以 https:// 開頭。");
  }
  return url.origin;
}

export function validatePublishKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!PUBLISH_KEY_PATTERN.test(key)) throw new ValidationError("發佈金鑰格式不正確，應以 kltp_ 開頭。");
  return key;
}

export function normalizeRoomTitle(value) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, ROOM_TITLE_MAX_CHARS)
    : "";
}
