"use client";

import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { Modal } from "@/components/app/Modal";
import { summarizeJd } from "@/lib/jd-summary";

/**
 * "Job description" for the review/detail header — opens the scraped posting in a modal, led by a
 * DETERMINISTIC summary of the facts you decide on (pay, workplace, sponsorship, clearance…).
 *
 * The summary is regex over the posting text, never a model: it must be instant on every open, free,
 * and identical every time you reopen the same posting. It is allowed to find nothing — see
 * lib/jd-summary — and when it does, the panel is omitted entirely rather than rendering an empty box
 * that implies the posting said nothing worth knowing.
 *
 * Renders nothing when there is no JD stored, so it never opens an empty popup.
 */
export function JobDescriptionButton({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  const facts = useMemo(() => summarizeJd(text), [text]);

  if (!text || !text.trim()) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost">
        <FileText className="h-4 w-4" />
        Job description
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Job description"
        subtitle={facts.length ? `${facts.length} fact${facts.length === 1 ? "" : "s"} read from the posting` : undefined}
      >
        {facts.length > 0 && (
          <div className="border-b border-hairline bg-panel-raised/40 px-6 py-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
              {facts.map((f) => (
                <div key={f.label} className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-label text-ink-faint">{f.label}</div>
                  <div className="truncate text-sm text-ink" title={f.value}>
                    {f.value}
                  </div>
                </div>
              ))}
            </div>
            {/* Say where these came from. A reader who knows it is a literal read of the posting
                trusts it differently from one who suspects it was summarized by a model. */}
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Read straight from the posting below — no AI. Anything the posting didn&apos;t state
              plainly is left out rather than guessed.
            </p>
          </div>
        )}
        <pre className="whitespace-pre-wrap px-6 py-5 font-sans text-sm leading-relaxed text-ink-dim">
          {text}
        </pre>
      </Modal>
    </>
  );
}
