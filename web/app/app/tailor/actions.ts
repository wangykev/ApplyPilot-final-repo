"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { callLLM } from "@/lib/llm";
import { loadUserData } from "@/lib/user-data";
import { buildTailorPrompt, parseTailorReply, type TailorMode, type TailoredResume } from "@/lib/tailor";
import {
  extractTexUnits,
  buildTexTailorPrompt,
  parseTexReply,
  decideTexEdits,
  decisionsToRecords,
  spliceTexEdits,
  fitTexToPages,
  vocabFromTex,
  shimForXetex,
  type TexTailorResult,
} from "@/lib/tex-tailor";
import { tailoredToTex, tailoredToPrintHtml } from "@/lib/resume-doc";

export type TailorActionResult =
  | { ok: true; result: TailoredResume; tex: string; printHtml: string }
  | { ok: false; error: string };

const MIN_JD_CHARS = 40;

export async function tailorResume({
  jobDescription,
  mode,
}: {
  jobDescription: string;
  mode: TailorMode;
}): Promise<TailorActionResult> {
  const jd = (jobDescription || "").trim();
  if (jd.length < MIN_JD_CHARS) {
    return { ok: false, error: "Paste a job description first — a bit more text is needed to tailor." };
  }
  if (!["select", "rewrite-surface", "rewrite-full"].includes(mode)) {
    return { ok: false, error: "Unknown tailoring mode." };
  }

  const loaded = await loadUserData();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { profile, ai } = loaded.data;
  if (!ai.apiKey) return { ok: false, error: "Add an API key on the AI page first." };
  if (!(profile.work_experience ?? []).length && !(profile.skills ?? []).length) {
    return { ok: false, error: "Your profile has no work experience or skills yet — fill it in (or parse your resume) first." };
  }

  const { system, user: prompt } = buildTailorPrompt(profile, jd, mode);
  const res = await callLLM({
    provider: ai.provider,
    model: ai.model,
    apiKey: ai.apiKey,
    system,
    user: prompt,
    // Generous twice over: the reply carries every bullet, AND thinking-enabled
    // models (gemini-2.5-flash) spend output tokens on thought before the JSON —
    // a tight budget truncates the reply mid-object (live-test finding).
    maxTokens: 8000,
  });
  if (!res.ok) return { ok: false, error: "AI request failed: " + res.error };

  const result = parseTailorReply(res.text, profile, mode);
  if (result.error) {
    return { ok: false, error: "Couldn't read the AI reply (" + result.error + ") — try again." };
  }
  return {
    ok: true,
    result,
    tex: tailoredToTex(profile, result),
    printHtml: tailoredToPrintHtml(profile, result),
  };
}

// ── RESUME-FIRST tailoring: edit the user's ACTUAL .tex (bullets only) ────────

export type TexTailorActionResult =
  | {
      ok: true;
      result: TexTailorResult;
      /** Compiled PDF of the FITTED document (absent when no local engine). */
      pdfBase64?: string;
      pages?: number | null;
      basePages?: number | null;
      length_reverts?: number;
    }
  | { ok: false; error: string };

/** tex → PDF bytes with the local engine; null when unavailable/failed. */
async function tryCompile(tex: string): Promise<Buffer | null> {
  const r = await runTectonic(tex);
  return r.ok ? r.pdf : null;
}

