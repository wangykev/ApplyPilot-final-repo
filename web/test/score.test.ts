import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verdictForScore,
  buildCandidateSummary,
  buildScorePrompt,
  parseScoreReply,
} from "@/lib/score";
import { coerceProfile } from "@/lib/profile-schema";

const PROFILE = coerceProfile({
  personal_info: { first_name: "Kevin", last_name: "Wang", email: "secret@example.com", phone_number: "555-0100" },
  work_authorization: { citizenship_country: "Narnia" }, // string → coerced to ["Narnia"]
  self_identification: { gender: "nonbinary-secret", race_ethnicity: "demographic-secret" },
  education: [
    {
      degree: "Bachelor of Science",
      field_of_study: "Electrical and Computer Engineering",
      school_or_university: "Carnegie Mellon University",
      gpa: "3.95",
      gpa_scale: "4.00",
      graduation_date: "2028-05",
    },
  ],
  work_experience: [
    {
      job_title: "Robotics Lab Intern",
      company: "FSU",
      from: "2025-05",
      to: "2025-08",
      role_description: "- Built ROS 2 nodes for CAN bus motor control",
      tech_stack: ["ROS 2", "C++"],
    },
  ],
  skills: ["SystemVerilog", "Altium Designer"],
});

const JD =
  "Software Engineering Intern. Requirements: C++, embedded systems, CAN bus, FPGA, real-time motor control firmware.";

// ── verdictForScore ─────────────────────────────────────────────────────────
test("verdictForScore: bucket boundaries (>=8 strong, 5-7 moderate, <5 weak)", () => {
  assert.equal(verdictForScore(10), "strong");
  assert.equal(verdictForScore(8), "strong");
  assert.equal(verdictForScore(7), "moderate");
  assert.equal(verdictForScore(5), "moderate");
  assert.equal(verdictForScore(4), "weak");
  assert.equal(verdictForScore(1), "weak");
});
test("verdictForScore: non-number → null", () => {
  assert.equal(verdictForScore(null), null);
  assert.equal(verdictForScore(NaN), null);
});

// ── buildCandidateSummary ─────────────────────────────────────────────────────
test("buildCandidateSummary: includes resume content (work, role description, tech, skills, education)", () => {
  const s = buildCandidateSummary(PROFILE);
  assert.match(s, /Robotics Lab Intern/);
  assert.match(s, /ROS 2 nodes for CAN bus/);
  assert.match(s, /SystemVerilog/);
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
test("buildCandidateSummary: empty profile → '' (never throws)", () => {
  assert.equal(buildCandidateSummary(coerceProfile({})), "");
});

// ── buildScorePrompt ──────────────────────────────────────────────────────────
test("buildScorePrompt: carries both the candidate background and the JD", () => {
  const { system, user } = buildScorePrompt(PROFILE, JD);
  assert.match(system, /1-10/);
  assert.match(user, /CANDIDATE BACKGROUND/);
  assert.match(user, /Robotics Lab Intern/);
  assert.match(user, /JOB DESCRIPTION/);
  assert.match(user, /CAN bus/);
});

// ── parseScoreReply ───────────────────────────────────────────────────────────
test("parseScoreReply: clean JSON → score + code-side verdict + normalized arrays", () => {
  const r = parseScoreReply(
    JSON.stringify({
      score: 7,
      matched_requirements: ["ROS 2", "C++"],
      gaps: ["FPGA production years"],
      keywords: ["CAN bus", "firmware"],
      reasoning: "Strong hands-on embedded fit; minor gaps.",
    })
  );
  assert.equal(r.score, 7);
  assert.equal(r.verdict, "moderate");
  assert.deepEqual(r.matched_requirements, ["ROS 2", "C++"]);
  assert.deepEqual(r.gaps, ["FPGA production years"]);
  assert.deepEqual(r.keywords, ["CAN bus", "firmware"]);
  assert.match(r.rationale, /embedded fit/);
});
test("parseScoreReply: tolerates a ```json code fence", () => {
  const r = parseScoreReply('```json\n{ "score": 9, "reasoning": "great" }\n```');
  assert.equal(r.score, 9);
  assert.equal(r.verdict, "strong");
});
test("parseScoreReply: clamps score to 1-10 and rounds", () => {
  assert.equal(parseScoreReply(JSON.stringify({ score: 15 })).score, 10);
  assert.equal(parseScoreReply(JSON.stringify({ score: 0 })).score, 1);
});
test("parseScoreReply: unparseable reply → { score:null, error:'parse-failed' }", () => {
  const r = parseScoreReply("I'd say about a 7 out of 10 honestly");
  assert.equal(r.score, null);
  assert.equal(r.error, "parse-failed");
  assert.match(r.raw ?? "", /7 out of 10/);
});
test("parseScoreReply: JSON with no numeric score → { score:null, error }", () => {
  const r = parseScoreReply(JSON.stringify({ reasoning: "forgot the score" }));
  assert.equal(r.score, null);
  assert.match(r.error ?? "", /no score/);
});
