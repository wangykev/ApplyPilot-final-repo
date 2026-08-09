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
      cdpAttachedAt = Date.now();              // lag trace: "does this degrade the longer one attach lives?"
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
        // Synthetic-input kill-switch (2026-07-25): forceTrustedInput=true reverts HIDDEN fills to the
        // trusted Input.* path (slow-but-battle-tested) — the escape hatch if a tenant's widgets
        // ignore synthetic events (they'd surface as needs_review, never a wrong fill).
        try { const { forceTrustedInput } = await new Promise((r) => chrome.storage.local.get("forceTrustedInput", r)); _forceTrustedInput = !!forceTrustedInput; } catch (e) { _forceTrustedInput = false; }
        cdpInvalidatePaint(); // a fresh attach says nothing about the previous tab's paint state
        _synthInputEnabled = false; // per-run opt-in — only the FILL entry points enable it (auth/onboarding/recon stay trusted)
        console.log(`[ApplyPilot][CDP] input mode: trusted${_forceTrustedInput ? " ALWAYS (forceTrustedInput)" : " (synthetic-when-hidden armed — the fill walk enables it)"}`);
        resolve({ ok: true });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  });
}

// Which tab (if any) this debugger client is currently attached to. Read-only
// accessor so callers that manage their own attach lifecycle (the discovery
// sweep's single-tab JD pass) can ask "am I already attached here?" without
// reaching into this module's internal binding. null = not attached.
function cdpAttachedTab() {
  return cdpTabId;
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
      cdpAttachedAt = 0;
      cdpLagStop();   // the heartbeat probes over the attach — it must never outlive it
      resolve();
    });
  });
}

