"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { profileSchema, type Profile } from "@/lib/profile-schema";

export type SaveResult = { ok: true } | { ok: false; error: string };

/** Validate + upsert the signed-in user's profile_json. */
export async function saveProfile(raw: unknown): Promise<SaveResult> {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Profile didn't validate. Check the fields and try again." };
  }
  const profile: Profile = parsed.data;

  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars to save (see WEBSITE.md)." };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, profile_json: profile }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
