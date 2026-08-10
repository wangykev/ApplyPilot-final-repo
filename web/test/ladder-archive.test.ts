import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceProfile,
  reconcileLaddersToProfile,
  replaceProfileSections,
  type Profile,
} from "../lib/profile-schema";

/** A profile whose screening answer is "yes" and carries a long hand-written ladder. */
function yesWithLadder(): Profile {
  return coerceProfile({
    screening: { at_least_18_years_old: true },
    answer_ladders: {
      "screening.at_least_18_years_old": {
        yes: ["Yes", "Y", "Yes, I am", "Correct"],
        no: [],
        values: ["Yes, I am over 18", "Over 18", "18 or older"],
      },
    },
  });
}

function setAge(p: Profile, v: boolean | null): Profile {
  const c = structuredClone(p);
  (c.screening as Record<string, unknown>).at_least_18_years_old = v;
  return c;
}

test("THE CASE: yes → no → yes returns the ladder verbatim", () => {
  const start = yesWithLadder();
  const ladderBefore = start.answer_ladders["screening.at_least_18_years_old"].values;

  // accidental flip to "no"
  const flipped = reconcileLaddersToProfile(start, setAge(start, false));
  assert.deepEqual(
    flipped.profile.answer_ladders["screening.at_least_18_years_old"].values,
    [],
    "the yes-variants stop applying while the answer is no",
  );
  assert.deepEqual(flipped.parked, ["screening.at_least_18_years_old"]);

  // …and back to "yes"
  const back = reconcileLaddersToProfile(flipped.profile, setAge(flipped.profile, true));
  assert.deepEqual(
    back.profile.answer_ladders["screening.at_least_18_years_old"].values,
    ladderBefore,
    "the ladder must come back exactly as written",
  );
  assert.deepEqual(back.restored, ["screening.at_least_18_years_old"]);
});

test("the per-polarity yes/no ladders are NEVER parked — both stay valid either way", () => {
  const start = yesWithLadder();
  const flipped = reconcileLaddersToProfile(start, setAge(start, false));
  assert.deepEqual(
    flipped.profile.answer_ladders["screening.at_least_18_years_old"].yes,
    ["Yes", "Y", "Yes, I am", "Correct"],
  );
});

test("an UNCHANGED answer leaves the ladder completely alone", () => {
  const start = yesWithLadder();
  const r = reconcileLaddersToProfile(start, structuredClone(start));
  assert.deepEqual(r.parked, []);
  assert.deepEqual(r.restored, []);
  assert.deepEqual(r.profile.answer_ladders, start.answer_ladders);
});

test("a ladder is never DELETED — parking preserves it under the old answer", () => {
  const start = yesWithLadder();
  const flipped = reconcileLaddersToProfile(start, setAge(start, false));
  const park = flipped.profile.answer_ladders_archive["screening.at_least_18_years_old"];
  assert.equal(park.length, 1);
  assert.equal(park[0].answer, "true");
  assert.deepEqual(park[0].values, ["Yes, I am over 18", "Over 18", "18 or older"]);
});

test("a DIFFERENT answer does not resurrect a parked ladder", () => {
  const start = coerceProfile({
    education: [{ gpa: "3.9" }],
    answer_ladders: { "education.0.gpa": { yes: [], no: [], values: ["3.9/4.0", "3.9 GPA"] } },
  });
  const to35 = structuredClone(start);
  to35.education[0].gpa = "3.5";
  const parked = reconcileLaddersToProfile(start, to35);
  assert.deepEqual(parked.profile.answer_ladders["education.0.gpa"].values, []);

  const to37 = structuredClone(parked.profile);
  to37.education[0].gpa = "3.7";
  const r = reconcileLaddersToProfile(parked.profile, to37);
  assert.deepEqual(r.restored, [], "3.7 is a different answer than the parked 3.9");
});

test("REPLACE parks a ladder whose entry vanished instead of dropping it", () => {
  const base = coerceProfile({
    education: [{ school_or_university: "A", gpa: "3.9" }, { school_or_university: "B", gpa: "3.2" }],
    answer_ladders: { "education.1.gpa": { yes: [], no: [], values: ["3.2/4.0"] } },
  });
  const parsed = coerceProfile({ education: [{ school_or_university: "A", gpa: "3.9" }] });
  const { profile, droppedLadders } = replaceProfileSections(base, parsed);

  assert.deepEqual(droppedLadders, ["education.1.gpa"]);
  const park = profile.answer_ladders_archive["education.1.gpa"];
  assert.ok(park && park.length === 1, "the ladder must be parked, not lost");
  assert.deepEqual(park[0].values, ["3.2/4.0"]);
  assert.equal(park[0].answer, "3.2");
});

test("parking is idempotent — re-parking the same answer does not duplicate", () => {
  const start = yesWithLadder();
  const once = reconcileLaddersToProfile(start, setAge(start, false));
  const twice = reconcileLaddersToProfile(once.profile, setAge(once.profile, null));
  const park = twice.profile.answer_ladders_archive["screening.at_least_18_years_old"];
  assert.equal(park.filter((e) => e.answer === "true").length, 1);
});

test("RE-READING the resume and merging keeps the ladder when the answer is the same", () => {
  // The operator's case: the resume gets parsed again and smart-merged. An entry is rewritten
  // (description, dates), but the field the ladder is bound to still holds the same answer — so the
  // ladder must not so much as flinch.
  const base = coerceProfile({
    work_experience: [{ job_title: "FW Intern", company: "Acme", role_description: "old text" }],
    answer_ladders: { "work_experience.0.company": { yes: [], no: [], values: ["Acme Corp", "Acme Inc."] } },
  });
  const afterMerge = structuredClone(base);
  afterMerge.work_experience[0].role_description = "rewritten by the new resume";
  afterMerge.work_experience[0].job_title = "Firmware Intern";

  const r = reconcileLaddersToProfile(base, afterMerge);
  assert.deepEqual(r.parked, [], "same company ⇒ nothing parked");
  assert.deepEqual(
    r.profile.answer_ladders["work_experience.0.company"].values,
    ["Acme Corp", "Acme Inc."],
  );
});

test("a profile with no ladders is untouched", () => {
  const p = coerceProfile({ screening: { at_least_18_years_old: true } });
  const r = reconcileLaddersToProfile(p, setAge(p, false));
  assert.deepEqual(r.parked, []);
  assert.deepEqual(r.restored, []);
});