// Promisified sendCommand against the tracked tab. Rejects on no-attach and on
// command errors (so callers' try/catch sees real failures, not undefineds).
function cdpSendRaw(method, params) {
  return new Promise((resolve, reject) => {
    if (cdpTabId === null) { reject(new Error("CDP not attached")); return; }
    chrome.debugger.sendCommand({ tabId: cdpTabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(method + ": " + chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// Every CDP command flows through here, so it is the one place that can time ALL of them. When the
// lag trace is off this is a straight pass-through — the instrumentation must not be able to change
// the timings it exists to measure.
function cdpSend(method, params) {
  if (!cdpLagOn) return cdpSendRaw(method, params);
  const s0 = Date.now();
  return cdpSendRaw(method, params).then(
    (r) => { cdpLagNote(method, Date.now() - s0, null); return r; },
    (e) => { cdpLagNote(method, Date.now() - s0, e); throw e; }
  );
}

// ── LAG TRACE (2026-08-09, debugLagTrace) ────────────────────────────────────────────────────────
// Operator: "sometimes it randomly starts filling slower — is it a Workday thing or a bug in my
// code?" You cannot answer that from a duration alone: "this field took 4s" is equally consistent
// with Workday thinking, with the debugger transport being slow, and with our own service worker
// being blocked. So measure THREE independent clocks and let them disagree:
//
//   1. SW scheduling DRIFT — a fixed-interval timer's ACTUAL vs EXPECTED fire time. The interval is
//      ours and touches nothing else, so a spike means the service worker's own event loop was
//      blocked (our JS, or Chrome GC/suspension). Workday cannot cause this.
//   2. NO-OP CDP round trip — Runtime.evaluate("1"). Crosses the whole debugger transport but runs
//      no Workday code and touches no DOM. A spike means the transport/browser, not the tenant.
//   3. REAL command duration — every cdpSend, by method. Subtract (2) and what remains is the page
//      genuinely thinking, i.e. Workday.
//
// Without (1) and (2), every pause looks like "the page was slow" — the assumption that has already
// sent debugging rounds in the wrong direction (the 2026-08-06 relocation bug was ours, not Workday's).
let cdpLagOn = false;
let cdpLagWin = null;    // the CURRENT accumulation window; cdpLagReport() drains and resets it per page
let cdpLagTimer = null;
let cdpLagBeatAt = 0;
let cdpAttachedAt = 0;   // for "does this get worse the longer one attach lives?" (the stale-state suspicion)
const CDP_LAG_BEAT_MS = 500;      // heartbeat interval — fine enough to catch a 1s stall, cheap enough to ignore
const CDP_LAG_SLOW_CMD_MS = 400;  // stream a line for any SINGLE command at/over this, with its blame
const CDP_LAG_DRIFT_MS = 400;     // stream a line when the SW loop itself stalls this long

function cdpLagFresh() { return { t0: Date.now(), cmds: new Map(), beats: [] }; }

function cdpLagPct(arr, p) {
  if (!arr || !arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

// Median no-op round trip over the recent beats — the "what does a round trip cost RIGHT NOW"
// baseline that every real command is judged against.
function cdpLagBaseline() {
  const w = cdpLagWin;
  if (!w) return null;
  const r = w.beats.slice(-12).map((b) => b.rtt).filter((x) => typeof x === "number");
  return r.length ? cdpLagPct(r, 0.5) : null;
}

// The whole point of the subsystem: one attribution per slow command.
function cdpLagBlame(ms, p) {
  if (p == null) return "no baseline yet";
  if (p >= ms * 0.5) return `RENDERER BLOCKED — a trivial page eval also costs ~${p}ms right now, so the page's main thread is jammed; the [CDP-TIME] phase breakdown says whose work that is`;
  if (p >= 200) return `MIXED — the page thread is already ~${p}ms behind, and this command added ~${ms - p}ms of its own`;
  return `THIS COMMAND'S OWN WORK — a trivial page eval costs ~${p}ms right now, so the channel and the page thread are both free and ~${ms}ms is what this call genuinely took`;
}

function cdpLagNote(method, ms, err) {
  const w = cdpLagWin;
  if (!w) return;
  let e = w.cmds.get(method);
  if (!e) { e = { n: 0, total: 0, max: 0, all: [] }; w.cmds.set(method, e); }
  e.n++; e.total += ms;
  if (ms > e.max) e.max = ms;
  if (e.all.length < 5000) e.all.push(ms);   // bounded: a long run must not grow memory without limit
  if (ms >= CDP_LAG_SLOW_CMD_MS) {
    const base = cdpLagBaseline();
    console.log(`[ApplyPilot][LAG] ⏳ ${method} ${ms}ms — ${cdpLagBlame(ms, base)}${err ? " (errored)" : ""}`);
  }
}

function cdpLagStart() {
  const first = !cdpLagOn;
  cdpLagOn = true;
  // Idempotent: called at the top of every page, but only the FIRST call opens a window — a later
  // call must not wipe the one the current page is still accumulating into.
  if (first || !cdpLagWin) cdpLagWin = cdpLagFresh();
  if (cdpLagTimer) return;
  cdpLagBeatAt = Date.now();
  cdpLagTimer = setInterval(async () => {
    const now = Date.now();
    const drift = now - cdpLagBeatAt - CDP_LAG_BEAT_MS;   // >0 ⇒ the SW loop was busy or suspended
    cdpLagBeatAt = now;
    let rtt = null;
    if (cdpTabId !== null) {
      // ONE probe: a trivial expression that must nonetheless be scheduled ON the page's main thread.
      // It measures transport AND renderer availability together, which is enough to separate them:
      // the round trip cannot be FASTER than the transport, so a p50 of ~1ms (measured across all
      // three 2026-08-09 runs) proves the debugger channel is not a source of lag — and any spike is
      // therefore the renderer being busy, not the channel.
      //
      // A second, browser-process probe (Browser.getVersion) was tried here to split those two apart
      // and is deliberately gone: browser-domain commands are not served on a TAB-scoped attach, so it
      // reported "–" on every beat of runs 2 and 3 while still costing a failing round trip each time.
      // cdpSendRaw, NOT cdpSend — the probe must stay out of the stats it is the baseline for.
      const s0 = Date.now();
      try { await cdpSendRaw("Runtime.evaluate", { expression: "1", returnByValue: true }); rtt = Date.now() - s0; }
      catch (e) { rtt = null; }   // detached / navigating — absence of a reading, not a slow reading
    }
    const w = cdpLagWin;
    if (!w) return;
    w.beats.push({ at: now, drift, rtt });
    if (drift >= CDP_LAG_DRIFT_MS) {
      console.log(`[ApplyPilot][LAG] ⛔ the SERVICE WORKER itself stalled ${drift}ms (expected a beat every ${CDP_LAG_BEAT_MS}ms) — this is OUR side, not Workday`);
    }
  }, CDP_LAG_BEAT_MS);
}

function cdpLagStop() {
  cdpLagOn = false;
  if (cdpLagTimer) { clearInterval(cdpLagTimer); cdpLagTimer = null; }
  cdpLagWin = null;
}

// Drain the window and return one summary line (or null when the trace is off). Called per page, so
// consecutive pages of the SAME run can be compared — which is how a run that "randomly gets slower"
// shows itself: the no-op rtt and the SW drift climb while the command COUNT stays flat.
function cdpLagReport(label) {
  const w = cdpLagWin;
  if (!cdpLagOn || !w) return null;
  cdpLagWin = cdpLagFresh();
  const rtts = w.beats.map((b) => b.rtt).filter((x) => typeof x === "number");
  const drifts = w.beats.map((b) => b.drift).filter((x) => typeof x === "number");
  const entries = [...w.cmds.entries()];
  const nCmd = entries.reduce((s, [, e]) => s + e.n, 0);
  const totMs = entries.reduce((s, [, e]) => s + e.total, 0);
  const top = entries.sort((a, b) => b[1].total - a[1].total).slice(0, 4)
    .map(([m, e]) => `${m} ×${e.n} tot ${(e.total / 1000).toFixed(1)}s p95 ${cdpLagPct(e.all, 0.95)}ms max ${e.max}ms`);
  const n = (x) => (x == null ? "–" : x + "ms");
  return `[LAG] ${label} · ${nCmd} cmds, ${(totMs / 1000).toFixed(1)}s total in CDP`
    + ` · PAGE-thread probe p50 ${n(cdpLagPct(rtts, 0.5))} p95 ${n(cdpLagPct(rtts, 0.95))} max ${n(rtts.length ? Math.max(...rtts) : null)}`
    + ` · SW drift p95 ${n(cdpLagPct(drifts, 0.95))} max ${n(drifts.length ? Math.max(...drifts) : null)}`
    + ` · worker age ${Math.round((Date.now() - AP_DEV_WORKER_START) / 1000)}s, attach age ${cdpAttachedAt ? Math.round((Date.now() - cdpAttachedAt) / 1000) + "s" : "–"}`
    + (top.length ? ` · top: ${top.join(" | ")}` : "");
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

// ── Navigation (onboarding stage) ────────────────────────────────────────────
// The FILL/WALK never navigates (it drives whatever page is active). The ONBOARDING
// stage does: it drives the tab from a job-description page through Apply → auth →
// the verification LINK. Page is already enabled in cdpAttach, and the attach SURVIVES
// navigation, so these are safe on the live attach. Both are SW-side (chrome.debugger),
// throttle-immune, and never throw — { ok } / { ok:false, error }.

// Navigate the attached tab to `url` (Page.navigate — the port of the reference's
// page.goto for the verification link). Returns the frameId on success; errorText on
// a blocked/failed navigation (e.g. a bad URL).
async function cdpNavigate(url) {
  try {
    const res = await cdpSend("Page.navigate", { url: String(url) });
    if (res && res.errorText) return { ok: false, error: res.errorText };
    return { ok: true, frameId: res && res.frameId };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Reload the attached tab (Page.reload) — the fix for Workday's transient
// "Something went wrong / Please refresh the page and then try again." soft-error:
// the onboarding state machine reloads ONCE (guarded) and retries. ignoreCache:true
// so a hard reload re-fetches a genuinely stuck SPA bundle.
async function cdpReload() {
  try { await cdpSend("Page.reload", { ignoreCache: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Force the page to behave as focused+active (Emulation.setFocusEmulationEnabled) — a best-effort
// nudge to keep a HIDDEN/backgrounded tab REPAINTING. Some Workday SPA sub-view transitions (e.g.
// the "Sign in with email" chooser→form reveal) defer on rAF, which Chrome pauses when the tab is
// hidden; the worker-timer override handles most, but a page whose CSP blocks the blob worker leaves
// the transition stalled (PANW's chooser, 2026-07-09). Focus-emulation is an independent lever that
// can keep such a page rendering. Does NOT touch the SW-side cdpVisible pacing sampler (that reads
// chrome.tabs, not page state), so adaptive pacing stays honest. No-op if unsupported.
async function cdpSetFocusEmulation(enabled) {
  try { await cdpSend("Emulation.setFocusEmulationEnabled", { enabled: !!enabled }); return true; }
  catch (e) { return false; }
}

// ── WHY THERE IS NO SCREENCAST HERE ANY MORE (removed 2026-08-07) ────────────────────────────────────
// There was one: Page.startScreencast put a hidden tab under capture, which makes Chrome keep producing
// frames for it, and that genuinely worked. It was added because Greenhouse's server-backed comboboxes
// "burn 16-31s hidden and then reach review unanswered".
//
// That symptom had nothing to do with paint. It was OUR page overrides landing on a document that was
// already running: the timers those widgets schedule their search on got swapped mid-flight and the
// widgets never resolved again. Forcing frames let the half-broken page grind through often enough to
// look like a fix. Installing the overrides before the document exists (see runAtsApplicationRun) fixed
// the cause, and the workaround measured as pure cost afterwards — Discord hidden filled 16.9s dark vs
// 17.2s under capture, and Reddit's rehearsal (the run that FAILED without forcing on 2026-08-06)
// passed its whole gate dark: 23 fields replayed, 0 failures, 0 blockers.
//
// If a future tenant genuinely needs frames, this is the lever and it does work — bring it back
// deliberately, with a measurement, rather than as a hedge. It is not free: capture makes the renderer
// paint, and at everyNthFrame:1 the JPEG encoding starved the very renderer it was meant to free.

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

// The worker-timers block, extracted (2026-07-25) so the CSP-bypass RETRY (cdpInstallPageOverrides)
// can re-run JUST this block on a doc whose first attempt was CSP-blocked — without re-running the
// full override (guarded by __apOverridesInstalled) or duplicating the source. Sets
// window.__apWorkerTimers true/false itself; rAF picks up the replaced window.setTimeout dynamically
// (it resolves window.setTimeout at call time, not install time).
const WORKER_TIMERS_SRC = `try {
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

// Re-run ONLY the worker-timers block on a doc where the full override already installed but the
// worker did NOT take (window.__apWorkerTimers !== true) — used after Page.setBypassCSP flips CSP
// enforcement off so the blob: worker that was blocked on the first attempt can now install.
// Idempotent: no-ops when the override never installed or the worker is already live.
function buildWorkerRetrySrc() {
  return `(function () { try {
    if (!window.__apOverridesInstalled || window.__apWorkerTimers === true) return;
    ${WORKER_TIMERS_SRC}
  } catch (e) { /* best-effort */ } })();`;
}

function buildOverrideSrc(opts) {
  const forceNoWorker = !!(opts && opts.forceNoWorker);
  const workerBlock = forceNoWorker
    ? `window.__apWorkerTimers = false; /* forceWorkerTimersOff — simulate a CSP-blocked tenant (slow-path test) */`
    : WORKER_TIMERS_SRC;
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
    // The paint probe needs the REAL rAF: the polyfill below is setTimeout-backed, so it fires happily
    // on a tab that is producing no frames at all — measuring it would report "painting" always.
    if (!window.__apNativeRaf && window.requestAnimationFrame) {
      window.__apNativeRaf = window.requestAnimationFrame.bind(window);
    }
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
  // CSP BYPASS (2026-07-25 — the wd3.myworkdaysite.com slow-run diagnosis): a tenant whose CSP blocks
  // blob: workers silently killed the WHOLE fast hidden path — the worker-timers install threw, the
  // readback stayed false, and every page-side debounce/render quantized to the ~1Hz throttle (the
  // live run's uniform ~11s/field). We are ALREADY attached via chrome.debugger, so ask the browser
  // to bypass CSP enforcement for this page (the standard Puppeteer page.setBypassCSP technique) —
  // then the blob: worker installs and the measured-fast gate does the rest. BEST-EFFORT + logged:
  // an old Chrome / restricted command just leaves CSP on → the readback stays false → the safe
  // slow path, byte-identical to before. Scoped to the debugger attach (detach restores enforcement).
  let cspBypassed = false;
  if (!forceNoWorker) {
    try { await cdpSend("Page.setBypassCSP", { enabled: true }); cspBypassed = true; } catch (e) { /* stay CSP-bound */ }
  }
  try {
    const src = buildOverrideSrc({ forceNoWorker });
    await cdpSend("Page.addScriptToEvaluateOnNewDocument", { source: src }); // future loads / re-auth
    await cdpSend("Runtime.evaluate", { expression: src });                  // the current already-loaded SPA doc
    // Read back whether the worker-timers polyfill actually installed on the CURRENT
    // doc (CSP could block blob: workers → false → we stay on the safe slow path).
    try { _workerTimersActive = !!(await cdpEval(() => !!window.__apWorkerTimers)); } catch (e) { _workerTimersActive = false; }
    // RETRY once (worker-only): the doc may carry __apOverridesInstalled from an EARLIER attach that
    // ran without the bypass (SPA — no reload between runs), so the full override no-ops and the
    // worker stays dead. buildWorkerRetrySrc re-runs JUST the worker block when the worker isn't live.
    if (!_workerTimersActive && !forceNoWorker && cspBypassed) {
      try {
        await cdpSend("Runtime.evaluate", { expression: buildWorkerRetrySrc() });
        _workerTimersActive = !!(await cdpEval(() => !!window.__apWorkerTimers));
      } catch (e) { /* stays slow/safe */ }
    }
    const wt = _workerTimersActive ? "ON" : (forceNoWorker ? "OFF (forced)" : (cspBypassed ? "OFF (blocked even with CSP bypass)" : "OFF (CSP?)"));
    console.log(`[ApplyPilot][CDP] page overrides installed (rAF→setTimeout + hasFocus; CSP bypass ${cspBypassed ? "ON" : "unavailable"}; worker-timers ${wt}) — hidden-tab unblock + fast timers.`);
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
// One trusted keystroke costing this long means the input pipeline is frame-gated (the tab is not
// painting), so the REST of the string would cost the same each — cdpTypeChars escalates to the
// page-side write instead of spending it. Well above a healthy visible keystroke (~10-30ms) and well
// below the ~1.2-1.5s stall, so a merely-busy page does not trip it.
const TYPE_STALL_ESCALATE_MS = 250;
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

// The PACING REGIME label for the per-page [CDP-TIME] log (2026-07-25) — makes every timing line
// self-diagnosing: a slow page with "hidden-SLOW (no worker timers)" means the tenant's CSP (or the
// forced flag) killed the worker install and EVERY page-side debounce is riding the ~1Hz throttle —
// the whole-run bottleneck class, not something the adaptive budgets can fix. Cheap (TTL-cached reads).
async function cdpPacingLabel() {
  if (await cdpVisible()) return "visible-fast";
  if (!_workerTimersActive) return "hidden-SLOW (no worker timers)";
  return (await cdpTimersFast()) ? "hidden-fast (worker timers)" : "hidden-SLOW (worker throttled)";
}

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

// ── SYNTHETIC input mode (2026-07-25 — the truly-hidden fast path) ───────────
// The [CDP-TIME] evidence (two live Magna runs): trusted Input.dispatch* to a HIDDEN tab stalls
// ~1.2–1.5s PER EVENT (input processing rides compositor-frame scheduling; a hidden tab produces no
// frames), while Runtime.evaluate stays fast (27-field audit batch ~0.1s). So when the tab is hidden,
// the input primitives below dispatch SYNTHETIC events INSIDE the page via one cdpEval instead of the
// Input domain — the page-engine's PROVEN repertoire (robustClick pointer→mouse→click sequence;
// native-setter + input/change = the React fill technique; label activation; searchBox set + synthetic
// Enter — all live-verified on Comcast/LiveRamp/US Bank on the page path). Every downstream verify
// gate is UNCHANGED (read-backs, chip/persistence re-reads, M40 audit), so a tenant where a synthetic
// event no-ops ends needs_review — never a wrong/silent fill. A VISIBLE tab keeps the trusted path
// (battle-tested, and input acks are ms there). Kill-switch: chrome.storage.local.forceTrustedInput
// (read at attach) reverts hidden runs to the trusted path (slow-but-proven).
//
// Semantics deltas (deliberate, documented):
//   • Synthetic events run NO browser default actions. The two we rely on are recreated: Tab → blur()
//     (the typeahead's clean non-commit exit is Workday's blur handler) and Space → click() (the
//     focus+Space radio fallback). Focus-on-click is mimicked (a trusted mousedown's default) so
//     follow-on key dispatches land on the element a real click would have focused.
//   • Synthetic text entry REPLACES the whole value (native setter + input/change) instead of
//     inserting at a cursor/selection — every call site types after a clear or a select-all, where
//     replace ≡ what select+type does; the read-back poll gates the result either way.
//   • elementFromPoint descends OPEN shadow roots (the Simplify-dismiss X lives in one) and steps
//     past Workday's own click_filter overlay to the control beneath it.
let _forceTrustedInput = false; // storage kill-switch, read at cdpAttach
// SCOPED opt-in (2026-07-25, after the live sign-in stall): synthetic input is enabled ONLY by the
// FILL entry points (runCdpWalk / runCdpFillPage) — the surface the synthetic repertoire was proven
// on (application FORM pages). The ONBOARDING/AUTH screens stay on the trusted path: the live run
// showed the auth form's Sign In submit never fired under synthetic input (fields read back OK but
// no outcome — the auth app likely doesn't register native-setter values in its own state, leaving
// the submit inert), and auth is a tiny fraction of run time (~4 fields + a few clicks), so trusted
// is the right trade there. Reset to false at every cdpAttach; recon/replay/onboarding never enable it.
let _synthInputEnabled = false;
function cdpSetSyntheticInput(on) {
  _synthInputEnabled = !!on;
  if (on) console.log("[ApplyPilot][CDP] synthetic input ENABLED for this run's fill — hidden-tab actuation dispatches page-side (trusted when visible; forceTrustedInput overrides).");
}
function cdpSyntheticInputEnabled() { return _synthInputEnabled; } // so a caller can SAVE/RESTORE around a deliberately-trusted step
// The self-ID surface ignores synthetic native-setter WRITES (Workday reported Name and Date empty on a
// page whose DOM held both) but accepts synthetic CLICKS — the disability checkbox committed and held
// 2/2 under synthetic, while trusted clicks on it produced the intermittent "did not commit". So the
// mode is per-KIND there, not per-page: text/date trusted, clicks synthetic.
let _trustedText = false;
function cdpSetTrustedText(b) { _trustedText = !!b; }
function cdpTrustedTextEnabled() { return _trustedText; }

// kind: "text" for value-writing paths (insertText / typeChars / keyTap / selectAllDelete / the date
// triple-click), anything else = a plain click.
async function cdpSynthInput(kind) {
  if (!_synthInputEnabled || _forceTrustedInput) return false;
  if (_trustedText && kind === "text") return false;
  // POLICY (2026-08-05): synthetic on form pages REGARDLESS of visibility. This used to ask "is the tab
  // hidden?" (and briefly "is it painting?"), on the assumption trusted input was only expensive when
  // frames were missing. Measured otherwise: the same page 2 took 11s hidden/synthetic and 14-38s
  // visible/trusted, with the paint probe confirming the 38.3s run WAS painting. Trusted Input.* is
  // simply dearer per event — it traverses the browser's input pipeline — and page 2 is event-bound.
  // Synthetic is the repertoire this file already proves on form pages, and every verify gate
  // (read-backs, chip/persistence re-reads, the M40 audit) is unchanged, so a synthetic no-op still
  // ends needs_review rather than a wrong value. Trusted is kept exactly where it is REQUIRED: the auth
  // form (own attach, never armed), the self-ID text/date fields (above), and the submit click
  // (cdpSetSyntheticInput(false) immediately before it).
  return true;
}

// In-page synthetic click (self-contained; evaluated via cdpEval). Dispatches the page-engine's
// proven pointer→mouse→click sequence on the element at (x,y) — clickCount/detail 1..n for a
// triple-click. Bumps window.__apActing around the dispatch so the operator input-lock's
// capture-phase blockers pass the bot's own events (the attachResume lesson).
function cdpSynthClickAt(x, y, clicks) {
  const els = (document.elementsFromPoint && document.elementsFromPoint(x, y)) || [];
  let el = els[0] || document.elementFromPoint(x, y);
  if (el && el.getAttribute && el.getAttribute("data-automation-id") === "click_filter" && els[1]) el = els[1]; // Workday's transparent overlay — the control beneath is the real target
  while (el && el.shadowRoot && el.shadowRoot.elementFromPoint) { // descend OPEN shadow roots (Simplify's dismiss X)
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return { ok: false, reason: "no element at point" };
  window.__apActing = (window.__apActing || 0) + 1;
  try {
    const mouse = (type, detail) => { try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail })); } catch (e) {} };
    const pointer = (type, detail) => { try { el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, button: 0, detail })); } catch (e) {} };
    const n = Math.max(1, clicks || 1);
    for (let i = 1; i <= n; i++) {
      pointer("pointerdown", i);
      mouse("mousedown", i);
      // Mimic trusted mousedown's default action: FOCUS the target (or its focusable self) so
      // follow-on activeElement-targeted key dispatches (Escape/Enter/typing) land correctly.
      try { if (i === 1 && el.focus && el.matches && el.matches("input,textarea,button,select,a[href],[tabindex]")) el.focus(); } catch (e) {}
      pointer("pointerup", i);
      mouse("mouseup", i);
      mouse("click", i);
    }
    const tag = (el.getAttribute && (el.getAttribute("data-automation-id") || el.id)) || el.tagName;
    return { ok: true, hit: String(tag || "") };
  } finally { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }
}

// In-page synthetic key tap (keydown+keyup on the FOCUSED element). Recreates the two default
// actions the fill relies on (Tab → blur; Space → activation click). Legacy keyCode/which are
// defined for widgets that still read them.
function cdpSynthKeyTap(key, code, vk, modifiers) {
  const el = document.activeElement || document.body;
  window.__apActing = (window.__apActing || 0) + 1;
  try {
    const m = modifiers || 0;
    const init = { key, code, bubbles: true, cancelable: true, composed: true, view: window,
      altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8) };
    const mk = (type) => {
      const e = new KeyboardEvent(type, init);
      try { Object.defineProperty(e, "keyCode", { get: () => vk }); Object.defineProperty(e, "which", { get: () => vk }); } catch (x) { /* legacy props best-effort */ }
      return e;
    };
    el.dispatchEvent(mk("keydown"));
    el.dispatchEvent(mk("keyup"));
    if (key === "Tab") { try { el.blur(); } catch (e) {} }   // the Tab-blur clean non-commit exit (Workday's blur handler does the abandoning)
    if (key === " ") { try { el.click(); } catch (e) {} }    // focus+Space radio fallback → activation
    return true;
  } finally { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }
}

// In-page synthetic text entry: native-setter REPLACE of the focused editable's whole value +
// input/change (the React fill technique — the page engine's proven text path). withKeystroke
// wraps the set in a keydown/keyup of the LAST character so keystroke-armed listeners (the
// typeahead highlight) still see a key — the closest synthetic analog of finishing real typing.
function cdpSynthSetValue(text, withKeystroke) {
  const el = document.activeElement;
  if (!el || !("value" in el)) return { ok: false, reason: "no editable element focused" };
  window.__apActing = (window.__apActing || 0) + 1;
  try {
    const s = String(text == null ? "" : text);
    const ch = withKeystroke && s.length ? s.slice(-1) : null;
    const keyInit = ch ? { key: ch, bubbles: true, cancelable: true, composed: true } : null;
    if (keyInit) { try { el.dispatchEvent(new KeyboardEvent("keydown", keyInit)); } catch (e) {} }
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, s); else el.value = s;
    try { el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: s })); }
    catch (e) { try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (x) {} }
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
    if (keyInit) { try { el.dispatchEvent(new KeyboardEvent("keyup", keyInit)); } catch (e) {} }
    return { ok: true, value: el.value };
  } finally { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }
}

// ── Committing a field before the page is saved (2026-07-28) ─────────────────
// Workday validates a field on BLUR. Real typing ends with the user moving away, which fires
// blur/focusout; `cdpSynthSetValue` fires keydown/input/change/keyup and NOTHING ELSE, and the only
// thing that blurs a synthetic-filled field is the NEXT synthetic click calling el.focus() (which fires
// the previous element's blur as a side effect). So the LAST field filled on a page is still focused
// when Save & Continue is clicked, and its blur — hence Workday's validation commit — races the submit
// in the same tick. Live on a HIDDEN solarturbines replay, page 5: every value physically correct and
// verified, and Save came back "The field Name is required and must have a value" + the same for Date.
// The operator's own workaround is the proof: *click into the field, then press Next, and the error goes
// away* — that is a focus/blur cycle with time to land.
//
// Two primitives, used at two moments:
//   • cdpCommitPendingEdits  — PREVENTIVE, run just before every Save & Continue: blur whatever is
//     focused so the page has no uncommitted edit when it's submitted.
//   • cdpNudgeFieldCommit    — CURATIVE, run only when Workday claims a field is empty that visibly
//     holds a value: focus → change → blur each of that field's inputs, reproducing the manual fix.
// Both use the REAL .focus()/.blur() methods, so the browser sequences genuine focus events; nothing
// here touches a VALUE, so neither can turn a correct fill into a wrong one.
function cdpCommitPendingEdits() {
  const el = document.activeElement;
  if (!el || el === document.body || typeof el.blur !== "function") return { blurred: false };
  const editable = (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  if (!editable) return { blurred: false, skipped: el.tagName };
  const tag = (el.getAttribute && (el.getAttribute("data-automation-id") || el.getAttribute("aria-label"))) || el.tagName;
  window.__apActing = (window.__apActing || 0) + 1;
  try {
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) { /* handlers are best-effort */ }
    el.blur();                       // REAL blur → the browser fires blur + focusout in the right order
    return { blurred: true, tag: String(tag || "") };
  } catch (e) {
    return { blurred: false, error: String(e) };
  } finally { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }
}

// Focus→change→blur every value-bearing input inside each wrapper. For a DATE composite that walks the
// month/day/year spinbuttons exactly as tabbing through them would. Checkboxes/radios are SKIPPED — their
// commit is the click itself (already read-back verified), and they have no pending-edit state to flush.
function cdpNudgeFieldCommit(wrapperSels) {
  const out = [];
  const sels = Array.isArray(wrapperSels) ? wrapperSels : [];
  window.__apActing = (window.__apActing || 0) + 1;
  try {
    for (const sel of sels) {
      let w = null;
      try { w = document.querySelector(sel); } catch (e) { w = null; }
      if (!w) { out.push({ sel, nudged: 0, reason: "wrapper not on the page" }); continue; }
      const inputs = Array.prototype.slice.call(w.querySelectorAll('input, textarea, [contenteditable="true"]'))
        .filter((el) => !el.disabled && el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio" && el.type !== "file");
      let n = 0;
      for (const el of inputs) {
        try {
          el.focus();
          if (document.activeElement !== el) continue;   // couldn't focus it — a nudge that didn't happen
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.blur();
          n++;
        } catch (e) { /* per-input best effort; the caller re-checks the errors either way */ }
      }
      out.push({ sel, nudged: n, inputs: inputs.length });
    }
    return out;
  } finally { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }
}

// ── Diagnosing a "required" error on a field that LOOKS filled (2026-07-28, round 2) ─────────────────
// The blur-commit fix (cdpCommitPendingEdits / cdpNudgeFieldCommit) did NOT clear it, so the mechanism is
// something else and a third guess is not worth making. This is READ-ONLY and dumps, at the moment of the
// failure, the facts that separate the hypotheses that remain — the same "make the next occurrence answer
// it" move that settled the auth-render halts:
//
//   • H1 the DOM holds the value and Workday's model disagrees anyway
//        ⇒ domValue set, reactValue set
//   • H2 the value REVERTED after we verified it (the "watched it uncheck itself" class on this very page)
//        ⇒ domValue EMPTY
//   • H3 React's internal state never took the value, so its next render will wipe it
//        ⇒ domValue set, reactValue EMPTY/different  ← the native-setter didn't reach React
//   • H4 the error is STALE — rendered before our fill, and the Save click was actually swallowed
//        ⇒ errorsInsideWrapper false / the error node is a page-level banner only
//   • H5 the DATE composite is the odd one out (spinbuttons carry aria-valuenow, not value)
//        ⇒ per-segment value vs ariaValueNow disagree
//
// Reading React's internals is the load-bearing part: `value` in the DOM and React's `memoizedProps.value`
// are exactly what diverge when a native-setter write doesn't notify React, and that divergence is
// invisible to every check we already have (read-backs, the M40 audit and the page scan all read the DOM).
function cdpDiagnoseFieldCommit(wrapperSels) {
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  // React attaches its fiber/props under keys like "__reactProps$hash" — the ONLY way to see the state
  // the component will re-render from. Defensive throughout: an internals change must degrade to nulls,
  // never throw inside a diagnostic.
  const reactOf = (el) => {
    const out = { propsValue: undefined, fiberValue: undefined, propsKeys: null };
    try {
      const keys = Object.keys(el);
      const pk = keys.find((k) => k.indexOf("__reactProps$") === 0);
      const fk = keys.find((k) => k.indexOf("__reactFiber$") === 0);
      if (pk && el[pk]) { out.propsValue = el[pk].value; out.propsKeys = Object.keys(el[pk]).slice(0, 12).join(","); }
      if (fk && el[fk]) {
        let f = el[fk];
        for (let i = 0; i < 4 && f; i++) {
          if (f.memoizedProps && "value" in f.memoizedProps) { out.fiberValue = f.memoizedProps.value; break; }
          f = f.return;
        }
      }
    } catch (e) { out.error = String(e); }
    return out;
  };

  const errorNodes = Array.prototype.slice.call(document.querySelectorAll('[data-automation-id*="rror" i], [role="alert"]'))
    .map((n) => ({ automationId: n.getAttribute("data-automation-id") || null, role: n.getAttribute("role") || null, text: clean(n.textContent).slice(0, 200), node: n }));

  const fields = (Array.isArray(wrapperSels) ? wrapperSels : []).map((sel) => {
    let w = null;
    try { w = document.querySelector(sel); } catch (e) { w = null; }
    if (!w) return { sel, present: false };
    const inputs = Array.prototype.slice.call(w.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="spinbutton"]'))
      .map((el) => {
        const r = reactOf(el);
        return {
          tag: el.tagName,
          automationId: el.getAttribute("data-automation-id") || null,
          type: el.getAttribute("type") || null,
          role: el.getAttribute("role") || null,
          domValue: "value" in el ? el.value : null,
          defaultValue: "defaultValue" in el ? el.defaultValue : null,
          textContent: el.isContentEditable ? clean(el.textContent).slice(0, 60) : null,
          ariaValueNow: el.getAttribute("aria-valuenow"),      // date spinbuttons live here, not in .value
          ariaInvalid: el.getAttribute("aria-invalid"),
          ariaRequired: el.getAttribute("aria-required"),
          checked: el.type === "checkbox" || el.type === "radio" ? !!el.checked : null,
          disabled: !!el.disabled,
          isActiveElement: el === document.activeElement,
          reactPropsValue: r.propsValue === undefined ? "(none)" : r.propsValue,
          reactFiberValue: r.fiberValue === undefined ? "(none)" : r.fiberValue,
          reactPropsKeys: r.propsKeys,
        };
      });
    // Is the error rendered INSIDE this field's wrapper (its own validation) or only in the page-level
    // banner (possibly stale — H4)? The node scan alone got this WRONG live: it reported "NONE" while the
    // wrapper's own text plainly read "Error: The field Name is required…", because Workday's inline error
    // element carries neither an "error"-ish automation-id nor role="alert". So fall back to the wrapper's
    // TEXT, which is the thing the operator actually sees.
    const wrapperText = clean(w.textContent).slice(0, 240);
    const inside = errorNodes.filter((e) => { try { return w.contains(e.node); } catch (x) { return false; } })
      .map((e) => ({ automationId: e.automationId, text: e.text }));
    const inlineErrorText = (clean(w.textContent).match(/Error:\s*[^]*?(?=$|Error:)/) || [null])[0];
    return { sel, present: true, wrapperText, inputs, errorsInsideWrapper: inside,
      inlineErrorInWrapperText: inlineErrorText ? String(inlineErrorText).slice(0, 160) : null };
  });

  return {
    url: location.href,
    activeElement: (function () {
      const a = document.activeElement;
      if (!a || a === document.body) return "(body/none)";
      return (a.getAttribute && (a.getAttribute("data-automation-id") || a.getAttribute("aria-label"))) || a.tagName;
    })(),
    fields,
    allErrorNodes: errorNodes.map((e) => ({ automationId: e.automationId, role: e.role, text: e.text })),
  };
}

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
// BATCHED SEND (2026-07-25 — the hidden input-pipeline stall): on a HIDDEN tab each awaited
// Input.dispatch* ack stalls ~1.2–1.5s (input processing rides compositor-frame scheduling, and a
// hidden tab produces no frames — the [CDP-TIME] evidence: per-field cost scaled with the input-event
// count across BOTH pacing regimes). chrome.debugger.sendCommand delivers in order per target, so we
// ISSUE the sequence back-to-back and await the acks together — the renderer's input queue drains the
// whole burst in one beat instead of paying one stall per event. Event order/semantics unchanged.
async function cdpClickAt(x, y) {
  // HIDDEN → synthetic page-side dispatch (fast; see the synthetic-input block above). A miss
  // (no element at the point / eval hiccup) falls through to the trusted path below.
  if (await cdpSynthInput()) {
    try {
      const r = await cdpEval(cdpSynthClickAt, Math.round(x), Math.round(y), 1);
      if (r && r.ok) { inputLog("click(synth)", "(" + Math.round(x) + "," + Math.round(y) + ") → " + r.hit); return; }
    } catch (e) { /* fall through to trusted */ }
  }
  inputLog("click", "(" + Math.round(x) + "," + Math.round(y) + ")");
  if (inputLockActive) await actingDelta(+1);
  try {
    const base = { x: Math.round(x), y: Math.round(y), pointerType: "mouse" };
    await Promise.all([
      cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0 }),
      cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", ...base, button: "left", buttons: 1, clickCount: 1 }),
      cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, button: "left", buttons: 0, clickCount: 1 })
    ]);
  } finally { if (inputLockActive) await actingDelta(-1); }
}

// Canonical triple-click (clickCount 1→2→3) — focuses a date spinbutton's 0-box
// `-input` by clicking its VISIBLE `-display` sibling (M33 proven recipe; the
// masked input can't be coordinate-clicked directly).
async function cdpTripleClickAt(x, y) {
  // HIDDEN → synthetic triple-click. NOTE: synthetic events don't run the browser's select-on-
  // triple-click default — the date path tolerates this because (a) focusDateSegment's ladder
  // falls to el.focus() when the click didn't focus, and (b) synthetic typing REPLACES the whole
  // segment value (cdpSynthSetValue), which is exactly what select+type achieved.
  if (await cdpSynthInput("text")) {
    try {
      const r = await cdpEval(cdpSynthClickAt, Math.round(x), Math.round(y), 3);
      if (r && r.ok) { inputLog("triple-click(synth)", "(" + Math.round(x) + "," + Math.round(y) + ") → " + r.hit); return; }
    } catch (e) { /* fall through to trusted */ }
  }
  inputLog("triple-click", "(" + Math.round(x) + "," + Math.round(y) + ")");
  if (inputLockActive) await actingDelta(+1);
  try {
    const base = { x: Math.round(x), y: Math.round(y), button: "left", pointerType: "mouse" };
    // BATCHED SEND (2026-07-25): issue the whole move + 3×(press/release) sequence back-to-back and
    // await together — in-order delivery holds, and a hidden tab pays ONE input-pipeline drain for
    // the burst instead of seven (see cdpClickAt).
    const sends = [cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: base.x, y: base.y, button: "none", buttons: 0, pointerType: "mouse" })];
    for (let i = 1; i <= 3; i++) {
      sends.push(cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1, clickCount: i }));
      sends.push(cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0, clickCount: i }));
    }
    await Promise.all(sends);
  } finally { if (inputLockActive) await actingDelta(-1); }
}

// Insert text into the FOCUSED editable as one IME-style commit — fires trusted
// beforeinput/input (no per-key events). Recon (a) decides if this is enough
// for Workday's React or whether per-char key events are needed.
async function cdpInsertText(text) {
  // HIDDEN → native-setter REPLACE + input/change (the React fill technique). Every call site
  // inserts after a clear/select-all, where replace ≡ insert; the caller's read-back poll gates it.
  if (await cdpSynthInput("text")) {
    try {
      const r = await cdpEval(cdpSynthSetValue, String(text), false);
      if (r && r.ok) { inputLog("insertText(synth)", JSON.stringify(String(text))); return; }
    } catch (e) { /* fall through to trusted */ }
  }
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
  // HIDDEN → synthetic keydown+keyup on the focused element (Tab additionally blurs; Space
  // additionally activates — the two default actions the fill relies on). Enter/Escape are
  // page-handled (Workday listens for the key events themselves), so the dispatch suffices.
  if (await cdpSynthInput("text")) {
    try {
      await cdpEval(cdpSynthKeyTap, def.key, def.code, def.vk, def.modifiers || 0);
      inputLog("key(synth)", JSON.stringify(def.key) + (def.modifiers ? " +mod" + def.modifiers : ""));
      return;
    } catch (e) { /* fall through to trusted */ }
  }
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
    // BATCHED SEND (2026-07-25): down+up issued back-to-back, awaited together — one hidden-tab
    // input-pipeline drain per tap instead of two (see cdpClickAt). Text insertion rides the keyDown.
    await Promise.all([
      cdpSend("Input.dispatchKeyEvent", down),
      cdpSend("Input.dispatchKeyEvent", {
        type: "keyUp", key: def.key, code: def.code,
        windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk,
        modifiers: def.modifiers || 0
      })
    ]);
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
  // HIDDEN → ONE native-setter REPLACE with a last-char keystroke wrap (cdpSynthSetValue) instead of
  // per-char key events — synthetic key events insert no text (no default actions), and this is also
  // the big hidden win (a 35-char typeahead candidate = 70 frame-gated Input commands ≈ 40s → 1 eval).
  // REPLACE is correct at every call site: typing always follows a clear (typeInSearch) or a
  // select-all (dates — where replace ≡ what select+type achieved); the read-back/chip gates verify.
  // WHICH PATH TYPED, and what it cost. Added 2026-08-08 chasing the field-of-study lag: the story
  // "trusted per-char typing is the slow part" only holds if the trusted path RAN, and during a fill walk
  // synthetic is enabled regardless of visibility — so the fall-through below is the interesting event,
  // not the happy path. Logged only when it costs real time, so a healthy field stays quiet.
  const _tcT0 = Date.now();
  if (await cdpSynthInput("text")) {
    try {
      const r = await cdpEval(cdpSynthSetValue, String(text), true);
      if (r && r.ok) {
        const ms = Date.now() - _tcT0;
        if (ms > 800) console.log(`[ApplyPilot][CDP-TYPE] page-side write took ${ms}ms for ${String(text).length} chars — the eval itself was slow, not the keystrokes.`);
        inputLog("typeChars(synth)", JSON.stringify(String(text)));
        return;
      }
      console.log(`[ApplyPilot][CDP-TYPE] page-side write DECLINED (${(r && r.reason) || "no ok"}) — falling back to trusted per-char for ${String(text).length} chars.`);
    } catch (e) {
      console.log(`[ApplyPilot][CDP-TYPE] page-side write THREW (${String((e && e.message) || e).slice(0, 80)}) — falling back to trusted per-char for ${String(text).length} chars.`);
    }
  }
  // Per-char gap is ADAPTIVE (Stage B): fast (fg / worker-fast) → scale by FAST_FACTOR but keep the
  // typing-specific TYPE_FAST_FLOOR_MS (> FAST_FLOOR_MS) so keystroke-driven listeners still arm the
  // typeahead's first-option highlight (cdpTypeChars is the KEYSTROKE path chosen over insertText for
  // exactly that — see typeInSearch). Slow path (hidden no-worker) keeps the full perCharDelayMs. Sampled
  // ONCE (not per char — no per-keystroke round-trip). A too-fast type that misses is caught downstream
  // (chip/value read-back → needs_review), never a silent wrong fill.
  const fast = await cdpFast();
  const gap = fast ? Math.max(TYPE_FAST_FLOOR_MS, Math.round(perCharDelayMs * FAST_FACTOR)) : perCharDelayMs;
  // ── ESCALATE OFF A MEASURED STALL (operator, 2026-08-08) ────────────────────────────────────────
  // Trusted input rides compositor-frame scheduling, so a tab that is NOT PAINTING stalls ~1.2-1.5s per
  // event — and this loop spends TWO events per character. "Electrical and Computer Engineering" is 35
  // chars ≈ 70 commands ≈ 90s. That is the field-of-study lag the operator watched: not the option
  // scrape, but the typing right after it.
  //
  // Synthetic mode already avoids this, but it only engages when the tab reports HIDDEN — and an
  // OCCLUSION (alt-tabbed behind another window) still reports `tab.active && !minimized`, so the label
  // says visible while the compositor produces no frames. Rather than trust the label, MEASURE the first
  // keystroke: if it comes back pathologically slow, the remaining characters would each cost the same,
  // so finish the whole string with the page-side native-setter REPLACE (exactly what the hidden path
  // above does). Same escalate-on-evidence shape as the dropdown commit's beat ladder.
  //
  // Safe because it changes only HOW the text lands, never whether it is verified: every call site
  // follows a clear/select-all (so REPLACE ≡ what typing achieved) and gates on the echo/read-back poll,
  // so a synthetic write that does not register still ends needs_review rather than a wrong value.
  const chars = Array.from(String(text));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isLetter = /^[a-z]$/i.test(ch);
    const isDigit = /^[0-9]$/.test(ch);
    const code = isLetter ? "Key" + ch.toUpperCase() : isDigit ? "Digit" + ch : ch === " " ? "Space" : "";
    const vk = isLetter || isDigit ? ch.toUpperCase().charCodeAt(0) : ch === " " ? 32 : 0;
    const t0 = Date.now();
    await cdpKeyTap({ key: ch, code, vk, text: ch });
    const dt = Date.now() - t0;
    if (i === 0 && dt >= TYPE_STALL_ESCALATE_MS && chars.length > 4) {
      const projected = Math.round((dt * chars.length) / 1000);
      try {
        const r = await cdpEval(cdpSynthSetValue, String(text), true);
        if (r && r.ok) {
          console.log(`[ApplyPilot][CDP] typing STALLED (${dt}ms for one keystroke — the tab is not painting, so trusted input is frame-gated);`
            + ` ${chars.length} chars would have taken ~${projected}s. Switched to the page-side write for this value.`);
          inputLog("typeChars(escalated-synth)", JSON.stringify(String(text)));
          return;
        }
      } catch (e) { /* page-side write unavailable — keep typing, slowly but correctly */ }
    }
    await cdpDelay(gap);
  }
  // The trusted per-char path actually ran. Report what it cost per keystroke — that number is the whole
  // argument: ~10-30ms is a painting tab, ~1.1-1.5s is a frame-gated one.
  const _tcMs = Date.now() - _tcT0;
  if (_tcMs > 1200) {
    console.log(`[ApplyPilot][CDP-TYPE] TRUSTED per-char typing: ${chars.length} chars in ${_tcMs}ms`
      + ` (~${Math.round(_tcMs / Math.max(1, chars.length))}ms/char, gap ${gap}ms) — ${await cdpPaintLabel()}.`);
  }
}

// Clear the FOCUSED text input: Select-All (Ctrl+A — Windows/Linux modifier 2)
// then Delete. Trusted key path so React sees a real edit, unlike a "" setter.
// HIDDEN → native-setter "" + input/change (the page engine's proven "clear before typing"
// pattern) — synthetic Ctrl+A/Delete run no default actions, so the key path can't clear there.
async function cdpSelectAllDelete() {
  if (await cdpSynthInput("text")) {
    try {
      const r = await cdpEval(cdpSynthSetValue, "", false);
      if (r && r.ok) { inputLog("selectAllDelete(synth)", '""'); return; }
    } catch (e) { /* fall through to trusted */ }
  }
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
    // `source` is the hierarchical picker on the tenants that shaped this rule — but NOT everywhere.
    // Aptiv renders it as a plain dropdown (button[aria-haspopup="listbox"], no multiselect container,
    // no search box), and the name-first shortcut routed it to the typeahead filler, which waits for a
    // searchBox that never mounts: "could not focus the search field", present:false on every attempt,
    // and on the REPLAY that halts the whole run. So require the multiselect SHAPE, and let anything
    // else fall through to the ladder below and be classified as what it actually is.
    //
    // The searchBox itself is no use as a marker here: it only mounts once the widget is OPEN. These
    // three are present while closed.
    if (fieldName === "source" && (wrapper.querySelector('[data-uxi-widget-type="multiselect"]') || wrapper.querySelector('[data-automation-id="multiselectInputContainer"]') || wrapper.hasAttribute("data-automation-hiddensearch"))) return "hierarchical";
    if (wrapper.querySelector('input[type="file"]')) return "file_upload";
    if (wrapper.querySelector('[data-uxi-widget-type="multiselect"]')) return "typeahead";
    if (wrapper.querySelector('input[type="radio"]')) return "radio";
    if (wrapper.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    if (wrapper.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    // CHECKBOX GROUP (2026-07-25, Caterpillar's OFCCP disability self-ID): several checkboxes in ONE
    // wrapper acting as a pick-one ("Yes, I have a disability…" / "No…" / "I do not want to answer" —
    // the operator had to UNCHECK the current one to change it). Previously fell through to "unknown",
    // which the review editor renders as a bare TEXTBOX. Radio-like, so it gets radio-like handling.
    if (wrapper.querySelectorAll('input[type="checkbox"]').length > 1) return "checkbox_group";
    // DATE composite (2026-07-25): Workday renders a date as 2–3 `dateSection*-input` spinbuttons in a
    // `dateInputWrapper`. Those inputs have NO type attribute, so they counted as "text-like" — three of
    // them meant textLike.length !== 1 and the field fell through to "unknown", i.e. a bare TEXTBOX in
    // review with no idea whether the form wants MM/YYYY or MM/DD/YYYY (live: Caterpillar's self-ID
    // "Date"). The segment ids also give the ORDER + granularity, carried as dateSegments below.
    if (wrapper.querySelector('[data-automation-id^="dateSection"][data-automation-id$="-input"]')) return "date";
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
  // REVIEW ORDER (2026-07-25, operator): which repeating SECTION does a repeating wrapper belong to?
  // (the fkit base of the nearest indexed ancestor, e.g. "workExperience-2--null" → "workExperience").
  // Paired with the document-order index below it lets the review list flat fields and repeating
  // sections INTERLEAVED exactly as the form lays them out, instead of all-flat-then-all-sections.
  const sectionBaseOf = (w) => {
    let el = w.closest("[data-fkit-id]");
    while (el) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)-\d+--/.exec(el.getAttribute("data-fkit-id") || "");
      if (m) return m[1];
      el = el.parentElement ? el.parentElement.closest("[data-fkit-id]") : null;
    }
    return null;
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
      if (wt === "checkbox_group") { // EVERY checked label, joined — a group can be genuinely MULTI
        // (PSECU's ethnicityMulti keeps two checked and saves both). Reading only the FIRST :checked
        // silently dropped the rest, so a two-answer field looked like a one-answer field everywhere
        // downstream — review, audit, replay.
        const cs = Array.from(wr.querySelectorAll('input[type="checkbox"]:checked'));
        if (!cs.length) return null;
        return cs.map((c) => {
          const lab = c.id ? document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(c.id) : c.id) + '"]') : null;
          return lab ? (lab.textContent || "").trim() : "selected";
        }).join("; ");
      }
      const segs = Array.from(wr.querySelectorAll('[data-automation-id^="dateSection"][data-automation-id$="-display"]')).map((s) => (s.textContent || "").trim()).filter((t) => t && !/^[MDY]+$/.test(t));
      if (segs.length) return segs.join("/");
      const inp = wr.querySelector("input, textarea"); return inp ? (inp.value || null) : null;
    } catch (e) { return null; }
  };
  const all = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
  // Document-order position of EVERY formField wrapper (flat + repeating) — the ordering key the
  // review uses. A repeating SECTION's position is the position of its FIRST field, so a flat field
  // that sits between two sections on the form stays between them in the review.
  const domPos = new Map();
  const sectionOrder = {};
  all.forEach((w, i) => {
    domPos.set(w, i);
    const b = isRepeating(w) ? sectionBaseOf(w) : null;
    if (b && sectionOrder[b] === undefined) sectionOrder[b] = i;
  });
  const wrappers = all.filter((w) => !isRepeating(w));
  return {
    url: location.href,
    repeatingFieldCount: all.length - wrappers.length,
    sectionOrder,
    fields: wrappers.map((w) => {
      const id = w.getAttribute("data-automation-id");
      const wt = classify(w);
      const d = {
        wrapperSel: '[data-automation-id="' + id + '"]',
        fieldName: id.slice("formField-".length),
        widgetType: wt,
        label: labelOf(w),
        isRequired: requiredOf(w),
        value: valueOf(w, wt),
        domIndex: domPos.get(w)
      };
      // Date segment ids in DOM order ("dateSectionMonth-input", "dateSectionDay-input", …) → the
      // review renders the form's OWN granularity/order (MM/DD/YYYY vs MM/YYYY vs YYYY), not a locale
      // date picker. Same shape cdpRepeatingScan already returns for section dates.
      if (wt === "date") {
        d.dateSegments = Array.from(w.querySelectorAll('[data-automation-id^="dateSection"]'))
          .map((n) => n.getAttribute("data-automation-id")).filter(Boolean);
      }
      // A checkbox GROUP carries its option labels straight from the DOM — READ-ONLY, no open/actuation
      // needed (unlike a dropdown), so the review editor can render a real picker even when the field is
      // left BLANK (an optional EEO/self-ID question the bot must never answer — the operator picks).
      if (wt === "checkbox_group") {
        d.groupOptions = Array.from(w.querySelectorAll('input[type="checkbox"]')).map((cb) => {
          const lab = cb.id ? document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(cb.id) : cb.id) + '"]') : null;
          return { id: cb.id || null, labelText: lab ? (lab.textContent || "").trim() : (cb.getAttribute("aria-label") || "").trim(), checked: !!cb.checked };
        }).filter((o) => o.labelText);
      }
      return d;
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
    // `source` is the hierarchical picker on the tenants that shaped this rule — but NOT everywhere.
    // Aptiv renders it as a plain dropdown (button[aria-haspopup="listbox"], no multiselect container,
    // no search box), and the name-first shortcut routed it to the typeahead filler, which waits for a
    // searchBox that never mounts: "could not focus the search field", present:false on every attempt,
    // and on the REPLAY that halts the whole run. So require the multiselect SHAPE, and let anything
    // else fall through to the ladder below and be classified as what it actually is.
    //
    // The searchBox itself is no use as a marker here: it only mounts once the widget is OPEN. These
    // three are present while closed.
    if (fieldName === "source" && (w.querySelector('[data-uxi-widget-type="multiselect"]') || w.querySelector('[data-automation-id="multiselectInputContainer"]') || w.hasAttribute("data-automation-hiddensearch"))) return "hierarchical";
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
    // Workday's TRANSIENT "Something went wrong / please refresh" soft-error (apology + refresh cue).
    // LOCKSTEP with lib.js isWorkdaySoftError — computed here (full bodyText in scope) because the walk
    // only gets bodyTextSample SW-side; the walk reloads-and-retries the page when this is set.
    softErrorPresent:
      (/something went wrong|an? (unexpected )?error (has )?occurred|we('| ?a)?re sorry/i.test(bodyText)) &&
      (/refresh (the|this) page|please refresh|try again/i.test(bodyText)),
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

// ── Onboarding-stage reads (JD → Apply → Apply Manually → auth → verify) ─────
// Self-contained page reads for the pre-form flow. The PURE decisions on this data
// live in lib.js (classifyAuthOutcome / isWorkdaySoftError / looksLikeSso /
// pickApplyTarget); this just surfaces the raw DOM state. Kept SEPARATE from
// cdpReadSessionState (which is tuned for the in-flow dead-session / review checks
// and caps bodyText at 500 chars — too short to classify a sign-in outcome).
function cdpOnboardScan() {
  const q = (sel) => document.querySelector(sel);
  const present = (sel) => !!document.querySelector(sel);
  const bodyText = ((document.body && document.body.innerText) || "").slice(0, 12000);
  const formFields = document.querySelectorAll('[data-automation-id^="formField-"]');
  const clickables = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const signInButtonPresent = clickables.some((b) => /\b(sign[- ]?in|log[- ]?in|sign[- ]?on)\b/i.test((b.textContent || "").trim()));
  const emailInput = present('input[type="email"]') || present('[data-automation-id="email"]');
  const passwordInput = present('input[type="password"]') || present('[data-automation-id="password"]');
  // Social-login CHOOSER (e.g. Palo Alto Networks wd5): the email/password form is behind a
  // "Sign in with email" button, alongside federated Apple/Google/LinkedIn buttons we NEVER click.
  //
  // The automation-id is NOT stable across tenants (sonos.wd1, 2026-08-09): its chooser renders the
  // same button with a HASHED id, so the page had zero inputs, this read false, and the run halted
  // `auth-form-not-rendered` — visible AND hidden, on a screen a human signs into fine. Fall back to
  // the button's own text, which is what a human reads. Safe against the federated buttons beside it:
  // they say "Sign in with Apple" / "Sign in with Google", and neither contains "email".
  const signInWithEmail = present('[data-automation-id="SignInWithEmailButton"]')
    || clickables.some((b) => /\bsign[- ]?in\s+with\s+email\b/i.test((b.textContent || "").trim()));
  const markers = {
    adventureButton: present('[data-automation-id="adventureButton"]'),
    continueButton: present('[data-automation-id="continueButton"]'),
    applyManually: present('[data-automation-id="applyManually"]'),
    // "Autofill with Resume" — the chooser option that makes Workday PARSE the résumé and pre-populate
    // the application, including the Skills section with its own suggested skills (traced 2026-08-07 on
    // cat.wd5). Preferred for a FIRST application; never used by a rehearse/submit run, which must not
    // re-parse (see runCdpOnboard's preferResumeAutofill).
    autofillWithResume: present('[data-automation-id="autofillWithResume"]'),
    // The résumé-upload page that Autofill-with-Resume lands on BEFORE My Information: a page with the
    // upload input and effectively no form fields. Same automation-ids attachResume already drives.
    resumeUploadInput: present('input[type="file"][data-automation-id="file-upload-input-ref"]'),
    resumeUploadSuccess: present('[data-automation-id="file-upload-successful"]'),
    useMyLastApplication: present('[data-automation-id="useMyLastApplication"]'),
    signInLink: present('[data-automation-id="signInLink"]'),
    createAccountLink: present('[data-automation-id="createAccountLink"]'),
    signInSubmit: present('[data-automation-id="signInSubmitButton"]') || present('[data-automation-id="click_filter"][aria-label="Sign In"]'),
    createAccountSubmit: present('[data-automation-id="createAccountSubmitButton"]') || present('[data-automation-id="click_filter"][aria-label="Create Account"]'),
    verifyPassword: present('[data-automation-id="verifyPassword"]'),
    agreementCheckbox: present('[data-automation-id="agreementCheckbox"]'),
    applyFlowPage: present('[data-automation-id="applyFlowPage"]'),
    applyFlowReviewPage: present('[data-automation-id="applyFlowReviewPage"]'),
    // "You've already applied for this job." — Workday shows a dedicated page (no form, no apply/auth
    // chrome) when the signed-in candidate already submitted for this requisition. A clean terminal
    // state, NOT an error (see isAlreadyApplied); the title can be a stale "Create Account", so the
    // automation-id is the reliable signal.
    alreadyAppliedPage: present('[data-automation-id="alreadyAppliedPage"]'),
    // Candidate-home "My Applications" list — the page the already-applied recovery navigates to in
    // order to read whether the application was REALLY submitted (2026-07-28). These automation-ids are
    // UNCONFIRMED across tenants (no recon dump captured yet), so they're a bonus signal only:
    // isMyApplicationsPage falls back to heading + status text, which is what the operator reads.
    myApplicationsPage: present('[data-automation-id="applicationsSectionHeader"]')
      || present('[data-automation-id="candidateHomePage"]')
      || present('[data-automation-id="myApplicationsPage"]'),
    formField: formFields.length > 0
  };
  // hasAuthEl: any auth chrome still on the page (blocks a false "success" — see classifyAuthOutcome).
  const hasAuthEl = passwordInput || signInWithEmail || markers.signInSubmit || markers.createAccountSubmit || markers.signInLink || markers.createAccountLink;
  // ── IS A SUBMIT IN FLIGHT? (2026-08-07, diagnostic) ──────────────────────────────────────────────
  // The retry ladder concludes "my click did not register" from the auth form still being MOUNTED —
  // which is also exactly what an in-flight submit looks like, so it re-submits a form that is already
  // working and the double submit costs a page reload. The fix needs POSITIVE evidence of a no-op, i.e.
  // some observable that flips while Workday is processing. Nobody has checked whether this form exposes
  // one, so measure before building on it: report the submit button's disabled/busy state and whether
  // the password field still holds a value. Read-only; no decision consumes this yet.
  const submitBtn = document.querySelector('[data-automation-id="signInSubmitButton"]')
    || document.querySelector('[data-automation-id="click_filter"][aria-label="Sign In"]')
    || document.querySelector('button[type="submit"]');
  const pwEl = document.querySelector('input[type="password"]');
  const authBusy = submitBtn ? {
    disabled: !!submitBtn.disabled || submitBtn.getAttribute("aria-disabled") === "true",
    busy: submitBtn.getAttribute("aria-busy") === "true",
    // A spinner/progress node anywhere in the auth widget is the other likely tell.
    spinner: !!document.querySelector('[data-automation-id*="spinner" i],[data-automation-id*="progress" i],[role="progressbar"]'),
    pwFilled: !!(pwEl && pwEl.value),
  } : null;
  // ── WHY the auth form refused (2026-08-07) ───────────────────────────────────────────────────────
  // A Sign In / Create Account that submits to nothing looked identical in the log to one that never
  // registered the click: both printed "no outcome after 20s and the form is still up". Live on
  // itron.wd5 the consent tick was FIXED and Create Account still would not go, and the log could not
  // say why — so the next move was a guess. Workday states the reason on the page; read it.
  // Distinct from bodyText (12k of everything) because the point is a SHORT, quotable cause.
  const errNodes = Array.from(document.querySelectorAll(
    '[data-automation-id="errorMessage"],[data-automation-id="formFieldErrorMessage"],[data-automation-id="validationErrorMessage"],[role="alert"],.css-error,[class*="error" i]'
  ));
  const seen = Object.create(null);
  const authErrors = [];
  for (const n of errNodes) {
    if (!n || (n.children && n.children.length > 2)) continue;   // leaf-ish nodes only — never a container
    const r = n.getBoundingClientRect && n.getBoundingClientRect();
    if (r && (r.width <= 0 || r.height <= 0)) continue;          // not rendered
    const t = ((n.textContent || "").replace(/\s+/g, " ").trim());
    if (!t || t.length > 220 || seen[t]) continue;
    seen[t] = 1;
    authErrors.push(t);
    if (authErrors.length >= 6) break;
  }
  return {
    url: location.href, host: location.host, title: document.title,
    authErrors,
    // Was the document still parsing when we read it? The auth widget can be MID-RENDER (auth chrome
    // present, email/password not in the DOM yet) — indistinguishable from "this page has no fields"
    // without this. A hidden tab makes it common; the waitFor timeout logs it (2026-07-27).
    readyState: document.readyState,
    bodyText,
    formFieldCount: formFields.length,
    emailInput, passwordInput, signInButtonPresent, signInWithEmail, hasAuthEl,
    authBusy,
    markers
  };
}

// ── Already-applied recovery reads (2026-07-28) ──────────────────────────────
// Workday sometimes shows "You've already applied for this job" for an application that was STARTED but
// never SUBMITTED (operator-observed). The only authority on which it is, is the candidate's own
// "My Applications" list. These three reads drive the recovery; every DECISION on their output is a pure
// lib.js function (isMyApplicationsPage / applicationStatusOf / pickApplicationRow / classifyWorkdayPage).
//
// DELIBERATELY GENERIC. We have no confirmed DOM for this page on any tenant, so instead of guessing an
// automation-id and silently reading nothing, this enumerates the page STRUCTURALLY (every job-ish link,
// its enclosing row, that row's text) and returns enough raw material for the SW to both decide AND, on a
// miss, PRINT what it actually saw. The first live run therefore either works or self-reports the exact
// DOM needed to tighten it — no second recon round to learn the shape.
function cdpReadApplicationsPage() {
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const STATUS_RX = /\bnot submitted\b|\bunsubmitted\b|\bsubmitted\b|\bin progress\b|\bincomplete\b|\bdraft\b|\bstarted\b|\bunder consideration\b/i;

  // A row is the smallest ancestor of the link that carries a status word — that's what makes it "a row"
  // rather than "the link" or "the whole page". Bounded climb; falls back to the nearest tr/li.
  const rowFor = (a) => {
    let el = a, best = null;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      const tag = (el.tagName || "").toLowerCase();
      if ((tag === "tr" || tag === "li") && !best) best = el;
      if (STATUS_RX.test(clean(el.textContent))) return el;
      el = el.parentElement;
    }
    return best || a.parentElement || a;
  };

  const links = Array.prototype.slice.call(document.querySelectorAll("a[href], [role='link'][href]"));
  const seen = new Set();
  const rows = [];
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    const title = clean(a.textContent);
    if (!title) continue;
    // Job-ish: a posting/application link, or a requisition id in the href/text. Skip nav chrome.
    const jobish = /\/job\/|\/apply\b|applicationId|jobRequisition|_R\d|\bR\d{5,}\b/i.test(href + " " + title);
    if (!jobish) continue;
    const row = rowFor(a);
    const rowText = clean(row.textContent).slice(0, 400);
    const key = href + "|" + title;
    if (seen.has(key)) continue;
    seen.add(key);
    let rect = null;
    try { const r = a.getBoundingClientRect(); rect = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; } catch (e) { /* off-screen */ }
    const statusMatch = rowText.match(STATUS_RX);
    rows.push({
      index: rows.length,
      title,
      href: a.href || href,                  // absolute when the browser resolved it
      text: rowText,
      statusText: statusMatch ? statusMatch[0] : null,
      rowAutomationId: (row.getAttribute && row.getAttribute("data-automation-id")) || null,
      visible: !!(rect && rect.w > 0 && rect.h > 0)
    });
  }

  // COLLAPSED sections — the operator's "sometimes the application dropdown is closed so you will have to
  // open it". Anything that advertises itself as collapsed is a candidate to expand; the SW clicks them
  // and re-reads until the row count stops growing (settle, never a fixed beat).
  const collapsed = Array.prototype.slice.call(document.querySelectorAll('[aria-expanded="false"]'))
    .map((el, i) => {
      let rect = null;
      try { const r = el.getBoundingClientRect(); rect = { w: r.width, h: r.height }; } catch (e) { /* ignore */ }
      return {
        index: i,
        label: clean(el.getAttribute("aria-label") || el.textContent).slice(0, 80),
        automationId: (el.getAttribute("data-automation-id")) || null,
        visible: !!(rect && rect.w > 0 && rect.h > 0)
      };
    })
    .filter((c) => c.visible);

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    rows,
    collapsed,
    // Diagnostic material for a miss: what the page actually is, so a failed pick prints something useful.
    headings: Array.prototype.slice.call(document.querySelectorAll("h1, h2, h3, h4")).map((h) => clean(h.textContent)).filter(Boolean).slice(0, 12),
    bodyText: clean(document.body ? document.body.innerText : "").slice(0, 4000)
  };
}

// Stamp `data-ap-click="<token>"` on the FIRST clickable whose visible text matches, so the caller can
// click it through the PROVEN clickTarget path (re-measured cover-check, auto-dismiss, coordinate click)
// instead of a second, weaker click primitive. Text-anchored clicks are unavoidable here — "View My
// Applications" and an application ROW have no stable automation-id we've confirmed.
// `rejectRx` is the safety rail: it can never tag something the caller named as off-limits.
function cdpTagClickableByText(token, textRx, rejectRx, indexHint) {
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  let want, reject = null;
  try { want = new RegExp(textRx, "i"); } catch (e) { return { tagged: false, error: "bad pattern" }; }
  if (rejectRx) { try { reject = new RegExp(rejectRx, "i"); } catch (e) { reject = null; } }

  // Clear any previous tag so a stale one can never be clicked.
  Array.prototype.forEach.call(document.querySelectorAll("[data-ap-click]"), (el) => el.removeAttribute("data-ap-click"));

  const cands = Array.prototype.slice.call(document.querySelectorAll('a[href], button, [role="button"], [role="link"]'));
  const matches = [];
  for (const el of cands) {
    const txt = clean(el.textContent) || clean(el.getAttribute("aria-label"));
    if (!txt || !want.test(txt)) continue;
    if (reject && reject.test(txt)) continue;
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (!r || r.width <= 0 || r.height <= 0) continue;         // invisible ⇒ not clickable
    matches.push({ el, text: txt.slice(0, 100), href: el.getAttribute("href") || null });
  }
  if (!matches.length) return { tagged: false, matchCount: 0 };
  const pick = (typeof indexHint === "number" && indexHint >= 0 && indexHint < matches.length) ? matches[indexHint] : matches[0];
  pick.el.setAttribute("data-ap-click", token);
  try { pick.el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* best effort */ }
  return { tagged: true, matchCount: matches.length, text: pick.text, href: pick.href };
}

// Same, but targets a specific application ROW by its href — used after pickApplicationRow chose one, so
// the click lands on exactly the row the pure matcher approved (never "the first job-ish link").
function cdpTagRowByHref(token, href) {
  Array.prototype.forEach.call(document.querySelectorAll("[data-ap-click]"), (el) => el.removeAttribute("data-ap-click"));
  const want = String(href || "");
  if (!want) return { tagged: false };
  const cands = Array.prototype.slice.call(document.querySelectorAll("a[href]"));
  const hit = cands.find((a) => a.href === want) || cands.find((a) => (a.getAttribute("href") || "") === want);
  if (!hit) return { tagged: false, tried: want.slice(0, 200) };
  hit.setAttribute("data-ap-click", token);
  try { hit.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* best effort */ }
  return { tagged: true, text: String(hit.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100) };
}

// Identity of the job-description page we landed on after clicking an application row — so the recovery
// can PROVE it's the right posting before clicking Continue Application (the operator's "make sure it is
// the correct application"). Reads the posting title, any requisition id on the page, and which apply/
// continue affordances exist.
function cdpReadJobIdentity() {
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const q = (sel) => document.querySelector(sel);
  const titleEl = q('[data-automation-id="jobPostingHeader"]') || q("h1") || q("h2");
  const body = clean(document.body ? document.body.innerText : "");
  const reqEl = q('[data-automation-id="requisitionId"]');
  return {
    url: location.href,
    title: document.title,
    postingTitle: titleEl ? clean(titleEl.textContent).slice(0, 200) : null,
    requisitionText: reqEl ? clean(reqEl.textContent).slice(0, 80) : null,
    hasContinue: !!q('[data-automation-id="continueButton"]'),
    hasApply: !!(q('[data-automation-id="adventureButton"]') || q('[data-automation-id="applyManually"]')),
    bodyText: body.slice(0, 3000)
  };
}

// Cover-check for an arbitrary selector's click point (the parametrized sibling of
// clickPageNext's inline check): is the top element at (cx,cy) the target button (or
// in its subtree)? If not, a coordinate click would be SWALLOWED by an overlay — return
// what's covering it so the caller can auto-dismiss (cdpFindDismissControl) or halt.
// STACK WALK (2026-07-25): walk the whole elementsFromPoint stack top-down and refuse only on an
// element that would REALLY swallow the click. Transparent-to-clicks, in order of how they bit us:
//   • Workday's own `click_filter` — a transparent overlay it puts on buttons to CAPTURE clicks; it IS
//     the intended click surface (PANW Sign In, 2026-07-09).
//   • `pointer-events: none` — paints but never receives the click.
//   • A shadow HOST whose shadow tree paints NOTHING at this point: elementFromPoint returns the HOST
//     for any point inside its box, so a full-width/!!invisible host (an extension's container) looked
//     like a cover everywhere. Descend via shadowRoot.elementFromPoint; nothing there ⇒ not blocking.
//   • The target itself, its ancestors, or its descendants.
// Reaching the target with only transparent things above ⇒ clear. Nothing opaque AND the target never
// appears (a stale rect after a reflow) ⇒ also clear: refusing there halted on a phantom (see
// clickPageNext's re-measure), and a click into empty space is harmless — the nav-wait gates it.
function cdpCoverCheck(selector, cx, cy) {
  const btn = document.querySelector(selector);
  if (!btn) return { blocked: false };
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
  const isTarget = (el) => el === btn || btn.contains(el) || el.contains(btn);
  const seeThrough = (el) => {
    const aid = el.getAttribute && el.getAttribute("data-automation-id");
    if (aid === "click_filter" || (el.closest && el.closest('[data-automation-id="click_filter"]'))) return true;
    let cs = null; try { cs = window.getComputedStyle(el); } catch (e) { cs = null; }
    if (cs && cs.pointerEvents === "none") return true;
    if (el.shadowRoot && el.shadowRoot.elementFromPoint) {
      const inner = el.shadowRoot.elementFromPoint(cx, cy);
      if (!inner) return true;                                  // the shadow tree paints nothing here
      let ics = null; try { ics = window.getComputedStyle(inner); } catch (e) { ics = null; }
      if (ics && ics.pointerEvents === "none") return true;
    }
    return false;
  };
  const stack = document.elementsFromPoint
    ? Array.from(document.elementsFromPoint(cx, cy))
    : [document.elementFromPoint(cx, cy)].filter(Boolean);
  for (const el of stack) {
    if (isTarget(el)) return { blocked: false };                // reached the target — only transparent things above it
    if (!seeThrough(el)) return { blocked: true, by: desc(el) };
  }
  return { blocked: false };                                    // nothing opaque anywhere in the stack
}

// Create-account CONSENT control (workday.py two strategies): the explicit
// agreementCheckbox (Capital One), else a checkbox whose associated label mentions
// consent/terms/agree/privacy (AssetMark). Returns the LABEL's click point (preferred —
// native label-activation fires React's change, the radio/checkbox lesson) + the current
// checked state + the input id, or null. Read-only; the caller coordinate-clicks + verifies.
// `mode:"activate"` ticks it FROM INSIDE THE PAGE via native label activation, instead of only
// reporting a rect for a coordinate click (2026-08-07). Why both live in one function: the FINDER is the
// hard part (the word-list fallback below), and a second copy of it would be a lockstep dup waiting to
// drift. Read stays the default, so every existing caller is unchanged.
//
// The coordinate click alone was not enough, and the reason is a STALE RECT — the same lesson
// clickPageNext learned in 2026-07-25. checkConsent measured the label, then dispatched cdpClickAt a
// full round-trip later (~1.2-1.5s on a hidden tab, where trusted input rides compositor frames), and in
// between React re-rendered the just-filled password fields' requirement list and REFLOWED the label out
// from under the saved coordinates. Live on itron.wd5 and radiancetech.wd12: the input is opacity:0 with
// a 56x20 "I agree" label, the point resolved correctly when measured, and the box still read unchecked
// afterwards — so Create Account could never submit and onboarding retried for ~12 minutes.
// This ONLY ever sets the account-creation consent the caller already decided to accept; it never
// searches for other agreements and never submits anything.
function cdpConsentRect(mode) {
  let checkbox = document.querySelector('[data-automation-id="agreementCheckbox"] input[type="checkbox"]');
  const bare = document.querySelector('[data-automation-id="agreementCheckbox"]');
  if (!checkbox && bare && bare.tagName === "INPUT") checkbox = bare;
  if (!checkbox) {
    // Word-list fallback. WIDENED 2026-07-25 (Caterpillar): its create-account consent is labeled
    // "I accept" — "accept" wasn't in the list, and the text may not live in an associated <label>
    // at all, so also read aria-label and (only when label/aria give nothing) the nearest SMALL
    // ancestor's own text (≤250 chars — a big container's text is too broad to trust; the word
    // list on SHORT nearby text keeps an unrelated checkbox, e.g. a job-alerts opt-in, unmatched).
    const CONSENT_RE = /consent|terms|agree|accept|privacy|acknowledge/;
    const textFor = (b) => {
      const lab = b.id ? document.querySelector('label[for="' + b.id + '"]') : null;
      const wrapLab = b.closest && b.closest("label");
      let t = ((lab && lab.textContent) || (wrapLab && wrapLab.textContent) || b.getAttribute("aria-label") || "").trim();
      if (!t) {
        let el = b.parentElement;
        for (let i = 0; i < 3 && el; i++) {
          const s = (el.textContent || "").trim();
          if (s) { if (s.length <= 250) t = s; break; } // first non-empty ancestor text only — never a page-wide container
          el = el.parentElement;
        }
      }
      return t.toLowerCase();
    };
    checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((b) => CONSENT_RE.test(textFor(b))) || null;
  }
  if (!checkbox) return null;
  const inputId = checkbox.id || null;
  const lab = inputId ? document.querySelector('label[for="' + inputId + '"]') : (checkbox.closest && checkbox.closest("label"));
  if (mode === "activate") {
    // Native LABEL activation first — the input is routinely CSS-clipped (opacity:0), and clicking its
    // <label for> is what flips `checked` AND fires the change event React listens for. This is the same
    // primitive the radio/checkbox fillers use. Verified in place: false -> true on itron.wd5.
    const before = !!checkbox.checked;
    if (!before) {
      if (lab && lab.click) { try { lab.click(); } catch (e) { /* fall through */ } }
      if (!checkbox.checked) { try { checkbox.click(); } catch (e) { /* fall through */ } }
      if (!checkbox.checked) {
        // Last resort: set the property and fire the events React needs. Never a silent lie — the
        // caller re-reads `checked` and reports whatever actually stuck.
        try {
          checkbox.checked = true;
          checkbox.dispatchEvent(new Event("input", { bubbles: true }));
          checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) { /* report below */ }
      }
    }
    return { checked: !!checkbox.checked, inputId, was: before, via: "in-page" };
  }
  let target = lab || checkbox;
  if (target.scrollIntoView) target.scrollIntoView({ block: "center", behavior: "instant" });
  let r = target.getBoundingClientRect();
  if ((r.width <= 0 || r.height <= 0) && checkbox.parentElement) {
    // CSS-clipped input with no label association (the styled box is a sibling/wrapper) — click the wrapper.
    target = checkbox.parentElement;
    if (target.scrollIntoView) target.scrollIntoView({ block: "center", behavior: "instant" });
    r = target.getBoundingClientRect();
  }
  if (r.width <= 0 || r.height <= 0) return null;
  return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), checked: !!checkbox.checked, inputId };
}

// AUTH VIEW SWITCH (2026-07-25, Caterpillar): Workday's auth screen renders Sign In and Create Account
// as two views of the SAME widget, and some tenants OPEN on Create Account — sign-in is behind an
// "Already have an account? Sign In" link. The coordinate click on that link can be REFUSED by the
// cover-check because the widget's own heading (`h3#authViewTitle`) overlaps its click point (live:
// "Sign In tab is covered by h3#authViewTitle 'Create Account' — refusing a blind click"), and the run
// then filled the CREATE-ACCOUNT fields believing it was signing in. A view-switch LINK is neither a
// submit nor a consent control, so a page-side element click is safe here — and it's the only way past
// a false-positive cover. SUBMIT buttons are explicitly excluded (a bare "Create Account" text match
// would otherwise hit the submit and create an account). Returns { ok, text, how }.
function cdpClickAuthSwitch(want) {
  const wantSignIn = want === "signin";
  const isSubmit = (el) => {
    const aid = (el.getAttribute && el.getAttribute("data-automation-id")) || "";
    return /SubmitButton$/i.test(aid) || (el.getAttribute && (el.getAttribute("type") || "").toLowerCase() === "submit");
  };
  const cands = [];
  const byId = document.querySelector(wantSignIn ? '[data-automation-id="signInLink"]' : '[data-automation-id="createAccountLink"]');
  if (byId && !isSubmit(byId)) cands.push(byId);
  const matches = (t) => wantSignIn
    ? (/^sign in$/i.test(t) || /already have an account/i.test(t))
    : (/^create account$/i.test(t) || /(don'?t|do not) have an account/i.test(t));
  for (const el of Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'))) {
    if (isSubmit(el)) continue;                                    // never the submit control
    const t = (el.textContent || "").trim();
    if (!t || t.length > 60) continue;
    if (/with (google|apple|linkedin|email|sso)/i.test(t)) continue; // never a federated / chooser button
    if (matches(t)) cands.push(el);
  }
  for (const el of cands) {
    const r = el.getBoundingClientRect && el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) continue;
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) {}
    window.__apActing = (window.__apActing || 0) + 1;              // input-lock passthrough
    try { el.click(); } catch (e) { continue; } finally { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }
    return { ok: true, text: (el.textContent || "").trim().slice(0, 60), how: el === byId ? "automation-id" : "text" };
  }
  return { ok: false };
}

// "Resend Account Verification" button — shown on Workday's sign-in page when the account EXISTS
// but is UNVERIFIED (e.g. a prior run created it and never completed verification). Clicking it
// dispatches a FRESH verification email; the original may be stale/expired. Matched by TEXT
// (must contain "resend" + verif/account) so it won't false-fire on Sign In / Create Account / other
// blurb buttons; the data-automation-id (informationalBlurbButton on altasciences) is tenant-variable.
// Returns the click point + label, or null.
function cdpResendVerifyRect() {
  const cands = Array.from(document.querySelectorAll('button, [role="button"], a, [data-automation-id="informationalBlurbButton"]'));
  for (const el of cands) {
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!/resend/i.test(txt) || !/verif|account/i.test(txt)) continue; // "Resend Account Verification"
    const r0 = el.getBoundingClientRect();
    if (r0.width <= 0 || r0.height <= 0) continue;
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), label: txt.slice(0, 50) };
  }
  return null;
}

// The n-th password input's click point (create-account "verify password" fallback when
// there's no data-automation-id="verifyPassword": Workday renders a 2nd input[type=password]).
function cdpNthPasswordRect(n) {
  const el = document.querySelectorAll('input[type="password"]')[n];
  if (!el) return null;
  if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  // Full {x,y,w,h,cx,cy} — this is consumed via cdpEvalRectReady, whose validity gate is
  // `rect.w > 0`, so w/h are REQUIRED (a {cx,cy}-only rect would always fail that gate).
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
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

// Clear a multiselect's search input the REACT-SAFE, FOCUS-INDEPENDENT way: the native value setter
// plus input/change (the standard React fill technique). The other typeaheads clear with trusted
// Ctrl+A/Delete (cdpSelectAllDelete), but on the SKILLS widget Ctrl+A does NOT select the input's
// text — observed by hand: the select-all went to the page, the next keystrokes APPENDED to the stale
// query, and Enter turned "Docker" + "CubeMars motor drivers" into the chip
// "DockerCubeMars motor drivers". On this widget a stale query can FABRICATE a skill, so the clear
// must not depend on where focus happens to be. Live, a trusted-hidden run cleared fine for one skill
// and then failed on the next two, which is exactly the flakiness a focus-blind primitive produces.
function cdpClearInputNative(sel) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, reason: "no input" };
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  try { if (d && d.set) d.set.call(el, ""); else el.value = ""; } catch (e) { return { ok: false, reason: "set threw" }; }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: el.value };
}

// Open a multiselect by acting on its OWN input, page-side — no coordinates, no paint required.
// Why this exists (skills, traced 2026-08-07): the input gains data-automation-id="searchBox" only
// ONCE OPEN, so while closed every searchBox-keyed selector misses it and opening has to go through
// a COORDINATE click on the container. That click is what failed on a HIDDEN run which worked fine
// visible — the field logged "could not focus the search box" and added zero skills. By hand, what
// reliably opened the widget was focus() + click() on the input itself, which is what this does.
// Returns a diagnostic (not a bare bool) so a failure says WHICH step missed; the caller still polls
// readHier, because the searchBox id appears on a later React tick.
function cdpOpenMultiselectInput(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  if (!w) return { ok: false, reason: "no wrapper" };
  const inp = w.querySelector("input");
  if (!inp) return { ok: false, reason: "no input" };
  if (inp.scrollIntoView) inp.scrollIntoView({ block: "center", behavior: "instant" });
  try { inp.focus(); } catch (e) { /* keep going — the click may still open it */ }
  const focused = document.activeElement === inp;
  try { inp.click(); } catch (e) { return { ok: false, reason: "click threw", focused }; }
  const sb = w.querySelector('input[data-automation-id="searchBox"]');
  return { ok: true, focused, openedNow: !!sb };
}

// Same focus attempt, but it REPORTS what happened instead of a bare boolean — whether the node was
// there, whether focus() took, and if not, what holds focus instead. "Could not focus" has at least
// three causes with different fixes, and a boolean cannot tell them apart.
function cdpFocusDiag(sel) {
  const d = (e) => e ? { tag: e.tagName, id: e.id || null, aid: e.getAttribute && e.getAttribute("data-automation-id"),
    type: e.getAttribute && e.getAttribute("type"), cls: String((e.className && e.className.baseVal) || e.className || "").slice(0, 60) } : null;
  const el = document.querySelector(sel);
  const before = d(document.activeElement);
  if (!el) return { present: false, focused: false, before, after: before, note: "node not in the DOM" };
  const r = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  const box = { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, vis: cs.visibility,
    disabled: !!el.disabled, readOnly: !!el.readOnly, tabIndex: el.tabIndex };
  if (!el.focus) return { present: true, focused: false, before, after: before, box, note: "no focus() on the node" };
  el.focus();
  const okNow = document.activeElement === el;
  return { present: true, focused: okNow, before, after: d(document.activeElement), box,
    note: okNow ? "focused" : "focus() did not stick" };
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
  const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  // READ-ONLY diagnostic (no behavior change — the caller still clicks (cx,cy) exactly as before): is the
  // target option ACTUALLY at the click point? `hitTarget` false / `atPointText` != text ⇒ a still-settling
  // /virtualizing list shifted the row or an overlay occludes it (a coordinate MIS-CLICK). `hitTarget` true
  // but no commit ⇒ the click lands right but the list isn't INTERACTIVE yet (the 2026-07-06 root cause).
  // `collisions` > 1 ⇒ the aria-controls id is shared by multiple elements (getElementById picked the wrong one).
  let hitTarget = null, atPointText = null, collisions = null;
  try {
    const hit = document.elementFromPoint(cx, cy);
    const ho = hit && hit.closest ? (hit.closest('[role="option"]') || hit) : hit;
    hitTarget = !!(hit && (hit === el || el.contains(hit) || ho === el));
    atPointText = ho ? (ho.textContent || "").trim().slice(0, 40) : null;
    collisions = id ? document.querySelectorAll("#" + ((window.CSS && CSS.escape) ? CSS.escape(id) : id)).length : null;
  } catch (e) {}
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx, cy, hitTarget, atPointText, collisions };
}

function cdpReadRadioState(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  return Array.from(w.querySelectorAll('input[type="radio"]')).map((input) => {
    const lab = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    return { id: input.id, labelText: lab ? lab.textContent.trim() : "", checked: input.checked };
  });
}

// ORPHAN CHECKBOXES (2026-07-25) — checkboxes that live OUTSIDE any `formField-*` wrapper, so the page
// scan (which only walks formField wrappers) cannot see them at all. Caterpillar's page-1 SMS/marketing
// consent is one: revealed by the phone number, never in the records. The create-account consent needed
// its own finder (cdpConsentRect) for exactly this reason. READ-ONLY inventory for the review summary —
// the bot never checks these (an optional consent is the operator's call; this only makes it VISIBLE).
// Each gets a stable-ish key from its id/name/aria-label so re-runs merge instead of duplicating.
function cdpScanOrphanCheckboxes() {
  const out = [];
  const seen = new Set();
  for (const cb of Array.from(document.querySelectorAll('input[type="checkbox"]'))) {
    if (cb.closest('[data-automation-id^="formField-"]')) continue;      // the normal scan owns these
    if (cb.closest("[data-fkit-id]")) {
      const f = cb.closest("[data-fkit-id]").getAttribute("data-fkit-id") || "";
      if (/-\d+--/.test(f)) continue;                                    // inside a repeating entry — its section owns it
    }
    const r = cb.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) continue;                   // not rendered → not on the page for the operator either
    const lab = cb.id ? document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(cb.id) : cb.id) + '"]') : null;
    const wrapLab = cb.closest("label");
    let text = ((lab && lab.textContent) || (wrapLab && wrapLab.textContent) || cb.getAttribute("aria-label") || "").trim();
    if (!text) { // fall back to the nearest SMALL ancestor's own text (a long consent paragraph is fine — it IS the label)
      let el = cb.parentElement;
      for (let i = 0; i < 4 && el; i++) { const t = (el.textContent || "").trim(); if (t) { text = t; break; } el = el.parentElement; }
    }
    if (!text) continue;                                                 // unlabeled → nothing meaningful to show in review
    const key = cb.id || cb.getAttribute("name") || ("orphanCheckbox_" + out.length);
    if (seen.has(key)) continue;
    seen.add(key);
    // A selector that re-resolves: prefer the id, else the automation-id, else an indexed fallback.
    const sel = cb.id ? ('input[type="checkbox"]#' + (window.CSS && CSS.escape ? CSS.escape(cb.id) : cb.id))
      : (cb.getAttribute("data-automation-id") ? 'input[data-automation-id="' + cb.getAttribute("data-automation-id") + '"]' : null);
    out.push({
      key, inputId: cb.id || null, selector: sel, checked: !!cb.checked,
      required: cb.getAttribute("aria-required") === "true" || cb.required === true,
      label: text.replace(/\s+/g, " ").slice(0, 400)
    });
  }
  return out;
}

// CHECKBOX GROUP (2026-07-25) — the same shape cdpReadRadioState returns, over `input[type=checkbox]`
// inside ONE wrapper (the OFCCP disability self-ID pick-one). Radio-shaped on purpose: the driver's
// label-exact match + the label-click commit are reused verbatim. The caller is responsible for the
// pick-one semantics (this tenant requires UNCHECKING the current option before another can be set).

// READ-ONLY inventory of every checkbox GROUP on the page: its wrapper, label, and each box's
// id/label/checked. Paired with cdpDevClickBox below it answers the one question the scan cannot:
// does this group allow TWO boxes checked at once?
function cdpDevGroups() {
  const out = [];
  const wraps = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
  for (const w of wraps) {
    const boxes = Array.from(w.querySelectorAll('input[type="checkbox"]'));
    if (boxes.length < 2) continue;
    const aid = w.getAttribute("data-automation-id") || "";
    const lab = (w.querySelector("label, legend") || {}).textContent || "";
    out.push({
      wrapperSel: '[data-automation-id="' + aid + '"]',
      fieldName: aid.replace(/^formField-/, ""),
      label: String(lab).trim().slice(0, 120),
      groupRole: (w.querySelector('[role="group"]') ? "group" : null),
      boxes: boxes.map((cb) => ({ id: cb.id || null, checked: !!cb.checked, disabled: !!cb.disabled,
        label: ((cb.id && document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(cb.id) : cb.id) + '"]')) || {}).textContent || "" })),
    });
  }
  return out;
}

// Click ONE checkbox's label (native label activation — the same primitive the filler uses) and
// return the group's state afterwards. Deliberately does NOT uncheck anything first: the point is to
// see what the PAGE does when a second box is checked.
function cdpDevClickBox(args) {
  const w = document.querySelector(args.wrapperSel);
  if (!w) return { ok: false, error: "wrapper not found" };
  const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(args.id) : args.id) + '"]');
  if (!lab) return { ok: false, error: "label not found for " + args.id };
  lab.click();
  return { ok: true };
}

// READ-ONLY geometry of a checkbox group, to answer whether the FILLER'S actuation and a page-side
// `label.click()` can differ. The filler clicks the LABEL'S CENTRE COORDINATE
// (clickRadioLabel → cdpRectReady('label[for=…]') → cdpClickAt). If the input sits AT that centre, one
// physical click can be seen by both the input and its label, and a checkbox toggles TWICE — checked
// then instantly unchecked, which is exactly what was observed live. So report, per box: the label and
// input rects, the label's centre, and what elementFromPoint() actually resolves to there.
function cdpDevBoxGeom(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  if (!w) return { ok: false, error: "wrapper not found" };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const r2 = (r) => (r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null);
  return {
    ok: true,
    boxes: Array.from(w.querySelectorAll('input[type="checkbox"]')).map((inp) => {
      const lab = inp.id ? document.querySelector('label[for="' + esc(inp.id) + '"]') : null;
      const lr = lab ? lab.getBoundingClientRect() : null;
      const cx = lr ? Math.round(lr.x + lr.width / 2) : null;
      const cy = lr ? Math.round(lr.y + lr.height / 2) : null;
      const at = cx != null ? document.elementFromPoint(cx, cy) : null;
      return {
        id: inp.id, checked: !!inp.checked,
        label: (lab && lab.textContent || "").trim().slice(0, 60),
        inputRect: r2(inp.getBoundingClientRect()), labelRect: r2(lr),
        labelCentre: cx != null ? [cx, cy] : null,
        // the whole question: what is under the point the filler clicks?
        atCentre: at ? (at.tagName + (at.id ? "#" + at.id : "") + (at.getAttribute && at.getAttribute("for") ? "[for=" + at.getAttribute("for") + "]" : "")) : null,
        atCentreIsThisInput: !!(at && at === inp),
        atCentreIsThisLabel: !!(at && at === lab),
        inputInsideLabel: !!(lab && lab.contains(inp)),
      };
    }),
  };
}
// The live values of a date composite's segments, read straight off the spinbuttons. Used to RE-TYPE a
// date with the value it already shows — reading the segments avoids parsing the rendered string, whose
// order is tenant-variable (MM/DD/YYYY vs DD/MM/YYYY), so no order can be assumed wrongly.
function cdpReadDateSegValues(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  const out = {};
  for (const seg of ["Month", "Day", "Year"]) {
    const el = w.querySelector('[data-automation-id="dateSection' + seg + '-input"]');
    const v = el && el.value != null ? String(el.value).trim() : "";
    if (v !== "") out[seg.toLowerCase()] = v;
  }
  return Object.keys(out).length ? out : null;
}

// What is ACTUALLY at (x,y), and is it the label/input we think we are clicking? The rect is measured in
// one CDP round trip and the click is dispatched in another, so a scroll or reflow in between silently
// sends the click somewhere else — the same staleness clickPageNext learned to re-measure for. Without
// this, "the click didn't register" and "the click landed on something else" are indistinguishable.
function cdpHitAt(x, y, wantId) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { hit: null, mine: false };
  const forAttr = (el.getAttribute && el.getAttribute("for")) || "";
  const lab = wantId ? document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(wantId) : wantId) + '"]') : null;
  const mine = !!(wantId && (forAttr === wantId || el.id === wantId || (lab && (el === lab || lab.contains(el)))));
  return {
    hit: el.nodeName + (el.id ? "#" + String(el.id).slice(0, 8) : "") + (forAttr ? "[for=" + String(forAttr).slice(0, 8) + "]" : ""),
    text: (el.textContent || "").trim().slice(0, 40),
    mine,
    // if the label exists but is NOT under the point, the rect we measured has gone stale
    labelRectNow: lab ? (() => { const r = lab.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) }; })() : null,
  };
}

