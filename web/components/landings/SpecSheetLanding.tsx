import Link from "next/link";
import { LogoMark } from "@/components/Logo";

/**
 * Design B — "Spec sheet": light, editorial-precision. ApplyPilot presented like
 * a precision instrument's datasheet. Cool paper, Archivo display, hairline rules,
 * a single indigo accent, mono annotations. (Self-contained: literal hex so it
 * doesn't touch the flight-deck tokens.)
 */

const INK = "text-[#15171C]";
const SOFT = "text-[#5A616B]";
const FAINT = "text-[#9298A2]";
const ACCENT = "text-[#2B3CE0]";
const RULE = "border-[#DBDEE4]";
const mono = "font-[family-name:var(--font-mono)]";

export function SpecSheetLanding() {
  return (
    <div
      className={`min-h-screen bg-[#F4F5F2] ${INK} font-[family-name:var(--font-archivo)] antialiased`}
    >
      <Header />
      <Hero />
      <Spec />
      <Pipeline />
      <Safety />
      <Capabilities />
      <Cta />
      <Footer />
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className={`${mono} text-[11px] uppercase tracking-[0.2em] ${ACCENT}`}>{children}</p>
  );
}

function Header() {
  return (
    <header className={`border-b ${RULE}`}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <span className="flex items-center gap-2.5">
          <LogoMark className="h-7 w-7" />
          <span className="text-lg font-bold tracking-tight">ApplyPilot</span>
        </span>
        <nav className={`hidden items-center gap-8 text-sm ${SOFT} md:flex`}>
          <a href="#spec" className="hover:text-[#15171C]">Specification</a>
          <a href="#how" className="hover:text-[#15171C]">Pipeline</a>
          <a href="#safety" className="hover:text-[#15171C]">Safety</a>
        </nav>
        <Link
          href="/login"
          className="rounded-md bg-[#15171C] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2B3CE0]"
        >
          Open ApplyPilot
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className={`border-b ${RULE}`}>
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-20 lg:grid-cols-[1.05fr_0.95fr]">
        <div>
          <Eyebrow>Datasheet · Workday autopilot</Eyebrow>
          <h1 className="mt-6 text-5xl font-extrabold leading-[0.98] tracking-tight text-balance sm:text-6xl">
            The application autopilot, specified.
          </h1>
          <p className={`mt-6 max-w-xl text-lg leading-relaxed ${SOFT}`}>
            Upload your resume once. ApplyPilot fills every Workday form from your profile, flags
            every guess it makes for your review, and{" "}
            <span className={INK}>never submits without you.</span>
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/login"
              className="rounded-md bg-[#2B3CE0] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1f2db0]"
            >
              Open ApplyPilot
            </Link>
            <a
              href="#spec"
              className={`rounded-md border ${RULE} px-5 py-2.5 text-sm font-medium ${INK} transition-colors hover:border-[#15171C]`}
            >
              Read the spec
            </a>
          </div>
        </div>

        <Figure />
      </div>
    </section>
  );
}

const FIG_ROWS: { label: string; value: string; tag: "FILLED" | "REVIEW" }[] = [
  { label: "First name", value: "Kevin", tag: "FILLED" },
  { label: "Email", value: "kevin@…", tag: "FILLED" },
  { label: "Country", value: "United States", tag: "FILLED" },
  { label: "How did you hear?", value: "LinkedIn", tag: "FILLED" },
  { label: "Previously employed here?", value: "No", tag: "REVIEW" },
  { label: "Gender", value: "Prefer not to say", tag: "REVIEW" },
];

