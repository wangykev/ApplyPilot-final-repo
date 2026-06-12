// ============================================================================
// observe.js — OBSERVATION run (EXPERIMENT, throwaway).
//
// Purpose: capture the SAME throttle telemetry as the experiment probe, but for runs
// where **Claude in Chrome does the filling** and OUR engine must only watch. So this
// is a plain content script that ticks every 250ms from page load and (a) posts
// DBG_TICK to the service worker AND (b) paints a tiny live badge on the page so you
// get unmistakable visual confirmation it's running without opening any console.
//
// HARD CONSTRAINTS (by request):
//   • Watch-only — does NOT call injectFill, does NOT run fillEngine.
//   • NO chrome.debugger / NO CDP domains. Claude in Chrome owns the single debugger
//     client on this tab; attaching here would collide and break its run.
//   • optionCount uses the SAME window.__apOptionNodes union scrape as the experiment
//     probe. fillEngine never runs in an observation run, so nothing else defines that
//     handle — this file defines it (a verbatim mirror of background.js fillEngine's
//     scrape: settlePoll [role=option] ∪ fillSource promptOption leaves ∪ source rows).
//   • Gate NOTHING on hidden — tick continuously from load so the SW log captures the
//     whole run, including the visible warm-up baseline.
//   • The on-page badge is pointer-events:none and a fixed overlay — it touches no form
//     field and can never intercept a click, so the fill (by Claude in Chrome) is
//     unaffected. It's purely a visibility aid; delete this file to remove everything.
//
// NOTE: this is the ONE intentional exception to the project's "active-tab injection,
// NOT a content script" invariant. It is throwaway instrumentation that actuates
// nothing; the production fill path is unchanged. It runs on ALL Workday pages (its
// match patterns), and announces itself in the page console + the badge.
// ============================================================================
(function () {
  if (window.__apObserveStarted) return; // defensive: never double-start the ticker
  window.__apObserveStarted = true;

  // Mirror of fillEngine's isVisible (background.js) — no offsetParent check (it's null
  // for the position:fixed portaled option popups).
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };

  // SAME scrape/handle as the experiment probe. Defined here because fillEngine (which
  // exposes it in an experiment run) never executes in an observation run.
  window.__apOptionNodes = () =>
    Array.from(document.querySelectorAll('[role="option"], [role="treeitem"], [data-automation-id="promptOption"]'))
      .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true"
        && !el.closest('[data-automation-id="selectedItemList"]'));

  // ── Live on-page badge (visibility aid; watch-only, pointer-events:none) ──
  let badge = null;
  const ensureBadge = () => {
    if (badge || !document.body) return badge;
    badge = document.createElement("div");
    badge.id = "__ap-observe-badge";
    badge.style.cssText = [
      "position:fixed", "top:8px", "right:8px", "z-index:2147483647",
      "background:rgba(20,20,20,0.88)", "color:#0f0", "font:12px/1.4 monospace",
      "padding:6px 9px", "border-radius:6px", "border:1px solid #0f0",
      "pointer-events:none", "white-space:pre", "box-shadow:0 2px 8px rgba(0,0,0,0.4)"
    ].join(";");
    document.body.appendChild(badge);
    return badge;
  };
  const paintBadge = (t, perfDelta, visibility, optionCount, ticks) => {
    const b = ensureBadge();
    if (!b) return;
    b.textContent =
      `ApplyPilot OBSERVE (watch-only)\n` +
      `tick #${ticks}  t=${t}ms\n` +
      `Δperf=${perfDelta}ms ${perfDelta > 600 ? "⚠ throttled" : ""}\n` +
      `vis=${visibility}\n` +
      `options=${optionCount}`;
  };

  const state = { last: performance.now(), start: performance.now(), ticks: 0, id: null };
  const tick = () => {
    const now = performance.now();
    const perfDelta = Math.round(now - state.last); // ms since last tick — the throttle tell
    state.last = now;
    state.ticks++;
    let optionCount = 0;
    try { optionCount = window.__apOptionNodes().length; } catch (e) { optionCount = -1; }
    const visibility = document.visibilityState;
    paintBadge(Math.round(now - state.start), perfDelta, visibility, optionCount, state.ticks);
    try {
      chrome.runtime.sendMessage({
        type: "DBG_TICK",
        mode: "observe",
        t: Math.round(now - state.start),
        perfDelta,
        visibility,
        optionCount
      });
    } catch (e) { /* SW asleep / extension context invalidated — ignore; next tick retries */ }
  };

  state.id = setInterval(tick, 250);
  tick(); // immediate baseline reading at page load

  // Continuous — gate NOTHING. On page unload, post a final marker (housekeeping, not a gate).
  window.addEventListener("pagehide", () => {
    if (state.id) clearInterval(state.id);
    try {
      chrome.runtime.sendMessage({ type: "DBG_STOP", mode: "observe", ticks: state.ticks, visibility: document.visibilityState });
    } catch (e) { /* ignore */ }
  }, { once: true });

  console.log("[ApplyPilot][OBSERVE] watch-only ticker started on", location.href);
})();
