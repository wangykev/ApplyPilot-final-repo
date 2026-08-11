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

    // The tracker LIST cannot see per-field approval (it never loads the bundle — a large jsonb), so the
    // roll-up is mirrored onto its own column. Computed from the SAME server-side envelope, never from
    // anything the client asserted.
    //
    // ⚠ It is CLEARED as readily as it is set. A value edit resets that field's approval, so a bundle
    // that stops being submit_ready must stop reading "Approved" — a stale badge on a row that now has an
    // unreviewed answer is exactly the wrong thing to show on the screen you decide from.
    const approvedAt = approval.submit_ready ? new Date().toISOString() : null;

    const save = (cols: Record<string, unknown>) =>
      supabase.from("applications").update(cols).eq("id", id).eq("user_id", user.id);

    let { error } = await save({ review_bundle_json: toStore, needs_review_count: needs, approved_at: approvedAt });
    // Losing the operator's EDITS because an optional column is missing would be the worst trade here —
    // those edits are hand-made and unrecoverable. Save the bundle without the badge.
    if (error && /approved_at/.test(error.message || "")) {
      ({ error } = await save({ review_bundle_json: toStore, needs_review_count: needs }));
    }
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/app/tracker/${id}`);
    revalidatePath("/app/tracker");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
