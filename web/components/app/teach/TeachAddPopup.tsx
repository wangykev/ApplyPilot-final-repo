"use client";

import { useEffect, useState } from "react";
import { X, Check } from "lucide-react";
import { SelectField, CheckboxField, TieredField, TagListField } from "@/components/form/fields";
import { ProfileFieldEditor, arrv, triv } from "@/components/app/teach/AnswerEditPopup";
import {
  type TeachCard,
  addWordingToBucket,
  ensureModeABucket,
  createModeBBucket,
  bucketLabel,
} from "@/lib/teach";
import { profileFieldMeta, getAtPath, setAtPath, type ProfileWidget } from "@/lib/profile-fields";
import type { Bucket } from "@/lib/buckets";
import type { Profile } from "@/lib/profile-schema";

const CATEGORIES = ["Screening", "Work authorization", "Demographics", "Personal", "Experience", "Education", "Other"];
const opt = (vals: string[]) => vals.map((v) => ({ value: v, label: v }));
const isListWidget = (w: ProfileWidget) => w === "candidate" || w === "tiered" || w === "taglist";

/** How the current teach card gets added to the profile — the three routes the popup confirms. */
export type AddKind = "field" | "wording" | "new" | "existing";

export type AddResult = { buckets?: Bucket[]; profile?: Profile; toast: string };

/** Seed the field editor from the card's answer: append to a list ladder, coerce a yes/no, else set it. */
function seedFieldValue(widget: ProfileWidget, current: unknown, answer: string): unknown {
  if (isListWidget(widget)) {
    const cur = arrv(current);
    return cur.includes(answer) ? cur : [...cur, answer].filter(Boolean);
  }
  if (widget === "tribool") return /^(yes|true)$/i.test(answer) ? true : /^(no|false)$/i.test(answer) ? false : triv(current);
  if (widget === "checkbox") return /^(yes|true|checked|on)$/i.test(answer);
  return answer;
}

/**
 * Confirm popup for adding the current teach card to the profile — one of three routes, each previewed
 * before it commits:
 *   • "field"    → set / add the ANSWER into the recommended profile field (its value, or its ladder);
 *   • "wording"  → remember the QUESTION wording under the recommended field's bucket;
 *   • "new"      → save a brand-new answer (a standalone bucket: wording + answer ladder);
 *   • "existing" → add the wording (or the answer to the ladder) of an existing saved answer.
 * On confirm it hands the computed change up to the parent (which persists + advances the card).
 */
