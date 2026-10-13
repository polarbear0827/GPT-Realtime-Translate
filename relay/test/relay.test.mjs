// End-to-end tests of the relay running in wrangler dev (workerd): rooms, host auth, fan-out to viewers,
// viewer isolation, host replacement and ending a room.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client, connectHost, createRoom, sleep, startRelay, viewerUrl } from "./helpers.mjs";

let relay;

before(async () => {
  relay = await startRelay();
});

after(async () => {
  await relay?.stop();
});

const META = {
  title: "AI 開發者大會",
  primary: "t",
  original: true,
  source: { label: "英文", lang: "en", cjk: false },
  target: { label: "繁體中文", lang: "zh-Hant", cjk: true },
};

// Like the viewer page: ping right after connecting.
async function openViewer(room) {
  const viewer = new Client(viewerUrl(relay, room.room));
  await viewer.opened;
  viewer.send("ping");
  const snapshot = await viewer.next("snapshot");
  await viewer.next((message) => message === "pong");
  return { viewer, snapshot };
}

test("the publish key is required to verify and to create rooms", async () => {
  const bad = await fetch(`${relay.url}/api/verify`, { headers: { Authorization: "Bearer kltp_wrong" } });
  assert.equal(bad.status, 401);
  const good = await fetch(`${relay.url}/api/verify`, { headers: { Authorization: `Bearer ${relay.key}` } });
  assert.equal(good.status, 200);
  const anonymous = await fetch(`${relay.url}/api/rooms`, { method: "POST" });
  assert.equal(anonymous.status, 401);
});

test("room creation returns a viewer link and a host socket", async () => {
  const room = await createRoom(relay, "測試");
  assert.match(room.room, /^[a-z0-9]{12}$/);
  assert.equal(room.viewerUrl, `${relay.url}/r/${room.room}`);
  assert.match(room.socketUrl, new RegExp(`^ws://.+/api/rooms/${room.room}/host$`));
  assert.ok(room.hostToken.length >= 40);

  const page = await fetch(room.viewerUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /viewer\.js/);
});

test("captions fan out from the host to every viewer", async () => {
  const room = await createRoom(relay, "AI 開發者大會");
  const { host, welcome } = await connectHost(room);
  assert.equal(welcome.viewers, 0);
  host.send({ t: "sync", meta: META, state: { status: "live", note: "" }, entries: [{ i: "a1", k: "t", x: "大家好。", f: 1, l: "zh-Hant" }] });
  await sleep(100);

  const { viewer: first, snapshot } = await openViewer(room);
  const { viewer: second } = await openViewer(room);
  assert.equal(snapshot.meta.title, "AI 開發者大會");
  assert.equal(snapshot.state.status, "live");
  assert.equal(snapshot.host, true);
  assert.deepEqual(snapshot.entries, [{ i: "a1", k: "t", x: "大家好。", f: 1, l: "zh-Hant" }]);

  const count = await host.next((message) => message.t === "viewers" && message.n === 2, 5000);
  assert.equal(count.n, 2);

  host.send({ t: "up", e: [{ i: "a2", k: "t", x: "今天" }] });
  host.send({ t: "up", e: [{ i: "a2", a: "要介紹" }] });
  host.send({ t: "up", e: [{ i: "a2", a: "新功能。", f: 1 }] });
  for (const viewer of [first, second]) {
    const one = await viewer.next("up");
    assert.deepEqual(one.e, [{ i: "a2", k: "t", x: "今天" }]);
    await viewer.next("up");
    const three = await viewer.next("up");
    assert.deepEqual(three.e, [{ i: "a2", a: "新功能。", f: 1 }]);
  }

  // A late viewer gets the assembled sentence.
  const { viewer: late, snapshot: lateSnapshot } = await openViewer(room);
  assert.deepEqual(
    lateSnapshot.entries.map((entry) => entry.x),
    ["大家好。", "今天要介紹新功能。"],
  );

  host.send({ t: "state", state: { status: "paused", note: "中場休息 10 分鐘" } });
  const state = await late.next("state");
  assert.deepEqual(state.state, { status: "paused", note: "中場休息 10 分鐘" });

  host.send({ t: "end" });
  for (const viewer of [first, second, late]) {
    await viewer.next("end");
    const closed = await viewer.waitClose();
    assert.equal(closed.code, 4000);
  }
  const { viewer: afterEnd } = await (async () => {
    const viewer = new Client(viewerUrl(relay, room.room));
    await viewer.opened;
    return { viewer };
  })();
  await afterEnd.next("gone");
  assert.equal((await afterEnd.waitClose()).code, 4404);
});

