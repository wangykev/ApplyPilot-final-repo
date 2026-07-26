import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBucketEligibleWidget,
  profileValueAt,
  teachableCards,
  coveredKeys,
  sameAnswer,
  addWordingToBucket,
  boolAnswerCandidates,
  isBoolAnswer,
  seedLadderDraft,
  setLadderList,
  setFieldVariants,
  ensureModeABucket,
  createModeBBucket,
  bucketLabel,
  humanize,
  flattenProfileFields,
  isFuzzyTier,
  dottedPath,
  fieldHoldsAnswer,
  decideTeachRoute,
  decideTeachPlan,
  ensureDefaultFieldWordings,
  bucketHasWording,
  fieldIsEmpty,
  wasManuallyEdited,
  type TeachSource,
} from "@/lib/teach";
import { ensureStarterBuckets, STARTER_BUCKETS, type Bucket } from "@/lib/buckets";
import type { ReviewEntry, ReviewBundle } from "@/lib/review-summary";

const bucket = (over: Partial<Bucket>): Bucket => ({
  id: "b", profile_path: "", value: [], category: "", widget_hint: "text", questions: [], selectors: {}, ...over,
});
const entry = (over: Partial<ReviewEntry>): ReviewEntry => ({
  field_id: "f", question_label: "Q?", widget_type: "dropdown", flag: "ai-choice", needs_review: true, is_approved: true, current_value: "Yes", ...over,
});
const bundle = (entries: ReviewEntry[]): ReviewBundle => ({ entries });
const src = (id: string, entries: ReviewEntry[], company?: string): TeachSource => ({ id, company: company ?? null, bundle: bundle(entries) });

test("isBucketEligibleWidget: choice + short text + checkbox yes; essay/file/unknown no", () => {
  for (const w of ["text", "dropdown", "radio", "typeahead", "checkbox"]) assert.equal(isBucketEligibleWidget(w), true, w);
  for (const w of ["textarea", "file_upload", "unknown", "", null, undefined]) assert.equal(isBucketEligibleWidget(w), false, String(w));
});

test("profileValueAt: nested path; a tiered array → its first candidate; missing → ''", () => {
  const p = { personal_info: { city: "Chicago" }, work_authorization: { citizenship_country: ["United States of America", "United States"] } };
  assert.equal(profileValueAt(p, "personal_info.city"), "Chicago");
  assert.equal(profileValueAt(p, "work_authorization.citizenship_country"), "United States of America");
  assert.equal(profileValueAt(p, "personal_info.missing"), "");
  assert.equal(profileValueAt(p, ""), "");
  // a path landing on an OBJECT or array-of-objects (a whole repeating section) → "" (never "[object Object]")
  assert.equal(profileValueAt({ education: [{ degree: "BS" }] }, "education"), "", "array-of-objects → ''");
  assert.equal(profileValueAt({ personal_info: { city: "X" } }, "personal_info"), "", "nested object → ''");
});

test("coveredKeys: wordings from ANSWERABLE buckets only (an empty/unanswered bucket does NOT cover)", () => {
  // Mode-B with a value, and Mode-A whose bound profile field is set → both cover their wordings.
  const answerable = coveredKeys(
    [
      bucket({ questions: ["Are you over 18?*"], value: ["Yes"] }),
      bucket({ id: "g", profile_path: "self_identification.gender", questions: ["Gender"] }),
    ],
    { self_identification: { gender: "Male" } },
  );
  assert.equal(answerable.has("are you over 18?"), true); // trailing * + case stripped
  assert.equal(answerable.has("gender"), true);
  // An EMPTY Mode-B (no value) and a Mode-A bound to an UNSET/removed field do NOT cover — the
  // questions resurface in teach (the over_18-starter-bound-to-empty-profile case this fixes).
  const empty = coveredKeys(
    [
      bucket({ questions: ["Are you over 18?*"], value: [] }),
      bucket({ id: "a18", profile_path: "screening.at_least_18_years_old", questions: ["Are you at least 18 years of age?"] }),
    ],
    { screening: {} },
  );
  assert.equal(empty.has("are you over 18?"), false);
  assert.equal(empty.has("are you at least 18 years of age?"), false);
});

test("boolAnswerCandidates: yes/no/true/false/checkbox answers expand to BOTH labelings; others pass through", () => {
  // A taught yes/no or checkbox answer must resolve whether a tenant labels the option Yes/No or
  // True/False — so a standalone (Mode-B) bucket stores the tiered pair.
  for (const y of ["Yes", "yes", "true", "TRUE", "checked", "on"]) assert.deepEqual(boolAnswerCandidates(y), ["Yes", "True"], y);
  for (const n of ["No", "no", "false", "FALSE", "unchecked", "off"]) assert.deepEqual(boolAnswerCandidates(n), ["No", "False"], n);
  // a non-boolean answer passes through unchanged; empty → []
  assert.deepEqual(boolAnswerCandidates("Blue"), ["Blue"]);
  assert.deepEqual(boolAnswerCandidates("  Chicago "), ["Chicago"]);
  assert.deepEqual(boolAnswerCandidates(""), []);
});

test("sameAnswer: caps/whitespace insensitive; different → false; empty → false", () => {
  assert.equal(sameAnswer("United States", " united  states "), true);
  assert.equal(sameAnswer("Yes", "No"), false);
  assert.equal(sameAnswer("", ""), false);
});

