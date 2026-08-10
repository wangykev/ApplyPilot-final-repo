/**
 * LIVE pipeline exercise — NOT part of `npm test` (the glob only picks *.test.ts).
 * Runs the real tailor + match-score brains against a real LLM with a real
 * profile and a real JD. Env-gated; spends a few LLM calls.
 *
 *   LIVE_PROFILE_PATH=path/to/profile.json \
 *   LIVE_JD_PATH=path/to/jd.txt \
 *   LIVE_LLM_PROVIDER=gemini LIVE_LLM_MODEL=gemini-2.5-flash LIVE_LLM_KEY=... \
 *   npx tsx test/live-tailor.script.ts [out-dir]
 *
 * Writes resume-<mode>.html / .tex into out-dir (default: os tmp) for eyeballing.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceProfile } from "@/lib/profile-schema";
import { callLLM, type LlmProvider } from "@/lib/llm";
import { buildTailorPrompt, parseTailorReply, type TailorMode } from "@/lib/tailor";
import { tailoredToTex, tailoredToPrintHtml } from "@/lib/resume-doc";
import { buildScorePrompt, parseScoreReply } from "@/lib/score";

async function main() {
  const profilePath = process.env.LIVE_PROFILE_PATH;
  const jdPath = process.env.LIVE_JD_PATH;
  const apiKey = process.env.LIVE_LLM_KEY;
  if (!profilePath || !jdPath || !apiKey) {
    console.log("Set LIVE_PROFILE_PATH, LIVE_JD_PATH, LIVE_LLM_KEY (and optionally LIVE_LLM_PROVIDER/MODEL).");
    process.exit(1);
  }
  const provider = (process.env.LIVE_LLM_PROVIDER || "gemini") as LlmProvider;
  const model = process.env.LIVE_LLM_MODEL || "gemini-2.5-flash";
  const outDir = process.argv[2] || join(tmpdir(), "applypilot-live-tailor");
  await mkdir(outDir, { recursive: true });

  const profile = coerceProfile(JSON.parse(await readFile(profilePath, "utf-8")));
  const jd = await readFile(jdPath, "utf-8");
  console.log(`profile: ${profile.work_experience.length} experiences, ${profile.skills.length} skills`);
  console.log(`jd: ${jd.length} chars · llm: ${provider}/${model}\n`);

  // ── match score ────────────────────────────────────────────────────────────
  {
    const { system, user } = buildScorePrompt(profile, jd);
    const res = await callLLM({ provider, model, apiKey, system, user, maxTokens: 2500 });
    if (!res.ok) console.log("MATCH SCORE: LLM failed —", res.error);
    else {
      const r = parseScoreReply(res.text);
      if (r.error) console.log(`  raw reply (${res.text.length} chars): …${res.text.slice(-120).replace(/\n/g, "\\n")}`);
      console.log(`MATCH SCORE: ${r.score}/10 (${r.verdict})${r.error ? " ERROR " + r.error : ""}`);
      console.log(`  rationale: ${r.rationale}`);
      console.log(`  matched: ${r.matched_requirements.join(" | ")}`);
      console.log(`  gaps: ${r.gaps.join(" | ")}\n`);
    }
  }

  // ── all three tailor modes ─────────────────────────────────────────────────
  for (const mode of ["select", "rewrite-surface", "rewrite-full"] as TailorMode[]) {
    const { system, user } = buildTailorPrompt(profile, jd, mode);
    const res = await callLLM({ provider, model, apiKey, system, user, maxTokens: 8000 });
    if (!res.ok) {
      console.log(`MODE ${mode}: LLM failed — ${res.error}\n`);
      continue;
    }
    const r = parseTailorReply(res.text, profile, mode);
    if (r.error) console.log(`  raw reply (${res.text.length} chars): …${res.text.slice(-120).replace(/\n/g, "\\n")}`);
    const included = r.experiences.filter((e) => e.include);
    const bullets = included.flatMap((e) => e.bullets);
    const edited = bullets.filter((b) => b.edited).length;
    const risks = bullets.filter((b) => b.fabrication_risk);
    console.log(`MODE ${mode}${r.error ? "  PARSE ERROR: " + r.error : ""}`);
    console.log(`  summary: ${r.summary}`);
    console.log(
      `  experiences: ${included.length}/${r.experiences.length} kept · bullets ${bullets.length} (${edited} edited, ${r.reverted_count} reverted, ${risks.length} risks)`
    );
    console.log(`  skills: ${r.skills.join(", ")}${r.skills_omitted.length ? "  [off: " + r.skills_omitted.join(", ") + "]" : ""}`);
    for (const e of included) {
      console.log(`  · ${e.company} — ${e.job_title}`);
      for (const b of e.bullets) {
        const tag = b.fabrication_risk ? " ⚠RISK: " + b.fabrication_risk : b.violation ? " ⛔reverted: " + b.violation : b.edited ? " ✦edited" : "";
        console.log(`      - ${b.text}${tag}`);
      }
    }
    console.log(`  gaps: ${r.gaps.join(" | ") || "(none)"}`);
    console.log(`  rationale: ${r.rationale}\n`);
    await writeFile(join(outDir, `resume-${mode}.html`), tailoredToPrintHtml(profile, r), "utf-8");
    await writeFile(join(outDir, `resume-${mode}.tex`), tailoredToTex(profile, r), "utf-8");
  }
  console.log("wrote HTML/TEX per mode to", outDir);
}

main().catch((e) => {
  console.error("live script crashed:", e);
  process.exit(1);
});
