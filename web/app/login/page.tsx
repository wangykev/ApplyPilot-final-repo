import { Suspense } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { isSupabaseConfigured } from "@/lib/env";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in · ApplyPilot" };

export default function LoginPage() {
  const configured = isSupabaseConfigured();
  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center px-5">
        <Link href="/" aria-label="ApplyPilot home">
          <Logo />
        </Link>
      </div>

      <main className="flex flex-1 items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <p className="eyebrow">Flight deck access</p>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">
            Open the deck
          </h1>
          <p className="mt-2 text-sm text-ink-dim">
            Sign in to upload your resume, build your profile, and sync the extension.
          </p>

          <div className="mt-8">
            {configured ? (
              <Suspense fallback={<div className="bezel h-80 animate-pulse" />}>
                <LoginForm />
              </Suspense>
            ) : (
              <NotConfigured />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="bezel p-6">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-amber" />
        <span className="font-mono text-[11px] uppercase tracking-label text-amber">
          Backend not connected
        </span>
      </div>
      <p className="mt-4 text-sm leading-relaxed text-ink-dim">
        Sign-in needs Supabase. Create a project, then set{" "}
        <code className="rounded bg-cockpit px-1 py-0.5 font-mono text-xs text-ink">
          NEXT_PUBLIC_SUPABASE_URL
        </code>{" "}
        and{" "}
        <code className="rounded bg-cockpit px-1 py-0.5 font-mono text-xs text-ink">
          NEXT_PUBLIC_SUPABASE_ANON_KEY
        </code>{" "}
        in <code className="font-mono text-xs text-ink">web/.env.local</code>, then restart the
        dev server. Setup steps are in <code className="font-mono text-xs text-ink">WEBSITE.md</code>.
      </p>
    </div>
  );
}