// ── IS THE TAB PAINTING? (2026-08-05) ───────────────────────────────────────────────────────────────
// The input-mode decision has always asked "is the tab HIDDEN?" (cdpVisible = tab.active &&
// !minimized). What actually determines whether trusted Input.* is fast is whether the tab is
// PAINTING: those events are drained in step with frame production. A window sitting BEHIND another
// app satisfies tab.active && !minimized while compositing nothing — the documented occlusion blind
// spot — so we keep using trusted input and pay ~1.1-1.5s per event.
//
// Measured live: the SAME page 2 of the same posting took 11.1s hidden (synthetic input, no frames
// needed) and 39s on a "visible" run whose window was actually behind another app — with
// firstYearAttended at 16.8s and fieldOfStudy at 16.2s, i.e. ~1.1s per input event. Every other page in
// that run was normal, because page 2 is the one dominated by input events.
//
// rAF is the honest signal: its callback is driven by frame production, so it simply does not arrive
// when nothing is being composited. Same philosophy as cdpTimersFast — measure, never assume.
function cdpPaintProbeSrc() {
  // Uses the NATIVE rAF stashed by buildOverrideSrc; without it, our own setTimeout-backed polyfill
  // would answer "painting" on a frameless tab. No native reference ⇒ report unknown, never a guess.
  return new Promise(function (res) {
    var raf = window.__apNativeRaf || (window.__apOverridesInstalled ? null : window.requestAnimationFrame);
    if (!raf) { res({ ok: false, reason: "no native rAF available" }); return; }
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var done = false;
    try {
      raf(function () {
        if (done) return; done = true;
        var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
        res({ ok: true, ms: Math.round(t1 - t0) });
      });
    } catch (e) { res({ ok: false, reason: String(e && e.message || e) }); }
  });
}

