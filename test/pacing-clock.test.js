"use strict";
// The PACING CLOCK (cdp.js) — cdpDelay and its guards.
//
// Why this exists: ALL fill pacing goes through cdpDelay, and until 2026-08-10 it was a bare
// setTimeout inside an MV3 service worker, which Chrome starves — a 250ms pace measured at 17.30s live
// (docs/fill-speed-log.md). The fix moves the clock into the page (worker-timer-backed, throttle-immune)
// and the RISK moves with it: the page clock is only valid while the polyfill is live, an eval can throw
// on a detach, and an eval can HANG across a navigation. Each of those three is a way to make the fill
// silently wait wrong, so each is pinned here.
//
// cdp.js can't be require()d (it expects chrome.* at load), so the clock is extracted from source
// between its markers and run with injected fakes — the idiom from test/classify-source.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "cdp.js"), "utf8");
const START = "// ── PACING CLOCK START";
const END = "// ── PACING CLOCK END ──";
const a = src.indexOf(START);
const b = src.indexOf(END);
assert.ok(a > 0 && b > a, "pacing-clock markers not found in cdp.js — did they get renamed?");
const block = src.slice(src.indexOf("\n", a) + 1, b);

// Build the clock in a scope where its module-level dependencies are ours to control.
function makeClock({ tabId = 1, workerTimers = true, pageClock = true, sendRaw }) {
  const logs = [];
  const factory = new Function(
    "deps",
    `let cdpTabId = deps.tabId;
     let _workerTimersActive = deps.workerTimers;
     const cdpSendRaw = deps.sendRaw;
     const console = { log: deps.log };
     ${block}
     cdpSetPageClock(deps.pageClock);
     return { cdpDelay, cdpPageSleep, cdpSetPageClock, cdpPageClockEnabled, PAGE_SLEEP_SLACK_MS,
              setTabId: (v) => { cdpTabId = v; },
              setWorkerTimers: (v) => { _workerTimersActive = v; } };`
  );
  const api = factory({ tabId, workerTimers, pageClock, sendRaw, log: (m) => logs.push(String(m)) });
  return {
    ...api,
    paceLogs: () => logs.filter((m) => /\[PACE\]/.test(m)),
    enableLogs: () => logs.filter((m) => /page-clock pacing ENABLED/.test(m)),
  };
}

/** A page-clock stand-in: resolves after `ms` of REAL time, and records the calls it received. */
function fakePageClock(calls, { hang = false, throwWith = null, throwAfterMs = 0, ms = null } = {}) {
  return (method, params) => {
    calls.push({ method, params });
    if (throwWith) {
      return new Promise((_, rej) => setTimeout(() => rej(new Error(throwWith)), throwAfterMs));
    }
    if (hang) return new Promise(() => {}); // never settles — the navigation-straddle case
    const asked = ms !== null ? ms : Number(/setTimeout\(r,(\d+)\)/.exec(params.expression)[1]);
    return new Promise((r) => setTimeout(r, asked));
  };
}

test("uses the PAGE clock when attached and worker timers are live — via Runtime.evaluate + awaitPromise", async () => {
  const calls = [];
  const c = makeClock({ sendRaw: fakePageClock(calls) });
  await c.cdpDelay(40);
  assert.equal(calls.length, 1, "should have paced on the page clock exactly once");
  assert.equal(calls[0].method, "Runtime.evaluate");
  assert.equal(calls[0].params.awaitPromise, true, "awaitPromise is what makes the command wait for the page timer");
  // window.setTimeout (not a bare setTimeout) is load-bearing: the polyfill REPLACES window.setTimeout,
  // so referencing it explicitly is what routes the sleep through the worker-backed timer.
  assert.match(calls[0].params.expression, /window\.setTimeout\(r,40\)/);
});

test("worker timers NOT live ⇒ SW timer, never the page clock (the throttled ~1Hz regime must be untouched)", async () => {
  const calls = [];
  const c = makeClock({ workerTimers: false, sendRaw: fakePageClock(calls) });
  const t0 = Date.now();
  await c.cdpDelay(40);
  assert.equal(calls.length, 0, "a page sleep on throttled page timers could take ~1s per 40ms pace");
  assert.ok(Date.now() - t0 >= 35, "still actually waited");
});

