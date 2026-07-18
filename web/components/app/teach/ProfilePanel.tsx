"use client";

import { clsx } from "@/lib/clsx";
import { flattenProfileFields, humanize, type ProfileFieldRow } from "@/lib/teach";

/**
 * The left half of the teach page: the applicant's profile, physically displayed. The field the AI
 * recommends for the current card is highlighted; clicking any field files this question's wording
 * under it. A field already backed by a bucket wording shows a subtle dot.
 */
export function ProfilePanel({
  profile,
  highlightPath,
  bucketedPaths,
  onPick,
  disabled,
}: {
  profile: unknown;
  highlightPath: string;
  bucketedPaths: Set<string>;
  onPick: (path: string) => void;
  disabled?: boolean;
}) {
  const rows = flattenProfileFields(profile);
  const sections: { key: string; label: string; rows: ProfileFieldRow[] }[] = [];
  for (const r of rows) {
    let s = sections.find((x) => x.key === r.section);
    if (!s) {
      s = { key: r.section, label: r.sectionLabel, rows: [] };
      sections.push(s);
    }
    s.rows.push(r);
  }
  return (
    <div className="bezel p-5">
      <p className="eyebrow">Your profile</p>
      <p className="mt-1 text-xs text-ink-faint">Click a field to file the current answer under it.</p>
      <div className="mt-4 space-y-5">
        {sections.map((s) => (
          <div key={s.key}>
            <p className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{s.label}</p>
            <div className="mt-1.5 divide-y divide-hairline/60 overflow-hidden rounded-lg border border-hairline">
              {s.rows.map((r) => {
                const hot = !!highlightPath && r.path === highlightPath;
                return (
                  <button
                    key={r.path}
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(r.path)}
                    title="File this answer under this field"
                    className={clsx(
                      "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      hot ? "bg-amber/15 ring-1 ring-inset ring-amber/40" : "hover:bg-panel-raised/40",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {bucketedPaths.has(r.path) && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-verified" title="has remembered wordings" />
                      )}
                      <span className={clsx("truncate", hot ? "font-medium text-ink" : "text-ink-dim")}>{r.label}</span>
                    </span>
                    <span className="shrink-0 max-w-[45%] truncate font-mono text-xs text-ink-faint">{r.value || "—"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {sections.length === 0 && <p className="text-sm text-ink-faint">No profile fields yet — fill out your Profile first.</p>}
      </div>
    </div>
  );
}

export { humanize };
