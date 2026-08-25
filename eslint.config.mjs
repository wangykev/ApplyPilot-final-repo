import fs from "node:fs";

// ── WHY THIS EXISTS (2026-08-20) ────────────────────────────────────────────────────────────
// Five separate LIVE failures were code written against a scope it did not have: `profile` in the
// ORC entry pass, `apMatch.cdpPageKey` (a lib.js helper reached through the wrong object),
// `preCreds` borrowed from a sibling `if (ats === …)` block, the entry pass again, and `startUrl`
// in runAtsSubmitRun's Oracle branch — that last one found by this config within a second of it
// first running, in code that had already passed 1693 unit tests and a live rehearsal.
//
// They all pass the unit suite because the guards in test/ scan source TEXT; they cannot evaluate
// a scope. Each one otherwise costs a live run to find.
//
// `no-undef` catches the whole class. It is the ONLY rule enabled: this is a bug net, not a style
// regime, and a config that also argued about formatting is one that gets switched off.
//
// ⚠ THE SERVICE WORKER IS ONE SCOPE. background.js pulls its dependencies in with importScripts,
// which evaluates them all into the SAME global — unlike Node's per-module scope. A name declared
// in lib.js is legitimately visible in fill-driver.js, so linting these files independently would
// report every cross-file call as undefined, i.e. pure noise.
//
// So the shared names are COLLECTED FROM THE FILES, and the file list is READ FROM THE
// importScripts CALL ITSELF rather than copied here. A hand-maintained copy of either would be one
// more lockstep dup to forget — precisely the class of mistake this file exists to catch. (First
// draft did hand-copy the list, omitted llm-keys.js, and produced six false positives.)
const bg = fs.readFileSync("background.js", "utf8");
const imports = /importScripts\(([^)]*)\)/.exec(bg);
const SW_FILES = imports
  ? [...imports[1].matchAll(/["']([^"']+\.js)["']/g)].map((m) => m[1]).concat("background.js")
  : ["background.js"];

const collect = (files) => {
  const out = {};
  for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    // Top-level declarations only — anything indented is inside a function, not a shared global.
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out[m[1]] = "writable";
    for (const m of src.matchAll(/^(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm)) out[m[1]] = "writable";
    for (const m of src.matchAll(/^class\s+([A-Za-z_$][\w$]*)/gm)) out[m[1]] = "writable";
  }
  return out;
};

// The runtime these actually run in. Explicit rather than pulling in the `globals` package: a short
// stable list, one less dependency to keep current.
const RUNTIME = [
  "chrome", "importScripts", "self", "globalThis", "console",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "fetch", "Request", "Response", "Headers", "AbortController", "AbortSignal",
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "Blob", "File", "FileReader", "FormData",
  "atob", "btoa", "crypto", "structuredClone", "performance",
  "indexedDB", "IDBKeyRange", "caches", "location", "navigator",
  "Worker", "MessageChannel", "BroadcastChannel", "EventTarget", "CustomEvent", "Event",
  // ⚠ present inside the INJECTED functions — they live in these files as source but are evaluated
  // in the PAGE, so the page's globals are legitimately in scope for them.
  "document", "window", "CSS", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
  "MouseEvent", "PointerEvent", "KeyboardEvent", "InputEvent", "Element", "Node", "NodeFilter",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DataTransfer",
  "MutationObserver", "alert", "innerWidth", "innerHeight", "devicePixelRatio", "scrollX", "scrollY",
  // Node, for the files the tests also require()
  "module", "require", "exports", "process", "__dirname", "__filename", "Buffer",
];

const swGlobals = { ...collect(SW_FILES) };
for (const g of RUNTIME) swGlobals[g] = "writable";

// The extension's PAGE scripts are a DIFFERENT scope — they get the DOM and whatever their own
// <script> tags load alongside them, NOT the service worker's globals. And, exactly as above, the
// set is read from the HTML rather than listed here: popup.html pulls db.js + llm-keys.js + llm.js
// before popup.js, summary.html pulls db.js + summary-lib.js, and hand-copying that produced four
// more false positives on the first run.
const PAGES = ["popup.html", "summary.html"];
const pageGroups = [];
for (const page of PAGES) {
  let html;
  try { html = fs.readFileSync(page, "utf8"); } catch { continue; }
  const scripts = [...html.matchAll(/src=["']([^"']+\.js)["']/g)].map((m) => m[1]);
  if (!scripts.length) continue;
  const g = { ...collect(scripts) };
  for (const r of RUNTIME) g[r] = "writable";
  pageGroups.push({ files: scripts, globals: g });
}

const base = {
  languageOptions: { ecmaVersion: 2023, sourceType: "script" },
  linterOptions: { reportUnusedDisableDirectives: true },
  rules: { "no-undef": "error" },   // the whole point; everything else is deliberately off
};

export default [
  { ignores: ["node_modules/**", "web/**", ".claude/**", "test/**", "eslint.config.mjs"] },
  { ...base, files: SW_FILES, languageOptions: { ...base.languageOptions, globals: swGlobals } },
  ...pageGroups.map((p) => ({ ...base, files: p.files, languageOptions: { ...base.languageOptions, globals: p.globals } })),
];
