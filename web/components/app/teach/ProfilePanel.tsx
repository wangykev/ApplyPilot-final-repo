"use client";

import { useEffect, useRef } from "react";
import { clsx } from "@/lib/clsx";
import { flattenProfileFields, humanize, type ProfileFieldRow } from "@/lib/teach";
import { profileFieldMeta } from "@/lib/profile-fields";

/**
 * The profile half of the teach page: the applicant's profile, physically displayed and editable in
 * place — same as the real profile page. Each field splits into two click targets:
 *   • the NAME → the "advanced options" popup (the question wordings that map to this field's answer);
 *   • the ANSWER → a popup to modify the stored value with the right editor, showing the LADDER of
 *     fallback candidates where one exists (country / phone-code / citizenship / sources).
 * Beyond the flat object sections, the simple LIST sections are shown too — Websites (name↔URL rows),
 * Skills and Employer history (a single editable list each; clicking edits the whole list). The field
 * the AI recommends for the current teach card is highlighted.
 */
export function ProfilePanel({
  profile,
  highlightPath,
  onOpenBucket,
  onOpenAnswer,
  note,
  disabled,
}: {
  profile: unknown;
  highlightPath: string;
  onOpenBucket: (path: string, label: string, bucketWidget: string) => void;
  onOpenAnswer: (path: string, label?: string) => void;
  note?: string | null;
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

  // simple list sections the flat walk skips (top-level arrays)
  const p = profile && typeof profile === "object" ? (profile as Record<string, unknown>) : {};
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const websites = Array.isArray(p.websites) ? (p.websites as { type?: string; url?: string }[]) : [];
  const websiteRows: FieldRowData[] = websites.map((w, i) => ({
    path: `websites.${i}.url`,
    label: (w?.type || "").trim() || "URL",
    value: String(w?.url || ""),
  }));
  const skills = strList(p.skills).join(", ");
  const employers = strList(p.employment_history_companies).join(", ");

  const common = { onOpenBucket, onOpenAnswer, disabled, highlightPath };
  const anyContent = sections.length > 0 || websiteRows.length > 0 || skills || employers;

  // Auto-scroll the recommended (highlighted) row into view within this panel, so the teach card on
  // the left and its target field on the right are on the same screen.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!highlightPath) return;
    const el = scrollRef.current?.querySelector<HTMLElement>('[data-hot="1"]');
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightPath]);

  return (
    <div
      ref={scrollRef}
      className="bezel self-start p-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Your profile</p>
        {note && <span className="font-mono text-[10px] tracking-label text-verified">{note}</span>}
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Click a field&apos;s <span className="text-ink-dim">name</span> for its question wordings, or its{" "}
        <span className="text-ink-dim">answer</span> to edit it.
      </p>
      <div className="mt-4 space-y-5">
        {sections.map((s) => (
          <FieldBox key={s.key} label={s.label} rows={s.rows.map((r) => ({ path: r.path, label: r.label, value: r.value }))} {...common} />
        ))}
        {websiteRows.length > 0 && <FieldBox label="Websites" rows={websiteRows} {...common} />}
        <ListBox label="Skills" path="skills" value={skills} onOpenAnswer={onOpenAnswer} disabled={disabled} />
        <ListBox label="Employer history" path="employment_history_companies" value={employers} onOpenAnswer={onOpenAnswer} disabled={disabled} />
        {!anyContent && <p className="text-sm text-ink-faint">No profile fields yet — fill out your Profile first.</p>}
      </div>
    </div>
  );
}

type FieldRowData = { path: string; label: string; value: string };

/** A category box of name↔answer rows: the name opens the field's advanced-options (question-wordings)
 *  bucket, the answer opens the value editor. */
function FieldBox({
  label,
  rows,
  highlightPath,
  onOpenBucket,
  onOpenAnswer,
  disabled,
}: {
  label: string;
  rows: FieldRowData[];
  highlightPath: string;
  onOpenBucket: (path: string, label: string, bucketWidget: string) => void;
  onOpenAnswer: (path: string, label?: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{label}</p>
      {/* one box per category, listing each field name matched to its answer */}
      <div className="mt-1.5 divide-y divide-hairline/60 overflow-hidden rounded-lg border border-hairline">
        {rows.map((r) => {
          const hot = !!highlightPath && r.path === highlightPath;
          const meta = profileFieldMeta(r.path, undefined);
          return (
            <div
              key={r.path}
              data-hot={hot ? "1" : undefined}
              className={clsx("flex items-baseline justify-between gap-3 px-3 py-1.5", hot && "bg-amber/10")}
            >
              {/* NAME — plain text, highlights on hover → advanced options (the question wordings) */}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onOpenBucket(r.path, r.label, meta.bucketWidget)}
                title="Advanced options — the questions that map to this answer"
                className="group inline-flex min-w-0 items-center gap-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span
                  className={clsx(
                    "truncate text-sm transition-colors",
                    hot ? "font-medium text-amber" : "text-ink-dim group-hover:text-ink",
                  )}
                >
                  {r.label}
                </span>
              </button>
              {/* ANSWER — plain text, highlights on hover → modify-answer popup */}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onOpenAnswer(r.path, r.label)}
                title="Modify this answer"
                className="group min-w-0 max-w-[55%] text-right disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="block truncate font-mono text-xs text-ink-faint transition-colors group-hover:text-ink">
                  {r.value || "—"}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A category box holding one editable free-text list (skills, employer history). Clicking edits the
 *  whole list. */
function ListBox({
  label,
  path,
  value,
  onOpenAnswer,
  disabled,
}: {
  label: string;
  path: string;
  value: string;
  onOpenAnswer: (path: string, label?: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{label}</p>
      <div className="mt-1.5 overflow-hidden rounded-lg border border-hairline">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onOpenAnswer(path, label)}
          title="Modify this list"
          className="group block w-full px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="block truncate text-sm text-ink-dim transition-colors group-hover:text-ink">{value || "—"}</span>
        </button>
      </div>
    </div>
  );
}

export { humanize };
