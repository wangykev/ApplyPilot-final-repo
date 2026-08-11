"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { approvalEnvelope } from "@/lib/review-approval";
import type { ReviewBundle } from "@/lib/review-summary";

type Result = { ok: true; approvedAt: string } | { ok: false; error: string };

/**
 * Approve an application straight from the tracker list, without opening it.
 *
 * Only offered when a fill flagged NOTHING — there is genuinely no per-field decision to make, so
 * requiring a click into the detail page just to press a button is friction with no review value.
 *
 * It re-derives readiness from the BUNDLE, server-side, and refuses otherwise. The list's
 * `needs_review_count` is a denormalised mirror and is NOT sufficient evidence: `submit_ready` also
 * requires no unreplaced AI placeholder and no REQUIRED field left blank, and neither of those shows up
 * in that count. Stamping "approved" on an application that a replay would then halt on is exactly the
 * failure this gate exists to prevent, so the count decides whether to SHOW the button and the envelope
 * decides whether it may act.
 */
export async function approveApplication(id: string): Promise<Result> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { data, error } = await supabase
      .from("applications")
      .select("review_bundle_json")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };

    const bundle = (data?.review_bundle_json ?? null) as ReviewBundle | null;
    if (!bundle || !Array.isArray(bundle.entries) || !bundle.entries.length) {
      return { ok: false, error: "No review summary captured yet — run a fill first." };
    }

    const env = approvalEnvelope(bundle.entries);
    if (!env.submit_ready) {
      // Say WHICH gate failed: "not ready" with no reason sends you hunting through the field list.
      const why =
        env.pending_count > 0 ? `${env.pending_count} field(s) still need your review`
        : env.unreplaced_placeholders > 0 ? `${env.unreplaced_placeholders} AI placeholder(s) still unanswered`
        : (env.required_blank ?? 0) > 0 ? `${env.required_blank} required field(s) are blank`
        : "it isn't ready to submit";
      return { ok: false, error: `Open it to finish — ${why}.` };
    }

    const approvedAt = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("applications")
      .update({ approved_at: approvedAt, needs_review_count: 0 })
      .eq("id", id)
      .eq("user_id", user.id);
    if (upErr) return { ok: false, error: upErr.message };

    revalidatePath("/app/tracker");
    revalidatePath(`/app/tracker/${id}`);
    return { ok: true, approvedAt };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
