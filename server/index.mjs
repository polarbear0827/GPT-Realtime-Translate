import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ValidationError,
  buildTranscriptionSecretRequest,
  buildTranslationSecretRequest,
  validateApiKeyFormat,
  validateTranscriptionRequest,
  validateTranslationRequest,
} from "./realtime.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = join(rootDir, "public");
const config = JSON.parse(readFileSync(join(publicDir, "realtime-config.json"), "utf8"));
const appVersion = readFileSync(join(rootDir, "VERSION"), "utf8").trim();
const UPSTREAM_TIMEOUT_MS = 15_000;
const OPENAI = "https://api.openai.com/v1";

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self' https://api.openai.com wss://api.openai.com; media-src 'self' blob:; " +
  "img-src 'self' data:; style-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'; " +
  "base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

const securityHeaders = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), payment=()",
};

const contentTypes = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function startServer({ port = Number(process.env.PORT || 8787), host = "127.0.0.1" } = {}) {
  // Per-launch secret: only the page served by this process knows it, so other local programs and
  // cross-site / DNS-rebinding requests cannot use the API key even though they can reach the port.
  const token = randomBytes(24).toString("base64url");
  let apiKey = null;
  let actualPort = port;

  const server = createServer(async (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);

    if (!isAllowedHost(req.headers.host, actualPort) || !isAllowedOrigin(req.headers.origin, actualPort)) {
      sendJson(res, 403, { error: "Forbidden." });
      return;
    }

    const url = new URL(req.url || "/", `http://${host}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        if (!hasValidToken(req.headers["x-klt-token"], token)) {
          sendJson(res, 403, { error: "Forbidden." });
          return;
        }
        await handleApi(req, res, url.pathname);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(req, res, url.pathname, token);
        return;
      }
      sendJson(res, 405, { error: "Method not allowed." });
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        console.error("Request failed:", error?.message || error);
        sendJson(res, 500, { error: "Internal server error." });
      }
    }
  });

  async function handleApi(req, res, pathname) {
    res.setHeader("Cache-Control", "no-store");

    if (pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, version: appVersion, hasApiKey: Boolean(apiKey), rememberedKey: false });
      return;
    }

    if (pathname === "/api/key" && req.method === "POST") {
      const body = await readJson(req);
      const key = validateApiKeyFormat(body.apiKey);
      const verification = await verifyApiKey(key);
      if (verification.rejected) {
        sendJson(res, 400, { error: verification.rejected });
        return;
      }
      apiKey = key;
      // The dev server never persists keys; "remember" is only offered by the native apps.
      sendJson(res, 200, { ok: true, remembered: false, warnings: verification.warnings });
      return;
    }

    if (pathname === "/api/key" && req.method === "DELETE") {
      apiKey = null;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/realtime/translation-client-secret" && req.method === "POST") {
      const params = validateTranslationRequest(await readJson(req), config);
      await proxyClientSecret(res, `${OPENAI}/realtime/translations/client_secrets`, buildTranslationSecretRequest(params, config));
      return;
    }

    if (pathname === "/api/realtime/transcription-client-secret" && req.method === "POST") {
      const params = validateTranscriptionRequest(await readJson(req), config);
      await proxyClientSecret(res, `${OPENAI}/realtime/client_secrets`, buildTranscriptionSecretRequest(params, config));
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  }

  async function proxyClientSecret(res, endpoint, payload) {
    if (!apiKey) {
      sendJson(res, 401, { error: "尚未設定 API key。" });
      return;
    }
    try {
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": "local-keynote-user",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "Content-Type": "application/json;charset=utf-8" });
      res.end(text);
    } catch (error) {
      const timedOut = error?.name === "TimeoutError";
      sendJson(res, timedOut ? 504 : 502, {
        error: timedOut ? "OpenAI 回應逾時，請稍後再試。" : "無法連線到 OpenAI，請檢查網路。",
      });
    }
  }

  async function readJson(req) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new ValidationError("Content-Type 必須是 application/json。", 415);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > config.limits.requestBodyMaxBytes) throw new ValidationError("Request body too large.", 413);
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      throw new ValidationError("JSON 格式錯誤。");
    }
  }

  server.listen(port, host, () => {
    actualPort = server.address().port;
    console.log(`Keynote Live Translator ${appVersion} running at http://${host}:${actualPort}`);
  });

  return {
    server,
    token,
    get port() {
      return actualPort;
    },
  };
}

// Checks the key and model access once when the key is saved, so problems surface during rehearsal
// instead of when pressing Start on stage.
export async function verifyApiKey(key, fetchImpl = fetch) {
  const models = [config.models.translation, config.models.transcription];
  const warnings = [];
  const results = await Promise.all(
    models.map(async (model) => {
      try {
        const response = await fetchImpl(`${OPENAI}/models/${model}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        });
        return { model, status: response.status };
      } catch {
        return { model, status: 0 };
      }
    }),
  );
  if (results.some((result) => result.status === 401)) {
    return { rejected: "OpenAI 拒絕這把金鑰（無效或已撤銷）。", warnings };
  }
  for (const { model, status } of results) {
    if (status === 0) warnings.push("暫時無法連線到 OpenAI 驗證金鑰，已先儲存。");
    else if (status === 403 || status === 404) warnings.push(`這把金鑰目前無法使用 ${model}。`);
    else if (status >= 400) warnings.push(`驗證 ${model} 時 OpenAI 回應 ${status}。`);
  }
  return { rejected: null, warnings: [...new Set(warnings)] };
}

export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== "string") return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader.toLowerCase());
}

export function isAllowedOrigin(origin, port) {
  if (origin === undefined) return true;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(String(origin).toLowerCase());
}

function hasValidToken(received, token) {
  if (typeof received !== "string" || received.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(token));
}

async function serveStatic(req, res, pathname, token) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "Bad request." });
    return;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = resolve(publicDir, relativePath);
  if (!filePath.startsWith(publicDir + sep)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  let file;
  try {
    file = await readFile(filePath);
  } catch {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  if (filePath.endsWith(`${sep}index.html`)) {
    file = Buffer.from(file.toString("utf8").replace('content="__KLT_TOKEN__"', `content="${token}"`));
  }
  res.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
    "Content-Length": file.length,
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : file);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json;charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server } = startServer();
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
