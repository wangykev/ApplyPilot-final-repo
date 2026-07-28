"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Rocket, Loader2, Check, AlertTriangle, X, Cable, ChevronDown, ExternalLink, EyeOff, Send, ShieldCheck } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { sendToExtension, extensionMessagingAvailable, openRunProgressPort, type ExtResponse, type RunProgress } from "@/lib/extension";
import { linkedExtensionId } from "@/lib/extension-sync";
import { saveRunJob, saveRunSubmit, type RunLogin } from "./actions";
import { clsx } from "@/lib/clsx";

type Jd = { title?: string; company?: string; text?: string; url?: string };
type Phase =
  | { s: "idle" }
  | { s: "running"; background: boolean }
  | { s: "done"; resp: ExtResponse; jd: Jd | null; appId: string | null };

// A submit run is a separate phase from a fill run — they can't overlap (one form, one tab), but the
// panel reports them separately so a submit outcome never overwrites the fill result you just read.
type SubmitPhase =
  | { s: "idle" }
  | { s: "running"; armed: boolean }
  | { s: "done"; resp: ExtResponse; armed: boolean; appId: string | null };

type Outcome = { tone: "ok" | "warn" | "err"; headline: string; detail?: string; blockers?: string[] };

// Friendly one-liners for the onboarding "needs operator" stops (from runCdpOnboard).
const ONBOARD_STOP: Record<string, string> = {
  sso: "This tenant uses SSO / federated login. Sign in manually in the tab, then run again — it detects the form and continues.",
  "no-credentials": "No sign-in credentials are loaded in the extension. Sign in manually in the tab, then run again.",
  "verification-required-gmail-off": "This tenant needs email verification but Gmail auto-verify is off. Click the link in the email yourself, then run again.",
  "verification-email-not-found": "Couldn't find the verification email. Check the inbox, click the link, then run again.",
  "verify-link-invalid": "The verification link was rejected — open it manually in this browser, then run again.",
  "hidden-render-stalled": "The sign-in form didn't render while the tab was in the background. Bring the tab to the front and run again.",
  "auth-form-not-rendered": "The sign-in fields never appeared on the auth screen. If you ran this in the background, it's usually a slow repaint — run it in the foreground and try again.",
  "blank-page-after-signin": "Workday kept returning a blank page after signing in — it does this occasionally. Refresh the tab and run again.",
  "password-breach-dialog": "Chrome is blocking sign-in with a “password found in a data breach” warning. Dismiss it in the tab — or use a unique Workday password (the Credentials page enforces a strong one), or turn off Chrome’s breach warning — then run again.",
  "workday-maintenance": "Workday is in planned maintenance. Try again after the maintenance window.",
  "unknown-page": "Couldn't find an Apply / sign-in / form on that page. Make sure the link is the job posting.",
  "already-applied": "You've already applied to this job — Workday won't reopen the application, so there's nothing to fill.",
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

  // Already applied — a clean terminal state (you applied before), not an error or a to-do.
  if (resp.already_applied) {
    return {
      tone: "ok",
      headline: "You've already applied to this job",
      detail: (resp.detail as string) || ONBOARD_STOP["already-applied"],
    };
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

// Friendly one-liners for the REPLAY-walk stops (from runCdpReplayWalk). A replay halts instead of
// guessing, so most of these mean "the form changed since you approved it" — re-fill and re-approve.
const REPLAY_STOP: Record<string, string> = {
  "replay-mismatch":
    "A value you approved isn't offered by the form any more, so it stopped rather than guess. Re-run the fill for this job, then review and approve again.",
  "replay-blocked":
    "A page wouldn't advance — usually a required field that appeared after another answer and so was never part of your approved review. Open the tab, then re-fill and re-approve.",
  "replay-page-not-in-bundle":
    "The form has a page your approved review never covered. Re-run the fill so every page gets reviewed, then submit.",
  "did-not-advance": "A page didn't advance. Re-running usually clears it.",
  "workday-soft-error": "Workday kept showing its “Something went wrong — please refresh” page even after reloading. Try again in a bit.",
  "replay-needs-approval":
    "The form made some fields required that weren't when you reviewed this application — they've been added to your review. Answer them on the Tracker, then submit again.",
  "replay-page-empty": "A page came up completely blank and stayed blank after reloading. Your approved review is fine — it's the Workday page. Open the tab and take a look.",
  "session-expired": "The Workday session expired part-way through. Run it again.",
  "resume-not-attached": "Your resume didn't attach, and it's required. Check the Resume page, then run again.",
  "no-next-button": "Couldn't find the Save & Continue button on a page. Open the tab to check.",
  "workday-maintenance": "Workday is in maintenance. Try again after the window.",
  "max-pages-cap": "Hit the page-count backstop without reaching the review page. Eyeball the tab.",
};

function interpretSubmit(resp: ExtResponse, armed: boolean): Outcome {
  // Refusals BEFORE anything opened — the pre-flight (cheap, no tab, no sign-in).
  if (resp.ok === false || resp.ok === undefined) {
    const err = String(resp.error ?? "");
    const detail = (resp.detail as string) || err || "The submit run couldn't start.";
    if (err === "no-approved-bundle") return { tone: "warn", headline: "Nothing approved to submit yet", detail };
    if (err === "not-approved") {
      return {
        tone: "warn",
        headline: "This application still needs your approval",
        detail,
        blockers: (resp.blockers as string[]) || [],
      };
    }
    if (err === "bad-url") return { tone: "err", headline: "That doesn't look like a job link", detail };
    if (/port closed|message channel|Could'?nt reach|No response/i.test(err)) {
      return {
        tone: "warn",
        headline: "Lost contact with the extension",
        detail: "The run may still be going in its tab — check the tab, then your Tracker.",
      };
    }
    return { tone: "err", headline: "The submit run hit an error", detail };
  }

  if (resp.already_applied) {
    return { tone: "ok", headline: "You've already applied to this job", detail: (resp.detail as string) || ONBOARD_STOP["already-applied"] };
  }

  // Couldn't even reach the form (sign-in / verification).
  if (!resp.replayed) {
    const stopped = String(resp.stopped ?? "");
    return {
      tone: "warn",
      headline: "Couldn't get back into the application",
      detail: ONBOARD_STOP[stopped] || (resp.detail as string) || (stopped ? `Stopped: ${stopped}` : "Stopped before the form."),
    };
  }

  const sub = (resp.submit as ExtResponse) || {};
  const pages = typeof sub.pages_replayed === "number" ? sub.pages_replayed : undefined;
  const pagesNote = pages != null ? ` (${pages} page${pages === 1 ? "" : "s"} replayed)` : "";

  if (sub.submitted) {
    return {
      tone: "ok",
      headline: "Submitted",
      detail: sub.confirmed
        ? `Your application is in — Workday showed the confirmation.${pagesNote}`
        : `The submit click went through, but the confirmation page wasn't detected — check the tab to be sure.${pagesNote}`,
    };
  }
  if (sub.would_submit) {
    return {
      tone: "ok",
      headline: "Rehearsal passed every check",
      detail: `Your approved answers replayed cleanly and the review page matched them exactly, so a real submit would have gone through.${pagesNote} Nothing was submitted.`,
    };
  }
  if (sub.submit_blocked || String(sub.stopped ?? "") === "submit-blocked") {
    return {
      tone: "warn",
      headline: "Stopped at the final check",
      detail: `Everything replayed, but the submit gate refused${pagesNote}. Clear the items below, then run it again.`,
      blockers: (sub.blockers as string[]) || [],
    };
  }
  const stopped = String(sub.stopped ?? "");
  // The form made fields required that weren't when this application was reviewed. They've been added
  // to the review bundle (empty + unapproved) and pushed to the site — list them so the operator knows
  // exactly what to answer before re-running.
  if (stopped === "replay-needs-approval") {
    return {
      tone: "warn",
      headline: "A few new questions need your answer",
      detail: REPLAY_STOP["replay-needs-approval"] + pagesNote,
      blockers: (sub.newly_required as string[]) || [],
    };
  }
  if (stopped.startsWith("submit-refused")) {
    return { tone: "warn", headline: "The Submit button couldn't be clicked", detail: `Something was covering it${pagesNote}. Open the tab and look.` };
  }
  return {
    tone: "warn",
    headline: armed ? "Stopped before submitting" : "Rehearsal stopped early",
    detail: (REPLAY_STOP[stopped] || (stopped ? `Stopped: ${stopped}` : "The replay stopped early.")) + pagesNote,
  };
}

export function RunPanel() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>({ s: "idle" });
  const [confirming, setConfirming] = useState(false); // the armed-submit two-step
  const [connected, setConnected] = useState<boolean | null>(null);
  const [showJd, setShowJd] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const portRef = useRef<{ disconnect: () => void } | null>(null);

  useEffect(() => {
    setConnected(linkedExtensionId() !== null && extensionMessagingAvailable());
  }, []);

  // Tear down a live-progress port if the panel unmounts mid-run (client-side nav).
  useEffect(() => () => portRef.current?.disconnect(), []);

  // Editing the link drops a pending "yes, submit it" — the confirmation belongs to the job it was
  // given for, never to whatever URL happens to be in the box when the second click lands.
  useEffect(() => setConfirming(false), [url]);

  const running = phase.s === "running";
  const submitting = submitPhase.s === "running";
  const busy = running || submitting;
  const validUrl = /^https?:\/\/\S+$/i.test(url.trim());

  async function run(background: boolean) {
    const startUrl = url.trim();
    if (!validUrl || busy) return;
    const extId = linkedExtensionId();
    if (!extId || !extensionMessagingAvailable()) {
      setConnected(false);
      return;
    }
    setPhase({ s: "running", background });
    setProgress({ phase: background ? "Starting in the background…" : "Starting…", detail: "", at: 0 });

    // Open a live-progress port BEFORE kicking off the run so we catch the earliest phases. The
    // extension streams { phase, detail } over it as onboard/fill progresses; it's UI sugar only —
    // the authoritative outcome still arrives on the sendToExtension response below.
    portRef.current = openRunProgressPort(extId, (p) => setProgress(p));

    // background:true → the extension opens the job tab UNFOCUSED and the whole pipeline runs
    // hidden (the CDP substrate is throttle-immune) — you stay right here on the Run page.
    const resp = await sendToExtension(extId, { type: "AP_RUN_APPLICATION", startUrl, background });

    portRef.current?.disconnect();
    portRef.current = null;
    setProgress(null);

    // Save whatever the extension scraped to the tracker row for this posting.
    const jd = (resp.jd as Jd | null) ?? null;
    let appId: string | null = null;
    try {
      const saved = await saveRunJob({
        // The pasted posting URL — saveRunJob derives a stable job_key from it (tenant + req id) that
        // matches the extension's report key, so both converge on ONE tracker row across runs, and it
        // stays the durable clickable link (unlike the ephemeral form url).
        url: startUrl,
        company: jd?.company,
        role: jd?.title,
        jobDescription: jd?.text,
        // Which Workday account the extension actually signed in as (migration 0011).
        login: (resp.login as RunLogin | null) ?? null,
      });
      if (saved.ok) appId = saved.id || null;
    } catch {
      /* non-fatal: the walk's own report also upserts this row */
    }

    setPhase({ s: "done", resp, jd, appId });
  }

  /**
   * The SUBMIT run — stage three, from this page.
   *
   * `armed:false` is a full rehearsal: it signs in, replays every approved answer, verifies each one,
   * checks the review page displays exactly what you approved, runs the whole submit gate — and then
   * stops and tells you it *would* have submitted. Same code path, no click.
   * `armed:true` is the real thing, and only ever runs from the second click of the confirm step.
   *
   * Always a FOREGROUND tab: the replay path uses trusted input (unlike the fill, it has no
   * synthetic-input fast path), and an irreversible action should be watchable while it happens.
   */
  async function submitRun(armed: boolean) {
    const startUrl = url.trim();
    if (!validUrl || busy) return;
    const extId = linkedExtensionId();
    if (!extId || !extensionMessagingAvailable()) {
      setConnected(false);
      return;
    }
    setConfirming(false);
    setSubmitPhase({ s: "running", armed });
    setProgress({ phase: armed ? "Starting the submit run…" : "Starting the rehearsal…", detail: "", at: 0 });
    portRef.current = openRunProgressPort(extId, (p) => setProgress(p));

    const resp = await sendToExtension(extId, { type: "AP_SUBMIT_APPLICATION", startUrl, arm: armed });

    portRef.current?.disconnect();
    portRef.current = null;
    setProgress(null);

    // Record the outcome: `submitted` flips the tracker row (the extension never reports that status
    // itself — the human authorizes a submit, and that happened here). A rehearsal writes no status.
    const sub = (resp.submit as ExtResponse) || {};
    let appId: string | null = (resp.application_id as string) || null;
    try {
      const saved = await saveRunSubmit({
        url: startUrl,
        submitted: sub.submitted === true,
        login: (resp.login as RunLogin | null) ?? null,
      });
      if (saved.ok && saved.id) appId = saved.id;
    } catch {
      /* non-fatal — the run already happened; the row just misses the status flip */
    }

    setSubmitPhase({ s: "done", resp, armed, appId });
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
        subtitle="A Workday posting URL (myworkdayjobs.com). Run opens it in a new tab and works through it — foreground to watch, or in the background while you stay here."
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run(false);
            }}
            disabled={busy}
            placeholder="https://company.wd5.myworkdayjobs.com/…/job/…/apply"
            className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber disabled:opacity-60"
          />
          <button
            onClick={() => run(false)}
            disabled={!validUrl || busy || connected === false}
            className="btn-primary shrink-0"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
            {running ? "Running…" : "Run"}
          </button>
          <button
            onClick={() => run(true)}
            disabled={!validUrl || busy || connected === false}
            className="btn-ghost shrink-0"
            title="Fills in an unfocused tab — you stay on this page while it works."
          >
            {phase.s === "running" && phase.background ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
            {phase.s === "running" && phase.background ? "Filling in background…" : "Background fill"}
          </button>
        </div>

        {running && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-hairline bg-cockpit px-3.5 py-3">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">
                {progress?.phase ||
                  (phase.s === "running" && phase.background ? "Starting in the background…" : "Starting…")}
              </p>
              {progress?.detail && <p className="mt-0.5 text-xs text-ink-dim">{progress.detail}</p>}
              <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
                {phase.s === "running" && phase.background
                  ? "Running in an unfocused tab — stay here; the result lands here and in your Tracker. Stops at the review page, never submits."
                  : "Watch the tab (Chrome shows a “started debugging” bar). Stops at the review page, never submits."}
              </p>
            </div>
          </div>
        )}
      </SectionCard>

      {phase.s === "done" && <Result phase={phase} onShowJd={() => setShowJd((v) => !v)} showJd={showJd} />}

      <SectionCard
        title="Submit this application"
        subtitle="The last stage, for a job you've already filled and approved on your Tracker. It signs back in, replays your approved answers, checks the review page matches them exactly — then submits."
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => submitRun(false)}
            disabled={!validUrl || busy || connected === false}
            className="btn-ghost shrink-0"
            title="Does the entire submit run and stops at the final gate without clicking Submit."
          >
            {submitPhase.s === "running" && !submitPhase.armed ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {submitPhase.s === "running" && !submitPhase.armed ? "Rehearsing…" : "Rehearse (no submit)"}
          </button>

          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              disabled={!validUrl || busy || connected === false}
              className="btn-primary shrink-0"
            >
              {submitPhase.s === "running" && submitPhase.armed ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {submitPhase.s === "running" && submitPhase.armed ? "Submitting…" : "Submit"}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-signal/40 bg-signal/[0.06] px-3 py-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-signal" />
              <span className="text-sm text-ink">Submit for real? This can&apos;t be undone.</span>
              <button onClick={() => submitRun(true)} className="btn-primary shrink-0">
                <Send className="h-4 w-4" />
                Yes, submit it
              </button>
              <button onClick={() => setConfirming(false)} className="btn-ghost shrink-0">
                Cancel
              </button>
            </div>
          )}
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Both run in a visible tab so you can watch. Neither can submit an application whose review
          isn&apos;t fully approved, or whose review page doesn&apos;t show exactly the values you
          approved — it stops and tells you what&apos;s in the way. Not filled yet?{" "}
          <Link href="/app/tracker" className="text-amber hover:underline">
            Fill and approve it first
          </Link>
          .
        </p>

        {submitting && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-hairline bg-cockpit px-3.5 py-3">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">{progress?.phase || "Starting…"}</p>
              {progress?.detail && <p className="mt-0.5 text-xs text-ink-dim">{progress.detail}</p>}
              <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
                {submitPhase.s === "running" && submitPhase.armed
                  ? "Signing in and replaying your approved answers. It submits only if every check passes."
                  : "Signing in and replaying your approved answers. Nothing will be submitted."}
              </p>
            </div>
          </div>
        )}
      </SectionCard>

      {submitPhase.s === "done" && <SubmitResult phase={submitPhase} />}
    </div>
  );
}