function Figure() {
  return (
    <figure>
      <div className={`overflow-hidden rounded-lg border ${RULE} bg-white shadow-[0_1px_0_rgba(0,0,0,0.03),0_24px_48px_-32px_rgba(20,23,28,0.25)]`}>
        <div className={`flex items-center justify-between border-b ${RULE} px-4 py-2.5`}>
          <span className={`${mono} text-[11px] uppercase tracking-[0.18em] ${FAINT}`}>
            Fig. 1 — My Information
          </span>
          <span className={`${mono} text-[11px] tracking-[0.18em] ${FAINT}`}>PAGE 1/4</span>
        </div>
        <table className="w-full border-collapse text-sm">
          <tbody>
            {FIG_ROWS.map((r) => (
              <tr key={r.label} className={`border-b ${RULE} last:border-0`}>
                <td className={`${mono} px-4 py-3 text-[12px] ${SOFT}`}>{r.label}</td>
                <td className="px-4 py-3 font-medium">{r.value}</td>
                <td className="px-4 py-3 text-right">
                  <Tag kind={r.tag} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className={`mt-3 ${mono} text-[11px] leading-relaxed ${FAINT}`}>
        Each field is filled, then labeled: verified when proven from your profile, flagged when
        inferred.
      </figcaption>
    </figure>
  );
}

function Tag({ kind }: { kind: "FILLED" | "REVIEW" }) {
  const cls =
    kind === "FILLED"
      ? "border-[#0E7A52]/30 text-[#0E7A52] bg-[#0E7A52]/[0.06]"
      : "border-[#B26B00]/30 text-[#B26B00] bg-[#B26B00]/[0.07]";
  return (
    <span
      className={`${mono} inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] ${cls}`}
    >
      {kind}
    </span>
  );
}

const SPECS: { k: string; v: string }[] = [
  { k: "Targets", v: "Workday application flows (*.myworkdayjobs.com)" },
  { k: "Fills", v: "Text · dropdowns · search typeaheads · radios · checkboxes · multi-segment dates" },
  { k: "Repeating sections", v: "Work experience · education · websites · languages · certifications" },
  { k: "Documents", v: "Resume attached programmatically — uploaded once" },
  { k: "Screening", v: "Answered by an LLM that names its reasoning and rates confidence" },
  { k: "Review", v: "Every field summarized; inferred answers flagged with the reason" },
  { k: "Submit", v: "Manual — the engine stops at the review page, never clicks Submit" },
];

function Spec() {
  return (
    <section id="spec" className={`border-b ${RULE}`}>
      <div className="mx-auto max-w-6xl px-6 py-20">
        <Eyebrow>Specification</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-4xl font-extrabold tracking-tight text-balance">
          What it does, line by line.
        </h2>
        <dl className={`mt-10 border-t ${RULE}`}>
          {SPECS.map((s) => (
            <div
              key={s.k}
              className={`grid grid-cols-1 gap-1 border-b ${RULE} py-4 sm:grid-cols-[220px_1fr] sm:gap-6`}
            >
              <dt className={`${mono} text-[12px] uppercase tracking-[0.14em] ${FAINT}`}>{s.k}</dt>
              <dd className={`text-[15px] ${INK}`}>{s.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

const STEPS = [
  { n: "01", t: "Fill", b: "The engine reads your profile and fills the page you're on — text, choices, dates, repeating sections, the resume." },
  { n: "02", t: "Review", b: "Every field lands in a summary. Confident fills read as verified; guesses are flagged with the reason." },
  { n: "03", t: "Submit", b: "You approve, then submit yourself. ApplyPilot walks to the review page and stops at the door." },
];

function Pipeline() {
  return (
    <section id="how" className={`border-b ${RULE}`}>
      <div className="mx-auto max-w-6xl px-6 py-20">
        <Eyebrow>Operating sequence</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-4xl font-extrabold tracking-tight text-balance">
          Fill, review, submit — in that order, on purpose.
        </h2>
        <div className="mt-12 grid gap-10 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className={`border-t-2 border-[#2B3CE0] pt-5`}>
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-extrabold tracking-tight">{s.n}</span>
                <span className={`${mono} text-[11px] uppercase tracking-[0.18em] ${FAINT}`}>step</span>
              </div>
              <h3 className="mt-4 text-xl font-bold">{s.t}</h3>
              <p className={`mt-2 text-sm leading-relaxed ${SOFT}`}>{s.b}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Safety() {
  return (
    <section id="safety" className={`border-b ${RULE}`}>
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
        <div>
          <Eyebrow>The contract</Eyebrow>
          <h2 className="mt-4 text-4xl font-extrabold tracking-tight text-balance">
            Guess, fill, flag. <span className={ACCENT}>Never silent.</span>
          </h2>
          <p className={`mt-6 max-w-lg leading-relaxed ${SOFT}`}>
            An application is a legal document, so ApplyPilot is built to be accurate, not just
            fast. When it&apos;s sure, it fills and verifies. When it has to infer, it still fills —
            but raises a flag and tells you why. A wrong answer is never quietly committed.
          </p>
          <ul className="mt-8 space-y-4">
            {[
              ["#0E7A52", "Fields proven from your profile fill and read back as verified."],
              ["#B26B00", "Inferred answers are filled and flagged with the reasoning behind them."],
              ["#C2362F", "Legally-loaded questions get the loudest badge and sort to the top."],
            ].map(([c, t]) => (
              <li key={t} className="flex gap-3">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: c }} />
                <span className={`text-sm leading-relaxed ${SOFT}`}>{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className={`rounded-lg border ${RULE} bg-white p-6`}>
          <div className={`flex items-center justify-between border-b ${RULE} pb-3`}>
            <span className={`${mono} text-[11px] uppercase tracking-[0.18em] ${FAINT}`}>Needs review</span>
            <span className={`${mono} text-[11px] tracking-[0.18em] text-[#B26B00]`}>02</span>
          </div>
          {[
            { badge: "Truthfulness", tone: "#C2362F", label: "Previously employed at this company?", value: "No", reason: "No match in your employer history — but this sits next to a truthfulness certification. Confirm before you submit." },
            { badge: "AI-inferred · demographic", tone: "#B26B00", label: "Gender", value: "Prefer not to say", reason: "Not stated in your profile. The model chose a safe default — verify or change it." },
          ].map((r) => (
            <div key={r.label} className={`border-b ${RULE} py-4 last:border-0`}>
              <span
                className={`${mono} inline-block rounded border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]`}
                style={{ color: r.tone, borderColor: `${r.tone}55` }}
              >
                {r.badge}
              </span>
              <div className="mt-2.5 flex items-baseline justify-between gap-4">
                <span className="text-sm font-medium">{r.label}</span>
                <span className={`${mono} shrink-0 text-sm`} style={{ color: r.tone }}>{r.value}</span>
              </div>
              <p className={`mt-2 text-xs leading-relaxed ${SOFT}`}>{r.reason}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const CAPS = [
  ["Fills the hard widgets", "Dropdowns, typeaheads, radios, checkboxes, multi-segment dates, hierarchical pickers, repeating sections — reconciled to exactly your list."],
  ["Answers screening questions", "Unmapped questions are answered from your profile by an LLM that names its reasoning and rates its confidence, then flags the answer."],
  ["Attaches your resume", "Upload one PDF. It's attached to the application programmatically — no file picker, no re-uploading per job."],
  ["Fills while minimized", "Off-loop actuation keeps filling even when the tab is hidden, so a throttled background tab doesn't stall the run."],
  ["Walks multi-page flows", "Advances page to page and stops at the review page. A double guard means it can never click Submit on its own."],
  ["Re-reads its own work", "After a page settles, an independent audit re-reads every field against what it recorded — catching late changes."],
];

function Capabilities() {
  return (
    <section className={`border-b ${RULE}`}>
      <div className="mx-auto max-w-6xl px-6 py-20">
        <Eyebrow>Capabilities</Eyebrow>
        <h2 className="mt-4 max-w-2xl text-4xl font-extrabold tracking-tight text-balance">
          Everything the form throws at you, handled.
        </h2>
        <div className={`mt-12 grid gap-px border ${RULE} bg-[#DBDEE4] sm:grid-cols-2 lg:grid-cols-3`}>
          {CAPS.map(([t, b]) => (
            <div key={t} className="bg-white p-7">
              <h3 className="text-lg font-bold">{t}</h3>
              <p className={`mt-2 text-sm leading-relaxed ${SOFT}`}>{b}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24 text-center">
      <h2 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tight text-balance">
        Set up your profile once. Apply on autopilot.
      </h2>
      <p className={`mx-auto mt-5 max-w-xl leading-relaxed ${SOFT}`}>
        Create your account, upload your resume, and connect the extension. ApplyPilot takes the
        typing; you keep the final word.
      </p>
      <div className="mt-9 flex justify-center">
        <Link
          href="/login"
          className="rounded-md bg-[#2B3CE0] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#1f2db0]"
        >
          Open ApplyPilot
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className={`border-t ${RULE}`}>
      <div className={`mx-auto flex max-w-6xl items-center justify-between px-6 py-8 ${mono} text-[11px] ${FAINT}`}>
        <span>ApplyPilot</span>
        <span>It never submits an application on its own — the review gate is yours.</span>
        <span>v0.1</span>
      </div>
    </footer>
  );
}
