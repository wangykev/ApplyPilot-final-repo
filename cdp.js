// ============================================================================
// cdp.js — CDP substrate (chrome.debugger) for off-the-page-loop actuation.
//
// WHY: a hidden/minimized Workday tab throttles page timers to ~1Hz and then
// deep-freezes, so page-injected actuation (synthetic events paced by page-side
// setTimeout) crawls and stalls. CDP input commands are issued from the service
// worker and execute off the page loop — throttle-immune (proven empirically:
// Claude-in-Chrome filled a hidden tab whose page loop stayed throttled at
// Δperf ≈ 1000ms). Workday's debounced REACTION to that input still runs
// page-side and throttled, so callers must pace everything with GENEROUS
// SW-side wall-clock waits (cdpDelay) — never page-side timers.
//
// SW-ONLY: loaded via importScripts in background.js; uses chrome.debugger, so
// nothing here is Node-testable (no UMD guard). The testable brain
// (fill-driver.js, Step 2) talks to this only through the actuation interface —
// it must never call chrome.debugger itself (substrate-swap hedge).
//
// LIFECYCLE RULES (carried over from the throttle-experiment harness):
//   • single tracked attachment — ONE debugger client per tab (page DevTools on
//     the same tab is a second client and kills the attach),
//   • the caller detaches in a `finally` — always, even on error/throw,
//   • external detach (infobar Cancel / DevTools opening) and tab close clear
//     the tracked state via the listeners below, so a later cdpDetach is a
//     safe no-op.
// ============================================================================

let cdpTabId = null; // the tab our chrome.debugger client is attached to (or null)

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === cdpTabId) {
    console.log("[ApplyPilot][CDP] debugged tab closed — clearing attach state.");
    cdpTabId = null;
  }
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source && source.tabId === cdpTabId) {
    const operatorCancel = reason === "canceled_by_user"; // native infobar Cancel/X
    console.log(operatorCancel
      ? "[ApplyPilot][CDP] ⛔ OPERATOR CANCELLED mid-run — the debugger was detached (Cancel/X on the “started debugging” banner). The in-flight fill's CDP calls will now fail; THIS is the cause of any errors below. Tearing down the input-lock overlay."
      : "[ApplyPilot][CDP] chrome.debugger detached externally — " + reason + " — the in-flight fill will error out. Tearing down the input-lock overlay.");
    const tid = cdpTabId;
    cdpTabId = null;
    inputLockActive = false;
    // Persist the CAUSE so the aborted run's errors aren't mysterious: the popup + the summary page read
    // `lastRunAbort` and show "operator cancelled mid-run" (cleared at the next cdpAttach — fresh session).
    try { chrome.storage.local.set({ lastRunAbort: { reason: operatorCancel ? "operator-cancelled" : "debugger-detached", detachReason: reason || null, at: Date.now() } }); }
    catch (e) { /* storage unavailable — the SW log above still names the cause */ }
    // The native infobar "Cancel" detaches the debugger MID-RUN, which strands the "please don't click or
    // type" input-lock overlay on the page: the run's finally → removeInputLock() goes through cdpEval,
    // which now can't reach the (detached) page and silently no-ops. So tear the overlay down here via
    // chrome.scripting (no debugger needed). cdpRemoveInputLock is self-contained + a no-op if never
    // installed / the tab is gone. This is the "Cancel ⇒ detach + remove the lock banner" behavior.
    // world:"MAIN" is LOAD-BEARING: the overlay was installed via cdpEval (CDP Runtime.evaluate → the page's
    // MAIN world), so window.__apLock lives there. chrome.scripting defaults to the ISOLATED world, where
    // __apLock is undefined → cdpRemoveInputLock would no-op and leave the banner stuck (the 2026-07-06 bug).
    try { chrome.scripting.executeScript({ target: { tabId: tid }, world: "MAIN", func: cdpRemoveInputLock }).catch(() => {}); }
    catch (e) { /* tab gone / no scripting host — nothing to clean */ }
  }
});

// SW-side wall-clock delay — the ONLY pacing primitive CDP fill code may use.
// (Page-side setTimeout is throttled to ~1Hz hidden, then frozen; this isn't.)
const cdpDelay = (ms) => new Promise((r) => setTimeout(r, ms));

// Attach to `tabId` and enable the domains we use (Runtime for evaluate, DOM for
// the DOM.focus fallback, Page for addScriptToEvaluateOnNewDocument — the hidden-
// tab SPA-transition override installer; Input.* needs no enable). The attach
// SURVIVES same-tab navigation regardless of enabled domains — no re-injection.
// { ok } or { ok:false, error }.
function cdpAttach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, "1.3", async () => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      cdpTabId = tabId;
      try { chrome.storage.local.remove("lastRunAbort"); } catch (e) { /* ignore */ } // fresh session — drop any prior operator-cancel marker
      _visCache = { visible: false, at: 0 };   // fresh foreground sampling per run (adaptive pacing)
      _timerLatCache = { fast: null, at: 0 };  // fresh timer-latency sampling per run
      _workerTimersActive = false;             // re-detected by cdpInstallPageOverrides after attach (default slow/safe until then)
      try {
        await cdpSend("Runtime.enable", {});
        await cdpSend("DOM.enable", {});
        await cdpSend("Page.enable", {}); // required for Page.addScriptToEvaluateOnNewDocument (cdpInstallPageOverrides)
        // Refresh the debug input-trace toggle per run (popup checkbox → chrome.storage.local).
        try { const { debugInputTrace } = await new Promise((r) => chrome.storage.local.get("debugInputTrace", r)); setInputTrace(!!debugInputTrace); } catch (e) { /* default stays OFF */ }
        resolve({ ok: true });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  });
}

// Idempotent detach of the tracked attachment — safe in finally, after tab
// close, and after an external detach (swallows "Debugger is not attached").
function cdpDetach() {
  return new Promise((resolve) => {
    if (cdpTabId === null) { resolve(); return; }
    const id = cdpTabId;
    chrome.debugger.detach({ tabId: id }, () => {
      void chrome.runtime.lastError;
      console.log("[ApplyPilot][CDP] detached from tab", id);
      cdpTabId = null;
      resolve();
    });
  });
}

// Promisified sendCommand against the tracked tab. Rejects on no-attach and on
// command errors (so callers' try/catch sees real failures, not undefineds).
function cdpSend(method, params) {
  return new Promise((resolve, reject) => {
    if (cdpTabId === null) { reject(new Error("CDP not attached")); return; }
    chrome.debugger.sendCommand({ tabId: cdpTabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(method + ": " + chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// Best-effort page WAKE: nudge a backgrounded tab out of Chrome's FROZEN lifecycle so Workday's
// SPA page-to-page transition can run. A HIDDEN tab throttles timers to ~1Hz and pauses rAF; the
// fill survives that (React schedules its commits on a channel that still runs), but the route
// transition after "Save & Continue" stalls (the 2026-07-03 hidden page-2→3 stall — advances when
// visible, never when hidden even with a 40s wait). setWebLifecycleState('active') resumes a frozen
// page; it is a no-op / swallowed error if the page isn't frozen or the command isn't supported.
// It does NOT spoof document.visibilityState (that would corrupt the adaptive-pacing sampler and
// race the next page's fill) — only the freeze lifecycle. If this proves insufficient the cause is
// pure rAF-pause, which only true tab visibility resumes.
async function cdpWakePage() {
  try { await cdpSend("Page.setWebLifecycleState", { state: "active" }); } catch (e) { /* best-effort — no-op if unsupported/not frozen */ }
}

// ── Hidden-tab SPA-transition unblock (2026-07-03) ───────────────────────────
// A HIDDEN/minimized tab has requestAnimationFrame FULLY PAUSED (and timers
// throttled to ~1Hz). The CDP fill survives that (React commits on a channel that
// still runs backgrounded — 40 fields audit clean hidden), but Workday's page-to-
// page SPA ROUTE TRANSITION after "Save & Continue" defers on rAF, so it never
// runs while hidden → the walk stalls at page 2 (live-diagnosed: the errors clear
// 2→0 but the page never advances, even in a 40s wait; a VISIBLE tab advances).
// FIX: repoint requestAnimationFrame at setTimeout — a paused-forever rAF becomes
// an eventually-firing timer (~1fps under the background throttle, enough to
// unblock a one-shot router "next frame" defer). hasFocus() is patched to true
// (Workday gates some logic on focus; it is a METHOD, not a getter).
//
// Installed at attach (cdpInstallPageOverrides): addScriptToEvaluateOnNewDocument
// covers any FUTURE full document load / session refresh; a Runtime.evaluate of
// the SAME source patches the CURRENT already-loaded SPA doc (the walk attaches
// when the operator is already on the form — the SPA never reloads, so the new-
// document hook alone would never fire). __apOverridesInstalled makes both idempotent.
//
// STAGE 1 (2026-07-04): the override now ALSO installs a WORKER-TIMERS polyfill so a
// hidden tab runs FAST, not just correct. rAF→setTimeout alone still fires at ~1fps
// hidden (setTimeout is throttled to ~1Hz), so the fill worked hidden but crawled.
// Timers routed through a Web Worker escape Chrome's main-thread background throttle
// (the callback returns via postMessage, which isn't throttled) — so the page's own
// debounced reactions (typeahead filter, dropdown render, section mounts) run at
// full speed hidden, and our pacing can follow (see cdpFast/cdpTimersFast). The
// worker install is BEST-EFFORT (Workday CSP may block blob: workers): its own
// try/catch sets window.__apWorkerTimers true/false and NEVER stops the rAF override
// (which installs after it). When the worker is unavailable we fall back to native
// (throttled) timers → measured slow → the pacing stays full → byte-identical to the
// pre-Stage-1 slow-but-correct path. rAF's inner window.setTimeout is worker-backed
// when available, so rAF fires fast too. Set window.__apWorkerTimers is read back by
// cdpInstallPageOverrides into _workerTimersActive.
//
// forceNoWorker (the forceWorkerTimersOff debug flag): skip the worker block and set
// __apWorkerTimers=false — simulates a CSP-blocked tenant so the no-regression slow
// path can be exercised on demand (Workday's real CSP is an empirical unknown).
let _workerTimersActive = false; // did the worker-timers polyfill install on the CURRENT doc? (set by cdpInstallPageOverrides readback; reset at attach)

function buildOverrideSrc(opts) {
  const forceNoWorker = !!(opts && opts.forceNoWorker);
  const workerBlock = forceNoWorker
    ? `window.__apWorkerTimers = false; /* forceWorkerTimersOff — simulate a CSP-blocked tenant (slow-path test) */`
    : `try {
      var __wsrc = "var m={};onmessage=function(e){var d=e.data;" +
        "if(d.c==='s'){m[d.i]=setTimeout(function(){delete m[d.i];postMessage(d.i);},d.ms);}" +
        "else if(d.c==='v'){m[d.i]=setInterval(function(){postMessage(d.i);},d.ms);}" +
        "else{clearTimeout(m[d.i]);clearInterval(m[d.i]);delete m[d.i];}};";
      var __w = new Worker(URL.createObjectURL(new Blob([__wsrc], { type: "application/javascript" }))); // THROWS if CSP blocks blob: workers
      var __cbs = {}, __seq = 1;
      var __toFn = function (f) { if (typeof f === "function") return f; try { return new Function(f); } catch (x) { return function () {}; } };
      __w.onmessage = function (e) { var r = __cbs[e.data]; if (!r) return; if (r.once) delete __cbs[e.data]; try { r.fn.apply(null, r.args); } catch (x) {} };
      window.setTimeout = function (fn, ms) { var i = __seq++; __cbs[i] = { fn: __toFn(fn), args: [].slice.call(arguments, 2), once: true }; __w.postMessage({ c: "s", i: i, ms: ms || 0 }); return i; };
      window.setInterval = function (fn, ms) { var i = __seq++; __cbs[i] = { fn: __toFn(fn), args: [].slice.call(arguments, 2), once: false }; __w.postMessage({ c: "v", i: i, ms: ms || 0 }); return i; };
      window.clearTimeout = function (i) { delete __cbs[i]; __w.postMessage({ c: "x", i: i }); };
      window.clearInterval = function (i) { delete __cbs[i]; __w.postMessage({ c: "x", i: i }); };
      window.__apWorkerTimers = true;
    } catch (e) { window.__apWorkerTimers = false; }`;
  return `(function () {
  try {
    if (window.__apOverridesInstalled) return;
    window.__apOverridesInstalled = true;
    Document.prototype.hasFocus = function () { return true; };
    // (S1) worker-timers FIRST (own try/catch) — so the rAF polyfill below picks up
    // the worker-backed window.setTimeout and fires fast, not ~1fps, when hidden.
    ${workerBlock}
    // rAF→setTimeout — installs regardless of the worker outcome (a paused-forever
    // rAF becomes an eventually-firing timer; worker-backed = fast, native = ~1fps).
    var last = 0;
    window.requestAnimationFrame = function (cb) {
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var wait = Math.max(0, 16 - (now - last));
      var id = window.setTimeout(function () { cb((window.performance && performance.now) ? performance.now() : Date.now()); }, wait);
      last = now + wait;
      return id;
    };
    window.cancelAnimationFrame = function (id) { window.clearTimeout(id); };
  } catch (e) { /* best-effort */ }
})();`;
}

// Install the override (buildOverrideSrc) both for future documents AND on the current
// SPA doc, then read back whether worker-timers took. Best-effort: an install failure
// logs and is swallowed — it must NEVER abort a run (the fill already works hidden;
// this helps page-to-page advancement AND, via worker-timers, hidden-run SPEED).
async function cdpInstallPageOverrides() {
  let forceNoWorker = false;
  try { const { forceWorkerTimersOff } = await new Promise((r) => chrome.storage.local.get("forceWorkerTimersOff", r)); forceNoWorker = !!forceWorkerTimersOff; } catch (e) { /* default OFF */ }
  try {
    const src = buildOverrideSrc({ forceNoWorker });
    await cdpSend("Page.addScriptToEvaluateOnNewDocument", { source: src }); // future loads / re-auth
    await cdpSend("Runtime.evaluate", { expression: src });                  // the current already-loaded SPA doc
    // Read back whether the worker-timers polyfill actually installed on the CURRENT
    // doc (CSP could block blob: workers → false → we stay on the safe slow path).
    try { _workerTimersActive = !!(await cdpEval(() => !!window.__apWorkerTimers)); } catch (e) { _workerTimersActive = false; }
    const wt = _workerTimersActive ? "ON" : (forceNoWorker ? "OFF (forced)" : "OFF (CSP?)");
    console.log(`[ApplyPilot][CDP] page overrides installed (rAF→setTimeout + hasFocus; worker-timers ${wt}) — hidden-tab unblock + fast timers.`);
  } catch (e) {
    _workerTimersActive = false;
    console.log("[ApplyPilot][CDP] page-override install failed (best-effort, continuing):", String((e && e.message) || e));
  }
}

// Run a SELF-CONTAINED function in the page via Runtime.evaluate and return its
// JSON value. Args must be JSON-serializable; fn must close over nothing (same
// discipline as chrome.scripting injections). CDP-injected evaluation executes
// promptly even hidden (it is not timer-driven) — this is the DOM-READ channel;
// all WAITING between reads stays SW-side (cdpDelay).
async function cdpEval(fn, ...args) {
  const expression = "(" + String(fn) + ")(" + args.map((a) => JSON.stringify(a)).join(",") + ")";
  const res = await cdpSend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error("cdpEval: " + ((d.exception && d.exception.description) || d.text || "page exception"));
  }
  return res && res.result ? res.result.value : undefined;
}

// ── Foreground-adaptive pacing ───────────────────────────────────────────────
// The fill's budgets are GENEROUS — tuned for the hidden-tab ~1Hz throttle (the
// page's debounced REACTION runs page-side + throttled). When the tab is VISIBLE
// the page runs full-speed, so those waits are wasteful. act.delay (wired to
// cdpAdaptiveDelay) scales DOWN when foreground and stays FULL when hidden —
// re-sampled (TTL) so a mid-fill minimize/restore adapts live ("fall back to slow
// if hidden"). This scales the inter-action delays AND the settle-poll INTERVALS
// (both flow through act.delay); the deadlines/ceilings are computed from raw
// budget values and are NOT routed through act.delay, so they stay full — a
// transient slow moment breaks early on success and never times out. Visible =
// fast happy path; safe failure ceiling either way.
// NOTE: pacing only. Visible CDP ACTUATION itself (coordinate-clicks, scrollIntoView,
// focus) is a separate, newly-exercised surface — see runCdpFillPage / docs.
const FAST_FACTOR = 0.1;    // fast delays = 1/10 the full delays (rapidfire; raise if a fast fill races — all adaptive sites are gated, so a race retries/flags, never a silent wrong fill)
const FAST_FLOOR_MS = 10;   // …but never below this (a too-short wait races even full-speed)
const TYPE_FAST_FLOOR_MS = 15; // per-KEYSTROKE floor (Stage B) — higher than FAST_FLOOR_MS so keystroke-driven listeners still arm the typeahead highlight when typing fast (see cdpTypeChars)
const VIS_TTL_MS = 500;     // re-sample real visibility at most this often (amortize the chrome.tabs/windows round-trip)

let _visCache = { visible: false, at: 0 };

// Measured page-timer-latency cache (STAGE 1). The HONEST "is the page throttled?"
// signal: a real in-page setTimeout(0) round-trip. Fast (worker-backed or visible) ≈
// <10ms; a ~1Hz-throttled tab ≈ ~1000ms. This is what lets us pace fast on a HIDDEN
// tab — but ONLY when timers MEASURE fast, never on the mere assumption the worker
// installed (install success ≠ the override reached Workday's call sites / the worker
// still alive). See cdpTimersFast (non-blocking) + cdpFast (the gate).
let _timerLatCache = { fast: null, at: 0 };
const TIMER_FAST_MS = 200;  // <TIMER_FAST_MS round-trip ⇒ not throttled. 1Hz throttle ≈ 1000ms; fast ≈ <10ms; 200ms is a safe margin AND the race timeout.
const TIMER_TTL_MS = 1500;  // throttle state is stable; re-measure occasionally (catches worker death / occlusion change mid-run)

// Cached, off-loop foreground read. Reads REAL visibility from the SERVICE WORKER
// (chrome.tabs + chrome.windows), NOT document.visibilityState from the page.
// WHY (hidden-walk fix, 2026-07-03): the escalation path SPOOFS document.
// visibilityState in the page to make Workday's SPA route transition run while
// backgrounded. If this sampler read the spoofed page value it would always see
// "visible" and drive act.delay 5× faster on a still-throttled page → races the
// fill. Reading REAL visibility here is the PREREQUISITE that keeps that spoof
// safe (and is strictly more accurate regardless of whether the spoof is on).
// Visibility = tab.active (the tab is frontmost in its window) AND the window not
// minimized — focus is NOT required (an unfocused-but-active tab still renders
// full-speed). The TTL keeps act.delay from round-tripping every call. Reset at
// attach (fresh per run). On any read failure (tab/window gone, not attached)
// default to NOT-visible → full (safe) delays, matching the prior behavior.
async function cdpVisible() {
  if (Date.now() - _visCache.at <= VIS_TTL_MS) return _visCache.visible;
  let vis = false;
  try {
    const tab = await new Promise((resolve, reject) =>
      chrome.tabs.get(cdpTabId, (t) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(t))));
    const win = await new Promise((resolve, reject) =>
      chrome.windows.get(tab.windowId, (w) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(w))));
    vis = tab.active === true && win.state !== "minimized";
  } catch (e) { vis = false; }
  _visCache = { visible: vis, at: Date.now() };
  return vis;
}

// Measure a page-side setTimeout(0) round-trip — the "not throttled" signal (STAGE 1).
// NON-BLOCKING by construction: a throttled probe takes ~1s and a DEAD worker's probe
// NEVER resolves (window.setTimeout posts to a dead thread → the callback never fires →
// the awaitPromise CDP call would hang the SW forever). So we race the probe against an
// SW-side timeout EQUAL to the fast/slow threshold — the race IS the decision, and it
// bounds every probe to ≤TIMER_FAST_MS. The losing probe promise is abandoned (it
// resolves harmlessly later on a merely-slow page, or dangles on a dead worker — the
// page is broken then anyway). cdpFast short-circuits with !_workerTimersActive so the
// pure no-worker path never even reaches here (never pays the probe cost).
async function cdpTimersFast() {
  if (Date.now() - _timerLatCache.at <= TIMER_TTL_MS && _timerLatCache.fast != null) return _timerLatCache.fast;
  let fast = false;
  try {
    const probe = cdpSend("Runtime.evaluate", {
      expression: "new Promise(function(r){var t=performance.now();setTimeout(function(){r(performance.now()-t)},0)})",
      awaitPromise: true, returnByValue: true }); // may take ~1s (throttled) or never (dead worker) — NOT awaited directly
    const res = await Promise.race([probe, cdpDelay(TIMER_FAST_MS).then(() => "TIMEOUT")]);
    fast = res !== "TIMEOUT"; // probe won ⇒ setTimeout(0) round-tripped in < TIMER_FAST_MS ⇒ not throttled
  } catch (e) { fast = false; }
  _timerLatCache = { fast, at: Date.now() };
  return fast;
}

// The pacing decision (STAGE 1). Visible → fast (cheap, no probe). Hidden + no worker
// installed → slow (today's behavior; skip the probe). Hidden + worker installed →
// fast ONLY if timers MEASURE fast (the honest gate against a fast wait on a still-
// throttled page — the false-verify class the whole design guards against).
async function cdpFast() {
  if (await cdpVisible()) return true;
  if (!_workerTimersActive) return false;
  return await cdpTimersFast();
}

// The adaptive pacing primitive wired into act.delay. Fast (visible, or hidden with
// worker-verified-fast timers) → scaled-down wait; slow (hidden + throttled/no worker)
// → the full caller-requested wait (byte-identical to the proven path).
async function cdpAdaptiveDelay(ms) {
  const fast = await cdpFast();
  await cdpDelay(fast ? Math.max(FAST_FLOOR_MS, Math.round(ms * FAST_FACTOR)) : ms);
}

// REAL-visibility label ("visible"/"hidden") for DIAGNOSTICS — reads from the SW
// (cdpVisible), never document.visibilityState, so a "[tab hidden]" log stays
// TRUTHFUL even after the page's visibilityState is spoofed. Cheap (TTL-cached).
async function cdpVisibilityLabel() { return (await cdpVisible()) ? "visible" : "hidden"; }

// ── Operator input-lock (recon 2026-06-22) ──────────────────────────────────
// While the bot actuates a VISIBLE tab the operator could accidentally click/type and
// corrupt the fill. The bot's CDP input is isTrusted through the SAME pipeline as the
// operator's (a pointer-events:auto overlay would block the BOT's own clicks — recon
// probe 1), so we use a VISUAL-only overlay + capture-phase listeners gated by a
// `window.__apActing` COUNTER: the bot raises the counter around each input primitive
// (every Input.* originates in cdpClickAt/cdpTripleClickAt/cdpKeyTap/cdpInsertText →
// gating those = no primitive un-gated), so the listeners block ONLY the operator's
// events (counter<=0). Clear-AFTER-dispatch is safe (recon probe 3: the awaited Input.*
// resolves after page propagation — no self-block). The counter (not a bool) keeps the
// nested cdpTypeChars→cdpKeyTap path correct.
let inputLockActive = false; // module flag: when false, the primitives skip the toggle (zero cost for non-lock runs)

function cdpInstallInputLock() {
  if (window.__apLock) return true; // idempotent (re-install after a nav re-creates it on the fresh page)
  window.__apActing = 0;
  const overlay = document.createElement("div");
  overlay.id = "__ap_lock_overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:rgba(20,20,30,0.16);";
  const banner = document.createElement("div");
  banner.textContent = "⏳ ApplyPilot is filling this form — please don't click or type.";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;background:#1a73e8;color:#fff;font:600 14px system-ui,sans-serif;text-align:center;padding:10px;box-shadow:0 2px 10px rgba(0,0,0,0.35);";
  (document.body || document.documentElement).appendChild(overlay);
  (document.body || document.documentElement).appendChild(banner);
  // Block the OPERATOR's input when the bot is NOT mid-primitive (counter<=0). keydown+
  // keypress+paste cover typing (the bot's insertText bypasses keydown — recon probe 2);
  // mousedown/click/etc cover clicks + focus-via-click; Tab→keydown blocked = no focus-steal.
  // NOT wheel — let the operator scroll to watch.
  const block = (e) => { if ((window.__apActing || 0) <= 0) { e.preventDefault(); e.stopImmediatePropagation(); } };
  const types = ["mousedown", "mouseup", "click", "dblclick", "keydown", "keypress", "paste", "contextmenu"];
  types.forEach((t) => document.addEventListener(t, block, true));
  window.__apLock = { overlay, banner, block, types };
  return true;
}

function cdpRemoveInputLock() {
  const L = window.__apLock;
  if (!L) return true;
  try { L.types.forEach((t) => document.removeEventListener(t, L.block, true)); } catch (e) { /* ignore */ }
  try { if (L.overlay) L.overlay.remove(); if (L.banner) L.banner.remove(); } catch (e) { /* ignore */ }
  try { delete window.__apLock; delete window.__apActing; } catch (e) { /* ignore */ }
  return true;
}

// SW-side lifecycle + the per-primitive counter toggle (no-op unless inputLockActive).
async function installInputLock() { try { await cdpEval(cdpInstallInputLock); inputLockActive = true; } catch (e) { inputLockActive = false; } }
async function removeInputLock() { inputLockActive = false; try { await cdpEval(cdpRemoveInputLock); } catch (e) { /* tab gone / detached — nothing to remove */ } }
async function actingDelta(d) { try { await cdpEval((dd) => { window.__apActing = (window.__apActing || 0) + dd; }, d); } catch (e) { /* ignore */ } }

// ── Input primitives (trusted, off-loop) ────────────────────────────────────

// Debug trace of EVERY trusted input the bot fires (each click / triple-click / key / insertText),
// in the SW console with an [ApplyPilot][INPUT] prefix — so a fill can be replayed keystroke-by-keystroke
// when chasing a bug. TOGGLEABLE: default OFF; the popup "Debug: log keystrokes" checkbox writes
// chrome.storage.local.debugInputTrace, which cdpAttach reads per run (setInputTrace). cdpClickAt/
// cdpTripleClickAt/cdpKeyTap/cdpInsertText are the can't-miss choke points (cdpTypeChars + cdpSelectAllDelete
// + the pressEnter/Tab/Escape/arrow taps ALL route through cdpKeyTap), so logging here captures every input.
let inputTraceEnabled = false;
function setInputTrace(b) { inputTraceEnabled = !!b; }
function inputLog(...a) { if (inputTraceEnabled) console.log("[ApplyPilot][INPUT]", ...a); }

// Full mouse click at viewport CSS-pixel coords: move → press → release — the
// closest CDP analog to a real click; the resulting page events are isTrusted.
async function cdpClickAt(x, y) {
  inputLog("click", "(" + Math.round(x) + "," + Math.round(y) + ")");
  if (inputLockActive) await actingDelta(+1);
  try {
    const base = { x: Math.round(x), y: Math.round(y), pointerType: "mouse" };
    await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0 });
    await cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", ...base, button: "left", buttons: 1, clickCount: 1 });
    await cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, button: "left", buttons: 0, clickCount: 1 });
  } finally { if (inputLockActive) await actingDelta(-1); }
}

