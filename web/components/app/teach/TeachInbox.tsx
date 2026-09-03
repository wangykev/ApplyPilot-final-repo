"use client";

import { useEffect, useRef, useState } from "react";
import { Check, SkipForward, Plus, Sparkles, ShieldAlert, Loader2, ChevronDown, RotateCcw, Trash2, PenLine } from "lucide-react";
import { BucketFieldPopup } from "@/components/form/BucketFieldPopup";
import { isModeA, type Bucket } from "@/lib/buckets";
import type { Profile } from "@/lib/profile-schema";
import {
  type TeachCard,
  sameAnswer,
  boolAnswerCandidates,
  fieldHoldsAnswer,
  profileValueAt,
  humanize,
  isFuzzyTier,
  looksLikeYesNoQuestion,
} from "@/lib/teach";
import { saveBuckets, saveProfile } from "@/app/app/profile/actions";
import { liveSync } from "@/lib/extension-sync";
import { saveDismissed, saveDeleted, recommendField, captureEssay, type FieldRecommendation } from "@/app/app/teach/actions";
import { essayShapeOk } from "@/lib/essays";
import { ProfilePanel } from "@/components/app/teach/ProfilePanel";
import { AnswerEditPopup } from "@/components/app/teach/AnswerEditPopup";
import { TeachAddPopup, type ConfirmTarget, type AddResult } from "@/components/app/teach/TeachAddPopup";
import { RememberedAnswerPopup } from "@/components/app/RememberedAnswerPopup";

// Categories a new remembered answer can carry (fixed set + any custom already in use + "Other").
const BASE_CATEGORIES = ["Screening", "Work authorization", "Demographics", "Personal", "Experience", "Education"];

