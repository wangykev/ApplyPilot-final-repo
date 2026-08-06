"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Cable,
  Check,
  FileText,
  IdCard,
  Rocket,
  Save,
  Sparkles,
} from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { ResumePanel } from "@/app/app/resume/ResumePanel";
import { ProfileEditor } from "@/app/app/profile/ProfileEditor";
import { ProviderKeys } from "@/app/app/ai/AiConfigForm";
import { saveAiConfig } from "@/app/app/ai/actions";
import { liveSync } from "@/lib/extension-sync";
import { PROVIDERS, keysForProvider, type AiConfig } from "@/lib/ai-config";
import { LLM_PROVIDER_LABELS } from "@/lib/llm";
import type { Profile } from "@/lib/profile-schema";
import type { Bucket } from "@/lib/buckets";
import {
  ONBOARDING_STEPS,
  countUsableKeys,
  missingForApproval,
  onboardingStatus,
  type OnboardingFacts,
  type OnboardingStepId,
} from "@/lib/onboarding";
import { approveProfile, finishOnboarding } from "./actions";
import { GeminiGuide } from "./GeminiGuide";
import { clsx } from "@/lib/clsx";

type View = OnboardingStepId | "done";

const STEP_META: Record<OnboardingStepId, { title: string; rail: string; icon: typeof FileText }> = {
  resume: { title: "Attach your resume", rail: "Resume", icon: FileText },
  profile: { title: "Approve your profile", rail: "Profile", icon: IdCard },
  ai: { title: "Add your AI key", rail: "AI key", icon: Sparkles },
};

