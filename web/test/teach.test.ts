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
});

test("coveredKeys: normalized wordings from every bucket", () => {
  const c = coveredKeys([bucket({ questions: ["Are you over 18?*", "Gender"] })]);
  assert.equal(c.has("are you over 18?"), true); // trailing * + case stripped
  assert.equal(c.has("gender"), true);
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
  assert.equal(teachableCards([src("a", [mk({})])], [bucket({ questions: ["Reliable transport?"] })], {}).length, 0, "already covered");
  assert.equal(teachableCards([src("a", [mk({})])], [], {}, ["reliable transport?"]).length, 0, "dismissed");
  assert.equal(teachableCards([src("a", [mk({ flag: null })])], [], {}).length, 1, "a REVIEWED non-AI field is teachable too (Req B)");
  assert.equal(teachableCards([src("a", [mk({})]), src("b", [mk({})])], [], {}).length, 1, "dedup across apps");
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

test("flattenProfileFields: object sections → scalar/bool/tiered rows; arrays-of-objects + top-level scalars skipped", () => {
  const profile = {
    schema_version: "2.0",
    personal_info: { first_name: "Ada", has_preferred_name: true, country: ["United States of America", "United States"] },
    work_experience: [{ job_title: "Engineer" }],
    skills: ["ts", "react"],
  };
  const rows = flattenProfileFields(profile);
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  assert.equal(byPath["personal_info.first_name"].value, "Ada");
  assert.equal(byPath["personal_info.first_name"].label, "First Name");
  assert.equal(byPath["personal_info.first_name"].sectionLabel, "Personal Info");
  assert.equal(byPath["personal_info.has_preferred_name"].value, "Yes"); // boolean → Yes
  assert.equal(byPath["personal_info.country"].value, "United States of America"); // tiered → first
  assert.equal(rows.find((r) => r.path.startsWith("work_experience")), undefined, "array-of-objects section skipped");
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
