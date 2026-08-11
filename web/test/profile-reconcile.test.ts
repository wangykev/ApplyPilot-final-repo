import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceProfile, type Profile } from "../lib/profile-schema";
import {
  RECONCILE_SECTIONS,
  entryLabel,
  buildReconcilePrompt,
  parseReconcileReply,
  validatePlan,
  applyReconcilePlan,
  type EntryDecision,
} from "../lib/profile-reconcile";

function base(): Profile {
  return coerceProfile({
    personal_info: { first_name: "Kevin", email: "old@example.com" },
    work_experience: [
      { job_title: "FW Intern", company: "Acme", role_description: "old text" },
      { job_title: "TA", company: "CMU" },
    ],
    education: [{ school_or_university: "CMU", degree: ["BS"] }],
    skills: ["C", "Python"],
    employment_history_companies: ["Acme"],
    answer_ladders: { "work_experience.1.gpa": { yes: [], no: [], values: ["x"] } },
  });
}

/** Same Acme role reworded, plus a genuinely new job. */
function parsed(): Profile {
  return coerceProfile({
    personal_info: { first_name: "Kevin", email: "new@example.com" },
    work_experience: [
      { job_title: "Firmware Intern", company: "Acme", role_description: "rewritten, much better" },
      { job_title: "SWE Intern", company: "Globex" },
    ],
    skills: ["Python", "Rust"],
  });
}

test("entryLabel names a role by identity, not by description", () => {
  assert.equal(
    entryLabel("work_experience", { job_title: "FW Intern", company: "Acme", from: "2025-06", to: "2025-08" }),
    "FW Intern @ Acme  2025-06–2025-08",
  );
  assert.equal(entryLabel("education", { school_or_university: "CMU", degree: ["BS"] }), "CMU — BS");
});

