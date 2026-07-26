"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { FileText, Sparkles, Check, Trash2, ArrowRight, Eye, X, FileUp, FileCheck2, RefreshCw } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import {
  applyParsedProfile,
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
import { clsx } from "@/lib/clsx";

type Stored = { filename: string; size: number } | null;
type Msg = { kind: "ok" | "err" | "info"; text: string; aiLink?: boolean } | null;

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

export function ResumePanel({ initialStored, initialSource }: { initialStored: Stored; initialSource: ResumeSource | null }) {
  const [stored, setStored] = useState<Stored>(initialStored);
  const [msg, setMsg] = useState<Msg>(null);
  const [parsed, setParsed] = useState<Profile | null>(null);
  const [parsing, setParsing] = useState(false);
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

  function save() {
    if (!compiled) return;
    startApply(async () => {
      if (tab === "tex" && texText.trim()) {
        const s = await saveResumeSourceTex({ filename: texName || "resume.tex", tex: texText });
        if (s.ok) setSourceSaved(true);
      }
      const res = await saveCompiledResume({ pdfBase64: compiled.base64, pdfName });
      if (res.ok) {
        setStored({ filename: res.filename, size: res.size });
        setPdfName(res.filename);
        setMsg({ kind: "ok", text: `Saved ${res.filename} — this is what gets attached to applications.` });
        liveSync("resume");
      } else {
        setMsg({ kind: "err", text: res.error });
      }
    });
  }

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

  function apply() {
    if (!parsed) return;
    startApply(async () => {
      const res = await applyParsedProfile(parsed);
      if (res.ok) liveSync("profile");
      setMsg(
        res.ok
          ? { kind: "ok", text: "Applied to your profile (filled blanks). Review it on the Profile page." }
          : { kind: "err", text: res.error }
      );
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

        {/* generated-PDF name + save */}
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
          <button onClick={save} disabled={!compiled || applying || compiling} className="btn-primary">
            <FileCheck2 className="h-4 w-4" />
            {applying ? "Saving…" : "Save as my resume"}
          </button>
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
        subtitle="The saved PDF the extension uploads on every application."
        actions={
          stored ? (
            <button onClick={clear} disabled={applying} className="inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-signal">
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </button>
          ) : null
        }
      >
        {stored ? (
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
          <p className="text-sm text-ink-dim">Nothing stored yet — compile above and “Save as my resume”.</p>
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
              <button onClick={apply} disabled={applying} className="btn-primary">
                {applying ? "Applying…" : "Apply to my profile"}
              </button>
              <Link href="/app/profile" className="inline-flex items-center gap-1.5 text-sm text-ink-dim hover:text-amber">
                Open profile
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <span className="font-mono text-[11px] text-ink-faint">fills blank fields only — won&apos;t overwrite</span>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
