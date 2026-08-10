"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import {
  profileSchema,
  coerceProfile,
  mergeProfile,
  replaceProfileSections,
  reconcileLaddersToProfile,
  emptyProfile,
  type ParsedSection,
} from "@/lib/profile-schema";
import { validatePlan, applyReconcilePlan, type EntryDecision } from "@/lib/profile-reconcile";
import { diffProfile, profileFingerprint, type ProfileDiff } from "@/lib/profile-diff";
import { sanitizePdfName } from "@/lib/filenames";
import type { Profile } from "@/lib/profile-schema";

export type ActionResult = { ok: true } | { ok: false; error: string };

export type ReplaceActionResult =
  | { ok: true; replaced: ParsedSection[]; droppedLadders: string[] }
  | { ok: false; error: string };

export type ReconcileActionResult =
  | { ok: true; updated: number; added: number }
  | { ok: false; error: string };

export type ApplyMode = "fill" | "replace";

export type PreviewResult =
  | { ok: true; diff: ProfileDiff; fingerprint: string }
  | { ok: false; error: string };

/** Shared load: the signed-in user's current profile, or a typed failure. */
async function loadCurrentProfile(): Promise<
  { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; userId: string; current: Profile } | { ok: false; error: string }
> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars to save (see WEBSITE.md)." };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You're not signed in." };
  const { data: row } = await supabase
    .from("profiles")
    .select("profile_json")
    .eq("id", user.id)
    .maybeSingle();
  return {
    ok: true,
    supabase,
    userId: user.id,
    current: row?.profile_json ? coerceProfile(row.profile_json) : emptyProfile(),
  };
}

/**
 * The profile changed between preview and confirm. Refusing beats writing something
 * the user never saw — they re-preview and look again.
 */
const STALE =
  "Your profile changed since this preview was generated. Re-run the preview so you can see the current diff.";

/**
 * What a mode WOULD do, computed by running that mode's real apply function against
 * a clone and diffing. Nothing is written.
 */
export async function previewProfileApply(parsedRaw: unknown, mode: ApplyMode): Promise<PreviewResult> {
  const parsed = profileSchema.safeParse(parsedRaw);
  if (!parsed.success) return { ok: false, error: "Parsed profile didn't validate." };

  const loaded = await loadCurrentProfile();
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const after =
    mode === "replace"
      ? replaceProfileSections(loaded.current, parsed.data).profile
      : mergeProfile(loaded.current, parsed.data);

  return { ok: true, diff: diffProfile(loaded.current, after), fingerprint: profileFingerprint(loaded.current) };
}

