import Link from "next/link";
import { ShieldCheck, ArrowRight } from "lucide-react";
import { FillStatusPanel } from "@/components/FillStatusPanel";

/**
 * Flight-deck variant "Avionics" — same dark + amber instrument DNA, but a
 * heads-up-display personality: squared Chakra Petch type, a centered layout
 * framed by HUD reticle brackets, a top status strip, an attitude-indicator
 * logo, and a faint HUD-cyan secondary line.
 */

const CHAKRA = "font-[family-name:var(--font-chakra)]";
const HUD_CYAN = "#5BD2FF";

function AttitudeIndicator({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-label="ApplyPilot">
      <circle cx="16" cy="16" r="14" stroke="#26303D" strokeWidth="2" />
      <path d="M2.5 16 A13.5 13.5 0 0 1 29.5 16 Z" fill="#5BD2FF" opacity="0.10" />
      <line x1="4" y1="16" x2="28" y2="16" stroke="#566273" strokeWidth="1" />
      {/* pitch ticks */}
      <line x1="12" y1="12" x2="20" y2="12" stroke="#566273" strokeWidth="1" opacity="0.7" />
      <line x1="13" y1="20" x2="19" y2="20" stroke="#566273" strokeWidth="1" opacity="0.7" />
      {/* aircraft symbol */}
      <path d="M9 16 L14 16 L16 18.5 L18 16 L23 16" stroke="#FFB627" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="16" r="1.4" fill="#FFB627" />
    </svg>
  );
}

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <AttitudeIndicator className="h-7 w-7" />
      <span className={`${CHAKRA} text-lg font-semibold tracking-wide text-ink`}>
        APPLY<span className="text-amber">PILOT</span>
      </span>
    </span>
  );
}

export function AvionicsLanding() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* status strip */}
      <div className="border-b border-hairline bg-panel/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-1.5">
          <span className="font-mono text-[10px] tracking-label text-ink-faint">
            SYS · APPLYPILOT
          </span>
          <div className="hidden items-center gap-5 font-mono text-[10px] tracking-label sm:flex">
            <span className="text-verified">FILL ◇ ARMED</span>
            <span className="text-amber">REVIEW ◇ MANUAL</span>
            <span className="text-signal">SUBMIT ◇ LOCKED</span>
          </div>
          <span className="font-mono text-[10px] tracking-label text-ink-faint">v0.1</span>
        </div>
      </div>

      <header className="border-b border-hairline">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link href="/"><Wordmark /></Link>
          <nav className="hidden items-center gap-8 md:flex">
            <a href="#how" className="text-sm text-ink-dim hover:text-ink">Sequence</a>
            <a href="#safety" className="text-sm text-ink-dim hover:text-ink">Safety</a>
            <a href="#caps" className="text-sm text-ink-dim hover:text-ink">Systems</a>
          </nav>
          <Link href="/login" className="btn-primary">Engage</Link>
        </div>
      </header>

      <main className="flex-1">
        {/* HERO — centered, reticle-framed */}
        <section className="relative overflow-hidden border-b border-hairline">
          <div className="absolute inset-0 grid-deck opacity-30" aria-hidden />
          <div className="relative mx-auto max-w-3xl px-5 py-24 text-center">
            {/* reticle corner brackets */}
            <Reticle />
            <p className={`${CHAKRA} text-xs uppercase tracking-[0.35em] text-amber`}>
              Workday application autopilot
            </p>
            <h1 className={`${CHAKRA} mx-auto mt-6 max-w-2xl text-4xl font-bold uppercase leading-[1.05] tracking-tight text-balance sm:text-5xl lg:text-6xl`}>
              Heads up.
              <br />
              You have the controls.
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-ink-dim">
              Upload your resume once. ApplyPilot flies the Workday form from your profile, flags
              every guess on the display, and <span className="text-ink">never submits without you</span>.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Link href="/login" className="btn-primary">
                Engage autopilot
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a href="#how" className="btn-ghost">Flight sequence</a>
            </div>
          </div>

          {/* primary flight display */}
          <div className="relative mx-auto max-w-2xl px-5 pb-20">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] tracking-label" style={{ color: HUD_CYAN }}>
                ◄ PRIMARY FLIGHT DISPLAY ►
              </span>
              <span className="font-mono text-[10px] tracking-label text-ink-faint">LIVE</span>
            </div>
            <FillStatusPanel />
          </div>
        </section>

        <Sequence />
        <Safety />
        <Systems />
        <Cta />
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-8">
          <Wordmark />
          <span className="font-mono text-[10px] tracking-label text-ink-faint">
            SUBMIT REMAINS UNDER PILOT COMMAND
          </span>
        </div>
      </footer>
    </div>
  );
}

