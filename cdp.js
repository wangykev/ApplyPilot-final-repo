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
    console.log("[ApplyPilot][CDP] chrome.debugger detached externally —", reason);
    cdpTabId = null;
  }
});

// SW-side wall-clock delay — the ONLY pacing primitive CDP fill code may use.
// (Page-side setTimeout is throttled to ~1Hz hidden, then frozen; this isn't.)
const cdpDelay = (ms) => new Promise((r) => setTimeout(r, ms));

// Attach to `tabId` and enable the domains we use (Runtime for evaluate, DOM for
// the DOM.focus fallback; Input.* needs no enable). { ok } or { ok:false, error }.
function cdpAttach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, "1.3", async () => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      cdpTabId = tabId;
      _visCache = { visible: false, at: 0 }; // fresh foreground sampling per run (adaptive pacing)
      try {
        await cdpSend("Runtime.enable", {});
        await cdpSend("DOM.enable", {});
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
const FAST_FACTOR = 0.2;    // visible delays = 1/5 the hidden delays (conservative; tunable — raise if a visible fill races)
const FAST_FLOOR_MS = 25;   // …but never below this (a too-short wait races even full-speed)
const VIS_TTL_MS = 500;     // re-sample document.visibilityState at most this often (amortize the cdpEval round-trip)

let _visCache = { visible: false, at: 0 };

// Cached, off-loop foreground read. cdpEval runs promptly even when hidden, so
// this is reliable in both states; the TTL keeps act.delay from round-tripping
// every call. Reset at attach (fresh per run). On read failure (tab closing)
// default to NOT-visible → full (safe) delays.
async function cdpVisible() {
  if (Date.now() - _visCache.at <= VIS_TTL_MS) return _visCache.visible;
  let vis = false;
  try { vis = (await cdpEval(() => document.visibilityState)) === "visible"; } catch (e) { vis = false; }
  _visCache = { visible: vis, at: Date.now() };
  return vis;
}

// The adaptive pacing primitive wired into act.delay. Visible → scaled-down wait;
// hidden → the full caller-requested wait (byte-identical to the proven path).
async function cdpAdaptiveDelay(ms) {
  const fast = await cdpVisible();
  await cdpDelay(fast ? Math.max(FAST_FLOOR_MS, Math.round(ms * FAST_FACTOR)) : ms);
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

// ── Input primitives (trusted, off-loop) ────────────────────────────────────

// Full mouse click at viewport CSS-pixel coords: move → press → release — the
// closest CDP analog to a real click; the resulting page events are isTrusted.
async function cdpClickAt(x, y) {
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
  if (inputLockActive) await actingDelta(+1);
  try { return await cdpSend("Input.insertText", { text: String(text) }); }
  finally { if (inputLockActive) await actingDelta(-1); }
}

// Named-key tap (keyDown + keyUp). def = { key, code, vk, text?, modifiers? }.
// The keyboard choke: cdpTypeChars / cdpSelectAllDelete / pressEnter/Escape/arrows ALL
// route through here, so gating cdpKeyTap covers the bot's entire key path (counter-based,
// so the nested cdpTypeChars→cdpKeyTap stays "acting" throughout — no per-char gap).
async function cdpKeyTap(def) {
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
  for (const ch of String(text)) {
    const isLetter = /^[a-z]$/i.test(ch);
    const isDigit = /^[0-9]$/.test(ch);
    const code = isLetter ? "Key" + ch.toUpperCase() : isDigit ? "Digit" + ch : ch === " " ? "Space" : "";
    const vk = isLetter || isDigit ? ch.toUpperCase().charCodeAt(0) : ch === " " ? 32 : 0;
    await cdpKeyTap({ key: ch, code, vk, text: ch });
    await cdpDelay(perCharDelayMs);
  }
}

// Clear the FOCUSED text input: Select-All (Ctrl+A — Windows/Linux modifier 2)
// then Delete. Trusted key path so React sees a real edit, unlike a "" setter.
async function cdpSelectAllDelete() {
  await cdpKeyTap({ key: "a", code: "KeyA", vk: 65, modifiers: 2 });
  await cdpDelay(60);
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
  const isRepeating = (w) => !!(w.closest('[data-fkit-id^="workExperience-"]') || w.closest('[data-fkit-id^="education-"]')
    || w.closest('[data-fkit-id^="webAddress-"]') || w.closest('[data-fkit-id^="language-"]')
    || w.closest('[data-fkit-id^="certification-"]'));
  const all = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
  const wrappers = all.filter((w) => !isRepeating(w));
  return {
    url: location.href,
    repeatingFieldCount: all.length - wrappers.length,
    fields: wrappers.map((w) => {
      const id = w.getAttribute("data-automation-id");
      return {
        wrapperSel: '[data-automation-id="' + id + '"]',
        fieldName: id.slice("formField-".length),
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
  const PREFIXES = ["workExperience-", "education-", "webAddress-", "language-", "certification-"];
  const sections = {};
  for (const prefix of PREFIXES) {
    const entries = Array.from(document.querySelectorAll('[data-fkit-id^="' + prefix + '"][data-fkit-id$="--null"]'));
    if (!entries.length) continue;
    sections[prefix] = {
      entryCount: entries.length,
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
        const fields = Array.from(e.querySelectorAll('[data-automation-id^="formField-"]')).map((w) => {
          const id = w.getAttribute("data-automation-id");
          const fieldName = id.slice("formField-".length);
          return {
            fieldName, automationId: id,
            widgetType: classify(w),
            label: labelOf(w),
            isRequired: requiredOf(w),
            hashedId: isHashed(fieldName),
            dateSegments: dateSegsOf(w),
            wrapperSel: '[data-fkit-id="' + fkit + '"] [data-automation-id="' + id + '"]'
          };
        });
        return { entryFkitId: fkit, deletePresent: !!del, deleteRect: rectOf(del), fieldCount: fields.length, fields };
      })
    };
  }
  const addButtons = Array.from(document.querySelectorAll('[data-automation-id="add-button"]'))
    .map((b) => ({ text: (b.textContent || "").trim().slice(0, 30), rect: rectOf(b), nearestHeading: nearestHeading(b) }));
  return { url: location.href, sectionsPresent: Object.keys(sections), sections, addButtons };
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
    errorPageText: errMatch ? errMatch[0].replace(/\s+/g, " ").trim().slice(0, 200) : null,
    // M31: error-element detail for the validation-vs-VPS recon diff
    errorMarkers: { count: errorEls.length, samples: errorEls.slice(0, 8).map((el) => (el.textContent || "").trim().slice(0, 120)).filter(Boolean) },
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

  const adFrom = (el) => (el && el.getAttribute && el.getAttribute("aria-activedescendant")) || null;
  const activeId = adFrom(document.activeElement) || adFrom(sb) || (acEl ? adFrom(acEl) : null);
  const activeEl = activeId ? document.getElementById(activeId) : null;

  return {
    searchBox: sb
      ? { present: true, visible: isVisible(sb), focused: document.activeElement === sb, value: sb.value }
      : { present: false, visible: false, focused: false, value: null },
    chips,
    banner,
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

  // Category vs leaf — mirror the in-tree fillSource isCategory heuristics.
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
  let banner = false;
  for (const el of document.querySelectorAll('[data-automation-id="promptTitle"]')) {
    if (isVisible(el) && /no matches found/i.test((el.textContent || "").trim())) { banner = true; break; }
  }
  return {
    searchBox: sb
      ? { present: true, visible: isVisible(sb), focused: document.activeElement === sb, value: sb.value }
      : { present: false, visible: false, focused: false, value: null },
    leaves, leafCount: leaves.length, sig, banner,
    chips: Array.from(w.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => (c.textContent || "").trim())
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
    delayFull: cdpDelay,     // NON-adaptive (never sped up): waits where the PAGE's own render needs real wall-clock time regardless of tab visibility (dropdown option-list render + commit-verify). The 5x speedup is for OUR pacing between actions, NEVER the page's render.

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
          await cdpDelay(250);
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
        if (r && r.w > 0) { await cdpTripleClickAt(r.cx, r.cy); await cdpDelay(200); if (await focused()) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusDateSegment", JSON.stringify(displaySel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (triple-click-display)`); return "triple-click-display"; } }
        if (await cdpEval(cdpFocusBySel, inputSel)) { await cdpDelay(120); if (await focused()) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusDateSegment", JSON.stringify(inputSel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (el.focus)`); return "el.focus()"; } }
        try { await cdpDomFocus(inputSel); await cdpDelay(120); if (await focused()) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusDateSegment", JSON.stringify(inputSel), `RECOVERED after ${Date.now() - start}ms / ${attempt} retries (DOM.focus)`); return "DOM.focus"; } } catch (e) { /* not found */ }
        if (Date.now() - start >= RECT_READY_CEILING_MS) { if (attempt > 0) console.log("[ApplyPilot][CDP] focusDateSegment", JSON.stringify(inputSel), `gave up after ${Date.now() - start}ms / ${attempt} retries`); return null; }
        await cdpDelay(RECT_READY_INTERVAL_MS);
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
