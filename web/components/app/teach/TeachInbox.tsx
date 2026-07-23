"use client";

import { useEffect, useRef, useState } from "react";
import { Check, SkipForward, Plus, Sparkles, ShieldAlert, Loader2, PenLine, ChevronDown, RotateCcw } from "lucide-react";
import { BucketFieldPopup } from "@/components/form/BucketFieldPopup";
import { isModeA, type Bucket } from "@/lib/buckets";
import type { Profile } from "@/lib/profile-schema";
import {
  type TeachCard,
  sameAnswer,
  profileValueAt,
  humanize,
  isFuzzyTier,
} from "@/lib/teach";
import { saveBuckets, saveProfile } from "@/app/app/profile/actions";
import { liveSync } from "@/lib/extension-sync";
import { saveDismissed, recommendField, type FieldRecommendation } from "@/app/app/teach/actions";
import { ProfilePanel } from "@/components/app/teach/ProfilePanel";
import { AnswerEditPopup } from "@/components/app/teach/AnswerEditPopup";
import { TeachAddPopup, type ConfirmTarget, type AddResult } from "@/components/app/teach/TeachAddPopup";
import { TargetPicker, type PickedTarget } from "@/components/app/teach/TargetPicker";
import { RememberedAnswerPopup } from "@/components/app/RememberedAnswerPopup";

// Categories a new remembered answer can carry (fixed set + any custom already in use + "Other").
const BASE_CATEGORIES = ["Screening", "Work authorization", "Demographics", "Personal", "Experience", "Education"];

