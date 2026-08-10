"use client";

import { useState, useEffect, useTransition } from "react";
import Link from "next/link";
import { Trash2, ExternalLink } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { updateApplicationStatus, deleteApplication } from "./actions";
import { APP_STATUSES, type Application, type AppStatus } from "./shared";
import { clsx } from "@/lib/clsx";

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

  // Poll the lightweight applications endpoint (every 12s while the tab is visible + on focus) and patch
  // the list in place. NOT a refresh: a JSON fetch → setState, only when the visible fields changed.
  useEffect(() => {
    const sig = (list: Application[]) =>
      list.map((a) => `${a.id}:${a.status}:${a.needs_review_count ?? ""}:${a.company ?? ""}:${a.role ?? ""}:${a.applied_at ?? ""}`).join("|");
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

  const counts = APP_STATUSES.reduce<Record<string, number>>((acc, s) => {
    acc[s] = apps.filter((a) => a.status === s).length;
    return acc;
  }, {});
  const shown = filter === "all" ? apps : apps.filter((a) => a.status === filter);

  const setStatus = (id: string, status: AppStatus) =>
    startTransition(async () => {
      setErr(null);
      const r = await updateApplicationStatus(id, status);
      if (r.ok) setApps((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
      else setErr(r.error);
    });

  const remove = (id: string) =>
    startTransition(async () => {
      setErr(null);
      const r = await deleteApplication(id);
      if (r.ok) setApps((prev) => prev.filter((a) => a.id !== id));
      else setErr(r.error);
    });

  const stats = [
    { label: "Total", value: apps.length, color: "#E6EDF5" },
    { label: "Needs review", value: counts.needs_review, color: "#FFB627" },
    { label: "Submitted", value: counts.submitted, color: "#36D6A0" },
    { label: "Interviewing", value: counts.interviewing, color: "#5BD2FF" },
    { label: "Offers", value: counts.offer, color: "#36D6A0" },
  ];

  const chips: (AppStatus | "all")[] = [
    "all",
    ...APP_STATUSES.filter((s) => counts[s] > 0),
  ];

  return (
    <div className="space-y-6">
      {/* stats strip */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="bg-panel px-4 py-4">
            <div className="font-display text-3xl font-semibold" style={{ color: s.color }}>
              {s.value}
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-label text-ink-dim">
              {s.label}
            </div>
          </div>
        ))}
      </div>

      <SectionCard
        title="Applications"
        subtitle="Fills in automatically as the extension reports each run. Move a card through your pipeline as things progress."
      >
        {/* filters */}
        {apps.length > 0 && (
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
                {c === "all" ? `All ${apps.length}` : `${LABEL[c]} ${counts[c]}`}
              </button>
            ))}
          </div>
        )}

        {err && <p className="mb-3 text-sm text-signal">{err}</p>}

        {apps.length === 0 ? (
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
                    {a.company || host(a.url)}
                  </div>
                  <div className="truncate font-mono text-[11px] text-ink-faint">
                    {a.role || host(a.url)}
                  </div>
                </Link>

                {a.needs_review_count > 0 && (
                  <span className="shrink-0 rounded border border-amber/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-label text-amber">
                    {a.needs_review_count} review
                  </span>
                )}

                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {fmtDate(a.applied_at || a.created_at)}
                </span>

                <select
                  name="application-status"
                  aria-label={`Status for ${a.company || host(a.url)}`}
                  value={a.status}
                  onChange={(e) => setStatus(a.id, e.target.value as AppStatus)}
                  disabled={pending}
                  className="shrink-0 rounded-md border border-hairline bg-cockpit px-2 py-1 text-xs text-ink outline-none focus:border-amber"
                  style={{ color: COLOR[a.status] }}
                >
                  {APP_STATUSES.map((s) => (
                    <option key={s} value={s} className="bg-panel text-ink">
                      {LABEL[s]}
                    </option>
                  ))}
                </select>

                {a.url && (
                  <a href={a.url} target="_blank" rel="noreferrer" className="shrink-0 text-ink-faint hover:text-ink" aria-label="Open">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  onClick={() => remove(a.id)}
                  disabled={pending}
                  className="shrink-0 text-ink-faint transition-colors hover:text-signal"
                  aria-label="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
