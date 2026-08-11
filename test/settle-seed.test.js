"use strict";
// awaitFieldSetSettled's SEED — counting stability the page-transition wait already observed.
//
// The point of the change is speed, but the point of THESE tests is safety. Operator's framing, and the
// standard they set: "1.2 seconds is not bad in the scope of things, much better than a run failing
// because it didn't settle." So every test here asks the same question — can the seed ever let the walk
// start filling a page whose field set is still mounting? The answer must be no, for these reasons:
//
//   • the BAR is unchanged (still NO_GROWTH_MS of an unchanged count),
//   • a first scan that DISAGREES with the seed resets the window in full,
//   • the credit is capped so at least two of this loop's own 150ms polls always land,
//   • the credit can never exceed real observed time (no crediting the future).
//
// background.js can't be require()d (it expects chrome.* at load), so the function is extracted from
// source — the idiom from test/classify-source.test.js and test/pacing-clock.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const start = src.indexOf("async function awaitFieldSetSettled(act, seed) {");
assert.ok(start > 0, "awaitFieldSetSettled(act, seed) not found — renamed, or the seed param dropped?");
let i = src.indexOf("{", start), depth = 0, end = -1;
for (let k = i; k < src.length; k++) {
  if (src[k] === "{") depth++;
  else if (src[k] === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
}
assert.ok(end > 0, "could not balance awaitFieldSetSettled's body");
const BODY = src.slice(start, end);

// Build it with a controllable page scan. `counts` is the sequence of field counts successive scans see.
function build(counts) {
  const scans = [];
  const cdpEval = async () => {
    const n = counts.length > 1 ? counts.shift() : counts[0];
    scans.push({ n, at: Date.now() });
    return { fields: new Array(n).fill({}) };
  };
  const factory = new Function("deps", `
    const cdpEval = deps.cdpEval;
    const cdpPageScan = function () {};
    ${BODY}
    return awaitFieldSetSettled;`);
  const fn = factory({ cdpEval });
  const act = { delayFull: (ms) => new Promise((r) => setTimeout(r, ms)) };
  return { fn, act, scans };
}

const NO_GROWTH_MS = 1200;

test("NO seed ⇒ unchanged behaviour: a stable count still costs the full ~1.2s window", async () => {
  const { fn, act } = build([7]);
  const took = await fn(act, undefined);
  assert.ok(took >= NO_GROWTH_MS - 60, `must still prove 1.2s of stability; took ${took}ms`);
});

test("a seed that agrees with the page CREDITS the already-observed time (the whole point)", async () => {
  const { fn, act } = build([7]);
  // The transition wait watched count 7 unchanged starting 900ms ago.
  const took = await fn(act, { count: 7, since: Date.now() - 900 });
  assert.ok(took < NO_GROWTH_MS - 200, `should not re-prove from zero; took ${took}ms`);
  assert.ok(took > 0, "still polls at least once itself");
});

test("SAFETY: a seed that DISAGREES with the live page gets the FULL window, not a shortcut", async () => {
  // The page grew between the transition and the settle — exactly the case the settle exists for.
  const { fn, act } = build([11]);
  const took = await fn(act, { count: 7, since: Date.now() - 5000 });   // stale, over-generous seed
  assert.ok(took >= NO_GROWTH_MS - 60,
    `a mismatched seed must reset the window in full; took ${took}ms`);
});

test("SAFETY: a page still MOUNTING is never short-circuited by a seed", async () => {
  // Counts keep growing for several polls, then stabilise — the seed must not let us fill mid-growth.
  const { fn, act, scans } = build([7, 9, 12, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14]);
  const took = await fn(act, { count: 7, since: Date.now() - 1100 });
  const lastChange = scans.filter((s) => s.n !== 14).slice(-1)[0];
  const settledAt = Date.now();
  assert.ok(settledAt - lastChange.at >= NO_GROWTH_MS - 60,
    "must have watched the FINAL count unchanged for the full window");
  assert.ok(took >= NO_GROWTH_MS, `took ${took}ms`);
});

test("SAFETY: the credit is CAPPED — at least two of this loop's own polls must land", async () => {
  const { fn, act, scans } = build([7]);
  // A seed claiming the count has been stable for an hour must NOT skip the wait entirely.
  const took = await fn(act, { count: 7, since: Date.now() - 3600_000 });
  assert.ok(scans.length >= 2, `at least two of our own scans must confirm; saw ${scans.length}`);
  assert.ok(took >= 2 * 150 - 60, `capped credit still leaves ~2 polls; took ${took}ms`);
});

test("SAFETY: a seed cannot credit the FUTURE (a clock-skewed `since` is clamped to zero)", async () => {
  const { fn, act } = build([7]);
  const took = await fn(act, { count: 7, since: Date.now() + 60_000 });
  assert.ok(took >= NO_GROWTH_MS - 60, `a future timestamp must credit nothing; took ${took}ms`);
  // Unclamped, a future `since` pushes lastChangeAt forward and the loop cannot break until the
  // 12s CEILING — turning a bogus seed into a 12-second stall on every page. Clamping to 0 is what
  // keeps a nonsense seed merely USELESS instead of harmful.
  assert.ok(took < 3000, `a bogus seed must not stall to the ceiling; took ${took}ms`);
});

test("a malformed seed is ignored rather than trusted", async () => {
  for (const bad of [null, {}, { count: 0, since: Date.now() - 900 }, { count: 7, since: 0 }]) {
    const { fn, act } = build([7]);
    const took = await fn(act, bad);
    assert.ok(took >= NO_GROWTH_MS - 60, `bad seed ${JSON.stringify(bad)} must not shorten; took ${took}ms`);
  }
});

test("a page with NO flat fields still bails on all-zero reads (seed must not defeat the zero-bail)", async () => {
  const { fn, act } = build([0]);
  const took = await fn(act, { count: 7, since: Date.now() - 1100 });
  assert.ok(took < 2000, `zero-field page should bail ~1s, not hang; took ${took}ms`);
});
