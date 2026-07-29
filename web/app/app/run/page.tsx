import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile } from "@/lib/profile-schema";
import { RunPanel } from "./RunPanel";
import { DiscoverPanel } from "./DiscoverPanel";

export const dynamic = "force-dynamic";

/**
 * The operator's field of study — what Discover falls back to when the keyword box
 * is blank. A blank box used to build a keyword-less LinkedIn URL, which signed in
 * renders their RECOMMENDED feed rather than a search, so "no keywords" quietly
 * returned the wrong jobs. Deriving from the profile keeps a blank box SPECIFIC.
 *
 * `field_of_study` is a tiered array (most-specific first), so entry 0 of the
 * primary education row is the best single answer. Never throws — a missing
 * profile / unconfigured backend just means no default, and the panel says so.
 */
async function loadFieldOfStudy(): Promise<string> {
  if (!isSupabaseConfigured()) return "";
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return "";
    const { data } = await supabase.from("profiles").select("profile_json").eq("id", user.id).maybeSingle();
    if (!data?.profile_json) return "";
    const profile = coerceProfile(data.profile_json);
    const first = profile.education?.[0]?.field_of_study;
    const value = Array.isArray(first) ? first[0] : first;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export default async function RunPage() {
  const fieldOfStudy = await loadFieldOfStudy();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Autopilot"
        title="Run an application"
        description="Paste a Workday job link and press Run. The extension opens it in a new tab, grabs the job description, applies, signs in and verifies your email if the tenant needs it, then fills every page — stopping at the review page for you to approve. It never submits."
      />
      <RunPanel />
      {/* Find work to run: sweeps the job boards for new postings and fills the queue.
          Sits below Run because Run is the page's primary action — Discover feeds it. */}
      <DiscoverPanel fieldOfStudy={fieldOfStudy} />
    </div>
  );
}