// Canonical triple-click (clickCount 1→2→3) — focuses a date spinbutton's 0-box
// `-input` by clicking its VISIBLE `-display` sibling (M33 proven recipe; the
// masked input can't be coordinate-clicked directly).
async function cdpTripleClickAt(x, y) {
  inputLog("triple-click", "(" + Math.round(x) + "," + Math.round(y) + ")");
  if (inputLockActive) await actingDelta(+1);
  try {
    const base = { x: Math.round(x), y: Math.round(y), button: "left", pointerType: "mouse" };
    await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: base.x, y: base.y, button: "none", buttons: 0, pointerType: "mouse" });
    for (let i = 1; i <= 3; i++) {
      await cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1, clickCount: i });
      await cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0, clickCount: i });
    }
  } finally { if (inputLockActive) await actingDelta(-1); }
}

// Insert text into the FOCUSED editable as one IME-style commit — fires trusted
// beforeinput/input (no per-key events). Recon (a) decides if this is enough
// for Workday's React or whether per-char key events are needed.
async function cdpInsertText(text) {
  inputLog("insertText", JSON.stringify(String(text)));
  if (inputLockActive) await actingDelta(+1);
  try { return await cdpSend("Input.insertText", { text: String(text) }); }
  finally { if (inputLockActive) await actingDelta(-1); }
}

// Named-key tap (keyDown + keyUp). def = { key, code, vk, text?, modifiers? }.
// The keyboard choke: cdpTypeChars / cdpSelectAllDelete / pressEnter/Escape/arrows ALL
// route through here, so gating cdpKeyTap covers the bot's entire key path (counter-based,
// so the nested cdpTypeChars→cdpKeyTap stays "acting" throughout — no per-char gap).
async function cdpKeyTap(def) {
  inputLog("key", JSON.stringify(def.key) + (def.modifiers ? " +mod" + def.modifiers : ""));
  if (inputLockActive) await actingDelta(+1);
  try {
    const down = {
      type: "keyDown",
      key: def.key, code: def.code,
      windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk,
      modifiers: def.modifiers || 0
    };
    if (def.text) { down.text = def.text; down.unmodifiedText = def.text; }
    await cdpSend("Input.dispatchKeyEvent", down);
    await cdpSend("Input.dispatchKeyEvent", {
      type: "keyUp", key: def.key, code: def.code,
      windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk,
      modifiers: def.modifiers || 0
    });
  } finally { if (inputLockActive) await actingDelta(-1); }
}

const CDP_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 }
};

// Per-character trusted typing (keyDown-with-text + keyUp per char), SW-paced —
// the fallback if Input.insertText doesn't arm a widget's key-driven listeners.
// Probe/profile strings are plain text; vk is best-effort for non-alphanumerics
// (the `text` field is what produces the character).
async function cdpTypeChars(text, perCharDelayMs = 40) {
  // Per-char gap is ADAPTIVE (Stage B): fast (fg / worker-fast) → scale by FAST_FACTOR but keep the
  // typing-specific TYPE_FAST_FLOOR_MS (> FAST_FLOOR_MS) so keystroke-driven listeners still arm the
  // typeahead's first-option highlight (cdpTypeChars is the KEYSTROKE path chosen over insertText for
  // exactly that — see typeInSearch). Slow path (hidden no-worker) keeps the full perCharDelayMs. Sampled
  // ONCE (not per char — no per-keystroke round-trip). A too-fast type that misses is caught downstream
  // (chip/value read-back → needs_review), never a silent wrong fill.
  const fast = await cdpFast();
  const gap = fast ? Math.max(TYPE_FAST_FLOOR_MS, Math.round(perCharDelayMs * FAST_FACTOR)) : perCharDelayMs;
  for (const ch of String(text)) {
    const isLetter = /^[a-z]$/i.test(ch);
    const isDigit = /^[0-9]$/.test(ch);
    const code = isLetter ? "Key" + ch.toUpperCase() : isDigit ? "Digit" + ch : ch === " " ? "Space" : "";
    const vk = isLetter || isDigit ? ch.toUpperCase().charCodeAt(0) : ch === " " ? 32 : 0;
    await cdpKeyTap({ key: ch, code, vk, text: ch });
    await cdpDelay(gap);
  }
}

// Clear the FOCUSED text input: Select-All (Ctrl+A — Windows/Linux modifier 2)
// then Delete. Trusted key path so React sees a real edit, unlike a "" setter.
async function cdpSelectAllDelete() {
  await cdpKeyTap({ key: "a", code: "KeyA", vk: 65, modifiers: 2 });
  await cdpAdaptiveDelay(60); // adaptive (Stage B): fast fg/worker-fast, full on the slow path; a stale-text race is caught by the caller's post-clear read-back
  await cdpKeyTap(CDP_KEYS.delete);
}

// CDP-native focus on the first match of `selector` (fallback when a CDP click
// or page-side el.focus() doesn't take). Throws if the node isn't found.
async function cdpDomFocus(selector) {
  const doc = await cdpSend("DOM.getDocument", { depth: 1 });
  const found = await cdpSend("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!found || !found.nodeId) throw new Error("cdpDomFocus: no node for " + selector);
  await cdpSend("DOM.focus", { nodeId: found.nodeId });
}

// Gate a run on the tab being hidden: SW-side poll of document.visibilityState
// via cdpEval — no page ticker, no content script. True once hidden, false on
// timeout. Transient eval errors are "not ready, keep polling", not failures.
async function cdpWaitHidden(timeoutMs = 60000, pollMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let vis = null;
    try { vis = await cdpEval(() => document.visibilityState); } catch (e) { /* keep polling */ }
    if (vis === "hidden") return true;
    await cdpDelay(pollMs);
  }
  return false;
}

// ============================================================================
// CDP actuation interface — the substrate implementation the fill driver
// (fill-driver.js) talks to. The driver owns the decision logic and ALL pacing
// (via act.delay); this layer owns elements, coordinates and CDP commands.
// In-page cdp* functions below are SELF-CONTAINED (evaluated via cdpEval) and
// locator-based — every call re-resolves fresh from document (React re-renders
// orphan any held node; recon proved it). DOM reads scope per the M14.1 rule:
// dropdown options live in the PORTALED listbox resolved via the trigger's
// aria-controls — never the wrapper subtree (a wrapper-scoped read returns 0
// options → false needs_review).
// ============================================================================

// Full-page scan: descriptors for every IN-SCOPE formField-* wrapper, document
// order, + the repeating-section count (partitioned out, never silently lost).
// classify/label/required mirror background.js fillEngine — keep in sync.
function cdpPageScan() {
  const classify = (wrapper) => {
    const fieldName = (wrapper.getAttribute("data-automation-id") || "").slice("formField-".length);
    if (fieldName === "source") return "hierarchical";
    if (wrapper.querySelector('input[type="file"]')) return "file_upload";
    if (wrapper.querySelector('[data-uxi-widget-type="multiselect"]')) return "typeahead";
    if (wrapper.querySelector('input[type="radio"]')) return "radio";
    if (wrapper.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    if (wrapper.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    const textLike = Array.from(wrapper.querySelectorAll("input")).filter((el) => {
      const t = (el.getAttribute("type") || "").toLowerCase();
      return t === "" || ["text", "email", "tel", "number", "url"].includes(t);
    });
    if (textLike.length === 1) return "text";
    if (wrapper.querySelector("textarea")) return "textarea"; // AI-2: a flat <textarea> (essay) — was "unknown"
    return "unknown";
  };
  const labelOf = (wrapper) => {
    const legend = wrapper.querySelector("legend");
    if (legend && legend.textContent.trim()) return legend.textContent.trim();
    for (const l of wrapper.querySelectorAll("label")) {
      const t = (l.textContent || "").trim();
      if (t) return t;
    }
    const ariaEl = wrapper.matches("[aria-label]") ? wrapper : wrapper.querySelector("[aria-label]");
    return ariaEl ? ariaEl.getAttribute("aria-label").trim() : null;
  };
  const requiredOf = (wrapper) => {
    for (const a of wrapper.querySelectorAll("abbr")) {
      const meta = (a.getAttribute("title") || "") + " " + (a.getAttribute("aria-label") || "");
      if (/required/i.test(meta) || (a.textContent || "").includes("*")) return true;
    }
    if (wrapper.querySelector('[aria-required="true"], [data-required="true"]')) return true;
    if (wrapper.querySelector('[data-automation-id="requiredMarker"]')) return true;
    const labelEl = wrapper.querySelector("legend") || wrapper.querySelector("label");
    if (labelEl && /\*\s*$/.test((labelEl.textContent || "").trim())) return true;
    return false;
  };
  // m3a: a field is "repeating" if ANY ancestor data-fkit-id is an INDEXED entry (or its
  // sub-wrapper) — the "-<digits>--" infix. Generic (was a hardcoded 5-prefix list) so an UNKNOWN
  // repeating section's fields don't leak into the flat scan; still flat for "phoneNumber--null"
  // (no -<digits>-- infix). LOCKSTEP idea with lib.js parseRepeatingFkit.
  const isRepeating = (w) => {
    let el = w.closest("[data-fkit-id]");
    while (el) {
      if (/-\d+--/.test(el.getAttribute("data-fkit-id") || "")) return true;
      el = el.parentElement ? el.parentElement.closest("[data-fkit-id]") : null;
    }
    return false;
  };
  // The field's CURRENT live value (the already-filled sweep: the review must inventory everything
  // the page holds, not just what the bot filled). LOCKSTEP with cdpRepeatingScan's valueOf. Empty
  // date segments render their "MM"/"DD"/"YYYY" placeholder text → filtered (never counts as filled).
  const valueOf = (wr, wt) => {
    try {
      if (wt === "dropdown") { const b = wr.querySelector('button[aria-haspopup="listbox"]'); return b ? (b.textContent || "").trim() : null; }
      if (wt === "typeahead" || wt === "hierarchical") { const chip = wr.querySelector('[data-automation-id="selectedItem"]'); return chip ? (chip.textContent || "").trim() : null; }
      if (wt === "checkbox") { const c = wr.querySelector('input[type="checkbox"]'); return c ? !!c.checked : null; }
      if (wt === "radio") { const r = wr.querySelector('input[type="radio"]:checked'); if (!r) return null; const lab = r.id ? wr.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(r.id) : r.id) + '"]') : null; return lab ? (lab.textContent || "").trim() : "selected"; }
      const segs = Array.from(wr.querySelectorAll('[data-automation-id^="dateSection"][data-automation-id$="-display"]')).map((s) => (s.textContent || "").trim()).filter((t) => t && !/^[MDY]+$/.test(t));
      if (segs.length) return segs.join("/");
      const inp = wr.querySelector("input, textarea"); return inp ? (inp.value || null) : null;
    } catch (e) { return null; }
  };
  const all = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
  const wrappers = all.filter((w) => !isRepeating(w));
  return {
    url: location.href,
    repeatingFieldCount: all.length - wrappers.length,
    fields: wrappers.map((w) => {
      const id = w.getAttribute("data-automation-id");
      const wt = classify(w);
      return {
        wrapperSel: '[data-automation-id="' + id + '"]',
        fieldName: id.slice("formField-".length),
        widgetType: wt,
        label: labelOf(w),
        isRequired: requiredOf(w),
        value: valueOf(w, wt)
      };
    })
  };
}

