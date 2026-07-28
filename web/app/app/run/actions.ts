"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { canonicalJobUrl } from "@/lib/job-key";

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
