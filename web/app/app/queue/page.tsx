import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { QueuePanel } from "./QueuePanel";
import type { QueueItem } from "./shared";

export const dynamic = "force-dynamic";

const SAMPLE: QueueItem[] = [
  { id: "s1", url: "https://comcast.wd5.myworkdayjobs.com/en-US/Comcast_Careers/job/apply", status: "done", position: 1 },
  { id: "s2", url: "https://liveramp.wd5.myworkdayjobs.com/en-US/LiveRamp/job/apply", status: "active", position: 2 },
  { id: "s3", url: "https://usbank.wd1.myworkdayjobs.com/en-US/usbank/job/apply", status: "pending", position: 3 },
];

async function loadQueue(): Promise<QueueItem[]> {
  if (!isSupabaseConfigured()) return DEV_PREVIEW ? SAMPLE : [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return DEV_PREVIEW ? SAMPLE : [];
    const { data } = await supabase
      .from("queue_items")
      .select("id, url, status, position, company, role, source, location, posted_at, job_description, details")
      .eq("user_id", user.id)
      .order("position", { ascending: true });
    if ((!data || data.length === 0) && DEV_PREVIEW) return SAMPLE;
    return (data as QueueItem[]) ?? [];
  } catch {
    return DEV_PREVIEW ? SAMPLE : [];
  }
}

export default async function QueuePage() {
  const items = await loadQueue();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Apply in batches"
        title="Job queue"
        description="Line up Workday applications and let the extension work through them, one fill → review at a time. Paste links here, or let Discover on the Run page fill this from LinkedIn, Handshake and the Simplify board."
      />
      <QueuePanel items={items} />
    </div>
  );
}
