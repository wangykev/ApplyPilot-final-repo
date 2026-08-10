import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile, emptyProfile } from "@/lib/profile-schema";
import { coerceBuckets, ensureStarterBuckets, STARTER_BUCKETS } from "@/lib/buckets";
import { teachableCards, ensureDefaultFieldWordings, type TeachSource } from "@/lib/teach";
import type { ReviewBundle } from "@/lib/review-summary";

export const dynamic = "force-dynamic";

/**
 * The current teachable cards for the signed-in user — POLLED by the teach inbox so a fill that was
 * just reviewed + approved appends to the queue WITHOUT a refresh. Mirrors the teach server page's
 * loaders (loadSources + loadBuckets + loadDismissed) + teachableCards. Cookie-authed.
 *
 * ok:false when unconfigured / not signed in → the poller leaves the queue untouched.
 */
export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, reason: "not-configured" });
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, reason: "not-signed-in" }, { status: 401 });
    const [appsRes, profRes] = await Promise.all([
      supabase
        .from("applications")
        .select("id, company, review_bundle_json, updated_at")
        .eq("user_id", user.id)
        .not("review_bundle_json", "is", null)
        .order("updated_at", { ascending: false })
        .limit(100),
      supabase.from("profiles").select("profile_json, buckets_json, teach_dismissed_json").eq("id", user.id).maybeSingle(),
    ]);
    const apps: TeachSource[] = (appsRes.data || []).map((a) => ({
      id: a.id as string,
      company: (a.company as string | null) ?? null,
      bundle: (a.review_bundle_json as ReviewBundle | null) ?? null,
    }));
    const profile = profRes.data?.profile_json ? coerceProfile(profRes.data.profile_json) : emptyProfile();
    // Mirror loadBuckets: NULL buckets_json → the starter set; otherwise the user's buckets + any newly
    // shipped starter bindings they don't have yet (dedup by profile_path, non-destructive).
    // …plus every profile field's own name as a default wording, so a card whose question IS the field
    // label counts as already covered instead of asking to be taught (operator, 2026-07-26).
    const buckets = ensureDefaultFieldWordings(
      ensureStarterBuckets(profRes.data?.buckets_json != null ? coerceBuckets(profRes.data.buckets_json) : STARTER_BUCKETS),
      profile,
    );
    const dismissed = Array.isArray(profRes.data?.teach_dismissed_json) ? (profRes.data!.teach_dismissed_json as string[]) : [];
    const cards = teachableCards(apps, buckets, profile, dismissed);
    return NextResponse.json({ ok: true, cards });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}

/**
 * POST { action: "dismiss-all" } — clear the whole teach queue.
 *
 * The queue is DERIVED from application bundles, not stored, so there is no list to delete: clearing
 * means dismissing every key the current bundles produce. That is why this is computed server-side
 * from the same inputs GET uses — a client-supplied list would silently miss any card the caller
 * hadn't loaded.
 *
 * Reversible: it only appends to `teach_dismissed_json`, so nothing about the underlying applications
 * or buckets changes and the keys can be removed again. NEW questions from future runs still appear —
 * only the questions asked exactly this way are suppressed.
 */
export async function POST(req: Request) {
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, reason: "not-configured" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "expected JSON" }, { status: 400 });
  }
  if ((body as { action?: string })?.action !== "dismiss-all") {
    return NextResponse.json({ ok: false, reason: "unknown action" }, { status: 400 });
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, reason: "not-signed-in" }, { status: 401 });

    const [appsRes, profRes] = await Promise.all([
      supabase
        .from("applications")
        .select("id, company, review_bundle_json, updated_at")
        .eq("user_id", user.id)
        .not("review_bundle_json", "is", null)
        .order("updated_at", { ascending: false })
        .limit(100),
      supabase.from("profiles").select("profile_json, buckets_json, teach_dismissed_json").eq("id", user.id).maybeSingle(),
    ]);
    const apps: TeachSource[] = (appsRes.data || []).map((a) => ({
      id: a.id as string,
      company: (a.company as string | null) ?? null,
      bundle: (a.review_bundle_json as ReviewBundle | null) ?? null,
    }));
    const profile = profRes.data?.profile_json ? coerceProfile(profRes.data.profile_json) : emptyProfile();
    const buckets = ensureDefaultFieldWordings(
      ensureStarterBuckets(profRes.data?.buckets_json != null ? coerceBuckets(profRes.data.buckets_json) : STARTER_BUCKETS),
      profile,
    );
    const already = Array.isArray(profRes.data?.teach_dismissed_json) ? (profRes.data!.teach_dismissed_json as string[]) : [];
    // No `dismissed` filter here: we want EVERY key the bundles can produce, including ones already
    // dismissed, so the stored set is complete rather than a delta.
    const keys = teachableCards(apps, buckets, profile, []).map((c) => c.key);
    const merged = Array.from(new Set([...already, ...keys]));

    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, teach_dismissed_json: merged }, { onConflict: "id" });
    if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, cleared: keys.length, dismissed_total: merged.length });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