// Cached, because cdpSynthInput() is consulted on EVERY click and a probe is a page round trip (a
// visibility read is not). The TTL is short on purpose: the operator alt-tabbing mid-run is exactly the
// case this exists for, so the answer has to be allowed to change during a page.
let _paintCache = { at: 0, painting: null };
const PAINT_PROBE_DEADLINE_MS = 150;   // 60fps = 16ms, 30fps = 33ms — generous, and only paid when NOT painting
const PAINT_CACHE_TTL_MS = 2000;
function cdpInvalidatePaint() { _paintCache = { at: 0, painting: null }; }
// For diagnostics: what the probe last measured, and what Chrome thinks — the pair is the whole point,
// because "visible but not painting" is the state that used to be invisible in the logs.
async function cdpPaintLabel() {
  const painting = await cdpPainting();
  let vis = "?"; try { vis = (await cdpVisible()) ? "visible" : "hidden"; } catch (e) { /* ignore */ }
  return painting ? `painting (${vis})` : `NOT painting (chrome says ${vis})`;
}
async function cdpPainting() {
  if (_paintCache.painting !== null && (Date.now() - _paintCache.at) < PAINT_CACHE_TTL_MS) return _paintCache.painting;
  let painting;
  try {
    const r = await Promise.race([
      cdpEval(cdpPaintProbeSrc),
      cdpDelay(PAINT_PROBE_DEADLINE_MS).then(() => ({ ok: true, ms: -1, timedOut: true })),
    ]);
    // A probe that cannot answer (no native rAF, eval failure) FALLS BACK to Chrome's visibility, so the
    // worst case is exactly today's behaviour rather than a new failure mode.
    if (!r || r.ok !== true) painting = await cdpVisible();
    else painting = !r.timedOut;
  } catch (e) {
    try { painting = await cdpVisible(); } catch (e2) { painting = true; }
  }
  _paintCache = { at: Date.now(), painting };
  return painting;
}

