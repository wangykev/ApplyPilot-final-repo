"use client";

import { useMemo, useState } from "react";
import { SectionCard } from "@/components/app/SectionCard";
import { LLM_MODEL_META } from "@/lib/llm";
import { clsx } from "@/lib/clsx";

export type UsageRow = {
  provider: string;
  model: string;
  action: string;
  keyTier: string | null;
  tokensIn: number;
  tokensOut: number;
  /** null = the rate is not known. NEVER treat as 0 — see migration 0013. */
  costUsd: number | null;
  ok: boolean;
  errorCode: string | null;
  source: string;
  createdAt: string;
};

export type QuotaRow = { model: string; rpd: number; rpm: number; usedToday: number };

/**
 * Categorical hues for the three providers, in FIXED order — never cycled, and never
 * derived from rank, so a filter that changes the series count can't repaint the survivors.
 * These are the reference instance's dark-surface steps, validated against this app's
 * panel-raised surface (#1A2230) with scripts/validate_palette.js: all six checks pass —
 * lightness band L 0.48–0.67, chroma floor, CVD separation (worst adjacent ΔE 9.4 deutan),
 * normal-vision floor 26.5, ≥3:1 contrast. Do not hand-tune these without re-running it.
 *
 * The app's own amber/teal/red are deliberately NOT used as series colours: amber is the
 * brand accent and red is a reserved status colour, and reusing a status hue for "series 3"
 * is exactly the mistake the palette rules forbid.
 */
const SERIES: Record<string, string> = {
  gemini: "#3987e5",
  anthropic: "#d95926",
  openai: "#199e70",
};
const SERIES_ORDER = ["gemini", "anthropic", "openai"];
const OTHER = "#52514e";
const seriesColor = (provider: string) => SERIES[provider] ?? OTHER;

const ACTION_LABEL: Record<string, string> = {
  fill: "Short answers",
  essay: "Essays",
  resume_parse: "Resume parsing",
  cover_letter: "Cover letter",
  teach: "Teach",
};

const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0.00");
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const dayKey = (iso: string) => iso.slice(0, 10);

