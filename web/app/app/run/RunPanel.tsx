"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Rocket, Loader2, Check, AlertTriangle, X, Cable, ChevronDown, ExternalLink } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { sendToExtension, extensionMessagingAvailable, type ExtResponse } from "@/lib/extension";
import { linkedExtensionId } from "@/lib/extension-sync";
import { saveRunJob } from "./actions";
import { clsx } from "@/lib/clsx";

type Jd = { title?: string; company?: string; text?: string; url?: string };
type Phase =
  | { s: "idle" }
  | { s: "running" }
  | { s: "done"; resp: ExtResponse; jd: Jd | null; appId: string | null };

type Outcome = { tone: "ok" | "warn" | "err"; headline: string; detail?: string };

// Friendly one-liners for the onboarding "needs operator" stops (from runCdpOnboard).
const ONBOARD_STOP: Record<string, string> = {
  sso: "This tenant uses SSO / federated login. Sign in manually in the tab, then run again — it detects the form and continues.",
  "no-credentials": "No sign-in credentials are loaded in the extension. Sign in manually in the tab, then run again.",
  "verification-required-gmail-off": "This tenant needs email verification but Gmail auto-verify is off. Click the link in the email yourself, then run again.",
  "verification-email-not-found": "Couldn't find the verification email. Check the inbox, click the link, then run again.",
  "verify-link-invalid": "The verification link was rejected — open it manually in this browser, then run again.",
  "hidden-render-stalled": "The sign-in form didn't render while the tab was in the background. Bring the tab to the front and run again.",
  "workday-maintenance": "Workday is in planned maintenance. Try again after the maintenance window.",
  "unknown-page": "Couldn't find an Apply / sign-in / form on that page. Make sure the link is the job posting.",
};

// Friendly one-liners for the fill-walk stops (from runCdpWalk).
const WALK_STOP: Record<string, string> = {
  "session-expired": "The Workday session expired mid-fill. Refresh + sign in in the tab, then run again.",
  "nav-timeout-dirty": "A page couldn't advance — usually a required field your profile has no value for. Open the tab and fill it in.",
  "resume-not-attached": "Your resume didn't attach. Upload one on the Resume page and re-sync, then run again.",
  "no-next-button": "Couldn't find the Save & Continue button on a page. Open the tab to check.",
  "workday-maintenance": "Workday went into maintenance during the fill. Try again later.",
  "max-pages-cap": "Hit the page-count backstop without reaching review. Eyeball the tab.",
};

function interpret(resp: ExtResponse): Outcome {
  // Extension messaging errors / crashes.
  if (resp.ok === false || resp.ok === undefined) {
    const err = String(resp.error ?? "");
    const detail = (resp.detail as string) || err || "The run couldn't start.";
    if (err === "no-profile") return { tone: "warn", headline: "Sync your profile first", detail };
    if (err === "bad-url") return { tone: "err", headline: "That doesn't look like a job link", detail };
    if (/port closed|message channel|Could'?nt reach|No response/i.test(err)) {
      return {
        tone: "warn",
        headline: "Lost contact with the extension",
        detail: "The run may still be going in its tab. Check the tab, and your Tracker for the result.",
      };
    }
    return { tone: "err", headline: "The run hit an error", detail };
  }

  // Reached the form but stopped before / instead of walking → needs a human.
  if (resp.needs_operator || !resp.walked) {
    const stopped = String(resp.stopped ?? "");
    return {
      tone: "warn",
      headline: "Needs you to step in",
      detail: ONBOARD_STOP[stopped] || (resp.detail as string) || (stopped ? `Stopped: ${stopped}` : "Stopped before the form."),
    };
  }

  // Walked the form.
  const walk = (resp.walk as ExtResponse) || {};
  const pages = typeof walk.pages_filled === "number" ? walk.pages_filled : undefined;
  if (walk.reached_review) {
    return {
      tone: "ok",
      headline: "Reached the review page",
      detail: `${pages != null ? `${pages} page${pages === 1 ? "" : "s"} filled. ` : ""}Nothing was submitted — review and approve when you're ready.`,
    };
  }
  const stopped = String(walk.stopped ?? "");
  return {
    tone: "warn",
    headline: "Stopped before review",
    detail:
      (WALK_STOP[stopped] || (stopped ? `Stopped: ${stopped}` : "The fill walk stopped early.")) +
      (pages != null ? ` (${pages} page${pages === 1 ? "" : "s"} filled)` : ""),
  };
}

