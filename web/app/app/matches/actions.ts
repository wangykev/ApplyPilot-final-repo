"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile, emptyProfile, type Profile } from "@/lib/profile-schema";
import { fetchRecentPostings, type SimplifyPosting } from "@/lib/simplify";
import { fetchJobDescription, atsOf, type Ats } from "@/lib/job-description";
import { buildProfileSignal, scoreMatch } from "@/lib/matching";
import { addQueueItems } from "@/app/app/queue/actions";
import type { MatchRow, MatchRunResult } from "./shared";

const RECENT_LIMIT = 40;
/** Beyond the top N recent, only Workday/Greenhouse (reliably readable) get a JD fetch. */
const GENERIC_JD_TOP = 12;
const JD_CONCURRENCY = 6;

const ATS_LABEL: Record<Ats, string> = {
  workday: "Workday",
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  rippling: "Rippling",
  lever: "Lever",
  icims: "iCIMS",
  other: "Company site",
};

async function loadProfile(): Promise<Profile> {
  if (!isSupabaseConfigured()) return emptyProfile();
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return emptyProfile();
    const { data } = await supabase
      .from("profiles")
      .select("profile_json")
      .eq("id", user.id)
      .maybeSingle();
    return data?.profile_json ? coerceProfile(data.profile_json) : emptyProfile();
  } catch {
    return emptyProfile();
  }
}

/** Run each item through fn, at most `limit` in flight. Preserves input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Should we attempt a server-side JD fetch for this posting at this position? */
function shouldFetchJd(ats: Ats, position: number): boolean {
  if (ats === "workday" || ats === "greenhouse") return true; // reliably readable
  if (ats === "ashby" || ats === "rippling") return false; // known SPA — extension reads these
  return position < GENERIC_JD_TOP; // lever/icims/company site: only the freshest few
}

export async function runMatchRun(): Promise<MatchRunResult> {
  const scoredAt = new Date().toISOString();
  const profile = await loadProfile();
  const sig = buildProfileSignal(profile);
  const profileSummary = {
    skills: sig.skills.length,
    field: sig.fieldsOfStudy[0] ?? "—",
    gradYear: sig.gradYear,
  };

  let postings: SimplifyPosting[];
  try {
    postings = await fetchRecentPostings(RECENT_LIMIT);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't fetch the Simplify listing.",
      rows: [],
      scoredAt,
      profileSummary,
      jdReadCount: 0,
      total: 0,
    };
  }

  const rows = await mapLimit(postings, JD_CONCURRENCY, async (p, i): Promise<MatchRow> => {
    const ats = atsOf(p.url);
    let jd: string | null = null;
    let needsBrowser = ats === "ashby" || ats === "rippling";

    if (shouldFetchJd(ats, i)) {
      const r = await fetchJobDescription(p.url);
      if (r.ok) jd = r.text;
      else needsBrowser = r.needsBrowser;
    }

    const match = scoreMatch(
      { title: p.role, company: p.company, location: p.location, jd, autoApply: ats === "workday" },
      sig,
    );

    return {
      company: p.company,
      role: p.role,
      location: p.location,
      url: p.url,
      ageDays: p.ageDays,
      ageLabel: p.ageLabel,
      autoApply: ats === "workday",
      atsLabel: ATS_LABEL[ats],
      score: match.score,
      tier: match.tier,
      eligibility: match.eligibility,
      reasons: match.reasons,
      matchedSkills: match.matchedSkills,
      jdRead: match.jdRead,
      jdExcerpt: jd ? jd.slice(0, 1200) : null,
      needsBrowser: match.jdRead ? false : needsBrowser,
    };
  });

  // Ineligible sinks to the bottom; otherwise by score desc, then freshness.
  const eligRank = (e: MatchRow["eligibility"]) => (e === "no" ? 0 : 1);
  rows.sort(
    (a, b) =>
      eligRank(b.eligibility) - eligRank(a.eligibility) ||
      b.score - a.score ||
      a.ageDays - b.ageDays,
  );

  return {
    ok: true,
    rows,
    scoredAt,
    profileSummary,
    jdReadCount: rows.filter((r) => r.jdRead).length,
    total: rows.length,
  };
}

/** Add a single posting URL to the apply queue (reuses the queue's insert + validation). */
export async function addMatchToQueue(url: string): Promise<{ ok: boolean; error?: string }> {
  const r = await addQueueItems(url);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
