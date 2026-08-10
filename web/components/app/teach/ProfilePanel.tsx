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
  selectMode,
  onSelectPath,
  onSelectRemembered,
  onCancelSelect,
  buckets,
  onOpenRemembered,
}: {
  profile: unknown;
  /** Mode-B remembered answers (a bucket with its own value and no profile_path). They are NOT
   *  profile fields, so the flat walk never sees them — and a brand-new answer created from the
   *  teach card therefore vanished the moment it was saved (operator 2026-08-02: "when I add a new
   *  field, it should render in the teach profile, it currently doesn't"). Shown as their own box. */
  buckets?: { profile_path?: string; value?: unknown; questions?: unknown; category?: string }[];
  /** Open a remembered answer for editing — its question WORDINGS and its answer LADDER live in the
   *  same object, so one editor serves both (operator 2026-08-02: "the questions should be buckets
   *  and the answer should be a ladder that I can edit"). Index into `buckets`. */
  onOpenRemembered?: (bucketIndex: number) => void;
  highlightPath: string;
  onOpenBucket: (path: string, label: string, bucketWidget: string) => void;
  onOpenAnswer: (path: string, label?: string) => void;
  note?: string | null;
  disabled?: boolean;
  /** RETARGET MODE (2026-07-25, operator): "Wrong field?" no longer opens a search popup over the
   *  profile — the profile is ALREADY on screen, so the whole row becomes one click target and the
   *  operator points at the right field directly. Rows stop opening the bucket/answer editors while
   *  this is on. */
  selectMode?: boolean;
  onSelectPath?: (path: string, label: string) => void;
  /** Pick a remembered answer as the target for the current card — its wordings get the question. */
  onSelectRemembered?: (bucketIndex: number) => void;
  onCancelSelect?: () => void;
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

  // Mode-B = no profile_path. Label it by its FIRST taught wording (that is how the operator will
  // recognise it); fall back to the category. Value = its first candidate. Keep the bucket's REAL
  // index so the editor opens the right one after filtering.
  const remembered = (buckets || [])
    .map((b, i) => ({ b, i }))
    .filter((x) => x.b && String(x.b.profile_path || "").trim() === "")
    .map((x) => {
      const qs = Array.isArray(x.b.questions) ? (x.b.questions as unknown[]).map((q) => String(q ?? "")).filter(Boolean) : [];
      const vals = Array.isArray(x.b.value) ? (x.b.value as unknown[]).map((v) => String(v ?? "")).filter(Boolean) : [];
      return {
        idx: x.i,
        category: (x.b.category || "").trim() || "Other",
        row: { path: REMEMBERED_PATH + x.i, label: qs[0] || (x.b.category || "").trim() || "Remembered answer", value: vals[0] || "" },
      };
    });
  // MERGED categories sit inside the matching profile section, exactly as the profile page does;
  // everything else (Experience / Education / customs / Other) gets its own box.
  const rememberedIn = (sectionKey: string) =>
    remembered.filter((r) => MERGED_CATEGORY_SECTION[r.category] === sectionKey).map((r) => r.row);
  const ownBoxCats = Array.from(new Set(remembered.filter((r) => !MERGED_CATEGORY_SECTION[r.category]).map((r) => r.category)));
  const common = { onOpenBucket, onOpenAnswer, disabled, highlightPath, selectMode: !!selectMode, onSelectPath, onSelectRemembered };
  const anyContent = sections.length > 0 || websiteRows.length > 0 || skills || employers || remembered.length > 0;

  // Auto-scroll the recommended (highlighted) row into view within this panel, so the teach card on
  // the left and its target field on the right are on the same screen.
  const scrollRef = useRef<HTMLDivElement>(null);
  // Escape leaves retarget mode (the same affordance the popup had).
  useEffect(() => {
    if (!selectMode || !onCancelSelect) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancelSelect(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, onCancelSelect]);
  useEffect(() => {
    if (!highlightPath) return;
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>('[data-hot="1"]');
    if (!box || !el) return;
    // Scroll THIS PANEL, never the window. scrollIntoView walks every scrollable ancestor, so any
    // re-render that recomputes the highlight — restoring a skipped item, most visibly — yanked the
    // whole page upward under the operator (2026-08-10). Moving the panel's own scrollTop keeps the
    // field-into-view behaviour and cannot move the document.
    //
    // Measured from live rects rather than offsetTop: the rows sit inside nested wrappers, so
    // offsetParent is not reliably this box.
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (Math.abs(delta) < 4) return; // already in place — don't animate a no-op
    // A little breathing room above, so the field reads as "near the top" rather than flush against it.
    box.scrollTo({ top: box.scrollTop + delta - 8, behavior: "smooth" });
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
      {selectMode ? (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2">
          <p className="text-xs text-ink">
            Pick where this answer belongs — <span className="text-ink-dim">click any field or saved answer below</span>.
          </p>
          {onCancelSelect && (
            <button type="button" onClick={onCancelSelect} className="btn-ghost px-2 py-1 text-xs">
              Cancel
            </button>
          )}
        </div>
      ) : (
        <p className="mt-1 text-xs text-ink-faint">
          Click a field&apos;s <span className="text-ink-dim">name</span> for its question wordings, or its{" "}
          <span className="text-ink-dim">answer</span> to edit it and its answer variants.
        </p>
      )}
      <div className="mt-4 space-y-5">
        {sections.map((s) => (
          <FieldBox
            key={s.key}
            label={s.label}
            rows={[...s.rows.map((r) => ({ path: r.path, label: r.label, value: r.value })), ...rememberedIn(s.key)]}
            {...common}
            onOpenRemembered={onOpenRemembered}
          />
        ))}
        {websiteRows.length > 0 && <FieldBox label="Websites" rows={websiteRows} {...common} />}
        <ListBox label="Skills" path="skills" value={skills} onOpenAnswer={onOpenAnswer} disabled={disabled} />
        <ListBox label="Employer history" path="employment_history_companies" value={employers} onOpenAnswer={onOpenAnswer} disabled={disabled} />
        {ownBoxCats.map((cat) => (
          <FieldBox
            key={"remembered-" + cat}
            label={cat}
            rows={remembered.filter((r) => r.category === cat).map((r) => r.row)}
            {...common}
            onOpenRemembered={onOpenRemembered}
          />
        ))}
        {!anyContent && <p className="text-sm text-ink-faint">No profile fields yet — fill out your Profile first.</p>}
      </div>
    </div>
  );
}

type FieldRowData = { path: string; label: string; value: string };

/** A remembered (Mode-B) answer has no profile path, so it carries a synthetic one that both marks it
 *  as remembered and holds its index into `buckets`. Rows keyed this way open the remembered editor
 *  instead of the field editors, and are never offered as a retarget target. */
const REMEMBERED_PATH = "__remembered__.";
const rememberedIndexOf = (path: string) =>
  path.startsWith(REMEMBERED_PATH) ? Number(path.slice(REMEMBERED_PATH.length)) : -1;
/** bucket category → the profile section it merges into (mirrors the profile page's MERGED_CATEGORIES). */
const MERGED_CATEGORY_SECTION: Record<string, string> = {
  Screening: "screening",
  "Work authorization": "work_authorization",
  Demographics: "self_identification",
  Personal: "personal_info",
};

/** A category box of name↔answer rows: the name opens the field's advanced-options (question-wordings)
 *  bucket, the answer opens the value editor. */
function FieldBox({
  label,
  rows,
  highlightPath,
  onOpenBucket,
  onOpenAnswer,
  disabled,
  selectMode,
  onSelectPath,
  onOpenRemembered,
  onSelectRemembered,
}: {
  label: string;
  rows: FieldRowData[];
  highlightPath: string;
  onOpenBucket: (path: string, label: string, bucketWidget: string) => void;
  onOpenAnswer: (path: string, label?: string) => void;
  disabled?: boolean;
  selectMode?: boolean;
  onSelectPath?: (path: string, label: string) => void;
  onOpenRemembered?: (bucketIndex: number) => void;
  onSelectRemembered?: (bucketIndex: number) => void;
}) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{label}</p>
      {/* one box per category, listing each field name matched to its answer */}
      <div className="mt-1.5 divide-y divide-hairline/60 overflow-hidden rounded-lg border border-hairline">
        {rows.map((r) => {
          const hot = !!highlightPath && r.path === highlightPath;
          const meta = profileFieldMeta(r.path, undefined);
          const remIdx = rememberedIndexOf(r.path); // >= 0 ⇒ a remembered answer, not a profile field
          if (selectMode && remIdx >= 0) {
            // A saved answer IS a valid target: a form asking the same thing in different words
            // should join that answer's wordings rather than spawn a duplicate (operator
            // 2026-08-02). It files as kind:"existing" — the wording goes to this bucket.
            return (
              <button
                key={r.path}
                type="button"
                disabled={disabled}
                onClick={() => onSelectRemembered && onSelectRemembered(remIdx)}
                title={`Add this question to "${r.label}"`}
                className={clsx(
                  "flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left transition-colors",
                  "hover:bg-amber/15 focus:bg-amber/15 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                <span className="truncate text-sm text-ink-dim">{r.label}</span>
                <span className="block max-w-[55%] truncate font-mono text-xs text-ink-faint">{r.value || "—"}</span>
              </button>
            );
          }
          if (selectMode) {
            // RETARGET: the whole row is ONE target — no name/answer split, no editors.
            return (
              <button
                key={r.path}
                type="button"
                data-hot={hot ? "1" : undefined}
                disabled={disabled}
                onClick={() => onSelectPath && onSelectPath(r.path, r.label)}
                title={`Use ${r.label} for this answer`}
                className={clsx(
                  "flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left transition-colors",
                  "hover:bg-amber/15 focus:bg-amber/15 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60",
                  hot && "scroll-mt-20 bg-amber/10",
                )}
              >
                <span className={clsx("truncate text-sm", hot ? "font-medium text-amber" : "text-ink-dim")}>{r.label}</span>
                <span className="block max-w-[55%] truncate font-mono text-xs text-ink-faint">{r.value || "—"}</span>
              </button>
            );
          }
          return (
            <div
              key={r.path}
              data-hot={hot ? "1" : undefined}
              className={clsx("flex items-baseline justify-between gap-3 px-3 py-1.5", hot && "scroll-mt-20 bg-amber/10")}
            >
              {/* NAME — plain text, highlights on hover → advanced options (the question wordings) */}
              <button
                type="button"
                disabled={disabled}
                onClick={() => (remIdx >= 0 ? onOpenRemembered && onOpenRemembered(remIdx) : onOpenBucket(r.path, r.label, meta.bucketWidget))}
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
                onClick={() => (remIdx >= 0 ? onOpenRemembered && onOpenRemembered(remIdx) : onOpenAnswer(r.path, r.label))}
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
