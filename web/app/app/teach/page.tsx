import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile, emptyProfile, type Profile } from "@/lib/profile-schema";
import { loadBuckets } from "../profile/actions";
import { loadDismissed } from "./actions";
import type { ReviewBundle } from "@/lib/review-summary";
import { teachableCards, type TeachSource } from "@/lib/teach";
import { TeachInbox } from "@/components/app/teach/TeachInbox";

export const dynamic = "force-dynamic";

/** Load the user's reviewed applications (with their bundles) + profile, for the teach queue. */
async function loadSources(): Promise<{ apps: TeachSource[]; profile: Profile }> {
  if (!isSupabaseConfigured()) return { apps: [], profile: emptyProfile() };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { apps: [], profile: emptyProfile() };
    const [appsRes, profRes] = await Promise.all([
      supabase
        .from("applications")
        .select("id, company, review_bundle_json, updated_at")
        .eq("user_id", user.id)
        .not("review_bundle_json", "is", null)
        .order("updated_at", { ascending: false })
        .limit(100),
      supabase.from("profiles").select("profile_json").eq("id", user.id).maybeSingle(),
    ]);
    const apps: TeachSource[] = (appsRes.data || []).map((a) => ({
      id: a.id as string,
      company: (a.company as string | null) ?? null,
      bundle: (a.review_bundle_json as ReviewBundle | null) ?? null,
    }));
    const profile = profRes.data?.profile_json ? coerceProfile(profRes.data.profile_json) : emptyProfile();
    return { apps, profile };
  } catch {
    return { apps: [], profile: emptyProfile() };
  }
}

export default async function TeachPage() {
  const [{ apps, profile }, buckets, dismissed] = await Promise.all([loadSources(), loadBuckets(), loadDismissed()]);
  // Compute ALL teachable cards (no dismissed filter), then partition: the active queue (not skipped)
  // vs. the SKIPPED ones, so the inbox can show a "Skipped (N)" section with a restore path back.
  const allCards = teachableCards(apps, buckets, profile, []);
  const dismissedSet = new Set(dismissed);
  const cards = allCards.filter((c) => !dismissedSet.has(c.key));
  const skippedCards = allCards.filter((c) => dismissedSet.has(c.key));
  return (
    <div className="space-y-8 pb-28">
      <PageHeader
        eyebrow="Get smarter"
        title="Teach"
        description="Questions the AI had to guess — that you approved on review. Add each to your saved answers so the next application fills it deterministically, with no review."
      />
      <TeachInbox initialCards={cards} initialSkipped={skippedCards} initialBuckets={buckets} initialDismissed={dismissed} profile={profile} />
    </div>
  );
}
