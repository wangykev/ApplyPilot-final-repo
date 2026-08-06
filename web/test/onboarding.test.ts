import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  coerceOnboarding,
  countUsableKeys,
  emptyOnboarding,
  missingForApproval,
  onboardedCookieMatches,
  onboardingStatus,
  profileReadyForApproval,
  stepDone,
  type OnboardingFacts,
} from "../lib/onboarding";

const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  hasResume: false,
  profileApprovedAt: null,
  usableKeys: 0,
  completedAt: null,
  ...over,
});

const ALL_DONE = facts({ hasResume: true, profileApprovedAt: "2026-08-06T00:00:00Z", usableKeys: 1 });

/* ── the step order the flow is built on ─────────────────────────────────── */

test("the steps are resume → profile → AI, in that order", () => {
  assert.deepEqual([...ONBOARDING_STEPS], ["resume", "profile", "ai"]);
});

test("each step reads its own fact", () => {
  assert.equal(stepDone("resume", facts({ hasResume: true })), true);
  assert.equal(stepDone("resume", facts()), false);
  assert.equal(stepDone("profile", facts({ profileApprovedAt: "2026-08-06T00:00:00Z" })), true);
  assert.equal(stepDone("profile", facts()), false);
  assert.equal(stepDone("ai", facts({ usableKeys: 2 })), true);
  assert.equal(stepDone("ai", facts({ usableKeys: 0 })), false);
});

test("currentStep is the FIRST unfinished step, so the flow opens where you left off", () => {
  assert.equal(onboardingStatus(facts()).currentStep, "resume");
  assert.equal(onboardingStatus(facts({ hasResume: true })).currentStep, "profile");
  assert.equal(
    onboardingStatus(facts({ hasResume: true, profileApprovedAt: "x" })).currentStep,
    "ai"
  );
  assert.equal(onboardingStatus(ALL_DONE).currentStep, null);
});

test("a LATER step being done does not skip an earlier one", () => {
  // Keys added first (via the step-1 detour) must not let the resume step be passed over.
  const s = onboardingStatus(facts({ usableKeys: 1 }));
  assert.equal(s.currentStep, "resume");
  assert.equal(s.complete, false);
  assert.equal(s.doneCount, 1);
});

/* ── completion, and why it is sticky ────────────────────────────────────── */

test("complete only when every step is done", () => {
  assert.equal(onboardingStatus(facts()).complete, false);
  assert.equal(onboardingStatus(facts({ hasResume: true, usableKeys: 1 })).complete, false);
  assert.equal(onboardingStatus(ALL_DONE).complete, true);
});

test("a finished flow STAYS finished after the underlying data changes", () => {
  // Removing a resume to upload a different one must not yank someone back into a wizard
  // mid-task. The pages that genuinely need a resume check for themselves.
  const afterRemoval = facts({ completedAt: "2026-08-06T00:00:00Z" });
  assert.equal(onboardingStatus(afterRemoval).complete, true);
  assert.equal(onboardingStatus(afterRemoval).currentStep, "resume");
});

/* ── the stored record ───────────────────────────────────────────────────── */

test("a missing / junk record reads as 'never started' rather than throwing", () => {
  for (const raw of [null, undefined, 42, "nope", [], {}]) {
    assert.deepEqual(coerceOnboarding(raw), emptyOnboarding());
  }
});

test("timestamps survive a round trip; blanks normalize to null", () => {
  const r = coerceOnboarding({
    version: ONBOARDING_VERSION,
    profile_approved_at: "2026-08-06T10:00:00Z",
    completed_at: "   ",
  });
  assert.equal(r.profile_approved_at, "2026-08-06T10:00:00Z");
  assert.equal(r.completed_at, null);
});

test("a record from a different step SET is dropped, not trusted", () => {
  const r = coerceOnboarding({ version: 99, profile_approved_at: "2026-01-01T00:00:00Z" });
  assert.deepEqual(r, emptyOnboarding());
});

/* ── step 3: counting keys off the RAW stored config ─────────────────────── */

test("counts enabled, non-empty keys across providers", () => {
  const cfg = {
    keys: {
      gemini: [
        { id: "a", key: "AIza-1", enabled: true },
        { id: "b", key: "", enabled: true }, // never entered
        { id: "c", key: "AIza-2", enabled: false }, // out of rotation
      ],
      anthropic: [{ id: "d", key: "sk-ant", enabled: true }],
    },
  };
  assert.equal(countUsableKeys(cfg), 2);
});

test("a key with no `enabled` field counts — absent means on, per the schema default", () => {
  assert.equal(countUsableKeys({ keys: { gemini: [{ id: "a", key: "AIza" }] } }), 1);
});

test("the LEGACY flat apiKey counts, so an older account isn't dragged back through setup", () => {
  assert.equal(countUsableKeys({ provider: "gemini", apiKey: "AIza-legacy" }), 1);
  // …but it is a fallback only: it must not double-count alongside a real key list.
  assert.equal(
    countUsableKeys({ apiKey: "AIza-legacy", keys: { gemini: [{ id: "a", key: "AIza", enabled: true }] } }),
    1
  );
});

test("an empty / absent / malformed config counts zero", () => {
  for (const raw of [null, undefined, {}, { keys: {} }, { keys: { gemini: "not-a-list" } }, { apiKey: "   " }]) {
    assert.equal(countUsableKeys(raw), 0);
  }
});

/* ── step 2: what approval requires ──────────────────────────────────────── */

const person = (over: Record<string, string> = {}) => ({
  personal_info: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", ...over },
});

test("a complete name + email is approvable", () => {
  assert.deepEqual(missingForApproval(person()), []);
  assert.equal(profileReadyForApproval(person()), true);
});

test("an EMPTY profile can't be approved — that would record a review that never happened", () => {
  const gaps = missingForApproval({});
  assert.deepEqual(gaps.map((g) => g.label), ["First name", "Last name", "Email address"]);
  assert.equal(profileReadyForApproval(null), false);
  assert.equal(profileReadyForApproval(undefined), false);
});

test("whitespace is not a value", () => {
  assert.deepEqual(
    missingForApproval(person({ first_name: "   " })).map((g) => g.path),
    ["personal_info.first_name"]
  );
});

test("a value that isn't an email address is a gap", () => {
  assert.deepEqual(
    missingForApproval(person({ email: "ada-at-example" })).map((g) => g.path),
    ["personal_info.email"]
  );
});

test("nothing beyond name + email is demanded — the rest genuinely varies", () => {
  assert.equal(profileReadyForApproval({ personal_info: { first_name: "A", last_name: "B", email: "a@b.co" } }), true);
});

/* ── the gate's cookie fast-path ─────────────────────────────────────────── */

test("the cookie only matches the SAME user — two accounts share a browser", () => {
  assert.equal(onboardedCookieMatches("user-1", "user-1"), true);
  assert.equal(onboardedCookieMatches("user-1", "user-2"), false);
  assert.equal(onboardedCookieMatches(undefined, "user-1"), false);
  assert.equal(onboardedCookieMatches("", "user-1"), false);
  // A blank user id can never be satisfied by a blank cookie.
  assert.equal(onboardedCookieMatches("", ""), false);
});
