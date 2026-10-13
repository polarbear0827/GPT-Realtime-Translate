import assert from "node:assert/strict";
import { test } from "node:test";
import { captionText, chunkText, formatClock, formatSrtTime, fullwidthPunctuation, joinText, lastSentenceBoundary, splitSentences, tailText, wrapLines } from "../public/js/text.js";

test("sentence boundary is only confirmed once more text follows", () => {
  assert.equal(lastSentenceBoundary("It costs 3."), -1);
  assert.equal(lastSentenceBoundary("It costs 3.14 dollars"), -1);
  assert.equal(lastSentenceBoundary("Hello. World"), 6);
  assert.equal(lastSentenceBoundary("你好。今天"), 3);
  assert.equal(lastSentenceBoundary("你好。"), -1);
});

test("splitSentences keeps punctuation and decimals", () => {
  assert.deepEqual(splitSentences("Pi is 3.14. Next one! 好的。"), ["Pi is 3.14.", "Next one!", "好的。"]);
});

test("wrapLines never starts a CJK line with closing punctuation", () => {
  const lines = wrapLines("今天我們要釋出一個全新的實時翻譯功能。", 18, true);
  assert.deepEqual(lines, ["今天我們要釋出一個全新的實時翻譯功能。"]);
  assert.ok(lines.every((line) => !/^[，。、！？]/.test(line)));
  assert.deepEqual(wrapLines("one two three four", 9, false), ["one two", "three", "four"]);
});

test("chunkText splits into balanced pieces at sentence boundaries", () => {
  const chunks = chunkText("First sentence here. Second sentence here. Third one.", 2, false);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(" "), "First sentence here. Second sentence here. Third one.");
  assert.deepEqual(chunkText("", 3, false), [""]);
});

test("joinText uses spaces only for space-separated languages", () => {
  assert.equal(joinText(["你好。", "再見。"], true), "你好。再見。");
  assert.equal(joinText(["Hello.", "Bye."], false), "Hello. Bye.");
});

test("tailText cuts at a word boundary for Latin text", () => {
  assert.equal(tailText("alpha beta gamma delta", 12, false), "gamma delta");
  assert.equal(tailText("一二三四五", 3, true), "三四五");
});

test("time formatting", () => {
  assert.equal(formatClock(65_000), "01:05");
  assert.equal(formatClock(3_725_000), "1:02:05");
  assert.equal(formatSrtTime(3_725_123), "01:02:05,123");
});

test("half-width punctuation next to Chinese becomes full-width; numbers and English are left alone", () => {
  assert.equal(fullwidthPunctuation("這局裡有很多工具,能直接秒掉Quad, 這就是其中之一?"), "這局裡有很多工具，能直接秒掉Quad，這就是其中之一？");
  assert.equal(fullwidthPunctuation("成長到3,000人,時間是3:00"), "成長到3,000人，時間是3:00");
  assert.equal(fullwidthPunctuation("Hello, world! It's 3:00."), "Hello, world! It's 3:00.");
  assert.equal(captionText("這就是其中之一，"), "這就是其中之一");
  assert.equal(captionText("真的嗎？"), "真的嗎？");
  assert.equal(captionText("If he comes online,"), "If he comes online,");
});
