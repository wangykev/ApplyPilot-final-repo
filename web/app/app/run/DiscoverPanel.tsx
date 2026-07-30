"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Radar, Loader2, Check, AlertTriangle, ExternalLink, FileText, Clock, MapPin, Cable, Users,
} from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { sendToExtension, extensionMessagingAvailable, openRunProgressPort, type RunProgress } from "@/lib/extension";
import { linkedExtensionId } from "@/lib/extension-sync";
import {
  DISCOVER_DEFAULTS, DISCOVER_SOURCE_LABEL, DISCOVER_SOURCE_HINT, describeSweep,
  DISCOVER_CYCLES, DISCOVER_DEFAULT_LOCATION, buildDiscoverQuery, discoverTermLabel, isBoardUrl,
  type DiscoveredJob, type DiscoverStats, type DiscoverSourceKey, type DiscoverSearch,
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
  | {
      s: "done";
      jobs: DiscoveredJob[];
      stats: DiscoverStats | null;
      notes: string[];
      added: number;
      saveError: string | null;
      search: DiscoverSearch | null;
    };

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

/** Next calendar year — the sensible default season to be hunting right now. */
function defaultYear(): string {
  return String(new Date().getFullYear() + 1);
}

/**
 * Sticky sweep settings. Deliberately localStorage and NOT a DB column: these are
 * per-browser UI preferences, the operator already has pending migrations, and the
 * extension-id storage next door establishes the pattern. Nothing here is secret.
 */
const PREFS_KEY = "applypilot.discover.prefs";
type Prefs = {
  enabled?: Record<DiscoverSourceKey, boolean>;
  query?: string; cycle?: string; year?: string; intern?: boolean; location?: string;
  sinceDays?: number; maxRecords?: number; maxPages?: number; queueLimit?: number;
  skipEasyApply?: boolean;
  background?: boolean;
};
function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p === "object" ? (p as Prefs) : {};
  } catch { return {}; }
}

