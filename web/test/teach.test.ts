import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBucketEligibleWidget,
  profileValueAt,
  teachableCards,
  coveredKeys,
  sameAnswer,
  addWordingToBucket,
  ensureModeABucket,
  createModeBBucket,
  bucketLabel,
  humanize,
  flattenProfileFields,
  isFuzzyTier,
  dottedPath,
  fieldHoldsAnswer,
  decideTeachRoute,
  wasManuallyEdited,
  type TeachSource,
} from "@/lib/teach";
import type { Bucket } from "@/lib/buckets";
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
  assert.equal(decideTeachRoute(p, "self_identification.gender", "Female"), "answer"); // differs → set/append
  assert.equal(decideTeachRoute(p, "personal_info.city", "Chicago"), "answer"); // empty → set
});
