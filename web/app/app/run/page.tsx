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
/**
 * Both discovery defaults come out of the SAME profile read.
 *
 * `homeCountry` seeds the Discover panel's location box. There is deliberately no
 * hardcoded fallback country anywhere in the sweep: the operator's own profile is
 * the only defensible default for "where should I look", and baking in a country
 * would silently search the wrong one for anyone whose profile says otherwise.
 * `country` is a tiered array like `field_of_study`, so entry 0 is the answer.
 */
async function loadDiscoverDefaults(): Promise<{
  fieldOfStudy: string;
  homeCountry: string;
  jobTitles: string[];
  skills: string[];
}> {
  const none = { fieldOfStudy: "", homeCountry: "", jobTitles: [] as string[], skills: [] as string[] };
  if (!isSupabaseConfigured()) return none;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return none;
    const { data } = await supabase.from("profiles").select("profile_json").eq("id", user.id).maybeSingle();
    if (!data?.profile_json) return none;
    const profile = coerceProfile(data.profile_json);
    const tier0 = (v: unknown): string => {
      const first = Array.isArray(v) ? v[0] : v;
      return typeof first === "string" ? first.trim() : "";
    };
    return {
      fieldOfStudy: tier0(profile.education?.[0]?.field_of_study),
      homeCountry: tier0(profile.personal_info?.country),
      // The resume, for deriving SEVERAL searches when the keyword box is blank:
      // roles actually held (the strongest evidence of what you want next) and skills.
      jobTitles: (profile.work_experience ?? [])
        .map((w) => String(w?.job_title || "").trim())
        .filter(Boolean)
        .slice(0, 6),
      skills: (profile.skills ?? []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8),
    };
  } catch {
    return none;
  }
}

export default async function RunPage() {
  const { fieldOfStudy, homeCountry, jobTitles, skills } = await loadDiscoverDefaults();
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
      <DiscoverPanel fieldOfStudy={fieldOfStudy} homeCountry={homeCountry} jobTitles={jobTitles} skills={skills} />
    </div>
  );
}