// ── QUIESCENCE (2026-08-04): "is the page still busy?", which no other wait here can answer ─────────
// Every settle in this file waits for a COUNT to stop changing (field set, options, entries). None can
// tell you the DOM is mid-reaction, and that is what actually breaks the self-ID checkbox group: the
// 10ms watch caught our verified check being wiped 281ms later by 29 MutationRecords, with NO click
// behind it. A human never hits that window because by the time they click, the page has gone quiet.
//
// Page side does nothing but STAMP the last mutation. The WAITING happens in the service worker on real
// wall-clock — a page-side timer would be throttled on a hidden tab, the rule this file already learned
// three times over.
function cdpInstallQuietWatch(sel) {
  try {
    window.__apQuiet = window.__apQuiet || {};
    window.__apQuietMo = window.__apQuietMo || {};
    if (window.__apQuietMo[sel]) return { ok: true, already: true };
    const w = document.querySelector(sel);
    // The wrapper's PARENT: a reaction can replace the wrapper itself, and a sibling churning is just as
    // good a signal that the form is busy. The whole document would never be quiet.
    const root = (w && w.parentNode) || document.body;
    window.__apQuiet[sel] = Date.now();
    const mo = new MutationObserver(() => { window.__apQuiet[sel] = Date.now(); });
    mo.observe(root, { childList: true, subtree: true, attributes: true });
    window.__apQuietMo[sel] = mo;
    return { ok: true, root: root.nodeName };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
function cdpReadQuiet(sel) {
  const at = (window.__apQuiet || {})[sel];
  return at ? { ok: true, idleMs: Date.now() - at } : { ok: false };
}

// ── TEMPORARY DIAGNOSTIC (2026-08-04): watch a checkbox group at 10ms and say WHY it changed ────────
// The question this settles: when the group loses its check, is the DOM being REBUILT (a re-render) or is
// the input's `checked` being toggled in place (a click / property write)? Those need opposite fixes and
// three rounds of reasoning failed to separate them.
//
// The discriminator is that `checked` is a PROPERTY, not an attribute: flipping it produces NO
// MutationRecord. So a state change with a mutation count that did not move = something toggled the input;
// a state change accompanied by childList mutations = the subtree was replaced. `isTrusted` on the
// recorded events separates our CDP clicks (trusted) from any page-side/synthetic dispatch.
//
// Records TRANSITIONS only, never raw samples — 10ms over a 30s page would be 3000 rows.
// Gated behind chrome.storage.local.debugGroupWatch; install → fill → drain.
function cdpInstallGroupWatch(wrapperSel) {
  try {
    if (window.__apGW) { try { clearInterval(window.__apGW.timer); window.__apGW.mo && window.__apGW.mo.disconnect(); } catch (e) {} }
    const st = { sel: wrapperSel, t0: Date.now(), samples: 0, muts: 0, transitions: [], events: [], mutLog: [] };
    const snap = () => {
      const w = document.querySelector(wrapperSel);
      if (!w) return "WRAPPER-ABSENT";
      const cbs = Array.from(w.querySelectorAll('input[type="checkbox"]'));
      if (!cbs.length) return "NO-BOXES";
      return cbs.map((c) => String(c.id || "?").slice(0, 6) + (c.checked ? "=ON" : "=off")).join(" ");
    };
    const ids = () => {
      const w = document.querySelector(wrapperSel);
      return w ? Array.from(w.querySelectorAll('input[type="checkbox"]')).map((c) => c.id) : [];
    };
    // MutationObserver on the wrapper's PARENT so a wholesale replacement of the wrapper is visible too.
    const w0 = document.querySelector(wrapperSel);
    const root = (w0 && w0.parentNode) || document.body;
    st.mo = new MutationObserver((recs) => {
      st.muts += recs.length;
      for (const r of recs) {
        if (st.mutLog.length >= 400) break;
        st.mutLog.push({ t: Date.now() - st.t0, type: r.type,
          added: r.addedNodes ? r.addedNodes.length : 0, removed: r.removedNodes ? r.removedNodes.length : 0,
          attr: r.attributeName || null,
          inGroup: !!(w0 && r.target && (w0 === r.target || w0.contains(r.target))),
          target: (r.target && r.target.nodeName) + ((r.target && r.target.getAttribute && r.target.getAttribute("data-automation-id")) ? "[" + r.target.getAttribute("data-automation-id") + "]" : "") });
      }
    });
    try { st.mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["checked", "class", "aria-checked", "data-automation-id"] }); } catch (e) { /* best effort */ }
    // Capture-phase event log, scoped to this group (its own nodes, or a label pointing at one of its ids).
    const myIds = ids();
    st.onEv = (e) => {
      try {
        if (st.events.length >= 80) return;
        const t = e.target;
        if (!t || !t.nodeName) return;
        const w = document.querySelector(wrapperSel);
        const forAttr = (t.getAttribute && t.getAttribute("for")) || "";
        const mine = (w && w.contains(t)) || (forAttr && myIds.indexOf(forAttr) >= 0);
        if (!mine) return;
        st.events.push({ t: Date.now() - st.t0, type: e.type, trusted: !!e.isTrusted,
          target: t.nodeName + (t.id ? "#" + String(t.id).slice(0, 6) : "") + (forAttr ? "[for=" + String(forAttr).slice(0, 6) + "]" : ""),
          checkedNow: (t.type === "checkbox") ? !!t.checked : undefined });
      } catch (err) { /* never let the probe break the page */ }
    };
    st.evTypes = ["pointerdown", "mousedown", "mouseup", "click", "change", "input", "focusin", "focusout"];
    for (const ty of st.evTypes) document.addEventListener(ty, st.onEv, true);
    let last = null;
    st.timer = setInterval(() => {
      st.samples++;
      const s = snap();
      if (s !== last) { st.transitions.push({ t: Date.now() - st.t0, s, mutsSoFar: st.muts }); last = s; }
    }, 10);
    window.__apGW = st;
    return { ok: true, sel: wrapperSel, first: snap(), boxes: myIds.length, observing: root.nodeName };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
function cdpDrainGroupWatch() {
  const st = window.__apGW;
  if (!st) return { ok: false, error: "not installed" };
  try { clearInterval(st.timer); st.mo && st.mo.disconnect(); for (const ty of st.evTypes) document.removeEventListener(ty, st.onEv, true); } catch (e) {}
  const out = { ok: true, samples: st.samples, muts: st.muts, transitions: st.transitions, events: st.events, mutLog: st.mutLog,
    spanMs: Date.now() - st.t0 };
  try { delete window.__apGW; } catch (e) { window.__apGW = null; }
  return out;
}

// READ-ONLY inventory of EVERY formField wrapper on the page with its widget kind and current value.
// cdpDevGroups only reports checkbox GROUPS, so it cannot answer "is this field even mounted yet?" —
// which is the question when a widget appears mid-fill and the settled pre-fill scan never saw it.
function cdpDevWrappers() {
  return Array.from(document.querySelectorAll('[data-automation-id^="formField-"]')).map((w) => {
    const aid = (w.getAttribute("data-automation-id") || "").replace(/^formField-/, "");
    const btn = w.querySelector('button[aria-haspopup="listbox"]');
    const cbs = w.querySelectorAll('input[type="checkbox"]');
    const txt = w.querySelector('input[type="text"], textarea');
    return {
      field: aid,
      widget: btn ? "dropdown" : cbs.length > 1 ? "checkbox_group(" + cbs.length + ")" : cbs.length === 1 ? "checkbox" : txt ? "text" : "other",
      value: btn ? btn.textContent.trim().slice(0, 46)
        : cbs.length ? Array.from(cbs).map((c) => c.checked).join(",")
        : txt ? (txt.value || "") : null,
      required: !!(w.querySelector("abbr") || w.querySelector('[aria-required="true"]')),
      // ── THE RAW EVIDENCE, not just our verdict (operator, 2026-08-09) ──────────────────────────────
      // "you should be able to get this from the DOM, so the fact that you are asking is a problem."
      // Exactly right: `required` above is a DERIVED boolean, and when a run halted on a required field
      // the only way to sanity-check it was to re-read the same derivation and learn nothing — so the
      // question got escalated to a human instead of answered from the page. Report WHICH marker fired,
      // so "is this really required?" is settled by looking, every time.
      requiredEvidence: (() => {
        const ab = w.querySelector("abbr");
        const lbl = w.querySelector("label,legend");
        const lblText = lbl ? (lbl.textContent || "").replace(/\s+/g, " ").trim() : "";
        return {
          abbrTitle: ab ? (ab.getAttribute("title") || null) : null,   // Workday's <abbr title="required">
          abbrText: ab ? (ab.textContent || "").trim() : null,         // or a bare <abbr>*</abbr>
          ariaRequired: !!w.querySelector('[aria-required="true"]'),
          labelEndsWithStar: /\*\s*$/.test(lblText),
          label: lblText.slice(0, 60),
        };
      })(),
    };
  });
}
function cdpReadCheckboxGroupState(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  return Array.from(w.querySelectorAll('input[type="checkbox"]')).map((input) => {
    const lab = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    return { id: input.id, labelText: lab ? lab.textContent.trim() : (input.getAttribute("aria-label") || "").trim(), checked: input.checked };
  });
}

// Best-effort: find a clearly-DISMISSIVE control (X / Close / No thanks — NEVER Accept/Agree/OK/Got it)
// inside the popup covering (cx,cy), so the walk can close it and proceed. Handles SHADOW-DOM overlays
// (Simplify renders into div.simplify-jobs-shadow-root → the X lives in host.shadowRoot, invisible to a
// light-DOM query) AND regular in-page modals. Read-only: returns the control's viewport rect for a TRUSTED
// click (or {found:false}). SAFETY: the affirmative deny-list is checked first so we never click a
// consent/accept button; if nothing clearly-dismissive is found we return not-found → the caller halts.
// ── The BACK control, and the leave-page dialog's confirm (2026-08-05) ──────────────────────────────
// For the phantom-required remedy: Workday's form model has lost an answer its own DOM still shows, and
// the only remedy not yet refuted is to step BACK one page and Save & Continue forward again, so Workday
// re-POSTs the previous page and re-DERIVES this one's model. This repo has never touched either control,
// so these finders are deliberately TOLERANT about markup (no tenant automation-id is assumed) and STRICT
// about identity — every caller additionally verifies the page signature actually changed, so a wrong
// click cannot be mistaken for a successful retreat.
// Generic activation fallback for a control the EXTENSION picked (not one found in page content): focus
// it, or click it from inside the page. Same lesson as the Sign In press — re-issuing the identical
// coordinate click cannot recover a click that silently did not register, so a retry has to change the
// MECHANISM. The caller passes a selector it derived itself (an apply-chain automation-id), never
// anything scraped from the page, and this still refuses a control whose label reads like a submit or a
// consent: a fallback that gets a run further must never be the thing that agrees to something.
function cdpActivateBySelector(sel, mode) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, reason: "selector not found" };
  const r = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  if (r.width <= 0 || r.height <= 0 || cs.display === "none" || cs.visibility === "hidden") return { ok: false, reason: "not visible" };
  const label = ((el.textContent || "").replace(/\s+/g, " ").trim() || el.getAttribute("aria-label") || "").slice(0, 60);
  if (/\bsubmit\b|\bagree\b|\baccept\b|\bconsent\b|\bi certify\b/i.test(label)) {
    return { ok: false, reason: `refusing — the control reads like a submit/consent ("${label}")` };
  }
  if (mode === "focus") { el.focus(); return { ok: document.activeElement === el, label }; }
  try { el.click(); return { ok: true, label, via: "el.click()" }; }
  catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

// ── SIGN-IN ACTIVATION FALLBACKS (2026-08-06) ───────────────────────────────────────────────────────
// The coordinate click on Sign In occasionally just does not take — the form stays up, Workday reports
// neither an error nor the next page, and re-clicking the SAME way (which is all submitAndWait did) can
// only reproduce it. Operator-confirmed: no browser dialog was involved, the press simply did not happen.
// So each retry now escalates to a DIFFERENT activation mechanism. These only ever FOCUS a target; the
// keystroke itself is dispatched trusted from the SW, because the auth form is the one surface where
// synthetic input is known not to register.
function cdpFocusSignInTarget(which) {
  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  if (which === "password") {
    const p = [...document.querySelectorAll('input[type="password"]')].filter(vis).pop();
    if (!p) return { ok: false, reason: "no visible password input" };
    p.focus();
    return { ok: document.activeElement === p, what: "password input" };
  }
  const b = [document.querySelector('[data-automation-id="signInSubmitButton"]'),
             document.querySelector('[data-automation-id="click_filter"][aria-label="Sign In"]'),
             ...document.querySelectorAll('button[type="submit"],button,[role="button"]')]
    .filter(Boolean).filter(vis)
    .find((e) => e.getAttribute("data-automation-id") === "signInSubmitButton"
      || /^\s*(sign[- ]?in|log[- ]?in|sign[- ]?on)\s*$/i.test((e.textContent || "").trim())
      || /sign in/i.test(e.getAttribute("aria-label") || ""));
  if (!b) return { ok: false, reason: "no visible Sign In button" };
  b.focus();
  return { ok: document.activeElement === b, what: "Sign In button" };
}
// LAST RESORT, page-side: a real .click() on the button, else the form's own submit. Used only after every
// trusted mechanism has failed and the alternative is halting for the operator. Scoped hard to the sign-in
// form — it resolves the button by its automation-id/label, so it cannot fire anything on an application
// page even if this is somehow reached there.
function cdpDomActivateSignIn() {
  const b = document.querySelector('[data-automation-id="signInSubmitButton"]')
    || [...document.querySelectorAll('button,[role="button"]')]
      .find((e) => /^\s*(sign[- ]?in|log[- ]?in|sign[- ]?on)\s*$/i.test((e.textContent || "").trim()));
  if (!b) return { ok: false, reason: "no Sign In button in the DOM" };
  try { b.click(); return { ok: true, via: "el.click()" }; } catch (e) { /* fall through to the form */ }
  const f = b.closest && b.closest("form");
  if (f) { try { (f.requestSubmit ? f.requestSubmit(b) : f.submit()); return { ok: true, via: "form.requestSubmit()" }; } catch (e) { /* nothing left */ } }
  return { ok: false, reason: "click() and form submit both threw" };
}
// (cdpFindPageBackControl / cdpFindLeaveDialogConfirm were removed 2026-08-06 with the back-a-page
// retreat they served -- see the note in background.js's replay nav-timeout branch. cdpActivateBySelector
// above is the survivor: it is generic and the Apply-press escalation uses it.)
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
  const DISMISS_TXT = /^(close|dismiss|minimi[sz]e|no thanks|no,\s*thanks|not now|skip|maybe later|later)$/i;
  // Simplify's overlay (div.simplify-jobs-shadow-root) collapses out of the way via a <button aria-label="Minimize">
  // — the safe get-out-of-the-way action (no close/consent). NOT "collapse" (that matches its "Collapse Resume
  // Section" SUB-control, which wouldn't uncover the button). Recon-confirmed 2026-07-06.
  const DISMISS_META = /close|dismiss|minimi[sz]e/i;
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
  // SINGLE rAF (2026-07-20): was double-rAF (~32ms floor). Every caller re-checks its own gate after each
  // frame — pickSel re-reads the option count, awaitRender re-reads the mounted-set signature — so a
  // too-early ~16ms read just re-polls; halving the settle floor cuts the per-hop wall-clock (biggest win
  // VISIBLE, where real scroll-paint contends with the timer callback). The setTimeout(fin, 250) fallback is
  // UNCHANGED, so frame() still always resolves (never hangs on a frozen-rAF hidden tab). Both poll loops
  // below give up on a WALL-CLOCK deadline (regime-independent), so this is provably no-slower than the old
  // double-rAF path even in the hidden+CSP-blocked slow regime where frame() is fallback-bound (~1s), not rAF.
  const frame = () => new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(fin); setTimeout(fin, 250); });
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
  // banner, or a ceiling). FoS is already rendered when scraped mid-fill → resolves at frame 0. The ceiling
  // is a WALL-CLOCK ~768ms (2026-07-20: matches the old 24×double-rAF ~768ms first-render budget). Wall-clock
  // (not an iteration count) so the ceiling is REGIME-INDEPENDENT: in the fast regime (visible / hidden+
  // worker-timers) frame() ~16ms fits ~48 polls; in the rare hidden+CSP-blocked slow regime frame() is bound
  // by the throttled ~1s setTimeout fallback (NOT rAF), so an iteration count would double the tail — here it
  // does 1 frame then the deadline, provably no-slower than the old code. i<200 is a spin-guard only.
  const pickSel = () => OPT_SELECTORS.find((sel) => optsFor(sel).length) || null;
  let optSel = pickSel();
  const _fr0 = Date.now();
  for (let t0 = Date.now(), i = 0; Date.now() - t0 < 768 && i < 200 && !optSel && !bannerUp(); i++) { await frame(); optSel = pickSel(); }
  const firstRenderMs = Date.now() - _fr0;   // 0 when the list was already mounted (the mid-fill case)
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
  // committed the just-scrolled window) — breaks at ~1 frame on the common steps. The sig-change IS the mount
  // signal, so this reads a COMMITTED window — it can't advance before the mount, so it can't re-truncate;
  // overlap + de-dup + stable-2-at-bottom still backstop completeness. The give-up is a WALL-CLOCK ~96ms
  // (2026-07-20: matches the old 3×double-rAF ~96ms per-hop budget). Wall-clock (not an iteration count) makes
  // the mount-wait REGIME-INDEPENDENT: fast regime (visible / hidden+worker) frame() ~16ms → up to ~6 polls;
  // rare hidden+CSP-blocked slow regime frame() ~1s (throttled fallback) → 1 poll then the deadline, provably
  // no-slower than the old code (an iteration count would have doubled the stable-2 tail there). i<60 spin-guard.
  // TIMED-OUT vs BROKE-EARLY (2026-08-06 measurement): 85ms average against a 96ms cap suggests most hops
  // TIME OUT — i.e. the virtualizer has not committed the new window when we give up, so each hop yields a
  // PARTIAL window and we need more of them. If that is what is happening, hopping FASTER makes it worse
  // and waiting LONGER per hop is faster overall. Counting settles it instead of guessing.
  let hopTimeouts = 0, hopEarly = 0, hopWaitMs = 0;
  const awaitRender = async (beforeSig) => {
    const w0 = Date.now();
    for (let t0 = Date.now(), i = 0; Date.now() - t0 < 96 && i < 60; i++) {
      await frame();
      if (curSig() !== beforeSig) { hopEarly++; hopWaitMs += Date.now() - w0; return; }
    }
    hopTimeouts++; hopWaitMs += Date.now() - w0;
  };
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
      // Hop by 0.7× the mounted-window span → ~30% overlap between consecutive windows (2026-07-20: was 0.6×
      // / 40% overlap; 0.7× drops ~1 hop in 8 while KEEPING the original's completeness robustness. A DOM/rAF
      // sim of a slow-mounting virtualizer (tmp harness) showed 0.6–0.75 all stay complete up to a ~200ms
      // per-scroll mount latency, but 0.8 REGRESSES to ~100ms: under a slow mount awaitRender times out and
      // scrollTop runs ~2 hops ahead before a window is collected, and only a factor ≤0.75 keeps enough
      // overlap to reach back to the last-collected row. de-dup + stable-2-at-bottom still backstop the rest.)
      const inc = Math.max(60, Math.floor(mountedSpan() * 0.7));
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
  return { ok: true, options, count: options.length, steps, atBottom, firstRenderMs, hopTimeouts, hopEarly, hopWaitMs, cappedOut: steps >= MAX_STEPS,
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
  // EXACT match FIRST (textContent OR data-automation-label), then a textContent startsWith as a FALLBACK
  // only when nothing matches exactly. Without exact-first, the startsWith made a request for "Other" land
  // on "Others" ("others".indexOf("other")===0) — whichever came first in DOM order won, committing the
  // wrong leaf (the live "How did you hear about us?" → chip "Others" ≠ "Other" bug). The startsWith stays
  // as a fallback so a leaf whose textContent carries an extra suffix/whitespace its label omits still hits.
  const matchPO = () => {
    const opts = Array.from(document.querySelectorAll('[data-automation-id="promptOption"]'))
      .filter((o) => isVisible(o) && !o.closest('[data-automation-id="selectedItemList"]'));
    return opts.find((o) => { const t = norm(o.textContent), d = norm(o.getAttribute("data-automation-label")); return t === want || d === want; })
        || opts.find((o) => norm(o.textContent).indexOf(want) === 0);
  };
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

// ── Batched audit re-read (perf) ─────────────────────────────────────────────
// The M40 audit re-reads every field the bot actuated. Doing one cdpEval PER FIELD is N serial
// SW↔page round-trips; on a HIDDEN tab (where the fill is slowest — throttled reaction, and each
// debugger round-trip costs more) that IPC latency dominates the otherwise-instant reads.
// cdpReadAuditRaw reads ALL fields in ONE Runtime.evaluate by COMPOSING the SINGLE-SOURCE reader
// functions (their .toString(), NO body duplication → no lockstep hazard) with a dispatcher inside
// one scoped IIFE. Returns a parallel array of RAW reader outputs (the same shapes
// act.readTextValue/readDropdownState/… return; a "date" entry → an array of per-segment reads),
// null per field on a page-side error. The {actual,readable} MAPPING stays SW-side in fill-driver
// (auditActualFromRaw — Node-testable); reconcileAudit falls back to the per-field path when this
// method is absent (older fakes / a minimal audit act).
const AUDIT_RAW_READERS = [cdpReadTextState, cdpReadInputBySel, cdpReadDropdownState,
  cdpReadCheckboxState, cdpReadRadioState, cdpReadCheckboxGroupState, cdpReadHierState, cdpReadSourcePick];
// Page-side dispatcher — receives [{widgetType, wrapperSel, tag, dateSegs}] and returns the raw read
// per spec. Self-contained: references ONLY the AUDIT_RAW_READERS (injected as sibling declarations
// by cdpReadAuditRaw) + page globals. Keep the widget→reader map in LOCKSTEP with fill-driver's
// auditReReadActual (typeahead→Hier, hierarchical→SourcePick).
function cdpAuditRawDispatch(specs) {
  return (specs || []).map(function (s) {
    try {
      switch (s.widgetType) {
        case "text": case "textarea": return cdpReadTextState(s.wrapperSel, s.tag);
        case "dropdown": return cdpReadDropdownState(s.wrapperSel);
        case "checkbox": return cdpReadCheckboxState(s.wrapperSel);
        case "radio": return cdpReadRadioState(s.wrapperSel);
        case "checkbox_group": return cdpReadCheckboxGroupState(s.wrapperSel);
        case "typeahead": return cdpReadHierState(s.wrapperSel);
        case "hierarchical": return cdpReadSourcePick(s.wrapperSel);
        case "date": return (s.dateSegs || []).map(function (seg) {
          return cdpReadInputBySel(s.wrapperSel + ' [data-automation-id="dateSection' + seg + '-input"]');
        });
        default: return null;
      }
    } catch (e) { return null; }
  });
}
async function cdpReadAuditRaw(specs) {
  const readerSrc = AUDIT_RAW_READERS.map((f) => String(f)).join("\n");
  const expression = "(function(){\n" + readerSrc + "\nreturn (" + String(cdpAuditRawDispatch)
    + ")(" + JSON.stringify(specs || []) + ");\n})()";
  const res = await cdpSend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error("cdpReadAuditRaw: " + ((d.exception && d.exception.description) || d.text || "page exception"));
  }
  return res && res.result ? res.result.value : undefined;
}

