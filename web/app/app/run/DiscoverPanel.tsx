"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Radar, Loader2, Check, AlertTriangle, ExternalLink, FileText, Clock, MapPin, Cable,
} from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { sendToExtension, extensionMessagingAvailable, openRunProgressPort, type RunProgress } from "@/lib/extension";
import { linkedExtensionId } from "@/lib/extension-sync";
import {
  DISCOVER_DEFAULTS, DISCOVER_SOURCE_LABEL, DISCOVER_SOURCE_HINT, describeSweep,
  type DiscoveredJob, type DiscoverStats, type DiscoverSourceKey,
} from "@/lib/discover";
import { getDiscoveryContext, saveDiscovered } from "./actions";
import { clsx } from "@/lib/clsx";

const SOURCES: DiscoverSourceKey[] = ["simplify", "linkedin", "handshake"];

const SOURCE_BADGE: Record<string, string> = {
  simplify: "border-verified/40 text-verified",
  linkedin: "border-amber/40 text-amber",
  handshake: "border-ink-dim/40 text-ink-dim",
};

type Phase =
  | { s: "idle" }
  | { s: "running" }
  | { s: "done"; jobs: DiscoveredJob[]; stats: DiscoverStats | null; notes: string[]; added: number; saveError: string | null };

/** "3 days ago" / "just now" — postedAt is epoch ms, null when the board gave no date. */
function agoLabel(postedAt: number | null): string {
  if (postedAt == null) return "date unknown";
  const mins = Math.round((Date.now() - postedAt) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function DiscoverPanel() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [enabled, setEnabled] = useState<Record<DiscoverSourceKey, boolean>>({
    simplify: true, linkedin: true, handshake: true,
  });
  const [query, setQuery] = useState("");
  const [sinceDays, setSinceDays] = useState(DISCOVER_DEFAULTS.sinceDays);
  const [maxJdOpens, setMaxJdOpens] = useState(DISCOVER_DEFAULTS.maxJdOpens);
  const portRef = useRef<{ disconnect: () => void } | null>(null);

  useEffect(() => {
    setConnected(linkedExtensionId() !== null && extensionMessagingAvailable());
  }, []);
  useEffect(() => () => portRef.current?.disconnect(), []);

  const running = phase.s === "running";
  const anySource = SOURCES.some((s) => enabled[s]);

  async function discover() {
    if (running || !anySource) return;
    const extId = linkedExtensionId();
    if (!extId || !extensionMessagingAvailable()) {
      setConnected(false);
      return;
    }
    setPhase({ s: "running" });
    setProgress({ phase: "Starting the sweep…", detail: "", at: 0 });

    // Everything already applied to or queued, so the extension can skip those jobs
    // BEFORE spending a tab open on their description. A backend hiccup here is
    // non-fatal: the sweep still runs, and saveDiscovered dedupes authoritatively.
    let knownKeys: string[] = [];
    const ctx = await getDiscoveryContext();
    if (ctx.ok) knownKeys = ctx.knownKeys;

    portRef.current = openRunProgressPort(extId, (p) => setProgress(p));

    const resp = await sendToExtension(extId, {
      type: "AP_DISCOVER_JOBS",
      sources: enabled,
      knownKeys,
      query: query.trim(),
      sinceDays,
      maxJdOpens,
      background: true, // sweep tabs open unfocused — you stay on this page
    });

    portRef.current?.disconnect();
    portRef.current = null;
    setProgress(null);

    if (resp.ok === false) {
      setPhase({
        s: "done",
        jobs: [],
        stats: null,
        notes: [String(resp.detail || resp.error || "The sweep couldn't run.")],
        added: 0,
        saveError: null,
      });
      return;
    }

    const jobs = (resp.jobs as DiscoveredJob[]) ?? [];
    const stats = (resp.stats as DiscoverStats) ?? null;
    const notes = (resp.notes as string[]) ?? [];

    // Add them to the queue — that IS the point of the sweep, so it happens without
    // a second click. The queue page is where you cull.
    let added = 0;
    let saveError: string | null = null;
    if (jobs.length) {
      const saved = await saveDiscovered(jobs);
      if (saved.ok) added = saved.added;
      else saveError = saved.error;
    }
    setPhase({ s: "done", jobs, stats, notes, added, saveError });
  }

  return (
    <SectionCard
      title="Discover new jobs"
      subtitle="Sweeps the Simplify 2026 internship board plus your signed-in LinkedIn and Handshake job searches for recent postings you haven't applied to, reads each job description, and adds them to your queue. It only reads — nothing is applied to."
    >
      {connected === false && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber/30 bg-amber/[0.05] px-4 py-3 text-sm">
          <Cable className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <div>
            <p className="text-ink">Your extension isn&apos;t connected here.</p>
            <p className="mt-1 text-ink-dim">
              Discovery runs in your browser so it can use your LinkedIn and Handshake sessions —{" "}
              <Link href="/app/connect" className="text-amber hover:underline">connect the extension</Link> first.
            </p>
          </div>
        </div>
      )}

      <fieldset disabled={running} className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {SOURCES.map((s) => (
            <label
              key={s}
              className={clsx(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                enabled[s] ? "border-amber/40 bg-amber/[0.04]" : "border-hairline bg-cockpit hover:border-ink-faint"
              )}
            >
              <input
                type="checkbox"
                checked={enabled[s]}
                onChange={(e) => setEnabled((v) => ({ ...v, [s]: e.target.checked }))}
                className="mt-0.5 accent-amber"
              />
              <span className="min-w-0">
                <span className="block text-sm text-ink">{DISCOVER_SOURCE_LABEL[s]}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">{DISCOVER_SOURCE_HINT[s]}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-label text-ink-faint">
              Keyword filter (optional)
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="software engineer intern"
              className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
            />
          </label>
          <label className="shrink-0">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-label text-ink-faint">
              Posted within
            </span>
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={60}
                value={sinceDays}
                onChange={(e) => setSinceDays(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                className="w-20 rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-amber"
              />
              <span className="text-xs text-ink-dim">days</span>
            </span>
          </label>
          <label className="shrink-0">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-label text-ink-faint">
              Read up to
            </span>
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={40}
                value={maxJdOpens}
                onChange={(e) => setMaxJdOpens(Math.max(0, Math.min(40, Number(e.target.value) || 0)))}
                className="w-20 rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-amber"
                title="Each job description means opening the posting in a background tab and closing it. Keep this modest."
              />
              <span className="text-xs text-ink-dim">descriptions</span>
            </span>
          </label>
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={discover} disabled={running || !anySource || connected === false} className="btn-primary">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
          {running ? "Discovering…" : "Discover jobs"}
        </button>
        {!anySource && <span className="text-xs text-ink-faint">Pick at least one source.</span>}
      </div>

      {running && (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-hairline bg-cockpit px-3.5 py-3">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{progress?.phase || "Starting the sweep…"}</p>
            {progress?.detail && <p className="mt-0.5 truncate text-xs text-ink-dim">{progress.detail}</p>}
            <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
              Board pages and each posting open in unfocused tabs and close again — stay here. Nothing is applied to.
            </p>
          </div>
        </div>
      )}

      {phase.s === "done" && <DiscoverResult phase={phase} />}
    </SectionCard>
  );
}

function DiscoverResult({ phase }: { phase: Extract<Phase, { s: "done" }> }) {
  const { jobs, stats, notes, added, saveError } = phase;
  const found = jobs.length;
  const tone =
    saveError ? { border: "border-signal/30", bg: "bg-signal/[0.05]", fg: "text-signal", Icon: AlertTriangle }
    : found ? { border: "border-verified/30", bg: "bg-verified/[0.05]", fg: "text-verified", Icon: Check }
    : { border: "border-hairline", bg: "bg-cockpit", fg: "text-ink-dim", Icon: Check };

  const headline = saveError
    ? "Found jobs, but couldn't save them"
    : found === 0
      ? "No new jobs this time"
      : `${added} job${added === 1 ? "" : "s"} added to your queue`;

  const detail = saveError
    ? saveError
    : found === 0
      ? "Everything the sources returned is already in your tracker or queue, or nothing new was posted in the window."
      : added < found
        ? `${found} found; ${found - added} were already queued.`
        : describeSweep(stats);

  return (
    <div className="mt-5 space-y-4">
      <div className={clsx("flex items-start gap-3 rounded-lg border px-4 py-3", tone.border, tone.bg)}>
        <tone.Icon className={clsx("mt-0.5 h-5 w-5 shrink-0", tone.fg)} />
        <div className="min-w-0">
          <p className={clsx("text-sm font-medium", tone.fg)}>{headline}</p>
          {detail && <p className="mt-1 text-sm leading-relaxed text-ink-dim">{detail}</p>}
          {stats && !saveError && found > 0 && (
            <p className="mt-1 font-mono text-[11px] text-ink-faint">{describeSweep(stats)}</p>
          )}
        </div>
      </div>

      {notes.length > 0 && (
        <ul className="space-y-1.5">
          {notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-amber">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      {found > 0 && (
        <>
          <ol className="space-y-2">
            {jobs.map((j) => (
              <li
                key={j.jobKey || j.url}
                className="flex items-start gap-3 rounded-lg border border-hairline bg-panel-raised/40 px-3 py-2.5"
              >
                <span
                  className={clsx(
                    "mt-0.5 shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label",
                    SOURCE_BADGE[j.source] || "border-ink-faint/40 text-ink-faint"
                  )}
                >
                  {j.source}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">
                    {j.company ? <span className="text-ink">{j.company}</span> : null}
                    {j.company && j.title ? <span className="text-ink-faint"> · </span> : null}
                    {j.title}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-faint">
                    {j.location && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {j.location}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {agoLabel(j.postedAt)}
                    </span>
                    <span
                      className={clsx("inline-flex items-center gap-1", j.description ? "text-verified" : "text-amber")}
                      title={j.description ? `Scraped from the posting (${j.descriptionSource})` : "Queued without a description"}
                    >
                      <FileText className="h-3 w-3" />
                      {j.description ? `${j.description.length.toLocaleString()} char JD` : "no JD"}
                    </span>
                  </div>
                </div>
                <a
                  href={j.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 shrink-0 text-ink-faint hover:text-ink"
                  aria-label="Open the posting"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </li>
            ))}
          </ol>

          <Link href="/app/queue" className="btn-primary">
            <ExternalLink className="h-4 w-4" />
            Open the queue
          </Link>
        </>
      )}
    </div>
  );
}