export function RunPanel() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [showJd, setShowJd] = useState(false);

  useEffect(() => {
    setConnected(linkedExtensionId() !== null && extensionMessagingAvailable());
  }, []);

  const running = phase.s === "running";
  const validUrl = /^https?:\/\/\S+$/i.test(url.trim());

  async function run() {
    const startUrl = url.trim();
    if (!validUrl || running) return;
    const extId = linkedExtensionId();
    if (!extId || !extensionMessagingAvailable()) {
      setConnected(false);
      return;
    }
    setPhase({ s: "running" });

    const resp = await sendToExtension(extId, { type: "AP_RUN_APPLICATION", startUrl });

    // Save whatever the extension scraped to the tracker row for this posting.
    const jd = (resp.jd as Jd | null) ?? null;
    let appId: string | null = null;
    try {
      const saved = await saveRunJob({
        // Prefer the URL the extension actually reported the tracker row under (the form page after
        // Apply/login navigation) so the JD lands on that SAME row instead of a second empty one.
        url: (resp.reportedUrl as string) || startUrl,
        company: jd?.company,
        role: jd?.title,
        jobDescription: jd?.text,
      });
      if (saved.ok) appId = saved.id || null;
    } catch {
      /* non-fatal: the walk's own report also upserts this row */
    }

    setPhase({ s: "done", resp, jd, appId });
  }

  return (
    <div className="space-y-6">
      {connected === false && (
        <div className="flex items-start gap-3 rounded-lg border border-amber/30 bg-amber/[0.05] px-4 py-3 text-sm">
          <Cable className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <div>
            <p className="text-ink">Your extension isn&apos;t connected here.</p>
            <p className="mt-1 text-ink-dim">
              Open this in the Chrome profile where ApplyPilot is installed, then{" "}
              <Link href="/app/connect" className="text-amber hover:underline">
                connect it
              </Link>{" "}
              so Run can drive it.
            </p>
          </div>
        </div>
      )}

      <SectionCard
        title="Job link"
        subtitle="A Workday posting URL (myworkdayjobs.com). Run opens it in a new tab — keep that tab visible to watch it work."
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
            }}
            disabled={running}
            placeholder="https://company.wd5.myworkdayjobs.com/…/job/…/apply"
            className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber disabled:opacity-60"
          />
          <button
            onClick={run}
            disabled={!validUrl || running || connected === false}
            className="btn-primary shrink-0"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            {running ? "Running…" : "Run"}
          </button>
        </div>

        {running && (
          <p className="mt-4 text-xs leading-relaxed text-ink-dim">
            Working through Apply → sign-in → email verification → fill. This takes a minute or two — the
            tab shows Chrome&apos;s &ldquo;started debugging&rdquo; bar while the extension drives it. It will
            stop at the review page and never submit.
          </p>
        )}
      </SectionCard>

      {phase.s === "done" && <Result phase={phase} onShowJd={() => setShowJd((v) => !v)} showJd={showJd} />}
    </div>
  );
}

function Result({
  phase,
  showJd,
  onShowJd,
}: {
  phase: Extract<Phase, { s: "done" }>;
  showJd: boolean;
  onShowJd: () => void;
}) {
  const out = interpret(phase.resp);
  const jd = phase.jd;
  const tone =
    out.tone === "ok"
      ? { border: "border-verified/30", bg: "bg-verified/[0.05]", fg: "text-verified", Icon: Check }
      : out.tone === "warn"
        ? { border: "border-amber/30", bg: "bg-amber/[0.05]", fg: "text-amber", Icon: AlertTriangle }
        : { border: "border-signal/30", bg: "bg-signal/[0.05]", fg: "text-signal", Icon: X };

  return (
    <SectionCard title="Result">
      <div className={clsx("flex items-start gap-3 rounded-lg border px-4 py-3", tone.border, tone.bg)}>
        <tone.Icon className={clsx("mt-0.5 h-5 w-5 shrink-0", tone.fg)} />
        <div className="min-w-0">
          <p className={clsx("text-sm font-medium", tone.fg)}>{out.headline}</p>
          {out.detail && <p className="mt-1 text-sm leading-relaxed text-ink-dim">{out.detail}</p>}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link href={phase.appId ? `/app/tracker/${phase.appId}` : "/app/tracker"} className="btn-primary">
          <ExternalLink className="h-4 w-4" />
          {out.tone === "ok" ? "Review this application" : "Open in Tracker"}
        </Link>
        {jd?.company && (
          <span className="font-mono text-[11px] text-ink-dim">
            {jd.company}
            {jd.title ? ` · ${jd.title}` : ""}
          </span>
        )}
      </div>

      {jd?.text && (
        <div className="mt-5">
          <button
            type="button"
            onClick={onShowJd}
            className="inline-flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink"
          >
            <ChevronDown className={clsx("h-3.5 w-3.5 transition-transform", showJd && "rotate-180")} />
            Job description we captured ({jd.text.length.toLocaleString()} chars)
          </button>
          {showJd && (
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-cockpit p-3 text-xs leading-relaxed text-ink-dim">
              {jd.text}
            </pre>
          )}
        </div>
      )}
    </SectionCard>
  );
}
