"use client";

import { useEffect, useRef, useState } from "react";
import { StatusLight, type FieldStatus } from "@/components/StatusLight";
import { clsx } from "@/lib/clsx";

type Row = {
  label: string;
  value: string;
  /** where the row lands once the bot finishes it */
  end: Exclude<FieldStatus, "pending" | "filling">;
  /** the human-readable reason a flagged row needs review */
  note?: string;
};

// Grounded in a real Workday "My Information" page: most fields fill
// confidently; the safety-critical ones get flagged for review.
const ROWS: Row[] = [
  { label: "First name", value: "Kevin", end: "verified" },
  { label: "Last name", value: "Wang", end: "verified" },
  { label: "Email", value: "kevin@…", end: "verified" },
  { label: "Country", value: "United States", end: "verified" },
  { label: "Phone", value: "+1 (415) …", end: "verified" },
  { label: "How did you hear?", value: "LinkedIn", end: "verified" },
  {
    label: "Previously employed here?",
    value: "No",
    end: "review",
    note: "adjacent to a truthfulness certification",
  },
  { label: "Work authorization", value: "Yes", end: "verified" },
  {
    label: "Gender",
    value: "AI-inferred",
    end: "review",
    note: "AI-guessed demographic — verify",
  },
];

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function FillStatusPanel() {
  const reduced = usePrefersReducedMotion();
  // cursor = index currently being filled; -1 before start, ROWS.length when done
  const [cursor, setCursor] = useState(reduced ? ROWS.length : -1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (reduced) {
      setCursor(ROWS.length);
      return;
    }
    let i = -1;
    const tick = () => {
      i += 1;
      if (i > ROWS.length) {
        // hold the completed state, then calmly restart the sweep
        timer.current = setTimeout(() => {
          i = -1;
          setCursor(-1);
          timer.current = setTimeout(tick, 700);
        }, 4200);
        return;
      }
      setCursor(i);
      timer.current = setTimeout(tick, i === ROWS.length ? 600 : 540);
    };
    timer.current = setTimeout(tick, 600);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reduced]);

  const statusFor = (idx: number): FieldStatus => {
    if (cursor === idx) return "filling";
    if (cursor > idx) return ROWS[idx].end;
    return "pending";
  };

  const done = cursor >= ROWS.length;
  const filledCount = ROWS.filter((_, i) => cursor > i && ROWS[i].end === "verified").length;
  const reviewCount = ROWS.filter((_, i) => cursor > i && ROWS[i].end === "review").length;

  return (
    <div className="bezel overflow-hidden" aria-hidden>
      {/* instrument header */}
      <div className="flex items-center justify-between border-b border-hairline bg-panel-raised/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-verified" />
          <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">
            My Information
          </span>
        </div>
        <span className="font-mono text-[11px] tracking-label text-ink-faint">
          PAGE 1 / 4
        </span>
      </div>

      {/* field rows */}
      <div className="divide-y divide-hairline/70">
        {ROWS.map((row, idx) => {
          const st = statusFor(idx);
          return (
            <div
              key={row.label}
              className={clsx(
                "flex items-center gap-3 px-4 py-2.5 transition-colors duration-300",
                st === "review" && "bg-amber/[0.06]",
                st === "filling" && "bg-panel-raised/40"
              )}
            >
              <StatusLight status={st} />
              <span className="w-40 shrink-0 truncate font-mono text-[12px] text-ink-dim">
                {row.label}
              </span>
              <div className="relative flex-1 overflow-hidden">
                {st === "filling" ? (
                  <span className="block h-3.5 w-full max-w-[160px] overflow-hidden rounded-sm bg-panel-raised">
                    <span className="block h-full w-1/2 animate-sweep bg-gradient-to-r from-transparent via-amber/60 to-transparent" />
                  </span>
                ) : st === "pending" ? (
                  <span className="block h-3.5 w-full max-w-[120px] rounded-sm bg-panel-raised/60" />
                ) : (
                  <span
                    className={clsx(
                      "truncate text-[13px]",
                      row.end === "review" ? "text-amber-soft" : "text-ink"
                    )}
                  >
                    {row.value}
                  </span>
                )}
              </div>
              <StatusLight status={st} showLabel className="hidden sm:flex" />
            </div>
          );
        })}
      </div>

      {/* readout footer */}
      <div className="flex items-center justify-between gap-3 border-t border-hairline bg-panel-raised/60 px-4 py-3">
        <div className="flex items-center gap-4 font-mono text-[11px] tracking-label">
          <span className="text-verified">FILLED {String(filledCount).padStart(2, "0")}</span>
          <span className="text-amber">REVIEW {String(reviewCount).padStart(2, "0")}</span>
        </div>
        <span className="font-mono text-[11px] tracking-label text-ink-faint">
          {done ? "AWAITING YOUR REVIEW" : "FILL → REVIEW → SUBMIT"}
        </span>
      </div>
    </div>
  );
}
