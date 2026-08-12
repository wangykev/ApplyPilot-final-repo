"use client";

import { useState, useEffect, useTransition } from "react";
import Link from "next/link";
import { Trash2, ExternalLink } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { updateApplicationStatus, deleteApplication } from "./actions";
import { approveApplication } from "./approve-action";
import { APP_STATUSES, type Application, type AppStatus } from "./shared";
import { clsx } from "@/lib/clsx";
import { prettyCompany } from "@/lib/company-name";

const COLOR: Record<AppStatus, string> = {
  queued: "#7E8C9E",
  needs_review: "#FFB627",
  submitted: "#36D6A0",
  interviewing: "#5BD2FF",
  offer: "#36D6A0",
  rejected: "#FF5C5C",
};
const LABEL: Record<AppStatus, string> = {
  queued: "Queued",
  needs_review: "Needs review",
  submitted: "Submitted",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
};

// The "N review" chip counts fields the FILL flagged for a human. Once the application has actually
// been sent, that number is history — it isn't work you can still do, and showing it on a submitted row
// reads as "17 things still need you". So the chip belongs only to the stage that still owns that work.
// (Queued rows never reach the tracker at all — see `visible`.)
function showsReviewChip(status: AppStatus): boolean {
  return status === "needs_review";
}

// FILLED AND APPROVED, BUT NOT YET SENT — the one state the status enum cannot name. Adding an
// `approved` member would mean a migration and teaching every writer (including the extension) a new
// value, so the row keeps `needs_review` and the UI relabels it. Only meaningful while it is still
// awaiting review: once the status moves on, the status itself says more than this ever could.
function approvedPending(a: Application): boolean {
  return !!a.approved_at && a.status === "needs_review";
}

// Was this application actually SENT? Everything past needs_review means a real application exists in
// the world, so deleting the row throws away the only record of it — that gets a confirmation. A
// needs_review row is a fill, and a fill can simply be run again.
function wasSent(status: AppStatus): boolean {
  return status !== "needs_review" && status !== "queued";
}