export function TeachInbox({
  initialCards,
  initialSkipped,
  initialBuckets,
  initialDismissed,
  initialDeleted,
  profile: initialProfile,
}: {
  initialCards: TeachCard[];
  initialSkipped: TeachCard[];
  initialBuckets: Bucket[];
  initialDismissed: string[];
  initialDeleted: string[];
  profile: Profile;
}) {
  const [cards, setCards] = useState<TeachCard[]>(initialCards);
  const [done, setDone] = useState(0);
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets);
  const [dismissed, setDismissed] = useState<string[]>(initialDismissed);
  // Cards the user SKIPPED — shown in a collapsible "Skipped" section so they can be restored.
  const [skipped, setSkipped] = useState<TeachCard[]>(initialSkipped);
  const [showSkipped, setShowSkipped] = useState(false);
  // Permanently-deleted skipped keys (subset of `dismissed`, hidden from the Skipped section too).
  const [deleted, setDeleted] = useState<string[]>(initialDeleted);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // the two add surfaces: the end-step confirm popup (a chosen target), and the shared new-answer
  // popup (identical to the profile page's "Add remembered answer").
  const [confirm, setConfirm] = useState<{ target: ConfirmTarget } | null>(null);
  // RETARGET (2026-07-25, operator): "Wrong field?" points at the profile ALREADY shown on the right
  // instead of opening a search popup over it. The search-all-fields popup is GONE entirely
  // (operator 2026-08-02: "the all fields popup is not needed") — when the AI's suggestion is wrong
  // or hallucinated, the two useful moves are click the right field on the right, or CREATE a new
  // field for it — both offered inline in retarget mode — and a searchable list of every existing
  // field was neither.
  const [retarget, setRetarget] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // Editing an EXISTING remembered answer from the profile panel. Its question wordings and its
  // answer ladder live in the same bucket, so one editor serves both clicks (operator 2026-08-02).
  // Index into `buckets`, NOT a copy — the popup edits a draft and commits on Done.
  const [remEdit, setRemEdit] = useState<number | null>(null);
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
  // Boolean-aware: a "Yes"/"True" card answer matches a true triBool field, a tiered array matches ANY
  // candidate, etc. (sameAnswer vs the collapsed display string would falsely read "differs" for yes/no).
  const matches = !!recPath && fieldHoldsAnswer(profile, recPath, card?.answer || "");

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
      advance();
    } else {
      setNote(`Couldn't save: ${err}`);
    }
  };

  // Save this answer into the essay library instead of teaching it as a remembered answer.
  //
  // ⚠ A long answer is a BAD remembered answer and a GOOD voice sample, which is why this exists as
  // its own action rather than as an extra checkbox on the teach popup. A remembered answer fills by
  // EXACT question wording, and an essay question is never worded the same way twice — so teaching
  // this as one would almost never match, and on the rare day it did it would replay a stale,
  // verbatim project list into a differently-worded question. The essay library is the other shape:
  // never replayed, only ever shown to the model as "this is how I write".
  //
  // Auto-capture cannot reach these. It fires inside the review editor's `commit()`, so it only ever
  // sees an answer being typed FROM NOW ON — every essay already sitting in a past bundle (i.e. all
  // of them, the day this shipped) needs a hand to bring it across.
  //
  // Saving SKIPS the card afterwards, so the same answer does not keep nagging as a remembered
  // answer once it has a better home. Skip is restorable from the Skipped section, so this is not a
  // one-way door.
  const saveAsEssay = async () => {
    if (!card) return;
    setSaving(true);
    setNote(null);
    const res = await captureEssay({
      question: card.question,
      text: card.answer,
      company: card.company || "",
      source: "manual",
    });
    setSaving(false);
    if (res.ok) {
      liveSync("profile");   // the extension reads the library from storage; push it like any profile edit
      // ⚠ ORDER: `skip` clears the note itself, so the confirmation has to be written AFTER it or the
      // save looks like it did nothing. Both land in one React batch, so the later write is what shows.
      skip();
      setNote("Saved to your essays");
    } else {
      setNote(`Couldn't save: ${res.error}`);
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

  // Delete ALL skipped: permanently discard them. They stay in `dismissed` (out of the active queue)
  // and are added to `deleted` so they're hidden from the Skipped section too — no restore path, and
  // they won't resurface on reload (the teach page renders Skipped as dismissed − deleted). One write.
  const clearSkipped = async () => {
    const keys = skipped.map((c) => c.key);
    if (keys.length === 0) {
      setConfirmClear(false);
      return;
    }
    setSaving(true);
    const nextDeleted = Array.from(new Set([...deleted, ...keys]));
    const r = await saveDeleted(nextDeleted);
    setSaving(false);
    if (r.ok) {
      setDeleted(nextDeleted);
      keys.forEach((k) => handledRef.current.add(k)); // belt-and-suspenders: never re-append via the poll
      setSkipped([]);
      setConfirmClear(false);
      setShowSkipped(false);
      setNote(`Deleted ${keys.length} skipped ✓`);
    } else {
      setNote(`Couldn't save: ${r.error}`);
    }
  };

  // ── new-answer popup (shared with the profile page) ──
  const usedCustomCats = Array.from(
    new Set(buckets.filter((b) => !isModeA(b)).map((b) => (b.category || "").trim()).filter((c) => c && !BASE_CATEGORIES.includes(c) && c !== "Other")),
  );
  const categoryOptions = [...BASE_CATEGORIES, ...usedCustomCats, "Other"];
  const seedNewBucket = (): Bucket => ({
    id: "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    profile_path: "",
    // A yes/no / checkbox answer stores BOTH labelings (["Yes","True"] / ["No","False"]) so the saved
    // answer resolves whether a tenant renders the option as Yes/No or True/False; other answers pass
    // through unchanged. (Mode-A teaches already get this — they set a boolean profile field.)
    value: card ? boolAnswerCandidates(card.answer) : [],
    category: recCat || "Other",
    // ⚠ A YES/NO QUESTION DEFAULTS TO "Yes / No", NOT Text (operator, 2026-09-03). Only the source
    // card's WIDGET was consulted, so a yes/no question a tenant rendered as a dropdown (or one
    // whose card carried no widget at all) seeded as free Text — and the operator then had to
    // notice and change the Answer type by hand on every such field. The question and its approved
    // answer are the evidence; see looksLikeYesNoQuestion for why the answer is the stronger of the
    // two and why the wording test anchors on a leading auxiliary verb.
    // "radio" is this popup's value for Yes / No (ANSWER_WIDGETS, RememberedAnswerPopup).
    widget_hint: card && (card.widget === "radio" || card.widget === "checkbox")
      ? card.widget
      : (card && looksLikeYesNoQuestion(card.question, card.answer) ? "radio" : "text"),
    questions: card ? [card.question] : [],
    selectors: {},
  });
  // Save an edited remembered answer in place. Persisted through the SAME commit() the teach card
  // uses, so it saves, live-syncs to the extension and shows the same toast — but it must NOT
  // advance the queue: editing the profile panel is not answering the current card.
  const commitRemEdit = (draft: Bucket) => {
    const i = remEdit;
    setRemEdit(null);
    if (i == null) return;
    const next = buckets.map((b, j) => (j === i ? draft : b));
    setBuckets(next);
    void persistBuckets(next);
  };
  const deleteRemEdit = () => {
    const i = remEdit;
    setRemEdit(null);
    if (i == null) return;
    const next = buckets.filter((_, j) => j !== i);
    setBuckets(next);
    void persistBuckets(next);
  };

  const commitNew = (draft: Bucket) => {
    const ids = new Set(buckets.map((b) => b.id));
    let d = draft;
    if (ids.has(d.id)) d = { ...d, id: d.id + "_" + Math.random().toString(36).slice(2, 6) };
    void commit({ buckets: [...buckets, d], toast: "Saved as a new answer ✓" });
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

            {/* An essay-shaped answer belongs in the essay library, NOT in a remembered answer — a
                remembered answer matches on exact question wording, which an essay question never
                repeats. Offered here because auto-capture only sees answers typed from now on. */}
            {essayShapeOk(card.answer, card.widget) && (
              <div className="mt-4 flex flex-wrap items-start gap-3 rounded-lg border border-hairline bg-panel-raised/30 px-3 py-2.5">
                <PenLine className="mt-0.5 h-4 w-4 shrink-0 text-ink-dim" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">This looks like an essay you wrote</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-dim">
                    Save it to your essay library and future long answers get drafted in your voice — and may
                    reuse concrete facts from it. It won&apos;t be replayed onto a form verbatim.
                  </p>
                </div>
                <button onClick={saveAsEssay} className="btn-primary shrink-0" disabled={saving}>
                  <PenLine className="h-3.5 w-3.5" />
                  Save as essay
                </button>
              </div>
            )}

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
                  <button onClick={() => setRetarget(true)} className="btn-ghost px-3 py-1.5 text-sm" disabled={saving || retarget}>
                    {retarget ? "Pick a field on the right →" : "Wrong field?"}
                  </button>
                  {/* The AI's field is wrong, and the RIGHT one may not exist yet — the answer belongs
                      nowhere on the profile. Offer creating it here, next to "pick one on the right",
                      so both moves are visible at the moment the operator has rejected the guess
                      (operator 2026-08-02). Same popup the no-match card uses. */}
                  {retarget && (
                    <button onClick={() => { setRetarget(false); setNewOpen(true); }} className="btn-ghost px-3 py-1.5 text-sm" disabled={saving}>
                      <Plus className="h-3.5 w-3.5" />
                      Create new field
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-hairline bg-panel-raised/30 px-3 py-2.5">
                <p className="text-xs text-ink-dim">
                  This looks like a <span className="font-medium text-ink">new answer</span> — no existing field matched.
                  Save it as its own answer, or file it under something you already have.
                </p>
                {/* "No match" is the AI's guess, and it is wrong often enough to be worth doubting —
                    live it offered "Carnegie Mellon University" as a NEW answer while
                    education.0.school_or_university sat right there (operator 2026-08-02). This card
                    used to have no route into select mode at all, so the only move it offered was the
                    wrong one. */}
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button onClick={() => setNewOpen(true)} className="btn-primary" disabled={saving}>
                    <Plus className="h-4 w-4" />
                    Save as a new answer
                  </button>
                  <button onClick={() => setRetarget(true)} className="btn-ghost px-3 py-1.5 text-sm" disabled={saving || retarget}>
                    {retarget ? "Pick one on the right →" : "Use an existing field"}
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
        buckets={buckets}
        onOpenRemembered={(i) => setRemEdit(i)}
        highlightPath={recPath}
        note={panelNote}
        onOpenBucket={(path, label, widget) => setBucketPopup({ path, label, widget })}
        onOpenAnswer={(path, label) => setAnswerPopup({ path, label })}
        selectMode={retarget}
        onCancelSelect={() => setRetarget(false)}
        onSelectPath={(path) => { setRetarget(false); setConfirm({ target: { kind: "field", path, label: humanize(path) } }); }}
        onSelectRemembered={(i) => { const b = buckets[i]; if (!b) return; setRetarget(false); setConfirm({ target: { kind: "existing", id: b.id } }); }}
      />

      {/* question bucket — the question wordings that map to a field's answer (the ANSWER LADDER is a
          separate thing, reached by clicking the answer → AnswerEditPopup) */}
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

      {/* EDIT an existing remembered answer, opened from the profile panel — same editor as Add, so
          the question WORDINGS and the answer LADDER are edited in one place. */}
      {remEdit != null && buckets[remEdit] && (
        <RememberedAnswerPopup
          initial={buckets[remEdit]}
          mode="edit"
          title="Edit remembered answer"
          categoryOptions={categoryOptions}
          onDone={commitRemEdit}
          onCancel={() => setRemEdit(null)}
          onDelete={deleteRemEdit}
        />
      )}
    </div>

      {/* SKIPPED — questions you passed on, collapsible, restorable back into the queue */}
      {skipped.length > 0 && (
        <div className="bezel p-5">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => { setConfirmClear(false); setShowSkipped((v) => !v); }}
              className="flex flex-1 items-center gap-2 text-left text-sm text-ink"
            >
              <SkipForward className="h-4 w-4 text-ink-dim" />
              Skipped ({skipped.length})
              <ChevronDown className={"h-4 w-4 text-ink-dim transition-transform" + (showSkipped ? " rotate-180" : "")} />
            </button>
            {/* Delete all — only while the list is EXPANDED (permanently discards every skipped card; two-click confirm) */}
            {showSkipped &&
              (confirmClear ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-ink-dim">Delete all {skipped.length}?</span>
                  <button onClick={clearSkipped} className="btn-ghost px-2 py-1 text-xs text-signal" disabled={saving} title="Permanently remove all skipped">
                    {saving ? "Deleting…" : "Confirm"}
                  </button>
                  <button onClick={() => setConfirmClear(false)} className="btn-ghost px-2 py-1 text-xs" disabled={saving}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  className="btn-ghost shrink-0 px-2 py-1 text-xs text-ink-dim hover:text-signal"
                  disabled={saving}
                  title="Permanently remove all skipped questions"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete all
                </button>
              ))}
          </div>
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
