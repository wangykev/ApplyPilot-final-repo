"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { FileText, Sparkles, Check, Trash2, ArrowRight, Eye, X, FileUp, FileCheck2, RefreshCw } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import {
  applyParsedProfile,
  replaceParsedProfile,
  applyReconcile,
  previewProfileApply,
  removeResume,
  getResumePreviewUrl,
  saveResumeSourceTex,
  saveCompiledResume,
  convertDocxToPdf,
  type ResumeSource,
} from "./actions";
import { compileLatexPdf } from "@/app/app/tailor/actions";
import { liveSync } from "@/lib/extension-sync";
import type { Profile } from "@/lib/profile-schema";
import type { ProfileDiff } from "@/lib/profile-diff";
import { clsx } from "@/lib/clsx";

type Stored = { filename: string; size: number } | null;
type Msg = { kind: "ok" | "err" | "info"; text: string; aiLink?: boolean } | null;

/**
 * One shape for all three modes. Every mode is preview-then-confirm: `diff` is the
 * computed before/after, `fingerprint` pins the profile the diff was taken against,
 * and `decisions` is present only for smart merge (what the AI proposed).
 */
type Pending = {
  mode: "smart" | "fill" | "replace";
  diff: ProfileDiff;
  fingerprint: string;
  decisions?: unknown[];
  corrections?: string[];
  aiPlan?: {
    section: string; action: "update" | "add"; label: string; replaces: string | null; reason: string;
    // per-row field changes — what the merge actually edits inside a matched entry
    fields?: { key: string; kind: "added" | "changed"; before: string; after: string }[];
  }[];
} | null;

// Draft persistence: the editor survives navigating away and coming back, even
// signed-out / before "Save as my resume". Also mirrored to the tailor page's
// fallback keys so the source ports over without a backend.
const LS_TEX = "applypilot.resume.tex";
const LS_TEX_NAME = "applypilot.resume.texName";
const LS_PDF_NAME = "applypilot.resume.pdfName";
const LS_TAILOR_TEX = "applypilot.tailor.tex";
const LS_TAILOR_NAME = "applypilot.tailor.texName";
const LS_VERSIONS = "applypilot.resume.versions";

/** Named snapshots of the .tex — different versions of the same resume the user
 *  can switch between. Kept on this device; the EDITOR's content is always the
 *  live/active one (it's what compiles, saves, and feeds the Tailor page). */
type TexVersion = { id: string; name: string; tex: string; savedAt: number };

function loadVersions(): TexVersion[] {
  try {
    const raw = localStorage.getItem(LS_VERSIONS);
    const v = raw ? (JSON.parse(raw) as TexVersion[]) : [];
    return Array.isArray(v) ? v.filter((x) => x && typeof x.tex === "string") : [];
  } catch {
    return [];
  }
}

function storeVersions(v: TexVersion[]) {
  try {
    localStorage.setItem(LS_VERSIONS, JSON.stringify(v));
  } catch {
    /* quota / private mode */
  }
}