test("not attached ⇒ SW timer (onboarding paces before any attach)", async () => {
  const calls = [];
  const c = makeClock({ tabId: null, sendRaw: fakePageClock(calls) });
  await c.cdpDelay(30);
  assert.equal(calls.length, 0);
});

test("a THROWN eval falls back ONCE, for the REMAINDER only — no double-wait", async () => {
  // Throws PART WAY through (250ms into a 400ms pace) so remainder(~150ms) and full-want(400ms) are
  // distinguishable — a fallback that re-waits the whole pace lands at ~650ms instead of ~400ms.
  const c = makeClock({ sendRaw: fakePageClock([], { throwWith: "context destroyed", throwAfterMs: 250 }) });
  const t0 = Date.now();
  await c.cdpDelay(400);
  const took = Date.now() - t0;
  assert.ok(took >= 380, `should still honour the full pace; took ${took}ms`);
  assert.ok(took < 560, `must wait only the REMAINDER after the throw, not the full pace again; took ${took}ms`);
});

test("a HANGING eval is abandoned at want+slack and never blocks forever (the navigation-straddle case)", async () => {
  const calls = [];
  const c = makeClock({ sendRaw: fakePageClock(calls, { hang: true }) });
  const t0 = Date.now();
  await c.cdpDelay(20);
  const took = Date.now() - t0;
  assert.equal(calls.length, 1, "the page sleep was attempted");
  assert.ok(took >= 20, "never under-waits the requested pace");
  assert.ok(took <= 20 + c.PAGE_SLEEP_SLACK_MS + 400,
    `abandoned near want+slack, not hung; took ${took}ms`);
});

test("never under-waits: the fallback race arm is strictly longer than the requested pace", () => {
  const c = makeClock({ sendRaw: fakePageClock([]) });
  assert.ok(c.PAGE_SLEEP_SLACK_MS > 0, "a zero/negative slack would let the SW arm win early and cut a pace short");
});

test("ms=0 short-circuits to the SW path (no CDP round trip for a no-op pace)", async () => {
  const calls = [];
  const c = makeClock({ sendRaw: fakePageClock(calls) });
  await c.cdpDelay(0);
  assert.equal(calls.length, 0, "a 0ms pace should not cost a debugger round trip");
});

test("a non-numeric pace is coerced, not turned into NaN (NaN would make setTimeout fire immediately)", async () => {
  const calls = [];
  const c = makeClock({ sendRaw: fakePageClock(calls) });
  await c.cdpDelay(undefined);
  assert.equal(calls.length, 0);
  await c.cdpDelay("45");
  assert.match(calls[0].params.expression, /window\.setTimeout\(r,45\)/);
});

test("a badly overrunning pace logs once, with no debug flag set", async () => {
  // A page clock that ignores the request and takes far longer than asked.
  const slow = () => new Promise((r) => setTimeout(r, 1400));
  const c = makeClock({ sendRaw: slow });
  await c.cdpDelay(20);
  assert.equal(c.paceLogs().length, 1, "the whole point is that drift is visible WITHOUT a flag");
  assert.match(c.paceLogs()[0], /20ms pace took/);
});

test("a pace inside budget logs NOTHING (a healthy run must stay quiet)", async () => {
  const c = makeClock({ sendRaw: fakePageClock([]) });
  await c.cdpDelay(30);
  assert.equal(c.paceLogs().length, 0);
});

