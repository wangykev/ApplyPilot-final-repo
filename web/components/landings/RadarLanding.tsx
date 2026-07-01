import Link from "next/link";
import { ShieldCheck, ArrowRight } from "lucide-react";

/**
 * Flight-deck variant "Radar" — same dark + amber DNA, control-tower personality:
 * geometric Sora type, an animated radar scope as the hero (applications sweeping
 * past, verified vs flagged), a concentric-rings logo. (Reduced-motion is honored
 * globally, so the sweep freezes for those users.)
 */

const SORA = "font-[family-name:var(--font-sora)]";

function RadarMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-label="ApplyPilot">
      <circle cx="16" cy="16" r="14" stroke="#26303D" strokeWidth="2" />
      <circle cx="16" cy="16" r="8.5" stroke="#26303D" strokeWidth="1" />
      <line x1="16" y1="16" x2="27" y2="8" stroke="#FFB627" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="16" r="1.6" fill="#FFB627" />
      <circle cx="23" cy="11" r="1.4" fill="#36D6A0" />
    </svg>
  );
}

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <RadarMark className="h-7 w-7" />
      <span className={`${SORA} text-lg font-bold tracking-tight text-ink`}>
        Apply<span className="text-amber">Pilot</span>
      </span>
    </span>
  );
}

export function RadarLanding() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-hairline">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link href="/"><Wordmark /></Link>
          <nav className="hidden items-center gap-8 md:flex">
            <a href="#how" className="text-sm text-ink-dim hover:text-ink">How it works</a>
            <a href="#safety" className="text-sm text-ink-dim hover:text-ink">Safety</a>
            <a href="#caps" className="text-sm text-ink-dim hover:text-ink">Capabilities</a>
          </nav>
          <Link href="/login" className="btn-primary">Open the tower</Link>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-hairline">
          <div className="absolute inset-0 grid-deck opacity-25" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-[1fr_0.9fr] lg:py-24">
            <div>
              <p className={`${SORA} text-xs font-semibold uppercase tracking-[0.28em] text-amber`}>
                Workday application autopilot
              </p>
              <h1 className={`${SORA} mt-6 text-4xl font-extrabold leading-[1.03] tracking-tight text-balance sm:text-5xl lg:text-6xl`}>
                Every application, on your scope.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-dim">
                Upload your resume once. ApplyPilot fills every Workday form from your profile, tracks
                every field it touches, and <span className="text-ink">never submits without you</span>.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link href="/login" className="btn-primary">
                  Open the tower
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <a href="#how" className="btn-ghost">How it works</a>
              </div>
              <div className="mt-12 flex flex-wrap gap-x-10 gap-y-4">
                {[
                  ["9", "filled + verified", "text-verified"],
                  ["2", "flagged for review", "text-amber"],
                  ["0", "submitted for you", "text-ink"],
                ].map(([n, l, c]) => (
                  <div key={l}>
                    <div className={`${SORA} text-3xl font-extrabold ${c}`}>{n}</div>
                    <div className="mt-1 font-mono text-[11px] tracking-label text-ink-dim">{l}</div>
                  </div>
                ))}
              </div>
            </div>

            <RadarScope />
          </div>
        </section>

        <Sequence />
        <Safety />
        <Capabilities />
        <Cta />
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-8">
          <Wordmark />
          <span className="font-mono text-[10px] tracking-label text-ink-faint">
            THE REVIEW GATE IS YOURS
          </span>
        </div>
      </footer>
    </div>
  );
}

function RadarScope() {
  const blips = [
    { x: "72%", y: "24%", c: "bg-verified", label: "verified" },
    { x: "30%", y: "40%", c: "bg-verified", label: null },
    { x: "62%", y: "70%", c: "bg-amber", label: "review" },
    { x: "44%", y: "22%", c: "bg-verified", label: null },
    { x: "26%", y: "66%", c: "bg-verified", label: null },
  ];
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="relative aspect-square overflow-hidden rounded-full border border-hairline bg-panel shadow-bezel">
        {/* rings */}
        {[0.72, 0.48, 0.24].map((s) => (
          <div
            key={s}
            className="absolute rounded-full border border-hairline"
            style={{ inset: `${(1 - s) * 50}%` }}
          />
        ))}
        {/* crosshair */}
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-hairline" />
        <div className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-hairline" />
        {/* sweep */}
        <div
          className="absolute inset-0 animate-[spin_5s_linear_infinite]"
          style={{
            backgroundImage:
              "conic-gradient(from 0deg, rgba(255,182,39,0.34), rgba(255,182,39,0.04) 32%, transparent 46%)",
          }}
        />
        {/* blips */}
        {blips.map((b, i) => (
          <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: b.x, top: b.y }}>
            <span className={`block h-2 w-2 rounded-full ${b.c} shadow-[0_0_8px_currentColor]`} />
            {b.label && (
              <span className="absolute left-3 top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[9px] uppercase tracking-label text-ink-dim">
                {b.label}
              </span>
            )}
          </div>
        ))}
        {/* center */}
        <div className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber" />
      </div>
      <p className="mt-3 text-center font-mono text-[11px] leading-relaxed tracking-wide text-ink-faint">
        Each blip is a field the engine touched — verified in teal, flagged for your review in amber.
      </p>
    </div>
  );
}

