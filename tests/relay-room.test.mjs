// The relay's room logic (relay/src/room-state.js) without Cloudflare: what hosts may change and what
// viewers receive. relay/test covers the Worker itself in wrangler dev.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, RoomState, applyOp, cleanMeta, cleanOp } from "../relay/src/room-state.js";

const META = { title: "大會", primary: "t", original: true, source: { label: "英文", lang: "en" }, target: { label: "繁體中文", lang: "zh-Hant", cjk: true } };

function synced() {
  const room = new RoomState();
  room.applyHost({ t: "sync", meta: META, state: { status: "live", note: "" }, entries: [] });
  return room;
}

test("updates before the first sync ask the host for its state", () => {
  const room = new RoomState();
  const result = room.applyHost({ t: "up", e: [{ i: "a", k: "t", x: "你好" }] });
  assert.deepEqual(result.reply, { t: "resync" });
  assert.equal(result.broadcast, null);
  assert.equal(room.entries.size, 0);
});

test("sync replaces the entries and is broadcast", () => {
  const room = new RoomState();
  const result = room.applyHost({
    t: "sync",
    meta: META,
    state: { status: "paused", note: "休息" },
    entries: [{ i: "a", k: "t", x: "一", f: 1 }, { i: "b", k: "s", x: "two" }, { bogus: true }, { i: "c", a: "orphan" }],
  });
  assert.equal(room.synced, true);
  assert.equal(result.persist, true);
  assert.deepEqual(result.broadcast.entries, [{ i: "a", k: "t", x: "一", f: 1 }, { i: "b", k: "s", x: "two" }]);
  assert.deepEqual(result.broadcast.state, { status: "paused", note: "休息" });
  const snapshot = JSON.parse(room.snapshotText(true));
  assert.equal(snapshot.t, "snapshot");
  assert.equal(snapshot.host, true);
  assert.equal(snapshot.entries.length, 2);
});

test("operations append, finish and delete; unknown entries trigger a resync", () => {
  const room = synced();
  room.applyHost({ t: "up", e: [{ i: "a", k: "t", x: "今天" }] });
  room.applyHost({ t: "up", e: [{ i: "a", a: "天氣很好", f: 1 }] });
  assert.deepEqual(room.entries.get("a"), { i: "a", k: "t", x: "今天天氣很好", f: 1 });
  const missing = room.applyHost({ t: "up", e: [{ i: "zz", a: "沒看過" }, { i: "b", k: "t", x: "新的" }] });
  assert.deepEqual(missing.reply, { t: "resync" });
  assert.deepEqual(missing.broadcast.e, [{ i: "b", k: "t", x: "新的" }]);
  room.applyHost({ t: "up", e: [{ i: "a", d: 1 }] });
  assert.deepEqual([...room.entries.keys()], ["b"]);
});

test("the snapshot cache follows changes", () => {
  const room = synced();
  const before = room.snapshotText(true);
  assert.equal(room.snapshotText(true), before);
  room.applyHost({ t: "up", e: [{ i: "a", k: "t", x: "新" }] });
  assert.notEqual(room.snapshotText(true), before);
  assert.match(room.snapshotText(false), /"host":false/);
});

test("only recent entries are kept", () => {
  const room = synced();
  const ops = Array.from({ length: LIMITS.entries + 50 }, (_, index) => ({ i: `e${index}`, k: "t", x: `${index}` }));
  room.applyHost({ t: "up", e: ops.slice(0, 200) });
  room.applyHost({ t: "up", e: ops.slice(200) });
  assert.equal(room.entries.size, LIMITS.entries);
  assert.equal(room.entries.keys().next().value, "e50");
});

test("host input is sanitized", () => {
  const meta = cleanMeta({ title: `  ${"題".repeat(200)}\u0007 `, primary: "x", source: { label: 3, lang: "<script>" }, target: null });
  assert.equal(meta.title.length, LIMITS.titleChars);
  assert.equal(meta.primary, "t");
  assert.equal(meta.source.lang, "und");
  assert.equal(meta.source.label, "");
  const room = synced();
  const state = room.applyHost({ t: "state", state: { status: "hacked", note: "x".repeat(1000) } });
  assert.equal(state.broadcast.state.status, "idle");
  assert.equal(state.broadcast.state.note.length, LIMITS.noteChars);
  assert.equal(cleanOp({ i: "x".repeat(LIMITS.idChars + 1), k: "t", x: "a" }), null);
  assert.equal(cleanOp({ i: "a", k: "t" }), null);
  assert.equal(cleanOp({ i: "a", k: "t", x: "y".repeat(5000) }).x.length, LIMITS.entryChars);
  assert.equal(cleanOp({ i: "a", k: "t", x: "y", l: "zh-Hant" }).l, "zh-Hant");
  assert.equal(cleanOp({ i: "a", k: "t", x: "y", l: "zh_Hant!" }).l, undefined);
  assert.equal(room.applyHost({ t: "nope" }).broadcast, null);
});

test("applyOp refuses to create entries from fragments", () => {
  const entries = new Map();
  assert.equal(applyOp(entries, { i: "a", a: "x" }), false);
  assert.equal(applyOp(entries, { i: "a", f: 1 }), false);
  assert.equal(applyOp(entries, { i: "a", x: "x" }), false, "needs a track");
  assert.equal(applyOp(entries, { i: "a", k: "t", x: "x" }), true);
});
