import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SharePublisher, buildMeta, flushInterval } from "../public/js/share.js";
import { TranscriptStore } from "../public/js/transcript.js";

const LANGUAGES = {
  en: { label: "英文", targetLabel: "英文", lang: "en", cjk: false },
  zh: { label: "中文", targetLabel: "繁體中文", lang: "zh-Hant", cjk: true },
};
const languageInfo = (code) => LANGUAGES[code];
const ROOM = { room: "abcdefghjkmn", hostToken: "host-token", viewerUrl: "https://relay.test/r/abcdefghjkmn", socketUrl: "wss://relay.test/api/rooms/abcdefghjkmn/host" };

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code) {
    this.closed = true;
    this.onclose?.({ code });
  }

  take(type) {
    const found = this.sent.filter((message) => message.t === type);
    this.sent = this.sent.filter((message) => message.t !== type);
    return found;
  }
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => {
      nextId += 1;
      timers.set(nextId, { fn, at: now + ms });
      return nextId;
    },
    clearTimeout: (id) => timers.delete(id),
    now: () => now,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

let clock;
let feed;
let publisher;
let changes;

function setup({ original = false, mode = "bilingual" } = {}) {
  FakeSocket.instances = [];
  clock = fakeClock();
  feed = new TranscriptStore();
  changes = 0;
  publisher = new SharePublisher(
    { feed, display: (text, language) => (language === "zh" ? text.replaceAll("这", "這") : text), languageInfo, onChange: () => (changes += 1) },
    { WebSocket: FakeSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5 },
  );
  const meta = buildMeta({ title: "大會", mode, sourceLanguage: "en", targetLanguage: "zh", original, languageInfo });
  return meta;
}

function connect(meta, options = {}) {
  publisher.start(ROOM, { meta, ...options });
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  socket.receive({ t: "welcome", viewers: 3 });
  return socket;
}

const translate = (delta) => feed.appendStream("translation", { track: "translation", language: "zh", delta, atMs: 0, cjk: true });
const transcribe = (item, transcript) => feed.upsertItem(item, { track: "source", language: "en", startMs: 0, endMs: 1000, transcript });

beforeEach(() => setup());

test("authenticates, then sends the full state", () => {
  const meta = setup();
  publisher.start(ROOM, { meta, sessionStatus: "live" });
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, ROOM.socketUrl);
  assert.equal(publisher.phase, "connecting");
  socket.open();
  assert.deepEqual(socket.sent, [{ t: "auth", token: "host-token" }]);
  socket.receive({ t: "welcome", viewers: 3 });
  assert.equal(publisher.phase, "live");
  assert.equal(publisher.viewers, 3);
  const [sync] = socket.take("sync");
  assert.deepEqual(sync.meta, meta);
  assert.deepEqual(sync.state, { status: "live", note: "" });
  assert.deepEqual(sync.entries, []);
  socket.receive({ t: "viewers", n: 1200 });
  assert.equal(publisher.viewers, 1200);
});

test("publishes new sentences as they grow, a few times per second", () => {
  translate("之前說的話。");
  const socket = connect(setup());
  socket.sent = [];
  translate("这是");
  translate("第一句");
  assert.equal(socket.sent.length, 0, "batched");
  clock.advance(250);
  const [first] = socket.take("up");
  assert.equal(first.e.length, 1, "what was said before sharing started stays private");
  const id = first.e[0].i;
  assert.match(id, /^\w{4}e\d+$/);
  assert.deepEqual(first.e[0], { i: id, k: "t", x: "這是第一句", l: "zh-Hant" });

  translate("。下");
  clock.advance(250);
  const [second] = socket.take("up");
  assert.deepEqual(second.e[0], { i: id, a: "。", f: 1 });
  assert.equal(second.e[1].k, "t");
  assert.equal(second.e[1].x, "下");
});

test("the original is only sent when viewers may see it", () => {
  const meta = setup({ original: false });
  const socket = connect(meta);
  socket.sent = [];
  transcribe("item1", "Hello everyone.");
  translate("大家好");
  clock.advance(250);
  let [up] = socket.take("up");
  assert.deepEqual(
    up.e.map((op) => op.k),
    ["t"],
  );

  publisher.setMeta({ ...meta, original: true });
  assert.equal(socket.take("meta").length, 1);
  transcribe("item2", "Welcome.");
  clock.advance(250);
  [up] = socket.take("up");
  assert.deepEqual(up.e.map((op) => [op.k, op.x]), [["s", "Welcome."]]);

  publisher.setMeta({ ...meta, original: false });
  [up] = socket.take("up");
  assert.deepEqual(up.e, [{ i: up.e[0].i, d: 1 }], "the shown original is withdrawn");
});

test("pausing freezes what viewers have and never sends what's said meanwhile", () => {
  const socket = connect(setup(), { sessionStatus: "live" });
  socket.sent = [];
  translate("公開的");
  clock.advance(250);
  const id = socket.take("up")[0].e[0].i;

  publisher.setPaused(true);
  assert.deepEqual(socket.take("up")[0].e, [{ i: id, f: 1 }]);
  assert.deepEqual(socket.take("state")[0].state, { status: "paused", note: "" });
  translate("內部討論，不要外流。");
  translate("還有這句。");
  clock.advance(1000);
  assert.equal(socket.take("up").length, 0);

  publisher.setPaused(false);
  assert.deepEqual(socket.take("state")[0].state, { status: "live", note: "" });
  translate("繼續公開。");
  translate("下一句");
  clock.advance(250);
  const texts = socket.take("up").flatMap((message) => message.e.map((op) => op.x ?? op.a));
  assert.ok(!texts.some((text) => text?.includes("內部") || text?.includes("還有")), JSON.stringify(texts));
  assert.ok(texts.includes("下一句"), JSON.stringify(texts));
});

