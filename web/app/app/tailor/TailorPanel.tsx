"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { WandSparkles, Printer, FileDown, FileCheck2, FileUp, X, AlertTriangle, ShieldCheck, Sparkles } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { TextAreaField } from "@/components/form/fields";
import { clsx } from "@/lib/clsx";
import { tailorResume, tailorResumeTex, compileLatexPdf, type JdApplication } from "./actions";
import type { TailorMode, TailoredResume } from "@/lib/tailor";
import type { TexTailorResult } from "@/lib/tex-tailor";

const TEX_LS_KEY = "applypilot.tailor.tex";
const TEX_NAME_LS_KEY = "applypilot.tailor.texName";

/** The "Original" view: the uploaded PDF when one is stored (`uploadedUrl` — the
 *  REAL original), plus the profile-generated rendition + exports as fallback. */
export type OriginalResume = { resume: TailoredResume; printHtml: string; tex: string; uploadedUrl?: string | null };

const MODES: { id: TailorMode; name: string; blurb: string; guard: string }[] = [
  {
    id: "select",
    name: "Select only",
    blurb: "Picks and reorders your existing bullets and skills to fit the JD. Nothing is reworded.",
    guard: "Safest — your words, verbatim. Fabrication impossible by construction.",
  },
  {
    id: "rewrite-surface",
    name: "Select + reword",
    blurb: "Same selection, plus wording is tuned toward the JD's language. Facts stay locked.",
    guard: "A fact-check reverts any rewrite that invents a number or a technology you never used.",
  },
  {
    id: "rewrite-full",
    name: "Full rewrite",
    blurb: "Rewrites your bullets aggressively to mirror the JD, like the big resume tools do.",
    guard: "Loudest flags — every bullet is AI-written; review each one before you use it.",
  },
];

