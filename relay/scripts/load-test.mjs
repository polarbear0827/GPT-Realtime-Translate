#!/usr/bin/env node
// Simulates a full hall: one host publishing captions and many viewers receiving them, then reports how
// many viewers connected and how long captions took to reach them.
//
//   node scripts/load-test.mjs --viewers 1000 --seconds 30
//   node scripts/load-test.mjs --url https://klt-relay.<you>.workers.dev --viewers 2000
//
// Without --url it starts the relay locally with wrangler dev. With --url the publish key comes from
// --key, RELAY_KEY or relay/.publish-key (written by the deploy script).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client, connectHost, createRoom, sleep, startRelay, viewerUrl } from "../test/helpers.mjs";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    key: { type: "string" },
    viewers: { type: "string", default: "1000" },
    seconds: { type: "string", default: "30" },
    rate: { type: "string", default: "4" },
    ramp: { type: "string", default: "10" },
  },
});

const viewerCount = Number(args.viewers);
const seconds = Number(args.seconds);
const rate = Number(args.rate);
const rampSeconds = Number(args.ramp);

if (args.url) {
  process.env.RELAY_URL = args.url;
  process.env.RELAY_KEY =
    args.key ??
    process.env.RELAY_KEY ??
    (() => {
      try {
        return readFileSync(new URL("../.publish-key", import.meta.url), "utf8").trim();
      } catch {
        return "";
      }
    })();
  if (!process.env.RELAY_KEY) {
    console.error("需要發佈金鑰：--key、RELAY_KEY 或 relay/.publish-key");
    process.exit(2);
  }
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);
const ms = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : "—");

const relay = await startRelay();
console.log(`中繼伺服器：${relay.url}`);
const room = await createRoom(relay, "壓力測試");
const { host } = await connectHost(room);
host.send({
  t: "sync",
  meta: { title: "壓力測試", primary: "t", original: false, source: { label: "英文", lang: "en" }, target: { label: "繁體中文", lang: "zh-Hant", cjk: true } },
  state: { status: "live", note: "" },
  entries: [],
});

// ---- connect viewers, spread over the ramp like people scanning the QR code ----
console.log(`連線 ${viewerCount} 位觀眾（${rampSeconds} 秒內陸續加入）…`);
const viewers = [];
const latencies = [];
let failed = 0;
let received = 0;
const connectStart = performance.now();
const joins = [];
for (let index = 0; index < viewerCount; index += 1) {
  joins.push(
    (async () => {
      await sleep((index / viewerCount) * rampSeconds * 1000);
      const viewer = new Client(viewerUrl(relay, room.room));
      viewer.onUpdate = (message) => {
        for (const op of message.e ?? []) {
          const sentAt = Number(op.x?.split("|")[1]);
          if (Number.isFinite(sentAt)) {
            latencies.push(message.__at - sentAt);
            received += 1;
          }
        }
      };
      const original = viewer.ws.onmessage;
      viewer.ws.onmessage = (event) => {
        original(event);
        const last = viewer.messages.at(-1);
        if (last?.t === "up") {
          viewer.messages.pop();
          viewer.onUpdate(last);
        }
      };
      try {
        await viewer.opened;
        viewer.send("ping");
        await viewer.next("snapshot", 30_000);
        viewers.push(viewer);
      } catch {
        failed += 1;
        viewer.close();
      }
    })(),
  );
}
await Promise.all(joins);
const connectSeconds = (performance.now() - connectStart) / 1000;
console.log(`已連線 ${viewers.length} 位，失敗 ${failed} 位（${connectSeconds.toFixed(1)} 秒）`);

const reported = await host.next((message) => message.t === "viewers" && message.n >= viewers.length, 15_000).catch(() => null);
console.log(`講者端收到的人數：${reported?.n ?? "（逾時）"}`);

// ---- publish like a talk: a few updates per second, sentences growing then finishing ----
console.log(`講者端每秒送出 ${rate} 次更新，持續 ${seconds} 秒…`);
let sent = 0;
const total = Math.round(seconds * rate);
for (let index = 0; index < total; index += 1) {
  const id = `L${Math.floor(index / 4)}`;
  const text = `第 ${index} 次更新|${performance.now()}`;
  host.send({ t: "up", e: [{ i: id, k: "t", x: text, ...(index % 4 === 3 ? { f: 1 } : {}) }] });
  sent += 1;
  await sleep(1000 / rate);
}
await sleep(3000);

const expected = sent * viewers.length;
const sorted = latencies.sort((a, b) => a - b);
console.log("\n結果");
console.log(`  觀眾：${viewers.length}/${viewerCount} 連線成功`);
console.log(`  送達：${received}/${expected}（${expected ? ((received / expected) * 100).toFixed(2) : 0}%）`);
console.log(`  延遲：p50 ${ms(percentile(sorted, 50))}・p95 ${ms(percentile(sorted, 95))}・p99 ${ms(percentile(sorted, 99))}・最慢 ${ms(sorted.at(-1))}`);

host.send({ t: "end" });
await sleep(1000);
for (const viewer of viewers) viewer.close();
host.close();
await relay.stop();
process.exit(received === expected && failed === 0 ? 0 : 1);