export function StartFlow({
  facts: initialFacts,
  profile,
  buckets,
  aiConfig,
  resume,
  next,
  configured,
}: {
  facts: OnboardingFacts;
  profile: Profile;
  buckets: Bucket[];
  aiConfig: AiConfig;
  resume: { filename: string; size: number } | null;
  next: string;
  configured: boolean;
}) {
  const router = useRouter();
  const [facts, setFacts] = useState<OnboardingFacts>(initialFacts);
  // The profile the SAVED state is judged against — approving is about what's stored, not
  // what's currently typed into the editor.
  const [savedProfile, setSavedProfile] = useState<Profile>(profile);

  const status = useMemo(() => onboardingStatus(facts), [facts]);
  const [view, setView] = useState<View>(status.complete ? "done" : (status.currentStep ?? "resume"));
  /**
   * Parsing a resume needs a key, but the key is step 3 — so step 1 can send you ahead to
   * fetch one and this remembers to send you back. The ORDER is unchanged: the flow still
   * refuses to finish until all three are done. Without the detour a brand-new user would
   * have to type their whole profile by hand in step 2, because the one thing that fills it
   * lives behind a step they haven't reached.
   */
  const [returnTo, setReturnTo] = useState<OnboardingStepId | null>(null);

  const doneOf = (id: OnboardingStepId) => status.steps.find((s) => s.id === id)?.done ?? false;

  // Reachable = already finished, or the one you're up to. You can go back freely; you
  // can't skip ahead past something unfinished.
  const reachable = (id: OnboardingStepId) => doneOf(id) || id === status.currentStep || id === view;

  const goto = (v: View) => {
    setView(v);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const finishStep = (id: OnboardingStepId) => {
    if (returnTo && id === "ai") {
      const back = returnTo;
      setReturnTo(null);
      goto(back);
      return;
    }
    const i = ONBOARDING_STEPS.indexOf(id);
    goto(i + 1 < ONBOARDING_STEPS.length ? ONBOARDING_STEPS[i + 1] : "done");
  };

  return (
    <div className="space-y-8 pb-28">
      <header className="border-b border-hairline pb-6">
        <p className="eyebrow">Preflight</p>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          {status.complete ? "You're set up" : "Get ApplyPilot ready"}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-dim">
          Three things before the extension can apply for you: a resume to attach, a profile you&apos;ve
          checked, and a key so it can answer the questions your profile doesn&apos;t cover. Takes a few
          minutes, once.
        </p>
      </header>

      {!configured && (
        <div className="bezel border-signal/40 p-4">
          <p className="text-sm text-ink-dim">
            <span className="text-signal">Backend not connected.</span> Nothing on this page can be saved
            until Supabase is configured — see <span className="font-mono text-xs text-ink">WEBSITE.md</span>.
          </p>
        </div>
      )}

      <StepRail
        steps={status.steps}
        view={view}
        onPick={(id) => reachable(id) && goto(id)}
        reachable={reachable}
      />

      {view === "resume" && (
        <StepShell
          id="resume"
          blurb="One PDF, stored once. The extension attaches it to every application — you'll never pick a file per job."
        >
          <ResumePanel
            initialStored={resume}
            onStored={(s) => setFacts((f) => ({ ...f, hasResume: !!s }))}
            onNeedsAiKey={() => {
              setReturnTo("resume");
              goto("ai");
            }}
            onOpenProfile={() => goto("profile")}
          />
          {facts.usableKeys === 0 && (
            <p className="text-sm leading-relaxed text-ink-dim">
              Parsing needs an AI key, which is step 3.{" "}
              <button
                type="button"
                onClick={() => {
                  setReturnTo("resume");
                  goto("ai");
                }}
                className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
              >
                Add one now
              </button>{" "}
              and you&apos;ll come straight back — it fills most of your profile for you, so it&apos;s worth
              the detour.
            </p>
          )}
          <StepNav
            backTo={null}
            onBack={() => {}}
            canContinue={doneOf("resume")}
            hint="Upload a PDF to continue."
            onContinue={() => finishStep("resume")}
          />
        </StepShell>
      )}

      {view === "profile" && (
        <StepShell
          id="profile"
          blurb="This is what every application gets filled from. Read it, fix anything wrong, then approve it — the extension trusts these values, so they're worth two minutes now."
        >
          <ProfileApproval
            savedProfile={savedProfile}
            approvedAt={facts.profileApprovedAt}
            onApproved={(at) => setFacts((f) => ({ ...f, profileApprovedAt: at }))}
          />
          <ProfileEditor initial={profile} initialBuckets={buckets} onSaved={setSavedProfile} />
          <StepNav
            backTo="Resume"
            onBack={() => goto("resume")}
            canContinue={doneOf("profile")}
            hint="Approve your profile to continue."
            onContinue={() => finishStep("profile")}
          />
        </StepShell>
      )}

      {view === "ai" && (
        <StepShell
          id="ai"
          blurb="Applications ask things your profile doesn't hold — screening questions, short essays, odd dropdowns. A key lets the extension answer them; every AI answer is flagged for you to check, never filed silently."
        >
          <AiKeyStep
            initial={aiConfig}
            onSaved={(usableKeys) => setFacts((f) => ({ ...f, usableKeys }))}
          />
          <StepNav
            backTo="Profile"
            onBack={() => goto("profile")}
            canContinue={doneOf("ai")}
            hint="Add and save at least one key to continue."
            continueLabel={returnTo ? "Back to your resume" : undefined}
            onContinue={() => finishStep("ai")}
          />
        </StepShell>
      )}

      {view === "done" && (
        <DoneStep
          complete={status.complete}
          next={next}
          onFinish={() => router.push(next)}
          onBack={() => goto("ai")}
        />
      )}
    </div>
  );
}

/* ── chrome ──────────────────────────────────────────────────────────────── */

function StepRail({
  steps,
  view,
  onPick,
  reachable,
}: {
  steps: { id: OnboardingStepId; done: boolean }[];
  view: View;
  onPick: (id: OnboardingStepId) => void;
  reachable: (id: OnboardingStepId) => boolean;
}) {
  return (
    <ol className="grid gap-3 sm:grid-cols-3">
      {steps.map((s, i) => {
        const meta = STEP_META[s.id];
        const active = view === s.id;
        const open = reachable(s.id);
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onPick(s.id)}
              disabled={!open}
              aria-current={active ? "step" : undefined}
              className={clsx(
                "bezel flex w-full items-center gap-3 p-4 text-left transition-colors",
                active && "border-amber/50",
                !active && open && "hover:border-ink-dim",
                !open && "cursor-not-allowed opacity-50"
              )}
            >
              <span
                className={clsx(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                  s.done ? "bg-verified/10 text-verified" : active ? "bg-amber/10 text-amber" : "bg-panel-raised text-ink-dim"
                )}
              >
                {s.done ? <Check className="h-4 w-4" /> : <meta.icon className="h-4 w-4" strokeWidth={1.75} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[10px] uppercase tracking-label text-ink-faint">
                  Step {String(i + 1).padStart(2, "0")}
                </span>
                <span className={clsx("block truncate text-sm", active ? "text-ink" : "text-ink-dim")}>
                  {meta.rail}
                </span>
              </span>
              {s.done && (
                <span className="font-mono text-[10px] uppercase tracking-label text-verified">done</span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StepShell({
  id,
  blurb,
  children,
}: {
  id: OnboardingStepId;
  blurb: string;
  children: React.ReactNode;
}) {
  const meta = STEP_META[id];
  return (
    <section className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-medium">{meta.title}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-dim">{blurb}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Inline, not fixed: the profile step embeds an editor that already owns a fixed save bar
 * at the bottom of the viewport, and two stacked bars would fight for the same pixels.
 */
function StepNav({
  backTo,
  onBack,
  canContinue,
  hint,
  continueLabel,
  onContinue,
}: {
  backTo: string | null;
  onBack: () => void;
  canContinue: boolean;
  hint: string;
  continueLabel?: string;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5">
      {backTo ? (
        <button type="button" onClick={onBack} className="btn-ghost">
          <ArrowLeft className="h-4 w-4" />
          {backTo}
        </button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-3">
        {!canContinue && <span className="text-xs text-ink-faint">{hint}</span>}
        <button type="button" onClick={onContinue} disabled={!canContinue} className="btn-primary">
          {continueLabel ?? "Continue"}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/* ── step 2: the approval ────────────────────────────────────────────────── */

function ProfileApproval({
  savedProfile,
  approvedAt,
  onApproved,
}: {
  savedProfile: Profile;
  approvedAt: string | null;
  onApproved: (at: string) => void;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const gaps = useMemo(() => missingForApproval(savedProfile), [savedProfile]);

  const approve = () =>
    start(async () => {
      setErr(null);
      const res = await approveProfile();
      if (res.ok) onApproved(new Date().toISOString());
      else setErr(res.error);
    });

  if (approvedAt) {
    return (
      <div className="bezel border-verified/40 p-5">
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-verified" />
          <span className="font-mono text-[11px] uppercase tracking-label text-verified">Profile approved</span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">
          Edit it whenever you like — here, or on the Profile page later. Approving again isn&apos;t needed.
        </p>
      </div>
    );
  }

  return (
    <div className="bezel p-5">
      <h3 className="font-display text-base font-medium">Does this look right?</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-dim">
        Go through the sections below and correct anything the resume parse got wrong or left out. When
        it&apos;s accurate, approve it.
      </p>

      {gaps.length > 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-amber">
          Still needed: {gaps.map((g) => g.label).join(", ")}. Every application asks for these — fill them in
          below and press <span className="text-ink">Save profile</span>.
        </p>
      ) : (
        <p className="mt-4 text-xs text-ink-faint">
          Save any edits first — approval records what&apos;s stored, not what&apos;s typed.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={approve} disabled={pending || gaps.length > 0} className="btn-primary">
          <Check className="h-4 w-4" />
          {pending ? "Approving…" : "This is right — approve"}
        </button>
        {err && <span className="text-sm text-signal">{err}</span>}
      </div>
    </div>
  );
}

/* ── step 3: the key ─────────────────────────────────────────────────────── */

function AiKeyStep({ initial, onSaved }: { initial: AiConfig; onSaved: (usableKeys: number) => void }) {
  const [cfg, setCfg] = useState<AiConfig>(initial);
  const [savedCfg, setSavedCfg] = useState<AiConfig>(initial);
  const [saving, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const enabledTouched = useRef(false);

  const edit = (u: (c: AiConfig) => AiConfig) => {
    setCfg(u);
    setMsg(null);
  };

  const usable = countUsableKeys(cfg);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(savedCfg);
  const geminiKeys = keysForProvider(cfg, "gemini").filter((k) => k.key && k.enabled);
  const geminiFreeOnly = geminiKeys.length > 0 && geminiKeys.every((k) => k.tier === "free");

  /**
   * Adding a key but leaving AI fill off would be a key that never gets used — a silent
   * dead end at the end of setup. So the first key turns it on, through the visible switch
   * below rather than behind the scenes, and once you've touched that switch your choice
   * stands.
   */
  useEffect(() => {
    if (usable > 0 && !cfg.enabled && !enabledTouched.current) {
      setCfg((c) => ({ ...c, enabled: true }));
    }
  }, [usable, cfg.enabled]);

  const save = () =>
    start(async () => {
      setMsg(null);
      const res = await saveAiConfig(cfg);
      if (res.ok) {
        setSavedCfg(cfg);
        setMsg({ kind: "ok", text: "Saved" });
        liveSync("ai"); // mirror into a connected extension (no-op when not connected)
        onSaved(countUsableKeys(cfg));
      } else {
        setMsg({ kind: "err", text: res.error });
      }
    });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Google Gemini"
        subtitle="The one provider here with a free tier you can use without a card — and what ApplyPilot defaults to. Add a key below, or pick a different provider further down."
      >
        <GeminiGuide />
        <div className="mt-5">
          <ProviderKeys provider="gemini" cfg={cfg} edit={edit} geminiFreeOnly={geminiFreeOnly} />
        </div>
      </SectionCard>

      <SectionCard
        title="Let the extension use AI"
        subtitle="Off means no model is ever called and no money is ever spent — unanswered questions are simply left blank for you to fill in on review."
      >
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-ink-dim">
            {cfg.enabled
              ? "On — it may call a model for questions it can't match from your profile. Every AI answer is flagged for review."
              : "Off — screening questions will be left blank."}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={cfg.enabled}
            aria-label="Let the extension use AI"
            onClick={() => {
              enabledTouched.current = true;
              edit((c) => ({ ...c, enabled: !c.enabled }));
            }}
            className={clsx(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-amber/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
              cfg.enabled ? "bg-amber" : "bg-panel-raised ring-1 ring-inset ring-hairline"
            )}
          >
            <span
              className={clsx(
                "inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform",
                cfg.enabled ? "translate-x-[1.375rem]" : "translate-x-0.5"
              )}
            />
          </button>
        </div>
      </SectionCard>

      {showOthers ? (
        <SectionCard
          title="Another provider"
          subtitle="Anthropic and OpenAI work the same way, but both need a paid account — there's no free tier to fall back on."
        >
          <div className="space-y-4">
            {PROVIDERS.filter((p) => p !== "gemini").map((p) => (
              <ProviderKeys key={p} provider={p} cfg={cfg} edit={edit} geminiFreeOnly={false} />
            ))}
          </div>
        </SectionCard>
      ) : (
        <button type="button" onClick={() => setShowOthers(true)} className="btn-ghost">
          Use {LLM_PROVIDER_LABELS.anthropic} or {LLM_PROVIDER_LABELS.openai} instead
        </button>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={saving || !dirty} className="btn-primary" title={!dirty ? "No changes to save" : undefined}>
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save key"}
        </button>
        {msg && (
          <span className={clsx("text-sm", msg.kind === "ok" ? "text-verified" : "text-signal")}>
            {msg.kind === "ok" ? "✓ " : ""}
            {msg.text}
          </span>
        )}
        {!msg && dirty && usable > 0 && (
          <span className="text-xs text-ink-faint">Save to finish this step.</span>
        )}
      </div>

      <p className="text-xs leading-relaxed text-ink-faint">
        You can add more keys, set a different model per job, and watch what you&apos;re spending on the AI
        page once setup is done.
      </p>
    </div>
  );
}

/* ── the end ─────────────────────────────────────────────────────────────── */

function DoneStep({
  complete,
  next,
  onFinish,
  onBack,
}: {
  complete: boolean;
  next: string;
  onFinish: () => void;
  onBack: () => void;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const finish = () =>
    start(async () => {
      setErr(null);
      const res = await finishOnboarding();
      // A finish that didn't record is still a finish the user asked for — say so, but let
      // them through rather than trapping them behind a failed write.
      if (!res.ok) setErr(res.error);
      onFinish();
    });

  return (
    <section className="space-y-6">
      <div className="bezel p-6">
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-verified" />
          <span className="font-mono text-[11px] uppercase tracking-label text-verified">Setup complete</span>
        </div>
        <h2 className="mt-4 font-display text-xl font-medium">
          Your resume, your profile and your key are all in place.
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-dim">
          One thing left, and it lives in Chrome rather than here: link the extension so all of this reaches
          it. After that, paste a job link on the Run page and watch it fill.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <NextCard
            href="/app/connect"
            icon={Cable}
            title="Connect the extension"
            body="Paste your extension ID once. Every edit you make here syncs to it automatically after that."
          />
          <NextCard
            href="/app/run"
            icon={Rocket}
            title="Run an application"
            body="Paste a job link and press Run. It fills every page through to review — it never submits on its own."
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5">
        <button type="button" onClick={onBack} className="btn-ghost">
          <ArrowLeft className="h-4 w-4" />
          AI key
        </button>
        <div className="flex items-center gap-3">
          {err && <span className="text-sm text-signal">{err}</span>}
          <button type="button" onClick={finish} disabled={pending || !complete} className="btn-primary">
            {pending ? "Finishing…" : next === "/app" ? "Go to the flight deck" : "Continue where you left off"}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}

function NextCard({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: typeof Cable;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-lg border border-hairline bg-panel-raised/40 p-4 transition-colors hover:border-amber/40"
    >
      <Icon className="h-5 w-5 text-amber" strokeWidth={1.75} />
      <h3 className="mt-3 text-sm text-ink">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-dim">{body}</p>
      <span className="mt-3 inline-flex items-center gap-1.5 text-sm text-ink-dim transition-colors group-hover:text-amber">
        Open <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
}
