import { AlertTriangle, ExternalLink } from "lucide-react";

/**
 * How to get a Gemini key, and what to do when Google refuses to make one.
 *
 * Gemini leads because it is the only provider of the three with a free tier you can reach
 * without a card, and the extension's default model is one of its free-tier models — so a
 * new user can finish setup and run a real application without spending anything.
 *
 * The age callout is not a footnote. Google gates Gemini API access on the account's stated
 * age, and the refusal it shows says nothing about why — people conclude the key is broken,
 * or that they typed it wrong, and give up on the step entirely.
 */

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-baseline gap-1 text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
  >
    {children}
    <ExternalLink className="h-3 w-3 shrink-0 self-center" />
  </a>
);

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <li className="flex gap-3">
    <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-hairline font-mono text-[10px] text-ink-dim">
      {n}
    </span>
    <span className="min-w-0 flex-1 text-sm leading-relaxed text-ink-dim">{children}</span>
  </li>
);

export function GeminiGuide() {
  return (
    <div className="space-y-5">
      <ol className="space-y-3">
        <Step n={1}>
          Open <A href="https://aistudio.google.com/apikey">Google AI Studio → API keys</A> and sign in with
          the Google account you want the usage metered against.
        </Step>
        <Step n={2}>
          Click <span className="text-ink">Create API key</span>. Pick an existing Google Cloud project, or
          let AI Studio make one for you — either is fine.
        </Step>
        <Step n={3}>
          Copy the key and paste it below, then press <span className="text-ink">Add</span>. It is shown in
          full only once, so grab it before closing the dialog.
        </Step>
        <Step n={4}>
          Mark it <span className="text-ink">Free</span> or <span className="text-ink">Paid</span> to match
          the project it came from. A free-tier key and a billed one are byte-identical strings, so nothing
          here can tell them apart — only you can.
        </Step>
        <Step n={5}>
          Press <span className="text-ink">Test</span> on the key. That round-trips a real prompt, so a typo
          or a dead key is caught now rather than halfway through your first application.
        </Step>
      </ol>

      {/* ── Pro / paid models ─────────────────────────────────────────────── */}
      <div className="rounded-lg border border-hairline bg-panel-raised/40 p-4">
        <h4 className="text-sm text-ink">Using Gemini Pro</h4>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          The Pro models are <span className="text-ink">not on the free tier</span>. A free key pointed at one
          fails on its first request, so while every Gemini key you hold is marked free, only free-tier models
          are offered. To reach Pro:
        </p>
        <ol className="mt-3 space-y-3">
          <Step n={1}>
            Enable billing on the key&apos;s Google Cloud project — in AI Studio the key&apos;s row links
            straight to it, or use the <A href="https://console.cloud.google.com/billing">Cloud billing console</A>.
          </Step>
          <Step n={2}>
            Add that key here (or switch an existing one) and set its tier to{" "}
            <span className="text-ink">Paid</span>. The Pro models appear in the model list as soon as one paid
            Gemini key exists.
          </Step>
        </ol>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">
          Keeping a free key alongside a paid one costs nothing: free keys are always spent first, so the paid
          one only picks up what the free allowance can&apos;t cover.
        </p>
      </div>

      {/* ── The failure everyone hits ─────────────────────────────────────── */}
      <div className="rounded-lg border border-amber/40 bg-amber/[0.06] p-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber" />
          <h4 className="font-mono text-[11px] uppercase tracking-label text-amber">
            If Google won&apos;t create a key
          </h4>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">
          Nine times out of ten it is your <span className="text-ink">age</span>, not your account. Google
          blocks the Gemini API for Google accounts whose birthday puts them{" "}
          <span className="text-ink">under 18</span>, and the message it shows doesn&apos;t say so — the
          Create-API-key button simply fails, or reports that the key isn&apos;t available for this account.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">
          Fix it in <A href="https://myaccount.google.com/personal-info">your Google account&apos;s personal
          info</A>: set your birthday so the account reads as{" "}
          <span className="text-ink">18 or over</span>, then reload AI Studio and create the key again. The
          change can take a few minutes to take effect.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-dim">
          Still refused? A school or work (Google Workspace) account can have the API turned off by its
          administrator — that one you cannot fix yourself, so use a personal Google account instead.
        </p>
      </div>
    </div>
  );
}
