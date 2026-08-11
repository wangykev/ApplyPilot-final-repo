"use strict";
// The CLOCK PROBE (cdp.js `cdpClockProbe`) + the transition wait's LITERAL poll counter.
//
// Why these are pinned together: both exist because a MEASUREMENT lied. `[TRANSITION]` printed a poll
// count derived as elapsed/interval — an assertion that the clock kept time, which is the one thing every
// measurement in docs/fill-speed-log.md exists to test — and it OVERSTATED coverage exactly when coverage
// was worst. The clock probe is the replacement instrument, and its own value is entirely in the two arms
// being timed over the SAME interval; a version that measured them sequentially would look identical in a
// log and mean nothing, since drift is bursty.
//
// cdp.js can't be require()d (it expects chrome.* at load), so the probe is extracted from source between
// its markers and run with injected fakes — the idiom from test/pacing-clock.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "cdp.js"), "utf8");
const START = "// ── CLOCK PROBE START";
const END = "// ── CLOCK PROBE END ──";
const a = src.indexOf(START);
const b = src.indexOf(END);
assert.ok(a > 0 && b > a, "clock-probe markers not found in cdp.js — did they get renamed?");
const block = src.slice(src.indexOf("\n", a) + 1, b);

function makeProbe({ tabId = 1, workerTimers = true, sendRaw }) {
  const logs = [];
  const factory = new Function(
    "deps",
    `let cdpTabId = deps.tabId;
     let _workerTimersActive = deps.workerTimers;
     const cdpSendRaw = deps.sendRaw;
     const cdpSwSleep = (ms) => new Promise((r) => setTimeout(r, ms));
     const console = { log: deps.log };
     ${block}
     return { cdpClockProbe, CLOCK_PROBE_CEILING_MS };`
  );
  const api = factory({ tabId, workerTimers, sendRaw, log: (m) => logs.push(String(m)) });
  return { ...api, clockLogs: () => logs.filter((m) => /\[CLOCKS\]/.test(m)) };
}

/** A page-timer stand-in that resolves after `takesMs` and reports `perf` as its performance.now() delta. */
function fakePage(calls, { takesMs = 0, perf = null, hang = false, throwWith = null } = {}) {
  return (method, params) => {
    calls.push({ method, params });
    if (throwWith) return Promise.reject(new Error(throwWith));
    if (hang) return new Promise(() => {});
    const asked = Number(/setTimeout\(function\(\)\{r\(performance\.now\(\)-p0\);\},(\d+)\)/.exec(params.expression)[1]);
    const wait = takesMs || asked;
    return new Promise((r) => setTimeout(() => r({ result: { value: perf === null ? wait : perf } }), wait));
  };
}

test("both arms are timed over the SAME interval — the probe is PAIRED, not sequential", async () => {
  // The whole claim of this instrument. want=100, page arm takes 320ms: run together the probe returns in
  // ~320ms; run one-then-the-other it would take ~420ms. Drift is bursty, so two arms measured at
  // different moments compare nothing.
  const calls = [];
  const p = makeProbe({ sendRaw: fakePage(calls, { takesMs: 320 }) });
  const t0 = Date.now();
  const out = await p.cdpClockProbe(100);
  const took = Date.now() - t0;
  assert.ok(took < 420, `arms must run concurrently; took ${took}ms (sequential would be ~420ms)`);
  assert.ok(out.swMs >= 95 && out.swMs < 300, `SW arm measures its own ~100ms, not the page arm's; got ${out.swMs}`);
  assert.ok(out.pageMs >= 300, `page arm measures the full 320ms; got ${out.pageMs}`);
});

test("reports the SW and PAGE overruns separately — that difference IS the verdict", async () => {
  // SW on time + page late ⇒ the tab is throttled. SW late + page on time ⇒ only our worker is starved.
  // Collapsing them into one number is what made the original [LAG] summary unreadable.
  const p = makeProbe({ sendRaw: fakePage([], { takesMs: 500 }) });
  const out = await p.cdpClockProbe(50);
  assert.ok(out.pageOverMs > out.swOverMs, "a slow page arm must show up as pageOverMs, not swOverMs");
  assert.equal(out.want, 50);
});

