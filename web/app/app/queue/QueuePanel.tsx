"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plus, Trash2, ExternalLink, FileText, MapPin, Clock, ChevronDown,
  DollarSign, Briefcase, CalendarRange, Hourglass, Users,
} from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { addQueueItems, removeQueueItem, clearQueue } from "./actions";
import { parseUrls, type QueueItem } from "./shared";
import { clsx } from "@/lib/clsx";

const STATUS: Record<QueueItem["status"], { dot: string; text: string }> = {
  pending: { dot: "bg-ink-faint", text: "text-ink-dim" },
  active: { dot: "bg-amber animate-blink-amber", text: "text-amber" },
  done: { dot: "bg-verified", text: "text-verified" },
  error: { dot: "bg-signal", text: "text-signal" },
};

// Matches the Discover panel's badge colours so a source reads the same on both pages.
const SOURCE_BADGE: Record<string, string> = {
  simplify: "border-verified/40 text-verified",
  zero2sudo: "border-iris/40 text-iris",
  linkedin: "border-amber/40 text-amber",
  handshake: "border-ink-dim/40 text-ink-dim",
};

/** Tab order = the sweep order, so the queue reads the same way Discover ran. */
const SOURCE_TABS: string[] = ["simplify", "zero2sudo", "linkedin", "handshake"];

const SOURCE_TAB_LABEL: Record<string, string> = {
  simplify: "Simplify",
  zero2sudo: "@zero2sudo",
  linkedin: "LinkedIn",
  handshake: "Handshake",
};

/** The sentinel for rows the operator PASTED — they have no source at all. */
const PASTED = "__pasted__";

/**
 * Every source that found this row.
 *
 * `details.found_on` is written only when MORE THAN ONE source found the posting, so
 * the common single-source row falls back to `source`. That fallback is the whole
 * contract: absent means "just `source`", never "unknown".
 */
