import type { Profile } from "@/lib/profile-schema";

/**
 * Resume tailoring — three user-selectable modes with ESCALATING guardrails,
 * honoring the research verdict (selection beats rewriting for a curated,
 * no-fabrication answer bank) while still offering the aggressive mode.
 *
 *   select          — the LLM only PICKS + ORDERS existing bullets/skills (by id).
 *                     Bullet text is copied verbatim from the profile — fabrication
 *                     is impossible by construction.
 *   rewrite-surface — same selection, plus the LLM may reword bullet TEXT.
 *                     A deterministic post-verify reverts any rewrite that invents
 *                     numbers or out-of-profile tech (facts locked).
 *   rewrite-full    — the LLM writes bullet text freely to match the JD.
 *                     Everything it writes is flagged for review; out-of-profile
 *                     tech is flagged as fabrication risk. Loud, never silent.
 *
 * STRUCTURAL guardrail shared by ALL modes: the LLM never authors the resume's
 * skeleton. Companies, job titles, dates, education, and the header are code-
 * copied from the profile; skills are chosen by id from the profile list. The
 * only free-text surfaces are bullet texts (rewrite modes) and the summary line
 * (always marked AI-written). Inventing an employer/degree/skill is impossible.
 *
 * JD requirements nothing in the profile can support surface as `gaps[]` —
 * "nothing to claim" — never as invented content.
 */

export type TailorMode = "select" | "rewrite-surface" | "rewrite-full";

export type TailoredBullet = {
  text: string; // what renders on the resume
  source_text: string; // verbatim profile text it came from ("" for full-mode free text)
  source_ids: string[]; // unit ids (e.g. "W0.B1") this bullet draws on
  edited: boolean; // text !== source_text
  violation?: string; // surface mode: why the rewrite was REVERTED
  fabrication_risk?: string; // full mode: out-of-profile claim to eyeball
};

export type TailoredExperience = {
  include: boolean;
  job_title: string;
  company: string;
  location: string;
  from: string;
  to: string;
  currently_work_here: boolean;
  bullets: TailoredBullet[];
};

export type TailoredResume = {
  mode: TailorMode;
  summary: string; // one tailored summary line — ALWAYS AI-written, always review
  experiences: TailoredExperience[]; // profile order preserved; include=false = dropped
  skills: string[]; // chosen + ordered, values from the profile list only
  skills_omitted: string[];
  gaps: string[]; // JD requirements with nothing to claim
  rationale: string;
  reverted_count: number; // surface rewrites reverted by the fact check
  error?: string;
  raw?: string;
};

// ── profile units (the numbered answer bank the LLM picks from) ─────────────

export type WorkUnit = {
  id: string; // "W0"
  job_title: string;
  company: string;
  location: string;
  from: string;
  to: string;
  currently_work_here: boolean;
  bullets: { id: string; text: string }[]; // "W0.B0" …
};

