"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";

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

export async function saveRunJob(input: {
  url: string;
  company?: string;
  role?: string;
  jobDescription?: string;
}): Promise<SaveRunJobResult> {
  const url = (input.url || "").trim();
  if (!url) return { ok: false, error: "No posting URL." };
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const patch: Record<string, unknown> = {};
    if (input.company && input.company.trim()) patch.company = input.company.trim().slice(0, 200);
    if (input.role && input.role.trim()) patch.role = input.role.trim().slice(0, 200);
    if (input.jobDescription && input.jobDescription.trim()) {
      patch.job_description = input.jobDescription.slice(0, 100000);
    }

    const { data: existing } = await supabase
      .from("applications")
      .select("id")
      .eq("user_id", user.id)
      .eq("url", url)
      .maybeSingle();

    if (existing) {
      // deleted_at: null — restarting a posting un-hides a previously soft-deleted row.
      const { error } = await supabase
        .from("applications")
        .update({ ...patch, deleted_at: null })
        .eq("id", existing.id);
      if (error) return { ok: false, error: error.message };
      return { ok: true, id: existing.id };
    }

    const { data: ins, error } = await supabase
      .from("applications")
      .insert({ user_id: user.id, url, status: "filling", ...patch })
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: ins?.id ?? "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
