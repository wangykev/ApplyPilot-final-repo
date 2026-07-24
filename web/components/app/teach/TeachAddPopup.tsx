"use client";

import { useEffect, useRef, useState } from "react";
import { X, Check } from "lucide-react";
import { CheckboxField, TagListField, TieredField } from "@/components/form/fields";
import { ProfileFieldEditor, arrv } from "@/components/app/teach/AnswerEditPopup";
import {
  type TeachCard,
  addWordingToBucket,
  ensureModeABucket,
  bucketLabel,
  decideTeachRoute,
  boolAnswerCandidates,
  isBoolAnswer,
  seedLadderDraft,
  setLadderList,
} from "@/lib/teach";
import { profileFieldMeta, getAtPath, setAtPath, type ProfileWidget } from "@/lib/profile-fields";
import type { Bucket } from "@/lib/buckets";
import type { Profile } from "@/lib/profile-schema";

const isListWidget = (w: ProfileWidget) => w === "candidate" || w === "tiered" || w === "taglist";

/** Where the current teach card is being filed — a profile FIELD (Mode-A) or an existing standalone
 *  (Mode-B) saved ANSWER. A brand-new answer is handled by the shared RememberedAnswerPopup, not here. */
export type ConfirmTarget = { kind: "field"; path: string; label: string } | { kind: "existing"; id: string };

export type AddResult = { buckets?: Bucket[]; profile?: Profile; toast: string };

/** Seed the field editor from the card's answer: append to a list ladder, coerce a yes/no, else set it. */
function seedFieldValue(widget: ProfileWidget, current: unknown, answer: string): unknown {
  if (isListWidget(widget)) {
    const cur = arrv(current);
    return cur.includes(answer) ? cur : [...cur, answer].filter(Boolean);
  }
  if (widget === "tribool")
    return /^(yes|true)$/i.test(answer) ? true : /^(no|false)$/i.test(answer) ? false : current === true ? true : current === false ? false : null;
  if (widget === "checkbox") return /^(yes|true|checked|on)$/i.test(answer);
  return answer;
}

/**
 * The END-STEP confirm popup for adding the current teach card to a CHOSEN target. It previews exactly
 * what will change — with the added element highlighted in amber — before it commits:
 *   • field + "answer" route  → the field is empty / holds a different value → set (or append, for a
 *     ladder) the ANSWER, and file the wording too (so the card is fully taught);
 *   • field + "wording" route → the field ALREADY holds this answer → just remember the QUESTION wording;
 *   • existing (Mode-B) answer → add the wording to that saved answer (optionally its answer to the ladder).
 * The answer-vs-wording split for a field is decided by decideTeachRoute — the popup opens straight into
 * the missing half. On confirm it hands the computed change up to the parent (persist + advance).
 */