// SUBMIT cascade recon: READ-ONLY full-page field-set snapshot for detecting fields
// REVEALED (or hidden) when a value changes — the "previously employed here? → Yes"
// follow-ups, a Country choice's local-name boxes, a "Yes/Other → please specify" box.
// Captures EVERY formField-* wrapper (flat AND inside a repeating entry — a cascade can
// reveal either), each keyed by automation-id qualified with its enclosing data-fkit-id
// so duplicated repeating ids stay distinct across the diff. The SW runner snapshots
// twice (the operator changes ONE field by hand between them) and diffs the key sets to
// isolate the added/removed fields + their widget shape + required flag. Self-contained
// (cdpEval stringifies it — no shared helpers).
function cdpCascadeScan() {
  const classify = (w) => {
    const fieldName = (w.getAttribute("data-automation-id") || "").slice("formField-".length);
    if (fieldName === "source") return "hierarchical";
    if (w.querySelector('input[type="file"]')) return "file_upload";
    if (w.querySelector('[data-uxi-widget-type="multiselect"]')) return "typeahead";
    if (w.querySelector('input[type="radio"]')) return "radio";
    if (w.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    if (w.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    const textLike = Array.from(w.querySelectorAll("input")).filter((el) => {
      const t = (el.getAttribute("type") || "").toLowerCase();
      return t === "" || ["text", "email", "tel", "number", "url"].includes(t);
    });
    if (textLike.length === 1) return "text";
    if (w.querySelector("textarea")) return "textarea";
    return "unknown";
  };
  const labelOf = (w) => {
    const legend = w.querySelector("legend");
    if (legend && legend.textContent.trim()) return legend.textContent.trim().slice(0, 80);
    for (const l of w.querySelectorAll("label")) { const t = (l.textContent || "").trim(); if (t) return t.slice(0, 80); }
    const ariaEl = w.matches("[aria-label]") ? w : w.querySelector("[aria-label]");
    return ariaEl ? ariaEl.getAttribute("aria-label").trim().slice(0, 80) : null;
  };
  const requiredOf = (w) => {
    for (const a of w.querySelectorAll("abbr")) {
      const meta = (a.getAttribute("title") || "") + " " + (a.getAttribute("aria-label") || "");
      if (/required/i.test(meta) || (a.textContent || "").includes("*")) return true;
    }
    if (w.querySelector('[aria-required="true"], [data-required="true"]')) return true;
    if (w.querySelector('[data-automation-id="requiredMarker"]')) return true;
    const labelEl = w.querySelector("legend") || w.querySelector("label");
    if (labelEl && /\*\s*$/.test((labelEl.textContent || "").trim())) return true;
    return false;
  };
  const wrappers = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
  return {
    url: location.href,
    fieldCount: wrappers.length,
    fields: wrappers.map((w) => {
      const id = w.getAttribute("data-automation-id");
      const fkitEl = w.closest("[data-fkit-id]");
      const fkit = fkitEl ? fkitEl.getAttribute("data-fkit-id") : null;
      return {
        automationId: id,
        fieldName: id.slice("formField-".length),
        fkitContainer: fkit,                 // null = flat (page-level); non-null = inside a repeating entry
        key: (fkit ? fkit + " " : "") + id,  // stable diff key (distinguishes duplicated repeating ids)
        widgetType: classify(w),
        label: labelOf(w),
        isRequired: requiredOf(w)
      };
    })
  };
}

// M32 recon: READ-ONLY structure dump of the page's repeating sections (My
// Experience). Enumerates the `--null` ENTRY containers grouped by section
// prefix (NOT the `--startDate`/`--endDate` date wrappers that share the prefix
// — the over-match trap), and per entry: each `formField-*` field with its
// widget type, label, required flag, HASHED-id flag (→ needs labelRegex), the
// date SEGMENT ids if any (`dateSection*-input`), and the COMPOSED entry-scoped
// `wrapperSel` (the duplicate-formField-id rule — every field access must be
// entry-scoped). Also every `add-button` (rect + nearest heading, for
// findSectionAdd/clickSectionAdd) and each entry's "Delete" button rect
// (deleteEntryButton climb). No clicks — the date-input PROBE is separate, in
// the SW runner. Mirrors background.js fillRepeatingSection/fillMappedEntry.
function cdpRepeatingScan() {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  };
  const labelOf = (w) => {
    const legend = w.querySelector("legend");
    if (legend && legend.textContent.trim()) return legend.textContent.trim().slice(0, 60);
    for (const l of w.querySelectorAll("label")) { const t = (l.textContent || "").trim(); if (t) return t.slice(0, 60); }
    return null;
  };
  const classify = (w) => {
    // LOCKSTEP rungs with cdpPageScan/cdpGenericNestedScan: the file rung types a per-entry
    // Attachments input file_upload (was "unknown" → the sweep/shape exclusions missed it → a
    // text-box "Attachments" row in review); selectinput covers a typeahead whose widget node
    // carries ONLY that marker (Magna's nested specialtyParent — no "multiselect" node).
    if (w.querySelector('input[type="file"]')) return "file_upload";
    if (w.querySelector('[data-uxi-widget-type="multiselect"], [data-uxi-widget-type="selectinput"]')) return "typeahead";
    if (w.querySelector('input[type="radio"]')) return "radio";
    if (w.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    if (w.querySelector('[data-automation-id$="-input"][role="spinbutton"], [data-automation-id^="dateSection"]')) return "date";
    if (w.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    const textLike = Array.from(w.querySelectorAll("input")).filter((el) => {
      const t = (el.getAttribute("type") || "").toLowerCase();
      return t === "" || ["text", "email", "tel", "number", "url"].includes(t);
    });
    if (textLike.length === 1) return "text";
    return "unknown";
  };
  const dateSegsOf = (w) => Array.from(w.querySelectorAll('[data-automation-id^="dateSection"]'))
    .map((s) => s.getAttribute("data-automation-id")).filter(Boolean);
  // Hashed id = the suffix after "formField-" isn't a clean name (contains a hex
  // run / non-word chars) → can't be targeted by automation-id, needs labelRegex.
  const isHashed = (fieldName) => /[0-9a-f]{8}/i.test(fieldName) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(fieldName);
  const requiredOf = (w) => {
    for (const a of w.querySelectorAll("abbr")) {
      const meta = (a.getAttribute("title") || "") + " " + (a.getAttribute("aria-label") || "");
      if (/required/i.test(meta) || (a.textContent || "").includes("*")) return true;
    }
    if (w.querySelector('[aria-required="true"], [data-required="true"]')) return true;
    const labelEl = w.querySelector("legend") || w.querySelector("label");
    if (labelEl && /\*\s*$/.test((labelEl.textContent || "").trim())) return true;
    return false;
  };
  // Nearest preceding heading (climb ancestors, scan previous siblings) — maps an
  // add-button back to its section, the findSectionAdd anchor.
  const nearestHeading = (el) => {
    let p = el;
    for (let i = 0; i < 12 && p; i++) {
      let s = p.previousElementSibling;
      while (s) {
        if (/^H[1-6]$/.test(s.tagName) || s.getAttribute("role") === "heading") { const t = (s.textContent || "").trim(); if (t) return t.slice(0, 50); }
        const h = s.querySelector && s.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
        if (h) { const t = (h.textContent || "").trim(); if (t) return t.slice(0, 50); }
        s = s.previousElementSibling;
      }
      p = p.parentElement;
    }
    return null;
  };
  // m3a: DISCOVER the repeating-section prefixes from the indexed entry containers (was a hardcoded
  // 5-prefix list) → ANY repeating section is detected, known or not. "<base>-<N>--null" → prefix
  // "<base>-"; the -<digits>--null anchor excludes the date sub-wrappers AND non-section
  // "<name>--null" (e.g. phoneNumber--null). LOCKSTEP regex with lib.js parseRepeatingFkit.
  const PREFIXES = Array.from(new Set(
    Array.from(document.querySelectorAll('[data-fkit-id$="--null"]'))
      .map((e) => { const m = /^(.+?)-(\d+)--null$/.exec(e.getAttribute("data-fkit-id") || ""); return m ? m[1] + "-" : null; })
      .filter(Boolean)
  ));
  const sections = {};
  for (const prefix of PREFIXES) {
    const entries = Array.from(document.querySelectorAll('[data-fkit-id^="' + prefix + '"][data-fkit-id$="--null"]'));
    if (!entries.length) continue;
    sections[prefix] = {
      entryCount: entries.length,
      heading: nearestHeading(entries[0]), // m3a: per-section heading (backend identifier + Add anchor)
      entries: entries.map((e) => {
        const fkit = e.getAttribute("data-fkit-id");
        // "Delete" button: climb up to 6 ancestors, find a <button> whose text is "Delete".
        let del = null, p = e;
        for (let i = 0; i < 6 && p; i++) {
          p = p.parentElement;
          if (!p) break;
          const b = Array.from(p.querySelectorAll("button")).find((x) => /^delete$/i.test((x.textContent || "").trim()));
          if (b) { del = b; break; }
        }
        // The field's CURRENT value (for surfacing an already-filled UNKNOWN section in review): the
        // selected dropdown text / typeahead chip / text-input value / checkbox state / date display.
        const valueOf = (wr, wt) => {
          try {
            if (wt === "dropdown") { const b = wr.querySelector('button[aria-haspopup="listbox"]'); return b ? (b.textContent || "").trim() : null; }
            if (wt === "typeahead") { const chip = wr.querySelector('[data-automation-id="selectedItem"]'); return chip ? (chip.textContent || "").trim() : null; }
            if (wt === "checkbox") { const c = wr.querySelector('input[type="checkbox"]'); return c ? !!c.checked : null; }
            if (wt === "date") { const segs = Array.from(wr.querySelectorAll('[data-automation-id$="-display"]')).map((s) => (s.textContent || "").trim()).filter((t) => t && !/^[MDY]+$/.test(t)); return segs.length ? segs.join("/") : null; } // empty segments show "MM"/"DD"/"YYYY" placeholders — never count as filled
            if (wt === "radio") { const r = wr.querySelector('input[type="radio"]:checked'); if (!r) return null; const lab = r.id ? wr.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(r.id) : r.id) + '"]') : null; return lab ? (lab.textContent || "").trim() : "selected"; }
            const inp = wr.querySelector('input, textarea'); return inp ? (inp.value || null) : null;
          } catch (e) { return null; }
        };
        const fields = Array.from(e.querySelectorAll('[data-automation-id^="formField-"]')).map((w) => {
          const id = w.getAttribute("data-automation-id");
          const fieldName = id.slice("formField-".length);
          const wt = classify(w);
          return {
            fieldName, automationId: id,
            widgetType: wt,
            label: labelOf(w),
            isRequired: requiredOf(w),
            hashedId: isHashed(fieldName),
            dateSegments: dateSegsOf(w),
            value: valueOf(w, wt),
            wrapperSel: '[data-fkit-id="' + fkit + '"] [data-automation-id="' + id + '"]'
          };
        });
        return { entryFkitId: fkit, deletePresent: !!del, deleteRect: rectOf(del), fieldCount: fields.length, fields };
      })
    };
  }
  // insideEntry: the Add button sits INSIDE a repeating entry (any ancestor fkit with the
  // "-<digits>--" infix — the cdpPageScan isRepeating idiom, inlined LOCKSTEP: page fns are
  // stringified separately). Such a button is a NESTED sub-section's Add (cert ▸ Specialties)
  // owned by its parent section's nested config — NEVER a top-level section's (the m3b
  // reveal-by-add must skip it: clicking it mounted the phantom empty specialty row).
  const insideEntry = (b) => {
    let el = b.closest("[data-fkit-id]");
    while (el) {
      if (/-\d+--/.test(el.getAttribute("data-fkit-id") || "")) return true;
      el = el.parentElement ? el.parentElement.closest("[data-fkit-id]") : null;
    }
    return false;
  };
  const addButtons = Array.from(document.querySelectorAll('[data-automation-id="add-button"]'))
    .map((b) => ({ text: (b.textContent || "").trim().slice(0, 30), rect: rectOf(b), nearestHeading: nearestHeading(b), insideEntry: insideEntry(b) }));
  return { url: location.href, sectionsPresent: Object.keys(sections), sections, addButtons };
}

// GENERIC-DETECTION RECON (Sections milestone 1): READ-ONLY proof that enumerate-and-group on
// data-fkit-id detects repeating sections WITHOUT the hardcoded 5-prefix catalog. Self-contained
// (cdpEval stringifies it — can't share helpers with cdpRepeatingScan). Unlike cdpRepeatingScan
// (which looks up known PREFIXES) this enumerates EVERY "<base>-<N>--null" entry container and
// groups by base, so a brand-new tenant section surfaces too. Emits, for the operator to verify
// against reality: (a) detectedBases vs the known catalog (extras = new/unmapped, missing = known
// but not on this page); (b) the EXCLUDED "<name>--null" list — proof the regex didn't over-match
// (phoneNumber--null and the date sub-wrappers must NOT appear as sections); (c) a section-level
// "required" SIGNAL per section (heading-asterisk + a required field in the first entry) — the
// open unknown for the safe-delete decision (no proven signal exists yet; this gathers evidence).
// NOTHING is actuated. LOCKSTEP: the parseFkit regex == lib.js parseRepeatingFkit.
function cdpGenericRepeatingScan() {
  const labelOf = (w) => {
    const legend = w.querySelector("legend");
    if (legend && legend.textContent.trim()) return legend.textContent.trim().slice(0, 60);
    for (const l of w.querySelectorAll("label")) { const t = (l.textContent || "").trim(); if (t) return t.slice(0, 60); }
    return null;
  };
  const classify = (w) => {
    if (w.querySelector('[data-uxi-widget-type="multiselect"]')) return "typeahead";
    if (w.querySelector('input[type="radio"]')) return "radio";
    if (w.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    if (w.querySelector('[data-automation-id$="-input"][role="spinbutton"], [data-automation-id^="dateSection"]')) return "date";
    if (w.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    const textLike = Array.from(w.querySelectorAll("input")).filter((el) => {
      const t = (el.getAttribute("type") || "").toLowerCase();
      return t === "" || ["text", "email", "tel", "number", "url"].includes(t);
    });
    if (textLike.length === 1) return "text";
    return "unknown";
  };
  const isHashed = (fieldName) => /[0-9a-f]{8}/i.test(fieldName) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(fieldName);
  const dateSegsOf = (w) => Array.from(w.querySelectorAll('[data-automation-id^="dateSection"]'))
    .map((s) => s.getAttribute("data-automation-id")).filter(Boolean);
  const requiredFieldOf = (w) => {
    for (const a of w.querySelectorAll("abbr")) {
      const meta = (a.getAttribute("title") || "") + " " + (a.getAttribute("aria-label") || "");
      if (/required/i.test(meta) || (a.textContent || "").includes("*")) return true;
    }
    if (w.querySelector('[aria-required="true"], [data-required="true"]')) return true;
    const labelEl = w.querySelector("legend") || w.querySelector("label");
    if (labelEl && /\*\s*$/.test((labelEl.textContent || "").trim())) return true;
    return false;
  };
  const nearestHeading = (el) => {
    let p = el;
    for (let i = 0; i < 12 && p; i++) {
      let s = p.previousElementSibling;
      while (s) {
        if (/^H[1-6]$/.test(s.tagName) || s.getAttribute("role") === "heading") { const t = (s.textContent || "").trim(); if (t) return t.slice(0, 60); }
        const h = s.querySelector && s.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
        if (h) { const t = (h.textContent || "").trim(); if (t) return t.slice(0, 60); }
        s = s.previousElementSibling;
      }
      p = p.parentElement;
    }
    return null;
  };
  // LOCKSTEP with lib.js parseRepeatingFkit — same regex.
  const parseFkit = (id) => { const m = /^(.+?)-(\d+)--null$/.exec(id || ""); return m ? { base: m[1], index: parseInt(m[2], 10) } : null; };

  const KNOWN = ["workExperience", "education", "webAddress", "language", "certification"];
  const groups = {};
  const excluded = []; // "<name>--null" that did NOT parse as an entry (false-positive guard evidence)
  for (const e of Array.from(document.querySelectorAll('[data-fkit-id$="--null"]'))) {
    const id = e.getAttribute("data-fkit-id");
    const p = parseFkit(id);
    if (!p) { excluded.push(id); continue; }
    const g = (groups[p.base] = groups[p.base] || { base: p.base, indices: [], firstEntryEl: null });
    g.indices.push(p.index);
    if (g.firstEntryEl == null) g.firstEntryEl = e;
  }

  const detected = Object.keys(groups).map((base) => {
    const g = groups[base];
    const e0 = g.firstEntryEl;
    const headingText = nearestHeading(e0);
    const fields = e0 ? Array.from(e0.querySelectorAll('[data-automation-id^="formField-"]')).map((w) => {
      const fid = w.getAttribute("data-automation-id");
      const fn = fid.slice("formField-".length);
      return { fieldName: fn, widgetType: classify(w), label: labelOf(w), isRequired: requiredFieldOf(w), hashedId: isHashed(fn), dateSegments: dateSegsOf(w) };
    }) : [];
    return {
      base, prefix: base + "-",
      isKnown: KNOWN.indexOf(base) !== -1,
      entryCount: g.indices.length,
      indices: g.indices.slice().sort((a, b) => a - b),
      headingText,
      requiredSignals: { headingAsterisk: !!(headingText && /\*\s*$/.test(headingText)), anyRequiredFieldInFirstEntry: fields.some((f) => f.isRequired) },
      fieldShape: fields
    };
  });

  return {
    url: location.href,
    knownPrefixes: KNOWN.map((b) => b + "-"),
    detected,
    detectedBases: detected.map((d) => d.base),
    unknownBases: detected.filter((d) => !d.isKnown).map((d) => d.base),
    excludedNullContainers: excluded,
    addButtons: Array.from(document.querySelectorAll('[data-automation-id="add-button"]'))
      .map((b) => ({ text: (b.textContent || "").trim().slice(0, 30), nearestHeading: nearestHeading(b) }))
  };
}

// GENERIC NESTED-SECTION RECON (read-only): detect repeating sections NESTED inside repeating entries
// (cert → Specialties + Attachments) WITHOUT hardcoding names, for ANY depth. The generic key: a
// data-fkit-id is a "--"-joined path of "<base>-<idx>" levels + a trailing field (or "null" = an
// entry container). "certification-54--specialties-5--specialtyParent" → parent certification[54] →
// nested specialties[5] → field specialtyParent (depth 2). Dumps, per nested section: parent▸child,
// entry count, a representative entry's fields (widget/label/required/dates/entry-scoped wrapperSel),
// the container-prefix pattern, PLUS file-upload (attachment) inputs + Add buttons scoped INSIDE a
// repeating entry (the per-entry nested Add anchors). NO actuation — pure read.
function cdpGenericNestedScan() {
  const labelOf = (w) => { const lg = w.querySelector("legend"); if (lg && lg.textContent.trim()) return lg.textContent.trim().slice(0, 60); for (const l of w.querySelectorAll("label")) { const t = (l.textContent || "").trim(); if (t) return t.slice(0, 60); } return null; };
  const classify = (w) => {
    if (w.querySelector('input[type="file"]')) return "file_upload";
    // nested typeaheads observed with ONLY the selectinput marker (Magna specialtyParent — no
    // "multiselect" node); include both (self-or-descendant: the fkit node may BE the widget node)
    const taSel = '[data-uxi-widget-type="multiselect"], [data-uxi-widget-type="selectinput"]';
    if (w.querySelector(taSel) || (w.matches && w.matches(taSel))) return "typeahead";
    if (w.querySelector('input[type="radio"]')) return "radio";
    if (w.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    if (w.querySelector('[data-automation-id$="-input"][role="spinbutton"], [data-automation-id^="dateSection"]')) return "date";
    if (w.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    const textLike = Array.from(w.querySelectorAll("input")).filter((el) => { const t = (el.getAttribute("type") || "").toLowerCase(); return t === "" || ["text", "email", "tel", "number", "url"].includes(t); });
    if (textLike.length === 1) return "text";
    return "unknown";
  };
  const isHashed = (fn) => /[0-9a-f]{8}/i.test(fn) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(fn);
  const dateSegsOf = (w) => Array.from(w.querySelectorAll('[data-automation-id^="dateSection"]')).map((s) => s.getAttribute("data-automation-id")).filter(Boolean);
  const requiredOf = (w) => { for (const a of w.querySelectorAll("abbr")) { const meta = (a.getAttribute("title") || "") + " " + (a.getAttribute("aria-label") || ""); if (/required/i.test(meta) || (a.textContent || "").includes("*")) return true; } if (w.querySelector('[aria-required="true"],[data-required="true"]')) return true; const le = w.querySelector("legend") || w.querySelector("label"); if (le && /\*\s*$/.test((le.textContent || "").trim())) return true; return false; };
  const nearestHeading = (el) => { let p = el; for (let i = 0; i < 12 && p; i++) { let s = p.previousElementSibling; while (s) { if (/^H[1-6]$/.test(s.tagName) || s.getAttribute("role") === "heading") { const t = (s.textContent || "").trim(); if (t) return t.slice(0, 60); } const h = s.querySelector && s.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]'); if (h) { const t = (h.textContent || "").trim(); if (t) return t.slice(0, 60); } s = s.previousElementSibling; } p = p.parentElement; } return null; };
  // Parse a fkit into { levels: [{base,idx}...], field }. "--"-joined; each non-last segment is
  // "<base>-<idx>"; the last is the field ("null" = the level's entry container). Handles ANY depth.
  const parseFkit = (id) => {
    const parts = String(id || "").split("--");
    if (parts.length < 2) return null;
    const field = parts[parts.length - 1];
    const levels = [];
    for (let i = 0; i < parts.length - 1; i++) { const m = /^(.+)-(\d+)$/.exec(parts[i]); if (!m) return null; levels.push({ base: m[1], idx: parseInt(m[2], 10) }); }
    return { levels, field };
  };
  let maxDepth = 0;
  const nested = {}; // "parent ▸ child" → { parentBase, childBase, depth, entries: { idxpath → {path, fields[]} } }
  for (const el of Array.from(document.querySelectorAll("[data-fkit-id]"))) {
    const p = parseFkit(el.getAttribute("data-fkit-id"));
    if (!p) continue;
    if (p.levels.length > maxDepth) maxDepth = p.levels.length;
    if (p.levels.length < 2) continue; // NESTED only (depth ≥ 2)
    const parent = p.levels[0], child = p.levels[p.levels.length - 1];
    const key = parent.base + " ▸ " + child.base;
    const g = (nested[key] = nested[key] || { parentBase: parent.base, childBase: child.base, depth: p.levels.length, entries: {} });
    const ek = p.levels.map((l) => l.idx).join("|");
    const ent = (g.entries[ek] = g.entries[ek] || { path: p.levels.map((l) => l.base + "[" + l.idx + "]").join(" / "), levels: p.levels.map((l) => ({ base: l.base, index: l.idx })), fields: [] });
    if (p.field && p.field !== "null") {
      const id = el.getAttribute("data-fkit-id");
      const ffSel = '[data-automation-id="formField-' + p.field + '"]';
      // fkit ↔ formField relationship varies (Magna specialties: NOT ancestor→descendant) — probe it
      // and record the selector that actually resolves (the cdpNestedFieldSel ladder, inlined: page
      // fns are stringified separately and can't share helpers).
      let ff = el, wrapperSel = '[data-fkit-id="' + id + '"]';
      const desc = el.querySelector(ffSel);
      if (desc) { ff = desc; wrapperSel = '[data-fkit-id="' + id + '"] ' + ffSel; }
      else if (el.matches && el.matches(ffSel)) { /* same node — fkit selector alone */ }
      else if (el.closest && el.closest(ffSel)) { ff = el.closest(ffSel); wrapperSel = ffSel + ':has([data-fkit-id="' + id + '"])'; }
      ent.fields.push({ field: p.field, widgetType: classify(ff), label: labelOf(ff), isRequired: requiredOf(ff), hashedId: isHashed(p.field), dateSegments: dateSegsOf(ff), wrapperSel });
    }
  }
  const nestedSections = Object.keys(nested).map((k) => {
    const g = nested[k]; const eks = Object.keys(g.entries);
    // ALL entries (each { levels:[{base,index}], fields:[...] }) — the fill needs every entry, not a sample.
    return { parentBase: g.parentBase, childBase: g.childBase, depth: g.depth, containerPattern: g.parentBase + "-<N>--" + g.childBase + "-<M>--<field>", entryCount: eks.length, entries: eks.map((ek) => g.entries[ek]) };
  });
  const enclosing = (el) => { const f = el.closest("[data-fkit-id]"); return f ? f.getAttribute("data-fkit-id") : null; };
  const fileUploads = Array.from(document.querySelectorAll('input[type="file"], [data-automation-id="select-files"], [data-automation-id^="file-upload"]'))
    .map((el) => ({ automationId: el.getAttribute("data-automation-id") || el.type, heading: nearestHeading(el), enclosingFkit: enclosing(el) }))
    .filter((u) => u.enclosingFkit); // only file inputs INSIDE a repeating entry (nested attachments)
  const addButtons = Array.from(document.querySelectorAll('[data-automation-id="add-button"]'))
    .map((b) => ({ text: (b.textContent || "").trim().slice(0, 30), heading: nearestHeading(b), enclosingFkit: enclosing(b) }))
    .filter((a) => a.enclosingFkit); // Add buttons INSIDE a repeating entry = nested-section Add anchors
  // Parent-entry ORDER per base (--null containers in DOM order) — from the SAME snapshot as the nested
  // fields, so the fill maps a nested field's parent fkit index → the parent's sequential ordinal (fkit
  // indices are non-contiguous / non-zero, e.g. certification-173). Robust vs a separate repeatingScan.
  const parentOrder = {};
  for (const el of Array.from(document.querySelectorAll('[data-fkit-id$="--null"]'))) {
    const m = /^(.+?)-(\d+)--null$/.exec(el.getAttribute("data-fkit-id") || "");
    if (m) (parentOrder[m[1]] = parentOrder[m[1]] || []).push(parseInt(m[2], 10));
  }
  // Per-ENTRY attachment areas (deduped by enclosingFkit), pre-parsed "<base>-<idx>--attachments" so the
  // fill needs no fkit parsing. Excludes the top-level resume ("resumeAttachments--attachments" → no
  // -<idx> → no match).
  const nestedAttachments = []; const seenAtt = {};
  for (const u of fileUploads) {
    if (seenAtt[u.enclosingFkit]) continue;
    const am = /^(.+?)-(\d+)--attachments$/.exec(u.enclosingFkit || "");
    if (!am) continue;
    seenAtt[u.enclosingFkit] = 1;
    nestedAttachments.push({ parentBase: am[1], parentIndex: parseInt(am[2], 10), enclosingFkit: u.enclosingFkit, heading: u.heading });
  }
  // NESTED sub-section CONTAINERS — the ROBUST detector (empty OR not). A fkit
  // "<parentBase>-<idx>--<childBase>" node that is NOT a field wrapper (has no
  // formField-<childBase> descendant) and NOT an attachment area (no input[type=file]) is a repeating
  // sub-section container (e.g. certification-287--specialties). Found even when EMPTY (no
  // --<childBase>-<M>-- entries yet) and REGARDLESS of where its "Add" button sits (the addButtons
  // enclosingFkit is often the parent's --null, which the fill can't key off). GENERIC — no names.
  const nestedContainers = []; const seenNC = {};
  for (const el of Array.from(document.querySelectorAll("[data-fkit-id]"))) {
    const id = el.getAttribute("data-fkit-id") || "";
    const m = /^(.+?)-(\d+)--([A-Za-z][A-Za-z0-9_]*)$/.exec(id);
    if (!m || m[3] === "null" || seenNC[id]) continue;
    const childBase = m[3];
    if (el.querySelector('[data-automation-id="formField-' + childBase + '"]')) continue; // a FIELD wrapper (wraps its own formField) — not a sub-section
    if (el.querySelector('input[type="file"]')) continue;                                  // an ATTACHMENT area (file input present) — handled by nestedAttachments
    if (seenAtt[id] || /attachment/i.test(childBase)) continue;                             // …or the file input renders lazily (not present at scan) → exclude by fkit/name so it never becomes a bogus sub-section "box"
    seenNC[id] = 1;
    nestedContainers.push({ parentBase: m[1], parentIndex: parseInt(m[2], 10), childBase, fkit: id, heading: nearestHeading(el) });
  }
  return { url: location.href, maxDepth, nestedSections, parentOrder, nestedAttachments, nestedContainers, fileUploads, addButtons };
}

// M36.2 — read-only structure dump of the Certifications entries, for the NESTED
// Specialties sub-section recon. Per cert entry (`certification-N--null`): ALL
// descendant `data-fkit-id`s (raw — a mounted specialty's container surfaces here,
// its prefix being the recon's unknown), ALL `formField-*` fields (widget/label/
// dates/hashed/required — flat; the runner diffs before/after a mount to isolate the
// specialty's own), the Add/Delete buttons INSIDE the entry (text + nearestHeading +
// rect — to click the nested specialty Add/Delete directly, no page-wide heading
// match), and the Attachments `input[type=file]` count (recorded, not filled). Self-
// contained (cdpEval stringifies it — helpers can't be shared with cdpRepeatingScan).
function cdpCertSpecialtyScan() {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  };
  const labelOf = (w) => {
    const lg = w.querySelector("legend");
    if (lg && lg.textContent.trim()) return lg.textContent.trim().slice(0, 60);
    for (const l of w.querySelectorAll("label")) { const t = (l.textContent || "").trim(); if (t) return t.slice(0, 60); }
    return null;
  };
  const classify = (w) => {
    if (w.querySelector('[data-uxi-widget-type="multiselect"]')) return "typeahead";
    if (w.querySelector('input[type="radio"]')) return "radio";
    if (w.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    if (w.querySelector('[data-automation-id$="-input"][role="spinbutton"], [data-automation-id^="dateSection"]')) return "date";
    if (w.querySelector('input[type="file"]')) return "file";
    if (w.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    const textLike = Array.from(w.querySelectorAll("input")).filter((el) => {
      const t = (el.getAttribute("type") || "").toLowerCase();
      return t === "" || ["text", "email", "tel", "number", "url"].includes(t);
    });
    if (textLike.length === 1) return "text";
    return "unknown";
  };
  const dateSegsOf = (w) => Array.from(w.querySelectorAll('[data-automation-id^="dateSection"]'))
    .map((s) => s.getAttribute("data-automation-id")).filter(Boolean);
  const isHashed = (fn) => /[0-9a-f]{8}/i.test(fn) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(fn);
  const requiredOf = (w) => {
    for (const a of w.querySelectorAll("abbr")) {
      const meta = (a.getAttribute("title") || "") + " " + (a.getAttribute("aria-label") || "");
      if (/required/i.test(meta) || (a.textContent || "").includes("*")) return true;
    }
    if (w.querySelector('[aria-required="true"], [data-required="true"]')) return true;
    const le = w.querySelector("legend") || w.querySelector("label");
    if (le && /\*\s*$/.test((le.textContent || "").trim())) return true;
    return false;
  };
  const nearestHeading = (el) => {
    let p = el;
    for (let i = 0; i < 12 && p; i++) {
      let s = p.previousElementSibling;
      while (s) {
        if (/^H[1-6]$/.test(s.tagName) || s.getAttribute("role") === "heading") { const t = (s.textContent || "").trim(); if (t) return t.slice(0, 50); }
        const h = s.querySelector && s.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
        if (h) { const t = (h.textContent || "").trim(); if (t) return t.slice(0, 50); }
        s = s.previousElementSibling;
      }
      p = p.parentElement;
    }
    return null;
  };
  const certEntries = Array.from(document.querySelectorAll('[data-fkit-id^="certification-"][data-fkit-id$="--null"]')).map((e) => {
    const fkit = e.getAttribute("data-fkit-id");
    const nestedFkitIds = Array.from(e.querySelectorAll("[data-fkit-id]")).map((n) => n.getAttribute("data-fkit-id"));
    const fields = Array.from(e.querySelectorAll('[data-automation-id^="formField-"]')).map((w) => {
      const id = w.getAttribute("data-automation-id");
      const fn = id.slice("formField-".length);
      return { fieldName: fn, automationId: id, widgetType: classify(w), label: labelOf(w), isRequired: requiredOf(w), hashedId: isHashed(fn), dateSegments: dateSegsOf(w) };
    });
    const addButtonsInside = Array.from(e.querySelectorAll('[data-automation-id="add-button"]'))
      .map((b) => ({ text: (b.textContent || "").trim().slice(0, 30), nearestHeading: nearestHeading(b), rect: rectOf(b) }));
    const deleteButtonsInside = Array.from(e.querySelectorAll("button"))
      .filter((b) => /^delete$/i.test((b.textContent || "").trim()))
      .map((b) => ({ nearestHeading: nearestHeading(b), rect: rectOf(b) }));
    const fileInputs = e.querySelectorAll('input[type="file"]').length;
    return { fkit, nestedFkitIds, fieldCount: fields.length, fields, addButtonsInside, deleteButtonsInside, fileInputs };
  });
  return { url: location.href, certEntryCount: certEntries.length, certEntries };
}

// ── M32 repeating-section actuation page fns (self-contained, cdpEval'd) ──────
// Count a section's entries — the `--null` containers ONLY (the bare prefix
// over-matches the date sub-wrappers, e.g. workExperience-N--startDate). The
// cheap reconcile-poll primitive (lighter than a full cdpRepeatingScan).
function cdpEntryCount(prefix) {
  return document.querySelectorAll('[data-fkit-id^="' + prefix + '"][data-fkit-id$="--null"]').length;
}

// Find a section's Add/"Add Another" button by its nearest-heading regex, scroll it
// into view (instant — rAF/"smooth" is frozen hidden), return a fresh VIEWPORT rect
// for cdpClickAt. Port of background.js findSectionAdd, matched against the SAME
// nearestHeading the recon's addButtons[] used (verified 2026-06-16:
// /websites?|web ?address/i hits ONLY "Websites 3" among the 5 page-2 sections).
// NO adds.length===1 fallback — REQUIRE a heading match (5 Add buttons coexist).
function cdpSectionAddRect(regexSource) {
  const re = new RegExp(regexSource, "i");
  const nearestHeading = (el) => {
    let p = el;
    for (let i = 0; i < 12 && p; i++) {
      let s = p.previousElementSibling;
      while (s) {
        if (/^H[1-6]$/.test(s.tagName) || s.getAttribute("role") === "heading") { const t = (s.textContent || "").trim(); if (t) return t.slice(0, 50); }
        const h = s.querySelector && s.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
        if (h) { const t = (h.textContent || "").trim(); if (t) return t.slice(0, 50); }
        s = s.previousElementSibling;
      }
      p = p.parentElement;
    }
    return null;
  };
  const btn = Array.from(document.querySelectorAll('[data-automation-id="add-button"]')).find((b) => re.test(nearestHeading(b) || ""));
  if (!btn) return null;
  if (btn.scrollIntoView) btn.scrollIntoView({ block: "center", behavior: "instant" });
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

// Find the index-th `--null` entry's Delete button (climb ≤6 ancestors to a
// <button>Delete</button> — port of background.js deleteEntryButton), scroll into
// view, return a fresh VIEWPORT rect.
function cdpDeleteEntryRect(prefix, index) {
  const entries = Array.from(document.querySelectorAll('[data-fkit-id^="' + prefix + '"][data-fkit-id$="--null"]'));
  const e = entries[index];
  if (!e) return null;
  let p = e, btn = null;
  for (let i = 0; i < 6 && p; i++) {
    p = p.parentElement;
    if (!p) break;
    const b = Array.from(p.querySelectorAll("button")).find((x) => /^delete$/i.test((x.textContent || "").trim()));
    if (b) { btn = b; break; }
  }
  if (!btn) return null;
  if (btn.scrollIntoView) btn.scrollIntoView({ block: "center", behavior: "instant" });
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

// NESTED-section Add — the "Add" button INSIDE a SPECIFIC parent entry (scoped by the parent's
// fkit), matched by its nearest-heading regex (e.g. "Specialties" inside a certification-N--null
// entry). Unlike cdpSectionAddRect (page-wide, grabs the FIRST match), this scopes to ONE parent so
// reveal-by-add mounts into a KNOWN entry (and can delete from the same). scrollIntoView + rect.
function cdpNestedAddRect(parentFkit, regexSource) {
  const re = new RegExp(regexSource, "i");
  const entry = document.querySelector('[data-fkit-id="' + parentFkit + '"]');
  if (!entry) return null;
  const nearestHeading = (el) => {
    let p = el;
    for (let i = 0; i < 12 && p; i++) {
      let s = p.previousElementSibling;
      while (s) {
        if (/^H[1-6]$/.test(s.tagName) || s.getAttribute("role") === "heading") { const t = (s.textContent || "").trim(); if (t) return t.slice(0, 50); }
        const h = s.querySelector && s.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
        if (h) { const t = (h.textContent || "").trim(); if (t) return t.slice(0, 50); }
        s = s.previousElementSibling;
      }
      p = p.parentElement;
    }
    return null;
  };
  const btn = Array.from(entry.querySelectorAll('[data-automation-id="add-button"]')).find((b) => re.test(nearestHeading(b) || ""));
  if (!btn) return null;
  if (btn.scrollIntoView) btn.scrollIntoView({ block: "center", behavior: "instant" });
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

// NESTED-ENTRY Delete — a nested entry (cert Specialty) has NO `--null` container (it's the SET of
// `<parent>--<child>-<M>--<field>` fkit nodes), so cdpDeleteEntryRect can't find it. Locate a field
// of the child entry, climb to the SMALLEST ancestor holding a <button>Delete</button>, and GUARD
// that the ancestor does NOT also span the PARENT's own direct fields (`<parent>--X` where X is not
// this child) — else we've climbed to the parent entry and its Delete would nuke the whole parent.
// Fully generic (no hardcoded parent/child names). Returns null (safe no-op) if no scoped Delete.
function cdpNestedDeleteRect(parentFkit, childBase, childIndex) {
  const base = String(parentFkit).replace(/--null$/, "");                // e.g. certification-N
  const specPrefix = base + "--" + childBase + "-" + childIndex + "--";   // certification-N--specialties-M--
  const field = document.querySelector('[data-fkit-id^="' + specPrefix + '"]');
  if (!field) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // a PARENT-direct fkit = "<base>--X" where X does NOT begin "<childBase>-<digits>" (the parent's
  // OWN field, or `--null`) — its presence in an ancestor means we've climbed past the child entry.
  const parentDirectRe = new RegExp("^" + esc(base) + "--(?!" + esc(childBase) + "-\\d)");
  const parentEntry = document.querySelector('[data-fkit-id="' + parentFkit + '"]');
  let p = field, btn = null;
  for (let i = 0; i < 8 && p; i++) {
    p = p.parentElement;
    if (!p) break;
    if (parentEntry && p === parentEntry) break; // reached the parent entry → its Delete is the PARENT's
    const spansParent = Array.from(p.querySelectorAll("[data-fkit-id]")).some((n) => parentDirectRe.test(n.getAttribute("data-fkit-id") || ""));
    if (spansParent) break; // this ancestor covers the parent's own fields → too big, refuse
    // Delete button shapes vary by tenant: text "Delete"/"Remove", aria-label/title-only, or ICON-ONLY
    // (a trash svg, e.g. class "wd-icon-trash" — no text). Match all; the ancestor-scoping above (never
    // spanning the parent's own fields) is what keeps an icon-only match safe.
    const isDeleteBtn = (x) => /^(delete|remove)$/i.test((x.textContent || "").trim())
      || /delete|remove|trash/i.test((x.getAttribute("aria-label") || "") + " " + (x.getAttribute("title") || "") + " " + (x.getAttribute("data-automation-id") || ""))
      || !!x.querySelector('svg[class*="trash" i], [class*="icon-trash" i], [data-automation-id*="trash" i], [data-automation-id*="delete" i]');
    const b = Array.from(p.querySelectorAll("button")).find(isDeleteBtn);
    if (b) { btn = b; break; }
  }
  if (!btn) return null;
  if (btn.scrollIntoView) btn.scrollIntoView({ block: "center", behavior: "instant" });
  const r = btn.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

// NESTED-FIELD wrapper selector — PROBE the live fkit ↔ formField relationship instead of assuming it.
// The composed descendant selector ('[data-fkit-id="F"] [formField-X]') failed live on Magna specialties
// ("typeahead wrapper not found"): the fkit node does NOT wrap the formField there. The relationship is
// tenant-variable, so resolve it from the real DOM (Working principles: trace, don't guess) and return a
// SINGLE suffix-composable selector (the substrate string-appends ' input…' etc. — no comma lists). The
// resolved node must CONTAIN the field's inner controls. Rungs, most-specific first:
//   1. fkit node wraps the formField → the classic descendant selector
//   2. fkit node IS the formField (same node) → the fkit selector alone
//   3. fkit node sits INSIDE the formField (e.g. on the input) → formField:has(fkit)
//   4. fkit node exists but no formField div anywhere related → the fkit node itself (best effort)
//   5. no data-fkit-id at all, but an element ID carries the fkit string (observed: the specialty INPUT's
//      id is "certification-N--specialties-M--specialtyParent") → formField:has([id=…]) / the id node
// Nothing hardcoded: F is composed at runtime from scanned indices; returns null (honest) when nothing
// resolves — the caller records an error, never actuates blind.
function cdpNestedFieldSel(fkit, field) {
  const ffSel = '[data-automation-id="formField-' + field + '"]';
  const fkSel = '[data-fkit-id="' + fkit + '"]';
  const fk = document.querySelector(fkSel);
  if (fk) {
    if (fk.querySelector(ffSel)) return fkSel + " " + ffSel;
    if (fk.matches && fk.matches(ffSel)) return fkSel;
    if (fk.closest && fk.closest(ffSel)) return ffSel + ":has(" + fkSel + ")";
    return fkSel;
  }
  const byId = document.querySelector('[id="' + fkit + '"]');
  if (byId) {
    if (byId.closest && byId.closest(ffSel)) return ffSel + ':has([id="' + fkit + '"])';
    return '[id="' + fkit + '"]';
  }
  return null;
}

// M30 session-expiry recon read: a READ-ONLY static snapshot to classify whether
// the page is a live apply form vs a logged-out / expired / error state. No clicks.
// Run once on a VALID form and once LOGGED-OUT/stale to find the discriminator.
function cdpReadSessionState() {
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const bodyText = ((document.body && document.body.innerText) || "").slice(0, 20000);
  const clickables = qa('button, a, [role="button"]');
  const formFields = qa('[data-automation-id^="formField-"]');
  const errMatch = bodyText.match(/error[- ]page error[\s\S]{0,200}/i);
  // M31 recon: visible Workday error elements (count + sample text) — lets the recon
  // PROVE an ordinary page-1 validation error is separable from a VPS/session error
  // before sessionLooksDead keys off vpsErrorPresent/sessionBanner. nextButtonPresent
  // is the PRECISE footer-button read (vs the saveContinuePresent text heuristic).
  const errorEls = qa('[data-automation-id="errorMessage"], [role="alert"], [data-automation-id*="rror"]')
    .filter((el) => { const r = el.getBoundingClientRect && el.getBoundingClientRect(); return r && r.width > 0 && r.height > 0; });
  return {
    url: location.href,
    title: document.title,
    visibilityState: document.visibilityState,
    // apply-form markers
    formFieldCount: formFields.length,
    applyFlowPagePresent: !!q('[data-automation-id="applyFlowPage"]'),
    applyFlowReviewPresent: !!q('[data-automation-id="applyFlowReviewPage"]'),
    nextButtonPresent: !!q('[data-automation-id="pageFooterNextButton"]'),
    saveContinuePresent: clickables.some((b) => /save and (continue|submit)|^\s*(continue|submit|next)\s*$/i.test((b.textContent || "").trim())),
    sourcePresent: !!q('[data-automation-id="formField-source"]'),
    // login / auth markers
    passwordInputPresent: !!q('input[type="password"]'),
    signInButtonPresent: clickables.some((b) => /\b(sign[- ]?in|log[- ]?in|sign[- ]?on|log[- ]?on)\b/i.test((b.textContent || "").trim())),
    authUrl: /login|sign-?in|authn|\bsso\b|\/saml|\/idp/i.test(location.href),
    // session / timeout / error banners (capped text scan)
    sessionBanner: /(session (has )?(expired|timed out|ended)|sign in again|log in again|your session|been (signed|logged) out|timed out)/i.test(bodyText),
    vpsErrorPresent: /error code:\s*vps\|/i.test(bodyText),
    // Workday PLANNED-MAINTENANCE page ("Workday is currently unavailable") — a transient retry-later
    // state, NOT a dead session (recon 2026-06-27). isWorkdayMaintenance keys off this (+ title/bodyText).
    maintenancePresent: /workday is currently unavailable|performing (planned )?maintenance|scheduled maintenance|temporarily unavailable|check back later/i.test(bodyText),
    errorPageText: errMatch ? errMatch[0].replace(/\s+/g, " ").trim().slice(0, 200) : null,
    // M31: error-element detail for the validation-vs-VPS recon diff. Samples are now DECISION
    // INPUTS (the AI-4 tiers key off them via lib.js expandErrorSamples), not just diagnostics —
    // and Workday's top summary banner concatenates EVERY error into ONE element, so the old
    // 120-char slice silently dropped errors past the first ~2 (the 2026-07-01 live Tier-0
    // dup-language miss). 600 chars ≈ 8 concatenated errors; expandErrorSamples splits them SW-side.
    errorMarkers: { count: errorEls.length, samples: errorEls.slice(0, 8).map((el) => (el.textContent || "").trim().slice(0, 600)).filter(Boolean) },
    bodyTextSample: bodyText.slice(0, 500).replace(/\s+/g, " ").trim()
  };
}

// AI-4: the visible Workday validation-ERROR links. Recon (2026-06-22, Magna): each error in the
// top summary is a HYPERLINK that, when clicked, jump-FOCUSES the offending field — Workday's own
// error→field map (more robust than text-matching the label). Returns each error's rect (for the
// GATED cdpClickAt) + text (for logging / the field-name parse). Best-effort selector (anchors +
// role=link + errorMessage/alert/*error* elements, visible, with text); live-tune if a tenant differs.
function cdpReadErrorLinks() {
  const cands = Array.from(document.querySelectorAll(
    'a[href], [role="link"], [data-automation-id="errorMessage"], [role="alert"] a, [data-automation-id*="rror"] a, [data-automation-id*="rror"]'
  ));
  const out = [], seen = new Set();
  for (const el of cands) {
    const r = el.getBoundingClientRect && el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) continue;
    const text = (el.textContent || "").trim();
    if (!text) continue;
    const anchor = el.tagName === "A" || el.getAttribute("role") === "link" || !!el.closest("a");
    const key = Math.round(r.y) + "|" + text.slice(0, 60);
    if (seen.has(key)) continue; seen.add(key);
    out.push({ text: text.slice(0, 200), anchor, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) });
  }
  return out;
}

// AI-4: after clicking an error link (Workday focuses the offending field), identify WHICH field is
// now focused → its enclosing formField-* wrapper. Returns {fieldName, wrapperSel} or null.
function cdpFocusedFieldName() {
  const el = document.activeElement;
  const wrap = el && el.closest && el.closest('[data-automation-id^="formField-"]');
  if (!wrap) return null;
  const id = wrap.getAttribute("data-automation-id");
  return { fieldName: id.slice("formField-".length), wrapperSel: '[data-automation-id="' + id + '"]' };
}

// Fresh rect for `sel` (optionally scrollIntoView first — instant, not smooth:
// smooth is rAF-driven and rAF is frozen hidden).
function cdpRectOf(sel, scroll) {
  const el = document.querySelector(sel);
  if (!el) return null;
  if (scroll && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

// M29 reliability: a rect read RETRIED SW-side until the element has a non-zero
// layout box (or a ceiling). While hidden the page reacts on the ~1Hz-throttled
// loop, so a one-shot getBoundingClientRect can catch a not-yet-laid-out element
// (mid-rerender — e.g. a server-loaded dropdown, or an input the page is
// re-rendering) → a 0-rect → the actuation errored ("trigger rect dead" / "could
// not focus input") on a single bad tick. Polling absorbs that transient; a
// genuinely-absent element still returns null after the ceiling (same safe
// outcome). Happy path is the first read (no added latency). All waiting is
// SW-side (cdpDelay), per the off-loop discipline.
const RECT_READY_CEILING_MS = 2500;
const RECT_READY_INTERVAL_MS = 150;
async function cdpRectReady(sel, scroll) {
  const start = Date.now();
  const deadline = start + RECT_READY_CEILING_MS;
  let rect = await cdpEval(cdpRectOf, sel, scroll);
  let polls = 0;
  while ((!rect || rect.w <= 0) && Date.now() < deadline) {
    await cdpDelay(RECT_READY_INTERVAL_MS);
    rect = await cdpEval(cdpRectOf, sel, scroll);
    polls++;
  }
  // Log ONLY when the retry engaged (a clean run stays silent) — makes the M29 fix
  // visible during live verification: "recovered" = a field that would have dropped.
  if (polls > 0) {
    const ok = rect && rect.w > 0;
    console.log("[ApplyPilot][CDP] rectReady", JSON.stringify(sel), ok ? `RECOVERED after ${Date.now() - start}ms / ${polls} polls` : `gave up after ${Date.now() - start}ms / ${polls} polls`);
  }
  return rect && rect.w > 0 ? rect : null;
}

// M29-style retry for a rect produced by an EVAL FN that scrolls-then-measures
// (Add/Delete buttons have no stable selector, so cdpRectReady's selector form
// can't be reused). Re-evals until a non-zero viewport box or the same ceiling.
async function cdpEvalRectReady(fn, ...args) {
  const deadline = Date.now() + RECT_READY_CEILING_MS;
  let rect = await cdpEval(fn, ...args);
  while ((!rect || rect.w <= 0) && Date.now() < deadline) {
    await cdpDelay(RECT_READY_INTERVAL_MS);
    rect = await cdpEval(fn, ...args);
  }
  return rect && rect.w > 0 ? rect : null;
}

function cdpReadTextState(wrapperSel, tag) {
  const w = document.querySelector(wrapperSel);
  const el = w && w.querySelector(tag || "input"); // M37: "textarea" for roleDescription; default "input"
  if (!el) return null;
  return { value: el.value, focused: document.activeElement === el };
}

// Read a specific input by a FULL composed selector (e.g. a date segment's
// dateSection*-input) — value + focused. Direct (not "first input in wrapper"),
// since a date wrapper holds several segment inputs (M34).
function cdpReadInputBySel(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  return { value: el.value, focused: document.activeElement === el };
}

function cdpFocusBySel(sel) {
  const el = document.querySelector(sel);
  if (!el || !el.focus) return false;
  el.focus();
  return document.activeElement === el;
}

// Dropdown state, fresh each call: trigger text + the aria-controls-scoped
// PORTALED option list + the aria-activedescendant highlight text.
function cdpReadDropdownState(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  const trigger = w && w.querySelector('button[aria-haspopup="listbox"]');
  if (!trigger) return null;
  const id = trigger.getAttribute("aria-controls");
  const lb = id ? document.getElementById(id) : null;
  const options = lb
    ? Array.from(lb.querySelectorAll('[role="option"]')).map((el) => ({
        text: (el.textContent || "").trim(),
        disabled: el.getAttribute("aria-disabled") === "true",
        selected: el.getAttribute("aria-selected") === "true"
      }))
    : [];
  const adFrom = (el) => (el && el.getAttribute && el.getAttribute("aria-activedescendant")) || null;
  const activeId = adFrom(document.activeElement) || adFrom(lb) || adFrom(trigger);
  const activeEl = activeId ? document.getElementById(activeId) : null;
  return {
    triggerText: trigger.textContent.trim(),
    // The TRIGGER's expanded state — the cheap "did the open-click actually open it?"
    // signal (independent of whether the option list has rendered yet). The driver's
    // open-retry gates on this: a raced no-op click never flips it to "true".
    ariaExpanded: trigger.getAttribute("aria-expanded"),
    listboxPresent: !!lb,
    optionCount: options.filter((o) => !o.disabled).length,
    options,
    activeText: activeEl ? (activeEl.textContent || "").trim() : null
  };
}

// scrollIntoView + rect of the dropdown's options[index] (FULL list index, same
// order as cdpReadDropdownState.options) — the last-resort coordinate click.
function cdpOptionRect(wrapperSel, index) {
  const w = document.querySelector(wrapperSel);
  const trigger = w && w.querySelector('button[aria-haspopup="listbox"]');
  if (!trigger) return null;
  const id = trigger.getAttribute("aria-controls");
  const lb = id ? document.getElementById(id) : null;
  if (!lb) return null;
  const el = Array.from(lb.querySelectorAll('[role="option"]'))[index];
  if (!el) return null;
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

// scrollIntoView + rect of the dropdown option whose trimmed text == `text`
// (M28 — TEXT-keyed, NOT index: sidesteps any scrape-order vs live-DOM-order drift
// from disabled/placeholder/separator rows). Scoped to the trigger's aria-controls
// listbox (same as cdpReadDropdownState, so chips / other listboxes are excluded);
// skips aria-disabled options (the "Select One" placeholder). `text` is itself a
// scraped option text, so an exact trimmed match resolves the same element.
function cdpDropdownOptionRectByText(wrapperSel, text) {
  const w = document.querySelector(wrapperSel);
  const trigger = w && w.querySelector('button[aria-haspopup="listbox"]');
  if (!trigger) return null;
  const id = trigger.getAttribute("aria-controls");
  const lb = id ? document.getElementById(id) : null;
  if (!lb) return null;
  const el = Array.from(lb.querySelectorAll('[role="option"]'))
    .find((o) => o.getAttribute("aria-disabled") !== "true" && (o.textContent || "").trim() === text);
  if (!el) return null;
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

function cdpReadRadioState(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  return Array.from(w.querySelectorAll('input[type="radio"]')).map((input) => {
    const lab = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    return { id: input.id, labelText: lab ? lab.textContent.trim() : "", checked: input.checked };
  });
}

// Best-effort: find a clearly-DISMISSIVE control (X / Close / No thanks — NEVER Accept/Agree/OK/Got it)
// inside the popup covering (cx,cy), so the walk can close it and proceed. Handles SHADOW-DOM overlays
// (Simplify renders into div.simplify-jobs-shadow-root → the X lives in host.shadowRoot, invisible to a
// light-DOM query) AND regular in-page modals. Read-only: returns the control's viewport rect for a TRUSTED
// click (or {found:false}). SAFETY: the affirmative deny-list is checked first so we never click a
// consent/accept button; if nothing clearly-dismissive is found we return not-found → the caller halts.
function cdpFindDismissControl(cx, cy) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const cs = win.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const host = document.elementFromPoint(cx, cy);
  if (!host) return { found: false };
  // Search root: an OPEN shadow root if the blocker is a shadow host (Simplify), else the blocker's own
  // subtree climbed to a dialog/overlay-ish ancestor (bounded). A CLOSED shadow root → shadowRoot is null →
  // we can't reach the X → not-found → safe halt.
  let root = host.shadowRoot || null;
  if (!root) {
    let el = host;
    for (let i = 0; i < 4 && el && el.parentElement; i++) {
      const role = el.getAttribute && el.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") break;
      el = el.parentElement;
    }
    root = el || host;
  }
  const AFFIRM = /accept|agree|\bok\b|okay|got\s*it|allow|\byes\b|confirm|continue|submit|\bsave\b|sign\s*up|subscribe|\bnext\b|enable|turn\s*on|autofill|\bapply\b/i;
  const X_GLYPH = /^(×|✕|✖|⨯|✗|x|╳|⤫|⤬)$/i;
  const DISMISS_TXT = /^(close|dismiss|no thanks|no,\s*thanks|not now|skip|maybe later|later)$/i;
  const DISMISS_META = /close|dismiss/i;
  // Candidates: interactive controls + common close-icon carriers (class*=close/dismiss, X-glyph spans/divs).
  const cand = Array.from(root.querySelectorAll('button, [role="button"], a[href], [aria-label], [title], [class*="close" i], [class*="dismiss" i], span, div, svg'));
  let best = null;
  for (const el of cand) {
    if (!isVisible(el)) continue;
    const meta = ((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || "").trim();
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (AFFIRM.test(meta) || AFFIRM.test(txt)) continue;          // never click a consent/affirmative control
    const cls = (el.className && typeof el.className === "string") ? el.className : "";
    const dismissive = DISMISS_META.test(meta) || DISMISS_TXT.test(txt) || X_GLYPH.test(txt) || /(^|[-_ ])(close|dismiss)([-_ ]|$)/i.test(cls);
    if (!dismissive) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 120 || r.height > 120) continue;                // skip big containers — target the small X/button, not the whole panel
    const score = r.width * r.height;                             // prefer the smallest (the icon)
    if (!best || score < best.score) best = { score, cx: r.left + r.width / 2, cy: r.top + r.height / 2, label: meta || txt || cls.slice(0, 40) };
  }
  return best ? { found: true, cx: best.cx, cy: best.cy, label: best.label } : { found: false };
}

// DIAG (2026-07-06): dump the blocking popup's structure so we can build a TARGETED dismiss. The auto-dismiss
// heuristic missed Simplify's X — we need to SEE the real shadow DOM (is the shadowRoot open? what/where is the
// close control?). Read-only. Logged by clickPageNext when a block is detected.
function cdpDumpBlocker(cx, cy) {
  const host = document.elementFromPoint(cx, cy);
  if (!host) return { host: null };
  const clsOf = (el) => (typeof el.className === "string" ? el.className : (el.className && el.className.baseVal) || "");
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const short = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const info = { hostTag: host.tagName.toLowerCase(), hostClass: clsOf(host).slice(0, 80), hostId: host.id || null,
    shadow: host.shadowRoot ? "OPEN" : "null-or-closed" };
  const root = host.shadowRoot || host;
  const all = Array.from(root.querySelectorAll("*"));
  info.totalEls = all.length;
  info.nestedShadowHosts = all.filter((el) => el.shadowRoot).slice(0, 10).map((el) => el.tagName.toLowerCase() + "." + (clsOf(el).split(/\s+/)[0] || ""));
  info.candidates = all.filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const tag = el.tagName.toLowerCase();
    const cls = clsOf(el);
    const aria = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    const txt = short(el.textContent);
    return tag === "button" || el.getAttribute("role") === "button" || tag === "svg" || tag === "path" || !!aria
      || /close|dismiss|hide|exit|cross/i.test(cls) || (txt.length <= 3 && /[×✕✖xX⨯╳]/.test(txt));
  }).slice(0, 50).map((el) => ({ tag: el.tagName.toLowerCase(), cls: clsOf(el).slice(0, 60),
    aria: el.getAttribute("aria-label") || el.getAttribute("title") || null, role: el.getAttribute("role") || null,
    text: short(el.textContent), rect: rectOf(el) }));
  return info;
}

function cdpReadCheckboxState(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  const input = w && w.querySelector('input[type="checkbox"]');
  if (!input) return null;
  return { inputId: input.id || null, checked: input.checked };
}

function cdpReadCheckedById(id) {
  const el = document.getElementById(id);
  return el ? el.checked : null;
}

function cdpFocusInputById(id) {
  const el = document.getElementById(id);
  if (!el || !el.focus) return false;
  el.focus();
  return document.activeElement === el;
}

// ── Typeahead reads (M25 recon + port) ──────────────────────────────────────

// Full typeahead state, fresh each call. Reports the option set through BOTH
// candidate scopes — the searchBox's aria-controls target AND the page-wide
// visible scrape (excluding selectedItem chips, the M22 settlePoll mirror) — so
// the build can pick the one that resolves REAL options (the spec warns source's
// aria-controls points at a promptAriaInstruction decoy; recon settles whether
// plain typeaheads share that). `sig` is a cheap set signature for SW-side
// transition detection (count + first/last texts).
function cdpReadTaState(wrapperSel) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  const sb = w.querySelector('input[data-automation-id="searchBox"]');
  const chips = Array.from(w.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => (c.textContent || "").trim());

  const acId = sb ? sb.getAttribute("aria-controls") : null;
  const acEl = acId ? document.getElementById(acId) : null;
  const acOpts = acEl
    ? Array.from(acEl.querySelectorAll('[role="option"]')).filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true")
    : [];
  const pwOpts = Array.from(document.querySelectorAll('[role="option"]'))
    .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true" && !el.closest('[data-automation-id="selectedItemList"]'));
  const texts = (els) => els.map((el) => (el.textContent || "").trim());
  const sig = (ts) => ts.length + "|" + ts.slice(0, 3).join("~") + "|" + ts.slice(-3).join("~");
  const acTexts = texts(acOpts);
  const pwTexts = texts(pwOpts);

  // Banner: the leaf-most visible node whose SHORT text is "No matches found"-ish
  // (recording its identity gives the build a precise selector).
  let banner = null;
  for (const el of document.querySelectorAll("[data-automation-id], [role], p, span, div")) {
    if (!isVisible(el)) continue;
    const t = (el.textContent || "").trim();
    if (t.length > 60 || !/no matches found/i.test(t)) continue;
    if (Array.from(el.children).some((c) => /no matches found/i.test((c.textContent || "").trim()))) continue;
    banner = { text: t, tag: el.tagName, automationId: el.getAttribute("data-automation-id"), role: el.getAttribute("role") };
    break;
  }

  // Results banner ("Search Results" — recon 2026-06-26): a VISIBLE promptTitle (the SAME host as the no-match
  // banner; text distinguishes them). The terminal-state gate uses resultsBanner + a stable non-zero
  // pageWide.count as the positive-match terminal — distinguishing a CONFIRMED results render from the
  // bannerless fallback-list-before-the-banner (the stray source). No count in the banner text (recon) → the
  // count comes from pageWide, not here.
  let resultsBanner = false;
  for (const el of document.querySelectorAll('[data-automation-id="promptTitle"]')) {
    if (isVisible(el) && /search results/i.test((el.textContent || "").trim())) { resultsBanner = true; break; }
  }

  const adFrom = (el) => (el && el.getAttribute && el.getAttribute("aria-activedescendant")) || null;
  const activeId = adFrom(document.activeElement) || adFrom(sb) || (acEl ? adFrom(acEl) : null);
  const activeEl = activeId ? document.getElementById(activeId) : null;

  return {
    searchBox: sb
      ? { present: true, visible: isVisible(sb), focused: document.activeElement === sb, value: sb.value }
      : { present: false, visible: false, focused: false, value: null },
    chips,
    banner,
    resultsBanner,
    ariaScope: acId
      ? (acEl
        ? { id: acId, resolved: true, tag: acEl.tagName, automationId: acEl.getAttribute("data-automation-id"), role: acEl.getAttribute("role"), count: acOpts.length, sig: sig(acTexts), sample: acTexts.slice(0, 10) }
        : { id: acId, resolved: false })
      : { id: null },
    // `sample` (10) is for log series; `texts` (40) feeds candidate matching —
    // filtered sets are small and even the virtualized fallback window is ~17.
    pageWide: { count: pwOpts.length, sig: sig(pwTexts), sample: pwTexts.slice(0, 10), texts: pwTexts.slice(0, 40) },
    activeText: activeEl ? (activeEl.textContent || "").trim() : null
  };
}

// RESULTS-BANNER RECON (read-only DOM dump) — capture the exact markup of BOTH typeahead banners so the
// terminal-state gate (next round) can distinguish them: the "No matches found" no-match banner (already
// detected) vs the "Search Results (N)" results banner (NOT currently surfaced anywhere). Dumps every visible
// promptTitle node (the likely host of both) + every short banner-ish text node (catches a non-promptTitle
// host) + the aria-controls listbox option count (the "N"). NO mutation / click / type / Enter — pure read.
function cdpResultsBannerScan(wrapperSel) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const w = document.querySelector(wrapperSel);
  if (!w) return { ok: false, error: "no wrapper" };
  const sb = w.querySelector('input[data-automation-id="searchBox"]');
  const chips = Array.from(w.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => (c.textContent || "").trim());
  const acId = sb ? sb.getAttribute("aria-controls") : null;
  const acEl = acId ? document.getElementById(acId) : null;
  const optionCount = acEl
    ? Array.from(acEl.querySelectorAll('[role="option"]')).filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true").length
    : 0;
  // Every visible promptTitle node (both banners are expected to render here).
  const promptTitles = Array.from(document.querySelectorAll('[data-automation-id="promptTitle"]'))
    .filter(isVisible)
    .map((el) => ({ text: (el.textContent || "").trim().slice(0, 80), automationId: el.getAttribute("data-automation-id"), role: el.getAttribute("role"), tag: el.tagName }));
  // Any short, leaf-most visible node whose text reads like a banner (catches a non-promptTitle host).
  const bannerish = [];
  for (const el of document.querySelectorAll("[data-automation-id], [role], p, span, h1, h2, h3, h4, div")) {
    if (!isVisible(el)) continue;
    const t = (el.textContent || "").trim();
    if (t.length > 60 || !/(search results|no matches|results?\s*\(|matches found|found)/i.test(t)) continue;
    if (Array.from(el.children).some((c) => /(search results|no matches|results?\s*\(|matches found|found)/i.test((c.textContent || "").trim()))) continue; // leaf-most only
    bannerish.push({ text: t, automationId: el.getAttribute("data-automation-id"), role: el.getAttribute("role"), tag: el.tagName });
    if (bannerish.length >= 12) break;
  }
  return {
    ok: true,
    searchBoxValue: sb ? sb.value : null,
    searchBoxVisible: sb ? isVisible(sb) : false,
    focused: document.activeElement === sb,
    chips,
    optionCount,
    ariaControls: acId,
    promptTitles,
    bannerish
  };
}

// FoS option CAPTURE (Round 2): scroll-accumulate a VIRTUALIZED typeahead's full option list,
// FAST + safe. Runs ENTIRELY in-page (one cdpEval, awaitPromise) → frame-paced via rAF, NO per-step
// SW round-trips, so it finishes in well under a second (a manual scroll is ~1s). READ-ONLY: it
// only sets scrollTop + reads [role="option"] text — NO click / type / Enter / arrow, so no listbox
// highlight ever arms (FoS is the stray-prone field). Returns the de-duped, in-order option list +
// scroll metrics so the SW can confirm the bottom was reached (complete) vs a cap hit (truncated).
async function cdpScrapeTaOptions(wrapperSel) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const w = document.querySelector(wrapperSel);
  if (!w) return { ok: false, error: "no wrapper" };
  const sb = w.querySelector('input[data-automation-id="searchBox"]');
  const acId = sb ? sb.getAttribute("aria-controls") : null;
  const acEl = acId ? document.getElementById(acId) : null;
  // rAF races a setTimeout fallback so a loop never HANGS on a hidden tab (frozen rAF). Used both to WAIT
  // for the list to render (below) and to pace the virtualizer between scroll steps (see doScroll).
  const frame = () => new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => requestAnimationFrame(fin)); setTimeout(fin, 250); });
  const labelOf = (el) => (el.getAttribute && el.getAttribute("data-automation-label")) || (el.textContent || "").trim();
  // A REAL option leaf: visible, not the disabled placeholder, and NOT a selectedItem CHIP. Chips carry
  // role="option" markup too (the documented chip-contamination), so they must NEVER count as options — else
  // a prefilled field's chip alone locks the selector + masks the real list (countryPhoneCode diag 2026-07-06:
  // role=2/prompt=2 were the 2 CHIPS, 0 real leaves).
  const nonChip = (el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true" && !el.closest('[data-automation-id="selectedItemList"]');
  // Leaves are role=option on most tenants, promptOption-only on some (the divergence cdpReadHierState handles).
  const OPT_SELECTORS = ['[role="option"]', '[data-automation-id="promptOption"]'];
  const optsFor = (sel) => { const scope = (acEl && acEl.querySelector(sel)) ? acEl : document; return Array.from(scope.querySelectorAll(sel)).filter(nonChip); };
  const bannerUp = () => Array.from(document.querySelectorAll('[data-automation-id="promptTitle"]'))
    .some((el) => isVisible(el) && /no matches found/i.test((el.textContent || "").trim()));
  // WAIT for the list to render, then pick the selector that finds REAL (non-chip) leaves. The searchBox
  // becomes visible a beat BEFORE the virtualized rows mount, so an immediate read finds only chips (0 real)
  // — that was the countryPhoneCode 0-options bug. Frame-poll until non-chip leaves appear (or a no-match
  // banner, or a ~24-frame ceiling). FoS is already rendered when scraped mid-fill → resolves at frame 0.
  const pickSel = () => OPT_SELECTORS.find((sel) => optsFor(sel).length) || null;
  let optSel = pickSel();
  for (let i = 0; i < 24 && !optSel && !bannerUp(); i++) { await frame(); optSel = pickSel(); }
  optSel = optSel || '[role="option"]';
  const roleCount = optsFor('[role="option"]').length;                       // non-chip counts (diagnostic)
  const promptCount = optsFor('[data-automation-id="promptOption"]').length;
  const curOpts = () => optsFor(optSel);
  // Scroll container = the nearest scrollable ancestor of an option (overflow-y auto/scroll +
  // scrollHeight > clientHeight); fall back to acEl / the option's parent.
  const findScroller = () => {
    let el = curOpts()[0] || acEl;
    for (let i = 0; i < 8 && el; i++) {
      const cs = window.getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(cs.overflowY)) return el;
      el = el.parentElement;
    }
    return (acEl && acEl.scrollHeight > acEl.clientHeight) ? acEl : null;
  };
  const seen = new Map(); // text -> first-seen order (de-dupe, preserve order)
  const curSig = () => { let s = ""; for (const o of curOpts()) s += labelOf(o) + ""; return s; }; // signature of the CURRENTLY-mounted window (change = a new window committed); labelOf to match collect
  const collect = () => { for (const o of curOpts()) { const t = labelOf(o); if (t && !seen.has(t)) seen.set(t, seen.size); } };
  const sc = findScroller();
  // THE fix (diag 2026-07-05): a programmatic scrollTop does NOT drive a react virtualizer's row re-render on
  // a HIDDEN tab — the mounted set stayed a FROZEN 17 rows → the FoS list truncated to the on-open window.
  // Firing an explicit 'scroll' after each set makes the virtualizer mount the new window even hidden
  // (live-verified: 65/65 options, seen-count climbs with scrollTop).
  const doScroll = (top) => { if (!sc) return; sc.scrollTop = top; try { sc.dispatchEvent(new Event("scroll", { bubbles: true })); } catch (e) {} };
  // FASTER per-step wait (2026-07-06): poll single frames until the mounted set actually CHANGES (React
  // committed the just-scrolled window) — breaks at ~1 frame on the common steps (≈2× the old fixed
  // double-rAF), capped at 3 (≈ the old worst case, so NEVER slower and safe for a slow commit). The
  // sig-change IS the mount signal, so this reads a COMMITTED window — it can't advance before the mount, so
  // it can't re-truncate; overlap + de-dup + stable-2-at-bottom still backstop completeness.
  const awaitRender = async (beforeSig) => { for (let i = 0; i < 3; i++) { await frame(); if (curSig() !== beforeSig) return; } };
  // Measure the CURRENTLY-mounted window's pixel span (viewport + the virtualizer's overscan, typically
  // 2–3× clientHeight). Stepping by a fraction of THIS (not the viewport) means far fewer hops to the bottom
  // — the big visible-scroll speedup — while self-adapting to the tenant's overscan. Falls back to clientHeight.
  const mountedSpan = () => {
    const els = curOpts();
    if (!sc || els.length < 2) return sc ? sc.clientHeight : 0;
    let top = Infinity, bottom = -Infinity;
    for (const e of els) { const r = e.getBoundingClientRect(); if (r.top < top) top = r.top; if (r.bottom > bottom) bottom = r.bottom; }
    return Math.max(sc.clientHeight, bottom - top);
  };
  collect();
  let steps = 0, stable = 0, atBottom = false;
  const MAX_STEPS = 80; // safety bound (far more than the ~4–8 mounted-span hops a real list needs)
  if (sc) {
    doScroll(0); await frame(); collect();
    let priorSig = curSig();
    while (steps < MAX_STEPS) {
      const before = seen.size;
      const prevTop = sc.scrollTop;
      // Hop by 0.6× the mounted-window span → ~40% overlap between consecutive windows, so no row is skipped
      // even if the span is mis-measured by up to 40% (a big safety margin; de-dup + stable-2 still backstop).
      const inc = Math.max(60, Math.floor(mountedSpan() * 0.6));
      doScroll(Math.min(sc.scrollTop + inc, sc.scrollHeight));
      await awaitRender(priorSig);
      priorSig = curSig();
      collect();
      steps++;
      atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      const movedNothing = sc.scrollTop === prevTop;
      if (seen.size === before && (atBottom || movedNothing)) { if (++stable >= 2) break; } else stable = 0;
    }
  }
  const options = Array.from(seen.keys());
  return { ok: true, options, count: options.length, steps, atBottom, cappedOut: steps >= MAX_STEPS,
    roleCount, promptCount, usedSel: optSel,
    scrollerFound: !!sc, scrollTop: sc ? sc.scrollTop : null, scrollHeight: sc ? sc.scrollHeight : null, clientHeight: sc ? sc.clientHeight : null };
}

// Scroll-accumulate the source promptOption LABELS — a VIRTUALIZED list needs scrolling to enumerate EVERY
// option. On the on-open / no-match-fallback view these labels are the CATEGORIES; after a drill they're the
// drilled category's LEAVES (the brain distinguishes by TIMING, not isCategory — the source chevron lives on
// the sibling [role=option] menuItem, NOT the promptOption, so isCategory-on-promptOption is always false).
// Reads data-automation-id="promptOption" — NOT role="option" (source's role=option is the TRUNCATED menuItem
// dup; cdpScrapeTaOptions is for the flat FoS typeahead). Also returns `banner` = the current promptTitle text
// ("No matches found" on the fallback; the CLICKED CATEGORY NAME once drilled — the drill-confirmation signal).
// Mirrors cdpScrapeTaOptions's scroll loop; resets scrollTop to 0 at the end so early rows are mounted for a
// subsequent category click. Async — awaited via cdpEval.
async function cdpScrapeSourceRows(wrapperSel, debug) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const leafLabel = (el) => el.getAttribute("data-automation-label") || (el.textContent || "").trim();
  const w = document.querySelector(wrapperSel);
  if (!w) return { ok: false, error: "no wrapper" };
  const optSel = '[data-automation-id="promptOption"]';
  const curOpts = () => Array.from(document.querySelectorAll(optSel))
    .filter((el) => isVisible(el) && !el.closest('[data-automation-id="selectedItemList"]'));
  const findScroller = () => {
    let el = curOpts()[0];
    for (let i = 0; i < 8 && el; i++) {
      const cs = window.getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(cs.overflowY)) return el;
      el = el.parentElement;
    }
    return null;
  };
  // rAF paces the virtualizer's paint when VISIBLE (fast); a hidden tab FREEZES rAF, so race a setTimeout
  // (throttled to ~1Hz when hidden) — without the fallback this scroll loop would HANG on a hidden tab.
  const frame = () => new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => requestAnimationFrame(fin)); setTimeout(fin, 250); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Per-step settle: one frame lets the virtualizer render the just-scrolled window before we read (the
  // fix is doScroll below, not the settle length). DEFAULT (debug OFF) = one frame; the +120ms is DEBUG-ONLY
  // so the operator can WATCH the scroll when "Debug: log keystrokes" is checked.
  const stepSettle = async () => { await frame(); if (debug) await sleep(120); };
  const seen = new Map(); // label → order (first-seen, de-dupe within ONE view)
  const collect = () => { for (const o of curOpts()) { const t = leafLabel(o); if (t && !seen.has(t)) seen.set(t, seen.size); } };
  const sc = findScroller();
  // THE fix (diag 2026-07-05): a programmatic scrollTop does NOT drive the virtualizer's row re-render on a
  // HIDDEN tab (mounted set stayed frozen while scrollTop climbed → enumeration truncated to the on-open
  // window). Fire an explicit 'scroll' after each set so the virtualizer mounts the new window even hidden.
  const doScroll = (top) => { if (!sc) return; sc.scrollTop = top; try { sc.dispatchEvent(new Event("scroll", { bubbles: true })); } catch (e) {} };
  let steps = 0, stable = 0, atBottom = false;
  const MAX_STEPS = 60;
  collect();
  if (sc) {
    // OVERLAPPING scroll: a virtualizer mounts rows only after a scroll settles → step ~0.8 window (overlap,
    // no row skipped). Pacing is via stepSettle (one frame; +120ms only in debug; hidden-safe setTimeout).
    const step = Math.max(Math.floor(sc.clientHeight * 0.8), 60);
    doScroll(0); await stepSettle(); collect();
    while (steps < MAX_STEPS) {
      const before = seen.size;
      const prevTop = sc.scrollTop;
      doScroll(Math.min(sc.scrollTop + step, sc.scrollHeight));
      await stepSettle(); collect();
      steps++;
      atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      const movedNothing = sc.scrollTop === prevTop;
      if (seen.size === before && (atBottom || movedNothing)) { if (++stable >= 2) break; } else stable = 0;
    }
    doScroll(0); await frame(); // back to top so early rows are mounted for a subsequent category click
  }
  // banner = the current promptTitle text (drill-confirmation: the clicked category name once drilled).
  let banner = "";
  for (const el of document.querySelectorAll('[data-automation-id="promptTitle"]')) {
    if (!isVisible(el)) continue;
    const t = (el.textContent || "").trim();
    if (t) { banner = t; break; }
  }
  return { ok: true, options: Array.from(seen.keys()), banner, count: seen.size, steps, atBottom };
}

// READ-ONLY recon (source-AI debug): dump every visible element whose label matches `label`, across the
// source rows (role=option / treeitem / promptOption), with the attrs that decide HOW to click a category —
// is it a drillable role=option (chevron / aria-expanded) or only a promptOption label? Tells us why
// expandCategory (role=option-only) missed it on the no-match fallback view.
function cdpSourceRowProbe(label) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(label);
  const out = [];
  for (const el of document.querySelectorAll('[role="option"],[role="treeitem"],[data-automation-id="promptOption"]')) {
    const txt = norm(el.textContent), dal = norm(el.getAttribute("data-automation-label"));
    if (!(txt === want || txt.indexOf(want) === 0 || dal === want)) continue;
    const r = el.getBoundingClientRect();
    out.push({
      tag: el.tagName, role: el.getAttribute("role"), automationId: el.getAttribute("data-automation-id"),
      dataLabel: el.getAttribute("data-automation-label"), text: (el.textContent || "").trim().slice(0, 50),
      ariaExpanded: el.getAttribute("aria-expanded"), ariaHaspopup: el.getAttribute("aria-haspopup"),
      hasChevron: !!el.querySelector('svg, [data-automation-id*="chevron" i], [class*="chevron" i]'),
      visible: isVisible(el), rectW: Math.round(r.width), rectH: Math.round(r.height),
      inSelectedList: !!el.closest('[data-automation-id="selectedItemList"]')
    });
    if (out.length >= 12) break;
  }
  return { want, count: out.length, matches: out };
}

// Scroll-to-FIND a source category/row by label in the react-virtualized listbox (only ~10 rows mounted; NO
// snap-back — live browser-diag 2026-06-28), and return the rect of its **promptLeafNode** — the node that
// carries the onClick/DRILL handler. NOT `menuItem`/role=option (handlers: mouseover/contextmenu, NO onClick)
// and NOT `promptOption` (text only, no handlers). The caller TRUSTED-clicks that rect. CRITICAL ORDER:
// scroll the container → **SETTLE ~350ms** (let react-virtualized finish recycling so the mounted rows are
// STABLE) → **RE-QUERY fresh** → read the LIVE rect. Do NOT `scrollIntoView` — it fires another onScroll →
// the row recycles → the rect points at a detached node (the live "click misses / doesn't drill"). Match the
// promptOption's label (data-automation-label / textContent), excluding selectedItemList chips. Async.
async function cdpSourceRowRect(label) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(label);
  // The deepest LABEL node (promptOption); the drill handler is on its promptLeafNode ancestor.
  const matchPO = () => Array.from(document.querySelectorAll('[data-automation-id="promptOption"]'))
    .filter((o) => isVisible(o) && !o.closest('[data-automation-id="selectedItemList"]'))
    .find((o) => { const t = norm(o.textContent), d = norm(o.getAttribute("data-automation-label")); return t === want || t.indexOf(want) === 0 || d === want; });
  const leafOf = (po) => (po && (po.closest('[data-automation-id="promptLeafNode"]') || po)) || null;
  const findScroller = () => {
    // From a DROPDOWN promptOption (identical to cdpScrapeSourceRows's curOpts), excluding selectedItemList —
    // a committed chip embeds a promptOption FIRST in document order; without the exclusion findScroller
    // started from the chip's (non-scrollable) subtree → null → never scrolled (live scrollerFound:false).
    let el = Array.from(document.querySelectorAll('[data-automation-id="promptOption"]')).filter((o) => isVisible(o) && !o.closest('[data-automation-id="selectedItemList"]'))[0];
    for (let i = 0; i < 8 && el; i++) {
      const cs = window.getComputedStyle(el);
      if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(cs.overflowY)) return el;
      el = el.parentElement;
    }
    return null;
  };
  // rAF is fast when VISIBLE but FREEZES on a hidden tab, so race a setTimeout fallback (throttled to ~1Hz
  // when hidden) — without it this scroll-to-find/click loop would HANG when hidden.
  const frame = () => new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => requestAnimationFrame(fin)); setTimeout(fin, 250); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Is the leaf's center inside the CLICKABLE viewport AND not occluded? CDP's Input.dispatchMouseEvent uses
  // VIEWPORT coords, so a row with cy > innerHeight is unclickable even when it's mounted + "visible" + inside
  // the inner scroller's own band — the dropdown panel extends past the fold (live browser-diag 2026-06-28).
  const inClickableViewport = (leaf) => {
    const rr = leaf.getBoundingClientRect();
    const cx = rr.x + rr.width / 2, cy = rr.y + rr.height / 2;
    if (cy < 0 || cy > window.innerHeight || cx < 0 || cx > window.innerWidth) return false;
    const hit = document.elementFromPoint(Math.round(cx), Math.round(cy));
    return !!(hit && hit.closest('[data-automation-id="promptLeafNode"]') === leaf);
  };
  // 1. Find the target promptOption. react-virtualized usually MOUNTS it (clipped below the fold) so matchPO
  //    finds it immediately; only if truly unmounted does a small bounded inner-list scroll mount it.
  let po = matchPO();
  if (!po) {
    const sc = findScroller();
    if (sc) {
      const step = Math.max(Math.floor(sc.clientHeight * 0.8), 60);
      sc.scrollTop = 0; await frame(); await sleep(120); po = matchPO();
      for (let i = 0; !po && i < 20; i++) {
        const prev = sc.scrollTop;
        sc.scrollTop = Math.min(sc.scrollTop + step, sc.scrollHeight);
        await frame(); await sleep(120); po = matchPO();
        if (sc.scrollTop === prev) break; // bottom
      }
    }
  }
  if (!po) {
    const sampleLabels = Array.from(document.querySelectorAll('[data-automation-id="promptOption"]'))
      .filter((o) => isVisible(o) && !o.closest('[data-automation-id="selectedItemList"]'))
      .slice(0, 20).map((o) => o.getAttribute("data-automation-label") || (o.textContent || "").trim());
    return { found: false, reason: "no-match", sampleLabels };
  }
  // 2. Bring the leaf's center INTO the clickable viewport. scrollIntoView scrolls the page + ancestors (the
  //    panel reaches below innerHeight, so the inner scroll alone can't put it on-screen). Re-query after each
  //    settle (scroll recycles the virtualized rows); validate with elementFromPoint before trusting the rect.
  //    One-shot scrollIntoView converges in 1–2 iters — NOT a 40×150ms loop (that risks the eval timeout).
  let leaf = leafOf(po);
  for (let i = 0; i < 12 && leaf && !inClickableViewport(leaf); i++) {
    leaf.scrollIntoView({ block: "center", behavior: "instant" });
    await frame(); await sleep(150);
    po = matchPO(); leaf = leafOf(po);
  }
  if (!leaf) return { found: false, reason: "recycled" };
  if (!inClickableViewport(leaf)) {
    const r0 = leaf.getBoundingClientRect();
    return { found: false, reason: "off-viewport", cy: Math.round(r0.y + r0.height / 2), innerHeight: window.innerHeight };
  }
  const r = leaf.getBoundingClientRect();
  return { found: true, automationId: leaf.getAttribute("data-automation-id"), tag: leaf.tagName, role: leaf.getAttribute("role"),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) } };
}

