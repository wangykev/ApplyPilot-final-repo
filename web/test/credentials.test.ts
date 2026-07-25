import { test } from "node:test";
import assert from "node:assert/strict";
import { passwordRequirements, passwordMeetsRequirements } from "../lib/credentials";

test("passwordMeetsRequirements: enforces Workday's account-creation policy", () => {
  // A password that satisfies all six rules.
  assert.equal(passwordMeetsRequirements("Abcdef1!"), true);
  assert.equal(passwordMeetsRequirements("Str0ng#Pass"), true);

  // Each single failing dimension.
  assert.equal(passwordMeetsRequirements("Abc1!"), false, "too short (<8)");
  assert.equal(passwordMeetsRequirements("ABCDEF1!"), false, "no lowercase");
  assert.equal(passwordMeetsRequirements("abcdef1!"), false, "no uppercase");
  assert.equal(passwordMeetsRequirements("Abcdefg1"), false, "no special character");
  assert.equal(passwordMeetsRequirements("Abcdefg!"), false, "no number");
  assert.equal(passwordMeetsRequirements(""), false, "empty");
});

test("passwordRequirements: reports each rule's met state for the live checklist", () => {
  const reqs = passwordRequirements("Abcdef1!");
  assert.deepEqual(
    reqs.map((r) => r.id).sort(),
    ["alpha", "len", "lower", "num", "special", "upper"],
    "all six rules present"
  );
  assert.ok(reqs.every((r) => r.met), "a compliant password meets every rule");

  const weak = passwordRequirements("abc");
  const byId = Object.fromEntries(weak.map((r) => [r.id, r.met]));
  assert.equal(byId.lower, true);
  assert.equal(byId.alpha, true);
  assert.equal(byId.len, false);
  assert.equal(byId.upper, false);
  assert.equal(byId.num, false);
  assert.equal(byId.special, false);
});
