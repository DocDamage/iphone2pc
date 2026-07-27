import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const legacyExpand = require("brace-expansion");
const modernExpansion = await import("brace-expansion");

assert.equal(typeof legacyExpand, "function");
assert.deepEqual(legacyExpand("build/{win,mac}"), ["build/win", "build/mac"]);
assert.equal(typeof modernExpansion.expand, "function");
assert.deepEqual(modernExpansion.expand("release/{1..3}"), [
  "release/1",
  "release/2",
  "release/3"
]);

const asarRequire = createRequire(require.resolve("@electron/asar/package.json"));
const legacyMinimatch = asarRequire("minimatch");
assert.equal(typeof legacyMinimatch, "function");
assert.equal(legacyMinimatch("PocketDock.exe", "*.exe"), true);

const adversarialPattern = "{a,b}".repeat(1_500);
const bounded = modernExpansion.expand(adversarialPattern, {
  max: 1_000,
  maxLength: 10_000
});
const expandedCharacters = bounded.reduce((total, value) => total + value.length, 0);
assert.ok(bounded.length > 0);
assert.ok(expandedCharacters <= 10_000);

process.stdout.write(
  `Patched brace expansion verified across legacy and modern consumers (${expandedCharacters} bounded characters).\n`
);
