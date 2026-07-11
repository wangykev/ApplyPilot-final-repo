"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Sparkles, Copy, Check } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { TextField, TextAreaField } from "@/components/form/fields";
import { generateCoverLetter } from "./actions";
import { clsx } from "@/lib/clsx";

export function CoverLetterPanel({ initialCompany }: { initialCompany: string }) {
  const [company, setCompany] = useState(initialCompany);
  const [role, setRole] = useState("");
  const [jd, setJd] = useState("");
  const [letter, setLetter] = useState("");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<{ text: string; aiLink?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const words = letter.trim() ? letter.trim().split(/\s+/).length : 0;

  const generate = () =>
    startTransition(async () => {
      setErr(null);
      setCopied(false);
      const res = await generateCoverLetter({ company, role, jobDescription: jd });
      if (res.ok) setLetter(res.text);
      else setErr({ text: res.error, aiLink: res.error.toLowerCase().includes("api key") });
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(letter);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr({ text: "Couldn't copy — select the text and copy manually." });
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="The job"
        subtitle="Tailor the letter to a specific posting. Paste the description for the sharpest result — it's optional."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Company" value={company} placeholder="e.g. Comcast" onChange={setCompany} />
          <TextField label="Role" value={role} placeholder="e.g. Software Engineer" onChange={setRole} />
        </div>
        <div className="mt-4">
          <TextAreaField
            label="Job description"
            value={jd}
            rows={6}
            placeholder="Paste the posting here (optional)"
            onChange={setJd}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={generate} disabled={pending} className="btn-primary">
            <Sparkles className="h-4 w-4" />
            {pending ? "Writing…" : letter ? "Regenerate" : "Generate cover letter"}
          </button>
          <span className="font-mono text-[11px] tracking-label text-ink-faint">
            grounded only in your profile — review before you send
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

      {letter && (
        <SectionCard
          title="Draft"
          subtitle="Edit freely — it's yours. Copy it into the application."
          actions={
            <button onClick={copy} className="btn-ghost px-3 py-1.5 text-xs">
              {copied ? <Check className="h-3.5 w-3.5 text-verified" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          }
        >
          <textarea
            value={letter}
            onChange={(e) => setLetter(e.target.value)}
            rows={16}
            className="w-full resize-y rounded-lg border border-hairline bg-cockpit px-4 py-3 text-sm leading-relaxed text-ink outline-none transition-colors focus:border-amber"
          />
          <div className={clsx("mt-2 font-mono text-[11px] tracking-label", words > 380 ? "text-amber" : "text-ink-faint")}>
            {words} words
          </div>
        </SectionCard>
      )}
    </div>
  );
}
