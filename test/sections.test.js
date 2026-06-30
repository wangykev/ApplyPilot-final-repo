// Unit tests for parseRepeatingFkit (lib.js) — the load-bearing regex behind GENERIC
// repeating-section detection (enumerate-and-group on data-fkit-id, replacing the hardcoded
// 5-prefix catalog). The two EXCLUSION cases are the crux: it must NOT match the date
// sub-wrappers (which share the section prefix) NOR the lone "<name>--null" containers that
// are not repeating entries (e.g. the page-1 "phoneNumber--null"). A false match either way
// would make generic detection over-count entries or mis-detect a non-section as a section.
const test = require("node:test");
const assert = require("node:assert");

const { parseRepeatingFkit } = require("../lib.js");

test("parseRepeatingFkit parses a real entry container → { base, index }", () => {
  assert.deepStrictEqual(parseRepeatingFkit("workExperience-3--null"), { base: "workExperience", index: 3 });
  assert.deepStrictEqual(parseRepeatingFkit("education-0--null"), { base: "education", index: 0 });
  assert.deepStrictEqual(parseRepeatingFkit("certification-12--null"), { base: "certification", index: 12 });
  assert.deepStrictEqual(parseRepeatingFkit("webAddress-1--null"), { base: "webAddress", index: 1 });
  assert.deepStrictEqual(parseRepeatingFkit("language-2--null"), { base: "language", index: 2 });
});

test("parseRepeatingFkit detects an UNKNOWN section base (the whole point — no catalog)", () => {
  // a hypothetical new tenant section the hardcoded catalog never listed
  assert.deepStrictEqual(parseRepeatingFkit("publication-4--null"), { base: "publication", index: 4 });
});

test("parseRepeatingFkit EXCLUDES the date sub-wrappers (share the prefix, not entries)", () => {
  assert.strictEqual(parseRepeatingFkit("workExperience-3--startDate"), null);
  assert.strictEqual(parseRepeatingFkit("workExperience-3--endDate"), null);
});

test("parseRepeatingFkit EXCLUDES lone <name>--null that are NOT repeating entries", () => {
  // page-1 phone wrapper — no "-<digits>--" index segment → must be flat, never a section
  assert.strictEqual(parseRepeatingFkit("phoneNumber--null"), null);
  assert.strictEqual(parseRepeatingFkit("workExperience--null"), null); // no index digits
});

test("parseRepeatingFkit EXCLUDES nested-specialty FIELD nodes (no top-level --null)", () => {
  // cert Specialties are "certification-N--specialties-M--<field>" — they end in a field name,
  // not "--null", so they must NOT surface as a top-level section (the deferred nested case).
  assert.strictEqual(parseRepeatingFkit("certification-0--specialties-1--specialtyParent"), null);
  assert.strictEqual(parseRepeatingFkit("certification-0--specialties-0--startDate"), null);
});

test("parseRepeatingFkit returns null for junk / non-fkit input", () => {
  assert.strictEqual(parseRepeatingFkit(""), null);
  assert.strictEqual(parseRepeatingFkit(null), null);
  assert.strictEqual(parseRepeatingFkit(undefined), null);
  assert.strictEqual(parseRepeatingFkit("formField-jobTitle"), null);
});
