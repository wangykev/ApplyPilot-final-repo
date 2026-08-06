import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile, emptyProfile, type Profile } from "@/lib/profile-schema";
import { coerceAiConfig, emptyAiConfig, type AiConfig } from "@/lib/ai-config";
import { coerceBuckets, ensureStarterBuckets, STARTER_BUCKETS, type Bucket } from "@/lib/buckets";
import { ensureDefaultFieldWordings } from "@/lib/teach";
import { coerceOnboarding, countUsableKeys, type OnboardingFacts } from "@/lib/onboarding";
import { StartFlow } from "./StartFlow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up · ApplyPilot" };

type Loaded = {
  facts: OnboardingFacts;
  profile: Profile;
  buckets: Bucket[];
  aiConfig: AiConfig;
  resume: { filename: string; size: number } | null;
};

function blank(): Loaded {
  return {
    facts: { hasResume: false, profileApprovedAt: null, usableKeys: 0, completedAt: null },
    profile: emptyProfile(),
    buckets: STARTER_BUCKETS,
    aiConfig: emptyAiConfig(),
    resume: null,
  };
}

/**
 * One pass over everything the three steps need. Read together rather than per-step so the
 * flow opens on the right step immediately — a wizard that renders step 1 and then jumps is
 * worse than one that waits for a single round of reads.
 */
async function load(): Promise<Loaded> {
  if (!isSupabaseConfigured()) return blank();
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return blank();

    /**
     * `onboarding_json` is read SEPARATELY from the columns that predate it. On a database
     * where migration 0014 hasn't been applied, selecting it fails — and folded into the
     * main select that failure would take `profile_json` down with it, handing the editor
     * below an EMPTY profile that the user could then save straight over their real one.
     * Split, the worst case is a flow that thinks you haven't started.
     */
    const [profileRes, onboardingRes, resumeRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("profile_json, buckets_json, ai_config")
        .eq("id", user.id)
        .maybeSingle(),
      supabase.from("profiles").select("onboarding_json").eq("id", user.id).maybeSingle(),
      supabase
        .from("resumes")
        .select("filename, size")
        .eq("user_id", user.id)
        .eq("kind", "default")
        .order("created_at", { ascending: false })
        .maybeSingle(),
    ]);

    const row = profileRes.data;
    const record = coerceOnboarding(onboardingRes.data?.onboarding_json);
    const profile = row?.profile_json ? coerceProfile(row.profile_json) : emptyProfile();
    // Same on-read merge the profile page does, so the editor shown here behaves identically
    // (starter bindings + each field's own name as a default wording).
    const buckets = row?.buckets_json
      ? ensureDefaultFieldWordings(ensureStarterBuckets(coerceBuckets(row.buckets_json)), profile)
      : STARTER_BUCKETS;

    return {
      facts: {
        hasResume: !!resumeRes.data,
        profileApprovedAt: record.profile_approved_at,
        usableKeys: countUsableKeys(row?.ai_config),
        completedAt: record.completed_at,
      },
      profile,
      buckets,
      aiConfig: row?.ai_config ? coerceAiConfig(row.ai_config) : emptyAiConfig(),
      resume: resumeRes.data ? { filename: resumeRes.data.filename, size: resumeRes.data.size } : null,
    };
  } catch {
    return blank();
  }
}

/** Only ever hand control back to a path inside the app — never an arbitrary URL. */
function safeNext(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") return "/app";
  if (!v.startsWith("/app") || v.startsWith("//") || v.startsWith("/app/start")) return "/app";
  return v;
}

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [loaded, params] = await Promise.all([load(), searchParams]);
  return (
    <StartFlow
      facts={loaded.facts}
      profile={loaded.profile}
      buckets={loaded.buckets}
      aiConfig={loaded.aiConfig}
      resume={loaded.resume}
      next={safeNext(params.next)}
      configured={isSupabaseConfigured()}
    />
  );
}