test("viewers cannot publish anything", async () => {
  const room = await createRoom(relay);
  const { host } = await connectHost(room);
  host.send({ t: "sync", meta: META, state: { status: "live", note: "" }, entries: [] });
  const { viewer } = await openViewer(room);
  const { viewer: other } = await openViewer(room);

  viewer.send({ t: "auth", token: room.hostToken });
  viewer.send({ t: "up", e: [{ i: "evil", k: "t", x: "偽造的字幕" }] });
  viewer.send({ t: "state", state: { status: "paused", note: "hacked" } });
  viewer.send({ t: "end" });
  await sleep(500);
  assert.equal(other.messages.filter((message) => message.t === "up" || message.t === "state" || message.t === "end").length, 0);
  assert.equal(viewer.closed, null);

  const { snapshot } = await openViewer(room);
  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.state.status, "live");

  viewer.send("ping");
  assert.equal(await viewer.next((message) => message === "pong"), "pong");
  host.send({ t: "end" });
});

test("a wrong host token is rejected", async () => {
  const room = await createRoom(relay);
  const impostor = new Client(room.socketUrl);
  await impostor.opened;
  impostor.send({ t: "auth", token: "not-the-token" });
  const error = await impostor.next("error");
  assert.equal(error.code, "auth");
  assert.equal((await impostor.waitClose()).code, 4401);

  // Messages before authenticating are not accepted either.
  const early = new Client(room.socketUrl);
  await early.opened;
  early.send({ t: "sync", meta: META, state: { status: "live" }, entries: [] });
  assert.equal((await early.waitClose()).code, 4401);
});

test("a reconnecting host replaces the old connection and resyncs", async () => {
  const room = await createRoom(relay);
  const { host: oldHost } = await connectHost(room);
  oldHost.send({ t: "sync", meta: META, state: { status: "live", note: "" }, entries: [{ i: "b1", k: "t", x: "第一句。", f: 1 }] });
  const { viewer } = await openViewer(room);

  const { host: newHost } = await connectHost(room);
  assert.equal((await oldHost.waitClose()).code, 4409);
  newHost.send({ t: "sync", meta: META, state: { status: "live", note: "" }, entries: [{ i: "b1", k: "t", x: "第一句。", f: 1 }, { i: "b2", k: "t", x: "斷線時說的第二句。", f: 1 }] });
  const sync = await viewer.next("sync");
  assert.deepEqual(
    sync.entries.map((entry) => entry.i),
    ["b1", "b2"],
  );
  newHost.send({ t: "end" });
});

test("viewers are told when the host drops and comes back", async () => {
  const room = await createRoom(relay);
  const { host } = await connectHost(room);
  host.send({ t: "sync", meta: META, state: { status: "live", note: "" }, entries: [] });
  const { viewer } = await openViewer(room);
  host.close();
  const offline = await viewer.next("host");
  assert.equal(offline.online, false);
  const { host: back } = await connectHost(room);
  const online = await viewer.next("host");
  assert.equal(online.online, true);
  back.send({ t: "end" });
});

test("socket routes need a WebSocket upgrade, and /go redirects to a room", async () => {
  const room = await createRoom(relay);
  const plain = await fetch(`${relay.url}/api/rooms/${room.room}/live`);
  assert.equal(plain.status, 426);
  const go = await fetch(`${relay.url}/go?code=${room.room.toUpperCase()}`, { redirect: "manual" });
  assert.equal(go.status, 303);
  assert.equal(new URL(go.headers.get("location")).pathname, `/r/${room.room}`);
  const missing = await fetch(`${relay.url}/r/x`);
  assert.equal(missing.status, 404);
});