const STEPS = [
  ["01", "Fill", "The engine reads your profile and fills the page you're on — text, choices, dates, repeating sections, the resume."],
  ["02", "Review", "Every field lands on your scope. Confident fills read verified; guesses are flagged with the reason."],
  ["03", "Submit", "You approve, then submit yourself. It holds at the review gate and never clicks Submit."],
];

function Sequence() {
  return (
    <section id="how" className="border-b border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <p className={`${SORA} text-xs font-semibold uppercase tracking-[0.26em] text-amber`}>The pipeline</p>
        <h2 className={`${SORA} mt-4 max-w-2xl text-3xl font-extrabold tracking-tight text-balance sm:text-4xl`}>
          Fill, review, submit — in that order, on purpose.
        </h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {STEPS.map(([n, t, b]) => (
            <div key={n} className="bezel p-6">
              <span className={`${SORA} text-3xl font-extrabold text-amber`}>{n}</span>
              <h3 className={`${SORA} mt-4 text-xl font-bold`}>{t}</h3>
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
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2">
        <div>
          <p className={`${SORA} flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.26em] text-verified`}>
            <ShieldCheck className="h-4 w-4" /> The contract
          </p>
          <h2 className={`${SORA} mt-4 text-3xl font-extrabold tracking-tight text-balance sm:text-4xl`}>
            Guess, fill, flag. <span className="text-amber">Never silent.</span>
          </h2>
          <p className="mt-6 max-w-lg leading-relaxed text-ink-dim">
            An application is a legal document, so ApplyPilot is built to be accurate, not just fast.
            When it&apos;s sure, it fills and verifies. When it has to infer, it still fills — but
            raises a flag and tells you why. A wrong answer is never quietly committed.
          </p>
        </div>
        <div className="bezel p-6">
          <div className="flex items-center justify-between border-b border-hairline pb-4">
            <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">Needs review</span>
            <span className="font-mono text-[11px] tracking-label text-amber">02</span>
          </div>
          {[
            ["border-signal/40 text-signal", "Truthfulness", "Previously employed here?", "No", "No match in your employer history — but this sits next to a truthfulness certification."],
            ["border-amber/40 text-amber", "AI-inferred · demographic", "Gender", "Prefer not to say", "Not stated in your profile. A safe default was chosen — verify or change it."],
          ].map(([cls, badge, label, value, reason]) => (
            <div key={label} className="border-b border-hairline/70 py-4 last:border-0">
              <span className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-label ${cls}`}>{badge}</span>
              <div className="mt-2.5 flex items-baseline justify-between gap-4">
                <span className="text-sm text-ink">{label}</span>
                <span className="shrink-0 font-mono text-sm text-amber-soft">{value}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-dim">{reason}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const CAPS = [
  ["Fills the hard widgets", "Dropdowns, typeaheads, radios, checkboxes, multi-segment dates, hierarchical pickers, repeating sections."],
  ["Answers screening questions", "Unmapped questions answered from your profile by an LLM that names its reasoning and rates confidence."],
  ["Attaches your resume", "Upload one PDF; it's attached programmatically — no file picker, no re-uploading per job."],
  ["Fills while minimized", "Off-loop actuation keeps filling even when the tab is hidden or the window is minimized."],
  ["Walks multi-page flows", "Advances page to page and stops at the review page. A double guard means it can't click Submit."],
  ["Re-reads its own work", "After a page settles, an independent audit re-reads every field against what it recorded."],
];

function Capabilities() {
  return (
    <section id="caps" className="border-b border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <p className={`${SORA} text-xs font-semibold uppercase tracking-[0.26em] text-amber`}>Capabilities</p>
        <h2 className={`${SORA} mt-4 max-w-2xl text-3xl font-extrabold tracking-tight text-balance sm:text-4xl`}>
          Everything the form throws at you, handled.
        </h2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
          {CAPS.map(([t, b]) => (
            <div key={t} className="bg-panel p-6">
              <h3 className={`${SORA} text-lg font-bold text-ink`}>{t}</h3>
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
      <h2 className={`${SORA} text-3xl font-extrabold tracking-tight text-balance sm:text-4xl`}>
        Set up your profile once. Apply on autopilot.
      </h2>
      <p className="mx-auto mt-5 max-w-xl leading-relaxed text-ink-dim">
        Create your account, upload your resume, and connect the extension. ApplyPilot takes the
        typing; you keep the final word.
      </p>
      <div className="mt-9 flex justify-center">
        <Link href="/login" className="btn-primary">
          Open the tower
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
