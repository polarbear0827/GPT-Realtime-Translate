import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after, before, test } from "node:test";
import { startServer } from "../server/index.mjs";

// OpenAI is stubbed: the server calls the global fetch, the tests talk to the server with node:http.
const upstreamCalls = [];
let modelStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  upstreamCalls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
  if (String(url).includes("/models/")) return new Response("{}", { status: modelStatus });
  return new Response(JSON.stringify({ value: "ek_test_secret" }), { status: 200, headers: { "Content-Type": "application/json" } });
};

let instance;
let token;
before(async () => {
  instance = startServer({ port: 0 });
  await new Promise((resolve) => instance.server.once("listening", resolve));
  const page = await call({ path: "/" });
  token = page.body.match(/name="klt-token" content="([^"]+)"/)[1];
});
after(() => instance.server.close());

function call({ method = "GET", path, headers = {}, body, auth = false, host }) {
  return new Promise((resolve, reject) => {
    const allHeaders = { Host: host ?? `127.0.0.1:${instance.port}`, ...headers };
    if (auth) allHeaders["X-KLT-Token"] = token;
    const req = httpRequest({ host: "127.0.0.1", port: instance.port, method, path, headers: allHeaders }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // Not JSON.
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const json = { "Content-Type": "application/json" };

test("serves the UI with a per-launch token and security headers", async () => {
  const page = await call({ path: "/" });
  assert.equal(page.status, 200);
  assert.ok(token && token !== "__KLT_TOKEN__");
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
});

test("rejects foreign Host headers (DNS rebinding)", async () => {
  assert.equal((await call({ path: "/", host: `attacker.example:${instance.port}` })).status, 403);
  assert.equal((await call({ path: "/api/health", auth: true, host: `attacker.example:${instance.port}` })).status, 403);
});

test("API requires the launch token", async () => {
  assert.equal((await call({ path: "/api/health" })).status, 403);
  const health = await call({ path: "/api/health", auth: true });
  assert.equal(health.status, 200);
  assert.equal(health.json.hasApiKey, false);
});

test("rejects cross-origin and non-JSON requests (CSRF)", async () => {
  const key = { apiKey: "sk-test-0000000000000000000000" };
  assert.equal((await call({ method: "POST", path: "/api/key", auth: true, headers: { ...json, Origin: "https://attacker.example" }, body: key })).status, 403);
  assert.equal((await call({ method: "POST", path: "/api/key", auth: true, headers: { "Content-Type": "text/plain" }, body: key })).status, 415);
});

test("malformed and oversized bodies get 400 / 413", async () => {
  assert.equal((await call({ method: "POST", path: "/api/key", auth: true, headers: json, body: "{not json" })).status, 400);
  const big = JSON.stringify({ apiKey: "x".repeat(20_000) });
  assert.equal((await call({ method: "POST", path: "/api/key", auth: true, headers: json, body: big })).status, 413);
});

test("missing files are 404 and traversal is blocked", async () => {
  assert.equal((await call({ path: "/favicon.ico" })).status, 404);
  assert.notEqual((await call({ path: "/../package.json" })).status, 200);
  assert.notEqual((await call({ path: "/%2e%2e/package.json" })).status, 200);
});

test("key is verified with OpenAI before it is accepted", async () => {
  modelStatus = 401;
  const rejected = await call({ method: "POST", path: "/api/key", auth: true, headers: json, body: { apiKey: "sk-test-0000000000000000000000" } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error, /拒絕/);

  modelStatus = 404;
  const warned = await call({ method: "POST", path: "/api/key", auth: true, headers: json, body: { apiKey: "sk-test-0000000000000000000000" } });
  assert.equal(warned.status, 200);
  assert.ok(warned.json.warnings.some((warning) => warning.includes("gpt-live-transcribe")));
  modelStatus = 200;
});

test("transcription client secret uses gpt-live-transcribe with languages, keywords and prompt", async () => {
  await call({ method: "POST", path: "/api/key", auth: true, headers: json, body: { apiKey: "sk-test-0000000000000000000000" } });
  upstreamCalls.length = 0;
  const response = await call({
    method: "POST",
    path: "/api/realtime/transcription-client-secret",
    auth: true,
    headers: json,
    body: { sourceLanguage: "en", delay: "medium", prompt: "Product keynote", keywords: "OpenAI\nGPT\n<b>bold</b>" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.value, "ek_test_secret");
  const [upstream] = upstreamCalls;
  assert.equal(upstream.url, "https://api.openai.com/v1/realtime/client_secrets");
  const transcription = upstream.body.session.audio.input.transcription;
  assert.deepEqual(transcription, {
    model: "gpt-live-transcribe",
    languages: ["en"],
    delay: "medium",
    prompt: "Product keynote",
    keywords: ["OpenAI", "GPT", "b bold /b"],
  });
  assert.equal("language" in transcription, false);
  assert.equal(upstream.body.session.audio.input.turn_detection, null);
});

test("translation client secret and validation", async () => {
  upstreamCalls.length = 0;
  const ok = await call({ method: "POST", path: "/api/realtime/translation-client-secret", auth: true, headers: json, body: { targetLanguage: "ja", noiseReduction: "far_field" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(upstreamCalls[0].body, {
    session: { model: "gpt-realtime-translate", audio: { input: { noise_reduction: { type: "far_field" } }, output: { language: "ja" } } },
  });
  assert.equal((await call({ method: "POST", path: "/api/realtime/translation-client-secret", auth: true, headers: json, body: { targetLanguage: "xx" } })).status, 400);
  assert.equal((await call({ method: "POST", path: "/api/realtime/transcription-client-secret", auth: true, headers: json, body: { delay: "fast" } })).status, 400);
});

test("deleting the key", async () => {
  assert.equal((await call({ method: "DELETE", path: "/api/key", auth: true })).status, 200);
  assert.equal((await call({ path: "/api/health", auth: true })).json.hasApiKey, false);
  assert.equal((await call({ method: "POST", path: "/api/realtime/translation-client-secret", auth: true, headers: json, body: {} })).status, 401);
});