function Reticle() {
  const b = "pointer-events-none absolute h-6 w-6 border-amber/50";
  return (
    <div aria-hidden>
      <span className={`${b} left-0 top-0 border-l border-t`} />
      <span className={`${b} right-0 top-0 border-r border-t`} />
      <span className={`${b} bottom-0 left-0 border-b border-l`} />
      <span className={`${b} bottom-0 right-0 border-b border-r`} />
    </div>
  );
}

const STEPS = [
  ["01", "Fill", "Reads your profile and flies the page — text, dropdowns, typeaheads, dates, repeating sections, the resume."],
  ["02", "Review", "Every field on the display: confident fills read verified; guesses are flagged with the reason."],
  ["03", "Submit", "You approve, then submit yourself. It stops at the review gate — it never clicks Submit."],
];

function Sequence() {
  return (
    <section id="how" className="border-b border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <p className={`${CHAKRA} text-xs uppercase tracking-[0.3em] text-amber`}>Flight sequence</p>
        <h2 className={`${CHAKRA} mt-4 text-3xl font-bold uppercase tracking-tight sm:text-4xl`}>
          Fill · Review · Submit
        </h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {STEPS.map(([n, t, b]) => (
            <div key={n} className="bezel p-6">
              <div className="flex items-center justify-between">
                <span className={`${CHAKRA} text-3xl font-bold text-amber`}>{n}</span>
                <span className="font-mono text-[10px] tracking-label text-ink-faint">STEP</span>
              </div>
              <h3 className={`${CHAKRA} mt-4 text-xl font-semibold uppercase tracking-wide`}>{t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{b}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Safety() {
  return (
    <section id="safety" className="border-b border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <p className={`${CHAKRA} flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-verified`}>
          <ShieldCheck className="h-4 w-4" /> The contract
        </p>
        <h2 className={`${CHAKRA} mt-4 max-w-2xl text-3xl font-bold uppercase tracking-tight text-balance sm:text-4xl`}>
          Guess, fill, flag. <span className="text-amber">Never silent.</span>
        </h2>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <p className="max-w-lg leading-relaxed text-ink-dim">
            An application is a legal document, so ApplyPilot is built to be accurate, not just fast.
            When it&apos;s sure, it fills and verifies. When it has to infer, it still fills — but
            raises a flag and tells you why. A wrong answer is never quietly committed.
          </p>
          <ul className="space-y-3">
            {[
              ["bg-verified", "Fields proven from your profile fill and read back as verified."],
              ["bg-amber", "Inferred answers are filled and flagged with the reasoning behind them."],
              ["bg-signal", "Legally-loaded questions get the loudest badge and sort to the top."],
            ].map(([c, t]) => (
              <li key={t} className="flex gap-3">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${c}`} />
                <span className="text-sm leading-relaxed text-ink-dim">{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

const CAPS = [
  ["Hard widgets", "Dropdowns, typeaheads, radios, dates, hierarchical pickers, repeating sections."],
  ["Screening AI", "Answers unmapped questions from your profile, with reasoning and confidence."],
  ["Resume attach", "One PDF, attached programmatically — no file picker per job."],
  ["Flies minimized", "Off-loop actuation keeps filling even when the tab is hidden."],
  ["Multi-page", "Advances page to page; a double guard means it can't click Submit."],
  ["Self-audit", "Re-reads every field after the page settles to catch late changes."],
];

function Systems() {
  return (
    <section id="caps" className="border-b border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <p className={`${CHAKRA} text-xs uppercase tracking-[0.3em] text-amber`}>Systems</p>
        <h2 className={`${CHAKRA} mt-4 text-3xl font-bold uppercase tracking-tight sm:text-4xl`}>
          Everything the form throws, handled.
        </h2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
          {CAPS.map(([t, b]) => (
            <div key={t} className="bg-panel p-6">
              <h3 className={`${CHAKRA} text-lg font-semibold uppercase tracking-wide text-ink`}>{t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{b}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="mx-auto max-w-3xl px-5 py-24 text-center">
      <h2 className={`${CHAKRA} text-3xl font-bold uppercase tracking-tight text-balance sm:text-4xl`}>
        Set up once. Fly on autopilot.
      </h2>
      <p className="mx-auto mt-5 max-w-xl leading-relaxed text-ink-dim">
        Create your account, upload your resume, and connect the extension. ApplyPilot takes the
        typing; you keep the final word.
      </p>
      <div className="mt-9 flex justify-center">
        <Link href="/login" className="btn-primary">
          Engage autopilot
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
