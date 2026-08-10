"use client";

import { useState, useEffect } from "react";
import { X, Trash2 } from "lucide-react";
import { SelectField, CheckboxField, CandidateField, TagListField, FieldLabel, AdvancedChoices } from "@/components/form/fields";
import { type Bucket } from "@/lib/buckets";
import { clsx } from "@/lib/clsx";

/**
 * The shared "remembered answer" editor popup + its small value controls, lifted out of ProfileEditor
 * so the TEACH page reuses the EXACT same add-a-new-answer flow (see docs/profile-v2-plan.md → teach).
 * Works on a local DRAFT — edits commit ONLY when "Done" is clicked; clicking outside, Escape, or the X
 * cancels (the draft is discarded; a brand-new answer is simply never created).
 */

const opt = (vals: string[], blank = "—") => vals.map((v) => ({ value: v, label: v === "" ? blank : v }));

// How to ENTER a remembered answer here. This only drives the editor shown below; the extension still
// adapts to whatever widget the LIVE form field is at fill time (the value is a candidate list). Text
// covers dropdown / type-ahead too — its top-choice-plus-ladder layout IS the "try these options in
// order" a dropdown needs — so those aren't separate options.
export const ANSWER_WIDGETS = [
  { value: "text", label: "Text" },
  { value: "radio", label: "Yes / No" },
  { value: "checkbox", label: "Checkbox" },
];

/** A trash control that requires a second click to confirm (no browser confirm dialog). */
export function ConfirmDeleteButton({ onDelete, withLabel }: { onDelete: () => void; withLabel?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2 text-[11px]">
        <span className="text-ink-dim">Delete?</span>
        <button type="button" onClick={onDelete} className="font-medium text-signal hover:underline">
          Yes
        </button>
        <button type="button" onClick={() => setConfirming(false)} className="text-ink-faint hover:text-ink">
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1 text-[11px] text-ink-faint transition-colors hover:text-signal"
      title="Delete this answer"
    >
      <Trash2 className="h-3.5 w-3.5" />
      {withLabel && "Remove"}
    </button>
  );
}

/** A Yes/No toggle for a remembered answer (stores ["Yes"] / ["No"] / []). Label is optional — omit it
 *  when the question is already shown elsewhere (e.g. on the row header). */
export function RememberedToggle({ label, value, onChange }: { label?: string; value: string[]; onChange: (v: string[]) => void }) {
  // Click the ALREADY-SELECTED option again to open its advanced ladder — the same gesture the profile
  // page's TriBool has always had, asked for here by the operator (2026-08-09): a text answer could reach
  // the ladder through CandidateField's `›` arrow, but a Yes/No one had no route to it at all.
  //
  // A remembered answer's `value` IS the candidate list, so the ladder edits that array directly: ["No"]
  // becomes ["No","Nope","Negative"] and the extension tries them in order. value[0] stays the option the
  // toggle shows as selected.
  const [advanced, setAdvanced] = useState(false);
  const cur = value[0] || "";
  return (
    <div>
      {label && <FieldLabel hint={cur ? "Esc clears" : undefined}>{label}</FieldLabel>}
      <div
        className={clsx("flex max-w-[14rem] overflow-hidden rounded-lg border border-hairline", label && "mt-1.5")}
        // Clicking the active option now OPENS the ladder instead of clearing, so Escape takes over the
        // clear — exactly the split TriBool uses, rather than leaving no way to unset the answer.
        onKeyDown={(e) => {
          if (e.key === "Escape" && cur) { e.preventDefault(); onChange([]); setAdvanced(false); }
        }}
      >
        {["Yes", "No"].map((o, idx) => {
          const active = cur.toLowerCase() === o.toLowerCase();
          return (
            <button
              key={o}
              type="button"
              title={active ? "Click again for the full answer ladder" : undefined}
              onClick={() => (active ? setAdvanced((v) => !v) : onChange([o]))}
              className={clsx(
                "flex-1 py-1.5 text-sm transition-colors",
                idx === 0 && "border-r border-hairline",
                active ? "bg-amber font-semibold text-cockpit" : "text-ink-dim hover:bg-panel-raised/40 hover:text-ink",
              )}
            >
              {o}
            </button>
          );
        })}
      </div>
      {advanced && (
        <AdvancedChoices
          label={label || "Answer"}
          value={value}
          onChange={onChange}
          onClose={() => setAdvanced(false)}
        />
      )}
    </div>
  );
}

