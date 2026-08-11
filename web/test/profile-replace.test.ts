import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceProfile,
  emptyProfile,
  mergeProfile,
  replaceProfileSections,
  PARSED_ARRAY_SECTIONS,
  type Profile,
} from "../lib/profile-schema";

/** A profile that is already COMPLETE — the state in which "Apply" is a silent no-op. */
function populated(): Profile {
  return coerceProfile({
    personal_info: { first_name: "Kevin", last_name: "Wang", email: "old@example.com" },
    work_experience: [{ job_title: "Old Role", company: "Old Co" }],
    education: [{ school_or_university: "Old School", degree: ["BS"] }],
    skills: ["C", "Python"],
    certifications: [{ certification: ["CPP"] }],
    employment_history_companies: ["Old Co"],
    work_authorization: { authorized_to_work_in_us: true, current_visa_status: "F-1 OPT" },
    screening: { at_least_18_years_old: true },
    self_identification: { gender: "Prefer not to say" },
    answer_ladders: { "education.0.gpa": { yes: [], no: [], values: ["3.5+"] } },
  });
}

/** What a parse of a REWRITTEN resume looks like. */
function parsedResume(): Profile {
  return coerceProfile({
    personal_info: { first_name: "Kevin", last_name: "Wang", email: "new@example.com" },
    work_experience: [
      { job_title: "New Role", company: "New Co" },
      { job_title: "Second Role", company: "Other Co" },
    ],
    education: [{ school_or_university: "New School", degree: ["MS"] }],
    skills: ["Rust", "SystemVerilog"],
  });
}

test("the bug: fill-blanks apply changes NOTHING on an already-populated profile", () => {
  const base = populated();
  const merged = mergeProfile(base, parsedResume());
  assert.deepEqual(merged.work_experience, base.work_experience);
  assert.deepEqual(merged.skills, base.skills);
  assert.equal(merged.personal_info.email, "old@example.com");
});

test("replace overwrites the sections the parse found", () => {
  const { profile, replaced } = replaceProfileSections(populated(), parsedResume());
  assert.deepEqual(
    profile.work_experience.map((w) => w.company),
    ["New Co", "Other Co"],
  );
  assert.deepEqual(profile.skills, ["Rust", "SystemVerilog"]);
  assert.deepEqual(
    profile.education.map((e) => e.school_or_university),
    ["New School"],
  );
  assert.equal(profile.personal_info.email, "new@example.com");
  assert.ok(replaced.includes("work_experience"));
  assert.ok(replaced.includes("skills"));
  assert.ok(replaced.includes("personal_info"));
});

test("a section the parse did NOT find is never cleared", () => {
  // parsedResume() has no certifications — the existing ones must survive.
  const { profile, replaced } = replaceProfileSections(populated(), parsedResume());
  assert.deepEqual(profile.certifications.map((c) => c.certification), [["CPP"]]);
  assert.ok(!replaced.includes("certifications"));
});

test("SAFETY: sections a resume cannot state are never touched, even if the parse returns them", () => {
  const hostile = coerceProfile({
    ...parsedResume(),
    employment_history_companies: ["Hallucinated Corp"],
    work_authorization: { authorized_to_work_in_us: false, current_visa_status: "H-1B" },
    screening: { at_least_18_years_old: false },
    self_identification: { gender: "Man" },
  });
  const base = populated();
  const { profile } = replaceProfileSections(base, hostile);

  // Guard the guard: these must be REAL populated fields, or the assertions below
  // would pass vacuously on undefined === undefined.
  assert.equal(base.work_authorization.authorized_to_work_in_us, true);
  assert.equal(base.self_identification.gender, "Prefer not to say");

  // The auto-"No" employer list is safety-critical: a non-empty list is treated as COMPLETE.
  assert.deepEqual(profile.employment_history_companies, ["Old Co"]);
  assert.equal(profile.work_authorization.authorized_to_work_in_us, true);
  assert.equal(profile.work_authorization.current_visa_status, "F-1 OPT");
  assert.equal(profile.screening.at_least_18_years_old, true);
  assert.equal(profile.self_identification.gender, "Prefer not to say");
});

test("employment_history_companies is deliberately NOT a parsed section", () => {
  assert.ok(!(PARSED_ARRAY_SECTIONS as readonly string[]).includes("employment_history_companies"));
});

test("an answer ladder pointing past the new array is dropped and reported", () => {
  const base = populated(); // has answer_ladders["education.0.gpa"], education length 1
  const incoming = coerceProfile({ education: [] as unknown[], work_experience: [] as unknown[] });
  // Parse found NO education → section untouched → ladder kept.
  const kept = replaceProfileSections(base, incoming);
  assert.ok("education.0.gpa" in kept.profile.answer_ladders);
  assert.deepEqual(kept.droppedLadders, []);

  // Now a parse that replaces education with a ZERO-length... not possible (empty is skipped),
  // so use a ladder that indexes past a shorter replacement.
  const deep = coerceProfile({
    ...base,
    answer_ladders: { "education.3.gpa": { yes: [], no: [], values: ["3.5+"] } },
  });
  const res = replaceProfileSections(deep, parsedResume()); // education becomes length 1
  assert.ok(!("education.3.gpa" in res.profile.answer_ladders));
  assert.deepEqual(res.droppedLadders, ["education.3.gpa"]);
});

test("an in-range answer ladder is KEPT — hand-written tuning is not silently discarded", () => {
  const { profile, droppedLadders } = replaceProfileSections(populated(), parsedResume());
  assert.ok("education.0.gpa" in profile.answer_ladders);
  assert.deepEqual(droppedLadders, []);
});

test("replacing with an identical parse reports nothing changed", () => {
  const base = populated();
  const same = coerceProfile({
    personal_info: base.personal_info,
    work_experience: base.work_experience,
    education: base.education,
    skills: base.skills,
  });
  const { replaced } = replaceProfileSections(base, same);
  assert.deepEqual(replaced, []);
});

test("replace onto an EMPTY profile behaves like a first import", () => {
  const { profile, replaced } = replaceProfileSections(emptyProfile(), parsedResume());
  assert.equal(profile.work_experience.length, 2);
  assert.ok(replaced.includes("work_experience"));
});

test("replace does not mutate the profile it was given", () => {
  const base = populated();
  const before = JSON.stringify(base);
  replaceProfileSections(base, parsedResume());
  assert.equal(JSON.stringify(base), before);
});
