"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { resumeById, signedUrlFor } from "@/lib/resume-store";

/**
 * A short-lived signed URL for the résumé a given application was sent with.
 *
 * Ownership is checked TWICE and deliberately: the application must belong to the caller, and so must
 * the résumé row. The second check is not redundant — resume_id is a plain column, so a wrong or
 * tampered value must not become a read of someone else's private bucket object.
 */
export async function getApplicationResumeUrl(
  applicationId: string
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { data: app } = await supabase
      .from("applications")
      .select("resume_id")
      .eq("id", applicationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!app?.resume_id) return { ok: false, error: "No résumé recorded for this application." };

    const row = await resumeById(supabase, user.id, app.resume_id);
    if (!row) return { ok: false, error: "That résumé is no longer stored." };

    const url = await signedUrlFor(supabase, row, 600);
    if (!url) return { ok: false, error: "Could not open that résumé." };
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
