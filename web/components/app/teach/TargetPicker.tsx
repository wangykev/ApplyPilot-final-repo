"use client";

import { useEffect, useState } from "react";
import { X, Plus, Search } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { flattenProfileFields, bucketLabel } from "@/lib/teach";
import { isModeA, type Bucket } from "@/lib/buckets";

/** The target the user chose for a teach card — a profile field, an existing saved answer, or brand-new. */
export type PickedTarget =
  | { kind: "field"; path: string; label: string }
  | { kind: "existing"; id: string }
  | { kind: "new" };

/**
 * The "put this somewhere else" chooser, opened when the AI's recommended field is wrong. Lists every
 * profile field (grouped by section) and every standalone saved answer, filterable by name, plus a
 * "make a completely new answer" footer that hands off to the shared RememberedAnswerPopup. Selecting a
 * row returns the target up; the parent then opens the confirm popup (or the new-answer popup).
 */
export function TargetPicker({
  profile,
  buckets,
  onPick,
  onClose,
}: {
  profile: unknown;
  buckets: Bucket[];
  onPick: (t: PickedTarget) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);

  // profile fields, grouped by section (same flattening the panel uses)
  const rows = flattenProfileFields(profile).filter((r) => match(r.label) || match(r.sectionLabel) || match(r.value));
  const sections: { key: string; label: string; rows: typeof rows }[] = [];
  for (const r of rows) {
    let s = sections.find((x) => x.key === r.section);
    if (!s) {
      s = { key: r.section, label: r.sectionLabel, rows: [] };
      sections.push(s);
    }
    s.rows.push(r);
  }

  // standalone (Mode-B) saved answers
  const savedAnswers = buckets
    .map((b, i) => ({ b, i }))
    .filter((x) => !isModeA(x.b))
    .filter((x) => match(bucketLabel(x.b)) || (x.b.value[0] ? match(x.b.value[0]) : false));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="presentation">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border border-hairline bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-label text-ink-dim">Choose where this goes</h3>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter fields and answers…"
            className="w-full rounded-lg border border-hairline bg-cockpit py-2 pl-8 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
          />
        </div>

        <div className="-mx-1 flex-1 space-y-4 overflow-y-auto px-1">
          {sections.map((s) => (
            <div key={s.key}>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-label text-ink-dim">{s.label}</p>
              <div className="overflow-hidden rounded-lg border border-hairline">
                {s.rows.map((r) => (
                  <PickRow
                    key={r.path}
                    label={r.label}
                    value={r.value}
                    onClick={() => onPick({ kind: "field", path: r.path, label: r.label })}
                  />
                ))}
              </div>
            </div>
          ))}

          {savedAnswers.length > 0 && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-label text-ink-dim">Saved answers</p>
              <div className="overflow-hidden rounded-lg border border-hairline">
                {savedAnswers.map(({ b }) => (
                  <PickRow key={b.id} label={bucketLabel(b)} value={b.value[0] || ""} onClick={() => onPick({ kind: "existing", id: b.id })} />
                ))}
              </div>
            </div>
          )}

          {sections.length === 0 && savedAnswers.length === 0 && (
            <p className="py-4 text-center text-sm text-ink-faint">No matches.</p>
          )}
        </div>

        <div className="mt-4 border-t border-hairline pt-3">
          <button type="button" onClick={() => onPick({ kind: "new" })} className="btn-ghost w-full justify-center px-3 py-2 text-sm">
            <Plus className="h-3.5 w-3.5" />
            Make a completely new answer
          </button>
        </div>
      </div>
    </div>
  );
}

function PickRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex w-full items-baseline justify-between gap-3 border-b border-hairline/60 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-amber/10",
      )}
    >
      <span className="truncate text-sm text-ink-dim">{label}</span>
      <span className="min-w-0 max-w-[50%] truncate font-mono text-xs text-ink-faint">{value || "—"}</span>
    </button>
  );
}
