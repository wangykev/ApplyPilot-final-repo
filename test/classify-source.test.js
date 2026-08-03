"use strict";
// classify() decides which filler a field gets, and it lives INSIDE an injected function in cdp.js —
// stringified, so it cannot be required. Nothing tested it, and a wrong answer there is expensive:
// the field is handed to machinery built for a different widget and fails in a way that looks like a
// timing bug.
//
// Live 2026-08-03 (Aptiv): `source` was classified by NAME before any shape check, so an ordinary
// dropdown — button[aria-haspopup="listbox"] already reading "Aptiv Recruiter", no multiselect
// container, no search box — went to the typeahead filler, which waits for a searchBox that never
// mounts. Diagnosis was "could not focus the search field", present:false on all three attempts, and
// on the REPLAY it halted the whole run.
//
// This pulls the real classify out of cdp.js and runs it against fake wrappers, so the rule is pinned
// without needing a browser.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// ── extract `const classify = (wrapper) => { … };` from cdpPageScan ──
const src = fs.readFileSync(path.join(__dirname, "..", "cdp.js"), "utf8");
const start = src.indexOf("  const classify = (wrapper) => {");
assert.ok(start > 0, "classify(wrapper) not found in cdp.js — did it get renamed?");
// balance braces from the arrow body
let i = src.indexOf("{", src.indexOf("=>", start)), depth = 0, end = -1;
for (let k = i; k < src.length; k++) {
  if (src[k] === "{") depth++;
  else if (src[k] === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
}
assert.ok(end > 0, "could not balance classify's body");
const classify = eval("(" + src.slice(src.indexOf("(", start), end) + ")"); // eslint-disable-line no-eval

/** Minimal wrapper stand-in: classify only uses getAttribute / hasAttribute / querySelector(All). */
function fakeWrapper(fieldName, selectors) {
  const has = (sel) => selectors.some((s) => s === sel);
  const countOf = (sel) => selectors.filter((s) => s === sel).length;
  return {
    getAttribute: (a) => (a === "data-automation-id" ? "formField-" + fieldName : null),
    hasAttribute: (a) => has("@" + a),
    querySelector: (sel) => (has(sel) ? { getAttribute: () => null } : null),
    querySelectorAll: (sel) => new Array(countOf(sel)).fill({ getAttribute: () => null }),
  };
}

const LISTBOX = 'button[aria-haspopup="listbox"]';
const MULTI = '[data-uxi-widget-type="multiselect"]';
const MULTI_CONTAINER = '[data-automation-id="multiselectInputContainer"]';

test("source with a MULTISELECT shape is still hierarchical (Comcast / US Bank)", () => {
  assert.strictEqual(classify(fakeWrapper("source", [MULTI])), "hierarchical");
  assert.strictEqual(classify(fakeWrapper("source", [MULTI_CONTAINER])), "hierarchical");
  // the closed widget carries the hidden-search flag before anything is opened
  assert.strictEqual(classify(fakeWrapper("source", ["@data-automation-hiddensearch"])), "hierarchical");
});

test("source that is a PLAIN DROPDOWN is a dropdown, not hierarchical (Aptiv)", () => {
  // The exact live shape: a listbox button and nothing multiselect about it.
  assert.strictEqual(classify(fakeWrapper("source", [LISTBOX])), "dropdown",
    "a name must not outvote the widget's actual shape — this is what sent Aptiv to the typeahead filler");
});

test("the name shortcut only applies to source, and other widgets are unaffected", () => {
  assert.strictEqual(classify(fakeWrapper("someOtherField", [MULTI])), "typeahead");
  assert.strictEqual(classify(fakeWrapper("someOtherField", [LISTBOX])), "dropdown");
  assert.strictEqual(classify(fakeWrapper("x", ['input[type="radio"]'])), "radio");
  assert.strictEqual(classify(fakeWrapper("x", ['input[type="file"]'])), "file_upload");
  assert.strictEqual(classify(fakeWrapper("x", ['input[type="checkbox"]'])), "checkbox");
  assert.strictEqual(classify(fakeWrapper("x", ['input[type="checkbox"]', 'input[type="checkbox"]'])), "checkbox_group");
});

test("a multiselect source keeps precedence over its own listbox button", () => {
  // Both markers present (the picker renders a button too) — the multiselect shape must win, or the
  // tree tenants would regress into plain-dropdown handling.
  assert.strictEqual(classify(fakeWrapper("source", [MULTI, LISTBOX])), "hierarchical");
});