export function TeachInbox({
  initialCards,
  initialSkipped,
  initialBuckets,
  initialDismissed,
  profile: initialProfile,
}: {
  initialCards: TeachCard[];
  initialSkipped: TeachCard[];
  initialBuckets: Bucket[];
  initialDismissed: string[];
  profile: Profile;
}) {
  const [cards, setCards] = useState<TeachCard[]>(initialCards);
  const [done, setDone] = useState(0);
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets);
  const [dismissed, setDismissed] = useState<string[]>(initialDismissed);
  // Cards the user SKIPPED — shown in a collapsible "Skipped" section so they can be restored.
  const [skipped, setSkipped] = useState<TeachCard[]>(initialSkipped);
  const [showSkipped, setShowSkipped] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // the three add surfaces: the end-step confirm popup (a chosen target), the "wrong field" picker, and
  // the shared new-answer popup (identical to the profile page's "Add remembered answer").
  const [confirm, setConfirm] = useState<{ target: ConfirmTarget } | null>(null);
  const [picker, setPicker] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // teach-time AI fallback: recommendation per card.key for cards with no stamped maps_to hint
  const [recCache, setRecCache] = useState<Record<string, FieldRecommendation>>({});
  const [recLoading, setRecLoading] = useState(false);

  // ── editable profile (the panel on the right) — edited in place, like the real profile page ──
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const profileRef = useRef(profile); // latest value for the save-on-close of the answer popup
  const [bucketPopup, setBucketPopup] = useState<{ path: string; label: string; widget: string } | null>(null);
  const [answerPopup, setAnswerPopup] = useState<{ path: string; label?: string } | null>(null);
  const [panelNote, setPanelNote] = useState<string | null>(null);

  // persist a profile-panel edit (answer value or a field's question bucket). Shows a small note; does
  // NOT touch the teach-card `saving`/advance flow.
  const persistProfile = async (p: Profile) => {
    const r = await saveProfile(p);
    setPanelNote(r.ok ? "Saved ✓" : `Couldn't save: ${r.error}`);
    if (r.ok) liveSync("profile"); // mirror the edit into a connected extension
  };
  const persistBuckets = async (b: Bucket[]) => {
    const r = await saveBuckets(b);
    setPanelNote(r.ok ? "Saved ✓" : `Couldn't save: ${r.error}`);
    if (r.ok) liveSync("profile"); // profile slice carries buckets too
  };
  const onAnswerChange = (next: Profile) => {
    profileRef.current = next;
    setProfile(next);
  };
  const closeAnswer = () => {
    setAnswerPopup(null);
    void persistProfile(profileRef.current);
  };

  const card = cards[0] || null;

  // The recommendation, in precedence order: the field's KNOWN mapped home (canonical_field) →
  // the fill-time AI hint (maps_to) → the teach-time LLM fallback (only when nothing is known).
  // A Mode-A bucket that already binds this question's wording to a profile field is AUTHORITATIVE
  // (the over_18 starter → screening.at_least_18_years_old) — prefer it over a FIELD_MAP home or the
  // AI's maps_to hint, which can be wrong (e.g. hallucinating "education" for the age question).
  const stampedPath = card ? card.bucket_path || card.canonical_field || card.maps_to : "";
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

  // Keys the operator has already TAUGHT or SKIPPED this session — so the background poll never
  // re-appends a card on its way out before the server persist (bucket / dismissed) catches up.
  const handledRef = useRef<Set<string>>(new Set());

  const advance = () => {
    const cur = cards[0];
    if (cur) handledRef.current.add(cur.key);
    setCards((c) => c.slice(1));
    setDone((d) => d + 1);
  };

  // Background poll: APPEND newly-teachable cards to the END of the queue (never replace/reorder) so a
  // just-reviewed fill shows up without a refresh, WITHOUT disrupting the current card / open popups /
  // in-progress edits. Skips anything already queued or handled this session. Every 15s while visible.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/teach", { cache: "no-store" });
        if (stopped || !res.ok) return;
        const j = await res.json();
        if (stopped || !j?.ok || !Array.isArray(j.cards)) return;
        const fetched = j.cards as TeachCard[];
        setCards((prev) => {
          const have = new Set(prev.map((c) => c.key));
          const add = fetched.filter((c) => c && c.key && !have.has(c.key) && !handledRef.current.has(c.key));
          return add.length ? [...prev, ...add] : prev;
        });
      } catch {
        /* transient — the next tick retries */
      }
    };
    const id = setInterval(poll, 15000);
    const onFocus = () => poll();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    poll();
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Commit a confirmed change (from the confirm popup or the new-answer popup): persist the changed
  // store(s), then advance to the next card. Saves buckets first, then the profile.
  const commit = async (r: AddResult) => {
    setSaving(true);
    let ok = true;
    let err = "";
    // Persist FIRST; apply the optimistic store updates only on success, in the SAME batch that closes
    // the popup + advances. Updating `profile`/`buckets` while the confirm popup is STILL OPEN made it
    // re-render — the field now held the answer, so decideTeachRoute flipped "answer" → "wording" and
    // flashed a spurious "Remember wording — …" screen for the length of the save. (2026-07-23)
    if (r.buckets) {
      const res = await saveBuckets(r.buckets);
      if (!res.ok) {
        ok = false;
        err = res.error;
      }
    }
    if (ok && r.profile) {
      const res = await saveProfile(r.profile);
      if (!res.ok) {
        ok = false;
        err = res.error;
      }
    }
    setSaving(false);
    if (ok) {
      if (r.buckets) setBuckets(r.buckets);
      if (r.profile) {
        setProfile(r.profile);
        profileRef.current = r.profile;
      }
      liveSync("profile"); // taught answer persisted — push profile + buckets to a connected extension
      setNote(r.toast);
      setConfirm(null);
      setNewOpen(false);
      setPicker(false);
      advance();
    } else {
      setNote(`Couldn't save: ${err}`);
    }
  };

  const skip = () => {
    if (card) {
      const next = Array.from(new Set([...dismissed, card.key]));
      setDismissed(next);
      void saveDismissed(next);
      // keep the card so it shows in the "Skipped" section (restorable) without a refresh
      setSkipped((s) => (s.some((x) => x.key === card.key) ? s : [card, ...s]));
    }
    setNote(null);
    advance();
  };

  // Un-skip: drop the key from the dismissed set (persist), pull it out of the Skipped list, and
  // put the card back at the END of the active queue (so it never jumps the card you're on).
  const restore = (c: TeachCard) => {
    const next = dismissed.filter((k) => k !== c.key);
    setDismissed(next);
    void saveDismissed(next);
    handledRef.current.delete(c.key); // allow the background poll to see it again if it leaves the queue
    setSkipped((s) => s.filter((x) => x.key !== c.key));
    setCards((prev) => (prev.some((x) => x.key === c.key) ? prev : [...prev, c]));
    setNote(null);
  };

  // ── new-answer popup (shared with the profile page) ──
  const usedCustomCats = Array.from(
    new Set(buckets.filter((b) => !isModeA(b)).map((b) => (b.category || "").trim()).filter((c) => c && !BASE_CATEGORIES.includes(c) && c !== "Other")),
  );
  const categoryOptions = [...BASE_CATEGORIES, ...usedCustomCats, "Other"];
  const seedNewBucket = (): Bucket => ({
    id: "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    profile_path: "",
    value: card && card.answer.trim() !== "" ? [card.answer] : [],
    category: recCat || "Other",
    widget_hint: card && (card.widget === "radio" || card.widget === "checkbox") ? card.widget : "text",
    questions: card ? [card.question] : [],
    selectors: {},
  });
  const commitNew = (draft: Bucket) => {
    const ids = new Set(buckets.map((b) => b.id));
    let d = draft;
    if (ids.has(d.id)) d = { ...d, id: d.id + "_" + Math.random().toString(36).slice(2, 6) };
    void commit({ buckets: [...buckets, d], toast: "Saved as a new answer ✓" });
  };

  const pickTarget = (t: PickedTarget) => {
    setPicker(false);
    if (t.kind === "new") setNewOpen(true);
    else if (t.kind === "field") setConfirm({ target: { kind: "field", path: t.path, label: humanize(t.path) } });
    else setConfirm({ target: { kind: "existing", id: t.id } });
  };

  return (
    <div className="space-y-6">
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* LEFT — the current teach card */}
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

            {/* AI recommendation — where this answer maps. One primary "add to profile"; the popup confirms. */}
            {recLoading ? (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-hairline bg-panel-raised/30 px-3 py-2.5 text-xs text-ink-dim">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding the matching field…
              </div>
            ) : recPath ? (
              <div className="mt-4 rounded-lg border border-amber/30 bg-amber/5 px-3 py-2.5">
                <p className="text-xs text-ink-dim">
                  Looks like your <span className="font-medium text-ink">{humanize(recPath)}</span>
                  {recProfileValue ? (
                    <>
                      {" — "}your profile has <span className="font-mono text-ink">{recProfileValue}</span>{" "}
                      <span className="text-ink-faint">(highlighted on the right).</span>
                    </>
                  ) : (
                    <span className="text-ink-faint"> (highlighted on the right).</span>
                  )}
                </p>
                {/* blank-profile warning: the AI mapped this answer to a field that's empty in the profile */}
                {!recProfileValue && (
                  <p className="mt-1.5 text-xs text-signal">
                    ⚠ Your profile has no value for {humanize(recPath)} yet — adding your answer fills it next time.
                  </p>
                )}
                {fuzzy ? (
                  <p className="mt-1.5 text-xs text-signal">⚠ Matched by a near match (possible typo/variant) — verify it&apos;s the same answer.</p>
                ) : recProfileValue && !matches ? (
                  <p className="mt-1.5 text-xs text-ink-faint">Your answer differs from that field&apos;s value — confirm the change in the next step.</p>
                ) : null}
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button onClick={() => setConfirm({ target: { kind: "field", path: recPath, label: humanize(recPath) } })} className="btn-primary" disabled={saving}>
                    <Check className="h-4 w-4" />
                    Add to your {humanize(recPath)}
                  </button>
                  <button onClick={() => setPicker(true)} className="btn-ghost px-3 py-1.5 text-sm" disabled={saving}>
                    Wrong field?
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-hairline bg-panel-raised/30 px-3 py-2.5">
                <p className="text-xs text-ink-dim">
                  This looks like a <span className="font-medium text-ink">new answer</span> — no existing field matched.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button onClick={() => setNewOpen(true)} className="btn-primary" disabled={saving}>
                    <Plus className="h-4 w-4" />
                    Save as a new answer
                  </button>
                  <button onClick={() => setPicker(true)} className="btn-ghost px-3 py-1.5 text-sm" disabled={saving}>
                    <PenLine className="h-3.5 w-3.5" />
                    Choose a field…
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* RIGHT — the profile, physically displayed + editable in place */}
      <ProfilePanel
        profile={profile}
        highlightPath={recPath}
        note={panelNote}
        onOpenBucket={(path, label, widget) => setBucketPopup({ path, label, widget })}
        onOpenAnswer={(path, label) => setAnswerPopup({ path, label })}
      />

      {/* advanced options — the question wordings that map to a field's answer */}
      {bucketPopup && (
        <BucketFieldPopup
          path={bucketPopup.path}
          label={bucketPopup.label}
          widget={bucketPopup.widget}
          buckets={buckets}
          onBucketsChange={(next) => {
            setBuckets(next);
            void persistBuckets(next);
          }}
          onClose={() => setBucketPopup(null)}
        />
      )}

      {/* modify an answer (with the ladder, where one exists) */}
      {answerPopup && (
        <AnswerEditPopup
          profile={profile}
          path={answerPopup.path}
          label={answerPopup.label}
          onChange={onAnswerChange}
          onClose={closeAnswer}
        />
      )}

      {/* the "wrong field" chooser — pick a different field / saved answer / make new */}
      {picker && card && (
        <TargetPicker profile={profile} buckets={buckets} onPick={pickTarget} onClose={() => setPicker(false)} />
      )}

      {/* the END-STEP confirm — shows exactly what's added, highlighted, before it commits */}
      {confirm && card && (
        <TeachAddPopup
          target={confirm.target}
          card={card}
          buckets={buckets}
          profile={profile}
          saving={saving}
          onConfirm={commit}
          onClose={() => setConfirm(null)}
        />
      )}

      {/* a brand-new answer — the SAME popup the profile page uses, prefilled from the card */}
      {newOpen && card && (
        <RememberedAnswerPopup
          initial={seedNewBucket()}
          mode="add"
          title="Save as a new answer"
          categoryOptions={categoryOptions}
          onDone={commitNew}
          onCancel={() => setNewOpen(false)}
          onDelete={() => setNewOpen(false)}
        />
      )}
    </div>

      {/* SKIPPED — questions you passed on, collapsible, restorable back into the queue */}
      {skipped.length > 0 && (
        <div className="bezel p-5">
          <button
            type="button"
            onClick={() => setShowSkipped((v) => !v)}
            className="flex w-full items-center justify-between text-left"
          >
            <span className="flex items-center gap-2 text-sm text-ink">
              <SkipForward className="h-4 w-4 text-ink-dim" />
              Skipped ({skipped.length})
            </span>
            <ChevronDown className={"h-4 w-4 text-ink-dim transition-transform" + (showSkipped ? " rotate-180" : "")} />
          </button>
          {showSkipped && (
            <ul className="mt-4 space-y-2">
              {skipped.map((c) => (
                <li key={c.key} className="flex items-center gap-3 rounded-lg border border-hairline bg-panel-raised/40 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{c.question}</p>
                    <p className="truncate text-xs text-ink-dim">{c.answer}</p>
                  </div>
                  <button
                    onClick={() => restore(c)}
                    className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
                    disabled={saving}
                    title="Move back into the teach queue"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