export function TeachAddPopup({
  kind,
  card,
  buckets,
  profile,
  recPath,
  recLabel,
  recCat,
  saving,
  onConfirm,
  onClose,
}: {
  kind: AddKind;
  card: TeachCard;
  buckets: Bucket[];
  profile: Profile;
  recPath: string;
  recLabel: string;
  recCat: string;
  saving?: boolean;
  onConfirm: (r: AddResult) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  // ── field: set / add the answer into the recommended profile field ──
  const meta = recPath ? profileFieldMeta(recPath, getAtPath(profile, recPath)) : null;
  const [fieldValue, setFieldValue] = useState<unknown>(() =>
    meta ? seedFieldValue(meta.widget, getAtPath(profile, recPath), card.answer) : card.answer,
  );

  // ── wording: the field's remembered question wordings (with this question added) ──
  const existingWordings = (() => {
    const b = buckets.find((x) => x.profile_path === recPath);
    return b ? b.questions : [];
  })();
  const [wordings, setWordings] = useState<string[]>(() =>
    dedupWordings([...existingWordings, card.question]),
  );

  // ── new: a standalone answer (wording + answer ladder + category) ──
  const [newValue, setNewValue] = useState<string[]>([card.answer]);
  const [newCat, setNewCat] = useState(CATEGORIES.includes(recCat) ? recCat : "Other");

  // ── existing: pick a saved answer; always adds the wording, optionally the answer to its ladder ──
  const [pickId, setPickId] = useState("");
  const [alsoLadder, setAlsoLadder] = useState(false);

  const confirm = () => {
    if (kind === "field" && meta) {
      // set the profile value AND remember the wording, so the card is fully taught (covered next time)
      const withValue = setAtPath(profile, recPath, fieldValue);
      const { buckets: withB, bucketId } = ensureModeABucket(buckets, recPath, card.widget);
      onConfirm({
        profile: withValue,
        buckets: addWordingToBucket(withB, bucketId, card.question),
        toast: `Added to your ${recLabel} ✓`,
      });
    } else if (kind === "wording") {
      const { buckets: withB, bucketId } = ensureModeABucket(buckets, recPath, card.widget);
      const next = withB.map((b) => (b.id === bucketId ? { ...b, questions: dedupWordings(wordings) } : b));
      onConfirm({ buckets: next, toast: `Filed under ${recLabel} ✓` });
    } else if (kind === "new") {
      onConfirm({
        buckets: createModeBBucket(buckets, {
          question: card.question,
          value: newValue,
          category: newCat,
          widget_hint: card.widget,
        }).buckets,
        toast: "Saved as a new answer ✓",
      });
    } else if (kind === "existing" && pickId) {
      let next = addWordingToBucket(buckets, pickId, card.question);
      if (alsoLadder) {
        next = next.map((b) =>
          b.id === pickId ? { ...b, value: b.value.includes(card.answer) ? b.value : [...b.value, card.answer] } : b,
        );
      }
      onConfirm({ buckets: next, toast: "Added to the answer ✓" });
    }
  };

  const canConfirm =
    kind === "field"
      ? true
      : kind === "wording"
        ? wordings.length > 0
        : kind === "new"
          ? newValue.length > 0
          : !!pickId;

  const title =
    kind === "field"
      ? `Add to your ${recLabel}`
      : kind === "wording"
        ? `Remember wording — ${recLabel}`
        : kind === "new"
          ? "Save as a new answer"
          : "Add to an existing answer";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="presentation">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-label text-ink-dim">{title}</h3>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* the card being taught — always shown so the confirm has context */}
        <div className="mb-4 rounded-lg border border-hairline bg-panel-raised/40 px-3 py-2 text-xs">
          <p className="text-ink-dim">{card.question}</p>
          <p className="mt-1">
            <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">answer </span>
            <span className="font-medium text-ink">{card.answer}</span>
          </p>
        </div>

        {kind === "field" && meta && (
          <div className="space-y-2">
            <p className="text-xs text-ink-dim">
              {isListWidget(meta.widget)
                ? "Added to your field's answer options (the ladder the extension tries)."
                : "Sets your profile field — the extension fills it from here."}
            </p>
            <ProfileFieldEditor
              path={recPath}
              label={recLabel}
              value={fieldValue}
              countryForState={arrv(getAtPath(profile, "personal_info.country"))}
              onChange={setFieldValue}
            />
          </div>
        )}

        {kind === "wording" && (
          <div className="space-y-2">
            <p className="text-xs text-ink-dim">
              These question wordings all fill from your <span className="text-ink">{recLabel}</span>. Confirm to remember them.
            </p>
            <TagListField label="Question wordings" value={wordings} onChange={setWordings} placeholder="Add another wording, press Enter" />
          </div>
        )}

        {kind === "new" && (
          <div className="space-y-4">
            <TieredField label="Answer" value={newValue} onChange={setNewValue} placeholder="the answer — add fallbacks for other tenants' wordings" />
            <SelectField label="Category" value={newCat} options={opt(CATEGORIES)} onChange={setNewCat} />
          </div>
        )}

        {kind === "existing" && (
          <div className="space-y-3">
            <SelectField
              label="Saved answer this question maps to"
              value={pickId}
              options={[{ value: "", label: "Choose an answer…" }, ...buckets.map((b) => ({ value: b.id, label: bucketLabel(b) }))]}
              onChange={setPickId}
            />
            <CheckboxField
              label="Also add this answer to its options"
              checked={alsoLadder}
              onChange={setAlsoLadder}
              hint="adds the answer above to that saved answer's ladder"
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost px-3 py-1.5 text-sm" disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={confirm} className="btn-primary" disabled={saving || !canConfirm}>
            <Check className="h-4 w-4" />
            {saving ? "Saving…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Case/whitespace-insensitive dedup that preserves the first spelling. */
function dedupWordings(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of list) {
    const k = q.trim().toLowerCase().replace(/\s+/g, " ");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(q.trim());
  }
  return out;
}