test("teachableCards: an approved AI answer becomes a card with the maps_to hint + profile value", () => {
  const profile = { self_identification: { gender: "Male" } };
  const apps = [src("a1", [
    entry({ question_label: "What is your gender?", flag: "ai-eeo-guess", current_value: "Male", maps_to: "self_identification.gender", suggested_category: "Demographics" }),
  ])];
  const cards = teachableCards(apps, [], profile);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].question, "What is your gender?");
  assert.equal(cards[0].answer, "Male");
  assert.equal(cards[0].maps_to, "self_identification.gender");
  assert.equal(cards[0].profile_value, "Male");
  assert.equal(cards[0].sensitive, true); // eeo flag → sensitive
});

test("teachableCards: excludes non-approved / deterministic / essay / empty / already-covered / dismissed; includes any REVIEWED field (not only AI); dedups", () => {
  const mk = (over: Partial<ReviewEntry>) => entry({ question_label: "Reliable transport?", widget_type: "radio", current_value: "Yes", ...over });
  assert.equal(teachableCards([src("a", [mk({ is_approved: false })])], [], {}).length, 0, "not approved");
  assert.equal(teachableCards([src("a", [mk({ needs_review: false })])], [], {}).length, 0, "filled deterministically (no review)");
  assert.equal(teachableCards([src("a", [mk({ widget_type: "textarea" })])], [], {}).length, 0, "essay excluded");
  assert.equal(teachableCards([src("a", [mk({ current_value: "" })])], [], {}).length, 0, "empty value");
  assert.equal(teachableCards([src("a", [mk({})])], [bucket({ questions: ["Reliable transport?"], value: ["Yes"] })], {}).length, 0, "already covered by an ANSWERABLE bucket");
  assert.equal(teachableCards([src("a", [mk({})])], [bucket({ questions: ["Reliable transport?"], value: [] })], {}).length, 1, "an EMPTY bucket with the wording does NOT cover → resurfaces (removed-profile-field notify)");
  assert.equal(teachableCards([src("a", [mk({})])], [], {}, ["reliable transport?"]).length, 0, "dismissed");
  assert.equal(teachableCards([src("a", [mk({ flag: null })])], [], {}).length, 1, "a REVIEWED non-AI field is teachable too (Req B)");
  assert.equal(teachableCards([src("a", [mk({})]), src("b", [mk({})])], [], {}).length, 1, "dedup across apps");
});

test("teachableCards: #4 — an AI-filled question still teaches even if a bucket nominally covers it", () => {
  // The bucket has a value (so it 'covers' the wording), but the fill was AI (the saved value didn't
  // match THIS tenant's options) → surface it so the operator can add the tenant's variant.
  const bkt = bucket({ id: "edu", questions: ["Highest level of education"], value: ["Bachelor's Degree"] });
  const aiEntry = entry({ question_label: "Highest level of education", widget_type: "dropdown", flag: "ai-choice", current_value: "Undergraduate Degree", is_approved: true, needs_review: true });
  assert.equal(teachableCards([src("a", [aiEntry])], [bkt], {}).length, 1, "AI fill surfaces despite the covering bucket (#4)");
  // A clean/fuzzy BUCKET fill (flag 'bucket') of the SAME covered question stays hidden — the bucket works.
  const bucketEntry = entry({ question_label: "Highest level of education", widget_type: "dropdown", flag: "bucket", current_value: "Bachelor's Degree", is_approved: true, needs_review: true });
  assert.equal(teachableCards([src("b", [bucketEntry])], [bkt], {}).length, 0, "a bucket fill of a covered question stays hidden");
  // And a skipped AI fill stays skipped even though it's covered+AI.
  assert.equal(teachableCards([src("a", [aiEntry])], [bkt], {}, ["highest level of education"]).length, 0, "dismissed still wins");
});

test("teachableCards: #4 resurface fix — a TAUGHT AI card stays gone even though its bundle keeps the ai-* flag", () => {
  // The bug: the operator teaches an AI-filled card (its value is now in a covering bucket), but the
  // stored bundle entry keeps flag ai-* forever, so re-approving / reloading the SAME bundle resurfaced
  // it. The fix: an AI card is hidden once the covering bucket HOLDS the filled value.
  const aiEntry = entry({ question_label: "Highest level of education", widget_type: "dropdown", flag: "ai-choice", current_value: "Undergraduate Degree", is_approved: true, needs_review: true });
  const apps = [src("a", [aiEntry])];
  // Before teaching: a bucket covers the wording but holds a DIFFERENT value → still surfaces (#4).
  const before = bucket({ id: "edu", questions: ["Highest level of education"], value: ["Bachelor's Degree"] });
  assert.equal(teachableCards(apps, [before], {}).length, 1, "value-mismatch bucket → still surfaces");
  // After teaching (Mode-B): the filled value is now in the bucket's candidates → gone, and STAYS gone
  // when the SAME (still-ai-flagged) bundle is re-approved.
  const taughtB = bucket({ id: "edu", questions: ["Highest level of education"], value: ["Bachelor's Degree", "Undergraduate Degree"] });
  assert.equal(teachableCards(apps, [taughtB], {}).length, 0, "taught (Mode-B value added) → gone");
  assert.equal(teachableCards(apps, [taughtB], {}).length, 0, "re-approve the same bundle → still gone");
  // After teaching (Mode-A): the bound profile field now holds the value → gone.
  const taughtA = bucket({ id: "edu", profile_path: "education[0].degree", questions: ["Highest level of education"] });
  assert.equal(teachableCards(apps, [taughtA], { education: [{ degree: ["Undergraduate Degree"] }] }).length, 0, "taught (Mode-A field holds it) → gone");
});

