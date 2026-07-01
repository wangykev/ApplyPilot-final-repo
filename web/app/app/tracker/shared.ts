// Non-action constants/types for the tracker. Kept OUT of actions.ts because a
// "use server" module may only export async functions.

export const APP_STATUSES = [
  "queued",
  "filling",
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
};
