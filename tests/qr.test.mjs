// Structure checks for the QR encoder. tests/macos/main.swift decodes real codes with Apple's Vision.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encodeQr, qrPath } from "../public/js/qr.js";

const URL_TEXT = "https://klt-relay.example.workers.dev/r/abcdefghjkmn";

function finderAt(qr, x0, y0) {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (qr.get(x0 + dx, y0 + dy) !== (ring !== 2)) return false;
    }
  }
  return true;
}

// Reads the 15 format bits around the top-left finder and checks them against all 32 valid words.
function formatInfo(qr) {
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) bits |= (qr.get(8, i) ? 1 : 0) << i;
  bits |= (qr.get(8, 7) ? 1 : 0) << 6;
  bits |= (qr.get(8, 8) ? 1 : 0) << 7;
  bits |= (qr.get(7, 8) ? 1 : 0) << 8;
  for (let i = 9; i < 15; i += 1) bits |= (qr.get(14 - i, 8) ? 1 : 0) << i;
  for (let level = 0; level < 4; level += 1) {
    for (let mask = 0; mask < 8; mask += 1) {
      const data = ([1, 0, 3, 2][level] << 3) | mask;
      let remainder = data;
      for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
      if ((((data << 10) | remainder) ^ 0x5412) === bits) return { level: "LMQH"[level], mask };
    }
  }
  return null;
}

test("a share link fits a small, easy-to-scan code", () => {
  const qr = encodeQr(URL_TEXT, { ecc: "M" });
  assert.equal(qr.version, 4);
  assert.equal(qr.size, 33);
  assert.ok(finderAt(qr, 0, 0) && finderAt(qr, qr.size - 7, 0) && finderAt(qr, 0, qr.size - 7));
  assert.deepEqual(formatInfo(qr), { level: "M", mask: qr.mask });
  assert.ok(qr.get(8, qr.size - 8), "dark module");
  for (let i = 8; i < qr.size - 8; i += 1) assert.equal(qr.get(i, 6), i % 2 === 0, "timing pattern");
});

test("versions grow with the text and every level is encodable", () => {
  assert.equal(encodeQr("a", { ecc: "L" }).version, 1);
  assert.equal(encodeQr("a".repeat(17), { ecc: "L" }).version, 1);
  assert.equal(encodeQr("a".repeat(18), { ecc: "L" }).version, 2);
  assert.equal(encodeQr("a".repeat(14), { ecc: "M" }).version, 1);
  assert.equal(encodeQr("a".repeat(15), { ecc: "M" }).version, 2);
  for (const ecc of ["L", "M", "Q", "H"]) assert.equal(formatInfo(encodeQr(URL_TEXT, { ecc })).level, ecc);
  assert.equal(encodeQr("x".repeat(2953), { ecc: "L" }).version, 40);
  assert.throws(() => encodeQr("x".repeat(2954), { ecc: "L" }), RangeError);
  assert.equal(encodeQr("中文".repeat(10)).version, 4, "60 UTF-8 bytes need version 4 at level M");
});

test("output is deterministic (a decoded-and-verified golden code)", () => {
  // Decoded with Vision when this test was written; a change here means the encoder changed.
  const qr = encodeQr(URL_TEXT, { ecc: "M" });
  const digest = createHash("sha256").update(qr.modules).digest("hex").slice(0, 16);
  assert.equal(digest, GOLDEN);
});

test("forced masks only change the masked area", () => {
  const a = encodeQr(URL_TEXT, { ecc: "M", mask: 0 });
  const b = encodeQr(URL_TEXT, { ecc: "M", mask: 5 });
  assert.equal(a.mask, 0);
  assert.equal(b.mask, 5);
  assert.ok(finderAt(a, 0, 0) && finderAt(b, 0, 0));
  assert.notDeepEqual(a.modules, b.modules);
});

test("the SVG path merges runs of dark modules", () => {
  const qr = encodeQr("hi", { ecc: "L" });
  const path = qrPath(qr, 4);
  assert.match(path, /^M4 4h7v1h-7z/, "the finder's top edge is one run");
  const area = [...path.matchAll(/h(\d+)v1/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(area, qr.modules.reduce((sum, value) => sum + value, 0));
});

const GOLDEN = "60b312e38c377fd1";
