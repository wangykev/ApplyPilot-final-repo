// Unit tests for score.js — JD-match scoring (the "should I even apply?" signal).
// A FAKE llm is injected (scoreJob's 2nd arg, same { ok, text } shape callLLM
// returns) so no network: assert the verdict buckets, that the candidate summary
// includes resume content but NO PII/demographic data, and that every scoreJob
// path returns a normalized result and NEVER throws.
const { test } = require("node:test");
const assert = require("node:assert");
const { scoreJob, verdictForScore, buildCandidateSummary, MIN_JD_CHARS } = require("../score.js");

// A fake llm that records its calls and returns a canned reply.
function fakeLlm(reply) {
  const calls = [];
  const fn = async (req) => { calls.push(req); return reply; };
  fn.calls = calls;
  return fn;
}

const JD = "Software Engineering Intern. Requirements: C++, embedded systems, CAN bus, FPGA, real-time motor control firmware.";

const PROFILE = {
  personal_info: { first_name: "Kevin", last_name: "Wang", email: "secret@example.com", phone_number: "555-0100" },
  work_authorization: { citizenship_country: ["Narnia"] },
  self_identification: { gender: "nonbinary-secret", race_ethnicity: "demographic-secret" },
  education: [{ degree: ["Bachelor of Science"], field_of_study: ["Electrical and Computer Engineering"], school_or_university: "Carnegie Mellon University", gpa: "3.95", gpa_scale: "4.00", graduation_date: "2028-05" }],
  work_experience: [{ job_title: "Robotics Lab Intern", company: "FSU", from: "2025-05", to: "2025-08", bullets: ["Built ROS 2 nodes for CAN bus motor control"], tech_stack: ["ROS 2", "C++"] }],
  projects: [{ name: "FPGA Motor Control", summary: "real-time PWM on an FPGA", bullets: ["fixed-point PID speed loop"], tech_stack: ["SystemVerilog"] }],
  skills: ["SystemVerilog", "Altium Designer"],
  certifications: [{ certification: "" }]
};

// ── verdictForScore ─────────────────────────────────────────────────────────
test("verdictForScore: bucket boundaries (>=8 strong, 5-7 moderate, <5 weak)", () => {
  assert.strictEqual(verdictForScore(10), "strong");
  assert.strictEqual(verdictForScore(8), "strong");
  assert.strictEqual(verdictForScore(7), "moderate");
  assert.strictEqual(verdictForScore(5), "moderate");
  assert.strictEqual(verdictForScore(4), "weak");
  assert.strictEqual(verdictForScore(1), "weak");
});
test("verdictForScore: non-number → null (no false bucket)", () => {
  assert.strictEqual(verdictForScore(null), null);
  assert.strictEqual(verdictForScore(NaN), null);
  assert.strictEqual(verdictForScore("7"), null);
});

// ── buildCandidateSummary ─────────────────────────────────────────────────────
test("buildCandidateSummary: includes resume content (work bullets, tech, skills, projects, education)", () => {
  const s = buildCandidateSummary(PROFILE);
  assert.match(s, /Robotics Lab Intern/);
  assert.match(s, /ROS 2 nodes for CAN bus/);
  assert.match(s, /SystemVerilog/);
  assert.match(s, /FPGA Motor Control/);
  assert.match(s, /Carnegie Mellon University/);
  assert.match(s, /Bachelor of Science/);
});
test("buildCandidateSummary: OMITS PII and demographic/auth data (never enters the prompt)", () => {
  const s = buildCandidateSummary(PROFILE);
  assert.ok(!s.includes("secret@example.com"), "no email");
  assert.ok(!s.includes("555-0100"), "no phone");
  assert.ok(!s.includes("Narnia"), "no citizenship");
  assert.ok(!s.includes("nonbinary-secret"), "no gender");
  assert.ok(!s.includes("demographic-secret"), "no race/ethnicity");
});
test("buildCandidateSummary: empty / missing profile → '' (never throws)", () => {
  assert.strictEqual(buildCandidateSummary({}), "");
  assert.strictEqual(buildCandidateSummary(null), "");
  assert.strictEqual(buildCandidateSummary(undefined), "");
});

