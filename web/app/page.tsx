import Link from "next/link";
import {
  ShieldCheck,
  FileText,
  ListChecks,
  EyeOff,
  Layers,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { Nav } from "@/components/site/Nav";
import { Footer } from "@/components/site/Footer";
import { FillStatusPanel } from "@/components/FillStatusPanel";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />
        <Pipeline />
        <Safety />
        <Capabilities />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ Hero */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 grid-deck opacity-40" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:py-28">
        <div>
          <p className="eyebrow">Workday application autopilot</p>
          <h1 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Autopilot for
            <br />
            Workday applications.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-dim">
            Upload your resume once. ApplyPilot fills every Workday form from
            your profile, flags every guess it makes for your review, and{" "}
            <span className="text-ink">never submits without you</span>.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/login" className="btn-primary">
              Open the deck
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#how" className="btn-ghost">
              See how it flies
            </a>
          </div>
          <dl className="mt-12 flex flex-wrap gap-x-10 gap-y-4">
            <Stat k="Every guess" v="flagged for review" />
            <Stat k="Resume" v="uploaded once, attached for you" />
            <Stat k="Submit" v="always your call" />
          </dl>
        </div>

        <div className="lg:pl-4">
          <FillStatusPanel />
          <p className="mt-3 px-1 font-mono text-[11px] leading-relaxed tracking-wide text-ink-faint">
            Live: the engine fills, marks each field verified, and raises an
            amber flag on anything you should check.
          </p>
        </div>
      </div>
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="font-mono text-[11px] uppercase tracking-label text-amber">{k}</dt>
      <dd className="mt-1 text-sm text-ink-dim">{v}</dd>
    </div>
  );
}

/* -------------------------------------------------------------- Pipeline */

const STEPS = [
  {
    n: "01",
    title: "Fill",
    body: "The engine reads your profile and fills the page you are on — text, dropdowns, typeaheads, dates, repeating sections, the resume attachment.",
  },
  {
    n: "02",
    title: "Review",
    body: "Every field lands in a summary. Confident fills are marked verified; anything guessed or legally-loaded is flagged with the reason, ready for your edit.",
  },
  {
    n: "03",
    title: "Submit",
    body: "You approve, then submit — yourself. ApplyPilot walks to the review page and stops at the door. It never clicks Submit for you.",
  },
];

