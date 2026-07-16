"use client";

import { useEffect, useState } from "react";
import { Cable, RefreshCw, ArrowUpFromLine, Link2, Check, X, Minus, ChevronDown } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { pingExtension, sendToExtension, type ExtResponse } from "@/lib/extension";
import { getSyncBundle, getSession } from "./actions";
import { clsx } from "@/lib/clsx";

type Conn =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "connected"; version?: string; hasProfile?: boolean; hasResume?: boolean }
  | { state: "error"; error: string };

type Step = { label: string; ok: boolean | null; msg: string };

const LS_KEY = "applypilot.extensionId";

export function ConnectPanel({ initialExtId }: { initialExtId: string }) {
  const [extId, setExtId] = useState(initialExtId);
  const [conn, setConn] = useState<Conn>({ state: "idle" });
  const [steps, setSteps] = useState<Step[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (!initialExtId) {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) setExtId(saved);
    }
  }, [initialExtId]);

  const persist = (id: string) => {
    setExtId(id);
    try {
      localStorage.setItem(LS_KEY, id);
    } catch {
      /* ignore */
    }
  };

  async function check() {
    if (!extId.trim()) {
      setConn({ state: "error", error: "Enter your extension ID first." });
      return;
    }
    setConn({ state: "checking" });
    const r = await pingExtension(extId.trim());
    if (r.ok) {
      setConn({
        state: "connected",
        version: r.version as string,
        hasProfile: r.hasProfile as boolean,
        hasResume: r.hasResume as boolean,
      });
    } else {
      setConn({ state: "error", error: r.error ?? "Couldn't reach the extension." });
    }
  }

  function rowFor(label: string, r: ExtResponse): Step {
    return { label, ok: !!r.ok, msg: r.ok ? "synced" : r.error ?? "failed" };
  }

  async function sync() {
    if (!extId.trim()) {
      setConn({ state: "error", error: "Enter your extension ID first." });
      return;
    }
    setSyncing(true);
    setSteps([]);
    const res = await getSyncBundle();
    if (!res.ok) {
      setSteps([{ label: "Gather your data", ok: false, msg: res.error }]);
      setSyncing(false);
      return;
    }
    const b = res.bundle;
    const id = extId.trim();
    const log: Step[] = [];

    log.push(rowFor("AI config", await sendToExtension(id, { type: "AP_SET_LLM", llmConfig: b.llmConfig })));
    setSteps([...log]);

    log.push(
      rowFor(
        "Profile, buckets, defaults & job context",
        await sendToExtension(id, {
          type: "AP_SYNC_PROFILE",
          profile: b.profile,
          defaults: b.defaults,
          buckets: b.buckets,
          jobContext: b.jobContext,
        })
      )
    );
    setSteps([...log]);

    log.push(
      rowFor(
        "Reporting link",
        await sendToExtension(id, {
          type: "AP_SET_SESSION",
          ingestUrl: b.session.ingestUrl,
          ingestKey: b.session.ingestKey,
        })
      )
    );
    setSteps([...log]);

    if (b.resume) {
      log.push(rowFor("Resume", await sendToExtension(id, { type: "AP_SYNC_RESUME", ...b.resume })));
    } else {
      log.push({ label: "Resume", ok: null, msg: "none uploaded — skipped" });
    }
    setSteps([...log]);

    setSyncing(false);
    check();
  }

  // Send ONLY the reporting credential — leaves the extension's own profile /
  // resume / AI config alone. For testing fills with the profile you loaded in
  // the extension while still getting Tracker reports.
  async function linkTracking() {
    if (!extId.trim()) {
      setConn({ state: "error", error: "Enter your extension ID first." });
      return;
    }
    setSyncing(true);
    setSteps([]);
    const res = await getSession();
    if (!res.ok) {
      setSteps([{ label: "Get reporting credential", ok: false, msg: res.error }]);
      setSyncing(false);
      return;
    }
    const r = await sendToExtension(extId.trim(), {
      type: "AP_SET_SESSION",
      ingestUrl: res.session.ingestUrl,
      ingestKey: res.session.ingestKey,
    });
    setSteps([rowFor("Reporting link (profile untouched)", r)]);
    setSyncing(false);
    check();
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="Connect your extension"
        subtitle="Paste the ID of your installed ApplyPilot extension. We check the link, then push your data straight into it."
        actions={<ConnBadge conn={conn} />}
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={extId}
            onChange={(e) => persist(e.target.value.trim())}
            placeholder="extension id (e.g. abcdefghijklmnopabcdefghijklmnop)"
            className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
          />
          <button onClick={check} disabled={conn.state === "checking"} className="btn-ghost shrink-0">
            <RefreshCw className={clsx("h-4 w-4", conn.state === "checking" && "animate-spin")} />
            Check connection
          </button>
        </div>

        {conn.state === "connected" && (
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-verified/30 bg-verified/[0.05] px-4 py-3 text-sm">
            <span className="flex items-center gap-2 text-verified">
              <Check className="h-4 w-4" /> Connected
            </span>
            <span className="font-mono text-[11px] text-ink-dim">v{conn.version}</span>
            <span className="font-mono text-[11px] text-ink-dim">
              profile {conn.hasProfile ? "✓" : "—"} · resume {conn.hasResume ? "✓" : "—"}
            </span>
          </div>
        )}
        {conn.state === "error" && <p className="mt-4 text-sm text-signal">{conn.error}</p>}

        <button
          type="button"
          onClick={() => setShowHelp((s) => !s)}
          className="mt-4 inline-flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink"
        >
          <ChevronDown className={clsx("h-3.5 w-3.5 transition-transform", showHelp && "rotate-180")} />
          Where do I find my extension ID?
        </button>
        {showHelp && (
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-ink-dim">
            <li>
              Open <code className="font-mono text-ink">chrome://extensions</code> and turn on{" "}
              <span className="text-ink">Developer mode</span> (top right).
            </li>
            <li>Find the ApplyPilot card — the ID is the long string under its name.</li>
            <li>Copy it and paste it above. We remember it on this device.</li>
          </ol>
        )}
      </SectionCard>

      <SectionCard
        title="Sync to extension"
        subtitle="Push your website data into the extension, or just link reporting so your fills show up in the Tracker."
      >
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={sync} disabled={syncing} className="btn-primary">
            <ArrowUpFromLine className="h-4 w-4" />
            {syncing ? "Working…" : "Sync everything"}
          </button>
          <button onClick={linkTracking} disabled={syncing} className="btn-ghost">
            <Link2 className="h-4 w-4" />
            Link for tracking only
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-dim">
          <span className="text-ink">Sync everything</span> overwrites the extension&apos;s profile, resume, and AI config
          with the website&apos;s. <span className="text-ink">Link for tracking only</span> sends just the reporting
          credential — use this to keep the profile you loaded in the extension and still have fills land in the Tracker.
        </p>

        {steps.length > 0 && (
          <ul className="mt-5 space-y-2">
            {steps.map((s, i) => (
              <li
                key={i}
                className="flex items-center gap-3 rounded-lg border border-hairline bg-panel-raised/40 px-3 py-2.5"
              >
                <StepIcon ok={s.ok} />
                <span className="flex-1 text-sm text-ink">{s.label}</span>
                <span
                  className={clsx(
                    "font-mono text-[11px] tracking-label",
                    s.ok === true && "text-verified",
                    s.ok === false && "text-signal",
                    s.ok === null && "text-ink-faint"
                  )}
                >
                  {s.msg}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 font-mono text-[11px] text-ink-faint">
          Tip: open this page in the same Chrome profile where ApplyPilot is installed.
        </p>
      </SectionCard>
    </div>
  );
}

function ConnBadge({ conn }: { conn: Conn }) {
  const map: Record<Conn["state"], { dot: string; label: string }> = {
    idle: { dot: "bg-ink-faint", label: "not checked" },
    checking: { dot: "bg-amber animate-blink-amber", label: "checking" },
    connected: { dot: "bg-verified", label: "connected" },
    error: { dot: "bg-signal", label: "not connected" },
  };
  const s = map[conn.state];
  return (
    <span className="flex items-center gap-2">
      <Cable className="h-4 w-4 text-ink-dim" />
      <span className={clsx("h-2 w-2 rounded-full", s.dot)} />
      <span className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{s.label}</span>
    </span>
  );
}

function StepIcon({ ok }: { ok: boolean | null }) {
  if (ok === true) return <Check className="h-4 w-4 shrink-0 text-verified" />;
  if (ok === false) return <X className="h-4 w-4 shrink-0 text-signal" />;
  return <Minus className="h-4 w-4 shrink-0 text-ink-faint" />;
}