// The actuation object. No tabId param — the substrate's single tracked
// attachment (cdpTabId) is the target; callers attach/detach around a run.
// `llmConfig` (AI-0 seam): the operator's {provider,model,apiKey,enabled} from storage,
// captured for act.llm. Omitted by recon/section harnesses (act.llm then short-circuits OFF).
// Per-key cooldown map for act.llm's rotation, in memory for the service worker's
// lifetime. Deliberately NOT persisted: llmConfig is config the website owns, so a
// cooldown written into storage would be wiped by the next sync (see llm-keys.js).
// Module scope, not per-actuation, so a key parked while filling field 3 stays parked for
// fields 4..60 rather than being re-probed on every one.
let cdpLlmKeyState = null;
// Primary-model failures this SW lifetime — surfaced at the end of a run so a degraded model is never
// something the operator has to infer from a slow fill (operator 2026-08-04).
let cdpLlmDemotions = [];
function cdpLlmDemotionSummary() {
  if (!cdpLlmDemotions.length) return null;
  const byModel = {};
  for (const d of cdpLlmDemotions) byModel[d.model] = (byModel[d.model] || 0) + 1;
  const worst = cdpLlmDemotions[0];
  return { count: cdpLlmDemotions.length, byModel, firstError: worst.error, model: worst.model };
}