function host(url: string | null): string {
  if (!url) return "—";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Locale/timezone-independent so server and client render identically (no hydration mismatch).
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function TrackerPanel({ applications }: { applications: Application[] }) {
  // The list lives in client state so a background poll can PATCH it in place — a fill the extension
  // reports appears without an F5 (no page reload, no server re-render). Seeded from the server prop.
  const [apps, setApps] = useState<Application[]>(applications);
  const [filter, setFilter] = useState<AppStatus | "all">("all");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // The row whose delete is awaiting confirmation (a sent application — see wasSent).
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Poll the lightweight applications endpoint (every 12s while the tab is visible + on focus) and patch
  // the list in place. NOT a refresh: a JSON fetch → setState, only when the visible fields changed.
  useEffect(() => {
    const sig = (list: Application[]) =>
      list.map((a) => `${a.id}:${a.status}:${a.needs_review_count ?? ""}:${a.company ?? ""}:${a.role ?? ""}:${a.applied_at ?? ""}:${a.approved_at ?? ""}`).join("|");
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/applications", { cache: "no-store" });
        if (stopped || !res.ok) return;
        const j = await res.json();
        if (stopped || !j?.ok || !Array.isArray(j.applications)) return; // non-ok → leave the list untouched
        const next = j.applications as Application[];
        setApps((prev) => (sig(prev) === sig(next) ? prev : next));
      } catch {
        /* transient network — the next tick retries */
      }
    };
    const id = setInterval(poll, 12000);
    const onFocus = () => poll();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    poll(); // catch up immediately on mount (e.g. arriving right after a fill)
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // QUEUED never belongs on the tracker — both loaders already exclude it, and this is the belt: it also
  // covers the DEV_PREVIEW samples and any row still in state from before a status change.
  const visible = apps.filter((a) => a.status !== "queued");
  const counts = APP_STATUSES.reduce<Record<string, number>>((acc, s) => {
    acc[s] = visible.filter((a) => a.status === s).length;
    return acc;
  }, {});
  const shown = filter === "all" ? visible : visible.filter((a) => a.status === filter);

  const setStatus = (id: string, status: AppStatus) =>
    startTransition(async () => {
      setErr(null);
      const r = await updateApplicationStatus(id, status);
      if (!r.ok) { setErr(r.error); return; }
      // Moving a row back to QUEUED takes it off the tracker — it belongs to the queue now. Drop it here
      // rather than waiting for the next poll to notice, so the list matches what you just asked for.
      setApps((prev) =>
        status === "queued" ? prev.filter((a) => a.id !== id) : prev.map((a) => (a.id === id ? { ...a, status } : a))
      );
    });

  const remove = (id: string) =>
    startTransition(async () => {
      setErr(null);
      const r = await deleteApplication(id);
      if (r.ok) setApps((prev) => prev.filter((a) => a.id !== id));
      else setErr(r.error);
    });

  const approve = (id: string) =>
    startTransition(async () => {
      setErr(null);
      const r = await approveApplication(id);
      if (r.ok) setApps((prev) => prev.map((a) => (a.id === id ? { ...a, approved_at: r.approvedAt, needs_review_count: 0 } : a)));
      // The action refuses (with the reason) when the bundle is not actually submit-ready — surface that
      // rather than silently doing nothing, because the button being visible implies it should work.
      else setErr(r.error);
    });

  // Each tile IS the filter for its stage — the number you just read and the list you want to see are
  // the same thing, so making them separate controls just asks you to find the matching chip. "Total"
  // clears the filter. `stage` is what a click selects; it drives the active styling too, so the strip
  // always shows which stage the list below is currently showing.
  const stats: { label: string; value: number; color: string; stage: AppStatus | "all" }[] = [
    { label: "Total", value: visible.length, color: "#E6EDF5", stage: "all" },
    { label: "Needs review", value: counts.needs_review, color: "#FFB627", stage: "needs_review" },
    { label: "Submitted", value: counts.submitted, color: "#36D6A0", stage: "submitted" },
    { label: "Interviewing", value: counts.interviewing, color: "#5BD2FF", stage: "interviewing" },
    { label: "Offers", value: counts.offer, color: "#36D6A0", stage: "offer" },
  ];

  const chips: (AppStatus | "all")[] = [
    "all",
    ...APP_STATUSES.filter((s) => counts[s] > 0),
  ];

  return (
    <div className="space-y-6">
      {/* stats strip */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-5">
        {stats.map((s) => {
          const active = filter === s.stage;
          // A stage with nothing in it would filter to an empty list and strand you there, so it stays
          // inert rather than becoming a dead end. "Total" is always live — it is how you get back.
          const clickable = s.stage === "all" || s.value > 0;
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => clickable && setFilter(s.stage)}
              disabled={!clickable}
              aria-pressed={active}
              title={clickable ? (s.stage === "all" ? "Show all applications" : `Show only ${s.label.toLowerCase()}`) : `No applications ${s.label.toLowerCase()}`}
              className={clsx(
                "bg-panel px-4 py-4 text-left transition-colors",
                clickable && "cursor-pointer hover:bg-panel-raised",
                !clickable && "cursor-default",
                active && "bg-panel-raised",
              )}
            >
              <div className="font-display text-3xl font-semibold" style={{ color: s.color }}>
                {s.value}
              </div>
              <div
                className={clsx(
                  "mt-1 font-mono text-[10px] uppercase tracking-label",
                  active ? "text-ink" : "text-ink-dim",
                )}
              >
                {s.label}
              </div>
              {/* The active stage gets an underline in its own colour, so the strip reads as the
                  current selection rather than five identical tiles. */}
              <div
                className="mt-2 h-0.5 rounded-full transition-opacity"
                style={{ background: s.color, opacity: active ? 1 : 0 }}
              />
            </button>
          );
        })}
      </div>

      <SectionCard
        title="Applications"
        subtitle="Fills in automatically as the extension reports each run. Move a card through your pipeline as things progress."
      >
        {/* filters */}
        {visible.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={clsx(
                  "rounded-full border px-3 py-1 font-mono text-[11px] tracking-wide transition-colors",
                  filter === c
                    ? "border-amber/50 bg-amber/[0.08] text-amber"
                    : "border-hairline text-ink-dim hover:text-ink"
                )}
              >
                {c === "all" ? `All ${visible.length}` : `${LABEL[c]} ${counts[c]}`}
              </button>
            ))}
          </div>
        )}

        {err && <p className="mb-3 text-sm text-signal">{err}</p>}

        {visible.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-ink-dim">No applications yet.</p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-faint">
              When you run a fill, the extension reports it here automatically — company, role,
              status, and how many fields need your review.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {shown.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline bg-panel-raised/40 px-3 py-3"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: COLOR[a.status] }}
                />
                <Link href={`/app/tracker/${a.id}`} className="group min-w-0 flex-1">
                  <div className="truncate text-sm text-ink transition-colors group-hover:text-amber">
                    {prettyCompany(a.company, a.url) || host(a.url)}
                  </div>
                  <div className="truncate font-mono text-[11px] text-ink-faint">
                    {a.role || host(a.url)}
                  </div>
                </Link>

                {a.needs_review_count > 0 && showsReviewChip(a.status) && (
                  <span className="shrink-0 rounded border border-amber/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-label text-amber">
                    {a.needs_review_count} review
                  </span>
                )}

                {/* APPROVED is shown BY THE STATUS DROPDOWN ITSELF (below), not as a chip beside it
                    (2026-08-12). It is the state between "filled" and "sent" and the enum has no word
                    for it, so the row used to read "Needs review" in the status control with a green
                    "Approved" sticker next to it — the control and the sticker saying opposite things
                    about the same row. The dropdown now relabels its own current value; the stored
                    status is untouched, so nothing downstream has to learn a new enum member. */}

                {/* Nothing was flagged, so there is no per-field decision to make — approving from here
                    saves a trip into the detail page. The action still re-verifies against the bundle and
                    refuses if it isn't genuinely ready (a blank REQUIRED field does not show up in this
                    count), so this is a shortcut, not a bypass.
                    ONLY on `needs_review`: that status means a fill produced a bundle to approve. Any
                    other stage has nothing to approve — a queued row has never been filled at all. */}
                {!a.approved_at && a.needs_review_count === 0 && a.status === "needs_review" && (
                  <button
                    onClick={() => approve(a.id)}
                    disabled={pending}
                    className="shrink-0 rounded border border-verified/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-label text-verified transition-colors hover:bg-verified/[0.12] disabled:opacity-50"
                    title="Nothing needs review — approve without opening"
                  >
                    Approve
                  </button>
                )}

                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {fmtDate(a.applied_at || a.created_at)}
                </span>

                <select
                  name="application-status"
                  aria-label={`Status for ${prettyCompany(a.company, a.url) || host(a.url)}`}
                  value={a.status}
                  onChange={(e) => setStatus(a.id, e.target.value as AppStatus)}
                  disabled={pending}
                  className={clsx(
                    "shrink-0 rounded-md border bg-cockpit px-2 py-1 text-xs text-ink outline-none focus:border-amber",
                    approvedPending(a) ? "border-verified/50" : "border-hairline"
                  )}
                  style={{ color: approvedPending(a) ? COLOR.submitted : COLOR[a.status] }}
                >
                  {APP_STATUSES.map((s) => (
                    <option key={s} value={s} className="bg-panel text-ink">
                      {s === "needs_review" && approvedPending(a) ? "✓ Approved — ready to submit" : LABEL[s]}
                    </option>
                  ))}
                </select>

                {a.url && (
                  <a href={a.url} target="_blank" rel="noreferrer" className="shrink-0 text-ink-faint hover:text-ink" aria-label="Open">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {confirmId === a.id ? (
                  // Inline, not window.confirm(): a native modal blocks every subsequent browser event,
                  // which would freeze the extension mid-run if one were ever open.
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-label text-signal">Delete?</span>
                    <button
                      onClick={() => { setConfirmId(null); remove(a.id); }}
                      disabled={pending}
                      className="rounded border border-signal/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-label text-signal transition-colors hover:bg-signal/[0.12]"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmId(null)}
                      className="font-mono text-[10px] uppercase tracking-label text-ink-faint hover:text-ink"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    // An application that was actually SENT is confirmed before it goes: deleting it
                    // throws away the only record you have of applying. A needs_review row is just a
                    // fill, and a fill can be run again — so that one still deletes on the first click.
                    onClick={() => (wasSent(a.status) ? setConfirmId(a.id) : remove(a.id))}
                    disabled={pending}
                    className="shrink-0 text-ink-faint transition-colors hover:text-signal"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
