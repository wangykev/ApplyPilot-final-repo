/**
 * ONE-OFF REMEDIATION — strip session tokens out of already-stored job descriptions.
 *
 * Why this exists: `scrapeJobPosting` used to fall back to `textContent`, which includes <script>
 * source, so on a server-rendered portal the "largest text block" it stored as the job description
 * could be the page's bootstrap JavaScript. On iCIMS that script embeds the one-time magic-link
 * session URL (`?from=login&eem=…&code=…`), so a live credential ended up in
 * `applications.job_description` — at rest, indefinitely. The scrape and a redaction belt are fixed
 * in code; this cleans up what was written before the fix.
 *
 * It is deliberately DUMB AND SAFE:
 *   • it reuses the SAME pure `redactSecrets` the extension now applies, so "clean" means the same
 *     thing in both places and re-running can never diverge;
 *   • it only ever REMOVES a secret's value — no other column, and no other part of the text, is
 *     touched, so there is nothing of value to lose;
 *   • it is idempotent (redacting redacted text is a no-op), so it is safe to run repeatedly;
 *   • DRY RUN BY DEFAULT. It prints what it would change and writes nothing unless you pass --apply.
 *   • it never prints a token. Findings are reported as counts and key names only — printing the
 *     leak to a terminal (and into a transcript) would just move it somewhere else.
 *
 * Usage, from the `web/` directory:
 *   node scripts/scrub-job-description-secrets.mjs            # dry run
 *   node scripts/scrub-job-description-secrets.mjs --apply    # write
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
// The extension's own helper — imported, not reimplemented, so the two can never drift.
const { redactSecrets, SECRET_QUERY_KEYS } = require("../../lib.js");

const APPLY = process.argv.includes("--apply");

// web/.env.local holds the service-role key. Read it directly rather than depending on a runner.
const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in web/.env.local");
  process.exit(1);
}
const admin = createClient(url, key, { auth: { persistSession: false } });

// Which secret KEYS appear in a string — names only, never values.
const keysFound = (s) => {
  const out = new Set();
  for (const m of String(s).matchAll(/[?&;#]([A-Za-z0-9_-]{2,24})=([^\s&;#"'<>)\]]{6,})/g)) {
    if (SECRET_QUERY_KEYS.test(m[1])) out.add(m[1].toLowerCase());
  }
  return [...out];
};

const { data, error } = await admin
  .from("applications")
  .select("id, company, job_description")
  .not("job_description", "is", null);
if (error) { console.error("query failed:", error.message); process.exit(1); }

let affected = 0;
for (const row of data || []) {
  const before = row.job_description || "";
  const after = redactSecrets(before);
  if (after === before) continue;
  affected++;
  console.log(
    `${APPLY ? "SCRUBBING" : "WOULD SCRUB"} ${row.id}  (${row.company || "?"})  ` +
    `${before.length} chars · secret keys present: ${keysFound(before).join(", ")}`
  );
  if (!APPLY) continue;
  const { error: upErr } = await admin
    .from("applications")
    .update({ job_description: after })
    .eq("id", row.id);
  if (upErr) { console.error(`  ⛔ update failed for ${row.id}: ${upErr.message}`); process.exit(1); }
}

console.log(
  `\nscanned ${(data || []).length} row(s) with a job description; ${affected} contained a secret.` +
  (affected && !APPLY ? "  Re-run with --apply to write." : affected ? "  All scrubbed." : "  Nothing to do.")
);
