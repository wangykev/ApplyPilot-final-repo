"use client";

/**
 * Client-side bridge to the ApplyPilot extension. `chrome.runtime` is injected
 * into this page only when the extension lists our origin in
 * externally_connectable.matches, so this works in Chrome with the extension
 * installed and degrades to a clear error elsewhere.
 */

export type ExtResponse = Record<string, unknown> & { ok?: boolean; error?: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
function runtime(): any | null {
  if (typeof window === "undefined") return null;
  const c = (window as any).chrome;
  return c && c.runtime && typeof c.runtime.sendMessage === "function" ? c.runtime : null;
}

export function extensionMessagingAvailable(): boolean {
  return runtime() !== null;
}

/**
 * WHY can't this page talk to the extension? (2026-08-11)
 *
 * Chrome injects `chrome.runtime` into a page ONLY when that page's origin is listed in the extension's
 * `externally_connectable.matches`. Today that list is localhost + 127.0.0.1 ONLY — so the moment this
 * site is deployed anywhere else, every extension feature goes quiet: no sync, no Run button, and (the
 * one that actually loses data) no self-healing of a rejected report. Nothing throws; the page simply
 * behaves as though no extension exists.
 *
 * The two causes are distinguishable, which is the point of this function:
 *   • `window.chrome` present but `chrome.runtime` missing, on a NON-localhost origin
 *       ⇒ this origin is not in the manifest. A deploy step was missed; installing the extension will
 *         not help, and telling the user to check the extension would send them the wrong way.
 *   • everything else ⇒ ordinary "not installed / not Chrome".
 *
 * ⚠ The fix is to add the real production origin to `manifest.json`. It is deliberately NOT wildcarded
 * (e.g. `https://*.vercel.app/*`) — externally_connectable grants message access, so a wildcard would
 * let any site on that host drive the extension.
 */
export function messagingUnavailableReason(): "ok" | "origin-not-allowlisted" | "no-extension" {
  if (runtime() !== null) return "ok";
  if (typeof window === "undefined") return "no-extension";
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const hasChrome = !!(window as any).chrome;
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  return hasChrome && !isLocal ? "origin-not-allowlisted" : "no-extension";
}

export function sendToExtension(extId: string, message: unknown): Promise<ExtResponse> {
  return new Promise((resolve) => {
    const rt = runtime();
    if (!rt) {
      // Name the ACTUAL cause. "Install the extension" is the wrong instruction when the real problem is
      // that this deployment's origin was never added to externally_connectable — the user would reinstall
      // forever and nothing would change.
      resolve({
        ok: false,
        error: messagingUnavailableReason() === "origin-not-allowlisted"
          ? `This site's origin (${window.location.origin}) is not listed in the extension's `
            + `externally_connectable.matches, so Chrome will not connect it — reinstalling will not help. `
            + `Add this exact origin to manifest.json and reload the extension.`
          : "No extension messaging here — open this in Chrome with ApplyPilot installed.",
      });
      return;
    }
    try {
      rt.sendMessage(extId, message, (resp: ExtResponse | undefined) => {
        const le = rt.lastError;
        if (le) {
          resolve({
            ok: false,
            error:
              le.message ||
              "Couldn't reach the extension. Check the ID and that it's installed and enabled.",
          });
          return;
        }
        resolve(resp ?? { ok: false, error: "No response from the extension." });
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export function pingExtension(extId: string): Promise<ExtResponse> {
  return sendToExtension(extId, { type: "AP_PING" });
}

export type ReportHealth = {
  ok?: boolean;
  healthy?: boolean;
  connected?: boolean;
  reason?: string | null;
  hasPending?: boolean;
  pendingCompany?: string | null;
  error?: string;
};

/**
 * Is the extension's REPORTING link actually working?
 *
 * Distinct from pingExtension on purpose. A ping proves the extension is installed and answering,
 * which it does just as happily while holding a credential the server deleted — that gap is exactly
 * how a user could read a green "connected" badge while every completed fill silently failed to
 * reach their tracker. This asks the question that matters: did the last report land, and is a
 * finished run parked waiting for a working key?
 *
 * Read-only, and returns nothing sensitive (no key, no bundle) — just the shape of the problem, so
 * the caller can REPAIR it rather than describe it to the user.
 */
export function getReportHealth(extId: string): Promise<ReportHealth> {
  return sendToExtension(extId, { type: "AP_REPORT_HEALTH" }) as Promise<ReportHealth>;
}

export type RunProgress = { phase: string; detail: string; at: number };

/**
 * Open a long-lived Port to stream live run progress from the extension while
 * AP_RUN_APPLICATION is in flight. The extension's runCdpOnboard/runCdpWalk pipeline
 * posts { type: "AP_RUN_PROGRESS", phase, detail, at } as it works. Returns a handle to
 * disconnect when the run finishes (or null if messaging isn't available here). Progress
 * is best-effort UI sugar — the authoritative result still arrives via sendToExtension.
 */
export function openRunProgressPort(
  extId: string,
  onProgress: (p: RunProgress) => void,
): { disconnect: () => void } | null {
  const rt = runtime();
  if (!rt || typeof rt.connect !== "function") return null;
  try {
    const port = rt.connect(extId, { name: "ap-run-progress" });
    port.onMessage.addListener((m: { type?: string; phase?: string; detail?: string; at?: number }) => {
      if (m && m.type === "AP_RUN_PROGRESS") {
        onProgress({ phase: m.phase || "", detail: m.detail || "", at: m.at || 0 });
      }
    });
    return { disconnect: () => { try { port.disconnect(); } catch { /* already closed */ } } };
  } catch {
    return null;
  }
}