// scrollIntoView + fresh rect of the VISIBLE [role="option"] whose trimmed text
// equals `text` (chip lists excluded — same scrape rules as cdpReadTaState's
// page-wide scope). Text-keyed, not index-keyed.
function cdpTaOptionRectByText(text) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const el = Array.from(document.querySelectorAll('[role="option"]'))
    .filter((o) => isVisible(o) && o.getAttribute("aria-disabled") !== "true" && !o.closest('[data-automation-id="selectedItemList"]'))
    .find((o) => (o.textContent || "").trim() === text);
  if (!el) return null;
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

// READ-ONLY dump of the selected-chip subtree (tag/automation-id/role/text per
// node, capped) — identifies the chip's delete control for a FUTURE overwrite
// milestone. Never clicks anything.
function cdpDumpChipSubtree(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  const root = w && (w.querySelector('[data-automation-id="selectedItemList"]') || w.querySelector('[data-automation-id="selectedItem"]'));
  if (!root) return null;
  const out = [];
  const walk = (el, depth) => {
    if (out.length >= 40 || depth > 6) return;
    out.push({
      depth,
      tag: el.tagName,
      automationId: el.getAttribute("data-automation-id"),
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      text: (el.textContent || "").trim().slice(0, 40)
    });
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

// ── Source / tree picker reads (backlog C recon) ────────────────────────────
// The hierarchical "How did you hear about us?" picker. Self-contained reads
// for the discover-and-trace recon; mirrors the node-detection of the in-tree
// page-substrate fillSource (background.js). NOT the production fill.

// Full source-field state, fresh each call. Reports: the searchBox (present/
// visible/focused/value + its aria-controls target id and what that resolves
// to — the DECOY check), the page-wide VISIBLE promptOption leaves (w/
// data-automation-label — the real result leaves on the search path), the
// [role=option]/[role=treeitem] rows classified category-vs-leaf (the
// expand-walk shape), any selectedItem chip, and the "No matches" banner.
function cdpReadSourceState(wrapperSel) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  const sb = w.querySelector('input[data-automation-id="searchBox"]');

  // aria-controls DECOY check: what does the searchBox's aria-controls resolve to?
  let ariaControls = null;
  if (sb) {
    const acId = sb.getAttribute("aria-controls");
    const acEl = acId ? document.getElementById(acId) : null;
    ariaControls = {
      id: acId || null,
      resolved: !!acEl,
      tag: acEl ? acEl.tagName : null,
      automationId: acEl ? acEl.getAttribute("data-automation-id") : null,
      role: acEl ? acEl.getAttribute("role") : null,
      optionCountUnder: acEl ? acEl.querySelectorAll('[role="option"],[data-automation-id="promptOption"]').length : null
    };
  }

  // Category vs leaf — mirror the in-tree fillSource isCategory heuristics. (The merge briefly dropped the
  // svg/chevron clause on a "side-charm" reading, but live evidence 2026-06-28 [source AI: "College/University"
  // is a DRILLABLE category] proved cert + source DO have categories you click to drill — so it's restored.
  // The source AI uses the scrape-based drill, NOT this; this gates the cert tree path's readTreeCategories.)
  const isCategory = (el) =>
    el.hasAttribute("aria-expanded") || el.hasAttribute("aria-haspopup") ||
    !!el.querySelector('svg, [data-automation-id*="chevron" i], [class*="chevron" i]') ||
    (el.getAttribute("role") === "treeitem" && el.hasAttribute("aria-level"));
  const nodeInfo = (el) => ({
    tag: el.tagName,
    role: el.getAttribute("role"),
    automationId: el.getAttribute("data-automation-id"),
    label: el.getAttribute("data-automation-label") || (el.textContent || "").trim().slice(0, 50),
    ariaExpanded: el.getAttribute("aria-expanded"),
    ariaLevel: el.getAttribute("aria-level"),
    ariaSelected: el.getAttribute("aria-selected"),
    isCategory: isCategory(el),
    hasChevron: !!el.querySelector('svg, [data-automation-id*="chevron" i], [class*="chevron" i]')
  });

  // The search-path result leaves: page-wide VISIBLE promptOption (NOT role=option),
  // EXCLUDING selectedItemList chips — a committed chip elsewhere (e.g. countryPhoneCode
  // "United States of America (+1)") embeds a promptOption P and otherwise contaminates
  // this scrape (M14.1/M22 lesson; observed live in source recon Phase A).
  const promptOptions = Array.from(document.querySelectorAll('[data-automation-id="promptOption"]'))
    .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true"
      && !el.closest('[data-automation-id="selectedItemList"]'));
  // The expand-walk rows: role=option / role=treeitem (visible, enabled).
  const rows = Array.from(document.querySelectorAll('[role="option"],[role="treeitem"]'))
    .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true"
      && !el.closest('[data-automation-id="selectedItemList"]'));

  // Banner (same promptTitle leaf as the typeahead).
  let banner = null;
  for (const el of document.querySelectorAll('[data-automation-id="promptTitle"], [role], p, span, div')) {
    if (!isVisible(el)) continue;
    const t = (el.textContent || "").trim();
    if (t.length > 60 || !/no matches found/i.test(t)) continue;
    if (Array.from(el.children).some((c) => /no matches found/i.test((c.textContent || "").trim()))) continue;
    banner = { text: t, automationId: el.getAttribute("data-automation-id") }; break;
  }

  return {
    searchBox: sb
      ? { present: true, visible: isVisible(sb), focused: document.activeElement === sb, value: sb.value, ariaControls }
      : { present: false, ariaControls: null },
    promptOptionCount: promptOptions.length,
    promptOptions: promptOptions.slice(0, 30).map(nodeInfo),
    rowCount: rows.length,
    rows: rows.slice(0, 30).map(nodeInfo),
    chips: Array.from(w.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => (c.textContent || "").trim()),
    banner
  };
}

