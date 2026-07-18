"use client";

import { useEffect, useState } from "react";
import { Check, SkipForward, Plus, Sparkles, ShieldAlert, Loader2 } from "lucide-react";
import { SelectField, TieredField, CheckboxField } from "@/components/form/fields";
import { type Bucket } from "@/lib/buckets";
import {
  type TeachCard,
  sameAnswer,
  addWordingToBucket,
  ensureModeABucket,
  createModeBBucket,
  bucketLabel,
  profileValueAt,
  humanize,
  isFuzzyTier,
} from "@/lib/teach";
import { saveBuckets } from "@/app/app/profile/actions";
import { saveDismissed, recommendField, type FieldRecommendation } from "@/app/app/teach/actions";
import { ProfilePanel } from "@/components/app/teach/ProfilePanel";

const CATEGORIES = ["Screening", "Work authorization", "Demographics", "Personal", "Experience", "Education", "Other"];
const opt = (vals: string[]) => vals.map((v) => ({ value: v, label: v }));

export function TeachInbox({
  initialCards,
  initialBuckets,
  initialDismissed,
  profile,
}: {
  initialCards: TeachCard[];
  initialBuckets: Bucket[];
  initialDismissed: string[];
  profile: unknown;
}) {
  const [cards, setCards] = useState<TeachCard[]>(initialCards);
  const [done, setDone] = useState(0);
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets);
  const [dismissed, setDismissed] = useState<string[]>(initialDismissed);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<"root" | "new" | "existing">("root");
  const [newCat, setNewCat] = useState("Other");
  const [newValue, setNewValue] = useState<string[]>([]);
  const [newSensitive, setNewSensitive] = useState(false);
  const [pickId, setPickId] = useState("");
  // teach-time AI fallback: recommendation per card.key for cards with no stamped maps_to hint
  const [recCache, setRecCache] = useState<Record<string, FieldRecommendation>>({});
  const [recLoading, setRecLoading] = useState(false);

  const card = cards[0] || null;
  const bucketedPaths = new Set(buckets.filter((b) => b.profile_path.trim() !== "").map((b) => b.profile_path.trim()));

  // The recommendation, in precedence order: the field's KNOWN mapped home (canonical_field) →
  // the fill-time AI hint (maps_to) → the teach-time LLM fallback (only when nothing is known).
  const stampedPath = card ? card.canonical_field || card.maps_to : "";
  const fallback = card && !stampedPath ? recCache[card.key] : undefined;
  const recPath = stampedPath || (fallback ? fallback.maps_to : "");
  const recCat = card ? card.suggested_category || (fallback ? fallback.suggested_category : "") : "";
  const recProfileValue = recPath ? profileValueAt(profile, recPath) : "";
  const fuzzy = !!stampedPath && isFuzzyTier(card?.match_tier); // matched a known field by near/typo
  const matches = !!recPath && sameAnswer(card?.answer || "", recProfileValue);

  // Fetch the fallback recommendation ONLY for a card with no known home (no canonical_field + no hint).
  useEffect(() => {
    if (!card || card.canonical_field || card.maps_to || recCache[card.key] !== undefined) {
      setRecLoading(false);
      return;
    }
    let cancelled = false;
    setRecLoading(true);
    recommendField({ question: card.question, answer: card.answer }).then((r) => {
      if (cancelled) return;
      setRecCache((c) => ({ ...c, [card.key]: r }));
      setRecLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [card, recCache]);

  const advance = () => {
    setCards((c) => c.slice(1));
    setDone((d) => d + 1);
    setMode("root");
    setPickId("");
  };

  const commit = async (next: Bucket[], toast: string) => {
    setBuckets(next);
    setSaving(true);
    const res = await saveBuckets(next);
    setSaving(false);
    setNote(res.ok ? toast : `Couldn't save: ${res.ok ? "" : res.error}`);
    if (res.ok) advance();
  };

  const skip = () => {
    if (card) {
      const next = Array.from(new Set([...dismissed, card.key]));
      setDismissed(next);
      void saveDismissed(next);
    }
    setNote(null);
    advance();
  };

  // File the current question's wording under a profile field (Mode-A) — from the panel click or the
  // "file under" shortcut. Creates the Mode-A bucket if needed.
  const fileUnder = (path: string) => {
    if (!card || saving) return;
    const { buckets: withB, bucketId } = ensureModeABucket(buckets, path, card.widget);
    void commit(addWordingToBucket(withB, bucketId, card.question), `Filed under ${humanize(path)} ✓`);
  };

  const openNew = (c: TeachCard) => {
    setNewCat(CATEGORIES.includes(recCat) ? recCat : "Other");
    setNewValue([c.answer]);
    setNewSensitive(c.sensitive);
    setMode("new");
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* LEFT — the profile, physically displayed + clickable */}
      <ProfilePanel
        profile={profile}
        highlightPath={recPath}
        bucketedPaths={bucketedPaths}
        onPick={fileUnder}
        disabled={saving || !card}
      />

      {/* RIGHT — the current teach card */}
      {!card ? (
        <div className="bezel flex flex-col items-center justify-center px-6 py-14 text-center">
          <Sparkles className="h-6 w-6 text-amber" />
          <p className="mt-3 text-sm text-ink">{done > 0 ? "All caught up — nothing left to teach." : "Nothing to teach yet."}</p>
          <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-ink-faint">
            After you review and approve a fill, the answers that didn&apos;t fill deterministically show up here to teach.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-ink-faint">
            <span className="font-mono uppercase tracking-label">{cards.length} to teach</span>
            <span className={saving ? "text-ink-dim" : "text-verified"}>{saving ? "Saving…" : note || ""}</span>
          </div>

          <div className="bezel p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="eyebrow">Question</p>
                <h2 className="mt-1 text-lg font-medium leading-snug text-ink">{card.question}</h2>
              </div>
              <button onClick={skip} className="btn-ghost shrink-0 px-3 py-1.5 text-xs" title="Don't remember this" disabled={saving}>
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

            {/* AI recommendation — the fill-time hint or the teach-time fallback */}
            {recLoading ? (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-hairline bg-panel-raised/30 px-3 py-2.5 text-xs text-ink-dim">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding the matching field…
              </div>
            ) : recPath ? (
              <div className="mt-4 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5">
                <p className="text-xs text-ink-dim">
                  Looks like your <span className="font-medium text-ink">{humanize(recPath)}</span>
                  {" — "}your profile has <span className="font-mono text-ink">{recProfileValue || "—"}</span>{" "}
                  <span className="text-ink-faint">(highlighted on the left).</span>
                </p>
                {fuzzy ? (
                  <p className="mt-1.5 text-xs text-signal">⚠ Matched by a near match (possible typo/variant) — verify it&apos;s the same answer.</p>
                ) : !matches ? (
                  <p className="mt-1.5 text-xs text-ink-faint">Your answer differs from that field&apos;s value — verify, or save it as a new answer below.</p>
                ) : null}
                <button onClick={() => fileUnder(recPath)} className="btn-primary mt-2.5" disabled={saving}>
                  <Check className="h-4 w-4" />
                  File under {humanize(recPath)}
                </button>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-hairline bg-panel-raised/30 px-3 py-2.5">
                <p className="text-xs text-ink-dim">
                  AI didn&apos;t find a matching field — this looks like a <span className="font-medium text-ink">new answer</span>. Save it
                  below, or click a field on the left to file it there.
                </p>
              </div>
            )}

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
      )}
    </div>
  );
}
