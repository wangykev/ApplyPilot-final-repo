"use client";

import { useEffect, useState } from "react";
import { Check, AlertTriangle } from "lucide-react";
import { SYNC_TOAST_EVENT, type SyncToast } from "@/lib/extension-sync";
import { clsx } from "@/lib/clsx";

type Item = SyncToast & { id: number };

/**
 * Global listener for live-sync results. Mounted once in the authenticated app
 * shell; `liveSync()` dispatches SYNC_TOAST_EVENT after pushing a slice to the
 * connected extension, and this surfaces a small, auto-dismissing confirmation.
 */
export function LiveSyncToast() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    let seq = 0;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<SyncToast>).detail;
      if (!detail) return;
      const id = ++seq;
      setItems((prev) => [...prev, { ...detail, id }]);
      // Errors linger a touch longer than confirmations.
      const ttl = detail.kind === "err" ? 5000 : 2600;
      window.setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), ttl);
    };
    window.addEventListener(SYNC_TOAST_EVENT, onToast as EventListener);
    return () => window.removeEventListener(SYNC_TOAST_EVENT, onToast as EventListener);
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "pointer-events-auto flex max-w-xs items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur",
            "motion-safe:animate-rise-in",
            t.kind === "ok"
              ? "border-verified/30 bg-panel-raised/95 text-ink"
              : "border-signal/40 bg-panel-raised/95 text-ink"
          )}
        >
          {t.kind === "ok" ? (
            <Check className="h-4 w-4 shrink-0 text-verified" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0 text-signal" />
          )}
          <span className="leading-snug">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
