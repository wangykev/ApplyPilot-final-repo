import Link from "next/link";

/**
 * Design C — "Console": minimal, monospace, near-black, monochrome except tiny
 * status dots. ApplyPilot as a calm developer tool — the hero is a terminal
 * session of a fill run. (Self-contained: literal hex + JetBrains Mono.)
 */

const INK = "text-[#E6E6E1]";
const DIM = "text-[#6F6F69]";
const MID = "text-[#9A9A92]";
const LINE = "border-[#26262A]";
const VERIFIED = "#58C18E";
const REVIEW = "#E0A93B";
const STOP = "#E06B5E";

type Row = { glyph: string; name: string; value: string; status: string; color: string };
const ROWS: Row[] = [
  { glyph: "✓", name: "first_name", value: "Kevin", status: "verified", color: VERIFIED },
  { glyph: "✓", name: "email", value: "kevin@…", status: "verified", color: VERIFIED },
  { glyph: "✓", name: "country", value: "United States", status: "verified", color: VERIFIED },
  { glyph: "✓", name: "how_did_you_hear", value: "LinkedIn", status: "verified", color: VERIFIED },
  { glyph: "⚠", name: "previously_employed", value: "No", status: "needs-review", color: REVIEW },
  { glyph: "⚠", name: "gender", value: "prefer-not-to-say", status: "needs-review", color: REVIEW },
];

export function ConsoleLanding() {
  return (
    <div
      className={`min-h-screen bg-[#0A0A0B] ${INK} font-[family-name:var(--font-jb-mono)] antialiased`}
    >
      <Header />
      <main className="mx-auto max-w-4xl px-5">
        <Hero />
        <Manual />
        <Capabilities />
        <Safety />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className={`border-b ${LINE}`}>
      <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-5 text-sm">
        <span className="flex items-center gap-2">
          <span style={{ color: REVIEW }}>◆</span>
          <span className="font-bold tracking-tight">applypilot</span>
        </span>
        <nav className={`hidden items-center gap-6 ${DIM} sm:flex`}>
          <a href="#how" className="hover:text-[#E6E6E1]">how</a>
          <a href="#caps" className="hover:text-[#E6E6E1]">capabilities</a>
          <a href="#safety" className="hover:text-[#E6E6E1]">safety</a>
        </nav>
        <Link href="/login" className="text-[#E6E6E1] underline-offset-4 hover:underline">
          open →
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="py-16">
      <p className={`text-sm ${DIM}`}># autopilot for workday applications</p>
      <h1 className="mt-3 text-2xl font-bold leading-snug sm:text-3xl">
        It fills the form. It flags every guess.
        <br />
        It never submits without you.
      </h1>

      {/* terminal window */}
      <div className={`mt-9 overflow-hidden rounded-lg border ${LINE} bg-[#131316]`}>
        <div className={`flex items-center gap-2 border-b ${LINE} px-4 py-2.5`}>
          <span className="h-2.5 w-2.5 rounded-full bg-[#3a3a3e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#3a3a3e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#3a3a3e]" />
          <span className={`ml-2 text-[12px] ${DIM}`}>applypilot — fill --review</span>
        </div>
        <div className="space-y-1.5 p-5 text-[13px] leading-relaxed">
          <div>
            <span style={{ color: VERIFIED }}>$</span> applypilot fill <span className={MID}>--review</span>
          </div>
          <div className={DIM}>→ my information · page 1/4</div>
          <div className="h-1.5" />
          {ROWS.map((r) => (
            <div key={r.name} className="flex items-center gap-3">
              <span className="w-3 shrink-0" style={{ color: r.color }}>{r.glyph}</span>
              <span className="w-44 shrink-0 truncate">{r.name}</span>
              <span className={`flex-1 truncate ${MID}`}>{r.value}</span>
              <span className="w-32 shrink-0 text-right" style={{ color: r.color }}>{r.status}</span>
            </div>
          ))}
          <div className={`my-2 border-t ${LINE}`} />
          <div className={MID}>
            <span style={{ color: VERIFIED }}>9 filled</span> ·{" "}
            <span style={{ color: REVIEW }}>2 flagged</span> · 0 submitted
          </div>
          <div>
            <span className={DIM}>awaiting review</span>
            <span className="ml-0.5 inline-block h-3.5 w-2 translate-y-0.5 animate-pulse bg-[#E6E6E1]" />
          </div>
        </div>
      </div>

      <div className="mt-9 flex flex-wrap items-center gap-4">
        <Link
          href="/login"
          className="rounded border border-[#E6E6E1] px-5 py-2.5 text-sm font-medium text-[#E6E6E1] transition-colors hover:bg-[#E6E6E1] hover:text-[#0A0A0B]"
        >
          [ open applypilot ]
        </Link>
        <span className={`text-sm ${DIM}`}>upload your resume once · sync to the extension</span>
      </div>
    </section>
  );
}

