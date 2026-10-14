import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after, before, test } from "node:test";
import { startServer } from "../server/index.mjs";

// OpenAI is stubbed: the server calls the global fetch, the tests talk to the server with node:http.
const upstreamCalls = [];
let modelStatus = 200;
let geminiModelStatus = 200;
const GEMINI_KEY = "AIzaSyTest-0123456789abcdefghijklmnopq";
let segmentReply = { status: 200, body: { choices: [{ message: { content: "儘管前期人頭一直往下掉\n所以他的大樹" } }] } };
const RELAY_KEY = "kltp_test_0123456789abcdefghijklmnopqrstuvwxyz";
let relaySocketUrl = "wss://relay.test/api/rooms/abcdefghjkmn/host";
globalThis.fetch = async (url, init = {}) => {
  upstreamCalls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
  if (String(url).startsWith("https://down.test")) throw new TypeError("fetch failed");
  if (String(url).startsWith("https://relay.test")) {
    if (init.headers?.Authorization !== `Bearer ${RELAY_KEY}`) return Response.json({ error: "發佈金鑰不正確。" }, { status: 401 });
    if (String(url).endsWith("/api/verify")) return Response.json({ ok: true });
    return Response.json({ room: "abcdefghjkmn", hostToken: "host-token", viewerUrl: "https://relay.test/r/abcdefghjkmn", socketUrl: relaySocketUrl });
  }
  if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
    if (init.headers?.["x-goog-api-key"] !== GEMINI_KEY) return Response.json({ error: { message: "API key not valid." } }, { status: 400 });
    if (String(url).endsWith("/auth_tokens")) return Response.json({ name: "auth_tokens/test-token" });
    if (String(url).endsWith(":generateContent")) return Response.json({ candidates: [{ content: { parts: [{ text: "儘管前期人頭一直往下掉\n所以他的大樹" }] } }] });
    return new Response("{}", { status: geminiModelStatus });
  }
  if (String(url).includes("/models/")) return new Response("{}", { status: modelStatus });
  if (String(url).endsWith("/chat/completions")) return Response.json(segmentReply.body, { status: segmentReply.status });
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
  assert.ok(warned.json.warnings.some((warning) => warning.includes("gpt-4.1-mini") && warning.includes("智慧斷句")));
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

test("smart line breaks: the open phrase goes to the text model, its lines come back", async () => {
  const body = { language: "zh", text: "儘管前期人頭一直往下掉所以他的大樹", context: "有經濟差" };
  const response = await call({ method: "POST", path: "/api/segment", auth: true, headers: json, body });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.lines, ["儘管前期人頭一直往下掉", "所以他的大樹"]);
  const upstream = upstreamCalls.at(-1);
  assert.equal(upstream.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(upstream.body.model, "gpt-4.1-mini");
  assert.equal(upstream.body.temperature, 0);
  assert.match(upstream.body.messages[0].content, /never|exactly/i);
  assert.equal(upstream.body.messages[1].content, "Previous line:\n有經濟差\n\nText:\n儘管前期人頭一直往下掉所以他的大樹");

  segmentReply = { status: 404, body: { error: { message: "The model `gpt-4.1-mini` does not exist" } } };
  const missing = await call({ method: "POST", path: "/api/segment", auth: true, headers: json, body });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /does not exist/);
  segmentReply = { status: 200, body: { choices: [] } };
  assert.equal((await call({ method: "POST", path: "/api/segment", auth: true, headers: json, body })).status, 502);

  const invalid = await call({ method: "POST", path: "/api/segment", auth: true, headers: json, body: { language: "zh", text: "  " } });
  assert.equal(invalid.status, 400);
});