// ── PORTED VERBATIM from the multi-ats branch (77abbdf, operator's) so the two paths share ONE
// implementation rather than two variants that drift. Workday uses these to choose synthetic vs
// trusted input; the multi-ATS combobox poll uses QUIESCENCE to tell "the menu isn't coming" from
// "the page is still busy" — a question its own read latency could only approximate. ────────────


function makeCdpActuation(llmConfig) {
  // Shared by act.trustedFocus and act.trustedType: a real click when we can measure the element,
  // DOM.focus when we cannot (a hidden tab can report a 0x0 rect, and the coordinate path would then
  // silently do nothing — which is exactly how the first version of this looked like a failed fix).
  const this_trustedFocus = async (sel) => {
    let how = null;
    try {
      const rect = await cdpRectReady(sel, true);
      if (rect && rect.w > 0) { await cdpClickAt(rect.cx, rect.cy); how = "click"; }
    } catch (e) { /* fall through */ }
    if (!how) { try { await cdpDomFocus(sel); how = "dom-focus"; } catch (e) { how = null; } }
    try { console.log(`[ApplyPilot][CDP] trustedFocus ${JSON.stringify(sel)} → ${how || "FAILED"}`); } catch (e) { /* log only */ }
    return how;
  };
  return {
    // AI-1: the brain gates the AI-fallback on this BEFORE opening a field (so a disabled
    // toggle never opens/actuates). Mirrors act.llm's own enabled check (both read llmConfig).
    aiEnabled: !!(llmConfig && llmConfig.enabled),
    delay: cdpAdaptiveDelay, // ALL driver pacing goes through this — visibility-adaptive: fast foreground, full hidden (SW wall-clock)
    delayFull: cdpDelay,     // NON-adaptive (never sped up): waits where the PAGE's own render needs real wall-clock time regardless of tab visibility. The 5x speedup is for OUR pacing between actions, NEVER the page's render.
    delayRender: cdpAdaptiveDelay, // STAGE 2 (2026-07-04): render-SETTLE intervals (dropdown option-list settle + commit-persistence) — adaptive on the SAME cdpFast() measured signal as `delay`. Safe to shrink because the sites gated by it use interval-LENGTH-INDEPENDENT state gates (2-equal-non-zero reads / persistence re-read), and it only shrinks when timers MEASURE fast (worker-backed/visible → the render genuinely completes in ~50ms). Slow/throttled ⇒ full ⇒ byte-identical to the old delayFull. Driver falls back to delayFull when this is absent (older fakes).
    visible: cdpVisible, // REAL tab visibility (tab.active && window not minimized), cached — the honest "is the page PAINTING?" signal. NOT cdpFast (which is true for hidden+worker-timers). The dropdown OVERWRITE debounce is a paint thing (~700ms hidden, tiny visible), so the fill uses this to pick the overwrite fast/slow beats. Absent on older fakes ⇒ driver treats as hidden (the safe, larger beat).

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
    // Shared page-state probes (ported from the Workday branch): "is the tab producing frames?"
    // and "has this subtree stopped mutating?". The multi-ATS poll needs the second to tell an
    // absent menu from a page that is still reacting.
    // A TRUSTED click on an element, for the widgets that will not wake for a synthetic one.
    // Greenhouse's location combobox is the case that earned this (2026-08-06): a synthetic open
    // click leaves its suggestion service asleep — the fill typed "Tallahassee" and waited 22.7s for
    // nothing — while ONE real click makes the very same synthetic typing return
    // "Tallahassee, Florida, United States" in about a second. In an ATS run cdpClickAt is already
    // trusted (synthetic mode is only armed for Workday fills), so this is a genuine
    // Input.dispatchMouseEvent, not another page-side dispatch.
    // …and TRUSTED KEYSTROKES for the same widgets. A real click alone was not enough: with
    // `trustedFocus → click` in the log, Greenhouse's school box still sat `loading` and its location
    // box still showed nothing, while the manual test that worked used a real click AND real typing
    // (2026-08-06). cdpTypeChars sends genuine key events, which is what these async loaders are
    // watching for; ordinary synthetic typing keeps driving every other widget on the page.
    trustedType: async (sel, text) => {
      const how = await this_trustedFocus(sel);
      if (!how) return false;
      try {
        await cdpSelectAllDelete();          // clear whatever is there, trusted
        await cdpTypeChars(String(text));    // real keydown/keypress/keyup per character
        return true;
      } catch (e) { return false; }
    },
    trustedFocus: (sel) => this_trustedFocus(sel),
    painting: () => cdpPainting(),
    paintLabel: () => cdpPaintLabel(),
    quietInstall: (sel) => cdpEval(cdpInstallQuietWatch, sel),
    quietRead: (sel) => cdpEval(cdpReadQuiet, sel),
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
    // Segment-scoped clear for the DATE composite. Ctrl+A is forbidden there (it spans the whole
    // composite and resets focus to Month), so Backspace on a triple-click-SELECTED segment is the
    // only way to empty one — which is what makes a genuine empty→value transition possible.
    pressBackspace: () => cdpKeyTap(CDP_KEYS.backspace),
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
      // READ-ONLY diagnostic for the intermittent dropdown first-commit stray: capture whether the click
      // point actually holds the target option AT CLICK TIME. Compare across the first commit + the fallback
      // re-commit to tell a MIS-CLICK (hitTarget=false / atPoint≠text) from an interactive-readiness no-commit
      // (hitTarget=true, click lands right but the value doesn't take). collisions>1 = aria-controls id shared.
      try { console.log(`[ApplyPilot][CDP-DD-COMMIT] "${text}" hitTarget=${rect.hitTarget} atPoint=${JSON.stringify(rect.atPointText)} collisions=${rect.collisions} rect=${rect.cx},${rect.cy}${rect.hitTarget === false ? " ⚠ OFF-TARGET" : ""}`); } catch (e) {}
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
      // TIMING + HOP COUNT (2026-08-06): this is one of the slowest single actions in a fill and the only
      // way to tune it is to know where its time goes. `steps` is the number of scroll hops, `ms` the
      // wall-clock, and `firstRenderMs` how much of that was spent waiting for the list to mount before a
      // single hop happened — three different fixes depending on which dominates.
      const _t0 = Date.now();
      const r = await cdpEval(cdpScrapeTaOptions, loc.wrapperSel);
      const ms = Date.now() - _t0;
      console.log("[ApplyPilot][CDP-SCRAPE-TA]", loc.wrapperSel, r && r.ok
        ? r.count + " options" + (r.atBottom ? " (reached bottom)" : "") + " in " + ms + "ms"
          + " [" + r.steps + " hop(s): " + r.hopEarly + " committed / " + r.hopTimeouts + " TIMED OUT, " + r.hopWaitMs + "ms waiting"
          + (r.firstRenderMs != null ? ", first-render " + r.firstRenderMs + "ms" : "")
          + (r.cappedOut ? ", CAPPED OUT" : "") + ", ~" + (r.steps ? Math.round((ms - (r.firstRenderMs || 0)) / r.steps) : 0) + "ms/hop]"
          + " [role=" + r.roleCount + " prompt=" + r.promptCount + " used=" + r.usedSel + "]"
        : "FAILED in " + ms + "ms");
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
    // Perf: read MANY fields' raw state in ONE round-trip for the M40 audit (see cdpReadAuditRaw).
    readAuditRaw: (specs) => cdpReadAuditRaw(specs),
    focusHierSearch: (loc) => cdpEval(cdpFocusBySel, loc.wrapperSel + ' input[data-automation-id="searchBox"]'),
    // Diagnostic twin — same attempt, but returns WHY it failed (see cdpFocusDiag).
    focusHierSearchDiag: (loc) => cdpEval(cdpFocusDiag, loc.wrapperSel + ' input[data-automation-id="searchBox"]'),
    // The multiselect's input carries data-automation-id="searchBox" ONLY ONCE OPEN (skills, traced
    // 2026-08-07), so every searchBox-keyed selector above is unreachable while the widget is closed and
    // opening otherwise has to go through a COORDINATE click. focus() + click() on the widget's own input
    // needs no coordinates and no paint — the skills opener alternates the two routes. Returns a
    // diagnostic (not a bool); the caller polls readHier, since the searchBox id appears a tick later.
    openHierInput: (loc) => cdpEval(cdpOpenMultiselectInput, loc.wrapperSel),
    // A TRUSTED coordinate click aimed at the widget's own INPUT rect. openHier's ladder resolves
    // `multiselectInputContainer` first and clicks its CENTRE, which is fine for a single-value picker but
    // wrong for a multi-value one: that container GROWS with each chip, so its centre drifts onto a CHIP,
    // whose DELETE_charm is part of it (live: a skill present after one run was GONE after the next, in a
    // run that logged our own "chip set changed" signal). The input is a distinct element from the chips,
    // so a click at ITS centre opens the widget and cannot delete anything.
    clickHierInputRect: async (loc) => {
      const r = await cdpEvalRectReady(cdpRectOf, loc.wrapperSel + " input", true);
      if (!r || r.w <= 0) return false;
      await cdpClickAt(r.cx, r.cy);
      return true;
    },
    // React-safe, focus-independent clear of the widget's search input (see cdpClearInputNative).
    clearHierInput: (loc) => cdpEval(cdpClearInputNative, loc.wrapperSel + " input"),
    // Blur whatever holds focus — the "click out of the box" half of a commit. Workday's date composite
    // keeps a typed value in the DOM but does not hand it to its own model until the field is left, which
    // surfaced as a phantom "The field From is required" on a page visibly showing the date.
    blurActive: () => cdpEval(() => {
      const el = document.activeElement;
      if (!el || !el.blur || el === document.body) return { ok: false, reason: "nothing focused" };
      const aid = (el.getAttribute && el.getAttribute("data-automation-id")) || el.id || el.tagName;
      el.blur();
      try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) { /* blur alone may suffice */ }
      return { ok: true, blurred: aid };
    }),
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
    readCheckboxGroup: (loc) => cdpEval(cdpReadCheckboxGroupState, loc.wrapperSel), // pick-one checkbox set (self-ID); clickRadioLabel commits by label id
    // Wait until the DOM around `loc` has stopped mutating for `quietMs`. NEVER hangs: on the ceiling it
    // reports quiet:false and the caller proceeds anyway — a gate that can block a fill forever is worse
    // than the bug it guards. Polls SW-side on wall-clock; the page only stamps.
    // Arm the observer EARLY (idempotent — a second call is `already:true` and does NOT re-stamp), so idle
    // time accrues during work the caller is doing anyway and the gate below can return immediately.
    installQuietWatch: (loc) => cdpEval(cdpInstallQuietWatch, loc.wrapperSel),
    awaitQuiet: async (loc, opts) => {
      const quietMs = (opts && opts.quietMs) || 400;
      const ceilingMs = (opts && opts.ceilingMs) || 3000;
      const t0 = Date.now();
      try {
        const ins = await cdpEval(cdpInstallQuietWatch, loc.wrapperSel);
        if (!ins || !ins.ok) return { quiet: false, waitedMs: 0, error: (ins && ins.error) || "install failed" };
        // A fresh install stamps NOW, so the first pass always waits one full quiet window — which is the
        // conservative direction and costs quietMs once per widget.
        for (;;) {
          const q = await cdpEval(cdpReadQuiet, loc.wrapperSel);
          const waited = Date.now() - t0;
          if (q && q.ok && q.idleMs >= quietMs) return { quiet: true, waitedMs: waited, idleMs: q.idleMs };
          if (waited >= ceilingMs) return { quiet: false, waitedMs: waited, idleMs: (q && q.idleMs) || null };
          await cdpDelay(Math.min(80, quietMs));   // real wall-clock, never the adaptive delay
        }
      } catch (e) { return { quiet: false, waitedMs: Date.now() - t0, error: String((e && e.message) || e) }; }
    },
    scanOrphanCheckboxes: () => cdpEval(cdpScanOrphanCheckboxes), // consents rendered OUTSIDE any formField wrapper (read-only inventory for review)
    // Blur whatever the fill last focused (2026-07-25, operator): some tenants only COMMIT a text field —
    // and fire the cascade it triggers — on BLUR, and the fill leaves focus INSIDE the last field it typed
    // (Caterpillar's SMS-consent checkbox is revealed by the phone number and never appeared while the
    // phone box still had focus). A direct activeElement.blur() rather than Tab: it fires blur/focusout
    // without moving focus INTO the next widget (no risk of arming a typeahead / opening a picker).
    blurActive: () => cdpEval(() => {
      const a = document.activeElement;
      if (!a || a === document.body || typeof a.blur !== "function") return false;
      a.blur();
      return true;
    }),
    // Returns a TRUTHY object (existing `&&` callers are unaffected) carrying WHERE it clicked and what
    // was under that point — so a caller reporting "did not commit" can say whether a click was even
    // dispatched, and whether it landed on the intended label. `false` still means no click happened.
    clickRadioLabel: async (loc, id) => {
      const rect = await cdpRectReady('label[for="' + id + '"]', true); // M29: retry the label rect
      if (!rect) return false;                                          // no rect ⇒ NOTHING was dispatched
      let hit = null;
      try { hit = await cdpEval(cdpHitAt, rect.cx, rect.cy, id); } catch (e) { /* diagnostic only */ }
      await cdpClickAt(rect.cx, rect.cy);
      return { ok: true, cx: Math.round(rect.cx), cy: Math.round(rect.cy), hit };
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
      const SEL = '[data-automation-id="pageFooterNextButton"]';
      const reviewPresent = await cdpEval(() => !!document.querySelector('[data-automation-id="applyFlowReviewPage"]'));
      if (reviewPresent) return { clicked: false, refused: "review-page" };
      // COMMIT THE LAST FIELD BEFORE SAVING (2026-07-28). Workday validates on blur, and in synthetic
      // mode the last-filled field is still focused here — its blur would otherwise race this very click
      // (see cdpCommitPendingEdits). Blur it and give the validator a beat. Cheap, and it applies to both
      // walks because both advance through this one method. Never touches a value, so it cannot mis-fill;
      // at Save time no widget should be mid-interaction, so there is nothing to disturb.
      try {
        const c = await cdpEval(cdpCommitPendingEdits);
        if (c && c.blurred) { await cdpAdaptiveDelay(400); }
      } catch (e) { /* best effort — the click and its error check still gate everything */ }
      // A popup/overlay (the Simplify extension's dialog, a cookie banner, a modal) can sit OVER Save &
      // Continue: a coordinate click would land on the popup and be SWALLOWED — the page never advances
      // and it surfaces as a bare nav-timeout. So cover-check the button's center first and refuse with a
      // diagnostic that NAMES the blocker rather than clicking blindly.
      // MEASURE + CHECK TOGETHER, RE-MEASURING each round (2026-07-25, Solar Turbines): the rect and the
      // cover test must describe the SAME layout. A field revealed by an earlier fill — Caterpillar mounts
      // an SMS-consent checkbox after the phone number — REFLOWS the footer DOWNWARD, so a rect taken a
      // moment earlier is stale and elementFromPoint reports whatever now sits at the old point (live: a
      // floating extension widget). The old code never re-measured, so it halted blaming an overlay that
      // was never on the button. Re-probing also lets a genuinely-animating overlay settle.
      const probe = async () => {
        const r = await cdpRectReady(SEL, true);
        if (!r) return { rect: null, cover: null };
        return { rect: r, cover: await cdpEval(cdpCoverCheck, SEL, r.cx, r.cy) };
      };
      let { rect, cover } = await probe();
      if (!rect) return { clicked: false, refused: "no-button" };
      for (let i = 0; i < 3 && cover && cover.blocked; i++) { // reflow/animation settle before believing it
        await cdpDelay(250);
        const p = await probe();
        if (!p.rect) break;
        rect = p.rect; cover = p.cover;
      }
      if (cover && cover.blocked) {
        // Best-effort auto-dismiss (operator opted in 2026-07-06): try ONCE to click a clearly-dismissive
        // control (X/Close/No-thanks — never Accept/OK) inside the popup, incl. Simplify's shadow-DOM overlay,
        // then re-check. If it clears → proceed; else halt (operator closes it) — never force-remove DOM.
        const d = await cdpEval(cdpFindDismissControl, rect.cx, rect.cy);
        if (d && d.found) {
          console.log("[ApplyPilot][CDP] Save & Continue covered by", cover.by, "— clicking its dismiss control:", JSON.stringify(d.label));
          await cdpClickAt(d.cx, d.cy);
          let clear = false;
          for (let i = 0; i < 5 && !clear; i++) { // let it animate out — RE-MEASURING each poll (the button may also have moved)
            await cdpDelay(300);
            const p = await probe();
            if (!p.rect) continue;
            rect = p.rect;
            clear = !(p.cover && p.cover.blocked);
          }
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

    // clickSubmit(authorize) — the ONE submit-capable click. EXACT INVERSE of clickPageNext: it fires
    // ONLY when the review marker is PRESENT *and* authorize === true, then clicks pageFooterNextButton
    // (which IS the Submit button on the review page). This is the sole place an application can be
    // submitted; clickPageNext refuses on the review page, so no other click can. Defense in depth: the
    // walk's submitPrecondition gate must ALSO pass before this is ever called. Never auto-dismisses an
    // overlay (unlike clickPageNext) — a covered Submit button REFUSES, it does not click blindly.
    clickSubmit: async (authorize) => {
      if (authorize !== true) return { clicked: false, refused: "not-authorized" };
      const reviewPresent = await cdpEval(() => !!document.querySelector('[data-automation-id="applyFlowReviewPage"]'));
      if (!reviewPresent) return { clicked: false, refused: "not-review-page" }; // NEVER submit off the review page
      const rect = await cdpRectReady('[data-automation-id="pageFooterNextButton"]', true);
      if (!rect) return { clicked: false, refused: "no-button" };
      // Covered-button guard (same as clickPageNext) — a swallowed submit click would look like a no-op.
      const cover = await cdpEval((cx, cy) => {
        const btn = document.querySelector('[data-automation-id="pageFooterNextButton"]');
        const top = document.elementFromPoint(cx, cy);
        if (!btn || !top || top === btn || btn.contains(top) || top.contains(btn)) return { blocked: false };
        return { blocked: true, by: (top.getAttribute && top.getAttribute("data-automation-id")) || (top.tagName ? top.tagName.toLowerCase() : "?") };
      }, rect.cx, rect.cy);
      if (cover && cover.blocked) return { clicked: false, refused: "blocked", blockedBy: cover.by };
      await cdpClickAt(rect.cx, rect.cy);
      return { clicked: true, submitted: true };
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
    // `action` picks the operator's per-action model (default "fill"); the route resolver
    // walks that action's model, its fallback chain, then the configured default — and for
    // each of those, callLLM rotates through every key the operator holds for that
    // provider. A v1 config still resolves to exactly one attempt with one key, so this
    // path is byte-identical for anyone who hasn't added a second key.
    llm: async ({ system, user, maxTokens, action }) => {
      if (!llmConfig || !llmConfig.enabled) return { ok: false, error: "AI fill OFF (enable it in the popup)" };
      // ── TEMPORARY RECON (2026-08-06, chrome.storage.local.debugAiPrompts) ─────────────────────────
      // Operator ask: "what exactly was the prompt sent to AI, and each time AI actually is called on
      // this page". Every AI call funnels through here — per-field AND batched — so this is the one
      // place that cannot miss one. Prompt and reply are truncated: the point is WHICH questions and
      // WHICH options went out (and what came back), not a verbatim transcript of the profile blob.
      const _dbgPrompts = await new Promise((r) => { try { chrome.storage.local.get("debugAiPrompts", (v) => r(!!(v && v.debugAiPrompts))); } catch (e) { r(false); } });
      if (_dbgPrompts) {
        const qOnly = String(user || "").split("\nApplicant profile:")[0];   // drop the profile blob — same every call
        console.log(`[ApplyPilot][AI-CALL] action=${action || "fill"} maxTokens=${maxTokens || "?"} — QUESTIONS/OPTIONS: `
          + qOnly.slice(0, 1400) + (qOnly.length > 1400 ? " …[cut]" : ""));
      }
      const attempts = typeof resolveLlmRoute === "function"
        ? resolveLlmRoute(llmConfig, action || "fill", LLM_DEFAULT_MODELS)
        : [{ provider: llmConfig.provider, model: llmConfig.model }];
      if (!attempts.length) return { ok: false, error: "no AI model configured (set one on the website's AI page)" };

      let last = null;
      const t0All = Date.now();
      for (const attempt of attempts) {
        const tAttempt = Date.now();
        // A LATER model is a cheaper remedy than waiting on this one. Fail fast on every attempt but
        // the last so the fallback is reached in ms, not after the full retry ladder; the final
        // attempt keeps the ladder, because then waiting really is all that is left. Mirrors what
        // callLLM already does across multiple KEYS.
        const isLast = attempts.indexOf(attempt) === attempts.length - 1;
        const keys = typeof llmKeysFor === "function" ? llmKeysFor(llmConfig, attempt.provider) : [];
        // Name the route BEFORE the call, so a wrong model is visible in the log next to the field it
        // answered rather than inferred from the answer's quality. Never the key itself — only how many
        // are available to rotate through, which is what you need when a call fails.
        console.log(`[LLM] ${attempt.provider} ${attempt.model}` +
          (attempt.thinking ? ` thinking:${attempt.thinking}${attempt.effort ? "/" + attempt.effort : ""}` : "") +
          ` for "${action || "fill"}"` +
          (keys.length ? ` (${keys.length} key${keys.length > 1 ? "s" : ""})` : " (single key)") +
          (attempts.length > 1 ? ` [attempt ${attempts.indexOf(attempt) + 1}/${attempts.length}]` : ""));
        const res = await callLLM({
          provider: attempt.provider,
          model: attempt.model,
          thinking: attempt.thinking,
          effort: attempt.effort,
          // llmKeysFor already folds a v1 flat apiKey into a one-key list, so passing
          // apiKey as well would just duplicate it.
          keys,
          apiKey: keys.length ? "" : llmConfig.apiKey,
          preferFreeFirst: llmConfig.preferFreeFirst !== false,
          // Cooldowns live for the service worker's lifetime, so a key parked on one
          // field is skipped for the rest of the form instead of being re-probed 60 times.
          keyState: cdpLlmKeyState,
          onKeyState: (s) => { cdpLlmKeyState = s; },
          noRetry: !isLast,
          system, user, maxTokens
        });
        // Every attempt is recorded — successes for spend/quota, failures because a run of
        // quota errors is the clearest sign a key is spent.
        if (typeof recordLlmUsage === "function" && typeof llmUsageEntry === "function") {
          recordLlmUsage(llmUsageEntry(action || "fill", res));
        }
        if (res.ok) {
          const ms = Date.now() - tAttempt;
          console.log(`[LLM] ok in ${ms}ms` + (attempts.length > 1 ? ` (${Date.now() - t0All}ms total across ${attempts.indexOf(attempt) + 1} attempt(s))` : "")
            // Without this a fast-retry recovery is invisible: the elapsed time just looks normal, and
            // the stuck socket it stepped over leaves no trace at all.
            + (res.fastAborts ? ` — after ${res.fastAborts} fast-retry abort(s)` : ""));
          return res;
        }
        // A FAILED attempt names itself too — with several models configured as fallbacks, silence
        // here makes it impossible to tell whether the answer came from your first choice or the
        // third one down the list.
        // A run that quietly spends every call on the fallback looks like "the AI is slow" and stays a
        // mystery. Count it and say so ONCE, loudly, the first time — the operator should learn their
        // primary model is down from the log, not from wondering why a fill dragged.
        cdpLlmDemotions.push({ model: attempt.model, error: String((res && res.error) || "").slice(0, 80) });
        if (cdpLlmDemotions.length === 1 && !isLast) {
          console.log(`[ApplyPilot] ⚠ YOUR PRIMARY AI MODEL IS FAILING — ${attempt.provider} ${attempt.model} did not answer,` +
            ` so this run is using the fallback instead. Every AI field pays a wasted request first.` +
            ` If this keeps happening, reorder the models on the AI page so a working one is first.`);
        }
        console.log(`[LLM] ${attempt.provider} ${attempt.model} FAILED after ${Date.now() - tAttempt}ms` +
          (isLast ? " (full retry ladder — no fallback left)" : " (failing fast to the next model)") +
          ` — ${String((res && res.error) || "no reply").slice(0, 140)}`);
        last = res;
      }
      if (attempts.length > 1) console.log(`[LLM] all ${attempts.length} attempt(s) failed in ${Date.now() - t0All}ms total`);
      return last || { ok: false, error: "no AI attempt made" };
    }
  };
}
