"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { TagListField, TieredField } from "@/components/form/fields";
import { type Bucket } from "@/lib/buckets";

/**
 * The "advanced options" popup a field label opens: edit the question wordings
 * that map to that field's answer (a Mode-A bucket, created on first use), and —
 * for a scalar (text/dropdown) field — its "answer variants" (extra candidates the
 * extension tries when the field renders as a dropdown/select). Shared by the profile
 * page (ProfileEditor) and the teach page's ProfilePanel. Backdrop / Esc / Done close.
 */
export function BucketFieldPopup({
  path,
  label,
  widget,
  buckets,
  onBucketsChange,
  onClose,
  variants,
  onVariantsChange,
  fieldValue,
}: {
  path: string;
  label: string;
  widget: string;
  buckets: Bucket[];
  onBucketsChange: (b: Bucket[]) => void;
  onClose: () => void;
  /** Editable "answer variants" (profile.answer_ladders[path].values) — extra candidates the extension
   *  tries (after the field's own value) when this field renders as a dropdown/select. Provided ONLY for
   *  scalar text/dropdown fields; when omitted the variants section is hidden. */
  variants?: string[];
  onVariantsChange?: (next: string[]) => void;
  /** The field's own value, shown as context (the variants are tried after it). */
  fieldValue?: string;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const idx = buckets.findIndex((b) => b.profile_path === path);
  const bucket = idx >= 0 ? buckets[idx] : null;
  const questions = bucket ? bucket.questions : [];
  const upsert = (patch: Partial<Bucket>) => {
    const next = buckets.map((b) => ({ ...b }));
    let i = idx;
    if (i < 0) {
      next.push({ id: "field_" + path.replace(/[^\w]+/g, "_"), profile_path: path, value: [], category: "", widget_hint: widget, questions: [], selectors: {} });
      i = next.length - 1;
    }
    next[i] = { ...next[i], ...patch };
    onBucketsChange(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="presentation">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-label text-ink-dim">{label} — question bucket</h3>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-ink-dim">
          Every wording here fills from this one field — add the phrasings a form might use, and editing the field updates them all.
          <span className="mt-1 block font-mono text-[10px] text-ink-faint">{path}</span>
        </p>
        <TagListField
          label="Question wordings"
          value={questions}
          placeholder="Add a wording a form might use, press Enter"
          onChange={(v) => upsert({ questions: v })}
        />

        {onVariantsChange && (
          <div className="mt-4 border-t border-hairline pt-4">
            <p className="mb-2 text-xs leading-relaxed text-ink-dim">
              Answer variants — other ways a form might word this answer (e.g. a GPA range picker, or a
              differently-labeled option). The extension tries them, in order, when this field is a
              dropdown/select.
              {fieldValue ? (
                <> Your value <span className="font-mono text-ink">{fieldValue}</span> is always tried first.</>
              ) : null}
            </p>
            <TieredField label="Variants" value={variants || []} onChange={onVariantsChange} />
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