test("teachableCards: resurface fix is bucket-agnostic — the user's OWN field / OWN new answer closes it, not just the AI's suggestion", () => {
  // The card's AI hint (maps_to) points at "self_identification.gender", but the operator DISAGREES and
  // files it under their OWN chosen field / their OWN new standalone answer. Coverage is decided by which
  // bucket actually HOLDS the value — never by the AI's suggestion — so any of these close the card.
  const ai = entry({ question_label: "Which best describes you?", widget_type: "dropdown", flag: "ai-choice", current_value: "Prefer to self-describe", is_approved: true, needs_review: true, maps_to: "self_identification.gender" });
  const apps = [src("a", [ai])];
  assert.equal(teachableCards(apps, [], {}).length, 1, "untaught → surfaces");
  // (a) filed under a DIFFERENT profile field than the AI suggested (Mode-A) → gone
  const ownField = bucket({ id: "own", profile_path: "self_identification.custom", questions: ["Which best describes you?"] });
  assert.equal(teachableCards(apps, [ownField], { self_identification: { custom: "Prefer to self-describe" } }).length, 0, "own field holds it → gone");
  // (b) saved as the user's OWN brand-new standalone answer (Mode-B, seeded with the answer) → gone
  const ownNew = bucket({ id: "mine", questions: ["Which best describes you?"], value: ["Prefer to self-describe"], category: "Demographics" });
  assert.equal(teachableCards(apps, [ownNew], {}).length, 0, "own new answer holds it → gone");
  // (c) filed under an existing answer WITHOUT adding the value (the value doesn't match) → still surfaces:
  //     the bucket wouldn't reproduce the answer, so it isn't truly taught yet (tick "also add to options").
  const wordingOnly = bucket({ id: "other", questions: ["Which best describes you?"], value: ["Man"] });
  assert.equal(teachableCards(apps, [wordingOnly], {}).length, 1, "wording filed but value absent → not yet covered");
});

test("teachableCards: recommends the matching Mode-A bucket's field via bucket_path (not the AI maps_to)", () => {
  // over_18-style: an EMPTY Mode-A bucket bound to screening.at_least_18_years_old; the AI filled the
  // question and (wrongly) stamped maps_to "education". The card must recommend the BUCKET's field,
  // and show it as empty (not "[object Object]" from the education array-of-objects).
  const bkt = bucket({ id: "a18", profile_path: "screening.at_least_18_years_old", questions: ["Are you over the age of 18?"] });
  const aiEntry = entry({ question_label: "Are you over the age of 18?*", widget_type: "dropdown", flag: "ai-choice-sensitive", current_value: "Yes", is_approved: true, needs_review: true, maps_to: "education" });
  const cards = teachableCards([src("a", [aiEntry])], [bkt], { screening: {} });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].bucket_path, "screening.at_least_18_years_old", "recommends the bucket's bound field");
  assert.equal(cards[0].profile_value, "", "the bound field is empty → '' (not [object Object])");
});

test("teachableCards: a repeating entry's AI-filled field TEACHES; a deterministically-filled one does NOT", () => {
  // Operator rule (2026-07-21): the AI/manually-supplied field of a repeating entry is worth learning
  // (an AI-canonicalized education[0].degree teaches), but a clean deterministic fill isn't (already known).
  const aiRep = entry({ question_label: "Degree", flag: "ai-canonicalized", needs_review: true, is_approved: true, current_value: "Bachelors", canonical_field: "education[0].degree" });
  assert.equal(teachableCards([src("a", [aiRep])], [], {}).length, 1, "an AI-filled repeating field teaches");
  const detRep = entry({ question_label: "School", flag: null, needs_review: false, is_edited: false, current_value: "CMU", canonical_field: "education[0].school_or_university" });
  assert.equal(teachableCards([src("b", [detRep])], [], {}).length, 0, "a clean deterministic repeating field does NOT teach (already known)");
});

test("dottedPath: bracketed indexes → dots; flat paths unchanged", () => {
  assert.equal(dottedPath("education[0].degree"), "education.0.degree");
  assert.equal(dottedPath("certifications[1].specialties[0].specialty"), "certifications.1.specialties.0.specialty");
  assert.equal(dottedPath("self_identification.gender"), "self_identification.gender");
  assert.equal(dottedPath(""), "");
  assert.equal(dottedPath(null), "");
});

test("teachableCards: a repeating field's BRACKETED path is dotted-normalized → resolves the profile value (not 'no value')", () => {
  // The degree bug: canonical_field "education[0].degree" didn't resolve (split-on-'.') so the card read
  // "no value" + never highlighted. Dotted-normalized, it resolves the real profile value.
  const profile = { education: [{ degree: ["Bachelor of Science"] }] };
  const cards = teachableCards(
    [src("a", [entry({ question_label: "Degree", widget_type: "dropdown", flag: "ai-canonicalized", current_value: "Bachelors", canonical_field: "education[0].degree" })])],
    [],
    profile,
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].canonical_field, "education.0.degree", "bracketed → dotted");
  assert.equal(cards[0].profile_value, "Bachelor of Science", "resolves the profile value → NOT 'no value'");
});

test("wasManuallyEdited: override / filled_blank → true; cleared / added_entry / not-edited → false", () => {
  assert.equal(wasManuallyEdited(entry({ is_edited: true, edit_kind: "override" })), true);
  assert.equal(wasManuallyEdited(entry({ is_edited: true, edit_kind: "filled_blank" })), true);
  assert.equal(wasManuallyEdited(entry({ is_edited: true, edit_kind: null })), true); // edited, kind unset
  assert.equal(wasManuallyEdited(entry({ is_edited: true, edit_kind: "cleared" })), false); // now empty
  assert.equal(wasManuallyEdited(entry({ is_edited: true, edit_kind: "added_entry" })), false); // a new row, not a Q→A
  assert.equal(wasManuallyEdited(entry({ is_edited: false })), false);
});

