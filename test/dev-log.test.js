// DEV LOG MIRROR — the ring-buffer mechanics behind AP_DEV_LOGS (see the block at the top of
// background.js). background.js holds the state and patches console; these are the pure parts, so the
// properties that make the mirror trustworthy as a debugging channel are pinned here: a line is never
// unreadable, the buffer is bounded, evictions are COUNTED (a reader must be able to tell "the window
// missed lines" from "nothing happened"), and the cursor can't silently skip.
const { test } = require("node:test");
const assert = require("node:assert");
const { devLogFormat, devLogAppend, devLogSelect } = require("../lib.js");

// ── devLogFormat ────────────────────────────────────────────────────────────────────────────────────
test("devLogFormat: joins args, JSON's objects (never '[object Object]')", () => {
  const s = devLogFormat(["[ApplyPilot][RUN]", "phase", { page: 2, ok: true }]);
  assert.strictEqual(s, '[ApplyPilot][RUN] phase {"page":2,"ok":true}');
});

test("devLogFormat: null/undefined/numbers survive as readable text", () => {
  assert.strictEqual(devLogFormat(["v", null, undefined, 7, false]), "v null undefined 7 false");
});

test("devLogFormat: an Error keeps its stack (the most valuable line in a failed run)", () => {
  const out = devLogFormat(["boom:", new Error("attach failed")]);
  assert.match(out, /boom:/);
  assert.match(out, /attach failed/);
});

test("devLogFormat: a circular object degrades instead of throwing", () => {
  const a = { name: "cyclic" };
  a.self = a;
  assert.doesNotThrow(() => devLogFormat(["x", a]));
});

test("devLogFormat: caps the line and SAYS how much was cut", () => {
  const out = devLogFormat(["y".repeat(5000)], 100);
  assert.strictEqual(out.length, 100 + "…(+4900 chars)".length);
  assert.match(out, /…\(\+4900 chars\)$/);
});

test("devLogFormat: a short line is returned untouched (no marker)", () => {
  assert.strictEqual(devLogFormat(["short"], 100), "short");
});

// ── devLogAppend ────────────────────────────────────────────────────────────────────────────────────
test("devLogAppend: keeps the newest and evicts the oldest at the cap", () => {
  const ring = [];
  for (let i = 1; i <= 5; i++) devLogAppend(ring, { n: i, msg: "m" + i }, 3);
  assert.deepStrictEqual(ring.map((e) => e.n), [3, 4, 5]);
});

test("devLogAppend: reports each eviction so the caller can keep a cumulative dropped count", () => {
  const ring = [];
  let dropped = 0;
  for (let i = 1; i <= 5; i++) dropped += devLogAppend(ring, { n: i }, 3);
  assert.strictEqual(dropped, 2, "5 pushed into a 3-cap ring = 2 evicted");
});

test("devLogAppend: under the cap nothing is dropped", () => {
  const ring = [];
  assert.strictEqual(devLogAppend(ring, { n: 1 }, 10), 0);
  assert.strictEqual(ring.length, 1);
});

// ── devLogSelect ────────────────────────────────────────────────────────────────────────────────────
const RING = [
  { n: 1, msg: "[ApplyPilot][RUN] opened job tab" },
  { n: 2, msg: "[ApplyPilot][CDP-TIME] page 1 settle 900ms" },
  { n: 3, msg: "[ApplyPilot][WALK] nav-timeout" },
  { n: 4, msg: "[ApplyPilot][CDP-TIME] page 2 settle 400ms" },
];

test("devLogSelect: since is exclusive — a cursor replay returns only what's new", () => {
  assert.deepStrictEqual(devLogSelect(RING, { since: 2 }).lines.map((e) => e.n), [3, 4]);
});

test("devLogSelect: since 0 / absent returns everything", () => {
  assert.strictEqual(devLogSelect(RING, {}).lines.length, 4);
  assert.strictEqual(devLogSelect(RING).lines.length, 4);
});

test("devLogSelect: pattern filters case-insensitively", () => {
  assert.deepStrictEqual(devLogSelect(RING, { pattern: "cdp-time" }).lines.map((e) => e.n), [2, 4]);
});

test("devLogSelect: pattern and since compose", () => {
  assert.deepStrictEqual(devLogSelect(RING, { pattern: "CDP-TIME", since: 2 }).lines.map((e) => e.n), [4]);
});

test("devLogSelect: an invalid regex is REPORTED, not thrown (a bad filter must not look like no logs)", () => {
  const out = devLogSelect(RING, { pattern: "([" });
  assert.ok(out.patternError, "expected the regex error to be surfaced");
  assert.strictEqual(out.lines.length, 4, "falls back to unfiltered rather than returning nothing");
});

test("devLogSelect: over-limit keeps the NEWEST lines and flags truncated", () => {
  const out = devLogSelect(RING, { limit: 2 });
  assert.deepStrictEqual(out.lines.map((e) => e.n), [3, 4]);
  assert.strictEqual(out.truncated, true);
  assert.strictEqual(out.matched, 4, "matched reports the true count behind the truncation");
});

test("devLogSelect: exactly-at-limit is not truncated", () => {
  const out = devLogSelect(RING, { limit: 4 });
  assert.strictEqual(out.truncated, false);
});

test("devLogSelect: the last returned n is a safe next cursor — no line is skipped", () => {
  // This is the property the AP_DEV_LOGS reply depends on: advancing the cursor to the last line
  // ACTUALLY returned (not the ring head) means a truncated page is re-read, never jumped over.
  const first = devLogSelect(RING, { limit: 2 });
  const cursor = first.lines[first.lines.length - 1].n;
  const rest = devLogSelect(RING, { since: cursor });
  const seen = [...first.lines, ...rest.lines].map((e) => e.n);
  assert.deepStrictEqual([...new Set(seen)].sort((a, b) => a - b), [3, 4]);
});

test("devLogSelect: an empty/garbage ring is handled", () => {
  assert.deepStrictEqual(devLogSelect([], { since: 5 }).lines, []);
  assert.deepStrictEqual(devLogSelect(null, {}).lines, []);
});
