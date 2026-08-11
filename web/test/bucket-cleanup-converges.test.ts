import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceBuckets } from "../lib/buckets";

/**
 * The one-shot rewrite in loadBuckets fires when the RAW stored row differs from its coerced form.
 * That is only "one-shot" if coercion is a fixed point: coerce(coerce(x)) === coerce(x). If it were
 * not, every profile-page load would write to the database forever.
 */

test("the cleanup rewrites once, then becomes a NO-OP", () => {
  const stored = [
    { id: "x", profile_path: "a.b", value: "legacy string", questions: ["Language*", "Language"] },
  ];
  const once = coerceBuckets(stored as unknown);
  assert.notEqual(JSON.stringify(stored), JSON.stringify(once), "the first load must rewrite");
  const twice = coerceBuckets(once);
  assert.equal(JSON.stringify(once), JSON.stringify(twice), "the second load must not");
});

test("an already-clean row is never rewritten at all", () => {
  const clean = coerceBuckets([
    { id: "x", profile_path: "a.b", value: [], category: "", widget_hint: "", questions: ["Language"], selectors: {} },
  ]);
  assert.equal(JSON.stringify(clean), JSON.stringify(coerceBuckets(clean)));
});

test("key ORDER is stable across a round trip (JSON compare is order-sensitive)", () => {
  // The comparison is a string compare, so a coercion that reordered keys would look like a change
  // on every load even when nothing differed.
  const a = coerceBuckets([{ id: "x", profile_path: "p", value: [], questions: ["Q"] }]);
  const b = coerceBuckets(JSON.parse(JSON.stringify(a)));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("the cleanup carries the wording fix through — this is what it exists to persist", () => {
  const once = coerceBuckets([
    { id: "x", profile_path: "a.b", value: [], category: "", widget_hint: "", questions: ["Language*", "Language"], selectors: {} },
  ]);
  assert.deepEqual(once[0].questions, ["Language"]);
});
