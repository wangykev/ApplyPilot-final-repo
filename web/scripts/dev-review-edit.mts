/**
 * DEV ONLY — stage a review-page state for a rehearsal test: edit some values, approve the flagged
 * ones, and persist exactly what the review page's own save would.
 *
 * Why this exists rather than clicking the page: the review editors are REACT-CONTROLLED, and
 * `javascript_tool` runs in an ISOLATED world, so a native-setter write never reaches React's state —
 * the box shows the new value while the bundle keeps the old one (documented in the live-testing
 * skill, and confirmed here: a select read "USD $" on screen while the bundle held null). Driving the
 * UI needs real keystrokes in a foregrounded tab, which is slow and flaky to automate. The thing under
 * test is bundle -> rehearsal -> form, so this sets the bundle the same way the page would and leaves
 * the UI out of it.
 *
 * It imports the REAL `approvalEnvelope`, so the approval roll-up cannot drift from what the app
 * computes — the same reason the scrub script imports the real redactSecrets.
 *
 *   npx tsx scripts/dev-review-edit.mts            # show what it would do
 *   npx tsx scripts/dev-review-edit.mts --apply
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { approvalEnvelope } from "../lib/review-approval";
import type { ReviewBundle, ReviewEntry } from "../lib/review-summary";

const APPLY = process.argv.includes("--apply");

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// field_id suffix -> the value to put there. Chosen to be verifiable on the form and harmless:
// three previously-EMPTY salary parts (so a value appearing proves review-supplied data reaches the
// form) and one CHANGED value (Mobile -> Home, so an override is proven too). Deliberately nothing
// legally loaded — no EEO, no employment history, no consent.
const EDITS: Record<string, string> = {
  "CandProfileFields.Salary_Currency": "USD $",
  "CandProfileFields.Salary": "30",
  "CandProfileFields.Salary_Timeframe": "Hr.",
  "-1_PersonProfileFields.PhoneType": "Home",
};

const { data, error } = await admin
  .from("applications")
  .select("id, review_bundle_json")
  .eq("company", "Astrion")
  .order("updated_at", { ascending: false })
  .limit(1);
if (error) { console.error(error.message); process.exit(1); }
const row = (data || [])[0];
if (!row) { console.error("no Astrion application row"); process.exit(1); }

const bundle = row.review_bundle_json as ReviewBundle;
const entries: ReviewEntry[] = bundle.entries || [];
const now = new Date().toISOString();

let edited = 0;
let approved = 0;
for (const e of entries) {
  const suffix = String(e.field_id || "").split("::formField-").pop() || "";
  if (suffix in EDITS) {
    const to = EDITS[suffix];
    console.log(`EDIT   ${suffix}  ${JSON.stringify(e.current_value)} -> ${JSON.stringify(to)}`);
    e.current_value = to;
    e.is_edited = true;
    e.edited_at = now;
    edited++;
  }
}
// Approve AFTER editing, in that order on purpose: a value edit RESETS that field's approval, so
// approving first would be undone by the edit — the same trap a human hits on the page.
for (const e of entries) {
  if (e.needs_review && !e.is_approved) {
    e.is_approved = true;
    e.approved_at = now;
    approved++;
  }
}

const approval = approvalEnvelope(entries);
const needs = entries.filter((e) => !e.is_deleted && e.needs_review && !e.is_approved).length;
console.log(`\nedited ${edited} · approved ${approved}`);
console.log("approval envelope:", JSON.stringify(approval));
console.log("needs_review_count ->", needs);

if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); process.exit(0); }

const { error: upErr } = await admin
  .from("applications")
  .update({
    review_bundle_json: { ...bundle, entries, approval },
    needs_review_count: needs,
    approved_at: approval.submit_ready ? now : null,
  })
  .eq("id", row.id);
if (upErr) { console.error("write failed:", upErr.message); process.exit(1); }
console.log("\nwritten.");
