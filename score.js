// ============================================================================
// score.js — JD-match scoring (the "should I even apply?" signal). Pure brain,
// UMD-lite (SW importScripts, popup <script>, Node require — the llm.js/db.js
// pattern), so it's unit-testable with an INJECTED llm.
//
// The LLM is passed in as `llm(req) -> { ok, text } | { ok:false, error }` — the
// SAME shape callLLM returns. The SW binds it to callLLM + the operator's
// llmConfig (OFF unless the AI toggle is on); tests pass a fake. This file does
// NOT import llm.js and does NOT touch chrome.storage — it only builds a prompt,
// calls the injected llm, and parses. It NEVER throws: every failure is a
// normalized { score:null, error } (mirrors the callLLM contract and the
// guess+flag safety ethos — a score is advisory, never blocks anything).
//
// Rubric adapted from ApplyPilot-oss-reference/src/applypilot/scoring/scorer.py
// (1-10 fit scale + ATS keywords), extended to emit matched/gaps as arrays.
// ============================================================================

// System prompt — the fit rubric. Kept provider-agnostic (goes in `system`).
const SCORE_SYSTEM = [
  "You are a job-fit evaluator. Given a candidate's background and a job description,",
  "score how well the candidate fits the role on a 1-10 scale.",
  "",
  "SCORING CRITERIA:",
  "- 9-10: Perfect match. Direct experience in nearly all required skills and qualifications.",
  "- 7-8: Strong match. Most required skills; minor gaps easily bridged.",
  "- 5-6: Moderate match. Some relevant skills but missing key requirements.",
  "- 3-4: Weak match. Significant skill gaps; substantial ramp-up needed.",
  "- 1-2: Poor match. Completely different field or experience level.",
  "",
  "WEIGHTING:",
  "- Weight technical skills heavily (languages, frameworks, tools).",
  "- Credit transferable experience (automation, scripting, API / hardware / firmware / research work).",
  "- Factor in project experience, not just employment.",
  "- Judge against the ROLE'S actual seniority bar: for an internship or new-grad role, do NOT",
  "  penalize a candidate for lacking senior/industry years; for a senior role, do.",
  "",
  "Respond with ONLY a JSON object — no prose, no markdown code fence:",
  '{',
  '  "score": <integer 1-10>,',
  '  "matched_requirements": [<short strings: JD requirements the candidate clearly meets>],',
  '  "gaps": [<short strings: JD requirements the candidate misses or only partially meets>],',
  '  "keywords": [<ATS keywords from the JD that match, or could match, the candidate>],',
  '  "reasoning": "<2-3 sentences explaining the score>"',
  '}'
].join("\n");

// Minimum JD length worth scoring — below this it's almost certainly empty /
// a placeholder, and scoring off noise gives a confident-but-meaningless number.
const MIN_JD_CHARS = 40;

// verdictForScore — the CODE-SIDE source of truth for the strong/moderate/weak
// bucket (never trust a model-emitted verdict). Conservative about "strong".
function verdictForScore(score) {
  if (typeof score !== "number" || !isFinite(score)) return null;
  if (score >= 8) return "strong";
  if (score >= 5) return "moderate";
  return "weak";
}

// firstText — a profile field may be a tiered candidate ARRAY (degree,
// field_of_study, country) or a plain string. For a summary we want readable
// text: join a non-empty array, pass a string through, else "".
function firstText(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== "").join(", ");
  return v == null ? "" : String(v).trim();
}