test("teachableCards: a MANUALLY-EDITED clean fill (needs_review=false) is teachable too", () => {
  const mk = (over: Partial<ReviewEntry>) =>
    entry({ question_label: "Preferred name?", widget_type: "text", needs_review: false, flag: null, current_value: "Sam", ...over });
  // a clean deterministic fill the human DIDN'T touch → not teachable (already known)
  assert.equal(teachableCards([src("a", [mk({})])], [], {}).length, 0, "untouched clean fill skipped");
  // the human OVERRODE the clean fill on review → now teachable
  assert.equal(teachableCards([src("a", [mk({ is_edited: true, edit_kind: "override" })])], [], {}).length, 1, "override teaches");
  // the edit RESET approval (is_approved=false) — it STILL teaches (the user's own typed answer; #4)
  assert.equal(teachableCards([src("a", [mk({ is_edited: true, edit_kind: "override", is_approved: false })])], [], {}).length, 1, "an edit that reset approval still teaches");
  // a filled-in blank → teachable
  assert.equal(teachableCards([src("a", [mk({ is_edited: true, edit_kind: "filled_blank" })])], [], {}).length, 1, "filled_blank teaches");
  // a cleared field (now empty) → excluded (no value to remember)
  assert.equal(teachableCards([src("a", [mk({ is_edited: true, edit_kind: "cleared", current_value: "" })])], [], {}).length, 0, "cleared skipped");
});

test("addWordingToBucket: adds to the right bucket, dedups by normalize, leaves others", () => {
  const bs = [bucket({ id: "x", questions: ["Q one"] }), bucket({ id: "y", questions: [] })];
  const out = addWordingToBucket(bs, "x", "Q TWO");
  assert.deepEqual(out[0].questions, ["Q one", "Q TWO"]);
  assert.deepEqual(out[1].questions, []);
  assert.deepEqual(addWordingToBucket(out, "x", "q one ")[0].questions, ["Q one", "Q TWO"], "dedup by normalize");
});

test("ensureModeABucket: an existing path returns it; a new path creates a Mode-A bucket", () => {
  const bs = [bucket({ id: "existing", profile_path: "self_identification.gender" })];
  const r1 = ensureModeABucket(bs, "self_identification.gender", "dropdown");
  assert.equal(r1.bucketId, "existing");
  assert.equal(r1.buckets.length, 1);
  const r2 = ensureModeABucket(bs, "work_authorization.authorized_to_work_in_us", "radio");
  assert.equal(r2.buckets.length, 2);
  const nb = r2.buckets.find((b) => b.id === r2.bucketId)!;
  assert.equal(nb.profile_path, "work_authorization.authorized_to_work_in_us");
  assert.equal(nb.widget_hint, "radio");
});

test("createModeBBucket: unique id, filters empty candidates, defaults category", () => {
  const r1 = createModeBBucket([], { question: "Clearance?", value: ["No", ""], category: "", widget_hint: "radio" });
  const b1 = r1.buckets.find((b) => b.id === r1.bucketId)!;
  assert.deepEqual(b1.value, ["No"]);
  assert.equal(b1.category, "Other");
  assert.deepEqual(b1.questions, ["Clearance?"]);
  assert.equal(b1.profile_path, "");
  const r2 = createModeBBucket(r1.buckets, { question: "Clearance?", value: ["Yes"], category: "Screening", widget_hint: "radio" });
  assert.notEqual(r2.bucketId, r1.bucketId, "second create of the same question gets a distinct id");
});

test("bucketLabel: Mode-A shows the path; Mode-B shows the first wording", () => {
  assert.equal(bucketLabel(bucket({ profile_path: "personal_info.city" })), "personal_info.city");
  assert.equal(bucketLabel(bucket({ profile_path: "", questions: ["Do you have a clearance?"] })), "Do you have a clearance?");
});

test("humanize: last segment, snake → Title Case, strips [i]", () => {
  assert.equal(humanize("self_identification.gender"), "Gender");
  assert.equal(humanize("work_authorization.authorized_to_work_in_us"), "Authorized To Work In Us");
  assert.equal(humanize("work_experience[0].job_title"), "Job Title");
});

test("flattenProfileFields: object sections + repeating entries (per-entry, dotted paths); string-arrays/websites skipped", () => {
  const profile = {
    schema_version: "2.0",
    personal_info: { first_name: "Ada", has_preferred_name: true, country: ["United States of America", "United States"] },
    education: [
      { school_or_university: "CMU", degree: ["Bachelor of Science", "Bachelors"] },
      { school_or_university: "MIT" },
    ],
    certifications: [{ certification: "CPP", specialties: [{ specialty: "x" }] }],
    websites: [{ type: "LinkedIn", url: "https://x" }],
    skills: ["ts", "react"],
  };
  const rows = flattenProfileFields(profile);
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  // object sections (unchanged)
  assert.equal(byPath["personal_info.first_name"].value, "Ada");
  assert.equal(byPath["personal_info.first_name"].sectionLabel, "Personal Info");
  assert.equal(byPath["personal_info.has_preferred_name"].value, "Yes"); // boolean → Yes
  assert.equal(byPath["personal_info.country"].value, "United States of America"); // tiered → first
  // repeating sections → per-entry rows, DOTTED index paths, one section group per entry
  assert.equal(byPath["education.0.school_or_university"].value, "CMU");
  assert.equal(byPath["education.0.school_or_university"].sectionLabel, "Education · 1");
  assert.equal(byPath["education.0.degree"].value, "Bachelor of Science", "tiered → first");
  assert.equal(byPath["education.1.school_or_university"].value, "MIT");
  assert.equal(byPath["education.1.school_or_university"].sectionLabel, "Education · 2");
  assert.equal(byPath["certifications.0.certification"].value, "CPP");
  assert.equal(byPath["certifications.0.specialties"], undefined, "a nested array-of-objects (specialties) is skipped");
  // still handled by ProfilePanel's own boxes → NOT auto-flattened here
  assert.equal(rows.find((r) => r.section.startsWith("websites")), undefined, "websites shown by its own box, not per-entry rows");
  assert.equal(rows.find((r) => r.section === "skills"), undefined, "top-level string array skipped");
  assert.equal(rows.find((r) => r.section === "schema_version"), undefined, "top-level scalar skipped");
});

