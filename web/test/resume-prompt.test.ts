import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResumePrompt, bulletizeRoleDescriptions } from "../lib/resume-prompt";

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

  // it still has to fill a single plain text box — plain text, no markup
  assert.match(s, /plain text/i);
  // …and each line carries a "- " marker (operator, 2026-08-16)
  assert.match(s, /prefixed with/i);
});

// The prompt asks for the markers, but a model that forgets on one role of four yields a
// description inconsistent with its neighbours — the kind of near-miss nobody catches before it is
// on an employer's form. The shape is therefore enforced, not requested.
test("bulletizeRoleDescriptions: every line gets '- ', and re-parsing never stacks markers", () => {
  const p = {
    work_experience: [
      { role_description: "Developed ROS 2 nodes.\nImplemented CAN bus protocols." },
      { role_description: "- Already bulleted.\n• Bullet glyph.\n– En dash.\n* Star." },
      { role_description: "  \n\nSpaced out.\n \n" },
      { role_description: "" },
      {},
    ],
  };
  const out = bulletizeRoleDescriptions(p) as typeof p;
  assert.deepEqual(out.work_experience[0].role_description!.split("\n"),
    ["- Developed ROS 2 nodes.", "- Implemented CAN bus protocols."]);
  // idempotent across every marker shape — no "- - Already bulleted."
  assert.deepEqual(out.work_experience[1].role_description!.split("\n"),
    ["- Already bulleted.", "- Bullet glyph.", "- En dash.", "- Star."]);
  // blank lines are dropped, not bulleted into empty "- " rows
  assert.equal(out.work_experience[2].role_description, "- Spaced out.");
  assert.equal(out.work_experience[3].role_description, "", "an empty description stays empty");
  // running it twice changes nothing
  assert.deepEqual(bulletizeRoleDescriptions(structuredClone(out)), out);
});

test("projects keep their verbatim rule — work experience now matches it", () => {
  const { system } = buildResumePrompt("");
  assert.match(String(system), /projects\[\][^.]*VERBATIM/i);
});
