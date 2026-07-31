"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { canonicalJobUrl } from "@/lib/job-key";
import { discoveryJobKey, toQueueRow, type DiscoveredJob } from "@/lib/discover";

/**
 * Persist the job the Run flow just started. The extension scrapes the posting
 * (company / title / description text) and returns it in the AP_RUN_APPLICATION
 * response; the Run page hands it here so it lands on the tracker row for this
 * posting URL. Upserts by (user_id, url) — the same key the extension's report
 * path uses — so this and the walk's own status report converge on one row
 * regardless of which arrives first (this never clobbers the review bundle, and
 * the report path never clobbers the job description).
 */
export type SaveRunJobResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * The Workday account a run signed in as, as REPORTED BY THE EXTENSION (its
 * AP_RUN_APPLICATION / AP_SUBMIT_APPLICATION response carries `login`). We take the
 * extension's word rather than reading our own `credentials_json`, because the extension
 * is the thing that actually signed in — if the two ever diverge (an edit that never
 * synced), the account on the tracker row must be the one that was really used.
 */
export type RunLogin = {
  email?: string | null;
  tenant?: string | null;
  host?: string | null;
  created?: boolean;
  verified?: boolean;
  at?: string | null;
};

/** The login columns for an update, or {} when there's nothing truthful to record (see 0011). */
function loginPatch(login: RunLogin | null | undefined): Record<string, unknown> {
  const email = login?.email?.trim();
  if (!email) return {}; // hand-signed-in run / older extension → never blank out what's on file
  return {
    login_email: email.toLowerCase().slice(0, 320),
    login_tenant: login?.tenant?.trim()?.slice(0, 200) || null,
    login_host: login?.host?.trim()?.slice(0, 253) || null,
    login_created: login?.created === true,
    login_verified: login?.verified === true,
    login_at: login?.at || new Date().toISOString(),
  };
}