/** tex → page count via the local engine + unpdf; null when unavailable/failed. */
async function compilePages(tex: string): Promise<number | null> {
  const pdf = await tryCompile(tex);
  if (!pdf) return null;
  try {
    const { getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    return doc.numPages;
  } catch {
    return null;
  }
}

/**
 * Tailor the user's real resume source: the LLM proposes keep/drop/replace per
 * \resumeItem bullet; everything else in the document passes through untouched
 * (fidelity by construction — the operator's resume-first correction of the
 * profile-first design). Same mode guardrails as the profile path.
 */
export async function tailorResumeTex({
  jobDescription,
  mode,
  tex,
}: {
  jobDescription: string;
  mode: TailorMode;
  tex: string;
}): Promise<TexTailorActionResult> {
  const jd = (jobDescription || "").trim();
  if (jd.length < MIN_JD_CHARS) {
    return { ok: false, error: "Paste a job description first — a bit more text is needed to tailor." };
  }
  if (!["select", "rewrite-surface", "rewrite-full"].includes(mode)) {
    return { ok: false, error: "Unknown tailoring mode." };
  }
  const units = extractTexUnits(tex || "");
  if (!units.length) {
    return { ok: false, error: "No \\resumeItem{…} bullets found in that .tex — is it your sb2nov-style resume source?" };
  }

  const loaded = await loadUserData();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { ai } = loaded.data;
  if (!ai.apiKey) return { ok: false, error: "Add an API key on the AI page first." };

  const { system, user: prompt } = buildTexTailorPrompt(units, jd, mode);
  const res = await callLLM({
    provider: ai.provider,
    model: ai.model,
    apiKey: ai.apiKey,
    system,
    user: prompt,
    maxTokens: 8000, // reply carries every bullet decision + thinking headroom
  });
  if (!res.ok) return { ok: false, error: "AI request failed: " + res.error };

  const parsed = parseTexReply(res.text);
  if (!parsed) return { ok: false, error: "Couldn't read the AI reply (parse-failed) — try again." };
  const { decisions, reverted } = decideTexEdits(units, parsed.edits, mode, vocabFromTex(tex));

  // PAGE-FIT: measure the ORIGINAL's page count, then compile-and-revert the
  // largest-growth rewrites until the tailored document fits it. Engine absent →
  // skip (the client's compile fallback surfaces the set-TECTONIC_PATH hint).
  const basePages = await compilePages(tex);
  let fittedTex: string | null = null;
  let pages: number | null = null;
  let lengthReverts = 0;
  if (basePages != null) {
    const fit = await fitTexToPages(tex, decisions, basePages, compilePages);
    fittedTex = fit.tex;
    pages = fit.pages;
    lengthReverts = fit.length_reverts;
  }

  const result: TexTailorResult = {
    tex: fittedTex ?? spliceTexEdits(tex, decisions),
    records: decisionsToRecords(decisions),
    gaps: parsed.gaps,
    rationale: parsed.rationale,
    reverted_count: reverted,
  };

  const finalPdf = fittedTex != null ? await tryCompile(fittedTex) : null;
  return {
    ok: true,
    result,
    ...(finalPdf ? { pdfBase64: finalPdf.toString("base64") } : {}),
    pages,
    basePages,
    length_reverts: lengthReverts,
  };
}

// ── LaTeX → PDF compile (LOCAL engine; the exact sb2nov template) ─────────────

export type CompileResult = { ok: true; pdfBase64: string } | { ok: false; error: string };

/**
 * Compile a generated .tex to PDF with a LOCAL TeX engine (tectonic — a single
 * user-scope binary; path via TECTONIC_PATH, falls back to "tectonic" on PATH).
 * Runs on the machine hosting the site: works for local dev today; a Vercel
 * deploy would need a compile container instead (documented in WEBSITE.md).
 * Auth-gated like every user action (signed-in or DEV_PREVIEW). Never throws.
 */
/** Shared engine runner: shim + temp dir + tectonic + read the PDF. Never throws. */
async function runTectonic(tex: string): Promise<{ ok: true; pdf: Buffer } | { ok: false; error: string }> {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");

  const engine = process.env.TECTONIC_PATH || "tectonic";
  let dir = "";
  try {
    dir = await mkdtemp(join(tmpdir(), "ap-tex-"));
    // XeTeX shim: guard pdfTeX-only primitives so a user's RAW resume.tex compiles
    // under tectonic (the downloaded .tex is untouched — this is compile-time only).
    await writeFile(join(dir, "resume.tex"), shimForXetex(tex), "utf-8");
    const run = new Promise<{ code: number; err: string }>((resolve) => {
      execFile(
        engine,
        [join(dir, "resume.tex"), "--outdir", dir, "--chatter", "minimal"],
        { timeout: 180000, windowsHide: true },
        (error, _stdout, stderr) => resolve({ code: error ? 1 : 0, err: String(stderr || (error && error.message) || "") })
      );
    });
    const { code, err } = await run;
    if (code !== 0) {
      if (/ENOENT/.test(err)) {
        return { ok: false, error: "LaTeX engine not found — set TECTONIC_PATH in web/.env.local (see .env.example)." };
      }
      return { ok: false, error: "LaTeX compile failed: " + err.slice(-400) };
    }
    const pdf = await readFile(join(dir, "resume.pdf"));
    return { ok: true, pdf };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "compile crashed" };
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function compileLatexPdf({ tex }: { tex: string }): Promise<CompileResult> {
  const gate = await loadUserData();
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!tex || tex.length < 100 || !tex.includes("\\begin{document}")) {
    return { ok: false, error: "Nothing to compile — tailor first." };
  }
  const r = await runTectonic(tex);
  return r.ok ? { ok: true, pdfBase64: r.pdf.toString("base64") } : r;
}

// ── JD sources: tracked applications that carry a scraped job description ────

export type JdApplication = {
  id: string;
  company: string;
  role: string;
  url: string;
  job_description: string;
};

/** Applications whose Run flow captured a job description — the picker's feed.
 *  Graceful []: not signed in / not configured / older rows without a JD. */
export async function listJdApplications(): Promise<JdApplication[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
      .from("applications")
      .select("id, company, role, url, job_description")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .not("job_description", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);
    return (data ?? [])
      .filter((r) => r.job_description && String(r.job_description).trim().length >= 40)
      .map((r) => ({
        id: String(r.id),
        company: String(r.company ?? ""),
        role: String(r.role ?? ""),
        url: String(r.url ?? ""),
        job_description: String(r.job_description),
      }));
  } catch {
    return [];
  }
}
