/**
 * report-fields.ts — which `applications` columns an extension report actually WRITES.
 *
 * PURE, so the clobbering rule below is testable without a route or a database.
 *
 * THE RULE: a report never NULLS a column it wasn't given a value for.
 *
 * Why (live 2026-07-28): the tracker row lost its company and role after a Rehearse run, keeping only
 * the url. `reportApplication` (background.js) sends `role: null` on EVERY report — the extension simply
 * doesn't know the job title — and `company` falls back to null when the run has no jobContext. The route
 * then wrote those nulls straight into an UPDATE, wiping values the FILL run had recorded. The fill path
 * survived it only by accident: `saveRunJob` runs afterwards and rewrites company/role from the scraped
 * JD. A submit run has no such follow-up, so the damage stuck.
 *
 * The same rule already governs the login columns (an absent `login` must not blank the account on file),
 * so this generalizes it to every value-bearing column: absence means "I have nothing to say about this",
 * never "set it to nothing". The report's OWN payload — status, needs_review_count, review_bundle_json —
 * is always written; that is the point of a report.
 */

export type ReportBody = Record<string, unknown>;

export const APP_STATUSES = [
  "queued",
  "needs_review",
  "submitted",
  "interviewing",
  "offer",
  "rejected",
] as const;

/** A trimmed non-empty string, or null. */
export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The per-application login columns, from the extension's `login` payload (background.js
 * recordRunLogin). `{}` when there's no usable record — a run that signed in by hand, or an older
 * extension build, must not blank out a login this application already has. An email is the minimum.
 */
export function loginFields(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const l = raw as Record<string, unknown>;
  const email = str(l.email);
  if (!email) return {};
  return {
    login_email: email.slice(0, 320).toLowerCase(),
    login_tenant: str(l.tenant)?.slice(0, 200) ?? null,
    login_host: str(l.host)?.slice(0, 253) ?? null,
    login_created: l.created === true,
    login_verified: l.verified === true,
    login_at: str(l.at) ?? new Date().toISOString(),
  };
}

/**
 * The columns to write for a report. Only what the payload actually carries: `company`, `role`, `url`,
 * `job_key` and `applied_at` are OMITTED when absent rather than set to null, so an UPDATE can't erase
 * them. Safe for an INSERT too — an omitted column just takes its default.
 */
export function reportColumns(body: ReportBody, userId: string): Record<string, unknown> {
  const status = APP_STATUSES.includes(body.status as (typeof APP_STATUSES)[number])
    ? (body.status as string)
    : "needs_review";

  // Always written — this IS the report.
  const cols: Record<string, unknown> = {
    user_id: userId,
    status,
    needs_review_count: typeof body.needs_review_count === "number" ? body.needs_review_count : 0,
    review_bundle_json: body.review_bundle ?? null,
    // A REPORT REPLACES THE BUNDLE, so any earlier approval is void — those approvals were given for
    // answers that no longer exist. Leaving it set would show "Approved" over a freshly-filled,
    // never-reviewed application, which is the one place a wrong badge could cost a real submission.
    approved_at: null,
    ...loginFields(body.login),
  };

  // Written ONLY when present — absence must never clobber (see the file header).
  const company = str(body.company);
  const role = str(body.role);
  const url = str(body.url);
  const jobKey = str(body.job_key);
  const appliedAt = str(body.captured_at);
  // The scraped posting text (extension reportApplication, 2026-08-12). The clobbering rule matters
  // more here than anywhere else: a SUBMIT run reports from the per-user jobContext slot, which holds
  // no description, so writing an absent value would erase the JD on exactly the run that confirms an
  // application. Capped at the same 100k as saveRunJob, the website-side writer of this column.
  const jobDescription = str(body.job_description);
  if (company) cols.company = company;
  if (role) cols.role = role;
  if (url) cols.url = url;
  if (jobKey) cols.job_key = jobKey;
  if (appliedAt) cols.applied_at = appliedAt;
  if (jobDescription) cols.job_description = jobDescription.slice(0, 100000);
  return cols;
}
