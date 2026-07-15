import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile, emptyProfile, type Profile } from "@/lib/profile-schema";
import { ProfileEditor } from "./ProfileEditor";
import { BucketsPanel } from "@/components/app/BucketsPanel";
import { loadBuckets } from "./actions";

export const dynamic = "force-dynamic";

async function loadProfile(): Promise<Profile> {
  if (!isSupabaseConfigured()) return emptyProfile();
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return emptyProfile();
    const { data } = await supabase
      .from("profiles")
      .select("profile_json")
      .eq("id", user.id)
      .maybeSingle();
    return data?.profile_json ? coerceProfile(data.profile_json) : emptyProfile();
  } catch {
    return emptyProfile();
  }
}

export default async function ProfilePage() {
  const [initial, buckets] = await Promise.all([loadProfile(), loadBuckets()]);
  return (
    <div className="space-y-8 pb-28">
      <PageHeader
        eyebrow="Your data"
        title="Profile"
        description="The details ApplyPilot fills applications from. Stored as raw fields — the extension derives dates, joined bullets, and fluency from these."
      />
      <ProfileEditor initial={initial} />
      <BucketsPanel initial={buckets} />
    </div>
  );
}