export function TailorPanel({ apps, original }: { apps: JdApplication[]; original: OriginalResume | null }) {
  const [jd, setJd] = useState("");
  const [appId, setAppId] = useState("");
  const [mode, setMode] = useState<TailorMode>("select");
  const [out, setOut] = useState<{ result: TailoredResume; tex: string; printHtml: string } | null>(null);
  const [view, setView] = useState<"tailored" | "original">("tailored");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<{ text: string; aiLink?: boolean } | null>(null);
  // The compiled LaTeX PDF of the TAILORED resume (blob URL) — the exact template.
  const [latexPdf, setLatexPdf] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState<string | null>(null);
  // RESUME-FIRST source: the user's actual .tex (kept on this device) + its tailoring result.
  const [texSrc, setTexSrc] = useState<string | null>(null);
  const [texName, setTexName] = useState<string>("");
  const [texOut, setTexOut] = useState<TexTailorResult | null>(null);
  // Measured page fit (compile-and-revert loop): pages vs the original's count.
  const [fitInfo, setFitInfo] = useState<{ pages: number | null; basePages: number | null; lengthReverts: number } | null>(null);

  useEffect(() => {
    try {
      const t = localStorage.getItem(TEX_LS_KEY);
      if (t) {
        setTexSrc(t);
        setTexName(localStorage.getItem(TEX_NAME_LS_KEY) || "resume.tex");
      }
    } catch {
      /* private mode etc. */
    }
  }, []);

  async function onTexFile(f: File) {
    const text = await f.text();
    setTexSrc(text);
    setTexName(f.name);
    setTexOut(null);
    try {
      localStorage.setItem(TEX_LS_KEY, text);
      localStorage.setItem(TEX_NAME_LS_KEY, f.name);
    } catch {
      /* too big / private mode — session-only then */
    }
  }

  function clearTex() {
    setTexSrc(null);
    setTexName("");
    setTexOut(null);
    try {
      localStorage.removeItem(TEX_LS_KEY);
      localStorage.removeItem(TEX_NAME_LS_KEY);
    } catch {
      /* noop */
    }
  }

  async function compileFrom(tex: string) {
    setCompiling(true);
    setCompileErr(null);
    const res = await compileLatexPdf({ tex });
    setCompiling(false);
    if (!res.ok) {
      setCompileErr(res.error);
      return;
    }
    const bytes = Uint8Array.from(atob(res.pdfBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setLatexPdf((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  }

  const compilePdf = () => out && compileFrom(out.tex);

  const pickApp = (id: string) => {
    setAppId(id);
    const app = apps.find((a) => a.id === id);
    if (app) setJd(app.job_description);
  };

  const run = () =>
    startTransition(async () => {
      setErr(null);
      setCompileErr(null);
      setLatexPdf((prev) => {
        if (prev) URL.revokeObjectURL(prev); // stale compile of the previous tailoring
        return null;
      });

      if (texSrc) {
        // RESUME-FIRST: edit the actual .tex; profile is not involved.
        setOut(null);
        const res = await tailorResumeTex({ jobDescription: jd, mode, tex: texSrc });
        if (res.ok) {
          setTexOut(res.result);
          setFitInfo({ pages: res.pages ?? null, basePages: res.basePages ?? null, lengthReverts: res.length_reverts ?? 0 });
          if (res.pdfBase64) {
            // server already compiled the page-fitted document — show it directly
            const bytes = Uint8Array.from(atob(res.pdfBase64), (c) => c.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
            setLatexPdf((prev) => {
              if (prev) URL.revokeObjectURL(prev);
              return url;
            });
          } else {
            void compileFrom(res.result.tex); // no engine on the server path — fallback surfaces the hint
          }
        } else {
          setTexOut(null);
          setFitInfo(null);
          setErr({ text: res.error, aiLink: res.error.toLowerCase().includes("api key") });
        }
        return;
      }

      const res = await tailorResume({ jobDescription: jd, mode });
      if (res.ok) {
        setTexOut(null);
        setOut({ result: res.result, tex: res.tex, printHtml: res.printHtml });
        setView("tailored");
      } else {
        setOut(null);
        setErr({ text: res.error, aiLink: res.error.toLowerCase().includes("api key") });
      }
    });

  // Which resume the preview card shows + which documents the export buttons emit.
  const showingOriginal = (view === "original" && !!original) || (!out && !!original);
  const active = showingOriginal
    ? original && { r: original.resume, printHtml: original.printHtml, tex: original.tex, name: "resume-original" }
    : out && { r: out.result, printHtml: out.printHtml, tex: out.tex, name: "resume-tailored" };

  const savePdf = () => {
    if (!active) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(active.printHtml);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250); // let fonts/layout settle before the dialog
  };

  const downloadTex = () => {
    if (!active) return;
    const blob = new Blob([active.tex], { type: "application/x-tex" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = active.name + ".tex";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const r = out?.result ?? null;
  const review = useMemo(() => {
    if (!r) return { edited: 0, reverted: 0, risks: 0 };
    let edited = 0,
      risks = 0;
    for (const sec of [...r.experiences, ...r.projects])
      for (const b of sec.bullets) {
        if (b.edited) edited++;
        if (b.fabrication_risk) risks++;
      }
    return { edited, reverted: r.reverted_count, risks };
  }, [r]);

  // The per-bullet diff rows: experiences + projects, labeled by their section.
  const changedRows = useMemo(() => {
    if (!r) return [];
    const rows: { label: string; b: (typeof r.experiences)[number]["bullets"][number] }[] = [];
    for (const e of r.experiences)
      for (const b of e.bullets)
        if (b.edited || b.violation || b.fabrication_risk) rows.push({ label: `${e.company} · ${e.job_title}`, b });
    for (const p of r.projects)
      for (const b of p.bullets)
        if (b.edited || b.violation || b.fabrication_risk) rows.push({ label: `Project · ${p.name}`, b });
    return rows;
  }, [r]);

  return (
    <div className="space-y-6">
      <SectionCard
        title="The job"
        subtitle="Pick a tracked application (Run captures its posting automatically) or paste the description."
      >
        {apps.length > 0 && (
          <label className="mb-4 block">
            <span className="font-mono text-[10px] uppercase tracking-label text-ink-dim">
              From a tracked application
            </span>
            <select
              value={appId}
              onChange={(e) => pickApp(e.target.value)}
              className="mt-1.5 w-full appearance-none rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-amber"
            >
              <option value="">Paste manually…</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id} className="bg-panel">
                  {[a.company, a.role].filter(Boolean).join(" — ") || a.url}
                </option>
              ))}
            </select>
          </label>
        )}
        <TextAreaField label="Job description" value={jd} rows={7} placeholder="Paste the full job posting here" onChange={setJd} />
      </SectionCard>

      <SectionCard
        title="Resume source"
        subtitle="Best: upload your resume's .tex — tailoring edits ITS bullets and leaves every other line of your document byte-identical. Without it, the resume is rebuilt from your profile data."
      >
        {texSrc ? (
          <div className="flex items-center gap-3 rounded-lg border border-hairline bg-panel-raised/50 p-3">
            <FileCheck2 className="h-5 w-5 shrink-0 text-verified" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink">{texName}</div>
              <div className="font-mono text-[11px] text-ink-faint">
                your .tex is the base — only bullet lines can change (kept on this device)
              </div>
            </div>
            <button
              onClick={clearTex}
              className="inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-signal"
              title="Remove — fall back to profile-based tailoring"
            >
              <X className="h-3.5 w-3.5" /> Remove
            </button>
          </div>
        ) : (
          <>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-hairline px-4 py-3 text-sm text-ink-dim transition-colors hover:border-amber hover:text-ink">
              <FileUp className="h-4 w-4" />
              Upload your resume .tex
              <input
                type="file"
                accept=".tex,text/x-tex,application/x-tex"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) onTexFile(f);
                }}
              />
            </label>
            <p className="mt-3 flex items-start gap-2 text-sm text-amber">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              No .tex uploaded — tailoring will REBUILD a resume from your profile data, and it will NOT look
              like your real resume (sections your profile doesn&apos;t model are lost). Upload the .tex to
              tailor your actual document.
            </p>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="Tailoring mode"
        subtitle="Three levels, escalating from safest to most aggressive. Every AI change is shown for review — never silent."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {MODES.map((m) => {
            const activeMode = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={clsx(
                  "rounded-xl border p-4 text-left transition-colors",
                  activeMode ? "border-amber bg-panel-raised" : "border-hairline hover:border-ink-faint"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={clsx("h-2 w-2 rounded-full", activeMode ? "bg-amber" : "bg-ink-faint")} />
                  <span className="font-display text-sm font-medium">{m.name}</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-ink-dim">{m.blurb}</p>
                <p className={clsx("mt-2 text-[11px] leading-relaxed", m.id === "rewrite-full" ? "text-amber" : "text-ink-faint")}>
                  {m.guard}
                </p>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={run} disabled={pending} className="btn-primary">
            <WandSparkles className="h-4 w-4" />
            {pending ? "Tailoring…" : out ? "Re-tailor" : "Tailor my resume"}
          </button>
          <span className="font-mono text-[11px] tracking-label text-ink-faint">
            uses your AI key · structure, dates &amp; education never change
          </span>
          {err && (
            <span className="text-sm text-signal">
              {err.text}
              {err.aiLink && (
                <>
                  {" "}
                  <Link href="/app/ai" className="underline hover:text-amber">
                    Configure AI →
                  </Link>
                </>
              )}
            </span>
          )}
        </div>
      </SectionCard>

      {texOut && (
        <>
          <SectionCard
            title="Tailored resume — your .tex, edited"
            subtitle="Only bullet lines changed; the rest of your document is byte-identical. The preview is the compiled PDF."
            actions={
              <div className="flex items-center gap-2">
                {latexPdf && (
                  <a href={latexPdf} download="resume-tailored.pdf" className="btn-ghost px-3 py-1.5 text-xs text-verified">
                    <FileCheck2 className="h-3.5 w-3.5" /> Download PDF
                  </a>
                )}
                <button
                  onClick={() => {
                    const blob = new Blob([texOut.tex], { type: "application/x-tex" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = "resume-tailored.tex";
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                  className="btn-ghost px-3 py-1.5 text-xs"
                >
                  <FileDown className="h-3.5 w-3.5" /> Download .tex
                </button>
              </div>
            }
          >
            <div className="mb-4 flex flex-wrap gap-2 font-mono text-[11px]">
              <span className="rounded-md border border-hairline px-2 py-1 text-ink-dim">mode: {mode}</span>
              {(() => {
                const replaced = texOut.records.filter((x) => x.action === "replaced").length;
                const dropped = texOut.records.filter((x) => x.action === "dropped").length;
                const risks = texOut.records.filter((x) => x.fabrication_risk).length;
                return (
                  <>
                    {replaced > 0 && <span className="rounded-md border border-amber/40 px-2 py-1 text-amber">{replaced} AI-reworded</span>}
                    {dropped > 0 && <span className="rounded-md border border-hairline px-2 py-1 text-ink-dim">{dropped} dropped</span>}
                    {texOut.reverted_count > 0 && (
                      <span className="rounded-md border border-verified/40 px-2 py-1 text-verified">
                        {texOut.reverted_count} rewrite{texOut.reverted_count === 1 ? "" : "s"} reverted by the fact-check
                      </span>
                    )}
                    {fitInfo?.pages != null && fitInfo.basePages != null && (
                      <span
                        className={clsx(
                          "rounded-md border px-2 py-1",
                          fitInfo.pages <= fitInfo.basePages ? "border-verified/40 text-verified" : "border-signal/40 text-signal"
                        )}
                      >
                        {fitInfo.pages} page{fitInfo.pages === 1 ? "" : "s"} — {fitInfo.pages <= fitInfo.basePages ? "fits your original" : `original is ${fitInfo.basePages}`}
                      </span>
                    )}
                    {(fitInfo?.lengthReverts ?? 0) > 0 && (
                      <span className="rounded-md border border-amber/40 px-2 py-1 text-amber">
                        {fitInfo!.lengthReverts} reverted to fit the page
                      </span>
                    )}
                    {risks > 0 && (
                      <span className="rounded-md border border-signal/40 px-2 py-1 text-signal">{risks} fabrication risk{risks === 1 ? "" : "s"} — verify below</span>
                    )}
                  </>
                );
              })()}
            </div>
            {compileErr && <p className="mb-3 text-sm text-signal">{compileErr}</p>}
            {latexPdf ? (
              <iframe title="Tailored resume (LaTeX PDF)" src={latexPdf} className="h-[780px] w-full rounded-lg border border-hairline bg-white shadow-inner" />
            ) : (
              <div className="flex h-40 items-center justify-center rounded-lg border border-hairline text-sm text-ink-dim">
                {compiling ? "Compiling your LaTeX…" : "Compile pending"}
              </div>
            )}
          </SectionCard>

          {texOut.records.some((x) => x.action !== "kept" || x.violation || x.fabrication_risk) && (
            <SectionCard title="What the AI changed" subtitle="Per bullet: was vs now. Reverted rewrites failed the deterministic fact-check.">
              <ul className="space-y-3">
                {texOut.records
                  .filter((x) => x.action !== "kept" || x.violation || x.fabrication_risk)
                  .map((x) => (
                    <li key={x.id} className="rounded-lg border border-hairline bg-panel-raised p-3 text-sm">
                      <div className="mb-1 font-mono text-[10px] uppercase tracking-label text-ink-faint">{x.context || x.id}</div>
                      <p className="text-ink-dim">
                        <span className="font-mono text-[10px] text-ink-faint">was&nbsp;&nbsp;</span>
                        {x.was}
                      </p>
                      {x.action === "dropped" ? (
                        <p className="mt-1 font-mono text-[11px] text-ink-dim">dropped for this job</p>
                      ) : (
                        <p className={clsx("mt-1", x.fabrication_risk ? "text-signal" : x.violation ? "text-ink" : "text-amber")}>
                          <span className="font-mono text-[10px] text-ink-faint">now&nbsp;</span>
                          {x.now}
                        </p>
                      )}
                      {x.violation && (
                        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-verified">
                          <ShieldCheck className="h-3.5 w-3.5" /> rewrite reverted — {x.violation}
                        </p>
                      )}
                      {x.fabrication_risk && (
                        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-signal">
                          <AlertTriangle className="h-3.5 w-3.5" /> {x.fabrication_risk}
                        </p>
                      )}
                    </li>
                  ))}
              </ul>
            </SectionCard>
          )}

          {(texOut.gaps.length > 0 || texOut.rationale) && (
            <SectionCard title="Honest read" subtitle="What this job asks for that your resume can't claim — surfaced, never papered over.">
              {texOut.gaps.length > 0 && (
                <ul className="space-y-1.5 text-sm text-ink">
                  {texOut.gaps.map((g, i) => (
                    <li key={i} className="flex gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" />
                      <span>{g}</span>
                    </li>
                  ))}
                </ul>
              )}
              {texOut.rationale && (
                <p className="mt-3 flex gap-2 text-xs leading-relaxed text-ink-dim">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  {texOut.rationale}
                </p>
              )}
            </SectionCard>
          )}
        </>
      )}

      {active && (
        <>
          <SectionCard
            title={showingOriginal ? "Your resume — original" : "Tailored resume"}
            subtitle={
              showingOriginal
                ? original?.uploadedUrl
                  ? "Your uploaded PDF — exactly what gets attached to applications. Tailoring rebuilds the document from your PROFILE data, so the tailored version's layout will differ from this file."
                  : "Generated from your PROFILE data — no uploaded PDF stored (upload one on the Resume page to see the real file here). If content is missing, your profile is missing it — parse your resume or edit the profile."
                : "“LaTeX PDF” compiles your tailored resume in your EXACT sb2nov template (needs the local engine — see .env.example). Quick PDF is the plain print-dialog fallback; the .tex opens in Overleaf."
            }
            actions={
              <div className="flex items-center gap-2">
                {out && original && (
                  <div className="mr-1 flex overflow-hidden rounded-lg border border-hairline">
                    {(["tailored", "original"] as const).map((v, idx) => (
                      <button
                        key={v}
                        onClick={() => setView(v)}
                        className={clsx(
                          "px-3 py-1.5 text-xs capitalize transition-colors",
                          idx === 0 && "border-r border-hairline",
                          view === v
                            ? "bg-amber font-semibold text-cockpit"
                            : "text-ink-dim hover:bg-panel-raised/60 hover:text-ink"
                        )}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                )}
                {/* export buttons only for the GENERATED documents — the uploaded PDF
                    is already a file (the browser's PDF viewer has its own download) */}
                {!(showingOriginal && original?.uploadedUrl) && (
                  <>
                    {!showingOriginal &&
                      (latexPdf ? (
                        <a href={latexPdf} download="resume-tailored.pdf" className="btn-ghost px-3 py-1.5 text-xs text-verified">
                          <FileCheck2 className="h-3.5 w-3.5" /> Download PDF
                        </a>
                      ) : (
                        <button onClick={compilePdf} disabled={compiling} className="btn-ghost px-3 py-1.5 text-xs">
                          <FileCheck2 className="h-3.5 w-3.5" /> {compiling ? "Compiling…" : "LaTeX PDF (your template)"}
                        </button>
                      ))}
                    <button onClick={savePdf} className="btn-ghost px-3 py-1.5 text-xs">
                      <Printer className="h-3.5 w-3.5" /> Quick PDF
                    </button>
                    <button onClick={downloadTex} className="btn-ghost px-3 py-1.5 text-xs">
                      <FileDown className="h-3.5 w-3.5" /> Download .tex
                    </button>
                  </>
                )}
              </div>
            }
          >
            {/* review strip — tailored view only */}
            {!showingOriginal && r && (
              <div className="mb-4 flex flex-wrap gap-2 font-mono text-[11px]">
                <span className="rounded-md border border-hairline px-2 py-1 text-ink-dim">mode: {r.mode}</span>
                {review.edited > 0 && (
                  <span className="rounded-md border border-amber/40 px-2 py-1 text-amber">{review.edited} AI-reworded</span>
                )}
                {review.reverted > 0 && (
                  <span className="rounded-md border border-verified/40 px-2 py-1 text-verified">
                    {review.reverted} rewrite{review.reverted === 1 ? "" : "s"} reverted by the fact-check
                  </span>
                )}
                {review.risks > 0 && (
                  <span className="rounded-md border border-signal/40 px-2 py-1 text-signal">
                    {review.risks} fabrication risk{review.risks === 1 ? "" : "s"} — verify below
                  </span>
                )}
              </div>
            )}

            {compileErr && !showingOriginal && (
              <p className="mb-3 text-sm text-signal">{compileErr}</p>
            )}
            {/* Original + PDF stored → the ACTUAL uploaded file. Tailored + compiled →
                the LaTeX PDF (exact template). Otherwise the print document (what
                Quick-PDF emits). PDF iframes are unsandboxed — the viewer needs scripts. */}
            {showingOriginal && original?.uploadedUrl ? (
              <iframe
                title="Uploaded resume PDF"
                src={original.uploadedUrl}
                className="h-[780px] w-full rounded-lg border border-hairline bg-white shadow-inner"
              />
            ) : !showingOriginal && latexPdf ? (
              <iframe
                title="Tailored resume (LaTeX PDF)"
                src={latexPdf}
                className="h-[780px] w-full rounded-lg border border-hairline bg-white shadow-inner"
              />
            ) : (
              <iframe
                title={showingOriginal ? "Original resume" : "Tailored resume"}
                srcDoc={active.printHtml}
                sandbox=""
                className="h-[780px] w-full rounded-lg border border-hairline bg-white shadow-inner"
              />
            )}
            {!showingOriginal && (review.edited > 0 || review.risks > 0) && (
              <p className="mt-2 font-mono text-[11px] tracking-label text-ink-faint">
                the preview is the exact PDF — AI-changed bullets are itemized below
              </p>
            )}
          </SectionCard>

          {!showingOriginal && r && changedRows.length > 0 && (
            <SectionCard title="What the AI changed" subtitle="Original vs tailored, per bullet — experiences and projects. Reverted rewrites failed the deterministic fact-check.">
              <ul className="space-y-3">
                {changedRows.map(({ label, b }, i) => (
                  <li key={i} className="rounded-lg border border-hairline bg-panel-raised p-3 text-sm">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-label text-ink-faint">{label}</div>
                    {b.source_text && (
                      <p className="text-ink-dim">
                        <span className="font-mono text-[10px] text-ink-faint">was&nbsp;&nbsp;</span>
                        {b.source_text}
                      </p>
                    )}
                    <p className={clsx("mt-1", b.fabrication_risk ? "text-signal" : b.violation ? "text-ink" : "text-amber")}>
                      <span className="font-mono text-[10px] text-ink-faint">now&nbsp;</span>
                      {b.text}
                    </p>
                    {b.violation && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-verified">
                        <ShieldCheck className="h-3.5 w-3.5" /> rewrite reverted — {b.violation}
                      </p>
                    )}
                    {b.fabrication_risk && (
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-signal">
                        <AlertTriangle className="h-3.5 w-3.5" /> {b.fabrication_risk}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {!showingOriginal && r && (r.gaps.length > 0 || r.skills_omitted.length > 0 || r.rationale) && (
            <SectionCard title="Honest read" subtitle="What this job asks for that your background can't claim — surfaced, never papered over.">
              {r.gaps.length > 0 && (
                <ul className="space-y-1.5 text-sm text-ink">
                  {r.gaps.map((g, i) => (
                    <li key={i} className="flex gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" />
                      <span>{g}</span>
                    </li>
                  ))}
                </ul>
              )}
              {r.skills_omitted.length > 0 && (
                <p className="mt-3 text-xs text-ink-dim">
                  <span className="font-mono text-[10px] uppercase tracking-label">left off:</span> {r.skills_omitted.join(", ")}
                </p>
              )}
              {r.rationale && (
                <p className="mt-3 flex gap-2 text-xs leading-relaxed text-ink-dim">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  {r.rationale}
                </p>
              )}
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}
