"use client";

import { useState, useTransition } from "react";
import {
  Target,
  Loader2,
  ExternalLink,
  Plus,
  Check,
  ChevronDown,
  Ban,
  AlertTriangle,
  ScanText,
} from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { clsx } from "@/lib/clsx";
import { runMatchRun, addMatchToQueue } from "./actions";
import type { MatchRow, MatchRunResult } from "./shared";

const TIER: Record<MatchRow["tier"], { bar: string; text: string }> = {
  strong: { bar: "bg-verified", text: "text-verified" },
  solid: { bar: "bg-amber", text: "text-amber" },
  stretch: { bar: "bg-ink-faint", text: "text-ink-dim" },
};

function Chip({ tone, children }: { tone: "auto" | "manual" | "jd" | "title" | "no" | "maybe" | "fresh"; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    auto: "border-amber/40 text-amber",
    manual: "border-hairline text-ink-faint",
    jd: "border-verified/40 text-verified",
    title: "border-hairline text-ink-faint border-dashed",
    no: "border-signal/50 text-signal",
    maybe: "border-amber/50 text-amber",
    fresh: "border-verified/40 text-verified",
  };
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label", cls[tone])}>
      {children}
    </span>
  );
}

function MatchBar({ score, tier }: { score: number; tier: MatchRow["tier"] }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-cockpit">
        <span className={clsx("block h-full rounded-full", TIER[tier].bar)} style={{ width: `${score}%` }} />
      </div>
      <span className={clsx("w-6 text-right font-mono text-sm font-semibold tabular-nums", TIER[tier].text)}>{score}</span>
    </div>
  );
}

export function MatchesPanel() {
  const [result, setResult] = useState<MatchRunResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [onlyAuto, setOnlyAuto] = useState(false);
  const [hideInelig, setHideInelig] = useState(false);
  const [openJd, setOpenJd] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState<Record<string, "pending" | "ok" | "err">>({});

  const run = () =>
    startTransition(async () => {
      setQueued({});
      setResult(await runMatchRun());
    });

  const addOne = async (url: string) => {
    setQueued((q) => ({ ...q, [url]: "pending" }));
    try {
      const r = await addMatchToQueue(url);
      setQueued((q) => ({ ...q, [url]: r.ok ? "ok" : "err" }));
    } catch {
      setQueued((q) => ({ ...q, [url]: "err" }));
    }
  };

  const toggleJd = (url: string) =>
    setOpenJd((s) => {
      const n = new Set(s);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });

  const rows = (result?.rows ?? []).filter((r) => {
    if (onlyAuto && !r.autoApply) return false;
    if (hideInelig && r.eligibility === "no") return false;
    return true;
  });
  const autoCount = result?.rows.filter((r) => r.autoApply).length ?? 0;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Match run"
        subtitle="Pulls the latest postings from SimplifyJobs, opens each Workday & Greenhouse link to read the full job description, and scores it against your profile. SPA/company sites (Ashby, Tesla…) can't be read server-side — those are marked to read in-browser via the extension."
      >
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={run} disabled={pending} className="btn-primary">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
            {pending ? "Reading job descriptions…" : result ? "Re-run match" : "Run match"}
          </button>
          {result?.profileSummary && (
            <span className="font-mono text-[11px] text-ink-dim">
              scoring vs {result.profileSummary.field}
              {result.profileSummary.gradYear ? ` · grad ${result.profileSummary.gradYear}` : ""} ·{" "}
              {result.profileSummary.skills} skills
            </span>
          )}
        </div>

        {pending && (
          <p className="mt-4 text-xs leading-relaxed text-ink-dim">
            Fetching the listing and reading full descriptions from each tenant&apos;s Workday CxS API and
            Greenhouse. This takes a few seconds.
          </p>
        )}

        {result?.ok === false && (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-signal/30 bg-signal/[0.05] px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
            <p className="text-ink-dim">{result.error}</p>
          </div>
        )}

        {result?.ok && (
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline pt-4">
            <Stat k={result.total} l="postings scored" />
            <Stat k={result.jdReadCount} l="full JDs read" />
            <Stat k={autoCount} l="auto-applyable" />
            <div className="ml-auto flex flex-wrap items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-dim">
                <input type="checkbox" checked={onlyAuto} onChange={(e) => setOnlyAuto(e.target.checked)} className="h-3.5 w-3.5 accent-amber" />
                Auto-applyable only
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-dim">
                <input type="checkbox" checked={hideInelig} onChange={(e) => setHideInelig(e.target.checked)} className="h-3.5 w-3.5 accent-amber" />
                Hide ineligible
              </label>
            </div>
          </div>
        )}
      </SectionCard>

      {!result && !pending && (
        <p className="py-10 text-center text-sm text-ink-faint">
          Run a match to pull the latest internships and score them against your profile.
        </p>
      )}

      {result?.ok && (
        <div className="space-y-2.5">
          {rows.map((r) => (
            <Row
              key={r.url}
              r={r}
              open={openJd.has(r.url)}
              onToggleJd={() => toggleJd(r.url)}
              queued={queued[r.url]}
              onAdd={() => addOne(r.url)}
            />
          ))}
          {rows.length === 0 && <p className="py-8 text-center text-sm text-ink-faint">No postings match that filter.</p>}
        </div>
      )}
    </div>
  );
}

