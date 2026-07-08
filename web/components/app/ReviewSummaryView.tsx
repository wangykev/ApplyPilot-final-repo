import {
  type ReviewBundle,
  type ReviewEntry,
  type BadgeTone,
  deriveBadge,
  prominence,
  statusKind,
  groupBySection,
} from "@/lib/review-summary";
import { clsx } from "@/lib/clsx";

const TONE: Record<BadgeTone, string> = {
  crit: "border-signal/40 text-signal",
  warn: "border-amber/40 text-amber",
  info: "border-hairline text-ink-dim",
};
const ROW_TINT: Record<BadgeTone, string> = {
  crit: "bg-signal/[0.05]",
  warn: "bg-amber/[0.04]",
  info: "",
};
const DOT: Record<ReturnType<typeof statusKind>, string> = {
  verified: "bg-verified",
  review: "bg-amber",
  error: "bg-signal",
  skip: "bg-ink-faint",
};
const CONF: Record<string, string> = {
  high: "text-verified",
  medium: "text-ink-dim",
  low: "text-amber",
  none: "text-ink-faint",
};

export function ReviewSummaryView({ bundle }: { bundle: ReviewBundle }) {
  const entries = bundle.entries ?? [];
  const review = entries
    .filter((e) => e.needs_review)
    .sort((a, b) => prominence(b) - prominence(a));
  const groups = groupBySection(entries);
  const filled = entries.filter((e) => e.fill_status === "filled" || e.fill_status === "filled_review").length;

  return (
    <div className="space-y-6">
      {/* meta strip */}
      <div className="bezel flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px] tracking-label">
          <span className="text-ink-dim">{String(entries.length).padStart(2, "0")} FIELDS</span>
          <span className="text-verified">{String(filled).padStart(2, "0")} FILLED</span>
          <span className="text-amber">{String(review.length).padStart(2, "0")} NEED REVIEW</span>
        </div>
        <div className="font-mono text-[11px] tracking-label text-ink-faint">
          {bundle.page ?? "page"} {bundle.tenant ? `· ${bundle.tenant}` : ""}
        </div>
      </div>

      {/* needs review */}
      {review.length > 0 && (
        <section>
          <h3 className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-label text-amber">
            <span className="h-2 w-2 rounded-full bg-amber" />
            Needs review — {review.length}
          </h3>
          <div className="space-y-2">
            {review.map((e) => (
              <ReviewCard key={e.field_id} e={e} />
            ))}
          </div>
        </section>
      )}

      {/* all fields */}
      <section>
        <h3 className="mb-3 font-mono text-[11px] uppercase tracking-label text-ink-dim">All fields</h3>
        <div className="bezel divide-y divide-hairline/70 overflow-hidden">
          {groups.map((g) => (
            <div key={g.section}>
              <div className="bg-panel-raised/40 px-4 py-2 font-mono text-[10px] uppercase tracking-label text-ink-faint">
                {g.section}
              </div>
              {g.entries.map((e) => (
                <FieldRow key={e.field_id} e={e} />
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ReviewCard({ e }: { e: ReviewEntry }) {
  const badge = deriveBadge(e);
  return (
    <div className={clsx("rounded-lg border border-hairline p-4", ROW_TINT[badge.tone])}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx("inline-block rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-label", TONE[badge.tone])}>
          {badge.label}
        </span>
        {e.confidence && e.confidence !== "none" && (
          <span className={clsx("font-mono text-[10px] uppercase tracking-label", CONF[e.confidence])}>
            {e.confidence} confidence
          </span>
        )}
      </div>
      <div className="mt-2.5 flex items-baseline justify-between gap-4">
        <span className="text-sm text-ink">
          {e.question_label ?? e.canonical_field ?? e.field_id}
          {e.is_required && <span className="ml-1 text-signal">*</span>}
        </span>
        <span className={clsx("shrink-0 font-mono text-sm", e.current_value ? "text-amber-soft" : "text-ink-faint")}>
          {e.current_value ?? "— not answered"}
        </span>
      </div>
      {e.detail && <p className="mt-2 text-xs leading-relaxed text-ink-dim">{e.detail}</p>}
    </div>
  );
}

function FieldRow({ e }: { e: ReviewEntry }) {
  const kind = statusKind(e);
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={clsx("h-2 w-2 shrink-0 rounded-full", DOT[kind])} />
      <span className="min-w-0 flex-1 truncate text-sm text-ink-dim">
        {e.question_label ?? e.canonical_field ?? e.field_id}
        {e.is_required && <span className="ml-1 text-ink-faint">*</span>}
      </span>
      <span
        className={clsx(
          "shrink-0 truncate font-mono text-[13px]",
          kind === "review" ? "text-amber-soft" : kind === "skip" ? "text-ink-faint" : "text-ink"
        )}
      >
        {e.current_value ?? (kind === "skip" ? "—" : "")}
      </span>
    </div>
  );
}
