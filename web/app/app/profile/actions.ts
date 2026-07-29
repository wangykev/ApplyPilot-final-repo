"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { profileSchema, coerceProfile, type Profile } from "@/lib/profile-schema";
import { bucketsSchema, coerceBuckets, ensureStarterBuckets, STARTER_BUCKETS, type Bucket } from "@/lib/buckets";
import { ensureDefaultFieldWordings } from "@/lib/teach";

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

/** Validate + upsert the signed-in user's answer buckets (buckets_json). */
export async function saveBuckets(raw: unknown): Promise<SaveResult> {
  const parsed = bucketsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Buckets didn't validate." };

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
      .upsert({ id: user.id, buckets_json: parsed.data }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * Load the user's buckets. Provision-if-null: a brand-new profile row has
 * buckets_json = NULL → seed STARTER_BUCKETS once and persist. An explicit []
 * (user emptied them) is respected and never re-seeded.
 */
export async function loadBuckets(): Promise<Bucket[]> {
  if (!isSupabaseConfigured()) return STARTER_BUCKETS;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return STARTER_BUCKETS;

    const { data } = await supabase
      .from("profiles")
      .select("buckets_json, profile_json")
      .eq("id", user.id)
      .maybeSingle();
    // Existing user → their buckets + any newly-shipped starter bindings they don't have yet
    // (e.g. the education/work-experience flat-field bindings). Non-destructive; merge is on-read.
    if (data && data.buckets_json != null) {
      // + each field's own name as a default wording (non-destructive, deduped) so the bucket editor
      // shows the same coverage the fill uses.
      const prof = data.profile_json != null ? coerceProfile(data.profile_json) : null;
      const withStarters = ensureStarterBuckets(coerceBuckets(data.buckets_json));
      return prof ? ensureDefaultFieldWordings(withStarters, prof) : withStarters;
    }

    // Never provisioned → seed the approved starter set (Mode-A bindings only).
    await supabase
      .from("profiles")
      .upsert({ id: user.id, buckets_json: STARTER_BUCKETS }, { onConflict: "id" });
    return STARTER_BUCKETS;
  } catch {
    return STARTER_BUCKETS;
  }
}
