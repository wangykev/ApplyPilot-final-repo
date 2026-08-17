import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResumePrompt } from "../lib/resume-prompt";

/**
 * The parse dropped the operator's THIRD bullet on every role (reported live 2026-08-16). It was not
 * a model failure — the prompt ASKED for "ONE paragraph (a few sentences) … NOT a bulleted list", and
 * a summarising instruction is a lossy one. `projects[]` had always been told to keep bullets
 * verbatim; work experience was the odd one out.
 */
test("the parse prompt demands EVERY work bullet verbatim, never a summary", () => {
  const { system } = buildResumePrompt("");
  const s = String(system);

  // the instruction that caused the loss must be gone
  assert.equal(/ONE paragraph/i.test(s), false, "a 'one paragraph' instruction summarises, and summarising drops bullets");
  assert.equal(/a few sentences/i.test(s), false);

  // and completeness must be demanded explicitly
  assert.match(s, /role_description/);
  assert.match(s, /VERBATIM/);
  assert.match(s, /EVERY bullet|none omitted/i);

  // it still has to fill a single plain text box — completeness must not smuggle in markup
  assert.match(s, /no leading bullet glyphs|plain text/i);
});

test("projects keep their verbatim rule — work experience now matches it", () => {
  const { system } = buildResumePrompt("");
  assert.match(String(system), /projects\[\][^.]*VERBATIM/i);
});