function SubmitResult({ phase }: { phase: Extract<SubmitPhase, { s: "done" }> }) {
  const out = interpretSubmit(phase.resp, phase.armed);
  const submitted = ((phase.resp.submit as ExtResponse) || {}).submitted === true;
  const tone =
    out.tone === "ok"
      ? { border: "border-verified/30", bg: "bg-verified/[0.05]", fg: "text-verified", Icon: Check }
      : out.tone === "warn"
        ? { border: "border-amber/30", bg: "bg-amber/[0.05]", fg: "text-amber", Icon: AlertTriangle }
        : { border: "border-signal/30", bg: "bg-signal/[0.05]", fg: "text-signal", Icon: X };

  return (
    <SectionCard title={submitted ? "Submitted" : phase.armed ? "Submit run" : "Rehearsal"}>
      <div className={clsx("flex items-start gap-3 rounded-lg border px-4 py-3", tone.border, tone.bg)}>
        <tone.Icon className={clsx("mt-0.5 h-5 w-5 shrink-0", tone.fg)} />
        <div className="min-w-0">
          <p className={clsx("text-sm font-medium", tone.fg)}>{out.headline}</p>
          {out.detail && <p className="mt-1 text-sm leading-relaxed text-ink-dim">{out.detail}</p>}
          {!!out.blockers?.length && (
            <ul className="mt-3 space-y-1.5">
              {out.blockers.map((b, i) => (
                <li key={i} className="flex gap-2 font-mono text-[11px] leading-relaxed text-ink-dim">
                  <span className={tone.fg}>✗</span>
                  <span className="min-w-0">{b}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link href={phase.appId ? `/app/tracker/${phase.appId}` : "/app/tracker"} className="btn-primary">
          <ExternalLink className="h-4 w-4" />
          {submitted ? "See it in Tracker" : "Open the review"}
        </Link>
      </div>
    </SectionCard>
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