function sourcesOf(item: QueueItem): string[] {
  const many = item.details?.found_on;
  if (Array.isArray(many) && many.length) return many;
  return item.source ? [item.source] : [PASTED];
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
const isWorkday = (url: string) => /myworkdayjobs\.com/i.test(url);
// A board link is one Run CANNOT drive — it's a wrapper around someone else's
// application (LinkedIn Easy Apply, or a posting that never exposed its employer
// link). Worth calling out distinctly from a merely non-Workday ATS link.
const isBoard = (url: string) => /(^|\.)linkedin\.com|joinhandshake\.com/i.test(url);

/** "3d ago" from an ISO posted_at — discovered rows carry it, pasted rows don't. */
function agoLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!isFinite(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function QueuePanel({ items }: { items: QueueItem[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [tab, setTab] = useState<string>("all");

  const detected = parseUrls(text).length;

  // ── SOURCE TABS ───────────────────────────────────────────────────────────
  // One tab per source that actually has rows, plus "All". The per-source tabs
  // deliberately OVERLAP — a posting found on both LinkedIn and Simplify is listed
  // under both, because "what did LinkedIn find for me?" is the question a source tab
  // answers. "All" is the deduped union and is the ONLY count that sums to the queue.
  //
  // Pure client-side: the page already loaded every row, so switching is instant and
  // no tab can be stale relative to another (the same reasoning as the Fill/Submit
  // toggle one level up).
  const counts = new Map<string, number>();
  for (const it of items) {
    for (const s of sourcesOf(it)) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  // Known sources in sweep order, then anything unrecognised (a source added to the
  // extension before this list), then pasted rows last.
  const present = [
    ...SOURCE_TABS.filter((s) => counts.has(s)),
    ...[...counts.keys()].filter((s) => s !== PASTED && !SOURCE_TABS.includes(s)).sort(),
    ...(counts.has(PASTED) ? [PASTED] : []),
  ];
  // A tab whose rows all got removed must not strand the view on an empty list.
  const activeTab = tab !== "all" && !counts.has(tab) ? "all" : tab;
  const shown = activeTab === "all" ? items : items.filter((it) => sourcesOf(it).includes(activeTab));
  // How many rows more than one source found — the number the "All" tab is collapsing.
  const overlapping = items.filter((it) => sourcesOf(it).length > 1).length;

  const add = () =>
    startTransition(async () => {
      setMsg(null);
      const r = await addQueueItems(text);
      if (r.ok) {
        setText("");
        setMsg({ kind: "ok", text: `Added ${r.added} to the queue.` });
        router.refresh();
      } else {
        setMsg({ kind: "err", text: r.error });
      }
    });

  const remove = (id: string) =>
    startTransition(async () => {
      const r = await removeQueueItem(id);
      if (r.ok) router.refresh();
      else setMsg({ kind: "err", text: r.error });
    });

  const clear = () =>
    startTransition(async () => {
      const r = await clearQueue();
      if (r.ok) router.refresh();
      else setMsg({ kind: "err", text: r.error });
    });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Add jobs"
        subtitle="Paste Workday application links — one per line. The extension works through them in order."
      >
        <textarea
          name="queue-urls"
          aria-label="Workday application URLs, one per line"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={"https://company.wd5.myworkdayjobs.com/…/apply\nhttps://another.wd1.myworkdayjobs.com/…/apply"}
          className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-[13px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={add} disabled={pending || detected === 0} className="btn-primary">
            <Plus className="h-4 w-4" />
            {pending ? "Adding…" : `Add ${detected || ""} to queue`.trim()}
          </button>
          <span className="font-mono text-[11px] tracking-label text-ink-faint">
            {detected} URL{detected === 1 ? "" : "s"} detected
          </span>
          {msg && (
            <span className={clsx("text-sm", msg.kind === "ok" ? "text-verified" : "text-signal")}>
              {msg.text}
            </span>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Queue"
        subtitle={`${items.length} job${items.length === 1 ? "" : "s"} waiting`}
        actions={
          items.length > 0 ? (
            <button
              onClick={clear}
              disabled={pending}
              className="inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-signal"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear all
            </button>
          ) : null
        }
      >
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-faint">
            Nothing queued yet. Paste some Workday links above.
          </p>
        ) : (
          <>
            {/* Only worth showing once there is more than one source to switch between. */}
            {present.length > 1 && (
              <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-hairline pb-3">
                <SourceTab
                  id="all"
                  label="All"
                  n={items.length}
                  active={activeTab === "all"}
                  onClick={setTab}
                />
                {present.map((s) => (
                  <SourceTab
                    key={s}
                    id={s}
                    label={s === PASTED ? "Pasted" : SOURCE_TAB_LABEL[s] || s}
                    n={counts.get(s) ?? 0}
                    active={activeTab === s}
                    tone={SOURCE_BADGE[s]}
                    onClick={setTab}
                  />
                ))}
                <span className="ml-auto font-mono text-[10px] text-ink-faint">
                  {activeTab === "all"
                    ? overlapping > 0
                      ? `deduped — ${overlapping} found by more than one source`
                      : "deduped union"
                    : "everything this source found"}
                </span>
              </div>
            )}
            <ol className="space-y-2">
              {shown.map((it, i) => (
                <QueueRow
                  key={it.id}
                  item={it}
                  index={i}
                  pending={pending}
                  onRemove={() => remove(it.id)}
                />
              ))}
            </ol>
          </>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * One source tab. Deliberately smaller and squarer than the Fill/Submit toggle above
 * it — these are a filter WITHIN that view, not a peer of it, and reusing the same pill
 * would read as two equal rows of tabs.
 */
function SourceTab({
  id,
  label,
  n,
  active,
  tone,
  onClick,
}: {
  id: string;
  label: string;
  n: number;
  active: boolean;
  tone?: string;
  onClick: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onClick(id)}
      aria-pressed={active}
      className={clsx(
        "rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-label transition-colors",
        active
          ? tone
            ? clsx(tone, "bg-panel-raised")
            : "border-ink-dim bg-panel-raised text-ink"
          : "border-hairline text-ink-dim hover:border-ink-dim"
      )}
    >
      {label} <span className={active ? "" : "text-ink-faint"}>{n}</span>
    </button>
  );
}

/**
 * One queue row. A DISCOVERED row leads with what the operator actually cares about
 * — company · role, where it came from, how fresh it is, and whether we captured a
 * job description — and keeps the raw URL as the secondary line. A PASTED row has
 * none of that, so it degrades to exactly the host + url it always showed.
 */
function QueueRow({
  item,
  index,
  pending,
  onRemove,
}: {
  item: QueueItem;
  index: number;
  pending: boolean;
  onRemove: () => void;
}) {
  const [showJd, setShowJd] = useState(false);
  const st = STATUS[item.status];
  const ago = agoLabel(item.posted_at);
  const headline = [item.company, item.role].filter(Boolean).join(" · ") || host(item.url);
  const discovered = Boolean(item.company || item.role || item.source);
  // Migration 0012's extras. Older rows (and pasted ones) simply have none, and every
  // key is optional — absent always means "the board didn't say".
  const d = item.details || null;

  return (
    <li className="rounded-lg border border-hairline bg-panel-raised/40 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="w-6 shrink-0 font-mono text-[11px] text-ink-faint">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className={clsx("h-2 w-2 shrink-0 rounded-full", st.dot)} />
        {/* EVERY source that found this posting, not just the one that found it first.
            On the "All" tab that is the only place the overlap is visible — the row
            appears once, so the badges are what say it was corroborated. */}
        {sourcesOf(item)
          .filter((s) => s !== PASTED)
          .map((s) => (
            <span
              key={s}
              className={clsx(
                "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label",
                SOURCE_BADGE[s] || "border-ink-faint/40 text-ink-faint"
              )}
            >
              {s}
            </span>
          ))}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-ink">{headline}</div>
          {discovered ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-faint">
              {item.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {item.location}
                </span>
              )}
              {ago && (
                <span
                  className="inline-flex items-center gap-1"
                  title={
                    d?.reposted && d.original_posted_at
                      ? `The board shows a REPOST. Originally posted ${new Date(d.original_posted_at).toLocaleDateString()}.`
                      : undefined
                  }
                >
                  <Clock className="h-3 w-3" />
                  {/* A board re-floats an old posting and shows the BUMP as if it were
                      new. Say which, so "posted 2h ago" can't mislead. */}
                  {d?.reposted ? <>reposted {ago}</> : <>posted {ago}</>}
                </span>
              )}
              {/* Pay / term / deadline / workplace — read from the board's own record,
                  so the row answers "is this worth opening" without opening it.
                  Pay is Handshake-only; LinkedIn publishes none, so it's simply absent. */}
              {d?.pay && (
                <span className="inline-flex items-center gap-1 text-verified">
                  <DollarSign className="h-3 w-3" />
                  {d.pay}
                </span>
              )}
              {(d?.employment_type || d?.workplace) && (
                <span className="inline-flex items-center gap-1">
                  <Briefcase className="h-3 w-3" />
                  {[d?.employment_type, d?.workplace].filter(Boolean).join(" · ")}
                </span>
              )}
              {(d?.start_date || d?.end_date) && (
                <span className="inline-flex items-center gap-1" title="The term, as the board states it">
                  <CalendarRange className="h-3 w-3" />
                  {[d?.start_date, d?.end_date].filter(Boolean).join(" → ")}
                </span>
              )}
              {d?.apply_by && (
                <span className="inline-flex items-center gap-1 text-amber" title="The board's own application deadline">
                  <Hourglass className="h-3 w-3" />
                  apply by {d.apply_by}
                </span>
              )}
              {typeof d?.applicants === "number" && (
                <span className="inline-flex items-center gap-1" title="How many people the board says have applied. Shown for context — it does not affect the match score.">
                  <Users className="h-3 w-3" />
                  {d.applicants.toLocaleString()} applied
                </span>
              )}
              <span className="truncate">{host(item.url)}</span>
            </div>
          ) : (
            <div className="truncate font-mono text-[11px] text-ink-faint">{item.url}</div>
          )}
        </div>
        {isBoard(item.url) ? (
          <span
            className="shrink-0 rounded border border-signal/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label text-signal"
            title="This is still a job-board link, not the employer's application page — Run can't drive it. Open it and apply from there."
          >
            board link
          </span>
        ) : !isWorkday(item.url) ? (
          <span className="shrink-0 rounded border border-amber/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label text-amber">
            not workday
          </span>
        ) : null}
        {/* WHY this row was queued. The sweep queues by a % threshold, so showing the
            score (and its reasons on hover) is what keeps that decision inspectable. */}
        {typeof d?.match_percent === "number" && (
          <span
            className={clsx(
              "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-label",
              d.match_percent >= 80 ? "border-verified/40 text-verified"
                : d.match_percent >= 60 ? "border-amber/40 text-amber"
                : "border-ink-faint/40 text-ink-faint"
            )}
            title={(d.match_reasons || []).join(" · ") || "Match score out of 100"}
          >
            {d.match_percent}% match
          </span>
        )}
        <span className={clsx("shrink-0 font-mono text-[10px] uppercase tracking-label", st.text)}>
          {item.status}
        </span>
        {item.job_description && (
          <button
            onClick={() => setShowJd((v) => !v)}
            className="shrink-0 text-ink-faint transition-colors hover:text-ink"
            aria-label="Show the job description"
            aria-expanded={showJd}
            title={`Job description (${item.job_description.length.toLocaleString()} chars)`}
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
        )}
        <a href={item.url} target="_blank" rel="noreferrer" className="shrink-0 text-ink-faint hover:text-ink" aria-label="Open">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <button
          onClick={onRemove}
          disabled={pending}
          className="shrink-0 text-ink-faint transition-colors hover:text-signal"
          aria-label="Remove"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {showJd && item.job_description && (
        <div className="mt-3 border-t border-hairline pt-3">
          <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-label text-ink-faint">
            <ChevronDown className="h-3 w-3" />
            Job description ({item.job_description.length.toLocaleString()} chars)
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-cockpit p-3 text-xs leading-relaxed text-ink-dim">
            {item.job_description}
          </pre>
        </div>
      )}
    </li>
  );
}