test("announcements and the session state go to viewers", () => {
  const socket = connect(setup());
  socket.sent = [];
  publisher.setNote("  中場休息 10 分鐘  ");
  assert.deepEqual(socket.take("state")[0].state, { status: "idle", note: "中場休息 10 分鐘" });
  publisher.setSessionStatus("live");
  assert.deepEqual(socket.take("state")[0].state, { status: "live", note: "中場休息 10 分鐘" });
  publisher.setSessionStatus("live");
  assert.equal(socket.take("state").length, 0, "unchanged state isn't resent");
});

test("reconnects with backoff and catches viewers up", () => {
  const socket = connect(setup());
  translate("第一句。第二");
  clock.advance(250);
  socket.serverClose(1006);
  assert.equal(publisher.phase, "reconnecting");
  translate("句說到一半斷線了。");
  clock.advance(999);
  assert.equal(FakeSocket.instances.length, 1);
  clock.advance(1);
  const next = FakeSocket.instances[1];
  next.open();
  next.receive({ t: "welcome", viewers: 2 });
  const [sync] = next.take("sync");
  assert.deepEqual(
    sync.entries.map((entry) => entry.x),
    ["第一句。", "第二"],
  );
  const [up] = next.take("up");
  assert.deepEqual(up.e.at(-1).a, "句說到一半斷線了。");

  next.receive({ t: "resync" });
  assert.equal(next.take("sync").length, 1);
});

test("a replaced or missing room stops publishing with a message", () => {
  let socket = connect(setup());
  socket.serverClose(4409);
  assert.equal(publisher.phase, "failed");
  assert.match(publisher.error, /另一個視窗/);
  clock.advance(60_000);
  assert.equal(FakeSocket.instances.length, 1);

  socket = connect(setup());
  socket.receive({ t: "gone" });
  assert.equal(publisher.phase, "failed");
  assert.match(publisher.error, /不存在/);
});

test("ending tells the relay and resolves when it closes", async () => {
  const socket = connect(setup());
  const ended = publisher.end();
  assert.equal(socket.take("end").length, 1);
  socket.serverClose(4000);
  await ended;
  assert.equal(publisher.phase, "ended");
  translate("結束後的話。");
  clock.advance(1000);
  assert.equal(socket.take("up").length, 0);
});

test("ending while disconnected reconnects just to end the room", async () => {
  const socket = connect(setup());
  socket.serverClose(1006);
  const ended = publisher.end();
  const retry = FakeSocket.instances.at(-1);
  assert.notEqual(retry, socket);
  retry.open();
  retry.receive({ t: "welcome", viewers: 0 });
  assert.equal(retry.take("end").length, 1);
  assert.equal(retry.take("sync").length, 0);
  retry.serverClose(4000);
  await ended;
  assert.equal(publisher.phase, "ended");
});

test("a heartbeat keeps the room awake during silence", () => {
  const socket = connect(setup());
  socket.sent = [];
  clock.advance(10_000);
  assert.equal(socket.take("hb").length, 1);
});

test("only the main track is shared in source-only mode", () => {
  const socket = connect(setup({ mode: "source", original: true }));
  socket.sent = [];
  transcribe("item1", "Captions only.");
  translate("不會送出");
  clock.advance(250);
  const [up] = socket.take("up");
  assert.deepEqual(up.e.map((op) => [op.k, op.x]), [["s", "Captions only."]]);
});

test("the feed stays bounded during a long event", () => {
  const socket = connect(setup());
  for (let index = 0; index < 900; index += 1) translate(`第 ${index} 句。`);
  translate("最後");
  clock.advance(250);
  assert.ok(feed.entries.length <= 400, `feed has ${feed.entries.length} entries`);
  assert.ok(publisher.published.size <= 300);
  assert.ok(socket.take("up").length >= 1);
});

test("buildMeta describes the languages for viewers", () => {
  assert.deepEqual(buildMeta({ title: " 大會 ", mode: "bilingual", sourceLanguage: "en", targetLanguage: "zh", original: true, languageInfo }), {
    title: "大會",
    primary: "t",
    original: true,
    source: { label: "英文", lang: "en", cjk: false },
    target: { label: "繁體中文", lang: "zh-Hant", cjk: true },
  });
  assert.equal(buildMeta({ mode: "source", sourceLanguage: "en", targetLanguage: "zh", original: true, languageInfo }).original, false);
});

test("large audiences get fewer, larger updates", () => {
  assert.equal(flushInterval(0), 250);
  assert.equal(flushInterval(400), 250);
  assert.equal(flushInterval(401), 500);
  assert.equal(flushInterval(1500), 500);
  assert.equal(flushInterval(1501), 1000);

  const socket = connect(setup());
  socket.receive({ t: "viewers", n: 1000 });
  socket.sent = [];
  translate("大");
  clock.advance(250);
  assert.equal(socket.take("up").length, 0);
  translate("家好");
  clock.advance(250);
  const [up] = socket.take("up");
  assert.equal(up.e[0].x, "大家好", "both changes in one update");
});
