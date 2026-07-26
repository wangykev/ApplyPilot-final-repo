import type { TailorMode } from "@/lib/tailor";
import { verifyFactsPreserved, checkFabricationRisk } from "@/lib/tailor";
import { escapeLatex } from "@/lib/resume-doc";

/**
 * RESUME-FIRST tailoring (the operator's correction of the profile-first design):
 * start from the user's ACTUAL resume .tex and compute targeted EDITS to it,
 * instead of regenerating a document from profile data and hoping it matches.
 *
 * Fidelity by construction: the ONLY editable units are the `\resumeItem{...}`
 * bullet bodies after \begin{document}. Every other byte — preamble, macros,
 * headers, section order, skills lines, sections we don't even understand
 * (Awards, Volunteering, …) — passes through UNTOUCHED. The LLM proposes
 * keep / drop / replace per unit id; replacements run the SAME deterministic
 * guardrails as the profile path (surface mode: fact-check or REVERT; full
 * mode: fabrication-risk flags). Unmentioned units are kept (fail-safe), and
 * a section whose bullets would ALL drop keeps them all (never an empty list —
 * an empty itemize is also a LaTeX error).
 */

export type TexUnit = {
  id: string; // "T0" …
  text: string; // raw LaTeX bullet body
  plain: string; // de-TeXed text (for the LLM + fact-check + diff display)
  context: string; // nearest preceding heading (company / project name)
  start: number; // byte range of the WHOLE \resumeItem{...} block
  end: number;
};

export type TexEdit = { id?: string; action?: string; text?: string };

export type TexEditRecord = {
  id: string;
  context: string;
  action: "kept" | "dropped" | "replaced";
  was: string;
  now: string;
  violation?: string; // surface: why the replacement was REVERTED
  fabrication_risk?: string; // full: out-of-resume claim to eyeball
};

export type TexTailorResult = {
  tex: string; // the edited document
  records: TexEditRecord[]; // one per unit, in document order
  gaps: string[];
  rationale: string;
  reverted_count: number;
  error?: string;
  raw?: string;
};

/** Strip LaTeX for display/matching: \textbf{x}→x, \% → %, commands dropped. */
export function detex(s: string): string {
  let t = String(s ?? "");
  for (let i = 0; i < 8; i++) {
    const before = t;
    // \cmd{x} → x, SPACE-padded: adjacent args must not jam ("{Acme}{2024}" → "Acme 2024")
    t = t.replace(/\\[a-zA-Z]+\*?\s*\{([^{}]*)\}/g, " $1 ");
    if (t === before) break;
  }
  return t
    .replace(/\\([%&#_{}])/g, "$1")
    .replace(/\\textbackslash\{?\}?/g, "\\")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}$]/g, " ") // bare braces + math delimiters ($|$) → separators
    .replace(/\s+/g, " ")
    .trim();
}

