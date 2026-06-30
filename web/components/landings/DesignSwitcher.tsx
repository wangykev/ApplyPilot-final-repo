import Link from "next/link";

export type DesignKey = "flight-deck" | "spec-sheet" | "console";

export const DESIGNS: { key: DesignKey; label: string; href: string }[] = [
  { key: "flight-deck", label: "Flight deck", href: "/designs/flight-deck" },
  { key: "spec-sheet", label: "Spec sheet", href: "/designs/spec-sheet" },
  { key: "console", label: "Console", href: "/designs/console" },
];

/** A neutral floating switcher so you can flip between the three directions.
 *  Dark, legible on any background; sits above each design. */
export function DesignSwitcher({ current }: { current: DesignKey }) {
  return (
    <div className="fixed left-1/2 top-4 z-[100] -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-full border border-white/15 bg-black/80 p-1 shadow-lg backdrop-blur">
        <span className="px-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
          Design
        </span>
        {DESIGNS.map((d) => {
          const active = d.key === current;
          return (
            <Link
              key={d.key}
              href={d.href}
              className={
                "rounded-full px-3 py-1.5 font-mono text-[11px] tracking-wide transition-colors " +
                (active ? "bg-white text-black" : "text-white/70 hover:bg-white/10 hover:text-white")
              }
            >
              {d.label}
            </Link>
          );
        })}
        <Link
          href="/designs"
          className="rounded-full px-2.5 py-1.5 font-mono text-[11px] text-white/40 transition-colors hover:text-white"
          aria-label="All designs"
        >
          ✦
        </Link>
      </div>
    </div>
  );
}
