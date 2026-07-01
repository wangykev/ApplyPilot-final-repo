import Link from "next/link";
import { ShieldCheck, Lock, ArrowRight } from "lucide-react";

/**
 * Flight-deck variant "Cluster" — same dark + amber DNA, but the hero is a dense
 * cockpit instrument CLUSTER (a bento grid of tiles: gauge, counters, field
 * readout, submit-lock). Heavy industrial Archivo type, a grid-cell logo.
 */

const ARCHIVO = "font-[family-name:var(--font-archivo)]";

function ClusterMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-label="ApplyPilot">
      <rect x="3" y="3" width="11" height="11" rx="2" stroke="#566273" strokeWidth="2" />
      <rect x="18" y="3" width="11" height="11" rx="2" fill="#FFB627" />
      <rect x="3" y="18" width="11" height="11" rx="2" stroke="#566273" strokeWidth="2" />
      <rect x="18" y="18" width="11" height="11" rx="2" stroke="#566273" strokeWidth="2" />
    </svg>
  );
}

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <ClusterMark className="h-7 w-7" />
      <span className={`${ARCHIVO} text-lg font-extrabold tracking-tight text-ink`}>
        Apply<span className="text-amber">Pilot</span>
      </span>
    </span>
  );
}

export function ClusterLanding() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-hairline">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link href="/"><Wordmark /></Link>
          <nav className="hidden items-center gap-8 md:flex">
            <a href="#how" className="text-sm text-ink-dim hover:text-ink">Pipeline</a>
            <a href="#safety" className="text-sm text-ink-dim hover:text-ink">Safety</a>
            <a href="#caps" className="text-sm text-ink-dim hover:text-ink">Capabilities</a>
          </nav>
          <Link href="/login" className="btn-primary">Open dashboard</Link>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-hairline">
          <div className="absolute inset-0 grid-deck opacity-25" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-[0.85fr_1.15fr]">
            <div>
              <p className={`${ARCHIVO} text-xs font-bold uppercase tracking-[0.22em] text-amber`}>
                Workday application autopilot
              </p>
              <h1 className={`${ARCHIVO} mt-6 text-5xl font-extrabold leading-[0.98] tracking-tight text-balance sm:text-6xl`}>
                Your whole application, on one dashboard.
              </h1>
              <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-dim">
                Upload your resume once. ApplyPilot fills every Workday form from your profile, reads
                out every field it touches, and <span className="text-ink">never submits without you</span>.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link href="/login" className="btn-primary">
                  Open dashboard
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <a href="#how" className="btn-ghost">How it works</a>
              </div>
            </div>

            <BentoCluster />
          </div>
        </section>

        <Pipeline />
        <Safety />
        <Capabilities />
        <Cta />
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-8">
          <Wordmark />
          <span className="font-mono text-[10px] tracking-label text-ink-faint">
            SUBMIT STAYS ON YOUR PANEL
          </span>
        </div>
      </footer>
    </div>
  );
}

