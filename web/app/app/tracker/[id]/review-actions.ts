"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import type { ReviewBundle } from "@/lib/review-summary";
import { approvalEnvelope } from "@/lib/review-approval";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Persist an edited+approved review bundle back to applications.review_bundle_json.
 * RLS-scoped to the owner (the anon client with the user's session). The extension
 * PULLS this bundle before replay (GET /api/extension/review), so this write is the
 * hand-off: the SW consumes exactly what the operator approved here.
 *
 * The bundle's `approval` roll-up is recomputed server-side (never trust a
 * client-sent submit_ready) and `needs_review_count` is refreshed so the tracker row
 * stays in sync. Nothing here submits — status is left untouched.
 */
export async function saveReviewBundle(id: string, bundle: ReviewBundle): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  if (!bundle || !Array.isArray(bundle.entries)) return { ok: false, error: "No bundle to save." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    // Recompute the approval envelope + a fresh needs_review_count from the entries the
    // operator actually left (soft-deleted excluded) — the client's copy is advisory only.
    const live = bundle.entries.filter((e) => !e.is_deleted);
    const approval = approvalEnvelope(bundle.entries);
    const needs = live.filter((e) => e.needs_review && !e.is_approved).length;
    const toStore: ReviewBundle = { ...bundle, approval };

    const { error } = await supabase
      .from("applications")
      .update({ review_bundle_json: toStore, needs_review_count: needs })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/app/tracker/${id}`);
    revalidatePath("/app/tracker");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
