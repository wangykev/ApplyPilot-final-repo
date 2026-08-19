#!/usr/bin/env node
/**
 * Verifies every Chrome Web Store justification field in
 * docs/store-submission/permission-fields.md fits the dashboard's 1000-character cap.
 *
 *   node scripts/check-justifications.mjs
 *
 * WHY THIS IS A SCRIPT AND NOT AN EYEBALL
 * ---------------------------------------
 * The dashboard silently truncates or refuses at 1000 characters per field, and the
 * `debugger` justification is the single most important text in the submission — losing its
 * last paragraph to a cap would drop exactly the scope-and-visibility argument that answers
 * the reviewer's objection. Prose gets edited; a counted limit should not be re-checked by
 * hand each time.
 *
 * Exits non-zero if any field is over, so it can gate a commit.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = path.join(ROOT, "docs/store-submission/permission-fields.md");
const LIMIT = 1000;

const md = fs.readFileSync(DOC, "utf8");

/**
 * Each field is a `##` heading followed by one fenced block. Pair them positionally: the
 * heading names the field, the next fence is what gets pasted into it.
 */
const sections = [];
const re = /^##\s+(.+)$/gm;
let m;
while ((m = re.exec(md))) sections.push({ title: m[1].trim(), at: m.index });

let failed = 0;
console.log(`\nJustification fields — cap ${LIMIT} chars\n`);

for (let i = 0; i < sections.length; i++) {
  const start = sections[i].at;
  const end = i + 1 < sections.length ? sections[i + 1].at : md.length;
  const body = md.slice(start, end);
  const fence = /```\n([\s\S]*?)```/.exec(body);
  if (!fence) {
    console.log(`  ?  ${sections[i].title} — no fenced block found`);
    continue;
  }
  // Trailing newline before the closing fence is not part of what you paste.
  const text = fence[1].replace(/\n$/, "");
  const raw = text.length;

  /**
   * THE BINDING NUMBER IS THE CRLF ONE, NOT raw.length.
   *
   * HTML normalises a textarea's submitted value to CRLF line endings, so a field that
   * measures 999 here can arrive as 999 + (number of line breaks) and be truncated or
   * refused — and the text most likely to sit near the cap is `debugger`, whose final
   * paragraph is the scope-and-visibility argument that answers the reviewer's actual
   * objection. Losing it silently to a line-ending detail is not a risk worth carrying for
   * a few characters, so the check is made against the worst case.
   */
  const breaks = (text.match(/\n/g) || []).length;
  const crlf = raw + breaks;

  const over = crlf > LIMIT;
  if (over) failed++;
  const bar = over ? "✖" : "✔";
  const pct = Math.round((crlf / LIMIT) * 100);
  console.log(
    `  ${bar}  ${String(crlf).padStart(4)} / ${LIMIT}  (${String(pct).padStart(3)}%)` +
      `  ${sections[i].title}   [raw ${raw} + ${breaks} breaks]`,
  );
}

if (failed) {
  console.error(`\n  ${failed} field(s) over the ${LIMIT}-character cap.\n`);
  process.exit(1);
}
console.log(`\n  All fields fit.\n`);