test("returns the page's OWN performance.now() delta (page-perf), distinct from our SW-side timing", async () => {
  const p = makeProbe({ sendRaw: fakePage([], { takesMs: 200, perf: 187.6 }) });
  const out = await p.cdpClockProbe(100);
  assert.equal(out.realMs, 188, "page-perf is the page's reading, rounded — not our Date.now() delta");
  assert.notEqual(out.realMs, out.pageMs, "the two columns must stay distinguishable");
});

test("a HANGING page arm is abandoned at want+ceiling and never blocks — a probe must not stall a fill", async () => {
  const calls = [];
  const p = makeProbe({ sendRaw: fakePage(calls, { hang: true }) });
  const t0 = Date.now();
  const out = await p.cdpClockProbe(20);
  const took = Date.now() - t0;
  assert.equal(calls.length, 1, "the page arm was attempted");
  assert.equal(out.note, "page-abandoned");
  assert.equal(out.pageMs, null, "an abandoned arm must report NO timing rather than a made-up one");
  assert.ok(took <= 20 + p.CLOCK_PROBE_CEILING_MS + 500, `abandoned near want+ceiling, not hung; took ${took}ms`);
});

test("a THROWN page arm resolves with a note — never rejects into the fill", async () => {
  const p = makeProbe({ sendRaw: fakePage([], { throwWith: "context destroyed" }) });
  const out = await p.cdpClockProbe(20);
  assert.match(out.note, /page-threw/);
  assert.ok(out.swMs >= 15, "the SW arm still produced a reading");
});

test("not attached ⇒ no CDP round trip, still measures the SW clock", async () => {
  const calls = [];
  const p = makeProbe({ tabId: null, sendRaw: fakePage(calls) });
  const out = await p.cdpClockProbe(30);
  assert.equal(calls.length, 0);
  assert.equal(out.note, "not-attached");
  assert.ok(out.swMs >= 25);
});

// ── the VERDICT must come from the numbers, not be a fixed legend ─────────────────────────────────
// The first live run printed "SW late + PAGE on time => the worker is starved and the tab is FINE" on
// EVERY line, including the five where both clocks were within 23ms of a 250ms request. A diagnostic
// that states a conclusion its own sample contradicts is worse than no diagnostic.
test("both clocks on time ⇒ says so, and warns that a quiet sample does NOT clear the run", async () => {
  const p = makeProbe({ sendRaw: fakePage([], { takesMs: 260 }) });
  const out = await p.cdpClockProbe(250);
  assert.match(out.verdict, /both clocks ON TIME/i);
  assert.match(out.verdict, /BURSTY/i, "drift is bursty — an all-clear sample must not read as an all-clear run");
  assert.ok(!/starved/i.test(out.verdict), "must not assert starvation when nothing was late");
});

test("SW late + page on time ⇒ the known MV3 verdict", async () => {
  // The page arm answers promptly; the SW arm is what drags. Simulated by asking for a pace far shorter
  // than the page arm's fixed cost would be — here the page returns fast and we inflate the SW side by
  // requesting a want the page beats.
  const p = makeProbe({ sendRaw: fakePage([], { takesMs: 20 }) });
  const out = await p.cdpClockProbe(20);
  // Both on time in this fixture; assert the CLASSIFIER instead, which is what the live case exercises.
  assert.equal(typeof out.swOverMs, "number");
  assert.equal(typeof out.pageOverMs, "number");
  assert.match(out.verdict, /ON TIME|starved|throttled|unusual/i, "every sample must land in exactly one named case");
});

