"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Gauge, CheckCircle2, AlertTriangle } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { TextAreaField } from "@/components/form/fields";
import { clsx } from "@/lib/clsx";
import { scoreMatch, type ScoreActionResult } from "./actions";
import type { JdApplication } from "@/app/app/tailor/actions";
import type { ScoreResult, Verdict } from "@/lib/score";

const VERDICT: Record<Verdict, { label: string; cls: string; dot: string }> = {
  strong: { label: "Strong match — worth applying", cls: "border-verified/40 text-verified", dot: "bg-verified" },
  moderate: { label: "Moderate — worth a look", cls: "border-amber/40 text-amber", dot: "bg-amber" },
  weak: { label: "Weak — probably skip", cls: "border-signal/40 text-signal", dot: "bg-signal" },
};

export function MatchPanel({ apps = [] }: { apps?: JdApplication[] }) {
  const [jd, setJd] = useState("");
  const [appId, setAppId] = useState("");
  const [result, setResult] = useState<ScoreResult | null>(null);
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
      const res: ScoreActionResult = await scoreMatch({ jobDescription: jd });
      if (res.ok) setResult(res.result);
      else {
        setResult(null);
        setErr({ text: res.error, aiLink: res.error.toLowerCase().includes("api key") });
      }
    });

  const v = result?.verdict ? VERDICT[result.verdict] : null;

  return (
    <div className="space-y-6">
      <SectionCard
        title="The job"
        subtitle="Paste the posting — ApplyPilot grades how well your profile fits, so you can decide whether it's worth your time."
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
        <TextAreaField
          label="Job description"
          value={jd}
          rows={8}
          placeholder="Paste the full job posting here"
          onChange={setJd}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={run} disabled={pending} className="btn-primary">
            <Gauge className="h-4 w-4" />
            {pending ? "Scoring…" : result ? "Re-score" : "Score this job"}
          </button>
          <span className="font-mono text-[11px] tracking-label text-ink-faint">
            uses your AI key · graded against your profile only
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

      {result && result.score != null && v && (
        <SectionCard
          title="Fit score"
          subtitle="A quick read on this role — a signal to help you prioritize, not a decision."
        >
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex items-baseline gap-1">
              <span className="font-display text-5xl font-semibold text-ink">{result.score}</span>
              <span className="font-mono text-lg text-ink-dim">/10</span>
            </div>
            <span className={clsx("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm", v.cls)}>
              <span className={clsx("h-2 w-2 rounded-full", v.dot)} />
              {v.label}
            </span>
          </div>

          {result.rationale && <p className="mt-4 text-sm leading-relaxed text-ink-dim">{result.rationale}</p>}

          <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
            {result.matched_requirements.length > 0 && (
              <div>
                <h3 className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-label text-verified">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Matches
                </h3>
                <ul className="space-y-1.5 text-sm text-ink">
                  {result.matched_requirements.map((m, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 text-verified">✓</span>
                      <span>{m}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.gaps.length > 0 && (
              <div>
                <h3 className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-label text-amber">
                  <AlertTriangle className="h-3.5 w-3.5" /> Gaps
                </h3>
                <ul className="space-y-1.5 text-sm text-ink">
                  {result.gaps.map((g, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 text-amber">!</span>
                      <span>{g}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {result.keywords.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-label text-ink-dim">ATS keywords</h3>
              <ul className="flex flex-wrap gap-2">
                {result.keywords.map((k, i) => (
                  <li
                    key={i}
                    className="rounded-md border border-hairline bg-panel-raised px-2 py-1 font-mono text-xs text-ink-dim"
                  >
                    {k}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}