// GENERIC page-identity dump (read-only) — for IDENTIFYING an unknown page state (maintenance / dead
// session / login / error / a normal form) so future code can detect it instead of reporting an opaque
// "unknown error". Captures title / URL / nav status / heading / body-text sample / the distinct
// data-automation-id set / headings / metas + boolean state markers. NO actuation, NO field changes.
function cdpPageIdentityDump() {
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const bodyText = norm(document.body ? document.body.innerText : "");
  const lower = bodyText.toLowerCase();
  // distinct data-automation-id values + counts (capped) — the structural fingerprint of the page.
  const aidCounts = {};
  for (const el of document.querySelectorAll("[data-automation-id]")) {
    const a = el.getAttribute("data-automation-id");
    if (a) aidCounts[a] = (aidCounts[a] || 0) + 1;
  }
  const automationIds = Object.keys(aidCounts).slice(0, 80).map((k) => ({ id: k, n: aidCounts[k] }));
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']")).slice(0, 12)
    .map((h) => ({ tag: h.tagName, text: norm(h.textContent).slice(0, 160) }));
  const metas = Array.from(document.querySelectorAll("meta[name],meta[http-equiv],meta[property]")).slice(0, 24)
    .map((m) => ({ k: m.getAttribute("name") || m.getAttribute("http-equiv") || m.getAttribute("property"), v: norm(m.getAttribute("content")).slice(0, 140) }));
  let httpStatusFromNav = null;
  try { const nav = performance.getEntriesByType("navigation")[0]; if (nav && typeof nav.responseStatus === "number") httpStatusFromNav = nav.responseStatus; } catch (e) { /* not available */ }
  const hasPasswordField = !!document.querySelector('input[type="password"]');
  const formFieldCount = document.querySelectorAll('[data-automation-id^="formField-"]').length;
  return {
    url: location.href,
    host: location.hostname,
    title: document.title,
    readyState: document.readyState,
    httpStatusFromNav,
    formFieldCount,
    hasPasswordField,
    automationIdCount: Object.keys(aidCounts).length,
    automationIds,
    headings,
    metas,
    bodyClass: document.body ? norm(document.body.className).slice(0, 200) : null,
    bodyTextSample: bodyText.slice(0, 2000),
    // candidate state markers (heuristics — captured so we can pick the most reliable one for a detector).
    markers: {
      maintenance: /performing (planned )?maintenance|under maintenance|scheduled maintenance|check back later|temporarily unavailable/.test(lower),
      apology: /we apologize for the inconvenience/.test(lower),
      workdayAdmin: /workday administrator/.test(lower),
      login: hasPasswordField || /\b(sign in|log in|log on|username|password)\b/.test(lower),
      vpsError: /error code:\s*vps/i.test(bodyText),
      sessionExpired: /session (has )?(expired|timed out)|your session has/.test(lower),
      noForm: formFieldCount === 0
    }
  };
}

