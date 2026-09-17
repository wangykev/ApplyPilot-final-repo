// test/ats-orc-pin-count.test.js — the pin-box COUNT is the expected code length, so it must count
// only real entry boxes.
//
// LIVE 2026-09-17, Emerson/ORC. The gate scan reported `pins=7` where recon documented six boxes
// (`input#pin-code-1…6`). That number is handed to the Gmail poll as `length`, so the extractor
// hunted a SEVEN-digit code while Oracle mails a six-digit one, and said so once the diagnostic
// existed:
//
//   43 matching message(s) arrived but no 7-digit code could be read from them
//   (latest subject: "Confirm your identity")
//
// So the mail was arriving and being parsed the whole time; one stray element made every code
// unmatchable. The cause was the selector: a bare `[id^="pin-code-"]` matches the WRAPPER that
// shares the id prefix, not just the inputs. It would also have had atsInjOrcFillPin typing into a
// non-input.
//
// ⚠ AND IT IS DELIBERATELY NOT FILTERED ON VISIBILITY. This repo's standing rule is that a box can
// be CSS-clipped and still be the real control (the Workday radio; ORC's own terms checkbox is 0x0).
// A `vis()` filter here could return 0 pins, and orcApplyView keys the whole "code" view off
// `pinInputs > 0` — so it would stop recognising the code screen at all, which is worse than an
// inflated count.
//
// Run: node --test test/ats-orc-pin-count.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ats = require("../ats.js");

// Execute the real injected scan against a fake document.
function runScan(els) {
  const nodes = els.map((e) => ({
    tagName: (e.tag || "input").toUpperCase(),
    id: e.id || "", name: e.name || "", type: e.type || "text", value: "",
    checked: false, className: "",
    getAttribute: (k) => (k in e ? e[k] : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: e.w == null ? 30 : e.w, height: e.h == null ? 30 : e.h }),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    parentElement: null,
  }));
  const match = (sel) => {
    if (sel === 'input[id^="pin-code-"]') return nodes.filter((n) => n.tagName === "INPUT" && n.id.startsWith("pin-code-"));
    if (sel === '[id^="pin-code-"]') return nodes.filter((n) => n.id.startsWith("pin-code-"));
    if (sel.includes("input:not([type=hidden])")) return nodes.filter((n) => n.type !== "hidden");
    return [];
  };
  const cssEscape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  const g = {
    document: { querySelectorAll: match, querySelector: () => null, title: "Confirm your identity" },
    location: { href: "https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26010099/apply/email" },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    window: { CSS: { escape: cssEscape } },
    CSS: { escape: cssEscape },
  };
  const f = new Function("g", `with (g) { return (${ats.atsInjOrcAuthScan.toString()})(); }`);
  return f(g);
}

const SIX_BOXES = [1, 2, 3, 4, 5, 6].map((n) => ({ id: "pin-code-" + n, type: "number" }));

test("⚠⚠ six boxes plus a wrapper sharing the id prefix still counts SIX", () => {
  const s = runScan([...SIX_BOXES, { tag: "div", id: "pin-code-container" }]);
  assert.strictEqual(s.pinInputs, 6,
    "the wrapper inflated this to 7, which became a 7-digit code search against a 6-digit code");
  assert.strictEqual(s.pinSels.length, 6, "and no wrapper selector reaches atsInjOrcFillPin");
});

test("⚠ a hidden input with the same prefix does not count either", () => {
  const s = runScan([...SIX_BOXES, { id: "pin-code-7", type: "hidden" }]);
  assert.strictEqual(s.pinInputs, 6);
});

test("⚠⚠ a CSS-CLIPPED box still counts — no visibility filter", () => {
  // The failure this guards against is the opposite one: orcApplyView keys "code" off pinInputs > 0,
  // so filtering on geometry could make the code screen unrecognisable entirely.
  const clipped = SIX_BOXES.map((b) => ({ ...b, w: 0, h: 0 }));
  const s = runScan(clipped);
  assert.strictEqual(s.pinInputs, 6, "a 0x0 box is still the real control (the Workday radio rule)");
});

test("the boxes come back in numeric order, so the code is typed left to right", () => {
  const shuffled = [3, 1, 6, 2, 5, 4].map((n) => ({ id: "pin-code-" + n, type: "number" }));
  const s = runScan(shuffled);
  assert.deepStrictEqual(s.pinSels, ["#pin-code-1", "#pin-code-2", "#pin-code-3", "#pin-code-4", "#pin-code-5", "#pin-code-6"]);
});

test("no pin boxes ⇒ pinInputs 0, so the view is not 'code'", () => {
  assert.strictEqual(runScan([]).pinInputs, 0);
  assert.strictEqual(ats.orcApplyView({ ok: true, pinInputs: 0 }), "none");
  assert.strictEqual(ats.orcApplyView({ ok: true, pinInputs: 6 }), "code");
});

test("⚠ the selector is pinned to `input[...]` in source", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8");
  assert.match(src, /querySelectorAll\('input\[id\^="pin-code-"\]'\)/,
    "a bare [id^=pin-code-] matches the wrapper and corrupts the code length");
});