const ENTRIES = [
  ["fill", "reads your profile and fills the page you're on — text, choices, multi-segment dates, repeating sections, and the resume attachment."],
  ["review", "every field lands in a summary. confident fills read as verified; anything guessed or legally-loaded is flagged with the reason."],
  ["submit", "you approve, then submit yourself. the engine walks to the review page and stops at the door — it never clicks submit."],
];

function Manual() {
  return (
    <section id="how" className={`border-t ${LINE} py-16`}>
      <p className={`text-sm ${DIM}`}>## pipeline — fill · review · submit</p>
      <div className="mt-8 space-y-7">
        {ENTRIES.map(([k, v], i) => (
          <div key={k} className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr]">
            <div className="flex items-baseline gap-3">
              <span className={DIM}>{String(i + 1).padStart(2, "0")}</span>
              <span className="text-lg font-bold">{k}</span>
            </div>
            <p className={`text-sm leading-relaxed ${MID}`}>{v}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const CAPS = [
  "fills dropdowns, typeaheads, radios, checkboxes, dates, hierarchical pickers",
  "reconciles repeating sections to exactly your list",
  "answers screening questions from your profile, with reasoning + confidence",
  "attaches your resume programmatically — no file picker",
  "fills while the tab is minimized (off-loop actuation)",
  "walks multi-page flows; a double guard means it can't click submit",
  "re-reads its own work after the page settles",
];

function Capabilities() {
  return (
    <section id="caps" className={`border-t ${LINE} py-16`}>
      <p className={`text-sm ${DIM}`}>## capabilities</p>
      <ul className="mt-8 space-y-2.5 text-sm">
        {CAPS.map((c) => (
          <li key={c} className="flex gap-3">
            <span className={DIM}>-</span>
            <span className={MID}>{c}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Safety() {
  const items = [
    { tone: STOP, badge: "truthfulness", name: "previously_employed", value: "No", note: "no match in employer history, but adjacent to a truthfulness certification — confirm." },
    { tone: REVIEW, badge: "demographic", name: "gender", value: "prefer-not-to-say", note: "not stated in your profile; a safe default was chosen — verify or change it." },
  ];
  return (
    <section id="safety" className={`border-t ${LINE} py-16`}>
      <p className={`text-sm ${DIM}`}>## safety — guess, fill, flag · never silent</p>
      <p className={`mt-6 max-w-2xl text-sm leading-relaxed ${MID}`}>
        an application is a legal document. when applypilot is sure, it fills and verifies. when it
        has to infer, it still fills — but raises a flag and tells you why. a wrong answer is never
        quietly committed.
      </p>
      <div className={`mt-8 rounded-lg border ${LINE} bg-[#131316] p-5`}>
        <div className={`mb-3 text-[12px] ${DIM}`}># needs_review (2)</div>
        <div className="space-y-4">
          {items.map((it) => (
            <div key={it.name} className="text-[13px]">
              <div className="flex items-center gap-3">
                <span style={{ color: it.tone }}>⚠</span>
                <span className="w-44 shrink-0 truncate">{it.name}</span>
                <span className={`flex-1 ${MID}`}>{it.value}</span>
                <span className="shrink-0" style={{ color: it.tone }}>[{it.badge}]</span>
              </div>
              <p className={`mt-1 pl-6 ${DIM}`}>{it.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className={`border-t ${LINE} py-16`}>
      <h2 className="text-xl font-bold sm:text-2xl">set up once. apply on autopilot.</h2>
      <p className={`mt-3 max-w-xl text-sm leading-relaxed ${MID}`}>
        create your account, upload your resume, and connect the extension. applypilot takes the
        typing; you keep the final word.
      </p>
      <Link
        href="/login"
        className="mt-7 inline-block rounded border border-[#E6E6E1] px-5 py-2.5 text-sm font-medium text-[#E6E6E1] transition-colors hover:bg-[#E6E6E1] hover:text-[#0A0A0B]"
      >
        [ open applypilot ]
      </Link>
    </section>
  );
}

function Footer() {
  return (
    <footer className={`border-t ${LINE}`}>
      <div className={`mx-auto max-w-4xl px-5 py-8 text-[12px] ${DIM}`}>
        # applypilot v0.1 — it never submits an application on its own. the review gate is yours.
      </div>
    </footer>
  );
}
