import type { Profile } from "@/lib/profile-schema";

/**
 * JD-match scoring — the "should I even apply?" signal. Pure functions: build the
 * prompt from the RAW profile + a pasted JD, and parse the LLM reply. The server
 * action (app/app/match/actions.ts) wires these to the user's LLM via callLLM.
 *
 * Rubric adapted from ApplyPilot-oss-reference/src/applypilot/scoring/scorer.py
 * (1-10 fit scale + ATS keywords), extended to return matched/gaps as arrays.
 * Grounded ONLY in the candidate's real background — the summary deliberately
 * excludes PII / demographics / work-authorization so none of it enters the prompt.
 */

export type Verdict = "strong" | "moderate" | "weak";

export type ScoreResult = {
  score: number | null; // 1-10 on success, null on any failure
  verdict: Verdict | null;
  matched_requirements: string[];
  gaps: string[];
  keywords: string[];
  rationale: string;
  error?: string;
  raw?: string;
};

/** Below this a JD is almost certainly empty / a placeholder — not worth scoring. */
export const MIN_JD_CHARS = 40;

/** Code-side source of truth for the strong/moderate/weak bucket (never trust a
 *  model-emitted verdict). Conservative about "strong". */
export function verdictForScore(score: number | null): Verdict | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score >= 8) return "strong";
  if (score >= 5) return "moderate";
  return "weak";
}

/** A tiered candidate array (degree, field_of_study, tech_stack) → readable text. */
function firstText(v: unknown): string {
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== "").join(", ");
  return v == null ? "" : String(v).trim();
}

/**
 * Distill the profile into a compact plain-text block for scoring. Includes ONLY
 * resume-relevant sections (education, work, skills, certifications). Deliberately
 * EXCLUDES personal_info / work_authorization / self_identification / screening —
 * no PII or demographic data enters the prompt. Tolerant of an empty profile.
 */
export function buildCandidateSummary(profile: Profile): string {
  const lines: string[] = [];

  const eduLines = (profile.education ?? [])
    .map((e) => {
      const parts = [
        firstText(e.degree),
        firstText(e.field_of_study),
        e.school_or_university,
        e.gpa ? `GPA ${e.gpa}${e.gpa_scale ? "/" + e.gpa_scale : ""}` : "",
        e.graduation_date && e.graduation_date !== "YYYY-MM" ? `grad ${e.graduation_date}` : "",
      ]
        .map((x) => String(x ?? "").trim())
        .filter(Boolean);
      return parts.length ? "- " + parts.join(", ") : "";
    })
    .filter(Boolean);
  if (eduLines.length) lines.push("EDUCATION:", ...eduLines, "");

  const workLines: string[] = [];
  for (const w of profile.work_experience ?? []) {
    const head = [w.job_title, w.company].map((x) => String(x || "").trim()).filter(Boolean).join(" @ ");
    const dates = [w.from, w.to].filter((d) => d && d !== "YYYY-MM").join("-");
    if (head || dates) workLines.push("- " + [head, dates ? `(${dates})` : ""].filter(Boolean).join(" "));
    const rd = (w.role_description || "").trim();
    if (rd) {
      for (const ln of rd.split("\n")) {
        const t = ln.replace(/^[-*]\s*/, "").trim();
        if (t) workLines.push("  * " + t);
      }
    }
    const tech = firstText(w.tech_stack);
    if (tech) workLines.push("  tech: " + tech);
  }
  if (workLines.length) lines.push("WORK EXPERIENCE:", ...workLines, "");

  const skills = (profile.skills ?? []).filter((s) => s && String(s).trim());
  if (skills.length) lines.push("SKILLS: " + skills.join(", "), "");

  const certs = (profile.certifications ?? []).map((c) => firstText(c.certification)).filter(Boolean);
  if (certs.length) lines.push("CERTIFICATIONS: " + certs.join(", "), "");

  return lines.join("\n").trim();
}

export const SCORE_SYSTEM = [
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
  "{",
  '  "score": <integer 1-10>,',
  '  "matched_requirements": [<short strings: JD requirements the candidate clearly meets>],',
  '  "gaps": [<short strings: JD requirements the candidate misses or only partially meets>],',
  '  "keywords": [<ATS keywords from the JD that match, or could match, the candidate>],',
  '  "reasoning": "<2-3 sentences explaining the score>"',
  "}",
].join("\n");

export function buildScorePrompt(profile: Profile, jd: string): { system: string; user: string } {
  const summary = buildCandidateSummary(profile);
  const user = [
    "CANDIDATE BACKGROUND:",
    summary || "(no background provided)",
    "",
    "---",
    "",
    "JOB DESCRIPTION:",
    (jd || "").trim().slice(0, 6000),
    "",
    "Return the JSON object described in the instructions.",
  ].join("\n");
  return { system: SCORE_SYSTEM, user };
}

/** Tolerant JSON extraction: strip a ```json fence, try JSON.parse, else the first
 *  {...} block. Returns the object or null — never throws. */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const t = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const o = JSON.parse(t);
    if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x == null ? "" : String(x).trim())).filter(Boolean);
}

const EMPTY: ScoreResult = {
  score: null,
  verdict: null,
  matched_requirements: [],
  gaps: [],
  keywords: [],
  rationale: "",
};

/** Parse an LLM reply into a ScoreResult. Never throws; a bad reply yields
 *  { score:null, error } with the raw text kept for debugging. */
export function parseScoreReply(text: string): ScoreResult {
  const obj = extractJsonObject(text);
  if (!obj) return { ...EMPTY, error: "parse-failed", raw: String(text).slice(0, 400) };

  const score = Number(obj.score);
  if (!Number.isFinite(score)) return { ...EMPTY, error: "no score in reply", raw: String(text).slice(0, 400) };
  const clamped = Math.max(1, Math.min(10, Math.round(score)));

  return {
    score: clamped,
    verdict: verdictForScore(clamped),
    matched_requirements: asStringArray(obj.matched_requirements),
    gaps: asStringArray(obj.gaps),
    keywords: asStringArray(obj.keywords),
    rationale: obj.reasoning == null ? "" : String(obj.reasoning).trim(),
  };
}
