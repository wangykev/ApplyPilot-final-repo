import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile, emptyProfile } from "@/lib/profile-schema";
import { coerceBuckets, ensureStarterBuckets, STARTER_BUCKETS } from "@/lib/buckets";
import { teachableCards, type TeachSource } from "@/lib/teach";
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
    const buckets = ensureStarterBuckets(profRes.data?.buckets_json != null ? coerceBuckets(profRes.data.buckets_json) : STARTER_BUCKETS);
    const dismissed = Array.isArray(profRes.data?.teach_dismissed_json) ? (profRes.data!.teach_dismissed_json as string[]) : [];
    const cards = teachableCards(apps, buckets, profile, dismissed);
    return NextResponse.json({ ok: true, cards });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
