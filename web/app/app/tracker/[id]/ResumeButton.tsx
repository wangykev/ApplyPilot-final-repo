"use client";

import { useState } from "react";
import { FileText, Loader2, ExternalLink, Download } from "lucide-react";
import { Modal } from "@/components/app/Modal";
import { getApplicationResumeUrl } from "./resume-action";

/**
 * "The résumé that went with THIS application."
 *
 * Opens IN A MODAL rather than a new tab (operator, 2026-08-12): checking which résumé went out is a
 * glance you take mid-review, and a tab switch loses your place in the review you were part-way
 * through approving.
 *
 * The URL is still minted on click, not rendered into the page: the bucket is private, signed URLs
 * expire, and a link baked into HTML at render time would be dead by the time anyone clicked it on a
 * page left open. Renders nothing when the application has no résumé recorded — every row filled
 * before this shipped is in that state, and an inert button would be a worse answer than no button.
 *
 * ⚠ THE NEW-TAB ESCAPE HATCH STAYS, as a link inside the modal. Inline PDF rendering is the browser's
 * choice, not ours — a viewer-less browser, a PDF-blocking policy or an unusual content-type all end
 * with a blank frame, and the reader still needs a way to see the document. Losing that would trade a
 * tab switch for a dead end.
 */
export function ResumeButton({ applicationId, filename }: { applicationId: string; filename: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  if (!filename) return null;

  const open = async () => {
    setBusy(true);
    setErr(null);
    const r = await getApplicationResumeUrl(applicationId);
    setBusy(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setUrl(r.url);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={open} disabled={busy} className="btn-ghost" title={filename}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
        Résumé
      </button>
      {err && <span className="text-[11px] text-signal">{err}</span>}

      <Modal open={!!url} onClose={() => setUrl(null)} title="Résumé" subtitle={filename} wide>
        <div className="flex items-center gap-4 border-b border-hairline px-6 py-2.5">
          <a
            href={url ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-label text-ink-dim transition-colors hover:text-ink"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in a tab
          </a>
          <a
            href={url ?? "#"}
            download={filename ?? undefined}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-label text-ink-dim transition-colors hover:text-ink"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
          <span className="ml-auto font-mono text-[10px] text-ink-faint">
            the exact file this application was filed with
          </span>
        </div>
        {url && (
          <iframe
            src={url}
            title={filename ?? "Résumé"}
            className="h-[72vh] w-full bg-cockpit"
          />
        )}
      </Modal>
    </div>
  );
}