// ── scoreJob happy path ───────────────────────────────────────────────────────
test("scoreJob: parses a clean JSON reply, derives verdict code-side, normalizes arrays", async () => {
  const llm = fakeLlm({ ok: true, text: JSON.stringify({ score: 7, matched_requirements: ["ROS 2", "C++"], gaps: ["FPGA production years"], keywords: ["CAN bus", "firmware"], reasoning: "Strong hands-on embedded fit; minor gaps." }) });
  const r = await scoreJob({ profile: PROFILE, jd: JD }, llm);
  assert.strictEqual(r.score, 7);
  assert.strictEqual(r.verdict, "moderate", "verdict derived from score, not the model");
  assert.deepStrictEqual(r.matched_requirements, ["ROS 2", "C++"]);
  assert.deepStrictEqual(r.gaps, ["FPGA production years"]);
  assert.deepStrictEqual(r.keywords, ["CAN bus", "firmware"]);
  assert.match(r.rationale, /embedded fit/);
  assert.strictEqual(llm.calls.length, 1);
  // the prompt carries both the candidate background and the JD
  assert.match(llm.calls[0].user, /CANDIDATE BACKGROUND/);
  assert.match(llm.calls[0].user, /Robotics Lab Intern/);
  assert.match(llm.calls[0].user, /CAN bus/);
});

test("scoreJob: tolerates a ```json code-fenced reply", async () => {
  const llm = fakeLlm({ ok: true, text: "```json\n{ \"score\": 9, \"reasoning\": \"great\" }\n```" });
  const r = await scoreJob({ profile: PROFILE, jd: JD }, llm);
  assert.strictEqual(r.score, 9);
  assert.strictEqual(r.verdict, "strong");
});

test("scoreJob: clamps score to 1-10 and rounds", async () => {
  const hi = await scoreJob({ profile: PROFILE, jd: JD }, fakeLlm({ ok: true, text: JSON.stringify({ score: 15 }) }));
  assert.strictEqual(hi.score, 10);
  const lo = await scoreJob({ profile: PROFILE, jd: JD }, fakeLlm({ ok: true, text: JSON.stringify({ score: 0 }) }));
  assert.strictEqual(lo.score, 1);
});

// ── scoreJob failure paths (never throws, never a false score) ────────────────
test("scoreJob: llm { ok:false } → { score:null, error }, never throws", async () => {
  const llm = fakeLlm({ ok: false, error: "HTTP 401: invalid api key" });
  const r = await scoreJob({ profile: PROFILE, jd: JD }, llm);
  assert.strictEqual(r.score, null);
  assert.match(r.error, /401/);
  assert.strictEqual(llm.calls.length, 1);
});

test("scoreJob: unparseable reply → { score:null, error:'parse-failed' } with raw kept", async () => {
  const llm = fakeLlm({ ok: true, text: "I'd say about a 7 out of 10 honestly" });
  const r = await scoreJob({ profile: PROFILE, jd: JD }, llm);
  assert.strictEqual(r.score, null);
  assert.strictEqual(r.error, "parse-failed");
  assert.match(r.raw, /7 out of 10/);
});

test("scoreJob: JSON with no numeric score → { score:null, error }", async () => {
  const llm = fakeLlm({ ok: true, text: JSON.stringify({ reasoning: "forgot the score" }) });
  const r = await scoreJob({ profile: PROFILE, jd: JD }, llm);
  assert.strictEqual(r.score, null);
  assert.match(r.error, /no score/);
});

// ── scoreJob JD gate (no spend on empty/placeholder JD) ───────────────────────
test("scoreJob: empty JD short-circuits to { error:'no-jd' } WITHOUT calling the llm", async () => {
  const llm = fakeLlm({ ok: true, text: JSON.stringify({ score: 9 }) });
  const r = await scoreJob({ profile: PROFILE, jd: "" }, llm);
  assert.strictEqual(r.score, null);
  assert.strictEqual(r.error, "no-jd");
  assert.strictEqual(llm.calls.length, 0, "no LLM spend on an empty JD");
});

test("scoreJob: too-short JD (below MIN_JD_CHARS) also gates out without an llm call", async () => {
  const llm = fakeLlm({ ok: true, text: JSON.stringify({ score: 9 }) });
  const short = "x".repeat(MIN_JD_CHARS - 1);
  const r = await scoreJob({ profile: PROFILE, jd: short }, llm);
  assert.strictEqual(r.error, "no-jd");
  assert.strictEqual(llm.calls.length, 0);
});

test("scoreJob: JD present but no llm function provided → error, never throws", async () => {
  const r = await scoreJob({ profile: PROFILE, jd: JD }, undefined);
  assert.strictEqual(r.score, null);
  assert.match(r.error, /no llm/);
});