// buildCandidateSummary — distill the profile into a compact plain-text block
// for scoring. Includes ONLY resume-relevant sections (education, work,
// projects, skills, certifications, relevant coursework). Deliberately EXCLUDES
// personal_info / work_authorization / self_identification / agreements /
// essay_drafts / story_bank — no PII or protected/demographic data enters the
// prompt. Tolerant of a missing/empty profile (returns "" rather than throwing).
function buildCandidateSummary(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const lines = [];

  const edu = Array.isArray(p.education) ? p.education : [];
  const eduLines = edu.map((e) => {
    if (!e || typeof e !== "object") return "";
    const parts = [
      firstText(e.degree),
      firstText(e.field_of_study),
      e.school_or_university,
      e.gpa ? "GPA " + firstText(e.gpa) + (e.gpa_scale ? "/" + firstText(e.gpa_scale) : "") : "",
      e.graduation_date && e.graduation_date !== "YYYY-MM" ? "grad " + e.graduation_date : ""
    ].map((x) => (x == null ? "" : String(x).trim())).filter(Boolean);
    return parts.length ? "- " + parts.join(", ") : "";
  }).filter(Boolean);
  if (eduLines.length) lines.push("EDUCATION:", ...eduLines, "");

  const work = Array.isArray(p.work_experience) ? p.work_experience : [];
  const workLines = [];
  work.forEach((w) => {
    if (!w || typeof w !== "object") return;
    const head = [w.job_title, w.company].map((x) => (x == null ? "" : String(x).trim())).filter(Boolean).join(" @ ");
    const dates = [w.from, w.to].filter((d) => d && d !== "YYYY-MM").join("-");
    if (head || dates) workLines.push("- " + [head, dates ? "(" + dates + ")" : ""].filter(Boolean).join(" "));
    (Array.isArray(w.bullets) ? w.bullets : []).forEach((b) => { if (b && String(b).trim()) workLines.push("  * " + String(b).trim()); });
    const tech = firstText(w.tech_stack);
    if (tech) workLines.push("  tech: " + tech);
  });
  if (workLines.length) lines.push("WORK EXPERIENCE:", ...workLines, "");

  const projects = Array.isArray(p.projects) ? p.projects : [];
  const projLines = [];
  projects.forEach((pr) => {
    if (!pr || typeof pr !== "object") return;
    if (pr.name && String(pr.name).trim()) projLines.push("- " + String(pr.name).trim());
    if (pr.summary && String(pr.summary).trim()) projLines.push("  " + String(pr.summary).trim());
    (Array.isArray(pr.bullets) ? pr.bullets : []).forEach((b) => { if (b && String(b).trim()) projLines.push("  * " + String(b).trim()); });
    const tech = firstText(pr.tech_stack);
    if (tech) projLines.push("  tech: " + tech);
  });
  if (projLines.length) lines.push("PROJECTS:", ...projLines, "");

  const skills = Array.isArray(p.skills) ? p.skills.filter((s) => s && String(s).trim()) : [];
  if (skills.length) lines.push("SKILLS: " + skills.join(", "), "");

  const certs = Array.isArray(p.certifications) ? p.certifications : [];
  const certNames = certs.map((c) => c && firstText(c.certification)).filter(Boolean);
  if (certNames.length) lines.push("CERTIFICATIONS: " + certNames.join(", "), "");

  const coursework = p.application_questions && p.application_questions.role_specific
    && Array.isArray(p.application_questions.role_specific.coursework_relevant)
    ? p.application_questions.role_specific.coursework_relevant.filter((c) => c && String(c).trim())
    : [];
  if (coursework.length) lines.push("RELEVANT COURSEWORK: " + coursework.join(", "), "");

  return lines.join("\n").trim();
}

// Tolerant JSON extraction (mirrors fill-driver.js parseAiReply): strip a
// ```json fence, try JSON.parse, else grab the first {...} block. Returns the
// object or null — never throws.
function extractJsonObject(text) {
  let t = String(text == null ? "" : text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const o = JSON.parse(t);
    if (o && typeof o === "object" && !Array.isArray(o)) return o;
  } catch (e) { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { const o = JSON.parse(m[0]); if (o && typeof o === "object" && !Array.isArray(o)) return o; } catch (e) { /* ignore */ } }
  return null;
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x == null ? "" : String(x).trim())).filter(Boolean);
}

// scoreJob({ profile, jd }, llm) -> Promise<{ score, verdict, matched_requirements,
// gaps, keywords, rationale, error? }>. `score` is 1-10 on success, null on any
// failure (with `error` set). NEVER throws.
async function scoreJob({ profile, jd } = {}, llm) {
  const empty = { score: null, verdict: null, matched_requirements: [], gaps: [], keywords: [], rationale: "" };

  const jdText = jd == null ? "" : String(jd).trim();
  if (jdText.length < MIN_JD_CHARS) {
    return { ...empty, error: "no-jd" }; // gate BEFORE the llm — no spend on empty/placeholder JD
  }
  if (typeof llm !== "function") {
    return { ...empty, error: "no llm provided" };
  }

  const summary = buildCandidateSummary(profile);
  const user = [
    "CANDIDATE BACKGROUND:",
    summary || "(no background provided)",
    "",
    "---",
    "",
    "JOB DESCRIPTION:",
    jdText,
    "",
    "Return the JSON object described in the instructions."
  ].join("\n");

  const res = await llm({ system: SCORE_SYSTEM, user, maxTokens: 512 });
  if (!res || !res.ok) {
    return { ...empty, error: (res && res.error) || "llm call failed" };
  }

  const obj = extractJsonObject(res.text);
  if (!obj) {
    return { ...empty, error: "parse-failed", raw: String(res.text).slice(0, 400) };
  }

  let score = Number(obj.score);
  if (!isFinite(score)) return { ...empty, error: "no score in reply", raw: String(res.text).slice(0, 400) };
  score = Math.max(1, Math.min(10, Math.round(score)));

  return {
    score,
    verdict: verdictForScore(score),
    matched_requirements: asStringArray(obj.matched_requirements),
    gaps: asStringArray(obj.gaps),
    keywords: asStringArray(obj.keywords),
    rationale: obj.reasoning == null ? "" : String(obj.reasoning).trim()
  };
}

// UMD-lite: export for the Node test runner; in the popup/SW `module` is
// undefined so these stay globals (from <script> / importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { scoreJob, verdictForScore, buildCandidateSummary, SCORE_SYSTEM, MIN_JD_CHARS, extractJsonObject };
}
