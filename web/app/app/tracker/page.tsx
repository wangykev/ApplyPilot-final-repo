import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { TrackerPanel } from "./TrackerPanel";
import type { Application } from "./shared";

export const dynamic = "force-dynamic";

const SAMPLE: Application[] = [
  { id: "a1", company: "Comcast", role: "Software Engineering Intern", url: "https://comcast.wd5.myworkdayjobs.com", status: "submitted", needs_review_count: 0, applied_at: "2026-06-24T10:00:00Z", created_at: "2026-06-24T10:00:00Z" },
  { id: "a2", company: "LiveRamp", role: "Data Engineer", url: "https://liveramp.wd5.myworkdayjobs.com", status: "needs_review", needs_review_count: 2, applied_at: "2026-06-26T10:00:00Z", created_at: "2026-06-26T10:00:00Z" },
  { id: "a3", company: "U.S. Bank", role: "Analyst", url: "https://usbank.wd1.myworkdayjobs.com", status: "interviewing", needs_review_count: 0, applied_at: "2026-06-20T10:00:00Z", created_at: "2026-06-20T10:00:00Z" },
  { id: "a4", company: "Magna", role: "Software Engineer", url: "https://magna.wd3.myworkdayjobs.com", status: "offer", needs_review_count: 0, applied_at: "2026-06-18T10:00:00Z", created_at: "2026-06-18T10:00:00Z" },
  { id: "a5", company: "Cambium Learning", role: "Frontend Engineer", url: "https://cambium.wd1.myworkdayjobs.com", status: "rejected", needs_review_count: 0, applied_at: "2026-06-15T10:00:00Z", created_at: "2026-06-15T10:00:00Z" },
];

async function loadApplications(): Promise<Application[]> {
  if (!isSupabaseConfigured()) return DEV_PREVIEW ? SAMPLE : [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return DEV_PREVIEW ? SAMPLE : [];
    const { data } = await supabase
      .from("applications")
      .select("id, company, role, url, status, needs_review_count, applied_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if ((!data || data.length === 0) && DEV_PREVIEW) return SAMPLE;
    return (data as Application[]) ?? [];
  } catch {
    return DEV_PREVIEW ? SAMPLE : [];
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
