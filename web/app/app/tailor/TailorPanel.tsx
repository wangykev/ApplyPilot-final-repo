"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { WandSparkles, Printer, FileDown, AlertTriangle, ShieldCheck, Sparkles } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { TextAreaField } from "@/components/form/fields";
import { clsx } from "@/lib/clsx";
import { tailorResume, type JdApplication } from "./actions";
import type { TailorMode, TailoredResume } from "@/lib/tailor";

/** The untailored resume (from the profile) + its exportable documents. */
export type OriginalResume = { resume: TailoredResume; printHtml: string; tex: string };

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

  const pickApp = (id: string) => {
    setAppId(id);
    const app = apps.find((a) => a.id === id);
    if (app) setJd(app.job_description);
  };

  const run = () =>
    startTransition(async () => {
      setErr(null);
      const res = await tailorResume({ jobDescription: jd, mode });
      if (res.ok) {
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

      {active && (
        <>
          <SectionCard
            title={showingOriginal ? "Your resume — original" : "Tailored resume"}
            subtitle={
              showingOriginal
                ? "Generated from your PROFILE data — not your uploaded PDF (that file attaches as-is; preview it on the Resume page). Formatting differs from your LaTeX; if content is missing here, your profile is missing it — parse your resume or edit the profile."
                : "Save as PDF opens the print dialog (choose “Save as PDF”). The .tex compiles in Overleaf with your exact template."
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
                <button onClick={savePdf} className="btn-ghost px-3 py-1.5 text-xs">
                  <Printer className="h-3.5 w-3.5" /> Save as PDF
                </button>
                <button onClick={downloadTex} className="btn-ghost px-3 py-1.5 text-xs">
                  <FileDown className="h-3.5 w-3.5" /> Download .tex
                </button>
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

            {/* document preview — the EXACT print document (what Save-as-PDF emits),
                full page: header, education, experience, projects, skills */}
            <iframe
              title={showingOriginal ? "Original resume" : "Tailored resume"}
              srcDoc={active.printHtml}
              sandbox=""
              className="h-[780px] w-full rounded-lg border border-hairline bg-white shadow-inner"
            />
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