// Locate a source LEAF by label/text (promptOption preferred, then role rows),
// scrollIntoView, return its fresh rect + selected-state markers on its
// enclosing multiselectlistitem wrapper (the commit-signal attributes that
// EXIST — read-only, no click). For the Phase-A "what would confirm a commit".
function cdpSourceLeafProbe(label) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(label);
  const leafLabel = (el) => el.getAttribute("data-automation-label") || (el.textContent || "").trim();
  let el = Array.from(document.querySelectorAll('[data-automation-id="promptOption"]'))
    .filter((o) => isVisible(o) && !o.closest('[data-automation-id="selectedItemList"]')) // exclude chip contaminants
    .find((o) => norm(leafLabel(o)) === want);
  if (!el) el = Array.from(document.querySelectorAll('[role="option"],[role="treeitem"]'))
    .filter((o) => isVisible(o) && !o.closest('[data-automation-id="selectedItemList"]'))
    .find((o) => norm(o.textContent) === want);
  if (!el) return { found: false };
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const wrap = el.closest('[data-uxi-multiselectlistitem-isselected],[data-automation-id*="multiselectlistitem" i],[data-automation-id*="promptLeafNode" i]');
  return {
    found: true,
    matchedLabel: leafLabel(el),
    automationId: el.getAttribute("data-automation-id"),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
            cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) },
    rectLive: r.width > 0 && r.height > 0,
    commitWrapper: wrap ? {
      automationId: wrap.getAttribute("data-automation-id"),
      hasIsSelectedAttr: wrap.hasAttribute("data-uxi-multiselectlistitem-isselected"),
      isSelectedValue: wrap.getAttribute("data-uxi-multiselectlistitem-isselected"),
      ariaSelected: wrap.getAttribute("aria-selected")
    } : null
  };
}

