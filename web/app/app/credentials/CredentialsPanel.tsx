"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  Save,
  Eye,
  EyeOff,
  Mail,
  Check,
  X,
  Loader2,
  Cable,
  ShieldAlert,
  RefreshCw,
} from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { FieldLabel } from "@/components/form/fields";
import { sendToExtension, extensionMessagingAvailable, type ExtResponse } from "@/lib/extension";
import { linkedExtensionId, liveSync } from "@/lib/extension-sync";
import { saveCredentials, saveOnboardConfig } from "./actions";
import { passwordRequirements, type Credentials, type OnboardConfig } from "@/lib/credentials";
import { clsx } from "@/lib/clsx";

type Msg = { kind: "ok" | "err"; text: string } | null;
type Gmail =
  | { s: "unknown" }
  | { s: "checking" }
  | { s: "connected"; email: string; messagesTotal?: number }
  | { s: "error"; error: string };

export function CredentialsPanel({
  initialCredentials,
  initialOnboard,
}: {
  initialCredentials: Credentials;
  initialOnboard: OnboardConfig;
}) {
  return (
    <div className="space-y-6">
      <CredentialsSection initial={initialCredentials} />
      <GmailSection initial={initialOnboard} />
    </div>
  );
}

function CredentialsSection({ initial }: { initial: Credentials }) {
  const [creds, setCreds] = useState<Credentials>(initial);
  const [saved, setSaved] = useState<Credentials>(initial);
  const [showPw, setShowPw] = useState(false);
  const [saving, startSave] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);

  const dirty = creds.email !== saved.email || creds.password !== saved.password;
  const reqs = passwordRequirements(creds.password);
  // An empty password is allowed (clears credentials); a present one must meet Workday's policy.
  const pwValid = creds.password === "" || reqs.every((r) => r.met);

  const edit = (patch: Partial<Credentials>) => {
    setCreds((c) => ({ ...c, ...patch }));
    setMsg(null);
  };

  const save = () =>
    startSave(async () => {
      const res = await saveCredentials(creds);
      if (res.ok) {
        setSaved(creds);
        setMsg({ kind: "ok", text: "Saved" });
        liveSync("credentials"); // push into a connected extension (no-op if not connected here)
      } else {
        setMsg({ kind: "err", text: res.error });
      }
    });

  return (
    <SectionCard
      title="Workday account"
      subtitle="The extension signs in with this — or creates the account on first run. Once connected, saving pushes it straight into your extension."
    >
      <div className="space-y-5">
        <div>
          <FieldLabel>Email</FieldLabel>
          <input
            type="email"
            value={creds.email}
            onChange={(e) => edit({ email: e.target.value })}
            placeholder="you+workday@gmail.com"
            autoComplete="off"
            className="mt-1.5 w-full rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
          />
        </div>

        <div>
          <FieldLabel hint="stored on your account to sync to your extension; never shown to other users">
            Password
          </FieldLabel>
          <div className="mt-1.5 flex gap-2">
            <input
              type={showPw ? "text" : "password"}
              value={creds.password}
              onChange={(e) => edit({ password: e.target.value })}
              placeholder="Workday account password"
              autoComplete="off"
              className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
            />
            <button
              type="button"
              onClick={() => setShowPw((s) => !s)}
              className="btn-ghost shrink-0 px-3 py-2"
              aria-label={showPw ? "Hide password" : "Show password"}
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {/* Workday's account-creation password policy — live checklist so first-run
              create-account never fails on the password rules. */}
          {creds.password !== "" && (
            <ul className="mt-2.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {reqs.map((r) => (
                <li
                  key={r.id}
                  className={clsx(
                    "flex items-center gap-1.5 text-xs transition-colors",
                    r.met ? "text-verified" : "text-ink-faint"
                  )}
                >
                  {r.met ? (
                    <Check className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <span className="h-3 w-3 shrink-0 rounded-full border border-current" />
                  )}
                  {r.label}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-start gap-2.5 rounded-lg border border-hairline bg-panel-raised/40 px-3.5 py-3 text-xs leading-relaxed text-ink-dim">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <span>
            Use a <span className="text-ink">dedicated throwaway account</span>, not a personal login. It&apos;s
            stored on your private account (owner-only) to sync into your extension — the same way your AI key is.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            onClick={save}
            disabled={saving || !dirty || !pwValid}
            className="btn-primary"
            title={!dirty ? "No changes to save" : !pwValid ? "Password doesn't meet Workday's requirements yet" : undefined}
          >
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : "Save credentials"}
          </button>
          {msg && (
            <span className={clsx("text-sm", msg.kind === "ok" ? "text-verified" : "text-signal")}>
              {msg.kind === "ok" ? "✓ " : ""}
              {msg.text}
            </span>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function GmailSection({ initial }: { initial: OnboardConfig }) {
  const [enabled, setEnabled] = useState(initial.gmailEnabled);
  const [gmail, setGmail] = useState<Gmail>({ s: "unknown" });
  const [connecting, setConnecting] = useState(false);
  const [toggleMsg, setToggleMsg] = useState<Msg>(null);

  const connectedHere = () => linkedExtensionId() !== null && extensionMessagingAvailable();

  // Silent status check on mount — reports whether a cached Gmail token already works,
  // without popping Chrome's account picker (interactive:false).
  useEffect(() => {
    const id = linkedExtensionId();
    if (!id || !extensionMessagingAvailable()) return;
    setGmail({ s: "checking" });
    sendToExtension(id, { type: "AP_GMAIL_CONNECT", interactive: false }).then((r: ExtResponse) => {
      if (r.ok) setGmail({ s: "connected", email: r.email as string, messagesTotal: r.messagesTotal as number });
      else setGmail({ s: "unknown" });
    });
  }, []);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    setToggleMsg(null);
    const res = await saveOnboardConfig({ gmailEnabled: next });
    if (res.ok) liveSync("onboard");
    else {
      setEnabled(!next); // revert on failure
      setToggleMsg({ kind: "err", text: res.error });
    }
  };

  const connect = async () => {
    const id = linkedExtensionId();
    if (!id || !extensionMessagingAvailable()) {
      setGmail({ s: "error", error: "Connect your extension here first." });
      return;
    }
    setConnecting(true);
    const r = await sendToExtension(id, { type: "AP_GMAIL_CONNECT", interactive: true });
    if (r.ok) setGmail({ s: "connected", email: r.email as string, messagesTotal: r.messagesTotal as number });
    else setGmail({ s: "error", error: (r.error as string) || "Couldn't connect Gmail." });
    setConnecting(false);
  };

  return (
    <SectionCard
      title="Gmail auto-verify"
      subtitle="Some tenants email a confirmation link before showing the form. With this on, the extension reads that email (read-only) and clicks the link for you."
      actions={<GmailBadge gmail={gmail} />}
    >
      <div className="space-y-5">
        {/* enable toggle */}
        <div className="flex items-center justify-between rounded-lg border border-hairline bg-panel-raised/40 p-4">
          <div>
            <div className="text-sm text-ink">Auto-verify email</div>
            <div className="mt-0.5 text-xs text-ink-dim">
              When off, an email-verify tenant halts and asks you to click the link yourself.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Gmail auto-verify"
            onClick={toggle}
            className={clsx(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-amber/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
              enabled ? "bg-amber" : "bg-panel-raised ring-1 ring-inset ring-hairline"
            )}
          >
            <span
              className={clsx(
                "inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform",
                enabled ? "translate-x-[1.375rem]" : "translate-x-0.5"
              )}
            />
          </button>
        </div>
        {toggleMsg && <p className="text-sm text-signal">{toggleMsg.text}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <button onClick={connect} disabled={connecting} className="btn-ghost">
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {connecting ? "Connecting…" : gmail.s === "connected" ? "Reconnect Gmail" : "Connect Gmail"}
          </button>
          {gmail.s === "connected" && (
            <span className="font-mono text-[11px] text-verified">
              ✓ {gmail.email}
              {gmail.messagesTotal != null ? ` · ${gmail.messagesTotal.toLocaleString()} messages` : ""}
            </span>
          )}
          {gmail.s === "error" && <span className="text-sm text-signal">{gmail.error}</span>}
        </div>

        <p className="text-xs leading-relaxed text-ink-dim">
          Connecting opens Chrome&apos;s Google account picker in the extension — Google owns that sign-in, so
          it happens in the extension, not here.{" "}
          {!connectedHere() && (
            <>
              <Link href="/app/connect" className="text-amber hover:underline">
                Connect your extension
              </Link>{" "}
              on this device first.
            </>
          )}
        </p>
      </div>
    </SectionCard>
  );
}

function GmailBadge({ gmail }: { gmail: Gmail }) {
  const map: Record<Gmail["s"], { dot: string; label: string }> = {
    unknown: { dot: "bg-ink-faint", label: "not checked" },
    checking: { dot: "bg-amber animate-blink-amber", label: "checking" },
    connected: { dot: "bg-verified", label: "connected" },
    error: { dot: "bg-signal", label: "not connected" },
  };
  const s = map[gmail.s];
  return (
    <span className="flex items-center gap-2">
      {gmail.s === "connected" ? (
        <Check className="h-4 w-4 text-verified" />
      ) : gmail.s === "error" ? (
        <X className="h-4 w-4 text-signal" />
      ) : gmail.s === "checking" ? (
        <RefreshCw className="h-4 w-4 animate-spin text-ink-dim" />
      ) : (
        <Cable className="h-4 w-4 text-ink-dim" />
      )}
      <span className={clsx("h-2 w-2 rounded-full", s.dot)} />
      <span className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{s.label}</span>
    </span>
  );
}
