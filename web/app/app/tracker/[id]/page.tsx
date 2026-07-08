import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { ReviewSummaryView } from "@/components/app/ReviewSummaryView";
import type { ReviewBundle } from "@/lib/review-summary";
import type { Application } from "../shared";
import { SAMPLE_APPS, SAMPLE_BUNDLE_BY_ID } from "../sample";

export const dynamic = "force-dynamic";

type Loaded = { app: Application; bundle: ReviewBundle | null };

function sampleLookup(id: string): Loaded | null {
  const app = SAMPLE_APPS.find((a) => a.id === id);
  return app ? { app, bundle: SAMPLE_BUNDLE_BY_ID[id] ?? null } : null;
}

async function loadApp(id: string): Promise<Loaded | null> {
  if (!isSupabaseConfigured()) return DEV_PREVIEW ? sampleLookup(id) : null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return DEV_PREVIEW ? sampleLookup(id) : null;
    const { data } = await supabase
      .from("applications")
      .select("id, company, role, url, status, needs_review_count, applied_at, created_at, review_bundle_json")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) return DEV_PREVIEW ? sampleLookup(id) : null;
    const { review_bundle_json, ...app } = data as Application & { review_bundle_json: ReviewBundle | null };
    return { app: app as Application, bundle: review_bundle_json ?? null };
  } catch {
    return DEV_PREVIEW ? sampleLookup(id) : null;
  }
}

export default async function ApplicationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadApp(id);
  if (!loaded) notFound();
  const { app, bundle } = loaded;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/app/tracker" className="inline-flex items-center gap-1.5 text-sm text-ink-dim transition-colors hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" />
          Tracker
        </Link>
        <div className="mt-4 flex flex-col gap-2 border-b border-hairline pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="eyebrow">Review summary</p>
            <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              {app.company || "Application"}
            </h1>
            {app.role && <p className="mt-1 text-sm text-ink-dim">{app.role}</p>}
          </div>
          {app.url && (
            <a href={app.url} target="_blank" rel="noreferrer" className="btn-ghost">
              Open posting
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </div>

      {bundle ? (
        <ReviewSummaryView bundle={bundle} />
      ) : (
        <div className="bezel px-6 py-12 text-center">
          <p className="text-sm text-ink-dim">No review summary captured yet.</p>
          <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-faint">
            When ApplyPilot finishes a fill for this application, its per-field review — verified
            fills and flagged guesses — shows up here for you to check before you submit.
          </p>
        </div>
      )}
    </div>
  );
}