// LEAN source read for the fill brain (fillSourceCdp): searchBox state, the
// chip-excluded VISIBLE promptOption leaves (label = data-automation-label||text)
// + a set signature for transition detection, the "No matches" banner, and any
// committed chips. (cdpReadSourceState is the verbose recon variant.)
function cdpReadSourcePick(wrapperSel) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  const sb = w.querySelector('input[data-automation-id="searchBox"]');
  const leafLabel = (el) => el.getAttribute("data-automation-label") || (el.textContent || "").trim();
  const leaves = Array.from(document.querySelectorAll('[data-automation-id="promptOption"]'))
    .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true"
      && !el.closest('[data-automation-id="selectedItemList"]'))
    .map(leafLabel);
  const sig = leaves.length + "|" + leaves.slice(0, 3).join("~") + "|" + leaves.slice(-3).join("~");
  let banner = false, resultsBanner = false;
  for (const el of document.querySelectorAll('[data-automation-id="promptTitle"]')) {
    if (!isVisible(el)) continue;
    const t = (el.textContent || "").trim();
    if (/no matches found/i.test(t)) banner = true;
    // Results banner — INFERRED from the typeahead recon (source uses the SAME promptPopup; its no-match
    // banner is already promptTitle-scoped). Confirmed by the source live-verify; if source never shows it,
    // awaitListTerminal times out → needs_review (safe — source commits via an explicit clickSourceLeaf).
    else if (/search results/i.test(t)) resultsBanner = true;
  }
  return {
    searchBox: sb
      ? { present: true, visible: isVisible(sb), focused: document.activeElement === sb, value: sb.value }
      : { present: false, visible: false, focused: false, value: null },
    leaves, leafCount: leaves.length, sig, banner, resultsBanner,
    chips: Array.from(w.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => (c.textContent || "").trim())
  };
}

// ── Unified hierarchical-typeahead read (merge 2026-06-28) ──────────────────────────────────────
// The Certification typeahead (My Experience) and "How did you hear about us?" (My Information) are the
// SAME Workday multiselect prompt component (operator recon 2026-06-28). This ONE reader serves the merged
// filler for both — superseding cdpReadTaState ([role=option]/textContent + aria-controls, which is NULL on
// both widgets) and cdpReadSourcePick for the FILL path. Both legacy readers stay for the recon harnesses.
//   • Options = the page-wide VISIBLE promptOption leaves (label = data-automation-label || textContent),
//     chip-excluded (a committed chip elsewhere embeds a promptOption → contamination).
//   • SCOPE by data-uxi-multiselect-id — the reliable join key, stamped on the searchBox AND every
//     promptLeafNode (recon). DEFENSIVE page-wide fallback when the id is absent (both observed widgets
//     carry it, so this branch is belt-and-suspenders, not a real case).
//   • Returns the typeahead-compatible `pageWide` shape (so the shared filler reads it unchanged) PLUS
//     `leaves`/`leafCount` aliases (the source loop's shape) + `activeText` (aria-activedescendant) +
//     `banner`/`resultsBanner` (both on the SAME promptTitle host; text distinguishes them — recon 2026-06-26).
function cdpReadHierState(wrapperSel) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  const sb = w.querySelector('input[data-automation-id="searchBox"]');
  const msId = sb ? sb.getAttribute("data-uxi-multiselect-id") : null;
  const leafLabel = (el) => el.getAttribute("data-automation-label") || (el.textContent || "").trim();
  // Resolve the option-label nodes. msId-scoped promptLeafNodes (robust if a 2nd widget is open); the inner
  // promptOption carries the label. Defensive page-wide promptOption fallback when msId is absent.
  let texts;
  if (msId) {
    const esc = (window.CSS && CSS.escape) ? CSS.escape(msId) : msId.replace(/"/g, '\\"');
    texts = Array.from(document.querySelectorAll('[data-uxi-multiselect-id="' + esc + '"][data-automation-id="promptLeafNode"]'))
      .filter((ln) => isVisible(ln) && ln.getAttribute("aria-disabled") !== "true" && !ln.closest('[data-automation-id="selectedItemList"]'))
      .map((ln) => leafLabel(ln.querySelector('[data-automation-id="promptOption"]') || ln));
  } else {
    texts = Array.from(document.querySelectorAll('[data-automation-id="promptOption"]'))
      .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true" && !el.closest('[data-automation-id="selectedItemList"]'))
      .map(leafLabel);
  }
  const sig = texts.length + "|" + texts.slice(0, 3).join("~") + "|" + texts.slice(-3).join("~");
  // Banner + results banner: both live on a VISIBLE promptTitle (recon 2026-06-26), text-distinguished.
  let banner = null, resultsBanner = false;
  for (const el of document.querySelectorAll('[data-automation-id="promptTitle"]')) {
    if (!isVisible(el)) continue;
    const t = (el.textContent || "").trim();
    if (/no matches found/i.test(t)) banner = { text: t, automationId: "promptTitle" };
    else if (/search results/i.test(t)) resultsBanner = true;
  }
  const chips = Array.from(w.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => (c.textContent || "").trim());
  const adFrom = (el) => (el && el.getAttribute && el.getAttribute("aria-activedescendant")) || null;
  const activeId = adFrom(document.activeElement) || adFrom(sb);
  const activeEl = activeId ? document.getElementById(activeId) : null;
  return {
    searchBox: sb
      ? { present: true, visible: isVisible(sb), focused: document.activeElement === sb, value: sb.value }
      : { present: false, visible: false, focused: false, value: null },
    chips, banner, resultsBanner, msId: msId || null,
    pageWide: { count: texts.length, sig, sample: texts.slice(0, 10), texts: texts.slice(0, 40) },
    leaves: texts.slice(0, 40), leafCount: texts.length,
    activeText: activeEl ? (activeEl.textContent || "").trim() : null
  };
}

// Expand a category node by label (trusted-click its rect) — the non-committing
// drill probe (Q4). Returns the rect clicked, or {found:false}.
function cdpSourceCategoryRect(label) {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(label);
  const el = Array.from(document.querySelectorAll('[role="option"],[role="treeitem"]'))
    .filter((o) => isVisible(o)).find((o) => norm(o.textContent).startsWith(want) || norm(o.getAttribute("data-automation-label")) === want);
  if (!el) return { found: false };
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { found: true, ariaExpandedBefore: el.getAttribute("aria-expanded"),
           rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                   cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) } };
}

