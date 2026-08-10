import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceBuckets,
  reconcileBucketsToProfile,
  activeBuckets,
  type Bucket,
} from "../lib/buckets";

function bucket(path: string, qs: string[], extra: Partial<Bucket> = {}): Bucket {
  return coerceBuckets([
    { id: path || "modeB", profile_path: path, value: [], category: "", widget_hint: "", questions: qs, selectors: {}, ...extra },
  ])[0];
}

test("an UNCHANGED answer leaves its bucket completely alone", () => {
  const before = { work_authorization: { authorized_to_work_in_us: true } };
  const after = { work_authorization: { authorized_to_work_in_us: true } };
  const b = bucket("work_authorization.authorized_to_work_in_us", ["Are you authorized to work?"]);
  const r = reconcileBucketsToProfile([b], before, after);
  assert.deepEqual(r.archived, []);
  assert.deepEqual(r.restored, []);
  assert.deepEqual(r.buckets[0], b);
});

test("a CHANGED answer parks the bucket, keeping its wordings", () => {
  const before = { education: [{ gpa: "3.9" }] };
  const after = { education: [{ gpa: "3.5" }] };
  const b = bucket("education.0.gpa", ["GPA", "Grade point average"]);
  const r = reconcileBucketsToProfile([b], before, after);
  assert.equal(r.buckets[0].archived, true);
  assert.equal(r.buckets[0].archived_answer, "3.9");
  assert.deepEqual(r.buckets[0].questions, ["GPA", "Grade point average"], "wordings must survive");
  assert.equal(r.archived[0].from, "3.9");
  assert.equal(r.archived[0].to, "3.5");
});

test("the reported bug: an answer that goes BLANK parks rather than silently empties", () => {
  // A resume import that shortens work_experience leaves entry 2 pointing at nothing.
  const before = { work_experience: [{ company: "A" }, { company: "B" }, { company: "C" }] };
  const after = { work_experience: [{ company: "A" }] };
  const b = bucket("work_experience.2.company", ["Most recent employer"]);
  const r = reconcileBucketsToProfile([b], before, after);
  assert.equal(r.buckets[0].archived, true);
  assert.equal(r.buckets[0].archived_answer, "C");
  assert.equal(r.archived[0].to, "");
});

test("an answer that comes BACK restores the parked bucket", () => {
  const parked = bucket("education.0.gpa", ["GPA"], { archived: true, archived_answer: "3.9" });
  const r = reconcileBucketsToProfile([parked], { education: [{ gpa: "3.5" }] }, { education: [{ gpa: "3.9" }] });
  assert.ok(!r.buckets[0].archived);
  assert.ok(!r.buckets[0].archived_answer);
  assert.equal(r.restored[0].answer, "3.9");
});

test("a DIFFERENT answer does NOT restore a parked bucket", () => {
  // Re-attaching taught wordings to an answer they were never taught for is the silent-wrong-answer
  // failure buckets exist to prevent.
  const parked = bucket("education.0.gpa", ["GPA"], { archived: true, archived_answer: "3.9" });
  const r = reconcileBucketsToProfile([parked], { education: [{ gpa: "3.5" }] }, { education: [{ gpa: "3.7" }] });
  assert.equal(r.buckets[0].archived, true);
  assert.deepEqual(r.restored, []);
});

test("Mode-B buckets are never touched — no profile edit can invalidate them", () => {
  const b = bucket("", ["Why do you want to work here?"]);
  const r = reconcileBucketsToProfile([b], { anything: 1 }, { anything: 2 });
  assert.deepEqual(r.buckets[0], b);
  assert.deepEqual(r.archived, []);
});

test("tiered array answers compare by CONTENT, so a re-serialised list is not a change", () => {
  const b = bucket("work_authorization.citizenship_country", ["Citizenship"]);
  const before = { work_authorization: { citizenship_country: ["United States of America", "USA"] } };
  const after = { work_authorization: { citizenship_country: ["United States of America", "USA"] } };
  assert.deepEqual(reconcileBucketsToProfile([b], before, after).archived, []);

  const changed = { work_authorization: { citizenship_country: ["Canada"] } };
  assert.equal(reconcileBucketsToProfile([b], before, changed).archived.length, 1);
});

test("booleans compare as booleans, not object identity", () => {
  const b = bucket("screening.at_least_18_years_old", ["Are you at least 18?"]);
  const same = reconcileBucketsToProfile([b], { screening: { at_least_18_years_old: true } }, { screening: { at_least_18_years_old: true } });
  assert.deepEqual(same.archived, []);
  const flipped = reconcileBucketsToProfile([b], { screening: { at_least_18_years_old: true } }, { screening: { at_least_18_years_old: false } });
  assert.equal(flipped.archived[0].from, "true");
  assert.equal(flipped.archived[0].to, "false");
});

test("activeBuckets hides parked ones — that is what reaches the extension", () => {
  const live = bucket("a.b", ["Q1"]);
  const parked = bucket("c.d", ["Q2"], { archived: true, archived_answer: "x" });
  assert.deepEqual(activeBuckets([live, parked]).map((b) => b.profile_path), ["a.b"]);
});

test("pre-existing buckets (no archived field) load as ACTIVE", () => {
  const legacy = coerceBuckets([
    { id: "x", profile_path: "a.b", value: [], category: "", widget_hint: "", questions: ["Q"], selectors: {} },
  ]);
  assert.ok(!legacy[0].archived, "absent === active");
  assert.equal(activeBuckets(legacy).length, 1);
});

test("archiving never DELETES a bucket — the set keeps its size", () => {
  const bs = [bucket("a.b", ["Q1"]), bucket("c.d", ["Q2"])];
  const r = reconcileBucketsToProfile(bs, { a: { b: "1" }, c: { d: "2" } }, { a: { b: "9" }, c: { d: "9" } });
  assert.equal(r.buckets.length, 2);
  assert.equal(r.archived.length, 2);
});
