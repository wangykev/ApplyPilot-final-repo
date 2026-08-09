// Structural invariant for the SERVICE-WORKER GLOBAL SCOPE.
//
// background.js loads its dependencies with `importScripts(...)`, which evaluates every file into ONE
// shared global scope — unlike Node, where each `require` gets its own module scope. So two files
// declaring the same top-level name is a hard `SyntaxError`:
//
//     Uncaught SyntaxError: Failed to execute 'importScripts' on 'WorkerGlobalScope':
//     Identifier 'dateOrderOf' has already been declared.
//
// …and the service worker then fails to register at all ("Service worker registration failed. Status
// code: 15") — the extension is completely dead, with no fill, no walk, no popup handlers.
//
// This happened live on 2026-07-28: `dateOrderOf` was moved into lib.js and a one-line alias
// (`const dateOrderOf = (segs) => apMatch.dateOrderOf(segs)`) was left behind in fill-driver.js so its
// call sites wouldn't need touching. Every `node --test` suite stayed green, because in Node the two
// files never share a scope. Only loading the unpacked extension revealed it.
//
// Hence this test. The rule it enforces: fill-driver.js reaches lib.js helpers through `apMatch.*`,
// never by re-declaring them. Deliberate lockstep DUPLICATES (the stringified `fillEngine` copies of
// normalize/matchCandidates, etc.) live INSIDE functions and are indented, so they don't participate in
// the global scope and aren't flagged here.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// The file list comes from background.js's own importScripts call, so this test can't drift as the
// list changes. background.js itself is included — it shares the same scope.
function swFiles() {
  const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const m = /importScripts\(([^)]*)\)/.exec(bg);
  assert.ok(m, "could not find background.js's importScripts call");
  const files = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  assert.ok(files.length >= 3, `expected several importScripts files, got ${JSON.stringify(files)}`);
  return [...files, "background.js"];
}

// A TOP-LEVEL declaration only — anchored at column 0, so anything inside a function (indented) is
// ignored. That's what makes the check match the actual global-scope rule.
const DECL = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

test("SW GLOBAL SCOPE: no top-level name is declared in two importScripts files", () => {
  const owners = new Map(); // name → [files]
  for (const f of swFiles()) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const line of src.split(/\r?\n/)) {
      const m = DECL.exec(line);
      if (!m) continue;
      const name = m[1] || m[2];
      if (!owners.has(name)) owners.set(name, []);
      const list = owners.get(name);
      if (!list.includes(f)) list.push(f);
    }
  }
  const clashes = [...owners].filter(([, files]) => files.length > 1);
  assert.deepStrictEqual(
    clashes.map(([n, files]) => `${n} (${files.join(" + ")})`),
    [],
    "these names are declared at top level in more than one importScripts file. Under importScripts they " +
      "share ONE global scope, so this is a SyntaxError that stops the service worker from registering at " +
      "all. Reach the other file's helper through its namespace (fill-driver.js uses apMatch.*) instead of " +
      "re-declaring it."
  );
});

test("SW GLOBAL SCOPE: every importScripts file exists and parses", () => {
  for (const f of swFiles()) {
    const p = path.join(ROOT, f);
    assert.ok(fs.existsSync(p), `${f} is importScripts'd but missing`);
    // new Function throws on a syntax error without executing the body — cheap parse check for a file
    // that can't simply be require()d (cdp.js/background.js expect chrome.* at load time).
    assert.doesNotThrow(() => new Function(fs.readFileSync(p, "utf8")), `${f} does not parse`);
  }
});


// ── apMatch must expose everything fill-driver.js asks of it ─────────────────────────────────────────
// fill-driver.js reaches lib.js through `apMatch`, which is TWO different objects:
//     Node  → require("./lib.js")           (everything lib.js exports)
//     SW    → a hand-written object literal (only the names someone remembered to list)
// So `apMatch.foo(...)` can work in every test and throw "apMatch.foo is not a function" in the browser.
// That happened live on 2026-07-28: routing the dateOrderOf call sites through apMatch fixed the
// global-scope collision, Node passed (it takes the require branch), and the replay walk died mid-run
// with `apMatch.dateOrderOf is not a function`. This pins the SW literal against actual usage.
//
// SCOPE (widened 2026-08-09): background.js reaches lib.js through the SAME `apMatch` object and was
// NOT scanned, so it had exactly the hole this test exists to close. A signature-date fix called
// `apMatch.parseErrorFieldName` from background.js; the suite passed 1185/1185 and the live replay
// aborted with `apMatch.parseErrorFieldName is not a function`. Both callers are checked now.
test("apMatch: every apMatch.X used in fill-driver.js AND background.js is present in the SW object literal", () => {
  const src = fs.readFileSync(path.join(ROOT, "fill-driver.js"), "utf8");
  const callers = ["fill-driver.js", "background.js"];
  const used = new Map(); // name → the file that calls it (for a message that names the culprit)
  for (const f of callers) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of text.matchAll(/\bapMatch\.([A-Za-z_$][\w$]*)/g)) if (!used.has(m[1])) used.set(m[1], f);
  }
  assert.ok(used.size > 3, `expected several apMatch.* uses, found ${used.size}`);

  // The literal is the ELSE branch of the ternary — from "? require(...)" to the closing "};".
  const decl = /const apMatch = [\s\S]*?\n\s*: (\{[\s\S]*?\});/.exec(src);
  assert.ok(decl, "could not locate the apMatch SW object literal");
  const listed = new Set([...decl[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]));

  const missing = [...used.keys()].filter((n) => !listed.has(n)).sort().map((n) => `${n} (called in ${used.get(n)})`);
  assert.deepStrictEqual(missing, [], "these names are called as apMatch.X but are NOT in the SW object literal, so they are undefined in the extension even though Node tests pass. Add them to the literal (they must also be globals from lib.js).");
});

test("apMatch: everything the SW literal lists is actually exported by lib.js", () => {
  const src = fs.readFileSync(path.join(ROOT, "fill-driver.js"), "utf8");
  const decl = /const apMatch = [\s\S]*?\n\s*: (\{[\s\S]*?\});/.exec(src);
  assert.ok(decl, "could not locate the apMatch SW object literal");
  const listed = [...decl[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
  const lib = require("../lib.js");
  const notExported = listed.filter((n) => typeof lib[n] !== "function").sort();
  assert.deepStrictEqual(notExported, [], "the SW literal maps these to lib.js globals, but lib.js does not export them — so the Node branch of apMatch would be missing what the SW branch has (the two branches must agree)");
});
