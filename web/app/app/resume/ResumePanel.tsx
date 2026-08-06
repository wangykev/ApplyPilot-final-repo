"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { UploadCloud, FileText, Sparkles, Check, Trash2, ArrowRight } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { applyParsedProfile, removeResume } from "./actions";
import { liveSync } from "@/lib/extension-sync";
import type { Profile } from "@/lib/profile-schema";
import { clsx } from "@/lib/clsx";

type Stored = { filename: string; size: number } | null;
type Msg = { kind: "ok" | "err" | "info"; text: string; aiLink?: boolean } | null;

function kb(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function summarize(p: Profile): { label: string; n: number }[] {
  return [
    { label: "Roles", n: p.work_experience.length },
    { label: "Schools", n: p.education.length },
    { label: "Skills", n: p.skills.length },
    { label: "Links", n: p.websites.length },
    { label: "Languages", n: p.languages.length },
    { label: "Certifications", n: p.certifications.length },
  ].filter((x) => x.n > 0);
}

export function ResumePanel({
  initialStored,
  onStored,
  onNeedsAiKey,
  onOpenProfile,
}: {
  initialStored: Stored;
  /**
   * Fired whenever the stored resume changes (uploaded, replaced, removed). The setup flow
   * (/app/start) marks its resume step done off this instead of re-reading the backend.
   */
  onStored?: (stored: Stored) => void;
  /**
   * Parsing needs an AI key. On the Resume page a missing key is a LINK to /app/ai; inside
   * the setup flow that link would be bounced straight back by the gate, so the flow passes
   * a handler and gets a button that moves to its own key step instead.
   */
  onNeedsAiKey?: () => void;
  /**
   * Same reason as `onNeedsAiKey`: in the setup flow the profile is the NEXT STEP, not
   * another page, so "Open profile" advances the wizard rather than navigating away.
   */
  onOpenProfile?: () => void;
}) {
  const [stored, setStored] = useState<Stored>(initialStored);
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<Profile | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [uploading, setUploading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [applying, startApply] = useTransition();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(f: File) {
    if (!f.type.includes("pdf")) {
      setMsg({ kind: "err", text: "Please choose a PDF." });
      return;
    }
    setFile(f);
    setParsed(null);
    setMsg(null);
    // store it for the extension straight away
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/resume/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (j.ok) {
        setStored({ filename: f.name, size: f.size });
        onStored?.({ filename: f.name, size: f.size });
        setMsg({ kind: "ok", text: "Stored — ready to attach during applications." });
        liveSync("resume"); // push the new resume bytes to a connected extension
      } else {
        setMsg({ kind: "err", text: j.error ?? "Upload failed." });
      }
    } catch {
      setMsg({ kind: "err", text: "Upload failed — is the backend reachable?" });
    } finally {
      setUploading(false);
    }
  }

  async function parse() {
    if (!file) return;
    setParsing(true);
    setMsg(null);
    setParsed(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
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
      if (res.ok) liveSync("profile"); // the merged profile changed — push it to a connected extension
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
        onStored?.(null);
        setFile(null);
        setParsed(null);
        setMsg({ kind: "info", text: "Removed." });
        liveSync("resume-clear"); // clear the resume in a connected extension too
      } else {
        setMsg({ kind: "err", text: res.error });
      }
    });
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="Your resume"
        subtitle="One PDF. We store it so the extension can attach it to every application — no file picker per job."
        actions={
          stored ? (
            <button
              onClick={clear}
              disabled={applying}
              className="inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-signal"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </button>
          ) : null
        }
      >
        {stored && (
          <div className="mb-5 flex items-center gap-3 rounded-lg border border-hairline bg-panel-raised/50 p-3">
            <FileText className="h-5 w-5 text-verified" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink">{stored.filename}</div>
              <div className="font-mono text-[11px] text-ink-faint">{kb(stored.size)} · stored</div>
            </div>
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-label text-verified">
              <Check className="h-3.5 w-3.5" /> Ready
            </span>
          </div>
        )}

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
          className={clsx(
            "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center transition-colors",
            dragging ? "border-amber bg-amber/[0.06]" : "border-hairline hover:border-ink-dim"
          )}
        >
          <UploadCloud className={clsx("h-7 w-7", dragging ? "text-amber" : "text-ink-dim")} />
          <div className="text-sm text-ink">
            {uploading ? "Uploading…" : stored ? "Replace your resume" : "Drop your resume PDF here"}
          </div>
          <div className="font-mono text-[11px] text-ink-faint">PDF · up to 10 MB · click to browse</div>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = "";
            }}
          />
        </label>

        {msg && (
          <p
            className={clsx(
              "mt-4 text-sm",
              msg.kind === "ok" && "text-verified",
              msg.kind === "err" && "text-signal",
              msg.kind === "info" && "text-ink-dim"
            )}
          >
            {msg.text}
            {msg.aiLink &&
              (onNeedsAiKey ? (
                <>
                  {" "}
                  <button type="button" onClick={onNeedsAiKey} className="underline hover:text-amber">
                    Add your AI key →
                  </button>
                </>
              ) : (
                <>
                  {" "}
                  <Link href="/app/ai" className="underline hover:text-amber">
                    Configure AI →
                  </Link>
                </>
              ))}
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Parse with AI"
        subtitle="Pull your work history, education, and skills out of the PDF into your profile. Review before it's applied — nothing is committed silently."
      >
        <button
          onClick={parse}
          disabled={!file || parsing}
          className="btn-primary"
          title={!file ? "Choose a PDF above first" : undefined}
        >
          <Sparkles className="h-4 w-4" />
          {parsing ? "Reading your resume…" : "Parse with AI"}
        </button>
        {!file && (
          <p className="mt-3 text-xs text-ink-faint">
            Select a PDF above, then parse. Parsing uses your configured AI provider.
          </p>
        )}

        {parsed && (
          <div className="mt-6 rounded-lg border border-hairline bg-panel-raised/40 p-5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-verified" />
              <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">
                Found in your resume
              </span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {summarize(parsed).length === 0 && (
                <span className="text-sm text-ink-faint">No structured sections detected.</span>
              )}
              {summarize(parsed).map((s) => (
                <span
                  key={s.label}
                  className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-panel px-2.5 py-1 text-sm"
                >
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
              {onOpenProfile ? (
                <button
                  type="button"
                  onClick={onOpenProfile}
                  className="inline-flex items-center gap-1.5 text-sm text-ink-dim hover:text-amber"
                >
                  Open profile
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              ) : (
                <Link href="/app/profile" className="inline-flex items-center gap-1.5 text-sm text-ink-dim hover:text-amber">
                  Open profile
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              )}
              <span className="font-mono text-[11px] text-ink-faint">fills blank fields only — won&apos;t overwrite</span>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