// The actuation object. No tabId param — the substrate's single tracked
// attachment (cdpTabId) is the target; callers attach/detach around a run.
// `llmConfig` (AI-0 seam): the operator's {provider,model,apiKey,enabled} from storage,
// captured for act.llm. Omitted by recon/section harnesses (act.llm then short-circuits OFF).
function makeCdpActuation(llmConfig) {
  return {
    // AI-1: the brain gates the AI-fallback on this BEFORE opening a field (so a disabled
    // toggle never opens/actuates). Mirrors act.llm's own enabled check (both read llmConfig).
    aiEnabled: !!(llmConfig && llmConfig.enabled),
    delay: cdpAdaptiveDelay, // ALL driver pacing goes through this — visibility-adaptive: fast foreground, full hidden (SW wall-clock)
    delayFull: cdpDelay,     // NON-adaptive (never sped up): waits where the PAGE's own render needs real wall-clock time regardless of tab visibility. The 5x speedup is for OUR pacing between actions, NEVER the page's render.
    delayRender: cdpAdaptiveDelay, // STAGE 2 (2026-07-04): render-SETTLE intervals (dropdown option-list settle + commit-persistence) — adaptive on the SAME cdpFast() measured signal as `delay`. Safe to shrink because the sites gated by it use interval-LENGTH-INDEPENDENT state gates (2-equal-non-zero reads / persistence re-read), and it only shrinks when timers MEASURE fast (worker-backed/visible → the render genuinely completes in ~50ms). Slow/throttled ⇒ full ⇒ byte-identical to the old delayFull. Driver falls back to delayFull when this is absent (older fakes).

    scanPage: () => cdpEval(cdpPageScan),

    // ── text ──
    // Focus ladder (recon: cdp-click is what works; the rest are fallbacks).
    focusText: async (loc, tag) => {
      const sel = loc.wrapperSel + " " + (tag || "input"); // M37: "textarea" for roleDescription; default "input"
      // M29: retry the WHOLE focus ladder until the element is actually focused (or a
      // ceiling). A hidden-tab frozen-layout tick can make the input transiently
      // unfocusable (0-rect / mid-rerender) → a one-shot ladder returned null
      // ("could not focus input"). Re-attempt; the happy path returns on pass 1.
      const start = Date.now();
      const deadline = start + RECT_READY_CEILING_MS;
      let attempt = 0;
      while (true) {
        const rect = await cdpEval(cdpRectOf, sel, true);
        if (rect && rect.w > 0) {
          await cdpClickAt(rect.cx, rect.cy);
          await cdpAdaptiveDelay(250); // focus settle — adaptive (Stage B); gated by the .focused read below (a too-short settle just costs one ladder retry, never a wrong fill)
          const s = await cdpEval(cdpReadTextState, loc.wrapperSel, tag);
          if (s && s.focused) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusText", JSON.stringify(sel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (cdp-click)`); return "cdp-click"; }
        }
        if (await cdpEval(cdpFocusBySel, sel)) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusText", JSON.stringify(sel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (page-focus)`); return "page-focus()"; }
        try {
          await cdpDomFocus(sel);
          const s = await cdpEval(cdpReadTextState, loc.wrapperSel, tag);
          if (s && s.focused) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusText", JSON.stringify(sel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (DOM.focus)`); return "DOM.focus"; }
        } catch (e) { /* fall through to retry / null */ }
        if (Date.now() >= deadline) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusText", JSON.stringify(sel), `gave up after ${Date.now() - start}ms / ${attempt} retries`); return null; }
        await cdpDelay(RECT_READY_INTERVAL_MS);
        attempt++;
      }
    },
    clearText: () => cdpSelectAllDelete(),
    typeText: (text) => cdpInsertText(text), // recon (a): trusted beforeinput+input, survives blur
    readTextValue: (loc, tag) => cdpEval(cdpReadTextState, loc.wrapperSel, tag),

    // ── dropdown ──
    openDropdown: async (loc) => {
      const rect = await cdpRectReady(loc.wrapperSel + ' button[aria-haspopup="listbox"]', true); // M29: retry the trigger rect
      if (!rect) return false;
      await cdpClickAt(rect.cx, rect.cy);
      return true;
    },
    readDropdownState: (loc) => cdpEval(cdpReadDropdownState, loc.wrapperSel),
    typeJumpChars: (chars) => cdpTypeChars(chars, 120), // native listbox type-to-jump
    arrowStep: (dir) => cdpKeyTap(dir < 0 ? CDP_KEYS.arrowUp : CDP_KEYS.arrowDown),
    pressEnter: () => cdpKeyTap(CDP_KEYS.enter),
    pressEscape: () => cdpKeyTap(CDP_KEYS.escape),
    pressSpace: () => cdpKeyTap(CDP_KEYS.space),
    // The ONLY clean non-committing typeahead/source exit (recon 2026-06-26): Enter commits the armed
    // row; Escape hides the popup but KEEPS focus + the armed row → the next field's focus blur-commits
    // the stray; Tab blurs and ABANDONS the armed row without committing. cdpKeyTap is counter-gated so
    // the bot's own Tab passes the input-lock.
    pressTab: () => cdpKeyTap(CDP_KEYS.tab),
    // Last resort only (recon: out-of-view coordinate clicks dismiss the popup;
    // Enter-commit is primary) — scrollIntoView makes the coordinate paintable.
    clickOptionByIndex: async (loc, index) => {
      const rect = await cdpEval(cdpOptionRect, loc.wrapperSel, index);
      if (!rect || rect.w <= 0) return false;
      await cdpClickAt(rect.cx, rect.cy);
      return true;
    },
    // M28: TEXT-keyed option click — scrollIntoView the matched option (by text)
    // then coordinate-click it. The primary dropdown commit (no type-jump cycling,
    // no scrape-order index assumption). A null/zero rect (text not resolvable) →
    // false; a missed click dismisses harmlessly and the trigger-text gate verifies.
    clickDropdownOptionByText: async (loc, text) => {
      const rect = await cdpEval(cdpDropdownOptionRectByText, loc.wrapperSel, text);
      if (!rect || rect.w <= 0) return false;
      await cdpClickAt(rect.cx, rect.cy);
      return true;
    },

    // ── typeahead (M25) ──
    // Opener ladder: multiselectInputContainer → selectinput → first input →
    // the wrapper itself. The searchBox is unreachable until the widget opens.
    openTypeahead: async (loc) => {
      for (const part of [' [data-automation-id="multiselectInputContainer"]', ' [data-uxi-widget-type="selectinput"]', " input", ""]) {
        const rect = await cdpEval(cdpRectOf, loc.wrapperSel + part, true);
        if (rect && rect.w > 0) { await cdpClickAt(rect.cx, rect.cy); return true; }
      }
      return false;
    },
    readTypeahead: (loc) => cdpEval(cdpReadTaState, loc.wrapperSel),
    // Per-char trusted KEYSTROKES, not insertText: the widget arms its
    // first-option highlight only under keystroke-driven interaction — with
    // insertText the commit-Enter had no highlight to commit and no-op'd
    // (live 2026-06-12: tier-1 "Other" lost to a tier-3 auto-commit).
    typeInSearch: (text) => cdpTypeChars(text, 40),
    clearSearch: () => cdpSelectAllDelete(),         // trusted clear (focused searchBox)
    focusSearchBox: (loc) => cdpEval(cdpFocusBySel, loc.wrapperSel + ' input[data-automation-id="searchBox"]'),
    // FoS Round 3: scroll-accumulate the FULL virtualized option list (read-only, in-page,
    // frame-paced → <1s). Used by the END-OF-PAGE capture AND the single-open during-fill capture
    // (fillTypeaheadCdp's onCapture, before the candidate loop) to populate the bundle entry's options
    // for the summary searchable editor. NO commit (only scrollTop + reads). Logs the count so the
    // operator can SEE the scrape run mid-fill (during-fill logs before the candidate types).
    scrapeTaOptions: async (loc) => {
      const r = await cdpEval(cdpScrapeTaOptions, loc.wrapperSel);
      console.log("[ApplyPilot][CDP-SCRAPE-TA]", loc.wrapperSel, r && r.ok ? r.count + " options" + (r.atBottom ? " (reached bottom)" : "") + " [role=" + r.roleCount + " prompt=" + r.promptCount + " used=" + r.usedSel + "]" : "FAILED");
      return r;
    },
    // Trusted-click commit fallback (multi-match): text-keyed — immune to list
    // shifts between the settle read and the click; a missed click dismisses
    // (no-op) rather than mis-commits, and the chip gate verifies either way.
    clickTaOption: async (loc, text) => {
      const rect = await cdpEval(cdpTaOptionRectByText, text);
      if (!rect || rect.w <= 0) return false;
      await cdpClickAt(rect.cx, rect.cy);
      return true;
    },

    // ── source / tree picker (backlog C — Magna search shape) ──
    // Opener ladder mirrors the in-tree fillSource (button → multiselectInputContainer
    // → selectinput → input → wrapper).
    openSource: async (loc) => {
      for (const part of [' button[aria-haspopup="listbox"]', ' [data-automation-id="multiselectInputContainer"]', ' [data-uxi-widget-type="selectinput"]', " input", ""]) {
        const rect = await cdpEval(cdpRectOf, loc.wrapperSel + part, true);
        if (rect && rect.w > 0) { await cdpClickAt(rect.cx, rect.cy); return true; }
      }
      return false;
    },
    readSource: (loc) => cdpEval(cdpReadSourcePick, loc.wrapperSel),
    focusSourceSearch: (loc) => cdpEval(cdpFocusBySel, loc.wrapperSel + ' input[data-automation-id="searchBox"]'),
    typeInSourceSearch: (text) => cdpTypeChars(text, 40), // recon-proven on source; filters on Enter
    clearSourceSearch: () => cdpSelectAllDelete(),
    // probe a leaf by label → rect + the promptLeafNode selected-state (commit read).
    probeSourceLeaf: (label) => cdpEval(cdpSourceLeafProbe, label),
    clickSourceLeaf: async (label) => {
      const probe = await cdpEval(cdpSourceLeafProbe, label);
      if (!probe || !probe.found || !probe.rect || probe.rect.w <= 0) return false;
      await cdpClickAt(probe.rect.cx, probe.rect.cy);
      return true;
    },

    // ── unified hierarchical-typeahead (merge 2026-06-28) ──
    // The merged fillTypeaheadCdp drives BOTH cert and source through THESE methods (the legacy
    // typeahead/source methods above stay for the recon harnesses). openHier = the broad source opener
    // ladder (a button-trigger source AND a bare-input typeahead both resolve — the button rect simply
    // misses on a typeahead and falls through). readHier = the unified promptOption/data-automation-label
    // reader. clear/type/focus are the same trusted primitives both pickers already used. clickHierLeaf is
    // VIEWPORT-AWARE (cdpSourceRowRect scrolls an off-fold leaf into the clickable viewport +
    // elementFromPoint-validates) and matches by data-automation-label||text → the FIRST DOM node (the
    // "two Other leaves → pick the first" rule). probeHierLeaf reads the promptLeafNode isselected commit-signal.
    openHier: async (loc) => {
      for (const part of [' button[aria-haspopup="listbox"]', ' [data-automation-id="multiselectInputContainer"]', ' [data-uxi-widget-type="selectinput"]', " input", ""]) {
        const rect = await cdpEval(cdpRectOf, loc.wrapperSel + part, true);
        if (rect && rect.w > 0) { await cdpClickAt(rect.cx, rect.cy); return true; }
      }
      return false;
    },
    readHier: (loc) => cdpEval(cdpReadHierState, loc.wrapperSel),
    focusHierSearch: (loc) => cdpEval(cdpFocusBySel, loc.wrapperSel + ' input[data-automation-id="searchBox"]'),
    typeInHier: (text) => cdpTypeChars(text, 40),
    clearHierSearch: () => cdpSelectAllDelete(),
    probeHierLeaf: (label) => cdpEval(cdpSourceLeafProbe, label),
    clickHierLeaf: async (loc, label) => {
      const rr = await cdpEval(cdpSourceRowRect, label);
      if (!rr || !rr.found || !rr.rect || rr.rect.w <= 0) return false;
      await cdpClickAt(rr.rect.cx, rr.rect.cy);
      return true;
    },

    // ── tree DRILL (cert) — the two-prompt AI's substrate (recon 2026-06-27: clicking a category
    // REPLACES the list with that category's leaves; leaves = data-automation-id="promptOption" with the
    // " - <Category>" suffix; clickSourceLeaf commits a leaf). The poll lives in the brain (aiTreeFallback).
    readTreeCategories: async (loc) => {
      const d = await cdpEval(cdpReadSourceState, loc.wrapperSel);
      const rows = d ? [].concat(d.promptOptions || [], d.rows || []) : [];
      return rows.filter((r) => r && r.isCategory).map((r) => r.label).filter(Boolean);
    },
    // The drilled category's leaves — promptOption labels (FULL, suffixed), chip-excluded. cdpScrapeTaOptions
    // is WRONG here (it scrapes role="option" → the TRUNCATED menuItem dupes); cdpReadSourcePick reads the
    // promptOption leaves. (No scroll: Magna renders the full category list; a huge virtualized category is a
    // future scroll-scrape.)
    readTreeLeaves: async (loc) => {
      const d = await cdpEval(cdpReadSourcePick, loc.wrapperSel);
      return (d && Array.isArray(d.leaves)) ? d.leaves.slice() : [];
    },
    // Scroll-accumulate the source rows (VIRTUALIZED) → { categories, leaves }. Used by the source AI to
    // enumerate EVERY category (on open) and EVERY leaf (after a drill), so the AI never picks from a
    // partial, on-screen-only list. Read-only (scrolls + reads; resets scrollTop to 0).
    scrapeSourceRows: async (loc) => {
      const r = await cdpEval(cdpScrapeSourceRows, loc.wrapperSel, inputTraceEnabled);
      console.log("[ApplyPilot][CDP-SRC-SCRAPE]", loc.wrapperSel, r && r.ok ? (r.options.length + " options, banner=" + JSON.stringify(r.banner) + (r.atBottom ? " (bottom)" : "")) : "FAILED");
      return r;
    },
    // Click a category to expand/drill it (NON-committing — recon-proven). Returns whether the click fired;
    // the caller polls readTreeCategories/readTreeLeaves until the list flips to the leaves.
    expandCategory: async (loc, label) => {
      // Scroll-to-find the category's promptLeafNode (the drill handler) with cdpSourceRowRect (which SETTLES
      // before reading the live rect — react-virtualized recycles during scroll), then TRUSTED-click its
      // freshly-read center. No scrollIntoView / no synthetic click (browser-diag 2026-06-28). The list is
      // idle when the rect is read, so it doesn't recycle out from under this click.
      const rr = await cdpEval(cdpSourceRowRect, label);
      if (!rr || !rr.found || !rr.rect || rr.rect.w <= 0) return false;
      await cdpClickAt(rr.rect.cx, rr.rect.cy);
      return true;
    },
    // Commit a drilled tree LEAF by label — the viewport-safe sibling of clickSourceLeaf (which does a single
    // scrollIntoView + immediate rect → MISSES a leaf rendered below the viewport fold; CDP clicks at viewport
    // coords, the category-click bug fixed 2026-06-28). Reuses cdpSourceRowRect: scroll the leaf's promptLeafNode
    // into the clickable viewport, settle, re-query, elementFromPoint-validate, then trusted-click its fresh
    // center. Identical mechanism to expandCategory (leaves + categories are both promptLeafNode-wrapped
    // promptOptions; clicking a LEAF commits, a CATEGORY drills). The caller passes the FULL " - <Category>"
    // suffixed label (matchPO matches it). `loc` is accepted for symmetry; cdpSourceRowRect is document-wide.
    clickTreeLeaf: async (loc, label) => {
      const rr = await cdpEval(cdpSourceRowRect, label);
      if (!rr || !rr.found || !rr.rect || rr.rect.w <= 0) return false;
      await cdpClickAt(rr.rect.cx, rr.rect.cy);
      return true;
    },
    // READ-ONLY recon for the source-AI debug harness — see cdpSourceRowProbe / cdpSourceRowRect.
    sourceRowProbe: async (label) => cdpEval(cdpSourceRowProbe, label),
    sourceRowRect: async (label) => cdpEval(cdpSourceRowRect, label),
    clickAt: async (x, y) => cdpClickAt(x, y), // trusted coordinate click (debug: click a rect from sourceRowRect)

    // ── structural tree-vs-flat discriminator (0.4) — EXCLUDE tree pickers from the AI typeahead
    // fallback. A "typeahead"-classified field whose opened popup shows CATEGORY rows (chevron svg /
    // aria-expanded / role=treeitem+aria-level / aria-haspopup → cdpReadSourceState's isCategory) is a
    // TREE (Magna's certification — recon 2026-06-26: 3 menuItem category rows), NOT a flat typeahead
    // (Field of Study / countryPhoneCode → 0 category rows). READ-ONLY: open → read markers → Tab-close
    // (no type/Enter/arrow/click → nothing arms; the recon proved this leaves the field unchanged).
    isTreePicker: async (loc) => {
      // open (the broad multiselect/source opener ladder; works for either chrome)
      for (const part of [' button[aria-haspopup="listbox"]', ' [data-automation-id="multiselectInputContainer"]', ' [data-uxi-widget-type="selectinput"]', " input", ""]) {
        const rect = await cdpEval(cdpRectOf, loc.wrapperSel + part, true);
        if (rect && rect.w > 0) { await cdpClickAt(rect.cx, rect.cy); break; }
      }
      // GATED render wait (Stage B — was a blind 700ms). Poll until the portaled list has MOUNTED (any
      // rows present), THEN classify — fast when it renders fast (the common case; FoS mounts ~immediately),
      // but never reads an EMPTY list (which would misclassify a tree as flat). Raw ceiling so a genuinely
      // slow render still resolves; a still-empty list at the ceiling = no options on open (search-only) →
      // treated flat, same conclusion the old blind read reached. Read-only (no type/Enter/arrow/click).
      let dump = null, rows = [];
      const treeDeadline = Date.now() + 1500; // raw bound (old blind wait was 700ms; give a slow mount room)
      while (Date.now() < treeDeadline) {
        await cdpAdaptiveDelay(120); // adaptive poll interval — tight when fast, full on the slow path
        dump = await cdpEval(cdpReadSourceState, loc.wrapperSel);
        rows = dump ? [].concat(dump.promptOptions || [], dump.rows || []) : [];
        if (rows.length > 0) break;
      }
      const isTree = rows.some((r) => r && r.isCategory);
      await cdpKeyTap(CDP_KEYS.tab); // clean non-committing close
      await cdpAdaptiveDelay(200);
      return isTree;
    },

    // ── radio / checkbox ──
    readRadioState: (loc) => cdpEval(cdpReadRadioState, loc.wrapperSel),
    clickRadioLabel: async (loc, id) => {
      const rect = await cdpRectReady('label[for="' + id + '"]', true); // M29: retry the label rect
      if (!rect) return false;
      await cdpClickAt(rect.cx, rect.cy);
      return true;
    },
    focusInput: (id) => cdpEval(cdpFocusInputById, id),
    readChecked: (id) => cdpEval(cdpReadCheckedById, id),
    readCheckboxState: (loc) => cdpEval(cdpReadCheckboxState, loc.wrapperSel),
    clickCheckboxLabel: async (loc) => {
      const st = await cdpEval(cdpReadCheckboxState, loc.wrapperSel);
      if (!st || !st.inputId) return false;
      let rect = await cdpRectReady('label[for="' + st.inputId + '"]', true); // M29: retry the label rect
      if (!rect) rect = await cdpEval(cdpRectOf, loc.wrapperSel + ' input[type="checkbox"]', true); // one-shot input fallback
      if (!rect || rect.w <= 0) return false;
      await cdpClickAt(rect.cx, rect.cy);
      return true;
    },

    // ── page advance (M31) ──
    // Guarded Save & Continue. REFUSE on the review page (the footer button is
    // Submit there — the double-guard). cdpRectReady (M29) absorbs a transient 0-rect.
    clickPageNext: async () => {
      const reviewPresent = await cdpEval(() => !!document.querySelector('[data-automation-id="applyFlowReviewPage"]'));
      if (reviewPresent) return { clicked: false, refused: "review-page" };
      const rect = await cdpRectReady('[data-automation-id="pageFooterNextButton"]', true);
      if (!rect) return { clicked: false, refused: "no-button" };
      // A popup/overlay (e.g. the Simplify extension's dialog, a cookie banner, a modal) can sit OVER the
      // Save & Continue button. A coordinate click would land on the popup and be SWALLOWED — the page never
      // advances and it surfaces as a bare nav-timeout. So elementFromPoint the button's center first: the
      // top node there must BE the button (or in its subtree). If something else covers it, refuse with a
      // diagnostic that NAMES the blocker instead of clicking blindly.
      const cover = await cdpEval((cx, cy) => {
        const btn = document.querySelector('[data-automation-id="pageFooterNextButton"]');
        const top = document.elementFromPoint(cx, cy);
        if (!btn || !top || top === btn || btn.contains(top) || top.contains(btn)) return { blocked: false };
        const desc = (el) => {
          const p = [el.tagName ? el.tagName.toLowerCase() : "?"];
          if (el.id) p.push("#" + el.id);
          const aid = el.getAttribute && el.getAttribute("data-automation-id");
          if (aid) p.push('[data-automation-id="' + aid + '"]');
          const cls = (el.className && typeof el.className === "string") ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
          if (cls) p.push("." + cls);
          const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
          return p.join("") + (txt ? ' "' + txt + '"' : "");
        };
        return { blocked: true, by: desc(top) };
      }, rect.cx, rect.cy);
      if (cover && cover.blocked) {
        // DIAG (2026-07-06): dump the blocker's real structure so we can build a targeted dismiss for it.
        try { const dump = await cdpEval(cdpDumpBlocker, rect.cx, rect.cy); console.log("[ApplyPilot][CDP-BLOCKER-DUMP]", JSON.stringify(dump)); } catch (e) { /* diag only */ }
        // Best-effort auto-dismiss (operator opted in 2026-07-06): try ONCE to click a clearly-dismissive
        // control (X/Close/No-thanks — never Accept/OK) inside the popup, incl. Simplify's shadow-DOM overlay,
        // then re-check. If it clears → proceed; else halt (operator closes it) — never force-remove DOM.
        const d = await cdpEval(cdpFindDismissControl, rect.cx, rect.cy);
        if (d && d.found) {
          console.log("[ApplyPilot][CDP] Save & Continue covered by", cover.by, "— clicking its dismiss control:", JSON.stringify(d.label));
          await cdpClickAt(d.cx, d.cy);
          const coverGone = async () => cdpEval((cx, cy) => {
            const b = document.querySelector('[data-automation-id="pageFooterNextButton"]');
            const t = document.elementFromPoint(cx, cy);
            return !b || !t || t === b || b.contains(t) || t.contains(b);
          }, rect.cx, rect.cy);
          let clear = false;
          for (let i = 0; i < 5 && !clear; i++) { await cdpDelay(300); clear = await coverGone(); } // let it animate out
          if (clear) {
            console.log("[ApplyPilot][CDP] popup dismissed — Save & Continue is now clickable.");
            await cdpClickAt(rect.cx, rect.cy);
            return { clicked: true, dismissed: cover.by };
          }
          console.log("[ApplyPilot][CDP] auto-dismiss clicked", JSON.stringify(d.label), "but the button is STILL covered — halting for the operator.");
          return { clicked: false, refused: "blocked", blockedBy: cover.by, dismissTried: d.label };
        }
        console.log("[ApplyPilot][CDP] Save & Continue is COVERED by an overlay/popup — NOT clicking (no safe dismiss control found). Blocked by:", cover.by);
        return { clicked: false, refused: "blocked", blockedBy: cover.by };
      }
      await cdpClickAt(rect.cx, rect.cy);
      return { clicked: true };
    },

    // ── AI-4 validation-error remediation ──
    readErrorLinks: () => cdpEval(cdpReadErrorLinks),            // the visible error anchors (rect + text)
    focusedFieldName: () => cdpEval(cdpFocusedFieldName),        // the field an error-anchor click focused
    clickAt: (cx, cy) => cdpClickAt(cx, cy),                     // GATED click (bumps __apActing) — for an error anchor's rect

    // ── repeating sections (M32) ──
    // Substrate for driveRepeatingSectionCdp. The brain stays substrate-agnostic:
    // these return data / {ok}, never rects, so the test fake just flips counts.
    repeatingScan: () => cdpEval(cdpRepeatingScan),
    nestedScan: () => cdpEval(cdpGenericNestedScan), // nested repeating sections (cert → specialties) + parentOrder + attachments
    entryCount: (prefix) => cdpEval(cdpEntryCount, prefix),
    // Click a section's Add button (headingRegexSource is a STRING — RegExp can't
    // cross the eval boundary). scrollIntoView + viewport rect + M29 retry, then click.
    clickSectionAdd: async (headingRegexSource) => {
      const rect = await cdpEvalRectReady(cdpSectionAddRect, headingRegexSource);
      if (!rect) return { ok: false };
      await cdpClickAt(rect.cx, rect.cy);
      return { ok: true };
    },
    // Click the index-th entry's Delete button (trailing entry for reconcile-down;
    // any index for delete-on-no-match). Same scroll + viewport-rect + retry mechanics.
    clickDeleteEntry: async (prefix, index) => {
      const rect = await cdpEvalRectReady(cdpDeleteEntryRect, prefix, index);
      if (!rect) return { ok: false };
      await cdpClickAt(rect.cx, rect.cy);
      return { ok: true };
    },
    // ── nested repeating sections (reveal-by-add: cert ▸ Specialties) ──
    // Add scoped INSIDE a specific parent entry (parentFkit = "<base>-<N>--null"); Delete a nested
    // child entry that has NO --null container. Same scroll + viewport-rect + M29 retry mechanics.
    clickNestedAdd: async (parentFkit, headingRegexSource) => {
      const rect = await cdpEvalRectReady(cdpNestedAddRect, parentFkit, headingRegexSource);
      if (!rect) return { ok: false };
      await cdpClickAt(rect.cx, rect.cy);
      return { ok: true };
    },
    clickNestedDelete: async (parentFkit, childBase, childIndex) => {
      const rect = await cdpEvalRectReady(cdpNestedDeleteRect, parentFkit, childBase, childIndex);
      if (!rect) return { ok: false };
      await cdpClickAt(rect.cx, rect.cy);
      return { ok: true };
    },
    // Probe the live fkit ↔ formField relationship for a nested field and return the SINGLE
    // suffix-composable wrapper selector that actually resolves (null = nothing found — honest).
    nestedFieldSel: (fkit, field) => cdpEval(cdpNestedFieldSel, fkit, field),
    // Does a selector resolve on the live page? (reconPageTruth's nested-row existence check —
    // a Tier-1.5 deleted specialty row's probed auditLoc stops resolving.)
    selExists: (sel) => cdpEval(function (s) { return !!document.querySelector(s); }, sel),

    // ── date composite segments (M34) ──
    // A date `-input` (role=spinbutton) is 0-box — can't be coordinate-clicked. Focus
    // ladder: TRIPLE-CLICK the visible `-display` sibling (M33 recipe) → rect-free
    // el.focus() → CDP DOM.focus, each verified via the input's focused flag. Returns
    // the winning rung ("triple-click-display" / "el.focus()" / "DOM.focus") or null.
    // `segment` ∈ {"Month","Day","Year"} → dateSection<segment>-input / -display.
    focusDateSegment: async (loc, segment) => {
      const inputSel = loc.wrapperSel + ' [data-automation-id="dateSection' + segment + '-input"]';
      const displaySel = loc.wrapperSel + ' [data-automation-id="dateSection' + segment + '-display"]';
      const focused = async () => { const s = await cdpEval(cdpReadInputBySel, inputSel); return !!(s && s.focused); };
      // M38 Bug A: RETRY the whole ladder until the segment reads .focused (or a ceiling).
      // The ladder is one-shot-per-rung; a transient hidden-tab layout glitch (frozen
      // layout tick / mid-rerender) can fail all three rungs in one pass → "focus-failed"
      // → a half-filled date (the live WE[0].endDate Year). Re-attempt; the happy path
      // returns on pass 1 (no added latency). Mirrors focusText's M29 hardening (single
      // cdpRectOf per attempt — the outer loop owns the retry). Logs only when it engages.
      const start = Date.now();
      let attempt = 0;
      while (true) {
        const r = await cdpEval(cdpRectOf, displaySel, true);
        if (r && r.w > 0) { await cdpTripleClickAt(r.cx, r.cy); await cdpAdaptiveDelay(200); if (await focused()) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusDateSegment", JSON.stringify(displaySel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (triple-click-display)`); return "triple-click-display"; } }
        if (await cdpEval(cdpFocusBySel, inputSel)) { await cdpAdaptiveDelay(120); if (await focused()) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusDateSegment", JSON.stringify(inputSel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (el.focus)`); return "el.focus()"; } }
        try { await cdpDomFocus(inputSel); await cdpAdaptiveDelay(120); if (await focused()) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusDateSegment", JSON.stringify(inputSel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (DOM.focus)`); return "DOM.focus"; } } catch (e) { /* not found */ }
        if (Date.now() - start >= RECT_READY_CEILING_MS) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusDateSegment", JSON.stringify(inputSel), `gave up after ${Date.now() - start}ms / ${attempt} retries`); return null; }
        await cdpAdaptiveDelay(RECT_READY_INTERVAL_MS); // focus-retry poll interval — adaptive (Stage B); gated by focused() re-check
        attempt++;
      }
    },
    readDateSegment: (loc, segment) => cdpEval(cdpReadInputBySel, loc.wrapperSel + ' [data-automation-id="dateSection' + segment + '-input"]'),
    typeDigits: (text) => cdpTypeChars(String(text), 80), // per-char primary; act.typeText (insertText) is the brain's verified fallback

    // ── AI fill (AI-0 seam) ── the ONLY I/O method on act: round-trips the configured
    // provider via the llm.js adapter (callLLM is a global — llm.js is imported before cdp.js
    // in background.js importScripts). Enforces the opt-in toggle HERE: enabled===false (or no
    // config) ⇒ no provider call, no spend. NEVER throws — returns the normalized
    // {ok,text}|{ok:false,error}; the brain flags the field for review on !ok. The brain stays
    // Node-testable: tests pass a FAKE act.llm with canned replies (the real one isn't loaded).
    llm: async ({ system, user, maxTokens }) => {
      if (!llmConfig || !llmConfig.enabled) return { ok: false, error: "AI fill OFF (enable it in the popup)" };
      return await callLLM({ provider: llmConfig.provider, model: llmConfig.model, apiKey: llmConfig.apiKey, system, user, maxTokens });
    }
  };
}
