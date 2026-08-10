import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceProfile,
  collectTechStack,
  unionSkills,
  replaceProfileSections,
  type Profile,
} from "../lib/profile-schema";
import { validatePlan, applyReconcilePlan } from "../lib/profile-reconcile";
import { diffProfile, profileFingerprint } from "../lib/profile-diff";

function withTech(): Profile {
  return coerceProfile({
    work_experience: [
      { job_title: "FW Intern", company: "Acme", tech_stack: ["Zephyr", "C", "I2C"] },
    ],
    projects: [{ name: "Rover", tech_stack: ["ROS 2", "zephyr"] }],
    skills: ["C"],
  });
}

test("collectTechStack gathers work + project stacks, de-duped case-insensitively", () => {
  assert.deepEqual(collectTechStack(withTech()), ["Zephyr", "C", "I2C", "ROS 2"]);
});

test("unionSkills keeps the existing spelling and appends only what's new", () => {
  const r = unionSkills(["C", "Python"], ["c", "Rust", "python", "Rust"]);
  assert.deepEqual(r.skills, ["C", "Python", "Rust"]);
  assert.deepEqual(r.added, ["Rust"]);
});

test("replace folds each role's tech stack into skills", () => {
  const base = coerceProfile({ skills: ["Java"], work_experience: [{ job_title: "old" }] });
  const { profile, replaced } = replaceProfileSections(base, withTech());
  // parsed skills (C) plus every tech_stack entry, none lost
  for (const s of ["C", "Zephyr", "I2C", "ROS 2"]) {
    assert.ok(profile.skills.includes(s), `missing ${s}`);
  }
  assert.ok(replaced.includes("skills"));
});

test("smart merge folds tech stack in too, without dropping hand-added skills", () => {
  const base = coerceProfile({ skills: ["Hand Added"], work_experience: [] });
  const plan = validatePlan(base, withTech(), []);
  const { profile } = applyReconcilePlan(base, withTech(), plan);
  assert.ok(profile.skills.includes("Hand Added"));
  assert.ok(profile.skills.includes("Zephyr"));
  assert.ok(profile.skills.includes("ROS 2"));
});

test("tech stack already present is not duplicated", () => {
  const base = coerceProfile({ skills: ["zephyr"], work_experience: [] });
  const plan = validatePlan(base, withTech(), []);
  const { profile } = applyReconcilePlan(base, withTech(), plan);
  const zeph = profile.skills.filter((s) => s.toLowerCase() === "zephyr");
  assert.equal(zeph.length, 1);
  assert.equal(zeph[0], "zephyr", "the user's own spelling should win");
});

test("diff reports a field change with before and after", () => {
  const a = coerceProfile({ personal_info: { email: "old@x.com" } });
  const b = coerceProfile({ personal_info: { email: "new@x.com" } });
  const d = diffProfile(a, b);
  const pi = d.sections.find((s) => s.section === "personal_info");
  assert.ok(pi?.fields?.some((f) => f.field === "email" && f.before === "old@x.com" && f.after === "new@x.com"));
});

test("diff reports an in-place entry change with the fields that moved", () => {
  const a = coerceProfile({ work_experience: [{ job_title: "FW Intern", company: "Acme" }] });
  const b = coerceProfile({
    work_experience: [{ job_title: "Firmware Intern", company: "Acme", role_description: "new" }],
  });
  const d = diffProfile(a, b);
  const we = d.sections.find((s) => s.section === "work_experience");
  const e = we?.entries?.[0];
  assert.equal(e?.kind, "change");
  assert.ok(e && e.kind === "change" && e.fields.includes("job_title"));
  assert.ok(e && e.kind === "change" && e.fields.includes("role_description"));
});

test("diff reports adds and removes at the ends of a list", () => {
  const a = coerceProfile({ work_experience: [{ job_title: "A" }] });
  const b = coerceProfile({ work_experience: [{ job_title: "A" }, { job_title: "B" }] });
  const added = diffProfile(a, b).sections.find((s) => s.section === "work_experience");
  assert.equal(added?.entries?.[0].kind, "add");
  const removed = diffProfile(b, a).sections.find((s) => s.section === "work_experience");
  assert.equal(removed?.entries?.[0].kind, "remove");
});

test("string lists diff as sets, not positions", () => {
  const a = coerceProfile({ skills: ["C", "Python"] });
  const b = coerceProfile({ skills: ["Python", "C", "Rust"] }); // reordered + one new
  const d = diffProfile(a, b).sections.find((s) => s.section === "skills");
  assert.deepEqual(d?.values?.added, ["Rust"]);
  assert.deepEqual(d?.values?.removed, []);
});

test("an identical profile diffs to nothing", () => {
  const a = withTech();
  assert.equal(diffProfile(a, a).sections.length, 0);
});

test("WARNS when an answer ladder survives but now describes a different entry", () => {
  const a = coerceProfile({
    education: [{ school_or_university: "Old School" }],
    answer_ladders: { "education.0.gpa": { yes: [], no: [], values: ["3.5+"] } },
  });
  const b = coerceProfile({
    education: [{ school_or_university: "New School" }],
    answer_ladders: { "education.0.gpa": { yes: [], no: [], values: ["3.5+"] } },
  });
  const d = diffProfile(a, b);
  assert.ok(
    d.warnings.some((w) => w.includes("education.0.gpa") && w.includes("New School")),
    `expected a re-point warning, got ${JSON.stringify(d.warnings)}`,
  );
});

test("WARNS when an answer ladder is dropped as dangling", () => {
  const a = coerceProfile({
    education: [{ school_or_university: "A" }, { school_or_university: "B" }],
    answer_ladders: { "education.1.gpa": { yes: [], no: [], values: ["x"] } },
  });
  const b = coerceProfile({ education: [{ school_or_university: "A" }] });
  assert.ok(diffProfile(a, b).warnings.some((w) => w.includes("dangling")));
});

test("fingerprint ignores key order but tracks content", () => {
  const a = coerceProfile({ personal_info: { first_name: "K", email: "e@x.com" } });
  const reordered = JSON.parse(JSON.stringify(a, ["personal_info", "email", "first_name"]));
  assert.equal(profileFingerprint(a), profileFingerprint(coerceProfile(reordered)));

  const b = coerceProfile({ personal_info: { first_name: "K", email: "other@x.com" } });
  assert.notEqual(profileFingerprint(a), profileFingerprint(b));
});

test("the preview a mode shows IS what that mode does", () => {
  // The contract that makes previews trustworthy: diff(base, apply(base)) must equal
  // the change actually written. Recomputing apply twice must be deterministic.
  const base = coerceProfile({ skills: ["Java"], work_experience: [{ job_title: "old" }] });
  const once = replaceProfileSections(base, withTech()).profile;
  const twice = replaceProfileSections(base, withTech()).profile;
  assert.equal(profileFingerprint(once), profileFingerprint(twice));
  assert.ok(diffProfile(base, once).sections.length > 0);
  assert.equal(diffProfile(once, twice).sections.length, 0);
});
