// web/scripts/dev.mjs — start `next dev` with a heap ceiling the RENDER WORKERS actually get.
//
// ⚠⚠ WHY THIS EXISTS, AND WHY THE OBVIOUS FIX DID NOT WORK (2026-09-15).
// The tracker had been failing in dev with:
//
//     Runtime Error
//     Jest worker encountered 2 child process exceptions, exceeding retry limit
//
// The documented remedy was `node --max-old-space-size=4096 .../next dev` in the dev script, and it
// was in package.json on BOTH this branch and main — yet the error kept happening. The reason is that
// `--max-old-space-size` is a V8 COMMAND-LINE flag, so it applies ONLY to the process it is handed to.
// Next renders RSC in CHILD processes (jest-worker — which is what the error message is naming), and a
// child does NOT inherit a parent's command-line V8 flags. So the flag raised the ceiling of the one
// process that was not running out of memory, and left the workers on their default heap.
//
// `NODE_OPTIONS` is an ENVIRONMENT VARIABLE, and a child process inherits the environment. Setting it
// here is therefore the whole fix: every worker Next spawns starts with the larger ceiling.
//
// ⚠ It has to be a launcher rather than an inline `NODE_OPTIONS=… next dev` in the npm script, because
// npm scripts run through `cmd.exe` on Windows, where the `VAR=value cmd` prefix form is a syntax
// error, not an assignment. A launcher is portable without adding a `cross-env` dependency.
//
// Why the TRACKER is what exposed it: it is the heaviest render in the app — the list materialises
// every application row, and a detail page renders a whole `review_bundle_json` (up to ~72 fields,
// each carrying its captured option list). Observed live: the list rendered, while every detail page
// came back as a ~7KB empty shell, which is what a crashed-and-retried render worker looks like.
//
// This is DEV-ONLY. `next build` / `next start` do not use these render workers.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Resolve Next's own CLI entry the way Node would, so this keeps working across Next versions and
// does not hardcode a path into node_modules.
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next");
} catch (err) {
  console.error("[dev] could not resolve next/dist/bin/next — run `npm install` in web/ first.");
  process.exit(1);
}

// APPEND rather than replace: an operator may already have NODE_OPTIONS set for their own reasons
// (a debugger, a CA bundle), and clobbering it would silently drop that.
const HEAP = "--max-old-space-size=4096";
const existing = (process.env.NODE_OPTIONS || "").trim();
const nodeOptions = existing.includes("--max-old-space-size")
  ? existing // the operator pinned their own ceiling — theirs wins, never fight it
  : `${existing} ${HEAP}`.trim();

// Pass through whatever the caller added (`npm run dev -- -p 3001`), so this is a transparent wrapper.
const args = [nextBin, "dev", ...process.argv.slice(2)];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

child.on("exit", (code, signal) => {
  // Mirror the child's fate so Ctrl-C and a crash both behave like running `next dev` directly.
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error("[dev] failed to start next dev:", err.message);
  process.exit(1);
});