function kb(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function summarize(p: Profile): { label: string; n: number }[] {
  return [
    { label: "Roles", n: p.work_experience.length },
    { label: "Projects", n: p.projects.length },
    { label: "Schools", n: p.education.length },
    { label: "Skills", n: p.skills.length },
    { label: "Links", n: p.websites.length },
    { label: "Languages", n: p.languages.length },
    { label: "Certifications", n: p.certifications.length },
  ].filter((x) => x.n > 0);
}

/**
 * How many individual edits a diff represents. Drives both the counter and the
 * disabled state of Apply — a preview with zero changes must not offer a button that
 * writes an identical profile back and reports success.
 */
function changeCount(d: ProfileDiff): number {
  return d.sections.reduce(
    (n, s) =>
      n +
      (s.fields?.length ?? 0) +
      (s.entries?.length ?? 0) +
      (s.values ? s.values.added.length + s.values.removed.length : 0),
    0,
  );
}

export function ResumePanel({ initialStored, initialSource }: { initialStored: Stored; initialSource: ResumeSource | null }) {
  const [stored, setStored] = useState<Stored>(initialStored);
  const [msg, setMsg] = useState<Msg>(null);
  const [parsed, setParsed] = useState<Profile | null>(null);
  const [parsing, setParsing] = useState(false);
  const [planning, setPlanning] = useState<null | "smart" | "fill" | "replace">(null);
  const [pending, setPending] = useState<Pending>(null);
  const [applying, startApply] = useTransition();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ── source (the document the PDF is generated from) ───────────────────────
  const [tab, setTab] = useState<"tex" | "docx">(initialSource?.kind === "docx" ? "docx" : "tex");
  const [texText, setTexText] = useState<string>(initialSource?.kind === "tex" ? initialSource.tex ?? "" : "");
  const [texName, setTexName] = useState<string>(initialSource?.kind === "tex" ? initialSource.filename : "");
  const [docxName, setDocxName] = useState<string>(initialSource?.kind === "docx" ? initialSource.filename : "");
  const [pdfName, setPdfName] = useState<string>(initialStored?.filename ?? "resume.pdf");
  const [sourceSaved, setSourceSaved] = useState(true); // editor text == stored source?

  // named versions of the .tex (device-local)
  const [versions, setVersions] = useState<TexVersion[]>([]);
  const [versionName, setVersionName] = useState("");
  const [activeVersion, setActiveVersion] = useState<string>("");
  // stored-card tabs: "attached" (what the extension uploads) or a version preview
  const [storedTab, setStoredTab] = useState<string>("attached");
  const versionPdfCache = useRef(new Map<string, { tex: string; url: string }>());
  const [versionPdf, setVersionPdf] = useState<string | null>(null);
  const [versionCompiling, setVersionCompiling] = useState(false);
  const [versionErr, setVersionErr] = useState<string | null>(null);

  async function openStoredTab(name: string) {
    setStoredTab(name);
    setVersionErr(null);
    if (name === "attached") return;
    const v = versions.find((x) => x.name === name);
    if (!v) return;
    const cached = versionPdfCache.current.get(name);
    if (cached && cached.tex === v.tex) {
      setVersionPdf(cached.url);
      return;
    }
    setVersionPdf(null);
    setVersionCompiling(true);
    const res = await compileLatexPdf({ tex: v.tex });
    setVersionCompiling(false);
    if (!res.ok) {
      setVersionErr(res.error);
      return;
    }
    const bytes = Uint8Array.from(atob(res.pdfBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const old = versionPdfCache.current.get(name);
    if (old) URL.revokeObjectURL(old.url);
    versionPdfCache.current.set(name, { tex: v.tex, url });
    setVersionPdf(url);
  }

  // live compile (debounced) — the bottom preview is the ACTUAL PDF
  const [compiled, setCompiled] = useState<{ url: string; base64: string } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState<string | null>(null);
  const compileSeq = useRef(0);

  async function compileNow(tex: string) {
    const seq = ++compileSeq.current;
    setCompiling(true);
    setCompileErr(null);
    const res = await compileLatexPdf({ tex });
    if (seq !== compileSeq.current) return; // superseded by a newer edit
    setCompiling(false);
    if (!res.ok) {
      setCompileErr(res.error);
      return;
    }
    const bytes = Uint8Array.from(atob(res.pdfBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setCompiled((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { url, base64: res.pdfBase64 };
    });
  }

  // restore the local draft on mount — it's the latest editing session, so it wins
  // over the server copy (which it may extend with unsaved edits)
  useEffect(() => {
    try {
      const draft = localStorage.getItem(LS_TEX);
      if (draft) {
        setTexText(draft);
        setTexName(localStorage.getItem(LS_TEX_NAME) || "resume.tex");
        setTab("tex");
        setSourceSaved(initialSource?.kind === "tex" && initialSource.tex === draft);
      }
      const pn = localStorage.getItem(LS_PDF_NAME);
      if (pn) setPdfName(pn);
      setVersions(loadVersions());
    } catch {
      /* private mode etc. */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function snapshotVersion() {
    if (!texText.trim()) return;
    const name = versionName.trim() || `Version ${versions.length + 1}`;
    const next: TexVersion[] = [
      ...versions.filter((v) => v.name !== name), // same name = overwrite
      { id: `${Date.now()}`, name, tex: texText, savedAt: Date.now() },
    ];
    setVersions(next);
    storeVersions(next);
    setActiveVersion(name);
    setVersionName("");
    setMsg({ kind: "ok", text: `Snapshotted “${name}” (${next.length} version${next.length === 1 ? "" : "s"} on this device).` });
  }

  function switchVersion(name: string) {
    setActiveVersion(name);
    const v = versions.find((x) => x.name === name);
    if (!v) return;
    setTexText(v.tex);
    setSourceSaved(false);
    setMsg({ kind: "info", text: `Loaded “${v.name}” into the editor.` });
  }

  function deleteVersion() {
    if (!activeVersion) return;
    const next = versions.filter((x) => x.name !== activeVersion);
    setVersions(next);
    storeVersions(next);
    setActiveVersion("");
    setMsg({ kind: "info", text: "Version deleted (editor content untouched)." });
  }

  // persist the draft (debounced) + mirror to the tailor page's fallback keys
  useEffect(() => {
    if (!texText.trim()) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(LS_TEX, texText);
        localStorage.setItem(LS_TEX_NAME, texName || "resume.tex");
        localStorage.setItem(LS_TAILOR_TEX, texText);
        localStorage.setItem(LS_TAILOR_NAME, texName || "resume.tex");
      } catch {
        /* quota / private mode — session-only then */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [texText, texName]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_PDF_NAME, pdfName);
    } catch {
      /* noop */
    }
  }, [pdfName]);

  // debounce: recompile ~1.2s after the user stops typing
  useEffect(() => {
    if (tab !== "tex" || !texText.trim()) return;
    const t = setTimeout(() => void compileNow(texText), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texText, tab]);

  useEffect(() => {
    if (!previewUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewUrl(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewUrl]);

  async function onSourceFile(f: File) {
    const lower = f.name.toLowerCase();
    if (tab === "tex" && !lower.endsWith(".tex")) return setMsg({ kind: "err", text: "Please choose a .tex file." });
    if (tab === "docx" && !lower.endsWith(".docx")) return setMsg({ kind: "err", text: "Please choose a .docx file." });
    setMsg(null);

    if (tab === "tex") {
      // open in the editor immediately; storage is best-effort (sign-in optional for editing)
      const text = await f.text();
      setTexText(text);
      setTexName(f.name);
      setSourceSaved(false);
    } else {
      setDocxName(f.name);
    }

    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/resume/source", { method: "POST", body: fd });
      const j = await r.json();
      if (j.ok) {
        setSourceSaved(true);
        setMsg({ kind: "ok", text: `${f.name} stored as your resume source.` });
      } else {
        setMsg({ kind: "info", text: `Editing locally — source not stored (${j.error ?? "upload failed"}).` });
      }
    } catch {
      setMsg({ kind: "info", text: "Editing locally — source not stored (backend unreachable)." });
    }
  }

  async function convertDocx() {
    setCompiling(true);
    setCompileErr(null);
    const res = await convertDocxToPdf();
    setCompiling(false);
    if (!res.ok) {
      setCompileErr(res.error);
      return;
    }
    const bytes = Uint8Array.from(atob(res.pdfBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setCompiled((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { url, base64: res.pdfBase64 };
    });
  }

  // AUTO-SAVE (no save button): every SUCCESSFUL compile persists the source +
  // the PDF (under the chosen name) and live-syncs the extension. A failed
  // compile never reaches here, so a broken document can't replace the stored
  // resume. Signed-out → quiet "local only" status (the local draft still holds).
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "local">("idle");
  const saveSeq = useRef(0);

  useEffect(() => {
    if (!compiled) return;
    const seq = ++saveSeq.current;
    const t = setTimeout(async () => {
      setSaveState("saving");
      if (tab === "tex" && texText.trim()) {
        const s = await saveResumeSourceTex({ filename: texName || "resume.tex", tex: texText });
        if (s.ok && seq === saveSeq.current) setSourceSaved(true);
      }
      const res = await saveCompiledResume({ pdfBase64: compiled.base64, pdfName });
      if (seq !== saveSeq.current) return; // superseded by a newer compile/name edit
      if (res.ok) {
        setStored({ filename: res.filename, size: res.size });
        setSaveState("saved");
        liveSync("resume");
      } else {
        setSaveState("local"); // typically "not signed in" / backend off — draft still safe locally
      }
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled, pdfName]);

  async function openPreview() {
    setPreviewLoading(true);
    setMsg(null);
    const res = await getResumePreviewUrl();
    setPreviewLoading(false);
    if (res.ok) setPreviewUrl(res.url);
    else setMsg({ kind: "err", text: "Preview failed: " + res.error });
  }

  async function parse() {
    if (!compiled) return;
    setParsing(true);
    setMsg(null);
    setParsed(null);
    try {
      const bytes = Uint8Array.from(atob(compiled.base64), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append("file", new File([bytes], pdfName || "resume.pdf", { type: "application/pdf" }));
      const r = await fetch("/api/parse-resume", { method: "POST", body: fd });
      const j = await r.json();
      if (j.ok) {
        setParsed(j.profile as Profile);
        setMsg({ kind: "ok", text: "Parsed. Review what we found, then apply it." });
      } else {
        setMsg({
          kind: "err",
          text: j.error ?? "Parse failed.",
          aiLink: typeof j.error === "string" && j.error.toLowerCase().includes("api key"),
        });
      }
    } catch {
      setMsg({ kind: "err", text: "Parse failed — is the backend reachable?" });
    } finally {
      setParsing(false);
    }
  }

  // EVERY mode is preview-then-confirm. Nothing writes on the first click — the diff
  // below is computed by running that mode's real apply against a clone, so what you
  // read is what you get.
  async function preview(mode: "smart" | "fill" | "replace") {
    if (!parsed) return;
    setPlanning(mode);
    setPending(null);
    setMsg(null);
    try {
      if (mode === "smart") {
        const r = await fetch("/api/reconcile-profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parsed }),
        });
        const j = await r.json();
        if (!j.ok) {
          setMsg({
            kind: "err",
            text: j.error ?? "Could not plan the merge.",
            aiLink: typeof j.error === "string" && j.error.toLowerCase().includes("api key"),
          });
          return;
        }
        setPending({
          mode,
          diff: j.diff,
          fingerprint: j.fingerprint,
          decisions: j.plan.decisions,
          corrections: j.plan.corrections,
          aiPlan: j.preview,
        });
      } else {
        const res = await previewProfileApply(parsed, mode);
        if (!res.ok) {
          setMsg({ kind: "err", text: res.error });
          return;
        }
        setPending({ mode, diff: res.diff, fingerprint: res.fingerprint });
      }
    } catch {
      setMsg({ kind: "err", text: "Could not build the preview — is the backend reachable?" });
    } finally {
      setPlanning(null);
    }
  }

  function confirm() {
    if (!parsed || !pending) return;
    const p = pending;
    startApply(async () => {
      if (p.mode === "smart") {
        const res = await applyReconcile(parsed, p.decisions ?? [], p.fingerprint);
        if (!res.ok) return setMsg({ kind: "err", text: res.error });
        liveSync("profile");
        setPending(null);
        return setMsg({
          kind: res.updated + res.added > 0 ? "ok" : "info",
          text:
            res.updated + res.added > 0
              ? `Merged — ${res.updated} entr${res.updated === 1 ? "y" : "ies"} updated, ${res.added} added.`
              : "Nothing changed.",
        });
      }
      if (p.mode === "replace") {
        const res = await replaceParsedProfile(parsed, p.fingerprint);
        if (!res.ok) return setMsg({ kind: "err", text: res.error });
        liveSync("profile");
        setPending(null);
        const ladders = res.droppedLadders.length
          ? ` Dropped ${res.droppedLadders.length} dangling answer ladder${res.droppedLadders.length === 1 ? "" : "s"}.`
          : "";
        return setMsg({
          kind: res.replaced.length ? "ok" : "info",
          text:
            (res.replaced.length
              ? `Replaced ${res.replaced.join(", ").replace(/_/g, " ")}.`
              : "Nothing to replace — your profile already matches the resume.") + ladders,
        });
      }
      const res = await applyParsedProfile(parsed, p.fingerprint);
      if (!res.ok) return setMsg({ kind: "err", text: res.error });
      liveSync("profile");
      setPending(null);
      setMsg({ kind: "ok", text: "Applied — blank fields filled." });
    });
  }

  function clear() {
    startApply(async () => {
      const res = await removeResume();
      if (res.ok) {
        setStored(null);
        setParsed(null);
        setMsg({ kind: "info", text: "Removed." });
        liveSync("resume-clear");
      } else {
        setMsg({ kind: "err", text: res.error });
      }
    });
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="Resume source"
        subtitle="Upload the document your resume is WRITTEN in — .tex live-edits and recompiles below; the generated PDF (named on the right) is what the extension attaches. This source also feeds the Tailor page."
        actions={
          <div className="flex overflow-hidden rounded-lg border border-hairline">
            {(["tex", "docx"] as const).map((t, idx) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={clsx(
                  "px-3 py-1.5 text-xs transition-colors",
                  idx === 0 && "border-r border-hairline",
                  tab === t ? "bg-amber font-semibold text-cockpit" : "text-ink-dim hover:bg-panel-raised/60 hover:text-ink"
                )}
              >
                {t === "tex" ? "LaTeX (.tex)" : "Word (.docx)"}
              </button>
            ))}
          </div>
        }
      >
        {/* SIDE-BY-SIDE: source (editor / docx controls) LEFT · live PDF RIGHT */}
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            {tab === "tex" ? (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-hairline px-3 py-2 text-sm text-ink-dim transition-colors hover:border-amber hover:text-ink">
                    <FileUp className="h-4 w-4" />
                    {texName ? `Replace ${texName}` : "Upload .tex (optional)"}
                    <input
                      type="file"
                      accept=".tex,text/x-tex,application/x-tex"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) onSourceFile(f);
                      }}
                    />
                  </label>
                  <span className="font-mono text-[11px] text-ink-faint">
                    {texName || "or just paste below"}
                    {texText ? (sourceSaved ? " · stored" : " · unsaved edits") : ""}
                  </span>
                </div>
                {/* versions of the same resume (kept on this device) */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <select
                    value={activeVersion}
                    onChange={(e) => switchVersion(e.target.value)}
                    className="min-w-40 appearance-none rounded-lg border border-hairline bg-cockpit px-3 py-1.5 text-xs text-ink outline-none transition-colors focus:border-amber"
                  >
                    <option value="">{versions.length ? "Load a version…" : "No saved versions yet"}</option>
                    {versions.map((v) => (
                      <option key={v.id} value={v.name} className="bg-panel">
                        {v.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={versionName}
                    onChange={(e) => setVersionName(e.target.value)}
                    placeholder={`name it (e.g. "hardware focus")`}
                    className="w-44 rounded-lg border border-hairline bg-cockpit px-3 py-1.5 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
                  />
                  <button onClick={snapshotVersion} disabled={!texText.trim()} className="btn-ghost px-3 py-1.5 text-xs" title="Snapshot the current editor content as a named version">
                    <FileCheck2 className="h-3.5 w-3.5" /> Save version
                  </button>
                  {activeVersion && (
                    <button onClick={deleteVersion} className="inline-flex items-center gap-1 text-xs text-ink-faint transition-colors hover:text-signal" title={`Delete “${activeVersion}”`}>
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  )}
                </div>
                <textarea
                  value={texText}
                  onChange={(e) => {
                    setTexText(e.target.value);
                    setSourceSaved(false);
                    if (!texName) setTexName("resume.tex");
                  }}
                  spellCheck={false}
                  placeholder={"Paste your resume's .tex here — it compiles live on the right as you type."}
                  className="h-[620px] w-full resize-y rounded-lg border border-hairline bg-cockpit p-3 font-mono text-xs leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
                />
              </>
            ) : (
              <div className="space-y-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-hairline px-3 py-2 text-sm text-ink-dim transition-colors hover:border-amber hover:text-ink">
                  <FileUp className="h-4 w-4" />
                  {docxName ? `Replace ${docxName}` : "Upload .docx"}
                  <input
                    type="file"
                    accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) onSourceFile(f);
                    }}
                  />
                </label>
                {docxName && (
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[11px] text-ink-faint">{docxName} · stored</span>
                    <button onClick={convertDocx} disabled={compiling} className="btn-ghost px-3 py-1.5 text-xs">
                      <RefreshCw className="h-3.5 w-3.5" /> {compiling ? "Converting…" : "Convert to PDF"}
                    </button>
                  </div>
                )}
                <p className="text-xs text-ink-faint">
                  .docx can&apos;t be live-edited here; conversion to PDF uses a local LibreOffice (set SOFFICE_PATH). For
                  full live editing, use the .tex tab.
                </p>
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-label text-ink-dim">
              Live PDF preview
              {compiling && <span className="text-amber">compiling…</span>}
            </div>
            {compileErr && <p className="mb-2 text-sm text-signal">{compileErr}</p>}
            {compiled ? (
              <iframe title="Compiled resume PDF" src={compiled.url} className="h-[620px] w-full rounded-lg border border-hairline bg-white shadow-inner" />
            ) : (
              <div className="flex h-[620px] items-center justify-center rounded-lg border border-dashed border-hairline px-6 text-center text-sm text-ink-faint">
                {tab === "tex" ? "The compiled PDF appears here as you type" : "Convert the .docx to see the PDF here"}
              </div>
            )}
          </div>
        </div>

        {/* generated-PDF name — everything auto-saves; no save button */}
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-hairline pt-4">
          <label className="block min-w-56 flex-1">
            <span className="font-mono text-[10px] uppercase tracking-label text-ink-dim">Generated PDF filename (what recruiters see)</span>
            <input
              value={pdfName}
              onChange={(e) => setPdfName(e.target.value)}
              placeholder="Kevin-Wang-Resume.pdf"
              className="mt-1.5 w-full rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
            />
          </label>
          <span className="pb-2 font-mono text-[11px] tracking-label">
            {saveState === "saving" && <span className="text-amber">auto-saving…</span>}
            {saveState === "saved" && <span className="text-verified">✓ auto-saved &amp; synced — this PDF attaches to applications</span>}
            {saveState === "local" && <span className="text-ink-faint">local only — sign in to store &amp; sync</span>}
            {saveState === "idle" && <span className="text-ink-faint">auto-saves after each successful compile</span>}
          </span>
        </div>

        {msg && (
          <p className={clsx("mt-4 text-sm", msg.kind === "ok" && "text-verified", msg.kind === "err" && "text-signal", msg.kind === "info" && "text-ink-dim")}>
            {msg.text}
            {msg.aiLink && (
              <>
                {" "}
                <Link href="/app/ai" className="underline hover:text-amber">
                  Configure AI →
                </Link>
              </>
            )}
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Stored resume (attached to applications)"
        subtitle="The saved PDF the extension uploads on every application — plus your saved versions."
        actions={
          stored && storedTab === "attached" ? (
            <button onClick={clear} disabled={applying} className="inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-signal">
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </button>
          ) : null
        }
      >
        {/* tabs: the attached PDF + one per saved version */}
        {versions.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1 rounded-lg border border-hairline p-1">
            {["attached", ...versions.map((v) => v.name)].map((name) => (
              <button
                key={name}
                onClick={() => void openStoredTab(name)}
                className={clsx(
                  "rounded-md px-3 py-1.5 text-xs transition-colors",
                  storedTab === name ? "bg-amber font-semibold text-cockpit" : "text-ink-dim hover:bg-panel-raised/60 hover:text-ink"
                )}
              >
                {name === "attached" ? "Attached" : name}
              </button>
            ))}
          </div>
        )}

        {storedTab === "attached" ? (
          stored ? (
            <div className="flex items-center gap-3 rounded-lg border border-hairline bg-panel-raised/50 p-3">
              <FileText className="h-5 w-5 text-verified" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">{stored.filename}</div>
                <div className="font-mono text-[11px] text-ink-faint">{kb(stored.size)} · stored</div>
              </div>
              <button
                onClick={openPreview}
                disabled={previewLoading}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-ink-dim transition-colors hover:border-amber hover:text-ink"
                title="View the stored PDF exactly as it will be attached"
              >
                <Eye className="h-3.5 w-3.5" />
                {previewLoading ? "Opening…" : "Preview"}
              </button>
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-label text-verified">
                <Check className="h-3.5 w-3.5" /> Ready
              </span>
            </div>
          ) : (
            <p className="text-sm text-ink-dim">Nothing stored yet — paste or upload your source above; it auto-saves once it compiles.</p>
          )
        ) : (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="font-mono text-[11px] text-ink-faint">
                version “{storedTab}” — saved on this device
                {versionCompiling && <span className="text-amber"> · compiling…</span>}
              </span>
              <button
                onClick={() => {
                  switchVersion(storedTab);
                  setStoredTab("attached");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                className="btn-ghost px-3 py-1.5 text-xs"
                title="Load this version into the editor — it auto-compiles and becomes the attached resume"
              >
                <FileCheck2 className="h-3.5 w-3.5" /> Load into editor (makes it the attached one)
              </button>
            </div>
            {versionErr && <p className="mb-2 text-sm text-signal">{versionErr}</p>}
            {versionPdf ? (
              <iframe title={`Version ${storedTab}`} src={versionPdf} className="h-[560px] w-full rounded-lg border border-hairline bg-white shadow-inner" />
            ) : (
              <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-hairline text-sm text-ink-faint">
                {versionCompiling ? "Compiling this version…" : "Preview appears here"}
              </div>
            )}
          </div>
        )}

        {previewUrl && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPreviewUrl(null)} role="dialog" aria-modal="true" aria-label="Resume preview">
            <div className="bezel relative flex h-[90vh] w-full max-w-3xl flex-col p-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-hairline pb-3">
                <h2 className="font-display text-lg font-medium">
                  {stored?.filename ?? "Resume"}{" "}
                  <span className="font-mono text-[11px] font-normal text-ink-faint">— the stored PDF, as attached to applications</span>
                </h2>
                <button type="button" onClick={() => setPreviewUrl(null)} className="text-ink-dim transition-colors hover:text-ink" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <iframe title="Resume PDF" src={previewUrl} className="mt-3 w-full flex-1 rounded-lg bg-white" />
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Parse with AI"
        subtitle="Pull your work history, education, projects, and skills out of the compiled PDF into your profile. Review before it's applied — nothing is committed silently."
      >
        <button onClick={parse} disabled={!compiled || parsing} className="btn-primary" title={!compiled ? "Compile a PDF above first" : undefined}>
          <Sparkles className="h-4 w-4" />
          {parsing ? "Reading your resume…" : "Parse with AI"}
        </button>
        {!compiled && <p className="mt-3 text-xs text-ink-faint">Compile a PDF above, then parse. Parsing uses your configured AI provider.</p>}

        {parsed && (
          <div className="mt-6 rounded-lg border border-hairline bg-panel-raised/40 p-5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-verified" />
              <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">Found in your resume</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {summarize(parsed).length === 0 && <span className="text-sm text-ink-faint">No structured sections detected.</span>}
              {summarize(parsed).map((s) => (
                <span key={s.label} className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-panel px-2.5 py-1 text-sm">
                  <span className="font-mono text-amber">{s.n}</span>
                  <span className="text-ink-dim">{s.label}</span>
                </span>
              ))}
            </div>
            {(parsed.personal_info.first_name || parsed.personal_info.email) && (
              <p className="mt-4 text-sm text-ink-dim">
                {[parsed.personal_info.first_name, parsed.personal_info.last_name].filter(Boolean).join(" ")}
                {parsed.personal_info.email ? ` · ${parsed.personal_info.email}` : ""}
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button onClick={() => preview("smart")} disabled={applying || !!planning} className="btn-primary">
                {planning === "smart" ? "Asking the AI…" : "Preview smart merge"}
              </button>
              <button onClick={() => preview("fill")} disabled={applying || !!planning} className="btn-ghost">
                Preview fill blanks
              </button>
              <button onClick={() => preview("replace")} disabled={applying || !!planning} className="btn-ghost">
                Preview replace
              </button>
              <Link href="/app/profile" className="inline-flex items-center gap-1.5 text-sm text-ink-dim hover:text-amber">
                Open profile
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <p className="mt-3 text-xs text-ink-faint">
              Every mode shows you the exact before/after first — nothing is saved until you confirm.{" "}
              <span className="font-mono">Smart merge</span> asks the AI, per entry, whether it&apos;s the same
              job/degree you already have (updates it in place) or a new one (adds an entry); it never deletes.{" "}
              <span className="font-mono">Fill blanks</span> never overwrites, so on a complete profile it
              changes nothing.{" "}
              <span className="font-mono">Replace</span> makes this resume the source of truth for the sections
              above. All three leave work authorization, screening answers, self-identification and your
              previous-employer list alone — a resume can&apos;t state those. Smart merge and Replace also fold
              each role&apos;s tech stack into your skills list.
            </p>

            {pending && (
              <div className="mt-5 rounded-lg border border-hairline bg-panel p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">
                    {pending.mode === "smart" ? "Smart merge" : pending.mode === "replace" ? "Replace" : "Fill blanks"}
                    {" — nothing is saved yet"}
                  </span>
                  <span className="font-mono text-[10px] text-ink-faint">{changeCount(pending.diff)} change(s)</span>
                </div>

                {/* ⚠ ONLY ROWS THAT ACTUALLY CHANGE SOMETHING (operator, 2026-08-16). The matcher
                    emits a decision for EVERY entry it recognised, so an untouched entry still
                    produced a row reading «X — replaces "X" · same role and company» — and a preview
                    that is mostly no-ops buries the handful of real edits it exists to show. An `add`
                    is always a change; an `update` only counts once it has field changes. */}
                {pending.aiPlan && pending.aiPlan.filter((p) => p.action === "add" || (p.fields?.length ?? 0) > 0).length > 0 && (
                  <ul className="mt-3 space-y-2 border-b border-hairline pb-3">
                    {pending.aiPlan.filter((p) => p.action === "add" || (p.fields?.length ?? 0) > 0).map((p, i) => (
                      <li key={i} className="text-sm">
                        <span
                          className={clsx(
                            "mr-2 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase",
                            p.action === "update" ? "bg-amber/15 text-amber" : "bg-verified/15 text-verified",
                          )}
                        >
                          {p.action}
                        </span>
                        <span className="text-ink">{p.label}</span>
                        {p.replaces && p.replaces !== p.label && (
                          <span className="text-ink-faint"> — replaces “{p.replaces}”</span>
                        )}
                        {p.reason && <div className="ml-12 text-xs text-ink-faint">{p.reason}</div>}
                        {/* WHAT ACTUALLY CHANGES. Without this the row states only the matching
                            decision, so adding three role descriptions looked like a no-op. */}
                        {p.fields && p.fields.length > 0 && (
                          <ul className="ml-12 mt-1 space-y-0.5">
                            {p.fields.map((f, k) => (
                              <li key={k} className="text-xs">
                                <span className={clsx("mr-1.5 font-mono", f.kind === "added" ? "text-verified" : "text-amber")}>
                                  {f.kind === "added" ? "+" : "~"} {f.key}
                                </span>
                                {f.kind === "changed" && f.before && (
                                  <span className="text-ink-faint line-through">{f.before}</span>
                                )}
                                {f.kind === "changed" && f.before && <span className="text-ink-faint"> → </span>}
                                <span className="text-ink-faint">{f.after}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {changeCount(pending.diff) === 0 && (
                  <p className="mt-3 text-sm text-ink-faint">
                    This mode would change nothing.
                    {pending.mode === "fill" && " Your profile has no blanks the resume can fill."}
                  </p>
                )}

                <div className="mt-3 space-y-4">
                  {pending.diff.sections.map((s) => (
                    <div key={s.section}>
                      <div className="font-mono text-[11px] uppercase tracking-label text-amber">
                        {s.section.replace(/_/g, " ")}
                      </div>
                      {s.fields && (
                        <ul className="mt-1.5 space-y-1 text-sm">
                          {s.fields.map((f) => (
                            <li key={f.field}>
                              <span className="font-mono text-[11px] text-ink-faint">{f.field}</span>{" "}
                              <span className="text-ink-faint line-through">{f.before}</span>{" "}
                              <span className="text-ink-faint">→</span> <span className="text-ink">{f.after}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {s.entries && (
                        <ul className="mt-1.5 space-y-1 text-sm">
                          {s.entries.map((e, i) => (
                            <li key={i}>
                              {e.kind === "add" && (
                                <>
                                  <span className="mr-2 font-mono text-[10px] uppercase text-verified">add</span>
                                  <span className="text-ink">{e.label}</span>
                                </>
                              )}
                              {e.kind === "remove" && (
                                <>
                                  <span className="mr-2 font-mono text-[10px] uppercase text-signal">remove</span>
                                  <span className="text-ink-faint line-through">{e.label}</span>
                                </>
                              )}
                              {e.kind === "change" && (
                                <>
                                  <span className="mr-2 font-mono text-[10px] uppercase text-amber">
                                    entry {e.index + 1}
                                  </span>
                                  <span className="text-ink-faint line-through">{e.before}</span>{" "}
                                  <span className="text-ink-faint">→</span>{" "}
                                  <span className="text-ink">{e.after}</span>
                                  <div className="ml-12 font-mono text-[11px] text-ink-faint">
                                    {e.fields.join(", ")}
                                  </div>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {s.values && (
                        <div className="mt-1.5 text-sm">
                          {s.values.added.length > 0 && (
                            <div>
                              <span className="mr-2 font-mono text-[10px] uppercase text-verified">add</span>
                              <span className="text-ink">{s.values.added.join(", ")}</span>
                            </div>
                          )}
                          {s.values.removed.length > 0 && (
                            <div>
                              <span className="mr-2 font-mono text-[10px] uppercase text-signal">remove</span>
                              <span className="text-ink-faint line-through">{s.values.removed.join(", ")}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {(pending.diff.warnings.length > 0 || (pending.corrections?.length ?? 0) > 0) && (
                  <div className="mt-4 rounded border border-amber/40 bg-amber/5 p-3">
                    <div className="font-mono text-[11px] uppercase tracking-label text-amber">Heads up</div>
                    <ul className="mt-2 space-y-1 text-xs text-ink-dim">
                      {pending.corrections?.map((c, i) => <li key={"c" + i}>Overruled the model: {c}</li>)}
                      {pending.diff.warnings.map((w, i) => <li key={"w" + i}>{w}</li>)}
                    </ul>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button onClick={confirm} disabled={applying || changeCount(pending.diff) === 0} className="btn-primary">
                    {applying ? "Saving…" : "Apply these changes"}
                  </button>
                  <button onClick={() => setPending(null)} disabled={applying} className="btn-ghost">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