test("loop closes: teach a card (file under the recommended field) → it's covered → no longer in the queue", () => {
  const profile = { work_authorization: { authorized_to_work_in_us: "Yes" } };
  const apps = [src("a", [
    entry({ question_label: "Authorized to work in the US?", widget_type: "radio", flag: "ai-choice-sensitive", current_value: "Yes", maps_to: "work_authorization.authorized_to_work_in_us" }),
  ])];
  let buckets: Bucket[] = [];
  const before = teachableCards(apps, buckets, profile);
  assert.equal(before.length, 1);
  const card = before[0];
  // what fileUnder(card.maps_to) does in the UI:
  const { buckets: withB, bucketId } = ensureModeABucket(buckets, card.maps_to, card.widget);
  buckets = addWordingToBucket(withB, bucketId, card.question);
  assert.equal(teachableCards(apps, buckets, profile).length, 0, "taught → covered → gone from the queue");
  const b = buckets.find((x) => x.profile_path === "work_authorization.authorized_to_work_in_us")!;
  assert.ok(b.questions.some((q) => q.toLowerCase() === "authorized to work in the us?"), "the bucket carries the wording");
});

test("teachableCards: a MAPPED fuzzy-matched field carries canonical_field + match_tier + profile_value from it (no LLM needed)", () => {
  const profile = { self_identification: { gender: "Male" } };
  const apps = [src("a", [
    entry({ question_label: "Sex/Gender", widget_type: "dropdown", flag: null, canonical_field: "self_identification.gender", match_tier: "fuzzy-92", current_value: "Man" }),
  ])];
  const c = teachableCards(apps, [], profile)[0];
  assert.equal(c.canonical_field, "self_identification.gender");
  assert.equal(c.match_tier, "fuzzy-92");
  assert.equal(c.profile_value, "Male", "profile_value from the KNOWN canonical_field");
  assert.equal(c.maps_to, "", "no AI hint on a deterministic fuzzy match");
});

test("isFuzzyTier: containment / fuzzy-* → true; exact / empty → false", () => {
  assert.equal(isFuzzyTier("containment"), true);
  assert.equal(isFuzzyTier("fuzzy-90"), true);
  assert.equal(isFuzzyTier("exact-normalized"), false);
  assert.equal(isFuzzyTier(""), false);
  assert.equal(isFuzzyTier(null), false);
});

test("fieldHoldsAnswer: scalar / boolean(Yes-No) / tiered-array-any-candidate; empty → false", () => {
  const p = {
    self_identification: { gender: "Male" },
    work_authorization: { authorized_to_work_in_us: true, citizenship_country: ["United States of America", "United States"] },
    personal_info: { city: "" },
  };
  assert.equal(fieldHoldsAnswer(p, "self_identification.gender", "male"), true); // scalar, case-insensitive
  assert.equal(fieldHoldsAnswer(p, "self_identification.gender", "Female"), false);
  assert.equal(fieldHoldsAnswer(p, "work_authorization.authorized_to_work_in_us", "Yes"), true); // boolean → Yes
  assert.equal(fieldHoldsAnswer(p, "work_authorization.authorized_to_work_in_us", "No"), false);
  assert.equal(fieldHoldsAnswer(p, "work_authorization.citizenship_country", "United States"), true); // ANY candidate
  assert.equal(fieldHoldsAnswer(p, "work_authorization.citizenship_country", "Canada"), false);
  assert.equal(fieldHoldsAnswer(p, "personal_info.city", "Chicago"), false); // empty holds nothing
  assert.equal(fieldHoldsAnswer(p, "personal_info.missing", "x"), false); // absent path
});

test("decideTeachRoute: value already present → 'wording'; missing/different → 'answer'", () => {
  const p = { self_identification: { gender: "Male" }, personal_info: { city: "" } };
  assert.equal(decideTeachRoute(p, "self_identification.gender", "Male"), "wording"); // already holds it
  assert.equal(decideTeachRoute(p, "self_identification.gender", "Female"), "variant"); // holds a DIFFERENT value → the answer is a VARIANT, never an overwrite
  assert.equal(decideTeachRoute(p, "personal_info.city", "Chicago"), "answer"); // empty → set
});

