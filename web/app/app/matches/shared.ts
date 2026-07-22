// Non-action types for the match run. Kept out of actions.ts because a
// "use server" module may only export async functions. Type-only imports from
// server libs are erased at compile, so this stays safe to import from the client.

import type { Eligibility, Tier } from "@/lib/matching";

export type MatchRow = {
  company: string;
  role: string;
  location: string;
  url: string;
  ageDays: number;
  ageLabel: string;
  autoApply: boolean; // Workday → the extension can drive it
  atsLabel: string; // "Workday" | "Greenhouse" | "Ashby" | …
  score: number;
  tier: Tier;
  eligibility: Eligibility;
  reasons: string[];
  matchedSkills: string[];
  jdRead: boolean;
  jdExcerpt: string | null; // first ~1200 chars of the fetched JD, for display
  needsBrowser: boolean; // JD couldn't be read server-side → read via the extension
};

export type MatchRunResult = {
  ok: boolean;
  error?: string;
  rows: MatchRow[];
  scoredAt: string;
  profileSummary: { skills: number; field: string; gradYear: number | null } | null;
  jdReadCount: number;
  total: number;
};
