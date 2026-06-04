import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = normalize(join(__dirname, ".."));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 8787);
const appVersion = process.env.APP_VERSION || "0.3.0";
let apiKey = null;

const translationOutputLanguages = new Set(["es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it", "en"]);
const transcriptionLanguages = new Set(["en", "zh"]);

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' https://api.openai.com wss://api.openai.com; media-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), payment=()",
};

const contentTypes = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  for (const [key, value] of Object.entries(securityHeaders)) {
    res.setHeader(key, value);
  }

  if (!isLocalhost(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: "Localhost access only." });
    return;
  }

  try {
    if (req.url === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, version: appVersion, hasApiKey: Boolean(apiKey) });
      return;
    }

    if (req.url === "/api/key" && req.method === "POST") {
      const body = await readJson(req, 8_192);
      const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (!key.startsWith("sk-") || key.length < 20) {
        sendJson(res, 400, { error: "Invalid API key format." });
        return;
      }
      apiKey = key;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.url === "/api/key" && req.method === "DELETE") {
      apiKey = null;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.url === "/api/realtime/translation-client-secret" && req.method === "POST") {
      if (!apiKey) {
        sendJson(res, 401, { error: "API key is not set." });
        return;
      }

      const body = await readJson(req, 8_192);
      const targetLanguage = typeof body.targetLanguage === "string" ? body.targetLanguage : "zh";
      if (!translationOutputLanguages.has(targetLanguage)) {
        sendJson(res, 400, { error: "Unsupported translation target language." });
        return;
      }
      const safetyIdentifier =
        typeof body.safetyIdentifier === "string" && body.safetyIdentifier.length <= 80
          ? body.safetyIdentifier
          : "local-keynote-user";

      try {
        const upstream = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": safetyIdentifier,
          },
          body: JSON.stringify({
            session: {
              model: "gpt-realtime-translate",
              audio: {
                input: {
                  noise_reduction: {
                    type: "near_field",
                  },
                },
                output: {
                  language: targetLanguage,
                },
              },
            },
          }),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": "application/json;charset=utf-8" });
        res.end(text);
      } catch {
        sendJson(res, 502, { error: "Unable to create a realtime translation client secret." });
      }
      return;
    }

    if (req.url === "/api/realtime/transcription-client-secret" && req.method === "POST") {
      if (!apiKey) {
        sendJson(res, 401, { error: "API key is not set." });
        return;
      }

      const body = await readJson(req, 8_192);
      const delay = typeof body.delay === "string" ? body.delay : "low";
      const sourceLanguage = typeof body.sourceLanguage === "string" ? body.sourceLanguage : "en";
      if (!transcriptionLanguages.has(sourceLanguage)) {
        sendJson(res, 400, { error: "Unsupported transcription source language." });
        return;
      }
      const safetyIdentifier =
        typeof body.safetyIdentifier === "string" && body.safetyIdentifier.length <= 80
          ? body.safetyIdentifier
          : "local-keynote-user";

      try {
        const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": safetyIdentifier,
          },
          body: JSON.stringify({
            expires_after: {
              anchor: "created_at",
              seconds: 600,
            },
            session: {
              type: "transcription",
              audio: {
                input: {
                  format: {
                    type: "audio/pcm",
                    rate: 24000,
                  },
                  transcription: {
                    model: "gpt-realtime-whisper",
                    language: sourceLanguage,
                    delay,
                  },
                  noise_reduction: {
                    type: "near_field",
                  },
                  turn_detection: null,
                },
              },
            },
          }),
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": "application/json;charset=utf-8" });
        res.end(text);
      } catch {
        sendJson(res, 502, { error: "Unable to create a realtime transcription client secret." });
      }
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch {
    sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Keynote Live Translator running at http://127.0.0.1:${port}`);
});

function isLocalhost(address) {
  return !address || address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function serveStatic(req, res) {
  const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
  const safePath = normalize(decodeURIComponent(parsedUrl.pathname)).replace(/^(\.\.[/\\])+/, "");
  const path = safePath === "/" ? "/index.html" : safePath;
  const filePath = join(publicDir, path);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : file);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
    res.end(fallback);
  }
}

async function readJson(req, limit) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) {
      throw new Error("Request body too large.");
    }
  }
  return data ? JSON.parse(data) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json;charset=utf-8" });
  res.end(JSON.stringify(body));
}
