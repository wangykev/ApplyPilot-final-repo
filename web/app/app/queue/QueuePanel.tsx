"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ExternalLink, FileText, MapPin, Clock, ChevronDown } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { addQueueItems, removeQueueItem, clearQueue } from "./actions";
import { parseUrls, type QueueItem } from "./shared";
import { clsx } from "@/lib/clsx";

const STATUS: Record<QueueItem["status"], { dot: string; text: string }> = {
  pending: { dot: "bg-ink-faint", text: "text-ink-dim" },
  active: { dot: "bg-amber animate-blink-amber", text: "text-amber" },
  done: { dot: "bg-verified", text: "text-verified" },
  error: { dot: "bg-signal", text: "text-signal" },
};

// Matches the Discover panel's badge colours so a source reads the same on both pages.
const SOURCE_BADGE: Record<string, string> = {
  simplify: "border-verified/40 text-verified",
  linkedin: "border-amber/40 text-amber",
  handshake: "border-ink-dim/40 text-ink-dim",
};

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
const isWorkday = (url: string) => /myworkdayjobs\.com/i.test(url);

/** "3d ago" from an ISO posted_at — discovered rows carry it, pasted rows don't. */
function agoLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!isFinite(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function QueuePanel({ items }: { items: QueueItem[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const detected = parseUrls(text).length;

  const add = () =>
    startTransition(async () => {
      setMsg(null);
      const r = await addQueueItems(text);
      if (r.ok) {
        setText("");
        setMsg({ kind: "ok", text: `Added ${r.added} to the queue.` });
        router.refresh();
      } else {
        setMsg({ kind: "err", text: r.error });
      }
    });

  const remove = (id: string) =>
    startTransition(async () => {
      const r = await removeQueueItem(id);
      if (r.ok) router.refresh();
      else setMsg({ kind: "err", text: r.error });
    });

  const clear = () =>
    startTransition(async () => {
      const r = await clearQueue();
      if (r.ok) router.refresh();
      else setMsg({ kind: "err", text: r.error });
    });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Add jobs"
        subtitle="Paste Workday application links — one per line. The extension works through them in order."
      >
        <textarea
          name="queue-urls"
          aria-label="Workday application URLs, one per line"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={"https://company.wd5.myworkdayjobs.com/…/apply\nhttps://another.wd1.myworkdayjobs.com/…/apply"}
          className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2.5 font-mono text-[13px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={add} disabled={pending || detected === 0} className="btn-primary">
            <Plus className="h-4 w-4" />
            {pending ? "Adding…" : `Add ${detected || ""} to queue`.trim()}
          </button>
          <span className="font-mono text-[11px] tracking-label text-ink-faint">
            {detected} URL{detected === 1 ? "" : "s"} detected
          </span>
          {msg && (
            <span className={clsx("text-sm", msg.kind === "ok" ? "text-verified" : "text-signal")}>
              {msg.text}
            </span>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Queue"
        subtitle={`${items.length} job${items.length === 1 ? "" : "s"} waiting`}
        actions={
          items.length > 0 ? (
            <button
              onClick={clear}
              disabled={pending}
              className="inline-flex items-center gap-1.5 text-xs text-ink-faint transition-colors hover:text-signal"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear all
            </button>
          ) : null
        }
      >
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-faint">
            Nothing queued yet. Paste some Workday links above.
          </p>
        ) : (
          <ol className="space-y-2">
            {items.map((it, i) => (
              <QueueRow
                key={it.id}
                item={it}
                index={i}
                pending={pending}
                onRemove={() => remove(it.id)}
              />
            ))}
          </ol>
        )}
      </SectionCard>
    </div>
  );
}

/**
 * One queue row. A DISCOVERED row leads with what the operator actually cares about
 * — company · role, where it came from, how fresh it is, and whether we captured a
 * job description — and keeps the raw URL as the secondary line. A PASTED row has
 * none of that, so it degrades to exactly the host + url it always showed.
 */
function QueueRow({
  item,
  index,
  pending,
  onRemove,
}: {
  item: QueueItem;
  index: number;
  pending: boolean;
  onRemove: () => void;
}) {
  const [showJd, setShowJd] = useState(false);
  const st = STATUS[item.status];
  const ago = agoLabel(item.posted_at);
  const headline = [item.company, item.role].filter(Boolean).join(" · ") || host(item.url);
  const discovered = Boolean(item.company || item.role || item.source);

  return (
    <li className="rounded-lg border border-hairline bg-panel-raised/40 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="w-6 shrink-0 font-mono text-[11px] text-ink-faint">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className={clsx("h-2 w-2 shrink-0 rounded-full", st.dot)} />
        {item.source && (
          <span
            className={clsx(
              "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label",
              SOURCE_BADGE[item.source] || "border-ink-faint/40 text-ink-faint"
            )}
          >
            {item.source}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-ink">{headline}</div>
          {discovered ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-faint">
              {item.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {item.location}
                </span>
              )}
              {ago && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  posted {ago}
                </span>
              )}
              <span className="truncate">{host(item.url)}</span>
            </div>
          ) : (
            <div className="truncate font-mono text-[11px] text-ink-faint">{item.url}</div>
          )}
        </div>
        {!isWorkday(item.url) && (
          <span className="shrink-0 rounded border border-amber/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label text-amber">
            not workday
          </span>
        )}
        <span className={clsx("shrink-0 font-mono text-[10px] uppercase tracking-label", st.text)}>
          {item.status}
        </span>
        {item.job_description && (
          <button
            onClick={() => setShowJd((v) => !v)}
            className="shrink-0 text-ink-faint transition-colors hover:text-ink"
            aria-label="Show the job description"
            aria-expanded={showJd}
            title={`Job description (${item.job_description.length.toLocaleString()} chars)`}
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
        )}
        <a href={item.url} target="_blank" rel="noreferrer" className="shrink-0 text-ink-faint hover:text-ink" aria-label="Open">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <button
          onClick={onRemove}
          disabled={pending}
          className="shrink-0 text-ink-faint transition-colors hover:text-signal"
          aria-label="Remove"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {showJd && item.job_description && (
        <div className="mt-3 border-t border-hairline pt-3">
          <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-label text-ink-faint">
            <ChevronDown className="h-3 w-3" />
            Job description ({item.job_description.length.toLocaleString()} chars)
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-cockpit p-3 text-xs leading-relaxed text-ink-dim">
            {item.job_description}
          </pre>
        </div>
      )}
    </li>
  );
}
