import { CheckCircle2, FileCheck2, AlertTriangle, Clock } from "lucide-react";

/**
 * The record of a SUBMIT run — what was filed, and the proof.
 *
 * This exists because a submitted application used to leave no durable trace anywhere: the tracker row
 * still read "needs_review" after a real submission, and Workday's own review page — the only
 * authoritative statement of what was actually on the application — died with the tab that closed
 * behind the run. Our review bundle says what we INTENDED to file; this says what Workday DISPLAYED
 * back, immediately before the click.
 *
 * A rehearsal writes the same block minus the submission (`armed: false`), so the review page can be
 * inspected without filing anything.
 */

export type WorkdayReviewPage = {
  captured_at?: string | null;
  url?: string | null;
  items?: { label: string | null; value: string | null; section?: string | null }[];
  truncated?: boolean;
  total_items?: number;
};

export type SubmissionRecord = {
  at?: string | null;
  armed?: boolean;
  submitted?: boolean;
  confirmed?: boolean;
  would_submit?: boolean;
  stopped?: string | null;
  blockers?: string[];
  login?: { email?: string | null } | null;
  confirmation?: { url?: string | null; title?: string | null; heading?: string | null; text?: string | null } | null;
};

function when(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function SubmittedRecord({
  submission,
  reviewPage,
}: {
  submission?: SubmissionRecord | null;
  reviewPage?: WorkdayReviewPage | null;
}) {
  if (!submission && !reviewPage) return null;

  const submitted = !!submission?.submitted;
  const rehearsal = !!submission && !submission.armed;
  const blockers = submission?.blockers ?? [];

  return (
    <section className="bezel overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-6 py-4">
        <div className="flex items-center gap-2.5">
          {submitted ? (
            <CheckCircle2 className="h-4 w-4 text-verified" />
          ) : blockers.length ? (
            <AlertTriangle className="h-4 w-4 text-amber" />
          ) : (
            <Clock className="h-4 w-4 text-ink-faint" />
          )}
          <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">
            {submitted ? "Submitted to Workday" : rehearsal ? "Rehearsal — nothing was submitted" : "Submit run"}
          </span>
        </div>
        <span className="font-mono text-[11px] text-ink-faint">{when(submission?.at)}</span>
      </header>

      <div className="space-y-5 px-6 py-5">
        {submitted && (
          <p className="text-sm text-ink-dim">
            Filed{submission?.login?.email ? <> as <span className="font-mono text-ink">{submission.login.email}</span></> : null}
            {submission?.confirmed ? " — Workday advanced to a confirmation page." : " — the click fired, but no confirmation page was seen; verify with the employer."}
          </p>
        )}

        {!submitted && rehearsal && (
          <p className="text-sm text-ink-dim">
            Every gate passed and the run stopped at{" "}
            <span className="font-mono text-ink">would-submit</span>. Nothing was filed.
          </p>
        )}

        {blockers.length > 0 && (
          <div className="rounded border border-amber/40 bg-amber/5 p-3">
            <div className="font-mono text-[11px] uppercase tracking-label text-amber">Blocked before submitting</div>
            <ul className="mt-2 space-y-1 text-xs text-ink-dim">
              {blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        {submission?.confirmation && (
          <div>
            <div className="font-mono text-[11px] uppercase tracking-label text-ink-dim">Confirmation page</div>
            <div className="mt-2 rounded border border-hairline bg-panel-raised/40 p-3">
              {submission.confirmation.title && (
                <p className="text-sm text-ink">{submission.confirmation.title}</p>
              )}
              {submission.confirmation.heading && (
                <p className="mt-1 text-sm text-ink-dim">{submission.confirmation.heading}</p>
              )}
              {submission.confirmation.text && (
                <p className="mt-2 max-h-40 overflow-y-auto text-xs leading-relaxed text-ink-faint">
                  {submission.confirmation.text}
                </p>
              )}
              {submission.confirmation.url && (
                <p className="mt-2 break-all font-mono text-[10px] text-ink-faint">{submission.confirmation.url}</p>
              )}
            </div>
          </div>
        )}

        {reviewPage?.items && reviewPage.items.length > 0 && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileCheck2 className="h-3.5 w-3.5 text-ink-faint" />
                <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">
                  Workday&apos;s review page, as displayed
                </span>
              </div>
              <span className="font-mono text-[10px] text-ink-faint">
                {reviewPage.total_items ?? reviewPage.items.length} row(s)
                {reviewPage.truncated ? ` · showing first ${reviewPage.items.length}` : ""}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-ink-faint">
              Read from the application itself immediately before the submit decision — what Workday
              showed, not what we intended to send.
            </p>
            <div className="mt-3 max-h-96 overflow-y-auto rounded border border-hairline">
              <table className="w-full text-sm">
                <tbody>
                  {reviewPage.items.map((it, i) => (
                    <tr key={i} className="border-b border-hairline/60 last:border-0">
                      <td className="w-1/2 px-3 py-2 align-top text-ink-dim">{it.label || "—"}</td>
                      <td className="px-3 py-2 align-top text-ink">{it.value || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
