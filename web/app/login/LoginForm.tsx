"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SITE_URL } from "@/lib/env";

type Mode = "signin" | "signup";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/app";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") ? "Sign-in failed. Please try again." : null
  );
  const [notice, setNotice] = useState<string | null>(null);

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const supabase = createClient();
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${SITE_URL}/auth/callback?next=${encodeURIComponent(next)}` },
        });
        if (error) throw error;
        setNotice("Check your email to confirm your account, then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${SITE_URL}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw error;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start Google sign-in.");
      setBusy(false);
    }
  }

  return (
    <div className="bezel p-7">
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-hairline p-1">
        {(["signin", "signup"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError(null);
              setNotice(null);
            }}
            className={`rounded-md py-2 text-sm font-medium transition-colors ${
              mode === m ? "bg-panel-raised text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            {m === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={handleGoogle}
        disabled={busy}
        className="btn-ghost mt-6 w-full"
      >
        <GoogleGlyph />
        Continue with Google
      </button>

      <div className="my-6 flex items-center gap-3">
        <span className="hairline-rule" />
        <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">or</span>
        <span className="hairline-rule" />
      </div>

      <form onSubmit={handleEmail} className="space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          required
        />
        <Field
          label="Password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          value={password}
          onChange={setPassword}
          required
          minLength={6}
        />
        {error && <p className="text-sm text-signal">{error}</p>}
        {notice && <p className="text-sm text-verified">{notice}</p>}
        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
      />
    </label>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8a12 12 0 0 1 0-24c3.1 0 5.9 1.2 8 3.1l5.7-5.7A20 20 0 1 0 24 44c11 0 19.5-8 19.5-20 0-1.2-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7A20 20 0 0 0 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C39.9 36 44 30.8 44 24c0-1.2-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}
