import { test } from "node:test";
import assert from "node:assert/strict";
import { formatJd } from "../lib/jd-format";

// The fixture is the REAL shape of Linear's Ashby posting as `innerText` flattened it (2026-08-12) —
// the metadata stutter, then headings and de-markered bullets. It is why the scrape now emits markers.

test("the metadata stutter collapses into ONE grid, not a stack of two-line pairs", () => {
  const blocks = formatJd(
    "Senior / Staff Fullstack Engineer\n\nLocation\n\nEurope\n\nEmployment Type\n\nFull time\n\nLocation Type\n\nRemote\n\nDepartment\n\nProduct\n\nAt Linear, we're building things."
  );
  const meta = blocks.filter((b) => b.kind === "meta");
  assert.equal(meta.length, 1, "four adjacent fields are ONE block");
  assert.deepEqual((meta[0] as { rows: unknown }).rows, [
    { label: "Location", value: "Europe" },
    { label: "Employment Type", value: "Full time" },
    { label: "Location Type", value: "Remote" },
    { label: "Department", value: "Product" },
  ]);
  // The title and the prose are still there — pairing must never eat content.
  assert.ok(blocks.some((b) => b.kind === "para" && /Fullstack Engineer/.test(b.text)));
  assert.ok(blocks.some((b) => b.kind === "para" && /building things/.test(b.text)));
});

test("a consecutive run of `- ` items becomes ONE list", () => {
  const blocks = formatJd("## What you'll do\n\n- Build features\n\n- Optimize sync\n\n- Add analytics\n\n## Our tech\n\n- React");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["heading", "bullets", "heading", "bullets"]
  );
  assert.deepEqual((blocks[1] as { items: string[] }).items, ["Build features", "Optimize sync", "Add analytics"]);
});

test("markers are parsed, never shown as literal text", () => {
  const blocks = formatJd("## What we offer\n\n- Competitive salary");
  assert.equal((blocks[0] as { text: string }).text, "What we offer");
  assert.equal((blocks[1] as { items: string[] }).items[0], "Competitive salary");
});

// The case that PROVES the markers had to come from the DOM: these two lines are indistinguishable by
// every text-only signal (short, few words, no terminal period), so this file must NOT guess.
test("a short heading and a short bullet are only ever told apart by their marker", () => {
  const guessed = formatJd("What we offer\n\nGitHub, Slack, Notion");
  assert.deepEqual(guessed.map((b) => b.kind), ["para", "para"], "unmarked ⇒ no guessing, both prose");
  const marked = formatJd("## What we offer\n\n- GitHub, Slack, Notion");
  assert.deepEqual(marked.map((b) => b.kind), ["heading", "bullets"]);
});

// Measured on the live Ashby scrape (2026-08-12): Ashby marks its sidebar metadata labels as <h2>, so
// they arrive MARKED as headings. Rendering them as sections would reproduce the stutter in bigger type.
test("a marked HEADING that is really a field label still pairs into the grid", () => {
  const blocks = formatJd(
    "## Senior / Staff Fullstack Engineer\n\n## Location\n\nEurope\n\n## Employment Type\n\nFull time\n\n## Department\n\nProduct\n\n## What you'll do\n\n- Build features"
  );
  assert.deepEqual(blocks.map((b) => b.kind), ["heading", "meta", "heading", "bullets"]);
  assert.equal((blocks[0] as { text: string }).text, "Senior / Staff Fullstack Engineer", "the TITLE is a real heading");
  assert.deepEqual((blocks[1] as { rows: unknown }).rows, [
    { label: "Location", value: "Europe" },
    { label: "Employment Type", value: "Full time" },
    { label: "Department", value: "Product" },
  ]);
  assert.equal((blocks[2] as { text: string }).text, "What you'll do", "a real section heading is untouched");
});

test("a heading label followed by a LIST is a real section, not a field", () => {
  // "Location" above a bulleted list of offices is a heading — pairing it would eat the list.
  const blocks = formatJd("## Location\n\n- London\n\n- Berlin");
  assert.deepEqual(blocks.map((b) => b.kind), ["heading", "bullets"]);
});

test("a label whose value is a SENTENCE is prose, not a metadata field", () => {
  const blocks = formatJd("Location\n\nWe are hiring across Europe and will consider exceptional candidates anywhere.");
  assert.equal(blocks.filter((b) => b.kind === "meta").length, 0);
  assert.deepEqual(blocks.map((b) => b.kind), ["para", "para"]);
});

test("a label with no following value stays prose (never a half-empty grid row)", () => {
  const blocks = formatJd("Department");
  assert.deepEqual(blocks, [{ kind: "para", text: "Department" }]);
});

test("`Label: value` already paired on one line is read as a field", () => {
  const blocks = formatJd("Employment Type: Full time\n\nSome prose about the role.");
  assert.deepEqual((blocks[0] as { rows: unknown }).rows, [{ label: "Employment Type", value: "Full time" }]);
});

test("an unknown label is NOT invented into a field", () => {
  const blocks = formatJd("Vibe\n\nImmaculate");
  assert.deepEqual(blocks.map((b) => b.kind), ["para", "para"]);
});

test("legacy flat text still renders — paragraphs, nothing lost", () => {
  const flat = "Overview\n\nAt Linear we build.\n\nWhat you'll do\n\nBuild new user-facing features end to end.";
  const blocks = formatJd(flat);
  assert.equal(blocks.length, 4);
  assert.ok(blocks.every((b) => b.kind === "para"));
  const joined = blocks.map((b) => (b as { text: string }).text).join(" ");
  for (const frag of ["Overview", "At Linear we build", "What you'll do", "user-facing features"])
    assert.match(joined, new RegExp(frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("empty / whitespace ⇒ no blocks (the caller renders nothing)", () => {
  assert.deepEqual(formatJd(""), []);
  assert.deepEqual(formatJd("   \n\n  "), []);
  assert.deepEqual(formatJd(null), []);
  assert.deepEqual(formatJd(undefined), []);
});

test("a wrapped line inside one block does not become its own paragraph", () => {
  const blocks = formatJd("This sentence was\nwrapped by the page.\n\nA second block.");
  assert.equal(blocks.length, 2);
  assert.equal((blocks[0] as { text: string }).text, "This sentence was wrapped by the page.");
});
