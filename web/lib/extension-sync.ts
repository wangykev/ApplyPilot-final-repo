"use client";

/**
 * Live sync: once the user has connected their extension (its id is saved on
 * this device), every edit to their profile / answer buckets / AI config /
 * resume is pushed straight into the extension — no manual "Sync everything"
 * click. Editors call `liveSync(kind)` in their save-success branch; this module
 * fetches the current slice from the backend (single source of truth, so it
 * reflects zod coercion + server-side merges like resume-parse) and pushes it
 * via the same AP_* messages the Connect page uses.
 *
 * It is a fire-and-forget no-op when not connected here (no extension id saved,
 * or not running in Chrome with the extension) — so it is always safe to call.
 */

import { sendToExtension, extensionMessagingAvailable, type ExtResponse } from "./extension";
import { getProfileSyncSlice, getAiSyncSlice, getResumeSyncSlice } from "@/app/app/connect/actions";

// Same localStorage key the Connect page writes the pasted extension id to.
export const EXT_ID_KEY = "applypilot.extensionId";

export function linkedExtensionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(EXT_ID_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    /* localStorage unavailable — fall through to the build-time id */
  }
  // A deployment may hardcode the id (Connect page seeds it) without the user ever
  // editing the field, so localStorage stays empty — fall back to the env var.
  const env = process.env.NEXT_PUBLIC_EXTENSION_ID;
  return env && env.trim() ? env.trim() : null;
}

/** True when live sync CAN run here: an extension id is linked AND Chrome
 *  extension messaging is present (Chrome + the extension installed). */
export function liveSyncActive(): boolean {
  return linkedExtensionId() !== null && extensionMessagingAvailable();
}

export type SyncKind = "profile" | "ai" | "resume" | "resume-clear";

// Human label for the toast, per kind.
const SYNC_LABEL: Record<SyncKind, string> = {
  profile: "profile",
  ai: "AI config",
  resume: "resume",
  "resume-clear": "resume",
};

// ── Toast bus: a single <LiveSyncToast/> in the app shell listens for these. ──
export type SyncToast = { kind: "ok" | "err"; text: string };
export const SYNC_TOAST_EVENT = "applypilot:synctoast";
function toast(t: SyncToast) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SyncToast>(SYNC_TOAST_EVENT, { detail: t }));
}

type Built = { ok: true; message: Record<string, unknown> } | { ok: false; error: string };

async function buildMessage(kind: SyncKind): Promise<Built> {
  if (kind === "resume-clear") return { ok: true, message: { type: "AP_CLEAR_RESUME" } };
  if (kind === "profile") {
    const r = await getProfileSyncSlice();
    if (!r.ok) return r;
    // Send profile + defaults + buckets together: the extension's AP_SYNC_PROFILE
    // guard rejects a buckets-only push ("nothing to sync"), so buckets never ride alone.
    return { ok: true, message: { type: "AP_SYNC_PROFILE", ...r.slice } };
  }
  if (kind === "ai") {
    const r = await getAiSyncSlice();
    if (!r.ok) return r;
    return { ok: true, message: { type: "AP_SET_LLM", llmConfig: r.slice.llmConfig } };
  }
  // resume (upload / replace)
  const r = await getResumeSyncSlice();
  if (!r.ok) return r;
  if (!r.slice.resume) return { ok: true, message: { type: "AP_CLEAR_RESUME" } }; // raced empty → clear
  return { ok: true, message: { type: "AP_SYNC_RESUME", ...r.slice.resume } };
}

async function runSync(kind: SyncKind): Promise<void> {
  const id = linkedExtensionId();
  if (!id || !extensionMessagingAvailable()) return; // not connected here — silent
  const built = await buildMessage(kind);
  if (!built.ok) {
    toast({ kind: "err", text: `Couldn't sync your ${SYNC_LABEL[kind]}: ${built.error}` });
    return;
  }
  const resp: ExtResponse = await sendToExtension(id, built.message);
  if (resp.ok) toast({ kind: "ok", text: `Synced your ${SYNC_LABEL[kind]} to the extension.` });
  else toast({ kind: "err", text: `Couldn't reach the extension to sync your ${SYNC_LABEL[kind]}.` });
}

// Trailing debounce per kind so rapid successive saves coalesce into one push
// (teach persists on every in-place edit; profile / AI saves can be clicked fast).
const timers: Partial<Record<SyncKind, ReturnType<typeof setTimeout>>> = {};
const DEBOUNCE_MS = 400;

/**
 * Fire-and-forget: push the given slice to the connected extension after a short
 * debounce. No-op when not connected here. Feedback surfaces via the toast bus.
 */
export function liveSync(kind: SyncKind): void {
  if (typeof window === "undefined") return;
  const existing = timers[kind];
  if (existing) clearTimeout(existing);
  timers[kind] = setTimeout(() => {
    delete timers[kind];
    void runSync(kind);
  }, DEBOUNCE_MS);
}