test("the prompt shows both sides with indices, and skips sections the resume didn't mention", () => {
  const { user } = buildReconcilePrompt(base(), parsed());
  assert.match(user, /## work_experience/);
  assert.match(user, /\[0\] FW Intern @ Acme/);
  assert.match(user, /\[1\] SWE Intern @ Globex/);
  // parsed() has no education entries → that section carries no decision to make
  assert.ok(!user.includes("## education"));
});

test("parseReconcileReply survives a code fence and surrounding prose", () => {
  const d = parseReconcileReply(
    'Sure!\n```json\n{"decisions":[{"section":"work_experience","incoming":0,"action":"update","target":0,"reason":"same role"}]}\n```',
  );
  assert.deepEqual(d, [
    { section: "work_experience", incoming: 0, action: "update", target: 0, reason: "same role" },
  ]);
});

test("parseReconcileReply returns null on unusable output rather than guessing", () => {
  assert.equal(parseReconcileReply("no json here"), null);
  assert.equal(parseReconcileReply(""), null);
  assert.equal(parseReconcileReply(42), null);
});

test("parseReconcileReply drops rows naming an unknown section", () => {
  const d = parseReconcileReply('{"decisions":[{"section":"screening","incoming":0,"action":"add"}]}');
  assert.deepEqual(d, []);
});

test("happy path: update the matched role, append the new one, keep the untouched one", () => {
  const raw: EntryDecision[] = [
    { section: "work_experience", incoming: 0, action: "update", target: 0, reason: "same role" },
    { section: "work_experience", incoming: 1, action: "add", reason: "new employer" },
  ];
  const plan = validatePlan(base(), parsed(), raw);
  assert.deepEqual(plan.corrections, []);
  const { profile, updated, added } = applyReconcilePlan(base(), parsed(), plan);

  assert.equal(updated, 1);
  assert.equal(added, 1);
  assert.deepEqual(
    profile.work_experience.map((w) => `${w.job_title} @ ${w.company}`),
    ["Firmware Intern @ Acme", "TA @ CMU", "SWE Intern @ Globex"],
  );
  // the rewritten description landed
  assert.equal(profile.work_experience[0].role_description, "rewritten, much better");
});

test("SAFETY: a target past the end of the existing array degrades to add, and says so", () => {
  const raw: EntryDecision[] = [
    { section: "work_experience", incoming: 0, action: "update", target: 99, reason: "bad index" },
    { section: "work_experience", incoming: 1, action: "add", reason: "new" },
  ];
  const plan = validatePlan(base(), parsed(), raw);
  assert.equal(plan.decisions[0].action, "add");
  assert.match(plan.corrections[0], /out of range/);
  const { profile } = applyReconcilePlan(base(), parsed(), plan);
  // nothing was overwritten; both parsed roles were appended
  assert.equal(profile.work_experience.length, 4);
  assert.equal(profile.work_experience[0].job_title, "FW Intern");
});

test("SAFETY: two parsed entries cannot claim the same existing entry", () => {
  const raw: EntryDecision[] = [
    { section: "work_experience", incoming: 0, action: "update", target: 0, reason: "same" },
    { section: "work_experience", incoming: 1, action: "update", target: 0, reason: "also same" },
  ];
  const plan = validatePlan(base(), parsed(), raw);
  assert.equal(plan.decisions[0].action, "update");
  assert.equal(plan.decisions[1].action, "add");
  assert.match(plan.corrections[0], /already claimed/);
  const { profile } = applyReconcilePlan(base(), parsed(), plan);
  assert.equal(profile.work_experience.length, 3);
});

test("SAFETY: a parsed entry the model forgot is added, never dropped", () => {
  const raw: EntryDecision[] = [
    { section: "work_experience", incoming: 0, action: "update", target: 0, reason: "same" },
  ];
  const plan = validatePlan(base(), parsed(), raw);
  assert.equal(plan.decisions.length, 2);
  assert.equal(plan.decisions[1].action, "add");
  assert.match(plan.corrections[0], /no decision returned/);
});

test("smart merge NEVER deletes an existing entry", () => {
  const plan = validatePlan(base(), parsed(), []);
  const { profile } = applyReconcilePlan(base(), parsed(), plan);
  for (const w of base().work_experience) {
    assert.ok(
      profile.work_experience.some((x) => x.job_title === w.job_title && x.company === w.company),
      `lost ${w.job_title}`,
    );
  }
});

test("appending keeps index-keyed answer ladders valid (unlike replace)", () => {
  const plan = validatePlan(base(), parsed(), []);
  const { profile } = applyReconcilePlan(base(), parsed(), plan);
  assert.ok("work_experience.1.gpa" in profile.answer_ladders);
  // entry 1 is still the TA role the ladder was written for
  assert.equal(profile.work_experience[1].job_title, "TA");
});

test("skills UNION rather than replace, case-insensitively, first spelling wins", () => {
  const plan = validatePlan(base(), parsed(), []);
  const { profile } = applyReconcilePlan(base(), parsed(), plan);
  assert.deepEqual(profile.skills, ["C", "Python", "Rust"]);
});

test("SAFETY: sections a resume cannot state stay untouched in smart merge too", () => {
  const plan = validatePlan(base(), parsed(), []);
  const { profile } = applyReconcilePlan(base(), parsed(), plan);
  assert.deepEqual(profile.employment_history_companies, ["Acme"]);
  assert.ok(!(RECONCILE_SECTIONS as readonly string[]).includes("employment_history_companies"));
});

test("personal_info adopts what the new resume states", () => {
  const plan = validatePlan(base(), parsed(), []);
  const { profile } = applyReconcilePlan(base(), parsed(), plan);
  assert.equal(profile.personal_info.email, "new@example.com");
});

test("apply does not mutate its inputs", () => {
  const b = base();
  const before = JSON.stringify(b);
  const plan = validatePlan(b, parsed(), []);
  applyReconcilePlan(b, parsed(), plan);
  assert.equal(JSON.stringify(b), before);
});
