import Link from "next/link";
import { Logo } from "@/components/Logo";

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline/70 bg-cockpit/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Link href="/" aria-label="ApplyPilot home">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-8 md:flex">
          <a href="#how" className="text-sm text-ink-dim transition-colors hover:text-ink">
            How it works
          </a>
          <a href="#safety" className="text-sm text-ink-dim transition-colors hover:text-ink">
            Safety
          </a>
          <a href="#capabilities" className="text-sm text-ink-dim transition-colors hover:text-ink">
            Capabilities
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/login" className="hidden text-sm text-ink-dim transition-colors hover:text-ink sm:inline">
            Sign in
          </Link>
          <Link href="/login" className="btn-primary">
            Open the deck
          </Link>
        </div>
      </div>
    </header>
  );
}
