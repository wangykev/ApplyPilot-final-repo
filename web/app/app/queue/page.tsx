import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { QueueTabs } from "./QueueTabs";
import type { QueueItem } from "./shared";
import type { Application } from "../tracker/shared";

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

/**
 * THE SUBMIT QUEUE — filled and approved, not yet sent. Derived from `applications`, never its own
 * table: that state already exists as `approved_at` set while the status is still `needs_review`, and
 * a second copy of it could only ever disagree with the first.
 *
 * ⚠ `approved_at` is selected OPTIONALLY, exactly as the tracker list does it: on a database that has
 * not run migration 0018 the column does not exist, and naming it fails the WHOLE query. There the
 * submit queue is simply empty — approval is unknowable, so claiming anything is ready would be a
 * guess — while the fill queue beside it keeps working.
 */
async function loadReadyToSubmit(): Promise<Application[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data, error } = await supabase
      .from("applications")
      .select("id, company, role, url, status, needs_review_count, applied_at, created_at, approved_at")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .eq("status", "needs_review")
      .not("approved_at", "is", null)
      // OLDEST APPROVAL FIRST: the queue's order is the order you decided these were ready, which is
      // the order you want to work through them — not when they happened to be filled.
      .order("approved_at", { ascending: true });
    if (error) return [];
    return ((data ?? []) as unknown as Application[]);
  } catch {
    return [];
  }
}

export default async function QueuePage() {
  const [items, ready] = await Promise.all([loadQueue(), loadReadyToSubmit()]);
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Apply in batches"
        title="Job queue"
        description="Two stages of the same pipeline: jobs lined up to be FILLED, and applications you've approved that are waiting to be SENT. Paste links below, or let Discover on the Run page fill this from LinkedIn, Handshake and the Simplify board."
      />
      <QueueTabs items={items} ready={ready} />
    </div>
  );
}