test("teach a NON-standard yes/no label: seedLadderDraft/setLadderList/isBoolAnswer → editable ladder, covered, no resurface", () => {
  // isBoolAnswer: standard tokens vs a tenant's custom label
  for (const a of ["Yes", "no", "True", "FALSE", "checked", "off"]) assert.equal(isBoolAnswer(a), true, a);
  for (const a of ["Affirmative", "Yes, I am authorized", "Blue", ""]) assert.equal(isBoolAnswer(a), false, a);

  const p0 = { screening: { at_least_18_years_old: true } };
  const PATH = "screening.at_least_18_years_old";
  // seedLadderDraft: the polarity's defaults + the label appended (deduped); each polarity independent
  assert.deepEqual(seedLadderDraft(p0, PATH, true, "Affirmative"), ["Yes", "True", "Affirmative"]);
  assert.deepEqual(seedLadderDraft(p0, PATH, false, "Negative"), ["No", "False", "Negative"]);
  assert.deepEqual(seedLadderDraft(p0, PATH, true, "Yes"), ["Yes", "True"], "already present → no dup");

  // setLadderList persists the user's REORDERED list, deduped, immutably; other polarity untouched
  const reordered = ["Affirmative", "Yes", "True"]; // user moved Affirmative to the top before confirming
  const p1 = setLadderList(p0, PATH, true, reordered) as { answer_ladders: Record<string, { yes: string[]; no: string[] }> };
  assert.deepEqual(p1.answer_ladders[PATH].yes, ["Affirmative", "Yes", "True"], "stored in the user's order");
  assert.deepEqual(p1.answer_ladders[PATH].no, [], "other polarity untouched");
  assert.equal((p0 as { answer_ladders?: unknown }).answer_ladders, undefined, "input profile not mutated");

  // the taught label is now HELD by the field, and the AI card no longer resurfaces in teach
  assert.equal(fieldHoldsAnswer(p1, PATH, "Affirmative"), true);
  const a18 = bucket({ id: "a18", profile_path: PATH, questions: ["Are you over the age of 18?"] });
  const aiAff = entry({ question_label: "Are you over the age of 18?*", widget_type: "dropdown", flag: "ai-choice-sensitive", current_value: "Affirmative", is_approved: true, needs_review: true });
  assert.equal(teachableCards([src("a", [aiAff])], [a18], p1).length, 0, "taught non-standard label → covered → not resurfaced");
  assert.equal(teachableCards([src("b", [aiAff])], [a18], p0).length, 1, "before teaching → surfaces");
});

test("STARTER_BUCKETS + ensureStarterBuckets: ships flat education/WE field bindings; merge is additive + dedup by profile_path", () => {
  const paths = STARTER_BUCKETS.map((b) => b.profile_path);
  assert.ok(paths.includes("education.0.gpa"), "ships an education.0.gpa binding");
  assert.ok(paths.includes("education.0.school_or_university"), "ships an education.0.school binding");
  assert.ok(paths.includes("work_experience.0.job_title"), "ships a work_experience.0.job_title binding");

  // empty user → all starters added
  assert.equal(ensureStarterBuckets([]).length, STARTER_BUCKETS.length);

  // an existing bucket for a starter path is PRESERVED (not duplicated / not overwritten); others still added
  const mine: Bucket[] = [
    { id: "x", profile_path: "education.0.gpa", value: [], category: "", widget_hint: "text", questions: ["My GPA wording"], selectors: {} },
  ];
  const merged = ensureStarterBuckets(mine);
  const gpa = merged.filter((b) => b.profile_path === "education.0.gpa");
  assert.equal(gpa.length, 1, "no duplicate for an existing profile_path");
  assert.deepEqual(gpa[0].questions, ["My GPA wording"], "existing wordings preserved (not overwritten)");
  assert.ok(merged.some((b) => b.profile_path === "education.0.school_or_university"), "a missing starter is still added");
  // idempotent
  assert.equal(ensureStarterBuckets(merged).length, merged.length, "running twice adds nothing");
});

test("setFieldVariants: sets a scalar field's variants (answer_ladders[path].values), deduped + immutable, preserving yes/no", () => {
  const p0 = { self_identification: { gender: "Male" }, answer_ladders: { "screening.at_least_18_years_old": { yes: ["Yes", "True"], no: [] } } };
  const p1 = setFieldVariants(p0, "self_identification.gender", ["Man", "man", "  ", "M"]) as {
    answer_ladders: Record<string, { yes: string[]; no: string[]; values: string[] }>;
  };
  assert.deepEqual(p1.answer_ladders["self_identification.gender"].values, ["Man", "M"], "deduped (case-insensitive), blanks dropped, order kept");
  assert.deepEqual(p1.answer_ladders["screening.at_least_18_years_old"].yes, ["Yes", "True"], "other field's yes/no ladder preserved");
  assert.equal((p0 as { answer_ladders: Record<string, { values?: string[] }> }).answer_ladders["self_identification.gender"], undefined, "input profile not mutated");
});

