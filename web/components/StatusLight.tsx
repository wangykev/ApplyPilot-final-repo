import { clsx } from "@/lib/clsx";

export type FieldStatus = "pending" | "filling" | "verified" | "review" | "error";

const DOT: Record<FieldStatus, string> = {
  pending: "bg-ink-faint",
  filling: "bg-amber-soft animate-blink-amber",
  verified: "bg-verified shadow-[0_0_8px_rgba(54,214,160,0.7)]",
  review: "bg-amber shadow-[0_0_8px_rgba(255,182,39,0.7)] animate-blink-amber",
  error: "bg-signal shadow-[0_0_8px_rgba(255,92,92,0.7)]",
};

const LABEL: Record<FieldStatus, string> = {
  pending: "—",
  filling: "FILLING",
  verified: "VERIFIED",
  review: "REVIEW",
  error: "ERROR",
};

/** The app's reused status vocabulary: a colored instrument light + mono label. */
export function StatusLight({
  status,
  showLabel = false,
  className = "",
}: {
  status: FieldStatus;
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <span className={clsx("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className={clsx("h-2 w-2 shrink-0 rounded-full", DOT[status])}
      />
      {showLabel && (
        <span
          className={clsx(
            "font-mono text-[10px] uppercase tracking-label",
            status === "verified" && "text-verified",
            status === "review" && "text-amber",
            status === "error" && "text-signal",
            (status === "pending" || status === "filling") && "text-ink-dim"
          )}
        >
          {LABEL[status]}
        </span>
      )}
    </span>
  );
}
