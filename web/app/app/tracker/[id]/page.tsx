import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, KeyRound } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { ReviewEditor } from "@/components/app/review/ReviewEditor";
import {
  SubmittedRecord,
  type SubmissionRecord,
  type WorkdayReviewPage,
} from "@/components/app/SubmittedRecord";
import { JobDescriptionButton } from "./JobDescriptionButton";
import { ResumeButton } from "./ResumeButton";
import type { ReviewBundle } from "@/lib/review-summary";
import { prettyCompany } from "@/lib/company-name";
import { resumeById } from "@/lib/resume-store";
import { getCredentialsSyncSlice } from "@/app/app/credentials/actions";
import type { Application } from "../shared";
import { SAMPLE_APPS, SAMPLE_BUNDLE_BY_ID } from "../sample";

export const dynamic = "force-dynamic";

// persistable = the bundle came from a real DB row we can UPDATE (not a DEV_PREVIEW sample).
type Loaded = { app: Application; bundle: ReviewBundle | null; persistable: boolean; jobDescription: string | null; resumeName: string | null };

function sampleLookup(id: string): Loaded | null {
  const app = SAMPLE_APPS.find((a) => a.id === id);
  return app ? { app, bundle: SAMPLE_BUNDLE_BY_ID[id] ?? null, persistable: false, jobDescription: null, resumeName: null } : null;
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
      .select("id, company, role, url, status, needs_review_count, applied_at, created_at, review_bundle_json, job_description, login_email, login_tenant, login_host, login_created, login_verified, login_at")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) return DEV_PREVIEW ? sampleLookup(id) : null;
    const { review_bundle_json, job_description, ...app } = data as Application & {
      review_bundle_json: ReviewBundle | null;
      job_description: string | null;
    };
    // Which résumé went with this application — fetched SEPARATELY and allowed to fail. Showing the
    // résumé is an extra; approving the review is the reason this page exists. Folding resume_id into
    // the select above would mean that a database still missing the 0017 columns 404s the whole review
    // page, which is a far worse outcome than a missing button.
    // Just the NAME here — the signed URL is minted on click (it expires, so baking one into the page
    // would hand out a dead link on any tab left open).
    let resumeName: string | null = null;
    try {
      const { data: r } = await supabase.from("applications").select("resume_id").eq("id", id).eq("user_id", user.id).maybeSingle();
      if (r?.resume_id) resumeName = (await resumeById(supabase, user.id, r.resume_id))?.filename ?? null;
    } catch { /* feature not migrated yet — the page still works */ }
    return {
      app: app as Application,
      bundle: review_bundle_json ?? null,
      persistable: true,
      jobDescription: job_description ?? null,
      resumeName,
    };
  } catch {
    return DEV_PREVIEW ? sampleLookup(id) : null;
  }
}

/**
 * WHICH Workday account this application was filed with. Workday accounts are per-tenant, so when a
 * recruiter replies weeks later this is what tells you how to sign back in — and after a
 * create-account run it's the record that the account exists at all. Renders nothing when unknown
 * (an application filled before this shipped, or one where you signed in by hand) rather than
 * implying an account we can't vouch for. The password is deliberately not here: it lives once, on
 * the Sign-in & email page.
 */
function LoginLine({ app }: { app: Application }) {
  if (!app.login_email) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-dim">
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span>Signed in as</span>
      <span className="font-mono text-ink">{app.login_email}</span>
      {app.login_tenant && <span className="text-ink-faint">on {app.login_tenant}</span>}
      {app.login_created && (
        <span className="rounded border border-verified/30 bg-verified/[0.08] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-verified">
          account created
        </span>
      )}
      {app.login_verified && (
        <span className="rounded border border-hairline px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
          email verified
        </span>
      )}
      <Link href="/app/credentials" className="text-amber hover:underline">
        Sign-in details
      </Link>
    </p>
  );
}

export default async function ApplicationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadApp(id);
  if (!loaded) notFound();
  const { app, bundle, persistable, jobDescription, resumeName } = loaded;
  // A form whose account is created by the submission (iCIMS) has login/password FIELDS, and the
  // bundle deliberately carries only a placeholder for them — the secret must not sit on the
  // application row. So the review page reads the account's own stored credential here, server-side,
  // purely to DISPLAY it (login as text, password as dots). Only fetched when the bundle actually
  // contains such a field, so no other application pays for it or has it in its payload.
  const wantsCredentials = !!bundle?.entries?.some((e) => e.credential);
  const credentials = wantsCredentials ? (await getCredentialsSyncSlice().then((r) => (r.ok ? r.slice : null)).catch(() => null)) : null;

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
              {prettyCompany(app.company, app.url) || "Application"}
            </h1>
            {app.role && <p className="mt-1 text-sm text-ink-dim">{app.role}</p>}
            <LoginLine app={app} />
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <JobDescriptionButton text={jobDescription} />
            <ResumeButton applicationId={app.id} filename={resumeName} />
            {app.url && (
              <a href={app.url} target="_blank" rel="noreferrer" className="btn-ghost">
                Open posting
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </div>
        </div>
      </div>

      {/* The submit run's own record sits ABOVE the editor: once an application is filed, "what was
          actually submitted" is the question you come back for, not "what should I approve". */}
      <SubmittedRecord
        submission={(bundle as unknown as { submission?: SubmissionRecord })?.submission ?? null}
        reviewPage={(bundle as unknown as { workday_review_page?: WorkdayReviewPage })?.workday_review_page ?? null}
      />

      {bundle ? (
        <ReviewEditor appId={id} initialBundle={bundle} canPersist={persistable} credentials={credentials} />
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