test("yes/no teach correctness: boolean fields cover Yes/True AND No/False + custom ladders (no false resurface, no 'true' display)", () => {
  // profileValueAt: a boolean shows the readable label, NOT "true"/"false"
  assert.equal(profileValueAt({ screening: { at_least_18_years_old: true } }, "screening.at_least_18_years_old"), "Yes");
  assert.equal(profileValueAt({ screening: { at_least_18_years_old: false } }, "screening.at_least_18_years_old"), "No");

  // fieldHoldsAnswer: a TRUE field holds BOTH "Yes" and "True" (+ case variants); a FALSE field holds No/False.
  const pt = { screening: { at_least_18_years_old: true } };
  const pf = { work_authorization: { requires_sponsorship_now: false } };
  for (const a of ["Yes", "yes", "True", "true"]) assert.equal(fieldHoldsAnswer(pt, "screening.at_least_18_years_old", a), true, `true holds ${a}`);
  for (const a of ["No", "false", "False", "Negative"]) assert.equal(fieldHoldsAnswer(pt, "screening.at_least_18_years_old", a), false, `true does NOT hold ${a}`);
  for (const a of ["No", "no", "False", "false"]) assert.equal(fieldHoldsAnswer(pf, "work_authorization.requires_sponsorship_now", a), true, `false holds ${a}`);
  assert.equal(fieldHoldsAnswer(pf, "work_authorization.requires_sponsorship_now", "Yes"), false);

  // custom ladder: a true field holds a custom Yes-synonym; not a label outside its ladder
  const pc = { screening: { at_least_18_years_old: true }, answer_ladders: { "screening.at_least_18_years_old": { yes: ["Yes", "True", "Affirmative"], no: [] } } };
  assert.equal(fieldHoldsAnswer(pc, "screening.at_least_18_years_old", "Affirmative"), true, "custom Yes label held");
  assert.equal(fieldHoldsAnswer(pc, "screening.at_least_18_years_old", "Negative"), false, "not a Yes-ladder label");

  // decideTeachRoute: a True-answered card on a true field is already answered → 'wording' (not 'answer')
  assert.equal(decideTeachRoute(pt, "screening.at_least_18_years_old", "True"), "wording");
  assert.equal(decideTeachRoute(pt, "screening.at_least_18_years_old", "No"), "answer"); // opposite polarity → set

  // RESURFACE GUARD: an AI card answered "True" whose Mode-A boolean field is true must NOT resurface.
  const a18 = bucket({ id: "a18", profile_path: "screening.at_least_18_years_old", questions: ["Are you over the age of 18?"] });
  const aiTrue = entry({ question_label: "Are you over the age of 18?*", widget_type: "dropdown", flag: "ai-choice-sensitive", current_value: "True", is_approved: true, needs_review: true });
  assert.equal(teachableCards([src("a", [aiTrue])], [a18], pt).length, 0, "a True-answered AI card is covered by the true boolean → not resurfaced");
  // a custom-label "Affirmative" card is covered once the field's custom ladder holds it…
  const aiAff = entry({ question_label: "Are you over the age of 18?*", widget_type: "dropdown", flag: "ai-choice-sensitive", current_value: "Affirmative", is_approved: true, needs_review: true });
  assert.equal(teachableCards([src("b", [aiAff])], [a18], pc).length, 0, "custom-ladder label covered → not resurfaced");
  // …but WITHOUT the custom ladder it surfaces (so the operator can add the tenant's variant to the ladder)
  assert.equal(teachableCards([src("c", [aiAff])], [a18], pt).length, 1, "Affirmative not in any ladder yet → surfaces");

  // flattenProfileFields ignores the answer_ladders metadata (no junk rows / phantom section)
  assert.equal(flattenProfileFields(pc).some((r) => r.section === "answer_ladders" || r.path.startsWith("answer_ladders")), false);
});

// ── TWO-AXIS teach plan (operator, 2026-07-25) ────────────────────────────────────────────────
// The question WORDING (bucket) and the ANSWER (value / variant ladder) are independent; the case
// where BOTH are missing was unhandled and is checked FIRST. Live example: race = "Asian" in the
// profile, the form asked "Please select the ethnicity which most accurately describes how you
// identify yourself" and the approved answer was "Asian (not hispanic or latino)".
const RACE = "self_identification.race";
const ethnicityQ = "Please select the ethnicity which most accurately describes how you identify yourself";
const raceProfile = () => ({ self_identification: { race: "Asian" } });
const bucketFor = (path: string, questions: string[]): Bucket => ({
  id: "field_" + path.replace(/[^\w]+/g, "_"), profile_path: path, value: [], category: "", widget_hint: "dropdown", questions, selectors: {},
});

test("teach plan: NEW wording + NEW answer phrasing → 'both' (the merged popup), the value untouched", () => {
  const plan = decideTeachPlan(raceProfile(), RACE, { question: ethnicityQ, answer: "Asian (not hispanic or latino)" }, []);
  assert.equal(plan.route, "both");
  assert.equal(plan.needsWording, true);
  assert.equal(plan.needsAnswer, true);
});

test("teach plan: KNOWN wording + new answer phrasing → 'variant' (answer ladder only)", () => {
  const buckets = [bucketFor(RACE, [ethnicityQ])];
  const plan = decideTeachPlan(raceProfile(), RACE, { question: ethnicityQ, answer: "Asian (not hispanic or latino)" }, buckets);
  assert.equal(plan.route, "variant");
  assert.equal(plan.needsWording, false);
  assert.equal(plan.needsAnswer, true);
});

test("teach plan: new wording + answer ALREADY held → 'wording' (question bucket only)", () => {
  const plan = decideTeachPlan(raceProfile(), RACE, { question: ethnicityQ, answer: "Asian" }, []);
  assert.equal(plan.route, "wording");
  assert.equal(plan.needsAnswer, false);
});

test("teach plan: an EMPTY field sets its VALUE (not a variant)", () => {
  const plan = decideTeachPlan({ self_identification: {} }, RACE, { question: ethnicityQ, answer: "Asian" }, []);
  assert.equal(plan.route, "answer");
});

test("teach plan: an answer already in the field's VARIANT ladder does not resurface as an answer change", () => {
  const p = { self_identification: { race: "Asian" }, answer_ladders: { [RACE]: { values: ["Asian (not hispanic or latino)"] } } };
  // the variant is stored → setFieldVariants covered it; only the wording can still be new
  const plan = decideTeachPlan(p, RACE, { question: ethnicityQ, answer: "Asian (not hispanic or latino)" }, []);
  assert.equal(plan.needsAnswer, false, "the ladder already carries this phrasing");
  assert.equal(plan.route, "wording");
});

