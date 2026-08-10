"use client";

import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { getApplicationResumeUrl } from "./resume-action";

/**
 * "The résumé that went with THIS application."
 *
 * The URL is minted on click, not rendered into the page: the bucket is private, signed URLs expire,
 * and a link baked into HTML at render time would be dead by the time anyone clicked it on a page left
 * open. Renders nothing when the application has no résumé recorded — every row filled before this
 * shipped is in that state, and an inert button would be a worse answer than no button.
 */
export function ResumeButton({ applicationId, filename }: { applicationId: string; filename: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    window.open(r.url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={open} disabled={busy} className="btn-ghost" title={filename}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
        Résumé
      </button>
      {err && <span className="text-[11px] text-signal">{err}</span>}
    </div>
  );
}
