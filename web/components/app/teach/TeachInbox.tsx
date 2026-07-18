"use client";

import { useState } from "react";
import { Check, SkipForward, Plus, Sparkles, ShieldAlert } from "lucide-react";
import { SelectField, TieredField, CheckboxField } from "@/components/form/fields";
import { type Bucket } from "@/lib/buckets";
import {
  type TeachCard,
  sameAnswer,
  addWordingToBucket,
  ensureModeABucket,
  createModeBBucket,
  bucketLabel,
} from "@/lib/teach";
import { saveBuckets } from "@/app/app/profile/actions";

const CATEGORIES = ["Screening", "Work authorization", "Demographics", "Personal", "Experience", "Education", "Other"];
const opt = (vals: string[], blank = "—") => vals.map((v) => ({ value: v, label: v === "" ? blank : v }));

/** Humanize a dotted profile path → the last segment, title-cased ("…gender" → "Gender"). */
function pathLabel(path: string): string {
  const seg = String(path || "").split(".").pop() || path;
  return seg.replace(/\[\d+\]/g, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function TeachInbox({ initialCards, initialBuckets }: { initialCards: TeachCard[]; initialBuckets: Bucket[] }) {
  const [cards, setCards] = useState<TeachCard[]>(initialCards);
  const [done, setDone] = useState(0); // how many taught/skipped this session
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // per-card sub-form state (reset when the card advances)
  const [mode, setMode] = useState<"root" | "new" | "existing">("root");
  const [newCat, setNewCat] = useState("Other");
  const [newValue, setNewValue] = useState<string[]>([]);
  const [newSensitive, setNewSensitive] = useState(false);
  const [pickId, setPickId] = useState("");

  const card = cards[0] || null;

  const advance = () => {
    setCards((c) => c.slice(1));
    setDone((d) => d + 1);
    setMode("root");
    setPickId("");
  };

  // Persist the mutated buckets, then advance to the next card with a toast.
  const commit = async (next: Bucket[], toast: string) => {
    setBuckets(next);
    setSaving(true);
    const res = await saveBuckets(next);
    setSaving(false);
    setNote(res.ok ? toast : `Couldn't save: ${res.ok ? "" : res.error}`);
    if (res.ok) advance();
  };

  const skip = () => {
    setNote(null);
    advance();
  };

  const openNew = (c: TeachCard) => {
    setNewCat(CATEGORIES.includes(c.suggested_category) ? c.suggested_category : "Other");
    setNewValue([c.answer]);
    setNewSensitive(c.sensitive);
    setMode("new");
  };

  if (!card) {
    return (
      <div className="bezel px-6 py-14 text-center">
        <Sparkles className="mx-auto h-6 w-6 text-amber" />
        <p className="mt-3 text-sm text-ink">
          {done > 0 ? "All caught up — nothing left to teach." : "Nothing to teach yet."}
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-ink-faint">
          After you review and approve a fill, the questions the AI had to guess show up here. Teach each
          one once and it fills itself — deterministically, no review — on every future application.
        </p>
      </div>
    );
  }

  const matches = card.maps_to && sameAnswer(card.answer, card.profile_value);

  return (
    <div className="space-y-4">
      {/* progress + status */}
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <span className="font-mono uppercase tracking-label">{cards.length} to teach</span>
        <span className={saving ? "text-ink-dim" : "text-verified"}>{saving ? "Saving…" : note || ""}</span>
      </div>

      <div className="bezel p-6">
        {/* the question + the approved answer */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">Question</p>
            <h2 className="mt-1 text-lg font-medium leading-snug text-ink">{card.question}</h2>
          </div>
          <button onClick={skip} className="btn-ghost shrink-0 px-3 py-1.5 text-xs" title="Don't remember this">
            <SkipForward className="h-3.5 w-3.5" />
            Skip
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-panel-raised/40 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">You approved</span>
          <span className="text-sm font-medium text-ink">{card.answer}</span>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-label text-ink-faint">{card.widget}</span>
          {card.sensitive && (
            <span className="inline-flex items-center gap-1 rounded border border-signal/40 px-1.5 py-0.5 text-[10px] font-semibold text-signal">
              <ShieldAlert className="h-3 w-3" /> sensitive
            </span>
          )}
        </div>

        {/* maps_to suggestion */}
        {card.maps_to && (
          <div className="mt-4 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5">
            <p className="text-xs text-ink-dim">
              AI thinks this is your <span className="font-medium text-ink">{pathLabel(card.maps_to)}</span>
              {" — "}your profile has <span className="font-mono text-ink">{card.profile_value || "—"}</span>.
            </p>
            {matches ? (
              <button
                onClick={() => {
                  const { buckets: withB, bucketId } = ensureModeABucket(buckets, card.maps_to, card.widget);
                  commit(addWordingToBucket(withB, bucketId, card.question), `Added this wording to ${pathLabel(card.maps_to)} ✓`);
                }}
                className="btn-primary mt-2.5"
                disabled={saving}
              >
                <Check className="h-4 w-4" />
                Add this wording to {pathLabel(card.maps_to)}
              </button>
            ) : (
              <p className="mt-1.5 text-xs text-ink-faint">
                Your answer differs from that field — save it as a new answer below, or skip if it&apos;s a typo.
              </p>
            )}
          </div>
        )}

        {/* root actions */}
        {mode === "root" && (
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => openNew(card)} className="btn-ghost px-3 py-1.5 text-sm" disabled={saving}>
              <Plus className="h-3.5 w-3.5" />
              Save as a new answer
            </button>
            {buckets.length > 0 && (
              <button onClick={() => setMode("existing")} className="btn-ghost px-3 py-1.5 text-sm" disabled={saving}>
                Add to an existing answer…
              </button>
            )}
          </div>
        )}

        {/* new standalone (Mode-B) bucket */}
        {mode === "new" && (
          <div className="mt-4 space-y-4 rounded-lg border border-hairline bg-panel-raised/30 p-4">
            <p className="eyebrow">New saved answer</p>
            <TieredField label="Answer" value={newValue} onChange={setNewValue} placeholder="the answer — add fallbacks for other tenants' wordings" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField label="Category" value={newCat} options={opt(CATEGORIES)} onChange={setNewCat} />
              <div className="flex items-end pb-1">
                <CheckboxField label="Sensitive (EEO / legal)" checked={newSensitive} onChange={setNewSensitive} />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  commit(
                    createModeBBucket(buckets, {
                      question: card.question,
                      value: newValue,
                      category: newCat,
                      widget_hint: card.widget,
                      sensitive: newSensitive,
                    }).buckets,
                    "Saved as a new answer ✓",
                  )
                }
                className="btn-primary"
                disabled={saving || newValue.length === 0}
              >
                <Check className="h-4 w-4" />
                Save new answer
              </button>
              <button onClick={() => setMode("root")} className="btn-ghost px-3 py-1.5 text-sm">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* add this wording to an existing bucket */}
        {mode === "existing" && (
          <div className="mt-4 space-y-3 rounded-lg border border-hairline bg-panel-raised/30 p-4">
            <SelectField
              label="Add this question's wording to"
              value={pickId}
              options={[{ value: "", label: "Choose an answer…" }, ...buckets.map((b) => ({ value: b.id, label: bucketLabel(b) }))]}
              onChange={setPickId}
            />
            <div className="flex gap-2">
              <button
                onClick={() => commit(addWordingToBucket(buckets, pickId, card.question), "Added the wording ✓")}
                className="btn-primary"
                disabled={saving || !pickId}
              >
                <Check className="h-4 w-4" />
                Add wording
              </button>
              <button onClick={() => setMode("root")} className="btn-ghost px-3 py-1.5 text-sm">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
