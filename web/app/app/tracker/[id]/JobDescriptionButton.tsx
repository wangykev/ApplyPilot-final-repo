"use client";

import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { Modal } from "@/components/app/Modal";
import { summarizeJd } from "@/lib/jd-summary";
import { formatJd } from "@/lib/jd-format";
import { clsx } from "@/lib/clsx";

/**
 * "Job description" for the review/detail header — opens the scraped posting in a modal, led by a
 * DETERMINISTIC summary of the facts you decide on (pay, workplace, sponsorship, clearance…).
 *
 * The summary is regex over the posting text, never a model: it must be instant on every open, free,
 * and identical every time you reopen the same posting. It is allowed to find nothing — see
 * lib/jd-summary — and when it does, the panel is omitted entirely rather than rendering an empty box
 * that implies the posting said nothing worth knowing.
 *
 * The BODY is rendered from `formatJd` blocks — real headings, real lists, and the ATS sidebar's
 * label/value stutter paired into a grid — not a `<pre>` dump. A posting is a document someone has to
 * read before deciding whether to finish an application, and one undifferentiated wall of text is
 * where they stop reading. Nothing is dropped in the process (see lib/jd-format).
 *
 * Renders nothing when there is no JD stored, so it never opens an empty popup.
 */
export function JobDescriptionButton({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  const facts = useMemo(() => summarizeJd(text), [text]);
  const blocks = useMemo(() => formatJd(text), [text]);

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
          </div>
        )}
        <div className="px-6 py-5">
          {blocks.map((b, i) =>
            b.kind === "heading" ? (
              // First heading needs no top gap — the summary panel above already provides the break.
              <h3
                key={i}
                className={clsx(
                  "font-display text-[15px] font-medium text-ink",
                  i === 0 ? "mb-2" : "mb-2 mt-6 border-t border-hairline/60 pt-5",
                )}
              >
                {b.text}
              </h3>
            ) : b.kind === "bullets" ? (
              <ul key={i} className="mb-4 space-y-1.5">
                {b.items.map((it, k) => (
                  <li key={k} className="flex gap-2.5 text-sm leading-relaxed text-ink-dim">
                    <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-amber/70" />
                    <span className="min-w-0">{it}</span>
                  </li>
                ))}
              </ul>
            ) : b.kind === "meta" ? (
              <dl key={i} className="mb-5 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 sm:grid-cols-[auto_1fr_auto_1fr]">
                {b.rows.map((r) => (
                  <div key={r.label} className="col-span-2 grid grid-cols-[7.5rem_1fr] items-baseline gap-x-3">
                    <dt className="font-mono text-[10px] uppercase tracking-label text-ink-faint">{r.label}</dt>
                    <dd className="text-sm text-ink">{r.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p key={i} className="mb-4 max-w-[68ch] text-sm leading-relaxed text-ink-dim">
                {b.text}
              </p>
            ),
          )}
        </div>
      </Modal>
    </>
  );
}
