"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { profileSchema, coerceProfile, mergeProfile, emptyProfile } from "@/lib/profile-schema";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Merge an AI-parsed profile into the user's profile (fills blanks only). */
export async function applyParsedProfile(parsedRaw: unknown): Promise<ActionResult> {
  const parsed = profileSchema.safeParse(parsedRaw);
  if (!parsed.success) return { ok: false, error: "Parsed profile didn't validate." };

  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars to save (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { data: row } = await supabase
      .from("profiles")
      .select("profile_json")
      .eq("id", user.id)
      .maybeSingle();
    const current = row?.profile_json ? coerceProfile(row.profile_json) : emptyProfile();
    const merged = mergeProfile(current, parsed.data);

    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, profile_json: merged }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** Remove the stored default resume (Storage object + row). */
export async function removeResume(): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    await supabase.storage.from("resumes").remove([`${user.id}/default-resume.pdf`]);
    await supabase.from("resumes").delete().eq("user_id", user.id).eq("kind", "default");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