function Stat({ k, l }: { k: number; l: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-mono text-lg font-semibold tabular-nums text-ink">{k}</span>
      <span className="text-xs text-ink-dim">{l}</span>
    </div>
  );
}

function Row({
  r,
  open,
  onToggleJd,
  queued,
  onAdd,
}: {
  r: MatchRow;
  open: boolean;
  onToggleJd: () => void;
  queued?: "pending" | "ok" | "err";
  onAdd: () => void;
}) {
  const inelig = r.eligibility === "no";
  const canQueue = r.autoApply && !inelig;
  return (
    <div className={clsx("bezel p-4", inelig && "opacity-65")}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="shrink-0 pt-0.5">
          <MatchBar score={r.score} tier={r.tier} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] font-semibold uppercase tracking-label text-amber">{r.company}</div>
          <div className="text-sm font-medium text-ink">{r.role}</div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {r.autoApply ? (
              <Chip tone="auto">⚡ Auto-apply · Workday</Chip>
            ) : (
              <Chip tone="manual">Manual · {r.atsLabel}</Chip>
            )}
            {r.eligibility === "no" && (
              <Chip tone="no">
                <Ban className="h-2.5 w-2.5" /> Ineligible
              </Chip>
            )}
            {r.eligibility === "maybe" && <Chip tone="maybe">Check eligibility</Chip>}
            {r.jdRead ? (
              <Chip tone="jd">
                <ScanText className="h-2.5 w-2.5" /> JD read
              </Chip>
            ) : (
              <Chip tone="title">title-level</Chip>
            )}
            {r.ageDays <= 2 && <Chip tone="fresh">{r.ageLabel} · new</Chip>}
            <span className="font-mono text-[10px] text-ink-faint">📍 {r.location}</span>
            {r.ageDays > 2 && <span className="font-mono text-[10px] text-ink-faint">{r.ageLabel} ago</span>}
          </div>

          {r.reasons.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {r.reasons.map((reason, i) => (
                <li key={i} className="text-xs leading-relaxed text-ink-dim">
                  {reason}
                </li>
              ))}
            </ul>
          )}

          {r.needsBrowser && !r.jdRead && (
            <p className="mt-1.5 text-[11px] text-ink-faint">
              JD is behind a client-rendered / bot-walled page — read it in-browser with the extension&apos;s Run.
            </p>
          )}

          {r.jdRead && r.jdExcerpt && (
            <div className="mt-2">
              <button
                type="button"
                onClick={onToggleJd}
                className="inline-flex items-center gap-1.5 text-[11px] text-ink-dim hover:text-ink"
              >
                <ChevronDown className={clsx("h-3 w-3 transition-transform", open && "rotate-180")} />
                {open ? "Hide" : "Show"} the job description I read
              </button>
              {open && (
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-cockpit p-3 text-[11px] leading-relaxed text-ink-dim">
                  {r.jdExcerpt}
                  {r.jdExcerpt.length >= 1200 ? "\n…" : ""}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-xs text-ink transition-colors hover:border-amber hover:text-amber"
          >
            Open <ExternalLink className="h-3.5 w-3.5" />
          </a>
          {canQueue &&
            (queued === "ok" ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-verified">
                <Check className="h-3.5 w-3.5" /> Queued
              </span>
            ) : (
              <button
                onClick={onAdd}
                disabled={queued === "pending"}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber/50 px-3 py-1.5 text-xs text-amber transition-colors hover:bg-amber/[0.08] disabled:opacity-50"
              >
                {queued === "pending" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {queued === "err" ? "Retry" : "Queue"}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
