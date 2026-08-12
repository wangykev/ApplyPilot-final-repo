"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { clsx } from "@/lib/clsx";

/**
 * One modal, shared. Extracted when the résumé needed the same shell the job description already had
 * — a second hand-rolled copy is how two dialogs end up closing on different keys.
 *
 * Escape closes, a backdrop click closes, and a click INSIDE never does (the résumé viewer is a
 * scrollable document, so a stray click on it must not dismiss the thing you are reading).
 * Body scroll is locked while open, or the page behind scrolls under the dialog on a trackpad.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** the résumé is a PAGE — it needs the room; a JD is prose and reads better narrow */
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={clsx("bezel relative flex max-h-[88vh] w-full flex-col", wide ? "max-w-5xl" : "max-w-2xl")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-medium">{title}</h2>
            {subtitle && <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-ink-dim transition-colors hover:text-ink"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