test("Gemini: the key is checked with Google, then tokens are locked to the session setup", async () => {
  const save = (apiKey) => call({ method: "POST", path: "/api/gemini/key", auth: true, headers: json, body: { apiKey } });
  assert.equal((await save("sk-not-a-gemini-key-000000000000")).status, 400);
  const rejected = await save("AIzaSyWrong-0123456789abcdefghijklmnopq");
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error, /拒絕/);
  assert.equal((await call({ method: "POST", path: "/api/gemini/translation-token", auth: true, headers: json, body: {} })).status, 401);

  geminiModelStatus = 404;
  const warned = await save(GEMINI_KEY);
  assert.equal(warned.status, 200);
  assert.ok(warned.json.warnings.some((warning) => warning.includes("gemini-3.5-live-translate-preview")));
  geminiModelStatus = 200;
  assert.equal((await call({ path: "/api/health", auth: true })).json.gemini.hasKey, true);

  const translation = await call({ method: "POST", path: "/api/gemini/translation-token", auth: true, headers: json, body: { targetLanguage: "zh" } });
  assert.equal(translation.status, 200);
  assert.equal(translation.json.token, "auth_tokens/test-token");
  assert.deepEqual(translation.json.setup.generationConfig.translationConfig, { targetLanguageCode: "zh-Hant", echoTargetLanguage: true });
  const tokenCall = upstreamCalls.at(-1);
  assert.equal(tokenCall.url, "https://generativelanguage.googleapis.com/v1beta/auth_tokens");
  assert.equal(tokenCall.body.uses, 1);
  assert.deepEqual(tokenCall.body.bidiGenerateContentSetup, translation.json.setup, "the token is locked to the setup the page sends");
  assert.ok(Date.parse(tokenCall.body.newSessionExpireTime) > Date.now());

  const transcription = await call({ method: "POST", path: "/api/gemini/transcription-token", auth: true, headers: json, body: { sourceLanguage: "en", keywords: "FlyQuest\nKarsa" } });
  assert.deepEqual(transcription.json.setup.inputAudioTranscription, { languageCodes: ["en-US"], mode: "SMART", customVocabulary: ["FlyQuest", "Karsa"] });

  const lines = await call({ method: "POST", path: "/api/segment", auth: true, headers: json, body: { provider: "gemini", language: "zh", text: "儘管前期人頭一直往下掉所以他的大樹" } });
  assert.deepEqual(lines.json.lines, ["儘管前期人頭一直往下掉", "所以他的大樹"]);
  assert.match(upstreamCalls.at(-1).url, /models\/gemini-3\.5-flash-lite:generateContent$/);

  assert.equal((await call({ method: "DELETE", path: "/api/gemini/key", auth: true })).status, 200);
  assert.equal((await call({ path: "/api/health", auth: true })).json.gemini.hasKey, false);
});

test("deleting the key", async () => {
  assert.equal((await call({ method: "DELETE", path: "/api/key", auth: true })).status, 200);
  assert.equal((await call({ path: "/api/health", auth: true })).json.hasApiKey, false);
  assert.equal((await call({ method: "POST", path: "/api/realtime/translation-client-secret", auth: true, headers: json, body: {} })).status, 401);
  assert.equal((await call({ method: "POST", path: "/api/segment", auth: true, headers: json, body: { language: "zh", text: "你好" } })).status, 401);
});

test("sharing: the relay is verified before it's saved, and the page may then connect to it", async () => {
  const save = (body) => call({ method: "POST", path: "/api/share/config", auth: true, headers: json, body });
  assert.equal((await save({ url: "ftp://relay.test", key: RELAY_KEY })).status, 400);
  assert.equal((await save({ url: "https://relay.test", key: "nope" })).status, 400);
  const unreachable = await save({ url: "https://down.test", key: RELAY_KEY });
  assert.equal(unreachable.status, 502);
  assert.match(unreachable.json.error, /無法連線/);
  const wrongKey = await save({ url: "https://relay.test", key: `${RELAY_KEY}x` });
  assert.equal(wrongKey.status, 400);
  assert.match(wrongKey.json.error, /拒絕/);
  assert.equal((await call({ method: "POST", path: "/api/share/rooms", auth: true, headers: json, body: {} })).status, 409);

  const saved = await save({ url: " relay.test/r/whatever ", key: RELAY_KEY });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.origin, "https://relay.test");
  const health = await call({ path: "/api/health", auth: true });
  assert.deepEqual(health.json.share, { configured: true, origin: "https://relay.test" });
  const page = await call({ path: "/" });
  assert.match(page.headers["content-security-policy"], /connect-src 'self' https:\/\/api\.openai\.com wss:\/\/api\.openai\.com wss:\/\/generativelanguage\.googleapis\.com https:\/\/relay\.test wss:\/\/relay\.test;/);
});

test("sharing: rooms are created with the publish key and checked", async () => {
  upstreamCalls.length = 0;
  const room = await call({ method: "POST", path: "/api/share/rooms", auth: true, headers: json, body: { title: "  大會\n名稱 " } });
  assert.equal(room.status, 200);
  assert.equal(room.json.socketUrl, relaySocketUrl);
  assert.equal(upstreamCalls[0].url, "https://relay.test/api/rooms");
  assert.deepEqual(upstreamCalls[0].body, { title: "大會 名稱" });

  relaySocketUrl = "wss://relay.test.evil.example/api/rooms/x/host";
  const tampered = await call({ method: "POST", path: "/api/share/rooms", auth: true, headers: json, body: {} });
  assert.equal(tampered.status, 502);
  relaySocketUrl = "wss://relay.test/api/rooms/abcdefghjkmn/host";

  assert.equal((await call({ method: "DELETE", path: "/api/share/config", auth: true })).status, 200);
  assert.equal((await call({ path: "/api/health", auth: true })).json.share.configured, false);
  assert.doesNotMatch((await call({ path: "/" })).headers["content-security-policy"], /relay\.test/);
});