export async function saveRunJob(input: {
  url: string;
  company?: string;
  role?: string;
  jobDescription?: string;
  login?: RunLogin | null;
}): Promise<SaveRunJobResult> {
  const url = (input.url || "").trim();
  if (!url) return { ok: false, error: "No posting URL." };
  // Stable per-job key (tenant + requisition id) — the extension's reportApplication computes the
  // SAME key from the form url, so both writers converge on ONE row across runs even though the raw
  // form url changes every run. LOCKSTEP: web/lib/job-key.ts ↔ lib.js canonicalJobUrl.
  const jobKey = canonicalJobUrl(url);
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    // deleted_at: null un-hides a soft-deleted row; url refreshed to the pasted POSTING link
    // (durable + clickable, unlike the ephemeral form url the report path stores) — saveRunJob runs
    // after reportApplication, so this write wins.
    const patch: Record<string, unknown> = { job_key: jobKey, url, deleted_at: null, ...loginPatch(input.login) };
    if (input.company && input.company.trim()) patch.company = input.company.trim().slice(0, 200);
    if (input.role && input.role.trim()) patch.role = input.role.trim().slice(0, 200);
    if (input.jobDescription && input.jobDescription.trim()) {
      patch.job_description = input.jobDescription.slice(0, 100000);
    }

    // Dedupe by job_key (the raw url varies per run); bridge to a legacy url-keyed row if present.
    let existing: { id: string } | null = null;
    {
      const { data } = await supabase
        .from("applications")
        .select("id")
        .eq("user_id", user.id)
        .eq("job_key", jobKey)
        .maybeSingle();
      existing = data ?? null;
    }
    if (!existing) {
      const { data } = await supabase
        .from("applications")
        .select("id")
        .eq("user_id", user.id)
        .eq("url", url)
        .maybeSingle();
      existing = data ?? null;
    }

    if (existing) {
      const { error } = await supabase.from("applications").update(patch).eq("id", existing.id);
      if (error) return { ok: false, error: error.message };
      return { ok: true, id: existing.id };
    }

    const { data: ins, error } = await supabase
      .from("applications")
      .insert({ user_id: user.id, status: "filling", ...patch })
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: ins?.id ?? "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * Record the outcome of a SUBMIT run (the Run page's Submit button → AP_SUBMIT_APPLICATION).
 *
 * This is the ONE place an application becomes `submitted`. The extension deliberately never reports
 * that status — its report path only ever fills to review ("the human submits") — and here the human
 * did authorize it, on this page, so the site is the honest writer of it.
 *
 * `submitted:false` (a dry rehearsal, or a run the gate stopped) writes NOTHING about status: a
 * rehearsal must never make an unsubmitted application look submitted. It still records the login,
 * since signing in happened either way.
 */
export type SubmitRunResult = { ok: true; id: string | null } | { ok: false; error: string };

export async function saveRunSubmit(input: {
  url: string;
  submitted: boolean;
  login?: RunLogin | null;
}): Promise<SubmitRunResult> {
  const url = (input.url || "").trim();
  if (!url) return { ok: false, error: "No posting URL." };
  const jobKey = canonicalJobUrl(url);
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const patch: Record<string, unknown> = { ...loginPatch(input.login) };
    if (input.submitted) {
      patch.status = "submitted";
      patch.applied_at = new Date().toISOString();
    }
    if (Object.keys(patch).length === 0) return { ok: true, id: null }; // nothing to record

    // A submit run always follows a fill, so the row exists — match it the same way every other
    // writer does (job_key, then the raw url). No insert: a submit with no filled application to
    // replay is impossible (the extension refuses without an approved bundle).
    let existing: { id: string } | null = null;
    {
      const { data } = await supabase
        .from("applications")
        .select("id")
        .eq("user_id", user.id)
        .eq("job_key", jobKey)
        .maybeSingle();
      existing = data ?? null;
    }
    if (!existing) {
      const { data } = await supabase
        .from("applications")
        .select("id")
        .eq("user_id", user.id)
        .eq("url", url)
        .maybeSingle();
      existing = data ?? null;
    }
    if (!existing) return { ok: true, id: null };

    const { error } = await supabase.from("applications").update(patch).eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: existing.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/* ────────────────────────── Job discovery (the Discover button) ─────────────────────────── */

/**
 * Everything the extension needs to skip jobs the operator has already dealt with.
 *
 * "Recently posted jobs that I have NOT yet applied to" is the whole point of a
 * sweep, and the cheapest place to enforce it is BEFORE the extension spends a tab
 * open scraping that job's description — so the keys go out with the request. The
 * insert path (`saveDiscovered`) re-checks authoritatively; this is the fast filter.
 *
 * For every known row we contribute BOTH the stored `job_key` and a freshly-derived
 * `discoveryJobKey(url)`. They're identical for Workday and generic URLs, but a
 * LEGACY row saved before board keys existed holds the generic origin+path form for
 * (say) a LinkedIn link, while a sweep now produces `linkedin:<id>`. Emitting both
 * makes the filter robust across that change instead of silently re-surfacing jobs.
 */
export type DiscoveryContext = { ok: true; knownKeys: string[] } | { ok: false; error: string };

export async function getDiscoveryContext(): Promise<DiscoveryContext> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const keys = new Set<string>();
    const add = (rows: Array<{ job_key?: string | null; url?: string | null }> | null) => {
      for (const r of rows ?? []) {
        if (r.job_key) keys.add(r.job_key);
        if (r.url) {
          const derived = discoveryJobKey(r.url);
          if (derived) keys.add(derived);
        }
      }
    };

    // Applications: every one, INCLUDING soft-deleted. Deleting a tracker row means
    // "stop showing me this", so re-discovering it would fight the operator.
    const { data: apps } = await supabase
      .from("applications")
      .select("job_key, url")
      .eq("user_id", user.id);
    add(apps);

    // Already-queued jobs (any status — a done/error row still shouldn't come back).
    const { data: queued } = await supabase
      .from("queue_items")
      .select("job_key, url")
      .eq("user_id", user.id);
    add(queued);

    return { ok: true, knownKeys: Array.from(keys) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * Persist a sweep's results into `queue_items` — the queue IS the storage the
 * discovery flow writes to, so a discovered job lands in the same list the operator
 * already works through (and the same list `GET /api/extension/queue` serves).
 *
 * Authoritative dedup lives here, not in the extension: keys are RECOMPUTED from
 * each url server-side (never trusted from the client), the batch is deduped
 * against itself, and then against what's already in `queue_items` and
 * `applications`. A row that slips through the race between the read and the insert
 * is caught by the partial unique index on (user_id, job_key) — reported as skipped,
 * not as a failure.
 */
export type SaveDiscoveredResult =
  | { ok: true; added: number; skipped: number }
  | { ok: false; error: string };

export async function saveDiscovered(jobs: DiscoveredJob[]): Promise<SaveDiscoveredResult> {
  const incoming = Array.isArray(jobs) ? jobs : [];
  if (incoming.length === 0) return { ok: true, added: 0, skipped: 0 };
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    // 1. Shape + self-dedupe (first occurrence wins — the extension merges sources
    //    in a stable order, so which one wins is deterministic).
    const byKey = new Map<string, ReturnType<typeof toQueueRow>>();
    for (const job of incoming) {
      const row = toQueueRow(job);
      if (!row) continue;
      if (!byKey.has(row.job_key)) byKey.set(row.job_key, row);
    }
    if (byKey.size === 0) return { ok: true, added: 0, skipped: incoming.length };

    // 2. Drop anything already queued or already applied to.
    const known = new Set<string>();
    const [{ data: queued }, { data: apps }] = await Promise.all([
      supabase.from("queue_items").select("job_key, url").eq("user_id", user.id),
      supabase.from("applications").select("job_key, url").eq("user_id", user.id),
    ]);
    for (const r of [...(queued ?? []), ...(apps ?? [])]) {
      if (r.job_key) known.add(r.job_key);
      if (r.url) {
        const derived = discoveryJobKey(r.url);
        if (derived) known.add(derived);
      }
    }
    const fresh = Array.from(byKey.values()).filter((r) => r && !known.has(r.job_key));
    const skipped = incoming.length - fresh.length;
    if (fresh.length === 0) return { ok: true, added: 0, skipped };

    // 3. Append to the end of the queue, preserving the sweep's newest-first order.
    const { data: last } = await supabase
      .from("queue_items")
      .select("position")
      .eq("user_id", user.id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    let pos = (last?.position ?? 0) + 1;

    const rows = fresh.map((r) => ({ user_id: user.id, status: "pending", position: pos++, ...r }));
    const { data: inserted, error } = await supabase.from("queue_items").insert(rows).select("id");
    if (error) {
      // A concurrent sweep won the race on the unique index — not a failure, the job
      // is queued either way. Anything else is a real error worth surfacing.
      if (/duplicate key|unique constraint/i.test(error.message)) {
        return { ok: true, added: 0, skipped: incoming.length };
      }
      return { ok: false, error: error.message };
    }

    revalidatePath("/app/queue");
    return { ok: true, added: inserted?.length ?? rows.length, skipped };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
