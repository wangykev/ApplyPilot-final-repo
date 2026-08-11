"use client";

/**
 * Silently repairs a broken reporting link, and only speaks when it cannot.
 *
 * THE FAILURE THIS EXISTS FOR. `getSession` rotates the reporting key (it deletes the user's old row
 * and mints a new one), so any earlier "Sync everything" — from another browser, or a re-link — leaves
 * the extension holding a credential the server no longer recognises. Every completed fill then 401s.
 * Before this, that was silent data loss: the run took minutes, produced a good bundle, and the only
 * trace was a service-worker console line plus an `apReportError` marker that nothing ever read. The
 * user's natural check made it worse — /app/connect shows a green "connected" badge off a plain ping,
 * which succeeds regardless of whether the key works.
 *
 * WHY IT HEALS INSTEAD OF WARNING. A user cannot act on "401 / stale ingest key", and should not have
 * to. The extension parks the rejected payload (`apPendingReport`), so the only missing ingredient is
 * a working credential — and this page, unlike the extension, is authenticated as the user and can
 * mint one. So the repair runs by itself and the user simply sees their application appear. The
 * banner below is the FALLBACK for when that can't work, not the primary path.
 *
 * WHY IT IS SAFE TO DO SILENTLY, and the two guards that make it so:
 *  1. It calls the TRACKING-ONLY link (AP_SET_SESSION). It must NEVER call the full sync, which
 *     overwrites the extension's profile, resume and AI config — silently destroying user data to fix
 *     a reporting key would be a far worse bug than the one being fixed.
 *  2. Every heal ROTATES the key, so it must never run speculatively. It fires only when the
 *     extension reports an actual rejection, and at most once per mount (`tried`) — an unguarded
 *     version would rotate on every visit, and two open tabs would rotate each other's keys forever.
 *     A successful flush clears the marker extension-side, which is what ends the cycle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getReportHealth, sendToExtension } from "@/lib/extension";
import { EXT_ID_KEY } from "@/lib/extension-sync";
import { getSession } from "../connect/actions";

type State =
  | { kind: "idle" }
  | { kind: "repairing" }
  | { kind: "recovered"; company: string | null }
  | { kind: "needs-action"; company: string | null };

export function ReportHealthGuard() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const tried = useRef(false);
  const router = useRouter();

  const repair = useCallback(async (extId: string, company: string | null) => {
    setState({ kind: "repairing" });
    const res = await getSession();
    if (!res.ok) {
      setState({ kind: "needs-action", company });
      return;
    }
    // TRACKING-ONLY. Never AP_SYNC_PROFILE / AP_SYNC_RESUME here — see the header note.
    // The extension flushes the parked report inside this handler and tells us whether it landed,
    // so `recovered` is evidence the application actually reached the tracker, not just that a
    // credential was stored.
    const set = await sendToExtension(extId, {
      type: "AP_SET_SESSION",
      ingestUrl: res.session.ingestUrl,
      ingestKey: res.session.ingestKey,
      reviewUrl: res.session.reviewUrl,
    });
    if (set.ok && (set as { recovered?: boolean }).recovered) {
      setState({ kind: "recovered", company });
      router.refresh(); // the recovered application is now a row — show it
      return;
    }
    // Credential stored but nothing came back: either there was no parked run (fine — stay quiet)
    // or the report failed again (the user needs to know their application did not save).
    if (set.ok && !(set as { recovered?: boolean }).recovered) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "needs-action", company });
  }, [router]);

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    let cancelled = false;
    (async () => {
      const extId = (typeof window !== "undefined" && localStorage.getItem(EXT_ID_KEY)) || "";
      if (!extId) return;                       // extension never linked here — nothing to repair
      const h = await getReportHealth(extId);
      if (cancelled) return;
      // Only a REJECTED report with a parked run is actionable. An unreachable extension (different
      // browser, disabled) is not this component's problem and must not produce a scary banner.
      if (!h.ok || h.healthy || !h.hasPending) return;
      await repair(extId, h.pendingCompany ?? null);
    })();
    return () => { cancelled = true; };
  }, [repair]);

  if (state.kind === "idle") return null;

  const who = state.kind === "recovered" || state.kind === "needs-action" ? state.company : null;

  if (state.kind === "repairing") {
    return (
      <Bar tone="quiet">Reconnecting your extension…</Bar>
    );
  }

  if (state.kind === "recovered") {
    // Speak in terms of the RESULT the user cares about, not the plumbing that produced it.
    return (
      <Bar tone="quiet">
        {who ? `Your ${who} application is saved.` : "Your latest application is saved."} We reconnected
        your extension automatically.
      </Bar>
    );
  }

  return (
    <Bar tone="alert">
      <span>
        {who ? `Your ${who} application didn't save.` : "Your latest application didn't save."} Reconnect
        your extension to finish saving it.
      </span>
      <button
        type="button"
        onClick={() => {
          const extId = localStorage.getItem(EXT_ID_KEY) || "";
          if (extId) repair(extId, who);
        }}
        className="shrink-0 rounded-lg bg-amber px-3 py-1.5 text-sm font-semibold text-cockpit hover:bg-amber-soft"
      >
        Reconnect
      </button>
    </Bar>
  );
}

function Bar({ tone, children }: { tone: "quiet" | "alert"; children: React.ReactNode }) {
  return (
    <div
      className={
        "mb-4 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm " +
        (tone === "alert"
          ? "border-signal/40 bg-signal/[0.08] text-ink"
          : "border-hairline bg-panel text-ink-dim")
      }
    >
      {children}
    </div>
  );
}