/** Merge an AI-parsed profile into the user's profile (fills blanks only). */
export async function applyParsedProfile(parsedRaw: unknown, expect?: string): Promise<ActionResult> {
  const parsed = profileSchema.safeParse(parsedRaw);
  if (!parsed.success) return { ok: false, error: "Parsed profile didn't validate." };

  try {
    const loaded = await loadCurrentProfile();
    if (!loaded.ok) return { ok: false, error: loaded.error };
    if (expect && profileFingerprint(loaded.current) !== expect) return { ok: false, error: STALE };

    const merged = reconcileLaddersToProfile(loaded.current, mergeProfile(loaded.current, parsed.data)).profile;

    const { error } = await loaded.supabase
      .from("profiles")
      .upsert({ id: loaded.userId, profile_json: merged }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * REPLACE the parsed sections instead of only filling blanks.
 *
 * Exists because "Apply" is a silent no-op on an already-populated profile: it
 * fills blanks, and a user who rewrites their resume has no blanks left. Scope is
 * still limited to what a resume can state (see `replaceProfileSections`), so
 * screening answers, work authorization, self-ID and employment_history_companies
 * are untouched.
 */
export async function replaceParsedProfile(parsedRaw: unknown, expect?: string): Promise<ReplaceActionResult> {
  const parsed = profileSchema.safeParse(parsedRaw);
  if (!parsed.success) return { ok: false, error: "Parsed profile didn't validate." };

  try {
    const loaded = await loadCurrentProfile();
    if (!loaded.ok) return { ok: false, error: loaded.error };
    if (expect && profileFingerprint(loaded.current) !== expect) return { ok: false, error: STALE };

    const r = replaceProfileSections(loaded.current, parsed.data);
    const { replaced, droppedLadders } = r;
    const profile = reconcileLaddersToProfile(loaded.current, r.profile).profile;

    const { error } = await loaded.supabase
      .from("profiles")
      .upsert({ id: loaded.userId, profile_json: profile }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, replaced, droppedLadders };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * Commit a smart-merge plan the user has seen and confirmed.
 *
 * The plan arrives from the client, so it is RE-VALIDATED here against the profile
 * as it stands right now — never applied as given. That closes the window where the
 * profile changed in another tab between planning and confirming, and means a
 * tampered plan can still only produce a legal update/append.
 */
export async function applyReconcile(
  parsedRaw: unknown,
  decisionsRaw: unknown,
  expect?: string,
): Promise<ReconcileActionResult> {
  const parsed = profileSchema.safeParse(parsedRaw);
  if (!parsed.success) return { ok: false, error: "Parsed profile didn't validate." };
  if (!Array.isArray(decisionsRaw)) return { ok: false, error: "No merge plan supplied." };

  try {
    const loaded = await loadCurrentProfile();
    if (!loaded.ok) return { ok: false, error: loaded.error };
    if (expect && profileFingerprint(loaded.current) !== expect) return { ok: false, error: STALE };

    const plan = validatePlan(loaded.current, parsed.data, decisionsRaw as EntryDecision[]);
    const rc = applyReconcilePlan(loaded.current, parsed.data, plan);
    const { updated, added } = rc;
    const profile = reconcileLaddersToProfile(loaded.current, rc.profile).profile;

    const { error } = await loaded.supabase
      .from("profiles")
      .upsert({ id: loaded.userId, profile_json: profile }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, updated, added };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

// ── resume SOURCE (.tex / .docx) — the document the PDF is generated from ────

export type ResumeSource = { kind: "tex" | "docx"; filename: string; tex?: string };
export type SourceResult = { ok: true; source: ResumeSource | null } | { ok: false; error: string };

/** The stored source, with the .tex text inlined for the editor. */
export async function getResumeSource(): Promise<SourceResult> {
  if (!isSupabaseConfigured()) return { ok: true, source: null };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: true, source: null };
    const { data } = await supabase
      .from("resumes")
      .select("filename, storage_path")
      .eq("user_id", user.id)
      .eq("kind", "source")
      .maybeSingle();
    if (!data) return { ok: true, source: null };
    const kind = data.storage_path.endsWith(".tex") ? "tex" : "docx";
    if (kind === "docx") return { ok: true, source: { kind, filename: data.filename } };
    const { data: blob, error } = await supabase.storage.from("resumes").download(data.storage_path);
    if (error || !blob) return { ok: true, source: { kind, filename: data.filename } };
    return { ok: true, source: { kind, filename: data.filename, tex: await blob.text() } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** Persist the live-edited .tex back to the stored source. */
export async function saveResumeSourceTex({ filename, tex }: { filename: string; tex: string }): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  if (!tex || !tex.includes("\\begin{document}")) return { ok: false, error: "That doesn't look like a LaTeX document." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    const path = `${user.id}/source.tex`;
    const { error: upErr } = await supabase.storage
      .from("resumes")
      .upload(path, new Blob([tex], { type: "application/x-tex" }), { upsert: true, contentType: "application/x-tex" });
    if (upErr) return { ok: false, error: upErr.message };
    await supabase.from("resumes").delete().eq("user_id", user.id).eq("kind", "source");
    const { error: insErr } = await supabase.from("resumes").insert({
      user_id: user.id,
      kind: "source",
      filename: filename || "resume.tex",
      mime: "application/x-tex",
      size: tex.length,
      storage_path: path,
    });
    if (insErr) return { ok: false, error: insErr.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** Store the generated PDF as THE resume the extension attaches, under the
 *  user-chosen name (that filename is what recruiters see). */
export async function saveCompiledResume({ pdfBase64, pdfName }: { pdfBase64: string; pdfName: string }): Promise<
  { ok: true; filename: string; size: number } | { ok: false; error: string }
> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  if (!pdfBase64) return { ok: false, error: "Nothing compiled yet." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    const bytes = Buffer.from(pdfBase64, "base64");
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return { ok: false, error: "Bad PDF payload." };
    const filename = sanitizePdfName(pdfName);
    const path = `${user.id}/default-resume.pdf`;
    const { error: upErr } = await supabase.storage
      .from("resumes")
      .upload(path, bytes, { upsert: true, contentType: "application/pdf" });
    if (upErr) return { ok: false, error: upErr.message };
    await supabase.from("resumes").delete().eq("user_id", user.id).eq("kind", "default");
    const { error: insErr } = await supabase.from("resumes").insert({
      user_id: user.id,
      kind: "default",
      filename,
      mime: "application/pdf",
      size: bytes.length,
      storage_path: path,
    });
    if (insErr) return { ok: false, error: insErr.message };
    return { ok: true, filename, size: bytes.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** .docx → PDF needs a local LibreOffice (SOFFICE_PATH); honest error otherwise. */
export async function convertDocxToPdf(): Promise<{ ok: true; pdfBase64: string } | { ok: false; error: string }> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  const soffice = process.env.SOFFICE_PATH;
  if (!soffice) {
    return {
      ok: false,
      error: "Converting .docx to PDF needs LibreOffice — install it and set SOFFICE_PATH in web/.env.local, or upload a .tex instead.",
    };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    const { data: blob, error } = await supabase.storage.from("resumes").download(`${user.id}/source.docx`);
    if (error || !blob) return { ok: false, error: "No stored .docx source found." };

    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    let dir = "";
    try {
      dir = await mkdtemp(join(tmpdir(), "ap-docx-"));
      const src = join(dir, "resume.docx");
      await writeFile(src, Buffer.from(await blob.arrayBuffer()));
      const code = await new Promise<number>((resolve) =>
        execFile(soffice, ["--headless", "--convert-to", "pdf", "--outdir", dir, src], { timeout: 120000, windowsHide: true }, (e) =>
          resolve(e ? 1 : 0)
        )
      );
      if (code !== 0) return { ok: false, error: "LibreOffice conversion failed." };
      const pdf = await readFile(join(dir, "resume.pdf"));
      return { ok: true, pdfBase64: pdf.toString("base64") };
    } finally {
      if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Conversion crashed." };
  }
}

export type PreviewUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** A short-lived signed URL for the stored resume PDF, so the browser can render
 *  the ACTUAL uploaded file (the private bucket blocks direct links). */
export async function getResumePreviewUrl(): Promise<PreviewUrlResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    const { data, error } = await supabase.storage
      .from("resumes")
      .createSignedUrl(`${user.id}/default-resume.pdf`, 600);
    if (error || !data?.signedUrl) return { ok: false, error: error?.message ?? "No stored resume found." };
    return { ok: true, url: data.signedUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** Remove the stored default resume (Storage object + row). */
export async function removeResume(): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    await supabase.storage.from("resumes").remove([`${user.id}/default-resume.pdf`]);
    await supabase.from("resumes").delete().eq("user_id", user.id).eq("kind", "default");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
