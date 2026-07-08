import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { TrackerPanel } from "./TrackerPanel";
import type { Application } from "./shared";
import { SAMPLE_APPS } from "./sample";

export const dynamic = "force-dynamic";

async function loadApplications(): Promise<Application[]> {
  if (!isSupabaseConfigured()) return DEV_PREVIEW ? SAMPLE_APPS : [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return DEV_PREVIEW ? SAMPLE_APPS : [];
    const { data } = await supabase
      .from("applications")
      .select("id, company, role, url, status, needs_review_count, applied_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if ((!data || data.length === 0) && DEV_PREVIEW) return SAMPLE_APPS;
    return (data as Application[]) ?? [];
  } catch {
    return DEV_PREVIEW ? SAMPLE_APPS : [];
  }
}

export default async function TrackerPage() {
  const applications = await loadApplications();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Every application, one place"
        title="Tracker"
        description="The extension reports each run here — company, role, status, and fields needing review. Move cards through your pipeline as you hear back."
      />
      <TrackerPanel applications={applications} />
    </div>
  );
}
