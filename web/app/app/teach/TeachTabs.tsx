"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "@/lib/clsx";

/**
 * Section switcher for the Teach area — the same reasoning as AiTabs: both halves answer "make the
 * AI smarter from what I approved", so the essay library belongs beside the question queue rather
 * than as a fifteenth sidebar entry.
 *
 * ⚠ They are TABS, not stacked sections, because the two have opposite lifecycles: Questions is a
 * queue you clear to empty, Essays is a library you keep and add to. Stacked, an empty queue would
 * sit above a growing library and read like the page was broken.
 */
const TABS = [
  { href: "/app/teach", label: "Questions" },
  { href: "/app/teach/essays", label: "My essays" },
];

export function TeachTabs() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 border-b border-hairline" aria-label="Teach sections">
      {TABS.map((t) => {
        // Exact match, not startsWith: /app/teach is a prefix of /app/teach/essays, so a prefix
        // test would light up both tabs on the essays page.
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