function Tile({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bezel flex flex-col p-4 ${className}`}>
      <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">{label}</span>
      <div className="mt-2 flex flex-1 flex-col justify-center">{children}</div>
    </div>
  );
}

function BentoCluster() {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Tile label="Fill accuracy">
        <Gauge />
      </Tile>

      <Tile label="This page">
        <div className="space-y-2.5">
          {[
            ["9", "filled + verified", "text-verified"],
            ["2", "flagged for review", "text-amber"],
            ["0", "submitted for you", "text-ink"],
          ].map(([n, l, c]) => (
            <div key={l} className="flex items-baseline gap-2">
              <span className={`${ARCHIVO} text-2xl font-extrabold ${c}`}>{n}</span>
              <span className="font-mono text-[10px] tracking-label text-ink-dim">{l}</span>
            </div>
          ))}
        </div>
      </Tile>

      <Tile label="Field readout" className="col-span-2">
        <div className="space-y-1.5">
          {[
            ["first_name", "Kevin", "verified", "text-verified", "✓"],
            ["country", "United States", "verified", "text-verified", "✓"],
            ["previously_employed", "No", "review", "text-amber", "⚠"],
            ["gender", "prefer-not-to-say", "review", "text-amber", "⚠"],
          ].map(([name, val, st, c, g]) => (
            <div key={name} className="flex items-center gap-3 text-[13px]">
              <span className={`${c} w-3 shrink-0`}>{g}</span>
              <span className="w-44 shrink-0 truncate font-mono text-[12px] text-ink-dim">{name}</span>
              <span className="flex-1 truncate text-ink">{val}</span>
              <span className={`shrink-0 font-mono text-[10px] uppercase tracking-label ${c}`}>{st}</span>
            </div>
          ))}
        </div>
      </Tile>

      <Tile label="Submit" className="col-span-2">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-signal/40 bg-signal/[0.08]">
            <Lock className="h-4 w-4 text-signal" />
          </span>
          <div>
            <div className="text-sm text-ink">Locked to you</div>
            <div className="font-mono text-[10px] tracking-label text-ink-dim">
              ApplyPilot stops at the review page — it never clicks Submit
            </div>
          </div>
        </div>
      </Tile>
    </div>
  );
}

function Gauge() {
  // ~80% of a semicircle. Arc length of r=40 semicircle = π*40 ≈ 125.6.
  const len = Math.PI * 40;
  const pct = 0.82;
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 100 58" className="w-full max-w-[150px]">
        <path d="M10 52 A40 40 0 0 1 90 52" fill="none" stroke="#26303D" strokeWidth="8" strokeLinecap="round" />
        <path
          d="M10 52 A40 40 0 0 1 90 52"
          fill="none"
          stroke="#FFB627"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${len * pct} ${len}`}
        />
        {/* needle */}
        <line x1="50" y1="52" x2="74" y2="26" stroke="#E6EDF5" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="50" cy="52" r="3.5" fill="#E6EDF5" />
      </svg>
      <div className={`${ARCHIVO} mt-1 text-2xl font-extrabold text-ink`}>
        High<span className="text-amber">.</span>
      </div>
      <div className="font-mono text-[10px] tracking-label text-ink-dim">confidence, read back</div>
    </div>
  );
}

const STEPS = [
  ["01", "Fill", "The engine reads your profile and fills the page you're on — text, choices, dates, repeating sections, the resume."],
  ["02", "Review", "Every field lands on the dashboard. Confident fills read verified; guesses are flagged with the reason."],
  ["03", "Submit", "You approve, then submit yourself. It holds at the review gate and never clicks Submit."],
];

function Pipeline() {
  return (
    <section id="how" className="border-b border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <p className={`${ARCHIVO} text-xs font-bold uppercase tracking-[0.2em] text-amber`}>The pipeline</p>
        <h2 className={`${ARCHIVO} mt-4 max-w-2xl text-4xl font-extrabold tracking-tight text-balance`}>
          Fill, review, submit — in that order, on purpose.
        </h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {STEPS.map(([n, t, b]) => (
            <div key={n} className="bezel p-6">
              <span className={`${ARCHIVO} text-3xl font-extrabold text-amber`}>{n}</span>
              <h3 className={`${ARCHIVO} mt-4 text-xl font-bold`}>{t}</h3>
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
        <p className={`${ARCHIVO} flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-verified`}>
          <ShieldCheck className="h-4 w-4" /> The contract
        </p>
        <h2 className={`${ARCHIVO} mt-4 max-w-2xl text-4xl font-extrabold tracking-tight text-balance`}>
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
        <p className={`${ARCHIVO} text-xs font-bold uppercase tracking-[0.2em] text-amber`}>Capabilities</p>
        <h2 className={`${ARCHIVO} mt-4 max-w-2xl text-4xl font-extrabold tracking-tight text-balance`}>
          Everything the form throws at you, handled.
        </h2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
          {CAPS.map(([t, b]) => (
            <div key={t} className="bg-panel p-6">
              <h3 className={`${ARCHIVO} text-lg font-bold text-ink`}>{t}</h3>
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
      <h2 className={`${ARCHIVO} text-4xl font-extrabold tracking-tight text-balance`}>
        Set up your profile once. Apply on autopilot.
      </h2>
      <p className="mx-auto mt-5 max-w-xl leading-relaxed text-ink-dim">
        Create your account, upload your resume, and connect the extension. ApplyPilot takes the
        typing; you keep the final word.
      </p>
      <div className="mt-9 flex justify-center">
        <Link href="/login" className="btn-primary">
          Open dashboard
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
