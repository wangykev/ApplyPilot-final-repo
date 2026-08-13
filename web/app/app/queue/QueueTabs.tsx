"use client";

import { useState } from "react";
import { clsx } from "@/lib/clsx";
import { QueuePanel } from "./QueuePanel";
import { SubmitQueuePanel } from "./SubmitQueuePanel";
import type { QueueItem } from "./shared";
import type { Application } from "../tracker/shared";

/**
 * The two halves of the pipeline, on one tab.
 *
 * They are the SAME queue at different stages — jobs waiting to be FILLED, then applications waiting
 * to be SENT — so putting them behind one toggle is what makes "what is left to do?" a single
 * question. Client-side state only: both lists are already loaded by the page, so switching is
 * instant and neither view can go stale relative to the other.
 */
type Tab = "fill" | "submit";

export function QueueTabs({ items, ready }: { items: QueueItem[]; ready: Application[] }) {
  const [tab, setTab] = useState<Tab>("fill");

  const Toggle = ({ id, label, n, tone }: { id: Tab; label: string; n: number; tone?: "ok" }) => (
    <button
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      className={clsx(
        "rounded-full border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-label transition-colors",
        tab === id
          ? "border-ink-dim bg-panel-raised text-ink"
          : tone === "ok" && n > 0
            ? "border-verified/40 text-ink-dim hover:border-verified"
            : "border-hairline text-ink-dim hover:border-ink-dim"
      )}
    >
      <span className={clsx(tone === "ok" && n > 0 && tab !== id && "text-verified")}>{label}</span>{" "}
      <span className={clsx(tab === id ? "text-ink" : "text-ink-faint")}>{n}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Toggle id="fill" label="Fill queue" n={items.length} />
        <Toggle id="submit" label="Submit queue" n={ready.length} tone="ok" />
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {tab === "fill" ? "jobs waiting to be filled" : "approved, waiting to be sent"}
        </span>
      </div>

      {tab === "fill" ? <QueuePanel items={items} /> : <SubmitQueuePanel apps={ready} />}
    </div>
  );
}