export function DiscoverPanel({ fieldOfStudy = "", homeCountry = "" }: { fieldOfStudy?: string; homeCountry?: string }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [enabled, setEnabled] = useState<Record<DiscoverSourceKey, boolean>>({
    simplify: true, linkedin: true, handshake: true,
  });
  const [query, setQuery] = useState("");
  const [cycle, setCycle] = useState<string>("summer");
  const [year, setYear] = useState<string>(defaultYear());
  const [intern, setIntern] = useState(true);
  // Seeded from the PROFILE's country, never a hardcoded "United States" — the
  // operator's own answer to "where do you live" is the only sensible default, and
  // baking one in would silently search the wrong country for anyone else.
  const [location, setLocation] = useState(homeCountry);
  const [sinceDays, setSinceDays] = useState(DISCOVER_DEFAULTS.sinceDays);
  const [maxRecords, setMaxRecords] = useState(DISCOVER_DEFAULTS.maxRecords);
  const [maxPages, setMaxPages] = useState(DISCOVER_DEFAULTS.maxPages);
  const [queueLimit, setQueueLimit] = useState(DISCOVER_DEFAULTS.queueLimit);
  const [queueAll, setQueueAll] = useState(false);
  const [skipEasyApply, setSkipEasyApply] = useState(DISCOVER_DEFAULTS.skipEasyApply);
  // Sweep tabs open unfocused by default so you can keep working. Turning this off
  // makes them the active tab, which is the right first move when a board's UI isn't
  // behaving — some controls only respond in a focused tab.
  const [background, setBackground] = useState(true);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const portRef = useRef<{ disconnect: () => void } | null>(null);

  // The EXACT search that will run, computed with the same pure function the
  // extension uses. Shown below the controls so a blank/odd query can never again
  // be invisible — that's what let an empty box quietly scrape LinkedIn's
  // recommended feed instead of searching.
  const preview = buildDiscoverQuery({ query, field: fieldOfStudy, intern });
  const term = discoverTermLabel(cycle, year);
  const locationLabel = location.trim() || homeCountry || DISCOVER_DEFAULT_LOCATION;
  const noKeywords = !preview.keywords;

  useEffect(() => {
    setConnected(linkedExtensionId() !== null && extensionMessagingAvailable());
  }, []);
  useEffect(() => () => portRef.current?.disconnect(), []);

  // Hydrate the saved knobs once, then persist on every change. A saved location
  // wins over the profile seed (it's a deliberate choice); everything else falls
  // back to the shared defaults.
  useEffect(() => {
    const p = loadPrefs();
    if (p.enabled) setEnabled((v) => ({ ...v, ...p.enabled }));
    if (typeof p.query === "string") setQuery(p.query);
    if (typeof p.cycle === "string") setCycle(p.cycle);
    if (typeof p.year === "string") setYear(p.year);
    if (typeof p.intern === "boolean") setIntern(p.intern);
    if (typeof p.location === "string" && p.location) setLocation(p.location);
    if (typeof p.sinceDays === "number") setSinceDays(p.sinceDays);
    if (typeof p.maxRecords === "number") setMaxRecords(p.maxRecords);
    if (typeof p.maxPages === "number") setMaxPages(p.maxPages);
    if (typeof p.queueLimit === "number") { setQueueLimit(p.queueLimit || DISCOVER_DEFAULTS.queueLimit); setQueueAll(p.queueLimit === 0); }
    if (typeof p.skipEasyApply === "boolean") setSkipEasyApply(p.skipEasyApply);
    if (typeof p.background === "boolean") setBackground(p.background);
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return; // don't write the pre-hydration defaults back over saved ones
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({
        enabled, query, cycle, year, intern, location, sinceDays, maxRecords, maxPages,
        queueLimit: queueAll ? 0 : queueLimit, skipEasyApply, background,
      } satisfies Prefs));
    } catch { /* a private-mode browser just won't remember them */ }
  }, [prefsLoaded, enabled, query, cycle, year, intern, location, sinceDays, maxRecords, maxPages, queueLimit, queueAll, skipEasyApply, background]);

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
      // `field` is what a BLANK keyword box derives from, so the search is still
      // specific instead of landing on a board's recommended feed.
      field: fieldOfStudy,
      intern,
      cycle,
      year: year.trim(),
      // Free text — each board resolves it through its OWN location typeahead
      // (neither board's location token can be constructed) and the result is
      // cached, so a given place costs one resolve on its first use only.
      location: location.trim() || homeCountry,
      sinceDays,
      maxRecords,
      // Scrape wide, queue narrow.
      maxPages,
      queueLimit: queueAll ? 0 : queueLimit,
      skipEasyApply,
      background, // unfocused by default; off = watch it happen in the active tab
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
        search: null,
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
    setPhase({ s: "done", jobs, stats, notes, added, saveError, search: (resp.search as DiscoverSearch) ?? null });
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
              What to search for
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={fieldOfStudy ? `blank = ${fieldOfStudy}` : "electrical and computer engineering"}
              className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
            />
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-label text-ink-faint">
              Location
            </span>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={homeCountry ? `blank = ${homeCountry} (from your profile)` : "city, state, or country"}
              title="Any city, state, or country. Each board resolves it through its own location box the first time you use it, then remembers it."
              className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
            />
          </label>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="shrink-0">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-label text-ink-faint">
              Season
            </span>
            <select
              value={cycle}
              onChange={(e) => setCycle(e.target.value)}
              className="rounded-lg border border-hairline bg-cockpit px-3 py-2.5 text-sm text-ink outline-none focus:border-amber"
            >
              <option value="">Any</option>
              {DISCOVER_CYCLES.map((c) => (
                <option key={c} value={c}>
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="shrink-0">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-label text-ink-faint">
              Year
            </span>
            <input
              value={year}
              onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
              inputMode="numeric"
              placeholder="2026"
              className="w-24 rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-amber"
            />
          </label>
          <label
            className={clsx(
              "flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors",
              intern ? "border-amber/40 bg-amber/[0.04]" : "border-hairline bg-cockpit hover:border-ink-faint"
            )}
          >
            <input type="checkbox" checked={intern} onChange={(e) => setIntern(e.target.checked)} className="accent-amber" />
            <span
              className="text-sm text-ink"
              title="Adds 'intern' to the keywords AND switches each board's own internship filter on (LinkedIn experience level, Handshake job type). On a live test that took 127 results down to 25 — all genuine internships and co-ops."
            >
              Internships
            </span>
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
                max={50}
                value={maxRecords}
                onChange={(e) => setMaxRecords(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
                className="w-20 rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-amber"
                title="Read straight from each board's own job record — no tab is opened and nothing is clicked. This is also what resolves the employer's real application link."
              />
              <span className="text-xs text-ink-dim">job records</span>
            </span>
          </label>
        </div>

        {/* Scrape wide, queue narrow. The sweep looks at several pages, ranks
            everything it finds, and queues only the best — so a daily run doesn't
            dump 60 half-relevant rows into the queue. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="shrink-0">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-label text-ink-faint">
              Queue the best
            </span>
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={60}
                value={queueLimit}
                disabled={queueAll}
                onChange={(e) => setQueueLimit(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                className="w-20 rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-amber disabled:opacity-40"
                title="Everything found is ranked on how well it matches your keywords and profile, how fresh it is, how few people have applied, and whether Run can actually drive it. Only this many are queued — the rest are reported, never silently dropped."
              />
              <span className="text-xs text-ink-dim">jobs</span>
            </span>
          </label>
          <label
            className={clsx(
              "flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors",
              queueAll ? "border-amber/40 bg-amber/[0.04]" : "border-hairline bg-cockpit hover:border-ink-faint"
            )}
          >
            <input type="checkbox" checked={queueAll} onChange={(e) => setQueueAll(e.target.checked)} className="accent-amber" />
            <span className="text-sm text-ink">Queue all</span>
          </label>
          <label className="shrink-0">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-label text-ink-faint">
              Scan up to
            </span>
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={10}
                value={maxPages}
                onChange={(e) => setMaxPages(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                className="w-20 rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-amber"
                title="Result pages per board, 25 jobs each. More pages = a bigger pool to rank from, and it's how tomorrow's sweep reaches past what you've already queued."
              />
              <span className="text-xs text-ink-dim">pages / board</span>
            </span>
          </label>
          <label
            className={clsx(
              "flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
              skipEasyApply ? "border-amber/40 bg-amber/[0.04]" : "border-hairline bg-cockpit hover:border-ink-faint"
            )}
          >
            <input
              type="checkbox"
              checked={skipEasyApply}
              onChange={(e) => setSkipEasyApply(e.target.checked)}
              className="mt-0.5 accent-amber"
            />
            <span className="min-w-0">
              <span className="block text-sm text-ink">Skip board-only applications</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                LinkedIn Easy Apply / Handshake Quick apply have no employer link, so Run can&apos;t drive them.
                Applying to these automatically is planned — until then, untick to queue them for manual apply.
              </span>
            </span>
          </label>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
          <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} className="accent-amber" />
          Sweep in the background (unfocused tabs — you stay on this page)
        </label>

        {/* The exact search that will run. This exists because a blank keyword box
            silently landed on LinkedIn's recommended feed — now you can always see
            what's actually being searched before you press the button. */}
        <div
          className={clsx(
            "rounded-lg border px-3.5 py-3 text-xs leading-relaxed",
            noKeywords ? "border-signal/40 bg-signal/[0.05]" : "border-hairline bg-cockpit"
          )}
        >
          {noKeywords ? (
            <p className="text-signal">
              No keywords to search. Type something above, tick Internships, or set your field of study on the{" "}
              <Link href="/app/profile" className="underline">
                Profile page
              </Link>
              . LinkedIn and Handshake will be skipped — a keyword-less search there returns their recommended
              feed, not your jobs.
            </p>
          ) : (
            <>
              <p className="text-ink-dim">
                <span className="font-mono text-ink">{preview.keywords}</span>
                {" · "}
                <span className="font-mono text-ink">{locationLabel}</span>
                {" · posted in the last "}
                <span className="font-mono text-ink">{sinceDays}d</span>
                {intern && <> · <span className="font-mono text-ink">internships only</span></>}
                <span className="text-ink-faint"> — from {preview.derivedFrom}</span>
              </p>
              <p className="mt-1 text-ink-faint">
                Scanning up to <span className="font-mono text-ink-dim">{maxPages * 25}</span> jobs per board, then queueing{" "}
                {queueAll ? <span className="font-mono text-ink-dim">all</span> : <>the best <span className="font-mono text-ink-dim">{queueLimit}</span></>}{" "}
                by how well they match, how fresh they are, and how few people have applied.
                {!location.trim() && homeCountry && <> Location comes from your profile.</>}
              </p>
              {term && (
                <p className="mt-1 text-ink-faint">
                  Season <span className="font-mono text-ink-dim">{term}</span> filters the Simplify board exactly
                  (its listings carry the term). LinkedIn and Handshake match on the keywords + date above — add the
                  season to the keywords if you want it there too.
                </p>
              )}
            </>
          )}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={discover}
          disabled={running || !anySource || connected === false || (noKeywords && !enabled.simplify)}
          className="btn-primary"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
          {running ? "Discovering…" : "Discover jobs"}
        </button>
        {!anySource && <span className="text-xs text-ink-faint">Pick at least one source.</span>}
        {anySource && noKeywords && !enabled.simplify && (
          <span className="text-xs text-signal">Add keywords — the selected sources can&apos;t search without them.</span>
        )}
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

      {phase.search && phase.search.keywords && (
        <p className="font-mono text-[11px] text-ink-faint">
          searched “{phase.search.keywords}” · {phase.search.location} · last {phase.search.sinceDays}d
          {phase.search.term ? ` · ${phase.search.term} (Simplify)` : ""}
        </p>
      )}

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
                      title={
                        j.description
                          ? j.descriptionSource === "api"
                            ? "Read straight from the board's own job record — no tab opened"
                            : `Scraped from the posting (${j.descriptionSource})`
                          : "Queued without a description"
                      }
                    >
                      <FileText className="h-3 w-3" />
                      {j.description ? `${j.description.length.toLocaleString()} char JD` : "no JD"}
                    </span>
                    {typeof j.applicants === "number" && (
                      <span
                        className={clsx("inline-flex items-center gap-1", j.applicants <= 50 ? "text-verified" : j.applicants >= 2000 ? "text-signal" : "")}
                        title="How many people have already applied, according to the board."
                      >
                        <Users className="h-3 w-3" />
                        {j.applicants.toLocaleString()} applied
                      </span>
                    )}
                    {/* A board link means Run can't drive it — the same warning the
                        queue shows, surfaced here where the choice is still fresh. */}
                    {isBoardUrl(j.url) && (
                      <span className="text-signal" title="Still a board link, not the employer's application page — Run can't drive it.">
                        board link
                      </span>
                    )}
                  </div>
                  {/* WHY this job ranked where it did. Shown because the sweep now
                      queues only the best N: a ranking the operator can't inspect is
                      a ranking they have to take on faith. */}
                  {j.scoreReasons && j.scoreReasons.length > 0 && (
                    <div className="mt-1 font-mono text-[10px] leading-relaxed text-ink-faint">
                      <span className="text-ink-dim">#{(j.score ?? 0)}</span> · {j.scoreReasons.join(" · ")}
                    </div>
                  )}
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