export function UsagePanel({
  rows,
  quota,
  windowDays,
}: {
  rows: UsageRow[];
  quota: QuotaRow[];
  windowDays: number;
  configured: boolean;
}) {
  const [showTable, setShowTable] = useState(false);

  const stats = useMemo(() => {
    const priced = rows.filter((r) => r.costUsd != null);
    const spend = priced.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    // Calls whose rate we don't know are counted SEPARATELY, never folded into the total as
    // if free — otherwise the headline understates the bill.
    const unpriced = rows.filter((r) => r.costUsd == null && r.ok).length;
    const today = dayKey(new Date().toISOString());
    return {
      spend,
      spendToday: priced.filter((r) => dayKey(r.createdAt) === today).reduce((n, r) => n + (r.costUsd ?? 0), 0),
      calls: rows.length,
      callsToday: rows.filter((r) => dayKey(r.createdAt) === today).length,
      failed: rows.filter((r) => !r.ok).length,
      tokens: rows.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0),
      unpriced,
    };
  }, [rows]);

  // Spend per day, stacked by provider. Days with no calls are still rendered, so a gap
  // reads as "nothing ran" rather than compressing the axis.
  const byDay = useMemo(() => {
    const days: string[] = [];
    for (let i = windowDays - 1; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * 86_400_000).toISOString()));
    const index = new Map(days.map((d) => [d, Object.fromEntries(SERIES_ORDER.map((p) => [p, 0])) as Record<string, number>]));
    for (const r of rows) {
      const slot = index.get(dayKey(r.createdAt));
      if (slot && r.costUsd != null) slot[r.provider] = (slot[r.provider] ?? 0) + r.costUsd;
    }
    return days.map((d) => ({ day: d, ...(index.get(d) as Record<string, number>) }));
  }, [rows, windowDays]);

  const byModel = useMemo(() => {
    const m = new Map<string, { provider: string; calls: number; cost: number; unpriced: number; tokens: number }>();
    for (const r of rows) {
      if (!r.model) continue;
      const e = m.get(r.model) ?? { provider: r.provider, calls: 0, cost: 0, unpriced: 0, tokens: 0 };
      e.calls++;
      e.tokens += r.tokensIn + r.tokensOut;
      if (r.costUsd == null) e.unpriced++;
      else e.cost += r.costUsd;
      m.set(r.model, e);
    }
    return [...m.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  }, [rows]);

  const byAction = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.action, (m.get(r.action) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  if (!rows.length) {
    return (
      <SectionCard title="No calls recorded yet" subtitle={`Nothing in the last ${windowDays} days.`}>
        <p className="text-sm leading-relaxed text-ink-dim">
          A row is written every time ApplyPilot calls a model — a form fill, an essay answer, a resume parse or a cover
          letter. Run one and this page fills in. Calls that <span className="text-ink">fail</span> are recorded too: a
          run of quota errors is the clearest sign a key is spent.
        </p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      {/* Headline numbers — a stat row, not a chart: four single values with no trend to read. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`Spend · ${windowDays}d`} value={money(stats.spend)} note={stats.unpriced ? `${stats.unpriced} calls unpriced` : "all calls priced"} />
        <Stat label="Spend · today" value={money(stats.spendToday)} />
        <Stat label="Calls · today" value={String(stats.callsToday)} note={`${stats.calls} in ${windowDays}d`} />
        <Stat
          label="Failed"
          value={String(stats.failed)}
          note={`${compact(stats.tokens)} tokens total`}
          tone={stats.failed ? "warn" : undefined}
        />
      </div>

      {/* ── Free-tier quota ── the view that matters when spend is $0 by definition. */}
      {quota.length > 0 && (
        <SectionCard
          title="Free Gemini allowance — today"
          subtitle="Requests per day are metered PER MODEL, which is why a fallback to a sibling model buys you a second allowance on the same key."
        >
          <div className="space-y-3">
            {quota.map((q) => (
              <QuotaMeter key={q.model} row={q} />
            ))}
          </div>
        </SectionCard>
      )}

      {/* ── Spend over time ── */}
      <SectionCard
        title={`Spend · last ${windowDays} days`}
        subtitle={
          stats.spend === 0
            ? "Nothing billable yet — free-tier calls cost nothing, so this stays flat until a paid key is used."
            : "Stacked by provider. Unpriced calls are excluded rather than counted as free."
        }
      >
        <Legend />
        <SpendChart data={byDay} />
      </SectionCard>

      {/* ── Per model ── */}
      <SectionCard title="By model" subtitle="Where the calls and the money actually went.">
        <div className="space-y-2">
          {byModel.map((m) => (
            <ModelBar key={m.model} row={m} max={Math.max(...byModel.map((x) => x.calls))} />
          ))}
        </div>
      </SectionCard>

      {/* ── Per action ── */}
      <SectionCard title="By job" subtitle="Which job is consuming your calls — the reason per-action routing exists.">
        <div className="space-y-2">
          {byAction.map(([action, n]) => (
            <div key={action} className="flex items-center gap-3">
              <span className="w-32 shrink-0 text-xs text-ink-dim">{ACTION_LABEL[action] ?? action}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-cockpit">
                <div
                  className="h-full rounded-full bg-ink-dim"
                  style={{ width: `${Math.max(2, (n / Math.max(...byAction.map((a) => a[1]))) * 100)}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-xs text-ink">{n}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Table view — the accessibility fallback for every chart above, and the place to
          read an individual call's error code. */}
      <SectionCard
        title="All calls"
        subtitle="The same data as a table."
        actions={
          <button onClick={() => setShowTable((s) => !s)} className="btn-ghost">
            {showTable ? "Hide" : `Show ${rows.length} rows`}
          </button>
        }
      >
        {showTable ? (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-panel text-ink-dim">
                <tr>
                  {["When", "Job", "Model", "Key", "In", "Out", "Cost", "Result"].map((h) => (
                    <th key={h} className="py-1.5 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-ink-dim">
                {rows.slice(0, 500).map((r, i) => (
                  <tr key={i} className="border-t border-hairline/60">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{r.createdAt.slice(5, 16).replace("T", " ")}</td>
                    <td className="py-1.5 pr-3">{ACTION_LABEL[r.action] ?? r.action}</td>
                    <td className="py-1.5 pr-3">
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: seriesColor(r.provider) }} />
                      {LLM_MODEL_META[r.model]?.label ?? r.model ?? "—"}
                    </td>
                    <td className="py-1.5 pr-3">{r.keyTier ?? "—"}</td>
                    <td className="py-1.5 pr-3 font-mono">{r.tokensIn}</td>
                    <td className="py-1.5 pr-3 font-mono">{r.tokensOut}</td>
                    <td className="py-1.5 pr-3 font-mono">{r.costUsd == null ? "unpriced" : money(r.costUsd)}</td>
                    <td className={clsx("py-1.5 pr-3", r.ok ? "text-verified" : "text-signal")}>
                      {r.ok ? "ok" : r.errorCode ?? "failed"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-ink-faint">Hidden by default — it can be long.</p>
        )}
      </SectionCard>
    </div>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-hairline bg-panel-raised/40 p-3">
      <div className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{label}</div>
      <div className={clsx("mt-1 font-display text-xl", tone === "warn" ? "text-signal" : "text-ink")}>{value}</div>
      {note && <div className="mt-0.5 text-[11px] text-ink-faint">{note}</div>}
    </div>
  );
}

/** Legend is always present for ≥2 series, so identity is never colour-alone. */
function Legend() {
  return (
    <div className="mb-3 flex flex-wrap gap-4">
      {SERIES_ORDER.map((p) => (
        <span key={p} className="flex items-center gap-1.5 text-xs text-ink-dim">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: SERIES[p] }} />
          {p}
        </span>
      ))}
    </div>
  );
}

/**
 * Stacked daily spend. Plain SVG: there is no chart library in this app and adding one for
 * two charts isn't worth the dependency. Rounded 4px data-ends anchored to the baseline, a
 * 2px surface gap between stacked segments, recessive axis, and a native <title> per bar as
 * the hover layer.
 */
function SpendChart({ data }: { data: Array<Record<string, number | string>> }) {
  const H = 140;
  const max = Math.max(...data.map((d) => SERIES_ORDER.reduce((n, p) => n + (d[p] as number), 0)), 0.0001);
  const barW = 100 / data.length;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 100 ${H + 18}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label="Daily spend by provider">
        {[0.5, 1].map((f) => (
          <line key={f} x1="0" x2="100" y1={H - f * H} y2={H - f * H} stroke="currentColor" strokeWidth="0.15" className="text-hairline" />
        ))}
        {data.map((d, i) => {
          const total = SERIES_ORDER.reduce((n, p) => n + (d[p] as number), 0);
          let y = H;
          return (
            <g key={i}>
              <title>{`${d.day}: ${total > 0 ? money(total) : "no billable calls"}`}</title>
              {SERIES_ORDER.map((p) => {
                const v = d[p] as number;
                if (v <= 0) return null;
                const h = (v / max) * H;
                y -= h;
                return (
                  <rect
                    key={p}
                    x={i * barW + barW * 0.2}
                    y={y}
                    width={barW * 0.6}
                    height={Math.max(h - 0.5, 0.4)}
                    rx="0.4"
                    fill={SERIES[p]}
                  />
                );
              })}
            </g>
          );
        })}
        <text x="0" y={H + 14} className="fill-ink-faint" style={{ fontSize: 4 }}>
          {String(data[0]?.day ?? "").slice(5)}
        </text>
        <text x="100" y={H + 14} textAnchor="end" className="fill-ink-faint" style={{ fontSize: 4 }}>
          today
        </text>
      </svg>
      <div className="mt-1 text-right font-mono text-[10px] text-ink-faint">peak {money(max)}/day</div>
    </div>
  );
}

function ModelBar({ row, max }: { row: { model: string; provider: string; calls: number; cost: number; unpriced: number }; max: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-44 shrink-0 truncate text-xs text-ink-dim" title={row.model}>
        {LLM_MODEL_META[row.model]?.label ?? row.model}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-cockpit">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(2, (row.calls / Math.max(max, 1)) * 100)}%`, background: seriesColor(row.provider) }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-xs text-ink">{row.calls}</span>
      {/* An unpriced model shows its call count but never a fabricated cost. */}
      <span className="w-20 shrink-0 text-right font-mono text-xs text-ink-dim">
        {row.unpriced === row.calls ? "unpriced" : money(row.cost)}
      </span>
    </div>
  );
}

/**
 * A meter, not a bar chart: one value against a known cap is the textbook case for it.
 * Status colours (not series colours) because this encodes STATE — approaching a limit —
 * and they ship with a visible label, never colour alone.
 */
function QuotaMeter({ row }: { row: QuotaRow }) {
  const pct = Math.min(100, (row.usedToday / row.rpd) * 100);
  const state = pct >= 90 ? "critical" : pct >= 60 ? "warning" : "good";
  const bar = state === "critical" ? "bg-signal" : state === "warning" ? "bg-amber" : "bg-verified";
  const ink = state === "critical" ? "text-signal" : state === "warning" ? "text-amber" : "text-ink-dim";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-ink-dim">{LLM_MODEL_META[row.model]?.label ?? row.model}</span>
        <span className={clsx("font-mono text-xs", ink)}>
          {row.usedToday} / {row.rpd} today
          {state !== "good" && <span className="ml-1.5">{state === "critical" ? "· almost gone" : "· running low"}</span>}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-cockpit" title={`${row.usedToday} of ${row.rpd} requests used today · ${row.rpm}/min limit`}>
        <div className={clsx("h-full rounded-full", bar)} style={{ width: `${Math.max(pct, row.usedToday > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}
