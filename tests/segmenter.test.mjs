import assert from "node:assert/strict";
import { test } from "node:test";
import { PhraseSegmenter } from "../public/js/segmenter.js";
import { TranscriptStore } from "../public/js/transcript.js";

// A store with one translation stream, a fake model and manual timers.
function setup(model) {
  const store = new TranscriptStore();
  const requests = [];
  const timers = new Map();
  let clock = 0;
  let nextTimer = 1;
  const disabled = [];
  const segmenter = new PhraseSegmenter(
    {
      request: (body) => {
        requests.push(body);
        return model(body);
      },
      read: (key) => {
        const entry = store.openStream(key);
        return entry ? { text: entry.text, language: entry.language, cjk: true, context: "" } : null;
      },
      apply: (key, heads) => store.breakStream(key, heads),
      onDisabled: (error) => disabled.push(error),
    },
    {
      now: () => clock,
      setTimeout: (fn, ms) => {
        timers.set(nextTimer, { fn, at: clock + ms });
        return nextTimer++;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  );
  const feed = async (delta, atMs = clock) => {
    store.appendStream("translation", { track: "translation", language: "zh", delta, atMs, cjk: true, assisted: segmenter.active });
    segmenter.update("translation");
    await settle();
  };
  const advance = async (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
    await settle();
  };
  const texts = () => store.track("translation").map((entry) => entry.text);
  return { store, segmenter, requests, feed, advance, texts, disabled };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Splits like the model would: before each connective.
const byMeaning = async ({ text }) => text.split(/(?=所以|再看)/);

test("finished phrases become lines as soon as the model marks them; the last one stays open", async () => {
  const { feed, texts, requests, store } = setup(byMeaning);
  await feed("儘管前期人頭", 0);
  await feed("一直往下掉", 200);
  await feed("所以他的大樹", 400);
  await feed("又快上線了再看", 600);
  await feed("男槍", 800);
  assert.deepEqual(texts(), ["儘管前期人頭一直往下掉", "所以他的大樹又快上線了", "再看男槍"]);
  assert.ok(requests.every((request) => request.language === "zh"));
  assert.equal(store.openStream("translation").text, "再看男槍");
  assert.deepEqual(store.track("translation").map((entry) => [entry.startMs, entry.endMs]).slice(0, 2), [[0, 200], [400, 600]], "lines keep the times their text arrived");
});

test("one request at a time: text that arrives meanwhile is sent when it returns", async () => {
  let release;
  const { feed, requests, advance } = setup(
    (body) =>
      new Promise((resolve) => {
        release = () => resolve([body.text]);
      }),
  );
  await feed("儘管前期人頭一直");
  await feed("往下掉所以");
  await feed("他的大樹");
  assert.equal(requests.length, 1);
  release();
  await advance(0);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].text, "儘管前期人頭一直往下掉所以他的大樹");
});

test("a word or two more waits a moment instead of asking again", async () => {
  const { feed, requests, advance } = setup(async ({ text }) => [text]);
  await feed("儘管前期人頭一直");
  await feed("往");
  assert.equal(requests.length, 1);
  await advance(700);
  assert.equal(requests.length, 2);
});

test("failures fall back to rule-based breaks; a key without access disables it for the run", async () => {
  const failing = setup(async () => {
    throw Object.assign(new Error("timeout"), { status: 504 });
  });
  await failing.feed("儘管前期人頭一直往下掉");
  assert.equal(failing.segmenter.active, false, "retried later");
  await failing.advance(21_000);
  assert.equal(failing.segmenter.active, true);

  const denied = setup(async () => {
    throw Object.assign(new Error("The model does not exist"), { status: 404 });
  });
  await denied.feed("儘管前期人頭一直往下掉");
  await denied.advance(60_000);
  assert.equal(denied.segmenter.active, false);
  assert.equal(denied.disabled.length, 1);
  // Without the model, the store breaks by rule.
  await denied.feed("，所以他的大樹又快上線了", 100);
  assert.deepEqual(denied.texts(), ["儘管前期人頭一直往下掉，", "所以他的大樹又快上線了"]);
});

test("answers about text that was cut since, or after closing, are ignored", async () => {
  let release;
  const { feed, store, segmenter, texts } = setup(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await feed("儘管前期人頭一直往下掉");
  store.sealStream("translation");
  await feed("所以他的大樹又快上線了", 5000);
  release(["儘管前期人頭", "一直往下掉"]);
  await settle();
  assert.deepEqual(texts(), ["儘管前期人頭一直往下掉", "所以他的大樹又快上線了"]);
  segmenter.close();
  release(["所以他的大樹", "又快上線了"]);
  await settle();
  assert.deepEqual(texts(), ["儘管前期人頭一直往下掉", "所以他的大樹又快上線了"]);
});

test("an echoed label or previous line is ignored", async () => {
  const { feed, texts } = setup(async ({ text }) => ["Text:", ...text.split(/(?=所以)/)]);
  await feed("儘管前期人頭一直往下掉所以他的大樹");
  assert.deepEqual(texts(), ["儘管前期人頭一直往下掉", "所以他的大樹"]);
});

test("a model that rewrites the text instead of breaking it is set aside for a while", async () => {
  const { feed, segmenter, advance } = setup(async ({ text }) => [text.replaceAll("头", "頭"), "x"]);
  await feed("前期人头一直往下掉");
  await feed("所以他的大树");
  await feed("又快上线了再看");
  assert.equal(segmenter.active, false);
  await advance(21_000);
  assert.equal(segmenter.active, true);
});

test("the model can't cut a line shorter than 10 characters: 「對，」 stays with what follows", async () => {
  const { feed, texts } = setup(async ({ text }) => text.split(/(?<=，)|(?=所以)/));
  await feed("對，這局裡有很多工具和英雄所以他");
  assert.deepEqual(texts(), ["對，這局裡有很多工具和英雄", "所以他"]);
});
