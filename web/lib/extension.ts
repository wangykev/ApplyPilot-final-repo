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

export function sendToExtension(extId: string, message: unknown): Promise<ExtResponse> {
  return new Promise((resolve) => {
    const rt = runtime();
    if (!rt) {
      resolve({
        ok: false,
        error: "No extension messaging here — open this in Chrome with ApplyPilot installed.",
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
