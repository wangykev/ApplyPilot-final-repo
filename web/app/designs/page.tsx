import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/Logo";

export const metadata = { title: "Pick a design — ApplyPilot" };

const OPTIONS = [
  {
    href: "/designs/flight-deck",
    name: "Flight deck",
    tag: "Dark · instrument panel",
    desc: "Night cockpit. Amber 'needs-review' warning light, teal verified, a live fill-status panel. The autopilot/safety theme, literal.",
    swatches: ["#0A0E14", "#FFB627", "#36D6A0", "#E6EDF5"],
    font: "var(--font-display)",
  },
  {
    href: "/designs/spec-sheet",
    name: "Spec sheet",
    tag: "Light · editorial precision",
    desc: "ApplyPilot as a precision instrument's datasheet. Cool paper, heavy Archivo display, hairline rules, a single indigo accent, a labeled 'Fig. 1' figure.",
    swatches: ["#F4F5F2", "#15171C", "#2B3CE0", "#0E7A52"],
    font: "var(--font-archivo)",
  },
  {
    href: "/designs/console",
    name: "Console",
    tag: "Minimal · monospace",
    desc: "A calm developer tool. Near-black, monochrome, JetBrains Mono throughout. The hero is a live terminal session of a fill run.",
    swatches: ["#0A0A0B", "#E6E6E1", "#58C18E", "#E0A93B"],
    font: "var(--font-jb-mono)",
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
          <p className="eyebrow">Choose a direction</p>
          <h1 className="mt-4 max-w-2xl font-display text-4xl font-semibold tracking-tight text-balance">
            Three designs. Pick the one that feels right.
          </h1>
          <p className="mt-4 max-w-2xl leading-relaxed text-ink-dim">
            Each is a complete landing page for the same product. Open any one, then use the switcher
            at the top to flip between them. Tell me which wins and I&apos;ll apply it across the whole
            app.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {OPTIONS.map((o) => (
            <Link
              key={o.href}
              href={o.href}
              className="group bezel flex flex-col overflow-hidden transition-colors hover:border-amber/40"
            >
              {/* palette band, doubling as a tiny preview of the design's mood */}
              <div className="flex h-28 items-end" style={{ background: o.swatches[0] }}>
                <div
                  className="px-5 pb-4 text-2xl font-semibold"
                  style={{ fontFamily: o.font, color: o.swatches[1] }}
                >
                  Aa
                  <span style={{ color: o.swatches[2] }}>.</span>
                </div>
              </div>
              <div className="flex flex-1 flex-col p-5">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-lg font-medium text-ink">{o.name}</h2>
                  <div className="flex gap-1">
                    {o.swatches.map((s) => (
                      <span
                        key={s}
                        className="h-3 w-3 rounded-full ring-1 ring-inset ring-white/10"
                        style={{ background: s }}
                      />
                    ))}
                  </div>
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
