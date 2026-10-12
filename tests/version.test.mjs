import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("VERSION is the single source of truth", () => {
  const version = read("VERSION").trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read("package.json")).version, version, "package.json version");
  assert.match(read("CHANGELOG.md"), new RegExp(`## v${version.replaceAll(".", "\\.")}\\b`), "CHANGELOG entry");
  // The macOS build reads VERSION at build time instead of hard-coding it.
  assert.match(read("src/macos/Info.plist"), /__VERSION__/);
});