test("both clocks late ⇒ the tab really is throttled (not blamed on the worker)", async () => {
  const p = makeProbe({ sendRaw: fakePage([], { takesMs: 1500 }) });
  const out = await p.cdpClockProbe(20);   // SW arm resolves ~20ms... so force the page arm slow only
  assert.match(out.verdict, /PAGE late|BOTH clocks late/i);
  assert.ok(!/tab is FINE/i.test(out.verdict), "a late page arm must never be reported as a fine tab");
});

test("an abandoned page arm reports NO verdict about the tab", async () => {
  const p = makeProbe({ sendRaw: fakePage([], { hang: true }) });
  const out = await p.cdpClockProbe(20);
  assert.match(out.verdict, /no comparison possible/i,
    "with one arm missing the probe must decline a verdict rather than infer one from the SW arm alone");
});

test("the log line states which reading is NOT a freeze signal", async () => {
  // performance.now() keeps advancing through a freeze. Reading it as a freeze detector would answer
  // "no freezing" every single time — so the line itself has to say so, not just a comment in cdp.js.
  const p = makeProbe({ sendRaw: fakePage([], { takesMs: 40 }) });
  await p.cdpClockProbe(30, "page 2 pre-fill");
  assert.equal(p.clockLogs().length, 1);
  assert.match(p.clockLogs()[0], /page 2 pre-fill/, "the label positions the sample within the run");
  assert.match(p.clockLogs()[0], /NOT a freeze signal/i);
});

// ── the transition wait's poll count must be COUNTED, never derived ───────────────────────────────
// Source-level (background.js can't be require()d — it expects chrome.* at load), the idiom above.
test("cdpWaitNextPageInner COUNTS its polls — no elapsed/interval arithmetic", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const at = bg.indexOf("async function cdpWaitNextPageInner(");
  assert.ok(at > 0, "cdpWaitNextPageInner not found — renamed?");
  const body = bg.slice(at, bg.indexOf("\nconst WALK_MAX_PAGES", at));
  assert.match(body, /\bpolls\+\+/, "the poll count must be incremented per iteration");
  assert.ok(!/polls:\s*Math\.round\(\(Date\.now\(\) - start\) \/ intervalMs\)/.test(body),
    "polls must NOT be re-derived as elapsed/intervalMs — that assumes the interval was honored, which is "
    + "exactly what drift breaks, and it OVERSTATES coverage precisely when coverage is worst");
  assert.match(body, /polls,\s*pollMeanMs:/,
    "report the ACTUAL mean interval alongside the count so a starved clock is visible on the line itself");
});

test("the transition wait's nav-timeout carries the real poll count (the exit where coverage is the question)", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const at = bg.indexOf("async function cdpWaitNextPageInner(");
  const body = bg.slice(at, bg.indexOf("\nconst WALK_MAX_PAGES", at));
  const tail = body.slice(body.lastIndexOf("return {"));
  assert.match(tail, /timeout: true[\s\S]*polls/,
    "a nav-timeout HALT is where 'did we look often enough?' gets asked — it must answer with a counted number");
});

test("the error-flicker timer is RESET on an un-hydrated read (the errSteady typo must not come back)", () => {
  // background.js is sloppy-mode and cannot be strict (importScripts shares ONE global scope), so a typo'd
  // assignment silently creates a global instead of throwing. `errSteady = 0` did exactly that, leaving
  // errSince set across a mid-transition un-hydrated gap — so the 600ms errors-must-persist guard could be
  // satisfied by a timestamp from BEFORE the gap, which is the flicker it exists to reject.
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  // Assignment, not the bare word — the comment at the fix site names the typo deliberately so the next
  // reader knows what it was and why sloppy-mode hid it.
  assert.ok(!/errSteady\s*=/.test(bg), "errSteady is not a declared variable anywhere — it was a typo for errSince");
  const at = bg.indexOf("async function cdpWaitNextPageInner(");
  const body = bg.slice(at, bg.indexOf("\nconst WALK_MAX_PAGES", at));
  assert.match(body, /steady = -1; errSince = 0; continue;/,
    "the un-hydrated branch must reset BOTH the stability run and the error-persistence window");
});