// ── the PAGE-TRANSITION wait must stay SW-timed ───────────────────────────────────────────────────
// Source-level (background.js can't be require()d — it expects chrome.* at load), the idiom from
// test/onboarding.test.js. This guards a HALT: cdpWaitNextPage is a 15s wall-clock budget with a
// cdpAdaptiveDelay(500) interval, so a page clock hanging mid-navigation buys ~7 polls instead of ~30
// and the walk nav-timeouts on a page that was merely slow to transition.
// The onboarding poll loop may use the page clock ONLY for the interval following a SUCCESSFUL in-page
// scan, and must leave onboarding SW-timed afterwards. Onboarding NAVIGATES, and a navigating document's
// timer never fires — the un-gated version of this halted a live run at waitFor(resume-upload-input).
test("onboarding waitFor arms the page clock ONLY after a successful scan, and always disarms", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const at = bg.indexOf("const waitFor = async (pred, timeoutMs, label, opts) => {");
  assert.ok(at > 0, "onboarding waitFor not found — renamed?");
  const body = bg.slice(at, at + 6000);
  assert.match(body, /cdpSetPageClock\(lastScanOk\)/,
    "the page clock must be gated on the PREVIOUS scan having succeeded, never armed unconditionally");
  assert.match(body, /finally\s*\{\s*cdpSetPageClock\(false\)/,
    "must disarm in a finally — onboarding's default is the SW timer, and a thrown pace must not leak it on");
  assert.match(body, /lastScanOk = !!st;/,
    "a FAILED scan (mid-navigation / detached) must drop back to the SW timer");
});

test("cdpWaitNextPage disables the page clock around its poll, and restores it", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const at = bg.indexOf("async function cdpWaitNextPage(");
  assert.ok(at > 0, "cdpWaitNextPage not found — renamed?");
  const head = bg.slice(at, bg.indexOf("async function cdpWaitNextPageInner", at));
  assert.match(head, /cdpPageClockEnabled\(\)/, "must SAVE the current page-clock state");
  assert.match(head, /cdpSetPageClock\(false\)/, "must SW-time the transition poll");
  assert.match(head, /finally\s*\{[\s\S]*cdpSetPageClock\(_wasPageClock\)/,
    "must RESTORE in a finally — the poll has many early returns (session-dead, maintenance, softError, advanced)");
});

// ── the SCOPE gate — this is the regression that halted a live run ────────────────────────────────
test("page clock OFF (onboarding/auth/recon) ⇒ SW timer, no page sleep attempted", async () => {
  const calls = [];
  const c = makeClock({ pageClock: false, sendRaw: fakePageClock(calls) });
  const t0 = Date.now();
  await c.cdpDelay(40);
  assert.equal(calls.length, 0,
    "onboarding paces MUST stay SW-timed: a navigating document's timer doesn't fire, which starves "
    + "poll SAMPLES and halted a live run at waitFor(resume-upload-input) after only 21 polls in 25s");
  assert.ok(Date.now() - t0 >= 35, "still actually waited");
});

test("page clock is OFF until explicitly enabled (per-run opt-in, reset at attach)", async () => {
  const calls = [];
  const c = makeClock({ pageClock: false, sendRaw: fakePageClock(calls) });
  await c.cdpDelay(20);
  assert.equal(calls.length, 0, "default must be the safe SW path");
  c.cdpSetPageClock(true);
  await c.cdpDelay(20);
  assert.equal(calls.length, 1, "enabling it opts into the page clock");
});

test("cdpPageClockEnabled reports the state, so a step can SAVE/RESTORE around itself", async () => {
  const calls = [];
  const c = makeClock({ sendRaw: fakePageClock(calls) });
  assert.equal(c.cdpPageClockEnabled(), true);
  // What cdpWaitNextPage does around the transition poll.
  const saved = c.cdpPageClockEnabled();
  c.cdpSetPageClock(false);
  assert.equal(c.cdpPageClockEnabled(), false);
  await c.cdpDelay(20);
  assert.equal(calls.length, 0, "the SW-timed window really is SW-timed");
  c.cdpSetPageClock(saved);
  await c.cdpDelay(20);
  assert.equal(calls.length, 1, "and the page clock comes back afterwards");
});

test("enabling is announced ONCE, not once per page transition (save/restore must not spam the log)", () => {
  const c = makeClock({ pageClock: false, sendRaw: fakePageClock([]) });
  // cdpWaitNextPage flips this off/on around EVERY transition; a 5-page walk would print 5 lines.
  for (let i = 0; i < 4; i++) { c.cdpSetPageClock(true); c.cdpSetPageClock(false); }
  c.cdpSetPageClock(true);
  assert.equal(c.enableLogs().length, 1, `announced once per run, saw ${c.enableLogs().length}`);
});
