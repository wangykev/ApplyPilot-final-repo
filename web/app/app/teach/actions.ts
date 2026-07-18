"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";

export type SaveResult = { ok: true } | { ok: false; error: string };

const dismissedSchema = z.array(z.string()).default([]);

/** Load the user's persistently-dismissed teach keys (normalized question labels). */
export async function loadDismissed(): Promise<string[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
      .from("profiles")
      .select("teach_dismissed_json")
      .eq("id", user.id)
      .maybeSingle();
    const parsed = dismissedSchema.safeParse(data?.teach_dismissed_json);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Persist the full set of dismissed teach keys (the client sends the merged list). */
export async function saveDismissed(raw: unknown): Promise<SaveResult> {
  const parsed = dismissedSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Dismissed list didn't validate." };
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    // de-dupe before storing
    const unique = Array.from(new Set(parsed.data));
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, teach_dismissed_json: unique }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
