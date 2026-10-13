import assert from "node:assert/strict";
import { test } from "node:test";
import { alignBreaks, clauseBreak, headsAt, ruleBreak } from "../public/js/phrases.js";

const text = "有經濟差儘管前期人頭一直往下掉所以他的大樹又快上線了再看男槍";

test("the model's lines are mapped back onto the original text", () => {
  const breaks = alignBreaks(text, ["有經濟差", "儘管前期人頭一直往下掉", "所以他的大樹又快上線了", "再看男槍"]);
  assert.deepEqual(headsAt(text, breaks), ["有經濟差", "儘管前期人頭一直往下掉", "所以他的大樹又快上線了"]);
  assert.deepEqual(alignBreaks(text, [text]), [], "one line: nothing to cut");
});

test("whitespace and punctuation the model added or dropped don't matter; changed words do", () => {
  const english = "if he starts to come online this could get very difficult";
  assert.deepEqual(headsAt(english, alignBreaks(english, ["If he starts to come online,", "this could get"])), ["if he starts to come online"]);
  const chinese = "這局裡有很多工具,能直接秒掉Quad,這就是";
  assert.deepEqual(headsAt(chinese, alignBreaks(chinese, ["這局裡有很多工具", "能直接秒掉Quad，", "這就是"])), ["這局裡有很多工具,", "能直接秒掉Quad,"]);
  assert.equal(alignBreaks(text, ["有經濟差", "儘管前期人頭一直往上漲"]), null);
  assert.equal(alignBreaks(text, "not lines"), null);
});

test("without the model, a clause mark ends a phrase once it has a few words", () => {
  assert.equal(clauseBreak("這局裡有很多工具,能直接", 6), 9);
  assert.equal(clauseBreak("對，這就是", 6), -1, "too short");
  assert.equal(clauseBreak("成長到3,000人", 2), -1, "a number, not a clause");
  assert.equal(clauseBreak("這局裡有很多工具，", 6), -1, "not confirmed until more text arrives");
  assert.equal(clauseBreak("Probably the right call there, Geckos was", 16), 31);
});

test("long phrases are cut where the meaning breaks, never inside a word", () => {
  const lines = [];
  let rest = `${text}和阿卡麗都能衝進後排咱們已經知道男槍找到人會怎麼打Karsa`;
  while (rest.length > 24) {
    const cut = ruleBreak(rest, { language: "zh" });
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  lines.push(rest);
  assert.deepEqual(lines, ["有經濟差", "儘管前期人頭一直往下掉", "所以他的大樹又快上線了", "再看男槍和阿卡麗都能衝進後排", "咱們已經知道男槍找到人會怎麼打Karsa"]);
  assert.equal(ruleBreak("他們決定不要往前衝卡爾則代表他們", { language: "zh" }) > 0, true);
  const english = "They do make the call not to dash forward on the parts as we happen and the team is ready";
  assert.equal(english.slice(ruleBreak(english, { language: "en", minChars: 12 })), "and the team is ready");
  assert.ok(!/\bthe$/.test(english.slice(0, ruleBreak("They do make the call to dash forward on the parts", { language: "en", minChars: 12 })).trim()));
});
