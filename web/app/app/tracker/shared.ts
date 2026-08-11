// Non-action constants/types for the tracker. Kept OUT of actions.ts because a
// "use server" module may only export async functions.

export const APP_STATUSES = [
  "queued",
  "needs_review",
  "submitted",
  "interviewing",
  "offer",
  "rejected",
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export type Application = {
  id: string;
  company: string | null;
  role: string | null;
  url: string | null;
  status: AppStatus;
  needs_review_count: number;
  applied_at: string | null;
  created_at: string;
  // WHEN every flagged field was approved (null = not approved). Mirrors the bundle's submit_ready
  // roll-up onto a cheap column, because the LIST never loads review_bundle_json.
  approved_at?: string | null;
  // The Workday account this application was filed with (migration 0011). Optional because the
  // tracker LIST doesn't select them — only the detail page, which is where you need them (Workday
  // accounts are per-tenant, so weeks later "what did I sign in as here?" is a real question).
  login_email?: string | null;
  login_tenant?: string | null;
  login_host?: string | null;
  login_created?: boolean | null;
  login_verified?: boolean | null;
  login_at?: string | null;
};