/** A single checkbox for a remembered answer (stores ["Yes"] checked / ["No"] unchecked). */
export function RememberedCheckbox({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const checked = (value[0] || "").toLowerCase() === "yes";
  return <CheckboxField label={label} checked={checked} onChange={(c) => onChange([c ? "Yes" : "No"])} />;
}

/** The value editor for a remembered answer, labeled by the QUESTION so it reads like any profile field:
 *  Yes/No → a toggle; checkbox → a checkbox; text (also dropdown / type-ahead) → the candidate field
 *  (top choice + arrow → advanced ladder). */
function RememberedValueField({ widget, label, value, onChange }: { widget: string; label: string; value: string[]; onChange: (v: string[]) => void }) {
  if (widget === "radio") return <RememberedToggle label={label} value={value} onChange={onChange} />;
  if (widget === "checkbox") return <RememberedCheckbox label={label} value={value} onChange={onChange} />;
  return <CandidateField label={label} value={value} onChange={onChange} placeholder="the answer" />;
}

/** The Add / Advanced popup for a remembered answer. Works on a local DRAFT — edits commit ONLY when
 *  "Done" is clicked; clicking outside, Escape, or the X cancels (the draft is discarded; a brand-new
 *  answer is simply never created). Shared by the profile page and the teach page's "new answer" route. */
export function RememberedAnswerPopup({
  initial,
  mode,
  categoryOptions,
  onDone,
  onCancel,
  onDelete,
  title,
}: {
  initial: Bucket;
  mode: "add" | "edit";
  categoryOptions: string[];
  onDone: (draft: Bucket) => void;
  onCancel: () => void;
  onDelete: () => void;
  /** Optional heading override (defaults to Add / Advanced). */
  title?: string;
}) {
  const [draft, setDraft] = useState<Bucket>(initial);
  const patch = (p: Partial<Bucket>) => setDraft((d) => ({ ...d, ...p }));
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel]);
  const answerType = draft.widget_hint === "radio" || draft.widget_hint === "checkbox" ? draft.widget_hint : "text";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel} role="presentation">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-label text-ink-dim">
            {title || (mode === "add" ? "Add remembered answer" : "Remembered answer — advanced")}
          </h3>
          <button type="button" onClick={onCancel} className="text-ink-faint hover:text-ink" aria-label="Cancel">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4">
          <TagListField
            label="Question wordings"
            value={draft.questions}
            onChange={(q) => patch({ questions: q })}
            placeholder="Paste the exact question, press Enter"
            hint="every phrasing that should get this answer"
          />
          <SelectField label="Answer type" value={answerType} options={ANSWER_WIDGETS} onChange={(w) => patch({ widget_hint: w })} />
          <RememberedValueField widget={answerType} label="Answer" value={draft.value} onChange={(v) => patch({ value: v })} />
          <CategoryField value={draft.category} options={categoryOptions} onChange={(c) => patch({ category: c })} />
        </div>
        <div className="mt-5 flex items-center justify-between">
          <div>{mode === "edit" && <ConfirmDeleteButton onDelete={onDelete} withLabel />}</div>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="btn-ghost px-3 py-1.5 text-sm">
              Cancel
            </button>
            <button type="button" onClick={() => onDone(draft)} className="btn-primary">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Category picker for a saved answer: a dropdown of the known + in-use categories. Pick "Other" to type
 *  a new category — the typed name becomes the category live (no separate Add; the popup's Done commits).
 *  A custom category persists in this dropdown for as long as an answer carries it. */
function CategoryField({ value, options, onChange }: { value: string; options: string[]; onChange: (c: string) => void }) {
  // "typing" = entering a new custom category. Enter it by picking "Other", or when the current value is
  // a custom that isn't offered in the dropdown.
  const [typing, setTyping] = useState(() => value !== "" && !options.includes(value));
  const inCustom = typing || value === "Other";
  const selectValue = inCustom ? "Other" : value;
  return (
    <div>
      <SelectField
        label="Category"
        value={selectValue}
        options={opt(["", ...options])}
        onChange={(c) => {
          setTyping(c === "Other");
          onChange(c);
        }}
      />
      {inCustom && (
        <div className="mt-2">
          <input
            value={value === "Other" ? "" : value}
            placeholder="Type a category name (optional)"
            onChange={(e) => {
              setTyping(true);
              const t = e.target.value;
              onChange(t.trim() === "" ? "Other" : t);
            }}
            className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
          />
          <p className="mt-1 text-[11px] text-ink-faint">Leave blank to keep it under &ldquo;Other&rdquo;. New categories appear in this list once an answer uses them.</p>
        </div>
      )}
    </div>
  );
}
