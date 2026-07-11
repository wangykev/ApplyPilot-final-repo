import { clsx } from "@/lib/clsx";

/**
 * Lightweight, server-rendered chart primitives for the analytics page. No chart
 * library — thin marks, 4px rounded data-ends, 2px surface gaps, recessive axes,
 * native <title> hover. Status colors are always paired with a text label (never
 * color-alone), per the dataviz method.
 */

export function StatTile({
  label,
  value,
  sub,
  color = "#E6EDF5",
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bezel px-5 py-5">
      <div className="font-display text-4xl font-semibold leading-none" style={{ color }}>
        {value}
      </div>
      <div className="mt-2 font-mono text-[10px] uppercase tracking-label text-ink-dim">{label}</div>
      {sub && <div className="mt-1 text-xs text-ink-faint">{sub}</div>}
    </div>
  );
}

export type Segment = { label: string; value: number; color: string };

/** 100%-stacked distribution bar + a labeled legend (identity never color-alone). */
export function SegmentBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const shown = segments.filter((s) => s.value > 0);
  return (
    <div>
      <div className="flex h-3.5 w-full gap-[2px] overflow-hidden rounded-full">
        {total === 0 ? (
          <div className="h-full w-full rounded-full bg-panel-raised" />
        ) : (
          shown.map((s) => (
            <div
              key={s.label}
              title={`${s.label}: ${s.value}`}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(s.value / total) * 100}%`, background: s.color, minWidth: 4 }}
            />
          ))
        )}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="flex-1 truncate text-xs text-ink-dim">{s.label}</span>
            <span className="font-mono text-xs text-ink">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Vertical bars over a category/time axis. Single series → one hue. */
export function ColumnChart({
  data,
  color = "#FFB627",
  height = 160,
}: {
  data: { label: string; value: number }[];
  color?: string;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-faint">No data yet.</p>;
  }
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {data.map((d) => {
          const h = d.value === 0 ? 2 : Math.max(6, Math.round((d.value / max) * (height - 24)));
          return (
            <div key={d.label} className="flex flex-1 flex-col items-center justify-end gap-2">
              <span
                className={clsx(
                  "font-mono text-[11px]",
                  d.value > 0 ? "text-ink" : "text-transparent"
                )}
              >
                {d.value}
              </span>
              <div
                title={`${d.label}: ${d.value}`}
                className="w-full rounded-t-[4px]"
                style={{ height: h, background: d.value > 0 ? color : "#1A2230" }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2 border-t border-hairline pt-2">
        {data.map((d) => (
          <span key={d.label} className="flex-1 truncate text-center font-mono text-[10px] text-ink-faint">
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}
