// Unit test for the IndexedDB storage helpers (db.js) — runs without a live page.
// fake-indexeddb/auto installs a faithful in-memory IndexedDB on the global, so
// the helpers exercise real IDB semantics (transactions, keyPath, upgrade).
// Tests run sequentially in definition order, sharing one in-memory DB, so the
// "empty DB" case must come first.
require("fake-indexeddb/auto");
const test = require("node:test");
const assert = require("node:assert");

const { saveResume, getResume, deleteResume, RESUME_KEY } = require("../db.js");

test("getResume returns undefined when nothing is stored", async () => {
  const rec = await getResume();
  assert.strictEqual(rec, undefined);
});

test("saveResume -> getResume round-trips bytes and metadata", async () => {
  const record = {
    key: RESUME_KEY,
    filename: "resume.pdf",
    mime: "application/pdf",
    size: 4,
    base64: "JVBE", // arbitrary base64 payload — round-trip must preserve it exactly
    savedAt: 123,
  };
  await saveResume(record);
  const got = await getResume();
  assert.ok(got, "expected a stored record");
  assert.strictEqual(got.key, RESUME_KEY);
  assert.strictEqual(got.filename, "resume.pdf");
  assert.strictEqual(got.mime, "application/pdf");
  assert.strictEqual(got.size, 4);
  assert.strictEqual(got.base64, "JVBE");
});

test("re-saving under the same key overwrites (single fixed resume)", async () => {
  await saveResume({ key: RESUME_KEY, filename: "old.pdf", base64: "AAAA" });
  await saveResume({ key: RESUME_KEY, filename: "new.pdf", base64: "BBBB" });
  const got = await getResume();
  assert.strictEqual(got.filename, "new.pdf");
  assert.strictEqual(got.base64, "BBBB");
});

test("saveResume defaults the key to RESUME_KEY when omitted", async () => {
  await saveResume({ filename: "nokey.pdf", base64: "CCCC" });
  const got = await getResume(RESUME_KEY);
  assert.strictEqual(got.filename, "nokey.pdf");
});

test("deleteResume removes the stored record (AP_CLEAR_RESUME handoff)", async () => {
  await saveResume({ key: RESUME_KEY, filename: "to-delete.pdf", base64: "DDDD" });
  assert.ok(await getResume(), "precondition: a resume is stored");
  await deleteResume();
  assert.strictEqual(await getResume(), undefined, "resume should be gone after delete");
});

test("deleteResume is a no-op when nothing is stored (idempotent)", async () => {
  await deleteResume(); // already empty from the prior test — must still resolve
  assert.strictEqual(await getResume(), undefined);
});
