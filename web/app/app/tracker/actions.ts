"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { APP_STATUSES, type AppStatus } from "./shared";

type ActionResult = { ok: true } | { ok: false; error: string };

async function ctx() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function updateApplicationStatus(id: string, status: AppStatus): Promise<ActionResult> {
  if (!APP_STATUSES.includes(status)) return { ok: false, error: "Unknown status." };
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const { supabase, user } = await ctx();
    if (!user) return { ok: false, error: "You're not signed in." };
    const { error } = await supabase
      .from("applications")
      .update({ status })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/app/tracker");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

export async function deleteApplication(id: string): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const { supabase, user } = await ctx();
    if (!user) return { ok: false, error: "You're not signed in." };
    // SOFT-delete: hide it from the tracker but KEEP the row + its review_bundle_json, so any answers the
    // operator APPROVED still surface on the teach page (operator: "as long as it got approved it should
    // stay on teach"). A re-fill of the same URL clears deleted_at (see /api/extension/report).
    const { error } = await supabase
      .from("applications")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/app/tracker");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
