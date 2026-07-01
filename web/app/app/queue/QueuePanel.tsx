"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ExternalLink } from "lucide-react";
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

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
const isWorkday = (url: string) => /myworkdayjobs\.com/i.test(url);

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
            {items.map((it, i) => {
              const st = STATUS[it.status];
              return (
                <li
                  key={it.id}
                  className="flex items-center gap-3 rounded-lg border border-hairline bg-panel-raised/40 px-3 py-2.5"
                >
                  <span className="w-6 shrink-0 font-mono text-[11px] text-ink-faint">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className={clsx("h-2 w-2 shrink-0 rounded-full", st.dot)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{host(it.url)}</div>
                    <div className="truncate font-mono text-[11px] text-ink-faint">{it.url}</div>
                  </div>
                  {!isWorkday(it.url) && (
                    <span className="shrink-0 rounded border border-amber/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label text-amber">
                      not workday
                    </span>
                  )}
                  <span className={clsx("shrink-0 font-mono text-[10px] uppercase tracking-label", st.text)}>
                    {it.status}
                  </span>
                  <a href={it.url} target="_blank" rel="noreferrer" className="shrink-0 text-ink-faint hover:text-ink" aria-label="Open">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <button
                    onClick={() => remove(it.id)}
                    disabled={pending}
                    className="shrink-0 text-ink-faint transition-colors hover:text-signal"
                    aria-label="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>
    </div>
  );
}
