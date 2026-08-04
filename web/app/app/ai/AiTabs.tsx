"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "@/lib/clsx";

/**
 * Section switcher for the AI area. Usage is a page WITHIN AI rather than a sidebar
 * sibling: "what is my AI costing me" is a question about the AI setup, so it belongs
 * beside the thing it measures — and it keeps the top-level nav from growing an entry per
 * view of the same subject.
 *
 * Lives in the AI layout, so both pages show it and the active one is derived from the
 * path rather than passed down.
 */
const TABS = [
  { href: "/app/ai", label: "Configuration" },
  { href: "/app/ai/usage", label: "Usage & cost" },
];

export function AiTabs() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 border-b border-hairline" aria-label="AI sections">
      {TABS.map((t) => {
        // Exact match, not startsWith: /app/ai is a prefix of /app/ai/usage, so a prefix
        // test would light up both tabs on the usage page.
        const active = path === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-amber font-medium text-amber"
                : "border-transparent text-ink-dim hover:text-ink"
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