test("bucketHasWording / fieldIsEmpty: the two axes, normalized", () => {
  const buckets = [bucketFor(RACE, ["  PLEASE select the Ethnicity which most accurately describes how you identify yourself  "])];
  assert.equal(bucketHasWording(buckets, RACE, ethnicityQ), true, "normalized wording match");
  assert.equal(bucketHasWording(buckets, "self_identification.gender", ethnicityQ), false, "bound to a different field");
  assert.equal(fieldIsEmpty({ self_identification: { race: "" } }, RACE), true);
  assert.equal(fieldIsEmpty({ self_identification: { race: "Asian" } }, RACE), false);
  assert.equal(fieldIsEmpty({ self_identification: { race: [] } }, RACE), true);
});

// ── DEFAULT FIELD WORDINGS (operator, 2026-07-26) ─────────────────────────────────────────────
// Every profile field's bucket starts with the field's OWN NAME as a wording, so a form that labels
// its question the way the profile labels the field fills deterministically even when the tenant's
// automation-id isn't in FIELD_MAP. Non-destructive + idempotent, like ensureStarterBuckets.
test("default wordings: every profile field gets a bucket seeded with its own name", () => {
  const profile = { personal_info: { first_name: "Kevin", last_name: "Wang", postal_code: "32312" } };
  const out = ensureDefaultFieldWordings([], profile);
  const fn = out.find((b) => b.profile_path === "personal_info.first_name");
  assert.ok(fn, "a bucket exists for first_name");
  assert.deepEqual(fn!.questions, ["First Name"]);
  assert.ok(out.find((b) => b.profile_path === "personal_info.postal_code")?.questions.includes("Postal Code"));
});

test("default wordings: EXISTING buckets keep their wordings and just gain the field name (deduped)", () => {
  const profile = { personal_info: { first_name: "Kevin" } };
  const mine: Bucket[] = [{
    id: "field_personal_info_first_name", profile_path: "personal_info.first_name", value: [],
    category: "", widget_hint: "text", questions: ["Given name"], selectors: {},
  }];
  const out = ensureDefaultFieldWordings(mine, profile);
  assert.deepEqual(out[0].questions, ["Given name", "First Name"], "operator wording kept, default appended");
  // idempotent + case/spacing-insensitive (normalizeQuestion)
  assert.deepEqual(ensureDefaultFieldWordings(out, profile)[0].questions, ["Given name", "First Name"]);
  const cased: Bucket[] = [{ ...mine[0], questions: ["  first   NAME "] }];
  assert.equal(ensureDefaultFieldWordings(cased, profile)[0].questions.length, 1, "already present under a different casing");
});

test("default wordings: generic labels are skipped, and only the PRIMARY repeating entry is seeded", () => {
  const profile = {
    websites: [{ type: "LinkedIn", url: "https://x" }],
    education: [{ school_or_university: "CMU", gpa: "4.0" }, { school_or_university: "FSU", gpa: "3.9" }],
  };
  const out = ensureDefaultFieldWordings([], profile);
  assert.equal(out.find((b) => b.profile_path === "websites.0.type"), undefined, "'Type' is too generic to stand alone");
  assert.ok(out.find((b) => b.profile_path === "education.0.gpa"), "primary entry seeded");
  assert.equal(out.find((b) => b.profile_path === "education.1.gpa"), undefined, "entry 1 is NOT seeded (a bucket binds one path)");
});

test("default wordings: each WEBSITE is seeded from its TYPE (LinkedIn / GitHub / Personal Website), not 'URL'", () => {
  const profile = {
    websites: [
      { type: "LinkedIn", url: "https://linkedin.com/in/x" },
      { type: "GitHub", url: "https://github.com/x" },
      { type: "Personal Website", url: "https://x.dev" },
    ],
  };
  const out = ensureDefaultFieldWordings([], profile);
  // EVERY entry gets its own bucket (unlike the other repeating sections) — each is a distinct question.
  assert.deepEqual(out.find((b) => b.profile_path === "websites.0.url")?.questions, ["LinkedIn"]);
  assert.deepEqual(out.find((b) => b.profile_path === "websites.1.url")?.questions, ["GitHub"]);
  assert.deepEqual(out.find((b) => b.profile_path === "websites.2.url")?.questions, ["Personal Website"]);
  // no "URL"/"Type" wording anywhere, and idempotent
  assert.ok(!out.some((b) => (b.questions || []).some((q) => /^url$/i.test(q))));
  assert.deepEqual(ensureDefaultFieldWordings(out, profile).find((b) => b.profile_path === "websites.1.url")?.questions, ["GitHub"]);
});

test("default wordings: a website with no type is skipped; an operator's own wording is kept", () => {
  const profile = { websites: [{ type: "", url: "https://x" }, { type: "Portfolio", url: "https://y" }] };
  const mine: Bucket[] = [{
    id: "field_websites_1_url", profile_path: "websites.1.url", value: [],
    category: "", widget_hint: "text", questions: ["Portfolio link"], selectors: {},
  }];
  const out = ensureDefaultFieldWordings(mine, profile);
  assert.equal(out.find((b) => b.profile_path === "websites.0.url"), undefined, "no type → nothing to seed");
  assert.deepEqual(out.find((b) => b.profile_path === "websites.1.url")?.questions, ["Portfolio link", "Portfolio"]);
});
