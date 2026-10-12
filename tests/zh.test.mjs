import assert from "node:assert/strict";
import { test } from "node:test";
import { displayText, fallbackConvert, setZhConverter, toTraditional } from "../public/js/zh.js";

await import("../public/vendor/opencc-cn2t.js");
setZhConverter(globalThis.OpenCC.Converter({ from: "cn", to: "twp" }));

test("context-dependent characters stay correct (v0.3 turned 公里 into 公裡)", () => {
  assert.equal(toTraditional("全程马拉松是42公里"), "全程馬拉松是42公里");
  assert.equal(toTraditional("皇后和王后都来了"), "皇后和王后都來了");
  assert.equal(toTraditional("我们周末去划船"), "我們週末去划船");
  assert.equal(toTraditional("人云亦云"), "人云亦云");
  assert.equal(toTraditional("楼梯的栏杆"), "樓梯的欄杆");
});

test("phrases split across streaming deltas convert correctly when converted as a passage", () => {
  const deltas = ["头", "发", "和", "软", "件", "的", "数", "据"];
  assert.equal(toTraditional(deltas.join("")), "頭髮和軟體的資料");
});

test("only Chinese text is converted", () => {
  assert.equal(displayText("软件", "zh"), "軟體");
  assert.equal(displayText("软件", "ja"), "软件");
});

test("fallback map avoids ambiguous characters", () => {
  assert.equal(fallbackConvert("公里和皇后"), "公里和皇后");
  assert.equal(fallbackConvert("我们的软件"), "我們的軟體");
  assert.equal(fallbackConvert("头发"), "頭髮");
});
