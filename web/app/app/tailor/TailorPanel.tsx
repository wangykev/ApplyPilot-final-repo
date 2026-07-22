"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { WandSparkles, Printer, FileDown, AlertTriangle, ShieldCheck, Sparkles } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { TextAreaField } from "@/components/form/fields";
import { clsx } from "@/lib/clsx";
import { tailorResume, type JdApplication } from "./actions";
import type { TailorMode, TailoredResume } from "@/lib/tailor";
import { dateRange } from "@/lib/resume-doc";

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

export function TailorPanel({ apps }: { apps: JdApplication[] }) {
  const [jd, setJd] = useState("");
  const [appId, setAppId] = useState("");
  const [mode, setMode] = useState<TailorMode>("select");
  const [out, setOut] = useState<{ result: TailoredResume; tex: string; printHtml: string } | null>(null);
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
      if (res.ok) setOut({ result: res.result, tex: res.tex, printHtml: res.printHtml });
      else {
        setOut(null);
        setErr({ text: res.error, aiLink: res.error.toLowerCase().includes("api key") });
      }
    });

  const savePdf = () => {
    if (!out) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(out.printHtml);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250); // let fonts/layout settle before the dialog
  };

  const downloadTex = () => {
    if (!out) return;
    const blob = new Blob([out.tex], { type: "application/x-tex" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "resume-tailored.tex";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const r = out?.result ?? null;
  const review = useMemo(() => {
    if (!r) return { edited: 0, reverted: r ? 0 : 0, risks: 0 };
    let edited = 0,
      risks = 0;
    for (const e of r.experiences)
      for (const b of e.bullets) {
        if (b.edited) edited++;
        if (b.fabrication_risk) risks++;
      }
    return { edited, reverted: r.reverted_count, risks };
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
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={clsx(
                  "rounded-xl border p-4 text-left transition-colors",
                  active ? "border-amber bg-panel-raised" : "border-hairline hover:border-ink-faint"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={clsx("h-2 w-2 rounded-full", active ? "bg-amber" : "bg-ink-faint")} />
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

      {r && (
        <>
          <SectionCard
            title="Tailored resume"
            subtitle="Save as PDF opens the print dialog (choose “Save as PDF”). The .tex compiles in Overleaf with your exact template."
            actions={
              <div className="flex gap-2">
                <button onClick={savePdf} className="btn-ghost px-3 py-1.5 text-xs">
                  <Printer className="h-3.5 w-3.5" /> Save as PDF
                </button>
                <button onClick={downloadTex} className="btn-ghost px-3 py-1.5 text-xs">
                  <FileDown className="h-3.5 w-3.5" /> Download .tex
                </button>
              </div>
            }
          >
            {/* review strip */}
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

            {/* document preview — a light “paper” card inside the dark cockpit */}
            <div className="rounded-lg bg-white p-8 text-[13px] leading-relaxed text-neutral-900 shadow-inner">
              {r.summary && (
                <p className="mb-3 border-l-2 border-amber pl-2 italic">
                  {r.summary} <span className="not-italic text-[10px] text-amber">✦ AI summary — review</span>
                </p>
              )}
              {r.experiences
                .filter((e) => e.include && e.bullets.length)
                .map((e, i) => (
                  <div key={i} className="mb-3">
                    <div className="flex justify-between">
                      <span className="font-semibold">{e.company || e.job_title}</span>
                      <span className="text-xs text-neutral-500">{dateRange(e.from, e.to, e.currently_work_here)}</span>
                    </div>
                    <div className="text-xs italic text-neutral-600">{e.job_title}</div>
                    <ul className="ml-5 mt-1 list-disc space-y-0.5">
                      {e.bullets.map((b, j) => (
                        <li key={j} className={clsx(b.fabrication_risk ? "text-red-700" : b.edited ? "text-amber-800" : "")}>
                          {b.text}
                          {b.edited && <span className="ml-1 align-middle text-[10px] text-amber-600">✦</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              {r.skills.length > 0 && (
                <p className="mt-2 text-xs">
                  <span className="font-semibold">Skills:</span> {r.skills.join(", ")}
                </p>
              )}
            </div>
          </SectionCard>

          {(review.edited > 0 || review.risks > 0 || r.reverted_count > 0) && (
            <SectionCard title="What the AI changed" subtitle="Original vs tailored, per bullet. Reverted rewrites failed the deterministic fact-check.">
              <ul className="space-y-3">
                {r.experiences.flatMap((e, i) =>
                  e.bullets
                    .filter((b) => b.edited || b.violation || b.fabrication_risk)
                    .map((b, j) => (
                      <li key={`${i}-${j}`} className="rounded-lg border border-hairline bg-panel-raised p-3 text-sm">
                        <div className="mb-1 font-mono text-[10px] uppercase tracking-label text-ink-faint">
                          {e.company} · {e.job_title}
                        </div>
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
                    ))
                )}
              </ul>
            </SectionCard>
          )}

          {(r.gaps.length > 0 || r.skills_omitted.length > 0 || r.rationale) && (
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
