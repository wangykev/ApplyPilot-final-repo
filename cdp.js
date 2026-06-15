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

// ── Input primitives (trusted, off-loop) ────────────────────────────────────

// Full mouse click at viewport CSS-pixel coords: move → press → release — the
// closest CDP analog to a real click; the resulting page events are isTrusted.
async function cdpClickAt(x, y) {
  const base = { x: Math.round(x), y: Math.round(y), pointerType: "mouse" };
  await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0 });
  await cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", ...base, button: "left", buttons: 1, clickCount: 1 });
  await cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, button: "left", buttons: 0, clickCount: 1 });
}

// Insert text into the FOCUSED editable as one IME-style commit — fires trusted
// beforeinput/input (no per-key events). Recon (a) decides if this is enough
// for Workday's React or whether per-char key events are needed.
function cdpInsertText(text) {
  return cdpSend("Input.insertText", { text: String(text) });
}

// Named-key tap (keyDown + keyUp). def = { key, code, vk, text?, modifiers? }.
async function cdpKeyTap(def) {
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

function cdpReadTextState(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  const input = w && w.querySelector("input");
  if (!input) return null;
  return { value: input.value, focused: document.activeElement === input };
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

// All typeahead-classified wrappers on the page, INCLUDING inside repeating
// entries (page-2 fieldOfStudy/certification live in entries; a document-order
// query on the duplicated formField-* id resolves entry 1). `source` excluded —
// hierarchical is a different code path (own recon + milestone).
function cdpScanTypeaheads() {
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const out = [];
  for (const w of document.querySelectorAll('[data-automation-id^="formField-"]')) {
    const id = w.getAttribute("data-automation-id");
    const fieldName = id.slice("formField-".length);
    if (fieldName === "source") continue;
    if (!w.querySelector('[data-uxi-widget-type="multiselect"]')) continue;
    const legend = w.querySelector("legend");
    let label = legend ? legend.textContent.trim() : null;
    if (!label) { for (const l of w.querySelectorAll("label")) { const t = (l.textContent || "").trim(); if (t) { label = t; break; } } }
    const entry = w.closest('[data-fkit-id$="--null"]');
    const sb = w.querySelector('input[data-automation-id="searchBox"]');
    const opener =
      (w.querySelector('[data-automation-id="multiselectInputContainer"]') && "multiselectInputContainer") ||
      (w.querySelector('[data-uxi-widget-type="selectinput"]') && "selectinput") ||
      (w.querySelector("input") && "input") || "wrapper";
    out.push({
      wrapperSel: '[data-automation-id="' + id + '"]',
      fieldName,
      label: label || null,
      entryFkitId: entry ? entry.getAttribute("data-fkit-id") : null,
      chips: Array.from(w.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => (c.textContent || "").trim()),
      searchBoxPresent: !!sb,
      searchBoxVisible: !!(sb && isVisible(sb)),
      opener
    });
  }
  return out;
}

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
function makeCdpActuation() {
  return {
    delay: cdpDelay, // ALL driver pacing goes through this (SW wall-clock)

    scanPage: () => cdpEval(cdpPageScan),

    // ── text ──
    // Focus ladder (recon: cdp-click is what works; the rest are fallbacks).
    focusText: async (loc) => {
      const inputSel = loc.wrapperSel + " input";
      const rect = await cdpEval(cdpRectOf, inputSel, true);
      if (rect && rect.w > 0) {
        await cdpClickAt(rect.cx, rect.cy);
        await cdpDelay(250);
        const s = await cdpEval(cdpReadTextState, loc.wrapperSel);
        if (s && s.focused) return "cdp-click";
      }
      if (await cdpEval(cdpFocusBySel, inputSel)) return "page-focus()";
      try {
        await cdpDomFocus(inputSel);
        const s = await cdpEval(cdpReadTextState, loc.wrapperSel);
        if (s && s.focused) return "DOM.focus";
      } catch (e) { /* fall through to null */ }
      return null;
    },
    clearText: () => cdpSelectAllDelete(),
    typeText: (text) => cdpInsertText(text), // recon (a): trusted beforeinput+input, survives blur
    readTextValue: (loc) => cdpEval(cdpReadTextState, loc.wrapperSel),

    // ── dropdown ──
    openDropdown: async (loc) => {
      const rect = await cdpEval(cdpRectOf, loc.wrapperSel + ' button[aria-haspopup="listbox"]', true);
      if (!rect || rect.w <= 0) return false;
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
      const rect = await cdpEval(cdpRectOf, 'label[for="' + id + '"]', true);
      if (!rect || rect.w <= 0) return false;
      await cdpClickAt(rect.cx, rect.cy);
      return true;
    },
    focusInput: (id) => cdpEval(cdpFocusInputById, id),
    readChecked: (id) => cdpEval(cdpReadCheckedById, id),
    readCheckboxState: (loc) => cdpEval(cdpReadCheckboxState, loc.wrapperSel),
    clickCheckboxLabel: async (loc) => {
      const st = await cdpEval(cdpReadCheckboxState, loc.wrapperSel);
      if (!st || !st.inputId) return false;
      let rect = await cdpEval(cdpRectOf, 'label[for="' + st.inputId + '"]', true);
      if (!rect || rect.w <= 0) rect = await cdpEval(cdpRectOf, loc.wrapperSel + ' input[type="checkbox"]', true);
      if (!rect || rect.w <= 0) return false;
      await cdpClickAt(rect.cx, rect.cy);
      return true;
    }
  };
}