/** Split a dash-bulleted role_description into individual bullet texts. */
export function splitRoleDescription(rd: string): string[] {
  return String(rd || "")
    .split("\n")
    .map((ln) => ln.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
}

export function workUnits(profile: Profile): WorkUnit[] {
  return (profile.work_experience ?? []).map((w, i) => ({
    id: `W${i}`,
    job_title: w.job_title || "",
    company: w.company || "",
    location: w.location || "",
    from: w.from || "",
    to: w.to || "",
    currently_work_here: !!w.currently_work_here,
    bullets: splitRoleDescription(w.role_description).map((text, j) => ({ id: `W${i}.B${j}`, text })),
  }));
}

export function skillUnits(profile: Profile): { id: string; text: string }[] {
  return (profile.skills ?? [])
    .filter((s) => s && String(s).trim())
    .map((text, i) => ({ id: `S${i}`, text: String(text).trim() }));
}

// ── prompt ───────────────────────────────────────────────────────────────────

const MODE_RULES: Record<TailorMode, string> = {
  select: [
    "MODE: SELECT-ONLY. You may only CHOOSE and ORDER the existing bullets and skills by their ids.",
    "You may NOT rewrite, merge, or invent any text. For each experience, list the bullet ids to keep",
    '(most JD-relevant first) as plain id strings, e.g. "bullets": ["W0.B2", "W0.B0"].',
  ].join("\n"),
  "rewrite-surface": [
    "MODE: SURFACE REWRITE. Choose and order bullets as in select mode, and you MAY reword a bullet's",
    'text to front-load JD-relevant language: "bullets": [{"id": "W0.B2", "text": "reworded…"}].',
    "HARD RULES for rewording: keep every fact, metric, number, technology and scope EXACTLY as stated —",
    "you may only rephrase, reorder clauses, and tighten. NEVER add a number, technology, or claim that",
    "is not in the original bullet. If a bullet is fine as-is, return just its id string.",
  ].join("\n"),
  "rewrite-full": [
    "MODE: FULL REWRITE. For each experience you may write NEW bullet text that presents the candidate's",
    'real work in the JD\'s language: "bullets": [{"text": "…", "sources": ["W0.B0","W0.B2"]}].',
    "Ground every bullet in the listed source bullets — recombine and re-emphasize aggressively, but do",
    "NOT invent employers, titles, dates, metrics, or technologies the candidate never used.",
    "Every bullet you write will be shown to the candidate flagged as AI-written for review.",
  ].join("\n"),
};

export function buildTailorPrompt(
  profile: Profile,
  jd: string,
  mode: TailorMode
): { system: string; user: string } {
  const work = workUnits(profile);
  const skills = skillUnits(profile);

  const workBlock = work
    .map((w) => {
      const head = `[${w.id}] ${w.job_title || "Role"} @ ${w.company || "?"} (${[w.from, w.to || (w.currently_work_here ? "present" : "")].filter(Boolean).join(" – ")})`;
      const bullets = w.bullets.map((b) => `  [${b.id}] ${b.text}`).join("\n");
      return bullets ? `${head}\n${bullets}` : head;
    })
    .join("\n");
  const skillsBlock = skills.map((s) => `[${s.id}] ${s.text}`).join(", ");

  const system = [
    "You tailor a candidate's resume to a specific job description. You work ONLY with the",
    "candidate's real, numbered background units below the divider — never invent experience.",
    "",
    MODE_RULES[mode],
    "",
    "Also produce:",
    '- "summary": ONE tailored professional-summary line (<= 30 words) grounded only in the units.',
    '- "skills": the skill ids to keep, ordered most-JD-relevant first. Omit irrelevant ones.',
    '- "experiences": one entry per experience id, {"id", "include" (boolean), "bullets" (ordered)}.',
    "  Keep every experience unless it is truly irrelevant; keep at least one experience.",
    '- "gaps": JD requirements the background CANNOT support — name them honestly, never paper over.',
    '- "reasoning": 2-3 sentences on your choices.',
    "",
    "Respond with ONLY a JSON object — no prose, no markdown fence:",
    '{ "summary": "...", "experiences": [...], "skills": ["S1","S0"], "gaps": ["..."], "reasoning": "..." }',
  ].join("\n");

  const user = [
    "CANDIDATE BACKGROUND UNITS:",
    workBlock || "(no work experience)",
    "",
    "SKILLS:",
    skillsBlock || "(none)",
    "",
    "---",
    "",
    "JOB DESCRIPTION:",
    (jd || "").trim().slice(0, 8000),
    "",
    "Tailor the resume now. Return the JSON object.",
  ].join("\n");

  return { system, user };
}

// ── guardrails ───────────────────────────────────────────────────────────────

/** Tokens that look like tech/proper-noun claims: words with digits / + / #
 *  (C++, ROS2, C#), ALL-CAPS acronyms, or Capitalized words that are NOT
 *  sentence-initial (ordinary sentence-case verbs like "Delivered …" are prose,
 *  not claims). Lowercased for comparison. */
function claimTokens(text: string): string[] {
  const s = String(text || "");
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z0-9]*[+#]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const tok = m[0];
    const hasDigitOrSym = /[\d+#]/.test(tok);
    const allCaps = /^[A-Z]{2,}/.test(tok) && tok === tok.toUpperCase();
    const capitalized = /^[A-Z]/.test(tok);
    const sentenceInitial = m.index === 0 || /[.!?;:\n]\s*$/.test(s.slice(0, m.index));
    if (hasDigitOrSym || allCaps || (capitalized && !sentenceInitial)) out.push(tok.toLowerCase());
  }
  return out;
}

/** Every word of the profile's tech vocabulary + the source text, lowercased. */
export function buildProfileVocab(profile: Profile): Set<string> {
  const vocab = new Set<string>();
  const add = (s: string) => {
    for (const w of String(s || "").split(/[\s,/()]+/)) {
      const t = w.trim().toLowerCase();
      if (t) vocab.add(t);
    }
  };
  for (const w of profile.work_experience ?? []) {
    (w.tech_stack ?? []).forEach(add);
    splitRoleDescription(w.role_description).forEach(add);
    add(w.job_title);
    add(w.company);
  }
  (profile.skills ?? []).forEach(add);
  for (const e of profile.education ?? []) {
    (e.degree ?? []).forEach(add);
    (e.field_of_study ?? []).forEach(add);
    add(e.school_or_university);
  }
  return vocab;
}

/**
 * Surface-rewrite fact check (deterministic — the guardrail is NOT prompt trust):
 *  - a NUMBER in the rewrite that is not in the source = invented metric → violation.
 *    (Dropping a number is allowed — claiming less is safe; claiming more is not.)
 *  - a tech-looking token not in the source bullet and not in the profile vocabulary
 *    = invented technology → violation.
 * Returns null when clean, else a short human reason.
 */
export function verifyFactsPreserved(
  source: string,
  rewritten: string,
  vocab: Set<string>
): string | null {
  const srcNums = new Set((source.match(/\d+(?:\.\d+)?/g) || []).map(String));
  for (const n of rewritten.match(/\d+(?:\.\d+)?/g) || []) {
    if (!srcNums.has(String(n))) return `invented number "${n}"`;
  }
  const srcTokens = new Set(claimTokens(source));
  for (const t of claimTokens(rewritten)) {
    if (!srcTokens.has(t) && !vocab.has(t)) return `technology/claim not in your background: "${t}"`;
  }
  return null;
}

/** Full-rewrite check: same detector, but FLAGS instead of reverting (the whole
 *  point of full mode is heavy rewriting — the human reviews the flags). */
export function checkFabricationRisk(text: string, sources: string[], vocab: Set<string>): string | null {
  const srcTokens = new Set(sources.flatMap((s) => claimTokens(s)));
  for (const t of claimTokens(text)) {
    if (!srcTokens.has(t) && !vocab.has(t)) return `not in your background: "${t}"`;
  }
  return null;
}

// ── parse + assemble ─────────────────────────────────────────────────────────

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

type ReplyBullet = string | { id?: string; text?: string; sources?: string[] };
type ReplyExperience = { id?: string; include?: boolean; bullets?: ReplyBullet[] };

/**
 * The UNTAILORED resume, straight from the profile: every experience, every
 * bullet verbatim, every skill, no summary. Doubles as (a) the "Original" view
 * on the tailor page and (b) parseTailorReply's fail-safe baseline.
 */
export function identityResume(profile: Profile, mode: TailorMode = "select"): TailoredResume {
  const work = workUnits(profile);
  const skills = skillUnits(profile);
  return {
    mode,
    summary: "",
    experiences: work.map((w) => ({
      include: true,
      job_title: w.job_title,
      company: w.company,
      location: w.location,
      from: w.from,
      to: w.to,
      currently_work_here: w.currently_work_here,
      bullets: w.bullets.map((b) => ({
        text: b.text,
        source_text: b.text,
        source_ids: [b.id],
        edited: false,
      })),
    })),
    skills: skills.map((s) => s.text),
    skills_omitted: [],
    gaps: [],
    rationale: "",
    reverted_count: 0,
  };
}

/**
 * Turn the LLM reply into a TailoredResume, enforcing each mode's guardrail.
 * NEVER throws. Fail-safe direction: anything unparseable keeps the ORIGINAL
 * profile content (a broken reply can only cost tailoring, never correctness).
 */
export function parseTailorReply(text: string, profile: Profile, mode: TailorMode): TailoredResume {
  const work = workUnits(profile);
  const skills = skillUnits(profile);
  const vocab = buildProfileVocab(profile);

  const identity: TailoredResume = identityResume(profile, mode);

  const obj = extractJsonObject(text);
  if (!obj) return { ...identity, error: "parse-failed", raw: String(text).slice(0, 400) };

  const bulletById = new Map<string, { text: string; expIdx: number }>();
  work.forEach((w, wi) => w.bullets.forEach((b) => bulletById.set(b.id, { text: b.text, expIdx: wi })));
  const skillById = new Map(skills.map((s) => [s.id, s.text]));

  let reverted = 0;

  // experiences: reply order is ignored for the SECTION (profile = reverse-chron
  // stays); reply order applies WITHIN an experience's bullets.
  const replyExps = Array.isArray(obj.experiences) ? (obj.experiences as ReplyExperience[]) : [];
  const byExpId = new Map<string, ReplyExperience>();
  for (const re of replyExps) if (re && typeof re.id === "string") byExpId.set(re.id, re);

  const experiences: TailoredExperience[] = work.map((w, wi) => {
    const re = byExpId.get(w.id);
    const base = identity.experiences[wi];
    if (!re) return base; // unmentioned → keep verbatim (fail-safe)

    const include = re.include !== false;
    const replyBullets = Array.isArray(re.bullets) ? re.bullets : null;
    if (!replyBullets) return { ...base, include };

    const bullets: TailoredBullet[] = [];
    for (const rb of replyBullets) {
      if (typeof rb === "string") {
        // id string → verbatim source bullet (the select-mode shape)
        const src = bulletById.get(rb);
        if (src && src.expIdx === wi) {
          bullets.push({ text: src.text, source_text: src.text, source_ids: [rb], edited: false });
        }
        continue;
      }
      if (!rb || typeof rb !== "object") continue;

      if (mode === "select") {
        // select mode may ONLY reference ids — a {text} here is ignored in favor of the source
        const src = rb.id ? bulletById.get(rb.id) : undefined;
        if (src && src.expIdx === wi) {
          bullets.push({ text: src.text, source_text: src.text, source_ids: [rb.id!], edited: false });
        }
        continue;
      }

      if (mode === "rewrite-surface") {
        const src = rb.id ? bulletById.get(rb.id) : undefined;
        if (!src || src.expIdx !== wi) continue;
        const newText = String(rb.text ?? "").trim();
        if (!newText || newText === src.text) {
          bullets.push({ text: src.text, source_text: src.text, source_ids: [rb.id!], edited: false });
          continue;
        }
        const violation = verifyFactsPreserved(src.text, newText, vocab);
        if (violation) {
          reverted++;
          bullets.push({ text: src.text, source_text: src.text, source_ids: [rb.id!], edited: false, violation });
        } else {
          bullets.push({ text: newText, source_text: src.text, source_ids: [rb.id!], edited: true });
        }
        continue;
      }

      // rewrite-full: free text grounded in sources
      const newText = String(rb.text ?? "").trim();
      if (!newText) continue;
      const srcIds = (Array.isArray(rb.sources) ? rb.sources : [])
        .filter((s): s is string => typeof s === "string")
        .filter((s) => bulletById.has(s));
      const srcTexts = srcIds.map((s) => bulletById.get(s)!.text);
      const risk = checkFabricationRisk(newText, srcTexts, vocab);
      bullets.push({
        text: newText,
        source_text: srcTexts.join(" | "),
        source_ids: srcIds,
        edited: true,
        ...(risk ? { fabrication_risk: risk } : {}),
      });
    }

    // an included experience must keep at least one bullet — else fall back to all
    if (include && bullets.length === 0) return { ...base, include };
    return { ...base, include, bullets };
  });

  // every experience dropped → fail-safe to all included
  const anyIncluded = experiences.some((e) => e.include);
  const safeExperiences = anyIncluded ? experiences : identity.experiences;

  // skills: ids only — the LLM cannot invent a skill
  const replySkills = Array.isArray(obj.skills) ? (obj.skills as unknown[]) : null;
  let chosenSkills = identity.skills;
  let omitted: string[] = [];
  if (replySkills && replySkills.length) {
    const picked: string[] = [];
    for (const s of replySkills) {
      const v = typeof s === "string" ? skillById.get(s) : undefined;
      if (v && !picked.includes(v)) picked.push(v);
    }
    if (picked.length) {
      chosenSkills = picked;
      omitted = skills.map((s) => s.text).filter((t) => !picked.includes(t));
    }
  }

  return {
    mode,
    summary: String(obj.summary ?? "").trim(),
    experiences: safeExperiences,
    skills: chosenSkills,
    skills_omitted: omitted,
    gaps: (Array.isArray(obj.gaps) ? obj.gaps : []).map((g) => String(g ?? "").trim()).filter(Boolean),
    rationale: String(obj.reasoning ?? "").trim(),
    reverted_count: reverted,
  };
}