/** Balanced-brace read starting at `open` (the "{"). Returns the content end, or -1. */
function braceEnd(tex: string, open: number): number {
  let depth = 0;
  for (let i = open; i < tex.length; i++) {
    const c = tex[i];
    if (c === "\\") {
      i++; // skip the escaped char (\{ \} \% …)
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** First balanced {…} argument after a command occurrence. */
function firstArg(tex: string, cmdEnd: number): string {
  const open = tex.indexOf("{", cmdEnd);
  if (open === -1) return "";
  const close = braceEnd(tex, open);
  return close === -1 ? "" : tex.slice(open + 1, close);
}

/** Every \resumeItem{...} bullet after \begin{document}, with its heading context. */
export function extractTexUnits(tex: string): TexUnit[] {
  const docStart = tex.indexOf("\\begin{document}");
  const body = docStart === -1 ? 0 : docStart;

  // heading positions → context labels (subheadings + project headings)
  const headings: { pos: number; label: string }[] = [];
  for (const cmd of ["\\resumeSubheading", "\\resumeProjectHeading"]) {
    let at = tex.indexOf(cmd, body);
    while (at !== -1) {
      headings.push({ pos: at, label: detex(firstArg(tex, at + cmd.length)) });
      at = tex.indexOf(cmd, at + cmd.length);
    }
  }
  headings.sort((a, b) => a.pos - b.pos);

  const units: TexUnit[] = [];
  const cmd = "\\resumeItem";
  let at = tex.indexOf(cmd, body);
  while (at !== -1) {
    // require an immediate "{" (skips \resumeItemListStart etc.)
    const open = at + cmd.length;
    if (tex[open] === "{") {
      const close = braceEnd(tex, open);
      if (close !== -1) {
        const text = tex.slice(open + 1, close);
        const ctx = [...headings].reverse().find((h) => h.pos < at)?.label ?? "";
        units.push({
          id: `T${units.length}`,
          text,
          plain: detex(text),
          context: ctx,
          start: at,
          end: close + 1,
        });
        at = tex.indexOf(cmd, close);
        continue;
      }
    }
    at = tex.indexOf(cmd, at + cmd.length);
  }
  return units;
}

const MODE_RULES: Record<TailorMode, string> = {
  select: [
    'MODE: SELECT-ONLY. For each bullet id choose "keep" or "drop". You may NOT rewrite any text',
    "— a \"replace\" action will be ignored. Drop only bullets that hurt the fit; keep is the default.",
  ].join("\n"),
  "rewrite-surface": [
    'MODE: SURFACE REWRITE — reword ONLY, never remove. Per bullet: "keep" or "replace" with',
    'reworded text that front-loads the JD\'s language ("drop" is NOT allowed and will be ignored:',
    "the tailored resume must be the same resume with a few words changed). HARD RULES for",
    "replacements: keep every fact, metric, number, technology and scope EXACTLY as stated —",
    "rephrase and tighten only. NEVER add a number, technology, or claim that is not in the",
    "original bullet. Aim for a similar length to the original (page fit is verified by",
    "compiling — oversize rewrites get reverted).",
  ].join("\n"),
  "rewrite-full": [
    'MODE: FULL REWRITE. Per bullet: "keep", "drop", or "replace" with new text that presents the',
    "SAME underlying work in the JD's language — recombine and re-emphasize aggressively, but do NOT",
    "invent employers, titles, dates, metrics, or technologies the candidate never used.",
    "Aim for a similar length to the original bullet (page fit is verified by compiling —",
    "oversize rewrites get reverted). Every replacement is shown to the candidate flagged as",
    "AI-written for review.",
  ].join("\n"),
};

export function buildTexTailorPrompt(units: TexUnit[], jd: string, mode: TailorMode): { system: string; user: string } {
  const block = units.map((u) => `[${u.id}] (${u.context || "?"}) ${u.plain}`).join("\n");
  const system = [
    "You tailor a resume to a job description by editing its EXISTING bullet points only.",
    "The resume's structure, sections, headers and everything else stay exactly as they are —",
    "you only decide, per numbered bullet, what happens to it.",
    "",
    MODE_RULES[mode],
    "",
    "Respond with ONLY a JSON object — no prose, no markdown fence:",
    '{ "edits": [{"id": "T0", "action": "keep|drop|replace", "text": "replacement when action=replace"}],',
    '  "gaps": ["JD requirements NONE of the resume can support — honest, never papered over"],',
    '  "reasoning": "2-3 sentences" }',
    "Unlisted bullet ids are kept unchanged. Plain text replacements only (no LaTeX commands).",
  ].join("\n");
  const user = [
    "RESUME BULLETS (id, section, text):",
    block || "(none)",
    "",
    "---",
    "",
    "JOB DESCRIPTION:",
    (jd || "").trim().slice(0, 8000),
    "",
    "Tailor now. Return the JSON object.",
  ].join("\n");
  return { system, user };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const t = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const o = JSON.parse(t);
    if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
  } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Compile-time shim for XeTeX engines (tectonic): \ifdefined-guard the two
 * pdfTeX-only primitives the sb2nov template uses, so a user's RAW resume.tex
 * compiles in our preview. Idempotent — an already-guarded line starts with
 * \ifdefined and no longer matches. Applied ONLY at compile time; the .tex the
 * user downloads keeps their original lines (pdfLaTeX/Overleaf-ready).
 */
export function shimForXetex(tex: string): string {
  return String(tex ?? "")
    .replace(/^([ \t]*)\\input\{glyphtounicode\}/m, "$1\\ifdefined\\pdfgentounicode\\input{glyphtounicode}\\fi")
    .replace(/^([ \t]*)\\pdfgentounicode=1/m, "$1\\ifdefined\\pdfgentounicode\\pdfgentounicode=1\\fi");
}

/** The whole original document's words — anything already in the resume is a
 *  legitimate claim for the fact-check / fabrication detectors. */
export function vocabFromTex(tex: string): Set<string> {
  const vocab = new Set<string>();
  for (const w of detex(tex).split(/[\s,/()|]+/)) {
    const t = w.trim().toLowerCase();
    if (t) vocab.add(t);
  }
  return vocab;
}

export type TexDecision = {
  unit: TexUnit;
  action: "kept" | "dropped" | "replaced";
  now: string;
  violation?: string;
  risk?: string;
};

/** Stage 1: turn the LLM's edits into per-unit decisions under the mode's guardrails. */
export function decideTexEdits(units: TexUnit[], edits: TexEdit[], mode: TailorMode, vocab: Set<string>): { decisions: TexDecision[]; reverted: number } {
  const byId = new Map<string, TexEdit>();
  for (const e of edits) if (e && typeof e.id === "string") byId.set(e.id, e);

  let reverted = 0;
  const decisions: TexDecision[] = units.map((u) => {
    const e = byId.get(u.id);
    const action = String(e?.action ?? "keep").toLowerCase();
    // surface = reword-ONLY: the result must be the same resume with a few words
    // changed, so a model-proposed drop is ignored (operator expectation).
    if (action === "drop" && mode !== "rewrite-surface") return { unit: u, action: "dropped", now: "" };
    if (action === "replace" && mode !== "select") {
      const newText = String(e?.text ?? "").trim();
      if (newText && newText !== u.plain) {
        if (mode === "rewrite-surface") {
          const violation = verifyFactsPreserved(u.plain, newText, vocab);
          if (violation) {
            reverted++;
            return { unit: u, action: "kept", now: u.plain, violation };
          }
          return { unit: u, action: "replaced", now: newText };
        }
        const risk = checkFabricationRisk(newText, [u.plain], vocab);
        return { unit: u, action: "replaced", now: newText, ...(risk ? { risk } : {}) };
      }
    }
    return { unit: u, action: "kept", now: u.plain };
  });

  return { decisions, reverted };
}

/**
 * STRUCTURAL never-empty-a-list guard: group decisions by the bullet's ENCLOSING
 * \resumeItemListStart block (by position — collision-proof, unlike heading
 * labels) and un-drop a group that would end up empty. An emptied itemize is a
 * LaTeX error AND a vanished resume section — never the right outcome.
 */
export function enforceNoEmptyLists(tex: string, decisions: TexDecision[]): void {
  const starts: number[] = [];
  let at = tex.indexOf("\\resumeItemListStart");
  while (at !== -1) {
    starts.push(at);
    at = tex.indexOf("\\resumeItemListStart", at + 1);
  }
  const listIndexOf = (pos: number) => {
    let idx = -1;
    for (let i = 0; i < starts.length; i++) if (starts[i] < pos) idx = i;
    return idx;
  };
  const byList = new Map<number, TexDecision[]>();
  for (const d of decisions) {
    const k = listIndexOf(d.unit.start);
    if (!byList.has(k)) byList.set(k, []);
    byList.get(k)!.push(d);
  }
  for (const group of byList.values()) {
    if (group.every((d) => d.action === "dropped")) {
      for (const d of group) {
        d.action = "kept";
        d.now = d.unit.plain;
      }
    }
  }
}

/** Stage 2: splice decisions into the ORIGINAL tex (from the end, so ranges stay valid). */
export function spliceTexEdits(tex: string, decisions: TexDecision[]): string {
  let outTex = tex;
  for (const d of [...decisions].sort((a, b) => b.unit.start - a.unit.start)) {
    if (d.action === "dropped") {
      // remove the block plus its leading indentation/newline
      let from = d.unit.start;
      while (from > 0 && (outTex[from - 1] === " " || outTex[from - 1] === "\t")) from--;
      if (from > 0 && outTex[from - 1] === "\n") from--;
      outTex = outTex.slice(0, from) + outTex.slice(d.unit.end);
    } else if (d.action === "replaced") {
      outTex = outTex.slice(0, d.unit.start) + `\\resumeItem{${escapeLatex(d.now)}}` + outTex.slice(d.unit.end);
    }
  }
  return outTex;
}

export function decisionsToRecords(decisions: TexDecision[]): TexEditRecord[] {
  return decisions.map((d) => ({
    id: d.unit.id,
    context: d.unit.context,
    action: d.action,
    was: d.unit.plain,
    now: d.action === "dropped" ? "" : d.now,
    ...(d.violation ? { violation: d.violation } : {}),
    ...(d.risk ? { fabrication_risk: d.risk } : {}),
  }));
}

/** Pull the edits/gaps/reasoning out of a reply for the staged pipeline. */
export function parseTexReply(jdReply: string): { edits: TexEdit[]; gaps: string[]; rationale: string } | null {
  const obj = extractJsonObject(jdReply);
  if (!obj) return null;
  return {
    edits: Array.isArray(obj.edits) ? (obj.edits as TexEdit[]) : [],
    gaps: (Array.isArray(obj.gaps) ? obj.gaps : []).map((g) => String(g ?? "").trim()).filter(Boolean),
    rationale: String(obj.reasoning ?? "").trim(),
  };
}

/**
 * PAGE-FIT enforcement — MEASURED, not prompt-trusted. Using the injected
 * compiler (`compilePages`: tex → page count, null on failure), while the
 * document exceeds the ORIGINAL's page count, revert the replacement with the
 * largest text growth back to its source and recompile. Reverting to original
 * text is always safe, and with every replacement reverted the document cannot
 * exceed the original (drops only shrink) — the loop converges by construction.
 * Mutates + returns the decisions (length-reverts carry a violation note the
 * review UI already renders).
 */
export async function fitTexToPages(
  tex: string,
  decisions: TexDecision[],
  basePages: number,
  compilePages: (tex: string) => Promise<number | null>
): Promise<{ tex: string; pages: number | null; length_reverts: number; fitted: boolean }> {
  let current = spliceTexEdits(tex, decisions);
  let pages = await compilePages(current);
  let lengthReverts = 0;

  while (pages != null && basePages > 0 && pages > basePages) {
    const candidates = decisions
      .filter((d) => d.action === "replaced")
      .sort((a, b) => (b.now.length - b.unit.plain.length) - (a.now.length - a.unit.plain.length));
    const worst = candidates[0];
    if (!worst) break; // nothing revertible left; drops alone can't overflow
    worst.action = "kept";
    worst.now = worst.unit.plain;
    worst.violation = "reverted to keep the resume at its original page count";
    lengthReverts++;
    current = spliceTexEdits(tex, decisions);
    pages = await compilePages(current);
  }

  return { tex: current, pages, length_reverts: lengthReverts, fitted: pages == null ? false : basePages <= 0 || pages <= basePages };
}

/**
 * Parse the LLM reply and splice the edits into the .tex. NEVER throws; an
 * unparseable reply returns the ORIGINAL document with every unit "kept".
 * (Composition of the stages above — the page-fit loop uses them directly.)
 */
export function applyTexTailor(tex: string, jdReply: string, mode: TailorMode): TexTailorResult {
  const units = extractTexUnits(tex);
  const identity: TexTailorResult = {
    tex,
    records: units.map((u) => ({ id: u.id, context: u.context, action: "kept", was: u.plain, now: u.plain })),
    gaps: [],
    rationale: "",
    reverted_count: 0,
  };
  const parsed = parseTexReply(jdReply);
  if (!parsed) return { ...identity, error: "parse-failed", raw: String(jdReply).slice(0, 400) };

  const { decisions, reverted } = decideTexEdits(units, parsed.edits, mode, vocabFromTex(tex));
  enforceNoEmptyLists(tex, decisions);
  return {
    tex: spliceTexEdits(tex, decisions),
    records: decisionsToRecords(decisions),
    gaps: parsed.gaps,
    rationale: parsed.rationale,
    reverted_count: reverted,
  };
}
