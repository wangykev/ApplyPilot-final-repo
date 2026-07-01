import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/Logo";

export const metadata = { title: "Pick a design — ApplyPilot" };

const OPTIONS = [
  {
    href: "/designs/flight-deck",
    name: "Flight deck",
    tag: "The original · Space Grotesk",
    desc: "The baseline you liked: two-column hero with the live fill-status instrument panel, heading-indicator dial logo.",
    font: "var(--font-display)",
    accent: "#FFB627",
    preview: "Aa",
  },
  {
    href: "/designs/avionics",
    name: "Avionics",
    tag: "HUD · Chakra Petch",
    desc: "Heads-up display. Squared, uppercase type; a centered layout framed by reticle brackets; a top status strip; an attitude-indicator logo.",
    font: "var(--font-chakra)",
    accent: "#5BD2FF",
    preview: "AA",
  },
  {
    href: "/designs/radar",
    name: "Radar",
    tag: "Control tower · Sora",
    desc: "A live radar scope sweeps over every field it touches — verified in teal, flagged in amber. Rounded geometric type, concentric-rings logo.",
    font: "var(--font-sora)",
    accent: "#36D6A0",
    preview: "Aa",
  },
  {
    href: "/designs/cluster",
    name: "Cluster",
    tag: "Dashboard · Archivo",
    desc: "A dense cockpit instrument cluster: a bento grid of tiles — accuracy gauge, counters, field readout, submit-lock. Heavy industrial type, grid-cell logo.",
    font: "var(--font-archivo)",
    accent: "#FFB627",
    preview: "Aa",
  },
];

export default function DesignsGallery() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-5xl px-5 py-16">
        <div className="flex items-center justify-between">
          <Logo />
          <Link href="/" className="text-sm text-ink-dim transition-colors hover:text-ink">
            ← current site
          </Link>
        </div>

        <div className="mt-14">
          <p className="eyebrow">Flight-deck family</p>
          <h1 className="mt-4 max-w-2xl font-display text-4xl font-semibold tracking-tight text-balance">
            Four takes on the cockpit.
          </h1>
          <p className="mt-4 max-w-2xl leading-relaxed text-ink-dim">
            All share the dark instrument DNA and the amber &ldquo;needs-review&rdquo; accent you
            liked — they differ in typeface, layout, and logo. Open any one, then use the switcher at
            the top to flip between them. Tell me which wins and I&apos;ll apply it across the app.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {OPTIONS.map((o) => (
            <Link
              key={o.href}
              href={o.href}
              className="group bezel flex flex-col overflow-hidden transition-colors hover:border-amber/40"
            >
              <div className="flex h-28 items-end bg-cockpit">
                <div
                  className="px-5 pb-4 text-3xl font-semibold text-ink"
                  style={{ fontFamily: o.font }}
                >
                  {o.preview}
                  <span style={{ color: o.accent }}>.</span>
                </div>
              </div>
              <div className="flex flex-1 flex-col p-5">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-lg font-medium text-ink">{o.name}</h2>
                  <span
                    className="h-3 w-3 rounded-full ring-1 ring-inset ring-white/10"
                    style={{ background: o.accent }}
                  />
                </div>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-label text-ink-faint">
                  {o.tag}
                </p>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-ink-dim">{o.desc}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-dim transition-colors group-hover:text-amber">
                  View design
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
