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
    // soft-deleted apps are hidden from the tracker (their bundles live on for teach)
    // QUEUED is not a tracker row (operator, 2026-08-11). The tracker is the record of applications
    // that have actually been WORKED — filled, reviewed, sent. A queued row has never been filled, so it
    // has nothing to show and nothing to act on here; queueing lives on its own tab.
    const query = (cols: string) =>
      supabase.from("applications").select(cols).eq("user_id", user.id).is("deleted_at", null)
        .neq("status", "queued")
        .order("created_at", { ascending: false });
    const BASE = "id, company, role, url, status, needs_review_count, applied_at, created_at";
    // approved_at is fetched OPTIONALLY: on a database that has not run 0018 yet, naming it fails the
    // whole query and the tracker list — the page's entire reason to exist — renders empty. An "Approved"
    // badge is not worth that, so fall back to the columns that have always been there.
    let { data, error } = await query(BASE + ", approved_at");
    if (error) ({ data } = await query(BASE));
    if ((!data || data.length === 0) && DEV_PREVIEW) return SAMPLE_APPS;
    return ((data ?? []) as unknown as Application[]);
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
