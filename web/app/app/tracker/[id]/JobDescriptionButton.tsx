"use client";

import { useEffect, useState } from "react";
import { FileText, X } from "lucide-react";

/**
 * "Job description" button for the review/detail header — sits next to "Open posting".
 * Opens a modal with the JD text the Run flow scraped and saved on the application row.
 * Renders nothing when there's no JD stored (so it never shows an empty popup).
 */
export function JobDescriptionButton({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!text || !text.trim()) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost">
        <FileText className="h-4 w-4" />
        Job description
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Job description"
        >
          <div
            className="bezel relative flex max-h-[80vh] w-full max-w-2xl flex-col p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-hairline pb-3">
              <h2 className="font-display text-lg font-medium">Job description</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-ink-dim transition-colors hover:text-ink"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <pre className="mt-4 overflow-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-dim">
              {text}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}
