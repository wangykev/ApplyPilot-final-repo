"use client";

import Link from "next/link";
import { ExternalLink, ArrowRight } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { prettyCompany } from "@/lib/company-name";
import type { Application } from "../tracker/shared";

/**
 * THE SUBMIT QUEUE — applications that are filled AND approved but not yet sent.
 *
 * Deliberately NOT a new table. That state already exists on `applications` (`approved_at` set while
 * the status is still `needs_review`); giving it its own rows would mean two places that can disagree
 * about whether a thing is ready. This panel is a VIEW of the tracker, ordered by the one thing that
 * matters when you sit down to send them: which you approved first.
 *
 * It is also read-only on purpose. Submitting runs in the EXTENSION (it needs the browser, the login
 * and the debugger), so this page's job is to tell you WHAT is ready and let you jump to it — not to
 * offer a button that cannot do what it says.
 */
function host(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function approvedAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!isFinite(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function SubmitQueuePanel({ apps }: { apps: Application[] }) {
  return (
    <div className="space-y-6">
      <SectionCard
        title="Ready to submit"
        subtitle={
          apps.length
            ? `${apps.length} application${apps.length === 1 ? "" : "s"} approved and waiting to be sent`
            : "Nothing approved yet"
        }
      >
        {apps.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-ink-faint">Nothing is waiting to be submitted.</p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-faint">
              Fill an application, approve its flagged fields on the{" "}
              <Link href="/app/tracker" className="text-amber hover:underline">
                Tracker
              </Link>
              , and it lines up here — oldest approval first.
            </p>
          </div>
        ) : (
          <>
            <ol className="space-y-2">
              {apps.map((a, i) => (
                <li
                  key={a.id}
                  className="flex items-center gap-3 rounded-lg border border-verified/25 bg-verified/[0.04] px-3 py-2.5"
                >
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-faint">{i + 1}</span>
                  <span className="shrink-0 rounded border border-verified/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-label text-verified">
                    ✓ approved
                  </span>
                  <Link href={`/app/tracker/${a.id}`} className="min-w-0 flex-1 group">
                    <div className="truncate text-sm text-ink group-hover:text-amber">
                      {prettyCompany(a.company, a.url) || host(a.url)}
                    </div>
                    <div className="truncate font-mono text-[11px] text-ink-faint">
                      {a.role || host(a.url)}
                    </div>
                  </Link>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                    {approvedAgo(a.approved_at)}
                  </span>
                  <Link
                    href={`/app/tracker/${a.id}`}
                    className="shrink-0 inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-label text-ink-dim transition-colors hover:text-ink"
                  >
                    Review
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                  {a.url && (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-ink-faint hover:text-ink"
                      aria-label="Open posting"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </li>
              ))}
            </ol>
            {/* Say WHERE the button is. Nothing on this page can submit — the run needs the browser,
                the login and the debugger — and a queue that looks actionable but isn't is worse than
                one that explains itself. */}
            <p className="mt-4 border-t border-hairline pt-3 text-xs leading-relaxed text-ink-faint">
              Submitting runs in the extension: open the posting, then use{" "}
              <span className="font-mono text-ink-dim">Replay + SUBMIT</span> — it pulls exactly the
              values you approved. The real submit stays behind the eyes-on, disposable-app gate.
            </p>
          </>
        )}
      </SectionCard>
    </div>
  );
}