export function TeachAddPopup({
  target,
  card,
  buckets,
  profile,
  saving,
  onConfirm,
  onClose,
}: {
  target: ConfirmTarget;
  card: TeachCard;
  buckets: Bucket[];
  profile: Profile;
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

  const isField = target.kind === "field";
  const path = isField ? target.path : "";
  const fieldLabel = isField ? target.label : "";
  // For a field: does it already hold this answer (→ wording) or not (→ answer)?
  const route = isField ? decideTeachRoute(profile, path, card.answer) : "answer";
  const meta = isField ? profileFieldMeta(path, getAtPath(profile, path)) : null;
  // A NON-STANDARD yes/no label (e.g. "Affirmative") a tenant used — the default Yes/No+True/False ladder
  // can't match it, so remember it in this field's ladder (answer_ladders) for the chosen polarity, so it
  // fills deterministically next time. A standard Yes/No/True/False answer needs no ladder entry.
  const nonStandardBool = isField && meta?.widget === "tribool" && !isBoolAnswer(card.answer);

  // ── field · answer route: the field value seeded with the card's answer ──
  const [fieldValue, setFieldValue] = useState<unknown>(() =>
    isField && meta ? seedFieldValue(meta.widget, getAtPath(profile, path), card.answer) : card.answer,
  );

  // ── the remembered wordings (with this question added + highlighted) ──
  const existing = !isField ? buckets.find((b) => b.id === target.id) ?? null : null;
  const seedWordings = isField
    ? buckets.find((x) => x.profile_path === path)?.questions ?? []
    : existing?.questions ?? [];
  const [wordings, setWordings] = useState<string[]>(() => dedupWordings([...seedWordings, card.question]));

  // ── existing (Mode-B) answer: optionally add the card's answer to its candidate ladder ──
  const [alsoLadder, setAlsoLadder] = useState(false);

  // ── non-standard yes/no label: the editable fill-ladder draft (same reorderable editor as the profile
  // page), seeded with the polarity's defaults + the card's label; re-seeded when the Yes/No toggle flips. ──
  const [ladderDraft, setLadderDraft] = useState<string[]>(() =>
    nonStandardBool && typeof fieldValue === "boolean" ? seedLadderDraft(profile, path, fieldValue, card.answer) : [],
  );
  const lastPolRef = useRef<boolean | null>(typeof fieldValue === "boolean" ? fieldValue : null);
  useEffect(() => {
    if (!nonStandardBool) return;
    const pol = typeof fieldValue === "boolean" ? fieldValue : null;
    if (pol === lastPolRef.current) return; // only re-seed on an ACTUAL polarity change (not every render)
    lastPolRef.current = pol;
    setLadderDraft(pol === null ? [] : seedLadderDraft(profile, path, pol, card.answer));
  }, [fieldValue, nonStandardBool, profile, path, card.answer]);

  const confirm = () => {
    if (isField && route === "answer" && meta) {
      // set the profile value AND remember the wording, so the card is fully taught (covered next time)
      let withValue = setAtPath(profile, path, fieldValue);
      // Remember a NON-STANDARD yes/no label for the chosen polarity (fieldValue is a definite Yes/No),
      // so the extension fills THIS tenant's wording deterministically and the card stops resurfacing.
      if (nonStandardBool && typeof fieldValue === "boolean") {
        withValue = setLadderList(withValue, path, fieldValue, ladderDraft) as Profile;
      }
      const { buckets: withB, bucketId } = ensureModeABucket(buckets, path, card.widget);
      onConfirm({
        profile: withValue,
        buckets: addWordingToBucket(withB, bucketId, card.question),
        toast: nonStandardBool ? `Remembered “${card.answer}” for your ${fieldLabel} ✓` : `Added to your ${fieldLabel} ✓`,
      });
    } else if (isField) {
      // wording route — the value's already there, only the phrasing is new
      const { buckets: withB, bucketId } = ensureModeABucket(buckets, path, card.widget);
      const next = withB.map((b) => (b.id === bucketId ? { ...b, questions: dedupWordings(wordings) } : b));
      onConfirm({ buckets: next, toast: `Filed under ${fieldLabel} ✓` });
    } else if (existing) {
      let next = buckets.map((b) => (b.id === existing.id ? { ...b, questions: dedupWordings(wordings) } : b));
      if (alsoLadder) {
        // A yes/no / checkbox answer adds BOTH labelings so it resolves whether the tenant words the
        // option Yes/No or True/False; a non-boolean answer adds itself. Deduped case-insensitively.
        const have = new Set(existing.value.map((v) => v.trim().toLowerCase()));
        const add = boolAnswerCandidates(card.answer).filter((v) => !have.has(v.toLowerCase()));
        next = next.map((b) => (b.id === existing.id ? { ...b, value: [...b.value, ...add] } : b));
      }
      onConfirm({ buckets: next, toast: `Added to ${bucketLabel(existing)} ✓` });
    }
  };

  // A non-standard yes/no label needs a definite polarity (Yes or No) before we can file it in a ladder.
  const canConfirm =
    isField && route === "answer" ? (nonStandardBool ? typeof fieldValue === "boolean" : true) : wordings.length > 0;

  const title =
    isField && route === "answer"
      ? `Add to your ${fieldLabel}`
      : isField
        ? `Remember wording — ${fieldLabel}`
        : `Add to ${existing ? bucketLabel(existing) : "answer"}`;

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

        {isField && route === "answer" && meta && (
          <div className="space-y-2">
            <p className="text-xs text-ink-dim">
              {isListWidget(meta.widget)
                ? "Added to your field's answer options (the ladder the extension tries — reorder if needed)."
                : nonStandardBool
                  ? "This form used a non-standard label — pick whether it means Yes or No, and it'll be remembered so the tool fills it automatically next time."
                  : "Sets your profile field — the extension fills it from here."}{" "}
              <span className="text-ink-faint">The question wording is saved too.</span>
            </p>
            <ProfileFieldEditor
              path={path}
              label={fieldLabel}
              value={fieldValue}
              highlight={card.answer}
              countryForState={arrv(getAtPath(profile, "personal_info.country"))}
              onChange={setFieldValue}
            />
            {nonStandardBool &&
              (typeof fieldValue === "boolean" ? (
                <div className="rounded-lg border border-hairline bg-panel-raised/30 px-3 py-2.5">
                  <p className="mb-2 text-xs text-ink-dim">
                    <span className="font-medium text-ink">{fieldValue ? "Yes" : "No"}</span> fill ladder — the extension tries
                    these against the form&apos;s options, in order. Reorder or remove as needed.
                  </p>
                  <TieredField
                    label="Candidates it tries (most-specific first)"
                    value={ladderDraft}
                    onChange={setLadderDraft}
                    highlight={card.answer}
                  />
                </div>
              ) : (
                <p className="text-xs text-signal">Pick Yes or No above so we know which &ldquo;{card.answer}&rdquo; means.</p>
              ))}
          </div>
        )}

        {isField && route === "wording" && (
          <div className="space-y-2">
            <p className="text-xs text-ink-dim">
              Your <span className="text-ink">{fieldLabel}</span> already answers this. Remember this phrasing so it
              fills with no review next time.
            </p>
            <TagListField
              label="Question wordings"
              value={wordings}
              onChange={setWordings}
              highlight={card.question}
              placeholder="Add another wording, press Enter"
            />
          </div>
        )}

        {!isField && (
          <div className="space-y-3">
            <p className="text-xs text-ink-dim">This question maps to that saved answer. Confirm to remember the phrasing.</p>
            <TagListField
              label="Question wordings"
              value={wordings}
              onChange={setWordings}
              highlight={card.question}
              placeholder="Add another wording, press Enter"
            />
            <CheckboxField
              label="Also add this answer to its options"
              checked={alsoLadder}
              onChange={setAlsoLadder}
              hint="adds the card's answer to that saved answer's ladder"
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
