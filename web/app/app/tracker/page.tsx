import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { TrackerPanel } from "./TrackerPanel";
import { ReportHealthGuard } from "./ReportHealthGuard";
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
      .is("deleted_at", null) // soft-deleted apps are hidden from the tracker (their bundles live on for teach)
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
      {/* Repairs a stale reporting link by itself and stays silent when it succeeds — the tracker is
          where a user notices an application is missing, so it is where the repair belongs. */}
      <ReportHealthGuard />
      <TrackerPanel applications={applications} />
    </div>
  );
}
