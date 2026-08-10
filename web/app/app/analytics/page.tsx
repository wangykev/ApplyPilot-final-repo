import { PageHeader } from "@/components/app/PageHeader";
import { SectionCard } from "@/components/app/SectionCard";
import { StatTile, SegmentBar, ColumnChart, type Segment } from "@/components/app/charts";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import type { Application, AppStatus } from "../tracker/shared";
import { SAMPLE_APPS } from "../tracker/sample";

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
      .eq("user_id", user.id);
    if ((!data || data.length === 0) && DEV_PREVIEW) return SAMPLE_APPS;
    return (data as Application[]) ?? [];
  } catch {
    return DEV_PREVIEW ? SAMPLE_APPS : [];
  }
}

const STAGES: { key: AppStatus; label: string; color: string }[] = [
  { key: "queued", label: "Queued", color: "#7E8C9E" },
  { key: "needs_review", label: "Needs review", color: "#FFC85C" },
  { key: "submitted", label: "Submitted", color: "#36D6A0" },
  { key: "interviewing", label: "Interviewing", color: "#5BD2FF" },
  { key: "offer", label: "Offer", color: "#6EE7B7" },
  { key: "rejected", label: "Rejected", color: "#FF5C5C" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekly(apps: Application[]): { label: string; value: number }[] {
  const buckets = new Map<string, { ts: number; label: string; count: number }>();
  for (const a of apps) {
    const iso = a.applied_at || a.created_at;
    const d = new Date(iso);
    if (isNaN(d.getTime())) continue;
    const dow = d.getUTCDay();
    const back = dow === 0 ? 6 : dow - 1; // to Monday
    const ws = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
    const key = ws.toISOString().slice(0, 10);
    const cur = buckets.get(key) ?? {
      ts: ws.getTime(),
      label: `${MONTHS[ws.getUTCMonth()]} ${ws.getUTCDate()}`,
      count: 0,
    };
    cur.count += 1;
    buckets.set(key, cur);
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.ts - b.ts)
    .map((b) => ({ label: b.label, value: b.count }));
}

export default async function AnalyticsPage() {
  const apps = await loadApplications();
  const count = (s: AppStatus) => apps.filter((a) => a.status === s).length;

  const total = apps.length;
  const reachedSubmitted = ["submitted", "interviewing", "offer", "rejected"].reduce(
    (n, s) => n + count(s as AppStatus),
    0
  );
  const offers = count("offer");
  const interviewing = count("interviewing");
  const needsReviewLoad = apps.reduce((n, a) => n + (a.needs_review_count || 0), 0);
  const offerRate = reachedSubmitted > 0 ? Math.round((offers / reachedSubmitted) * 100) : 0;
  const interviewRate = reachedSubmitted > 0 ? Math.round((interviewing / reachedSubmitted) * 100) : 0;

  const segments: Segment[] = STAGES.map((s) => ({ label: s.label, value: count(s.key), color: s.color }));
  const overTime = weekly(apps);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="The numbers"
        title="Analytics"
        description="How your applications are moving — volume over time, pipeline distribution, and outcome rates."
      />

      {total === 0 ? (
        <div className="bezel px-6 py-12 text-center">
          <p className="text-sm text-ink-dim">No applications yet.</p>
          <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-faint">
            Once you start applying, this fills with your volume, pipeline, and outcome rates.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Applications" value={total} />
            <StatTile label="Submitted" value={reachedSubmitted} color="#36D6A0" />
            <StatTile label="Interview rate" value={`${interviewRate}%`} sub={`${interviewing} of ${reachedSubmitted} submitted`} color="#5BD2FF" />
            <StatTile label="Needs-review load" value={needsReviewLoad} sub="fields flagged across runs" color="#FFB627" />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard title="Pipeline" subtitle="Where your applications stand right now.">
              <SegmentBar segments={segments} />
            </SectionCard>

            <SectionCard title="Outcomes" subtitle="Of applications you've submitted.">
              <div className="grid grid-cols-2 gap-4">
                <StatTile label="Offer rate" value={`${offerRate}%`} sub={`${offers} offer${offers === 1 ? "" : "s"}`} color="#6EE7B7" />
                <StatTile label="Interviewing" value={interviewing} color="#5BD2FF" />
                <StatTile label="Offers" value={offers} color="#6EE7B7" />
                <StatTile label="Rejected" value={count("rejected")} color="#FF5C5C" />
              </div>
            </SectionCard>
          </div>

          <SectionCard title="Applications over time" subtitle="By week.">
            <ColumnChart data={overTime} />
          </SectionCard>
        </>
      )}
    </div>
  );
}
