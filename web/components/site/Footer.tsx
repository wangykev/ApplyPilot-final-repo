import Link from "next/link";
import { Logo } from "@/components/Logo";

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between">
        <Logo />
        <p className="max-w-md font-mono text-[11px] leading-relaxed tracking-wide text-ink-faint">
          ApplyPilot fills the form you are already on. It never submits an
          application on its own — the review gate is yours.
        </p>
        <div className="flex items-center gap-4">
          {/* ⚠ Google OAuth verification for the restricted gmail.readonly scope
              requires the privacy policy to be linked from the app's HOME PAGE,
              not just reachable by URL. Do not remove this link. */}
          <Link
            href="/privacy"
            className="font-mono text-[11px] tracking-label text-ink-faint transition-colors hover:text-amber"
          >
            PRIVACY
          </Link>
          <span className="font-mono text-[11px] tracking-label text-ink-faint">
            v0.1 · DEV
          </span>
        </div>
      </div>
    </footer>
  );
}