function Pipeline() {
  return (
    <section id="how" className="border-t border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <p className="eyebrow">The pipeline</p>
        <h2 className="mt-4 max-w-2xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Fill, review, submit — in that order, on purpose.
        </h2>
        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="bg-panel p-7">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-2xl text-amber">{s.n}</span>
                <span className="font-mono text-[11px] uppercase tracking-label text-ink-faint">
                  step
                </span>
              </div>
              <h3 className="mt-5 font-display text-xl font-medium text-ink">{s.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-ink-dim">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Safety */

function Safety() {
  return (
    <section id="safety" className="border-t border-hairline">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2">
        <div>
          <p className="eyebrow flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-verified" />
            The contract
          </p>
          <h2 className="mt-4 font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Guess, fill, flag.
            <br />
            <span className="text-amber">Never silent.</span>
          </h2>
          <p className="mt-6 max-w-lg leading-relaxed text-ink-dim">
            An application is a legal document. So ApplyPilot is built to be
            accurate, not just fast: when it is sure, it fills and verifies.
            When it has to infer — a screening question, a demographic field,
            anything it can&apos;t prove from your profile — it still fills, but
            it raises a flag and tells you why. A wrong answer is never quietly
            committed.
          </p>
          <ul className="mt-8 space-y-3">
            <SafetyItem tone="verified">
              Fields it can prove from your profile fill and read back as verified.
            </SafetyItem>
            <SafetyItem tone="amber">
              Inferred answers are filled and flagged with the reasoning behind them.
            </SafetyItem>
            <SafetyItem tone="signal">
              Legally-loaded questions — &ldquo;previously employed here?&rdquo;,
              demographics — get the loudest badge and sort to the top.
            </SafetyItem>
          </ul>
        </div>

        <div className="bezel p-6">
          <div className="flex items-center justify-between border-b border-hairline pb-4">
            <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">
              Needs review
            </span>
            <span className="font-mono text-[11px] tracking-label text-amber">02</span>
          </div>
          <ReviewRow
            badge="Truthfulness"
            tone="signal"
            label="Previously employed at this company?"
            value="No"
            reason="No match in your employer history — but this sits next to a truthfulness certification. Confirm before you submit."
          />
          <ReviewRow
            badge="AI-inferred · demographic"
            tone="amber"
            label="Gender"
            value="Prefer not to say"
            reason="Not stated in your profile. The model chose a safe default — verify or change it."
          />
        </div>
      </div>
    </section>
  );
}

function SafetyItem({
  tone,
  children,
}: {
  tone: "verified" | "amber" | "signal";
  children: React.ReactNode;
}) {
  const dot =
    tone === "verified" ? "bg-verified" : tone === "amber" ? "bg-amber" : "bg-signal";
  return (
    <li className="flex gap-3">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="text-sm leading-relaxed text-ink-dim">{children}</span>
    </li>
  );
}

function ReviewRow({
  badge,
  tone,
  label,
  value,
  reason,
}: {
  badge: string;
  tone: "amber" | "signal";
  label: string;
  value: string;
  reason: string;
}) {
  const badgeCls =
    tone === "signal"
      ? "border-signal/40 text-signal"
      : "border-amber/40 text-amber";
  return (
    <div className="border-b border-hairline/70 py-4 last:border-0">
      <span
        className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-label ${badgeCls}`}
      >
        {badge}
      </span>
      <div className="mt-2.5 flex items-baseline justify-between gap-4">
        <span className="text-sm text-ink">{label}</span>
        <span className="shrink-0 font-mono text-sm text-amber-soft">{value}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-dim">{reason}</p>
    </div>
  );
}

/* ----------------------------------------------------------- Capabilities */

const CAPS = [
  {
    icon: Layers,
    title: "Fills the hard widgets",
    body: "Dropdowns, search typeaheads, radios, checkboxes, multi-segment dates, hierarchical pickers, and repeating sections — reconciled to exactly your list.",
  },
  {
    icon: Sparkles,
    title: "Answers screening questions",
    body: "Unmapped questions are answered from your profile by an LLM that names its reasoning and rates its own confidence — then flags the answer for you.",
  },
  {
    icon: FileText,
    title: "Attaches your resume",
    body: "Upload one PDF here. It is attached to the application programmatically — no file picker, no re-uploading per job.",
  },
  {
    icon: EyeOff,
    title: "Fills while minimized",
    body: "Off-loop actuation keeps filling even when the tab is hidden or the window is minimized, so a throttled background tab doesn't stall the run.",
  },
  {
    icon: ListChecks,
    title: "Walks multi-page flows",
    body: "It advances page to page through the application and stops at the review page. A double guard means it can never click Submit on its own.",
  },
  {
    icon: ShieldCheck,
    title: "Re-reads its own work",
    body: "After a page settles, an independent audit re-reads every field against what it recorded — catching anything the form changed after the fill.",
  },
];

function Capabilities() {
  return (
    <section id="capabilities" className="border-t border-hairline">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <p className="eyebrow">On the deck</p>
        <h2 className="mt-4 max-w-2xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Everything the form throws at you, handled.
        </h2>
        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
          {CAPS.map((c) => (
            <div key={c.title} className="bg-panel p-7">
              <c.icon className="h-5 w-5 text-amber" strokeWidth={1.75} />
              <h3 className="mt-4 font-display text-lg font-medium text-ink">{c.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-dim">{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- Closing CTA */

function ClosingCta() {
  return (
    <section className="border-t border-hairline">
      <div className="relative mx-auto max-w-6xl overflow-hidden px-5 py-24">
        <div className="absolute inset-0 grid-deck opacity-30" aria-hidden />
        <div className="relative mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Set up your profile once. Apply on autopilot.
          </h2>
          <p className="mt-5 leading-relaxed text-ink-dim">
            Create your account, upload your resume, and connect the extension.
            ApplyPilot takes the typing; you keep the final word.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Link href="/login" className="btn-primary">
              Open the deck
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#how" className="btn-ghost">
              How it works
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
