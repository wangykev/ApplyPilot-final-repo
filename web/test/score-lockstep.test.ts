import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { SCORE_SYSTEM, buildCandidateSummary, buildScorePrompt, parseScoreReply, verdictForScore, MIN_JD_CHARS } from "../lib/score";
import type { Profile } from "../lib/profile-schema";

/**
 * The extension scores a posting in the POPUP, without the website in the loop — so lib.js carries a
 * plain-JS port of this file's rubric (the repo's TODO(dup) discipline). Two copies of a PROMPT drift in
 * the worst possible way: silently, and only in the answers. The same match card would then mean two
 * different things depending on where it was computed.
 *
 * Loading the real lib.js makes that drift a test failure. Same guard discover.js already has.
 */
const require_ = createRequire(import.meta.url);
const ext = require_("../../lib.js");

test("SCORE_SYSTEM is byte-identical in the extension's copy", () => {
  assert.equal(ext.SCORE_SYSTEM, SCORE_SYSTEM);
});

test("MIN_JD_CHARS is the same floor on both sides", () => {
  assert.equal(ext.MATCH_MIN_JD_CHARS, MIN_JD_CHARS);
});

test("verdictForScore agrees across the whole range, and on non-scores", () => {
  for (let s = 0; s <= 11; s++) assert.equal(ext.verdictForScore(s), verdictForScore(s), `score ${s}`);
  assert.equal(ext.verdictForScore(null), verdictForScore(null));
  assert.equal(ext.verdictForScore(Number.NaN), verdictForScore(Number.NaN));
});

// `unknown[]`, cast at each call: these are deliberately PARTIAL profiles (the point is that both
// copies tolerate the same holes), and a Profile-typed literal would have to spell out every field.
const PROFILES: unknown[] = [
  {},
  { skills: ["Python", "C++"] },
  {
    education: [
      { degree: ["BS", "Bachelor"], field_of_study: "Computer Engineering", school_or_university: "State U", gpa: "3.8", gpa_scale: "4.0", graduation_date: "2027-05" },
      { degree: "MS", school_or_university: "Other U", graduation_date: "YYYY-MM" },
    ],
    work_experience: [
      { job_title: "SWE Intern", company: "Acme", from: "2025-06", to: "2025-08", role_description: "Built an API\n- Wrote tests\n\n", tech_stack: ["Python", "FastAPI"] },
      { job_title: "Research Assistant", company: "Lab", from: "2024-01", to: "YYYY-MM" },
    ],
    skills: ["Python", "C++", "Git", ""],
    certifications: [{ certification: ["CPP", "Certified"] }, { certification: "" }],
    personal_info: { first_name: "Kevin", email: "kev@example.com" },
  },
];

test("buildCandidateSummary produces the same text on both sides", () => {
  for (const p of PROFILES) {
    assert.equal(ext.buildCandidateSummary(p), buildCandidateSummary(p as Profile), JSON.stringify(p).slice(0, 80));
  }
});

test("buildScorePrompt produces the same system+user on both sides", () => {
  const jd = "We are looking for an intern with Python and Kubernetes experience. ".repeat(200);
  for (const p of PROFILES) {
    const a = ext.buildScorePrompt(p, jd);
    const b = buildScorePrompt(p as Profile, jd);
    assert.equal(a.system, b.system);
    assert.equal(a.user, b.user);
  }
});

test("parseScoreReply agrees — including on the malformed replies", () => {
  const REPLIES = [
    '{"score":8,"matched_requirements":["Python"],"gaps":["K8s"],"keywords":["gRPC"],"reasoning":"Good."}',
    '```json\n{"score":6}\n```',
    'Sure:\n{"score":3,"reasoning":"Different field."}\nHope that helps.',
    '{"score":47}',
    '{"score":0}',
    '{"score":7.6}',
    '{"reasoning":"hmm"}',
    '{"score":5,"gaps":["  Go  ","",null,7],"keywords":"not-an-array"}',
    "I'm not able to score this.",
    "",
  ];
  for (const r of REPLIES) {
    const a = ext.parseScoreReply(r);
    const b = parseScoreReply(r);
    assert.deepEqual(
      { score: a.score, verdict: a.verdict, matched: a.matched_requirements, gaps: a.gaps, keywords: a.keywords, rationale: a.rationale, error: a.error ?? undefined },
      { score: b.score, verdict: b.verdict, matched: b.matched_requirements, gaps: b.gaps, keywords: b.keywords, rationale: b.rationale, error: b.error ?? undefined },
      `disagreement on ${JSON.stringify(r).slice(0, 60)}`
    );
  }
});
