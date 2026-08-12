"use client";

/**
 * ReviewEditor — the hosted review VIEWER + EDITOR (the website is now the primary
 * review surface, replacing the extension's summary.html). A faithful React port of the
 * extension's summary.js: needs-review-first with flag-driven prominence, every widget
 * editable in place, per-field / per-section / all approval with submit-readiness gating,
 * repeating-entry add + soft-delete (+undo), nested sub-sections (cert ▸ specialties),
 * and the currently-work-here / preferred-name visibility mirrors.
 *
 * React holds ONE bundle in state; every edit produces a new bundle and autosaves it
 * (debounced) to applications.review_bundle_json via saveReviewBundle. The extension
 * PULLS that approved bundle before replay — so this editor writes exactly the fields
 * runCdpReplayWalk / submitPrecondition read (current_value / edit_kind / is_deleted /
 * is_approved). Value edits reset that field's approval (a stale approval never rides a
 * changed value into replay).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { clsx } from "@/lib/clsx";
import type { ReviewBundle, ReviewEntry, FieldShape, WalkStatus } from "@/lib/review-summary";
import {
  editKindOf,
  checkedOf,
  tokenFor,
  withoutPlaceholderOptions,
  isPlaceholderOption,
  groupSelection,
  joinGroupValue,
  requiresApproval,
  approvalEnvelope,
  hasPlaceholder,
  isHiddenPreferredName,
  isPreferredCheckField,
  ensurePreferredNameEntries,
  isCurrentlyWorkHere,
  visibleEntryItems,
  newEntryRecords,
  addBackEntryRecords,
} from "@/lib/review-approval";
import {
  fmt,
  norm,
  humanize,
  sectionOf,
  nestedInfoOf,
  type NestedInfo,
  isSensitive,
  needsAnswer,
  isEeoGuess,
  isAiFlag,
  isSuperHard,
  mustReplace,
  isPrePopulated,
  isCascadeRevealed,
  isBecameRequired,
  orderForReview,
  normalizeDateOrder,
  todayForDateOrder,
  explainFill,
  statusOf,
  cleanPageName,
  pageNumOf,
  pageCaptionOf,
  sectionShapeFor,
  nextIndexFor,
  nextNestedIndexFor,
} from "@/lib/review-model";
import { saveReviewBundle } from "@/app/app/tracker/[id]/review-actions";

const PARTIAL_NOTE =
  "Options the search surfaced — not the full list. Edit on the form for other values.";
const TIER_NOTE =
  "Add candidate values, most specific first. On submit the replay tries each in order and uses the first that matches this field's options on the form.";

type Filter = "all" | "review" | "edited";
type SaveState = "idle" | "saving" | "saved" | "error";

const nowIso = () => new Date().toISOString();
const isEmptyVal = (e: ReviewEntry) => e.current_value == null || e.current_value === "";
const canApprove = (e: ReviewEntry) => !(e.is_required && isEmptyVal(e));

export function ReviewEditor({
  appId,
  initialBundle,
  canPersist,
}: {
  appId: string;
  initialBundle: ReviewBundle;
  canPersist: boolean;
}) {
  const [bundle, setBundle] = useState<ReviewBundle>(initialBundle);
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const firstRender = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const entries = bundle.entries;

  // ── autosave (debounced) ── never on the first render (that's just the loaded bundle).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!canPersist) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      const res = await saveReviewBundle(appId, bundle);
      setSaveState(res.ok ? "saved" : "error");
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [bundle, appId, canPersist]);

  // ── mutation helpers (immutable; React re-renders — no manual DOM refresher) ──
  const replaceEntries = useCallback((next: ReviewEntry[]) => {
    setBundle((b) => ({ ...b, entries: next, approval: approvalEnvelope(next) }));
  }, []);
  const patchEntry = useCallback(
    (fieldId: string, patch: Partial<ReviewEntry>) => {
      setBundle((b) => {
        const next = b.entries.map((e) => (e.field_id === fieldId ? { ...e, ...patch } : e));
        return { ...b, entries: next, approval: approvalEnvelope(next) };
      });
    },
    []
  );

  // commit a value edit (buildEditor's onCommit). Recompute edit_kind/is_edited; a VALUE edit
  // RESETS approval (re-review) — UNLESS the caller passes { approve: true }, which one-click buttons
  // that write a single self-evident value use (see "Today"). null = cleared.
  const commit = useCallback(
    (entry: ReviewEntry, val: string | null, opts?: { approve?: boolean; patch?: Partial<ReviewEntry> }) => {
      const value = val === "" || val == null ? null : val;
      const merged: ReviewEntry = { ...entry, current_value: value, ...(opts?.patch || {}) };
      const edit_kind = editKindOf(merged);
      const patch: Partial<ReviewEntry> = {
        current_value: value,
        edit_kind,
        is_edited: edit_kind !== null,
        // Structured state a widget owns alongside the display value — today only a checkbox group's
        // selected_options, the AUTHORITATIVE set behind the joined current_value. Without threading
        // it here the array was computed and silently dropped, so a two-option selection persisted as
        // a joined string with no array, and the replay had to guess by splitting it.
        ...(opts?.patch || {}),
      };
      // APPROVE IN THE SAME PATCH (operator 2026-07-28: "if today is pressed, automatically approve").
      // A value edit normally RESETS approval — a changed value deserves a fresh look. The exception is a
      // one-click button that writes ONE unambiguous, self-evident value: clicking "Today" IS the human
      // decision, so demanding a second click to confirm what you just chose is pure friction. Still
      // gated by canApprove (a required field left empty can never be approved), and done in ONE patch so
      // there's no intermediate state where the field reads edited-but-unapproved.
      if (opts?.approve && canApprove(merged)) {
        patch.is_approved = true;
        patch.approved_at = nowIso();
      } else if (entry.is_approved) {
        patch.is_approved = false;
        patch.approved_at = null;
      }
      // Preferred-name reveal (mirror the profile page + the form cascade): CHECKING "I have a
      // preferred name" reveals the preferred first/last fields. If the first fill had the box
      // UNCHECKED, the form never rendered them → they're absent from the bundle, so synthesize
      // editable rows here (right after the checkbox). Unchecking keeps them but isHiddenPreferredName
      // hides them from view. Needs setBundle (adds entries) — patchEntry only touches one field.
      if (isPreferredCheckField(entry) && checkedOf(value)) {
        setBundle((b) => {
          const patched = b.entries.map((e) => (e.field_id === entry.field_id ? { ...e, ...patch } : e));
          const withPref = ensurePreferredNameEntries(patched, { ...entry, ...patch });
          return { ...b, entries: withPref, approval: approvalEnvelope(withPref) };
        });
        return;
      }
      patchEntry(entry.field_id, patch);
    },
    [patchEntry]
  );

  const setApproved = useCallback(
    (entry: ReviewEntry, on: boolean) => {
      patchEntry(entry.field_id, { is_approved: on, approved_at: on ? nowIso() : null });
    },
    [patchEntry]
  );

  // tier editor: persist the ordered candidate list + track the TOP tier as current_value
  // (the effective value the replay reads). A change RESETS approval, like any value edit.
  const setTiers = useCallback(
    (entry: ReviewEntry, tiers: string[]) => {
      const top = tiers.length ? tiers[0] : null;
      const merged: ReviewEntry = { ...entry, current_value: top };
      const edit_kind = editKindOf(merged);
      const patch: Partial<ReviewEntry> = {
        tiers: tiers.length ? tiers : null,
        current_value: top,
        edit_kind,
        is_edited: edit_kind !== null,
      };
      if (entry.is_approved) {
        patch.is_approved = false;
        patch.approved_at = null;
      }
      patchEntry(entry.field_id, patch);
    },
    [patchEntry]
  );

  const approveAll = useCallback(() => {
    const at = nowIso();
    setBundle((b) => {
      const next = b.entries.map((e) =>
        requiresApproval(e) && canApprove(e) ? { ...e, is_approved: true, approved_at: at } : e
      );
      return { ...b, entries: next, approval: approvalEnvelope(next) };
    });
  }, []);

  const approveSection = useCallback((page: string | null, key: string) => {
    const at = nowIso();
    setBundle((b) => {
      const next = b.entries.map((e) =>
        e.page === page && sectionOf(e).key === key && requiresApproval(e) && canApprove(e)
          ? { ...e, is_approved: true, approved_at: at }
          : e
      );
      return { ...b, entries: next, approval: approvalEnvelope(next) };
    });
  }, []);

  const setEntryDeleted = useCallback(
    (page: string | null, key: string, index: number, del: boolean) => {
      setBundle((b) => {
        const next = b.entries.map((e) =>
          e.page === page && sectionOf(e).key === key && sectionOf(e).index === index
            ? { ...e, is_deleted: del }
            : e
        );
        return { ...b, entries: next, approval: approvalEnvelope(next) };
      });
    },
    []
  );

  const removeAddedEntry = useCallback(
    (page: string | null, key: string, index: number) => {
      setBundle((b) => {
        const next = b.entries.filter(
          (e) =>
            !(
              e.page === page &&
              sectionOf(e).key === key &&
              sectionOf(e).index === index &&
              e.is_added
            )
        );
        return { ...b, entries: next, approval: approvalEnvelope(next) };
      });
    },
    []
  );

  const addEntry = useCallback(
    (page: string | null, key: string) => {
      const shape = sectionShapeFor(bundle, page, key);
      if (!shape.length) return;
      const sample = bundle.entries.find((e) => e.page === page);
      const newIx = nextIndexFor(bundle, page, key);
      const recs = newEntryRecords(shape, {
        page,
        pageNumber: sample ? sample.page_number : null,
        pageLabel: sample ? sample.page_label : null,
        sectionKey: key,
        index: newIx,
        at: nowIso(),
      });
      // attach a nested sub-section stub if this section has recon'd nested shapes (cert ▸ specialties)
      const nsStub = bundle.entries.find(
        (e) =>
          e.page === page &&
          sectionOf(e).key === key &&
          e.widget_type === "section_stub" &&
          (e.nested_shapes || e.nested_attachments)
      );
      if (nsStub && nsStub.nested_shapes) {
        for (const childBase of Object.keys(nsStub.nested_shapes)) {
          const shp = nsStub.nested_shapes[childBase];
          if (!Array.isArray(shp) || !shp.length) continue;
          recs.push(nestedStubRecord(page, key, newIx, childBase, shp, sample));
        }
      }
      replaceEntries([...bundle.entries, ...recs]);
      requestAnimationFrame(() => recs[0] && jumpTo(recs[0]));
    },
    [bundle, replaceEntries]
  );

  const addNestedEntry = useCallback(
    (page: string | null, parentKey: string, parentIx: number, childBase: string, stub: ReviewEntry) => {
      const shape: FieldShape[] = (stub.section_field_shape || []).map((s) => ({
        recName: s.recName,
        path: s.path != null ? s.path : s.recName,
        widget_type: s.widget_type,
        is_required: !!s.is_required,
        label: s.label != null ? s.label : s.recName,
        options: Array.isArray(s.options) ? s.options : null,
        captured_options: null,
        tree_structure: null,
        date_order: s.date_order || null,
      }));
      if (!shape.length) return;
      const sample = bundle.entries.find((e) => e.page === page);
      const ci = nextNestedIndexFor(bundle, page, parentKey, parentIx, childBase);
      const recs = newEntryRecords(shape, {
        page,
        pageNumber: sample ? sample.page_number : null,
        pageLabel: sample ? sample.page_label : null,
        sectionKey: parentKey + "[" + parentIx + "]." + childBase,
        index: ci,
        at: nowIso(),
      });
      recs.forEach((r) => {
        r.container_prefix = stub.container_prefix || null;
        r.nested_child_base = childBase;
        r.nested_parent = stub.nested_parent || { base: parentKey, index: parentIx };
      });
      replaceEntries([...bundle.entries, ...recs]);
      requestAnimationFrame(() => recs[0] && jumpTo(recs[0]));
    },
    [bundle, replaceEntries]
  );

  const removeNestedAdded = useCallback(
    (page: string | null, parentKey: string, parentIx: number, childBase: string, ci: number) => {
      const re = new RegExp("^" + parentKey + "\\[" + parentIx + "\\]\\." + childBase + "\\[" + ci + "\\]");
      setBundle((b) => {
        const next = b.entries.filter(
          (e) => !(e.page === page && e.is_added && re.test(String(e.canonical_field || "")))
        );
        return { ...b, entries: next, approval: approvalEnvelope(next) };
      });
    },
    []
  );

  // ── Phase 2 (delete-with-memory): ADD BACK a removed_entry — reconstruct the entry PREFILLED from its
  // remembered_fields (deterministic values clean; AI/unfilled ones flagged), then drop the removed_entry
  // card. Mirrors addEntry but seeds values instead of a blank shape. ──
  const addBackEntry = useCallback(
    (removed: ReviewEntry) => {
      const remembered = removed.remembered_fields || [];
      if (!remembered.length) return;
      const page = removed.page != null ? removed.page : null;
      const key = sectionOf(removed).key;
      const unfilled = (removed.unfilled_fields || []).map((u) => u.recName);
      const sample = bundle.entries.find((e) => e.page === page);
      const newIx = nextIndexFor(bundle, page, key);
      const recs = addBackEntryRecords(remembered, unfilled, {
        page,
        pageNumber: sample ? sample.page_number : null,
        pageLabel: sample ? sample.page_label : null,
        sectionKey: key,
        index: newIx,
        at: nowIso(),
      });
      // carry the recon'd nested sub-sections (cert ▸ specialties) onto the reconstructed parent
      if (removed.nested_shapes) {
        for (const childBase of Object.keys(removed.nested_shapes)) {
          const shp = removed.nested_shapes[childBase];
          if (Array.isArray(shp) && shp.length) recs.push(nestedStubRecord(page, key, newIx, childBase, shp, sample));
        }
      }
      replaceEntries([...bundle.entries.filter((e) => e.field_id !== removed.field_id), ...recs]);
      requestAnimationFrame(() => recs[0] && jumpTo(recs[0]));
    },
    [bundle, replaceEntries]
  );

  // "Leave removed" — accept the deletion (an optional entry the tenant doesn't offer). Approve the card so
  // it stops blocking submit; it stays visible as resolved and is NOT replayed (removed_entry is skipped).
  const leaveRemoved = useCallback(
    (removed: ReviewEntry) => patchEntry(removed.field_id, { is_approved: true, approved_at: nowIso() }),
    [patchEntry]
  );

  // ── jump-to-field (expand section + switch to All + scroll/flash) ──
  const jumpTo = useCallback((e: ReviewEntry) => {
    const key = e.page + "||" + sectionOf(e).key;
    setCollapsed((c) => {
      const n = new Set(c);
      n.delete(key);
      return n;
    });
    setFilter("all");
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(e.field_id);
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.animate(
          [{ background: "rgba(255,182,39,0.18)" }, { background: "transparent" }],
          { duration: 1300, easing: "ease-out" }
        );
      }
    });
  }, []);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((c) => {
      const n = new Set(c);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }, []);

  // ── derived view state ──
  const live = useMemo(
    () => entries.filter((e) => !e.is_deleted && !isHiddenPreferredName(e, entries)),
    [entries]
  );
  const removedCount = entries.length - live.length;
  const editedCount = useMemo(() => live.filter((e) => editKindOf(e)).length, [live]);
  // COUNT WHAT IS LEFT TO DO, not what was ever flagged (2026-08-12). The chip used to hold at its
  // original number however many you approved, so "Needs review 9" sat directly above
  // "9 / 9 flagged fields approved" — the one strip a reviewer scans to know whether they are
  // finished flatly contradicted the approval bar underneath it.
  // ⚠ COUNT WHAT NEEDS APPROVING, WHICH IS NOT THE SAME SET AS `needs_review` (2026-08-12).
  // `requiresApproval` is needs_review OR cascade_revealed, and the approval bar has always counted
  // that set — so a page with 2 cascade-revealed fields showed "7" here and "0 / 9" in the bar, and
  // those 2 were reachable ONLY by hunting through All fields. You could approve all 7 the section
  // offered and stay stuck at 7/9 with nothing telling you where the rest were. The section, the
  // chip and the bar now all count the same thing.
  const reviewTotal = useMemo(() => live.filter((e) => requiresApproval(e)).length, [live]);
  const reviewPending = useMemo(() => live.filter((e) => requiresApproval(e) && !e.is_approved).length, [live]);
  const allReviewed = reviewTotal > 0 && reviewPending === 0;
  const liveCounts = useMemo(
    () =>
      live.reduce<Record<string, number>>((a, e) => {
        const k = e.fill_status || "unknown";
        a[k] = (a[k] || 0) + 1;
        return a;
      }, {}),
    [live]
  );
  const approval = useMemo(() => approvalEnvelope(entries), [entries]);
  // Flag AND the placeholder still present — the flag alone survives the operator REPLACING the
  // text (provenance is permanent), so a flag-only filter kept the "Submit blocked" banner up
  // forever after the answer was supplied (live 2026-07-31). LOCKSTEP with approvalEnvelope's
  // placeholdersLeft — the banner must never disagree with the gate it narrates.
  const blocked = useMemo(() => live.filter((e) => needsAnswer(e) && hasPlaceholder(e.current_value)), [live]);

  // NEW items first (questions a submit run sent back), then the pre-existing loudness ordering —
  // see reviewPriority. Stable, so form order still decides within a tier.
  const flagged = useMemo(() => orderForReview(live.filter((e) => requiresApproval(e))), [live]);
  // PENDING FIRST, APPROVED SUNK BELOW. An approved row must stay visible — you have to be able to
  // take an approval back — but it is no longer WORK, and leaving it interleaved meant the remaining
  // questions were scattered between rows that were already done.
  const flaggedPending = useMemo(() => flagged.filter((e) => !e.is_approved), [flagged]);
  const flaggedDone = useMemo(() => flagged.filter((e) => e.is_approved), [flagged]);

  const groupKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of entries) {
      const k = e.page + "||" + sectionOf(e).key;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
    return out;
  }, [entries]);

  const filterPass = useCallback(
    // "review" filters on the SAME predicate the chip counts, or clicking a chip reading 9 would
    // narrow the list to 7.
    (e: ReviewEntry) => (filter === "review" ? requiresApproval(e) : filter === "edited" ? !!editKindOf(e) : true),
    [filter]
  );

  const registerRow = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  }, []);

  // shared props threaded into the field renderer — STABLE (memoized over stable callbacks) so a
  // field row's ref-registration effect doesn't re-run on every keystroke elsewhere on the page.
  const ctx = useMemo<RowCtx>(
    () => ({ commit, setApproved, setTiers, registerRow, jumpTo, addBack: addBackEntry, leaveRemoved }),
    [commit, setApproved, setTiers, registerRow, jumpTo, addBackEntry, leaveRemoved]
  );

  return (
    <div className="space-y-6">
      {/* halt banner — WHY the fill didn't reach the end (loud, top of page) */}
      {bundle.walk_status && <WalkStatusBanner ws={bundle.walk_status} onePage={!!bundle.ats && bundle.ats !== "workday"} />}

      {/* header */}
      <div className="bezel flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold text-ink">Review your application</div>
          <div className="mt-1 font-mono text-[11px] tracking-label text-ink-faint">
            {cleanPageName(bundle)} · {fmt(bundle.tenant)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SaveBadge state={saveState} canPersist={canPersist} />
          <button className="btn-ghost text-xs" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button className="btn-ghost text-xs" onClick={() => setCollapsed(new Set(groupKeys))}>
            Collapse all
          </button>
        </div>
      </div>

      {/* filter strip */}
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-label">
        <FilterChip label="All" n={live.length} active={filter === "all"} onClick={() => setFilter("all")} />
        <FilterChip
          label={allReviewed ? "✓ Reviewed" : "Needs review"}
          n={allReviewed ? reviewTotal : reviewPending}
          tone={allReviewed ? "ok" : "warn"}
          active={filter === "review"}
          onClick={() => setFilter(filter === "review" ? "all" : "review")}
        />
        <FilterChip
          label="Edited"
          n={editedCount}
          tone="edit"
          active={filter === "edited"}
          onClick={() => setFilter(filter === "edited" ? "all" : "edited")}
        />
        <span className="ml-auto text-ink-faint">
          <span className="text-verified">{liveCounts.filled || 0}</span> filled
          {liveCounts.skipped ? <> · {liveCounts.skipped} skipped</> : null}
          {liveCounts.error ? <> · <span className="text-signal">{liveCounts.error}</span> error</> : null}
          {removedCount ? <> · {removedCount} removed</> : null}
        </span>
      </div>

      {/* approval bar */}
      <ApprovalBar
        approval={approval}
        onApproveAll={approveAll}
        incomplete={!!(bundle.walk_status && !bundle.walk_status.completed)}
      />

      {/* submit-blocked banner */}
      {blocked.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-signal/40 bg-signal/[0.06] px-4 py-3 text-sm">
          <span aria-hidden>⛔</span>
          <div>
            <b className="text-signal">
              Submit blocked — {blocked.length} required field{blocked.length > 1 ? "s" : ""} still hold
              {blocked.length > 1 ? "" : "s"} an AI placeholder.{" "}
            </b>
            <span className="text-ink-dim">Replace each below before submitting.</span>
          </div>
        </div>
      )}

      {/* needs review */}
      {flagged.length > 0 && filter !== "edited" && (
        <section>
          <SectionLabel
            title="Needs review"
            count={
              flaggedPending.length
                ? `${flaggedPending.length} of ${flagged.length} left to verify`
                : `all ${flagged.length} approved`
            }
            tone={flaggedPending.length ? "warn" : "ok"}
          />
          <div className="space-y-2">
            {flaggedPending.map((e) => (
              <FieldRow key={"rev-" + e.field_id} e={e} review ctx={ctx} />
            ))}
            {flaggedDone.length > 0 && flaggedPending.length > 0 && (
              <div className="flex items-center gap-2 pt-2">
                <span className="font-mono text-[10px] uppercase tracking-label text-verified">
                  ✓ approved ({flaggedDone.length})
                </span>
                <span className="h-px flex-1 bg-verified/20" />
              </div>
            )}
            {flaggedDone.map((e) => (
              <FieldRow key={"rev-" + e.field_id} e={e} review ctx={ctx} />
            ))}
          </div>
        </section>
      )}

      {/* all fields */}
      <section>
        <SectionLabel
          title={filter === "all" ? "All fields" : filter === "review" ? "Flagged fields" : "Edited fields"}
          count={`${live.length} total`}
        />
        <FieldList
          bundle={bundle}
          filter={filter}
          filterPass={filterPass}
          collapsed={collapsed}
          toggleCollapse={toggleCollapse}
          ctx={ctx}
          onAddEntry={addEntry}
          onDeleteEntry={(pg, key, ix) => setEntryDeleted(pg, key, ix, true)}
          onUndoDelete={(pg, key, ix) => setEntryDeleted(pg, key, ix, false)}
          onRemoveAdded={removeAddedEntry}
          onApproveSection={approveSection}
          onAddNested={addNestedEntry}
          onRemoveNested={removeNestedAdded}
        />
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Row context threaded through the tree (avoids prop-drilling the mutators everywhere).
type RowCtx = {
  commit: (e: ReviewEntry, v: string | null, opts?: { approve?: boolean; patch?: Partial<ReviewEntry> }) => void;
  setApproved: (e: ReviewEntry, on: boolean) => void;
  setTiers: (e: ReviewEntry, tiers: string[]) => void;
  registerRow: (id: string, node: HTMLDivElement | null) => void;
  jumpTo: (e: ReviewEntry) => void;
  addBack: (removed: ReviewEntry) => void; // Phase 2: reconstruct a removed_entry PREFILLED
  leaveRemoved: (removed: ReviewEntry) => void; // Phase 2: accept the removal (approve the card)
};

// ── the FIELD LIST (grouped by page → section, collapsible, repeating entries + nested) ──
function FieldList({
  bundle,
  filter,
  filterPass,
  collapsed,
  toggleCollapse,
  ctx,
  onAddEntry,
  onDeleteEntry,
  onUndoDelete,
  onRemoveAdded,
  onApproveSection,
  onAddNested,
  onRemoveNested,
}: {
  bundle: ReviewBundle;
  filter: Filter;
  filterPass: (e: ReviewEntry) => boolean;
  collapsed: Set<string>;
  toggleCollapse: (key: string) => void;
  ctx: RowCtx;
  onAddEntry: (pg: string | null, key: string) => void;
  onDeleteEntry: (pg: string | null, key: string, ix: number) => void;
  onUndoDelete: (pg: string | null, key: string, ix: number) => void;
  onRemoveAdded: (pg: string | null, key: string, ix: number) => void;
  onApproveSection: (pg: string | null, key: string) => void;
  onAddNested: (pg: string | null, pk: string, pi: number, cb: string, stub: ReviewEntry) => void;
  onRemoveNested: (pg: string | null, pk: string, pi: number, cb: string, ci: number) => void;
}) {
  const allEntries = bundle.entries.filter((e) => !isHiddenPreferredName(e, bundle.entries));
  const pageOrder: string[] = [];
  const pages: Record<string, ReviewEntry[]> = {};
  for (const e of allEntries) {
    const pg = String(e.page);
    if (!pages[pg]) {
      pages[pg] = [];
      pageOrder.push(pg);
    }
    pages[pg].push(e);
  }
  pageOrder.sort((a, b) => {
    const na = pageNumOf(pages[a]),
      nb = pageNumOf(pages[b]);
    if (na != null && nb != null) return na - nb;
    if (na != null) return -1;
    if (nb != null) return 1;
    return 0;
  });
  const multiPage = pageOrder.length > 1;

  const blocks: ReactNode[] = [];
  for (const pg of pageOrder) {
    const pageKey = pg === "null" ? null : pg;
    const groups = groupSections(pages[pg]);
    const grpNodes: ReactNode[] = [];
    for (const g of groups) {
      const key = pg + "||" + g.sec.key;
      const node = (
        <SectionGroup
          key={key}
          collapseKey={key}
          bundle={bundle}
          page={pageKey}
          sec={g.sec}
          items={g.items}
          filter={filter}
          filterPass={filterPass}
          collapsed={collapsed.has(key)}
          toggleCollapse={() => toggleCollapse(key)}
          ctx={ctx}
          onAddEntry={onAddEntry}
          onDeleteEntry={onDeleteEntry}
          onUndoDelete={onUndoDelete}
          onRemoveAdded={onRemoveAdded}
          onApproveSection={onApproveSection}
          onAddNested={onAddNested}
          onRemoveNested={onRemoveNested}
        />
      );
      grpNodes.push(node);
    }
    if (multiPage) {
      blocks.push(
        <div key={"cap-" + pg} className="mt-6 font-mono text-[11px] uppercase tracking-label text-ink-dim first:mt-0">
          {pageCaptionOf(pages[pg], pageKey)}
        </div>
      );
    }
    blocks.push(
      <div key={"tbl-" + pg} className="bezel divide-y divide-hairline/60 overflow-hidden">
        {grpNodes}
      </div>
    );
  }

  if (!blocks.length)
    return (
      <div className="bezel px-6 py-10 text-center text-sm text-ink-dim">
        {filter === "review" ? "Nothing needs review." : filter === "edited" ? "No edited fields yet." : "No fields."}
      </div>
    );
  return <div className="space-y-3">{blocks}</div>;
}

type SecInfo = ReturnType<typeof sectionOf>;
function groupSections(items: ReviewEntry[]): { sec: SecInfo; items: ReviewEntry[] }[] {
  const order: string[] = [];
  const byKey: Record<string, { sec: SecInfo; items: ReviewEntry[] }> = {};
  for (const e of items) {
    const sec = sectionOf(e);
    if (!byKey[sec.key]) {
      byKey[sec.key] = { sec, items: [] };
      order.push(sec.key);
    }
    byKey[sec.key].items.push(e);
  }
  return order.map((k) => byKey[k]);
}

// ── one collapsible SECTION group (flat fields, or repeating entry cards + nested) ──
function SectionGroup({
  collapseKey,
  bundle,
  page,
  sec,
  items,
  filter,
  filterPass,
  collapsed,
  toggleCollapse,
  ctx,
  onAddEntry,
  onDeleteEntry,
  onUndoDelete,
  onRemoveAdded,
  onApproveSection,
  onAddNested,
  onRemoveNested,
}: {
  collapseKey: string;
  bundle: ReviewBundle;
  page: string | null;
  sec: SecInfo;
  items: ReviewEntry[];
  filter: Filter;
  filterPass: (e: ReviewEntry) => boolean;
  collapsed: boolean;
  toggleCollapse: () => void;
  ctx: RowCtx;
  onAddEntry: (pg: string | null, key: string) => void;
  onDeleteEntry: (pg: string | null, key: string, ix: number) => void;
  onUndoDelete: (pg: string | null, key: string, ix: number) => void;
  onRemoveAdded: (pg: string | null, key: string, ix: number) => void;
  onApproveSection: (pg: string | null, key: string) => void;
  onAddNested: (pg: string | null, pk: string, pi: number, cb: string, stub: ReviewEntry) => void;
  onRemoveNested: (pg: string | null, pk: string, pi: number, cb: string, ci: number) => void;
}) {
  const realItems = items.filter((e) => e.widget_type !== "section_stub" && e.widget_type !== "removed_entry");
  const removedCards = items.filter((e) => e.widget_type === "removed_entry" && filterPass(e)); // Phase 2 delete-with-memory add-back cards
  const repeating = realItems.some((e) => sectionOf(e).index != null);
  const liveItems = (repeating ? realItems : items).filter((e) => !e.is_deleted);

  const body: ReactNode[] = [];
  if (repeating) {
    const idxOrder: number[] = [];
    const byIdx: Record<number, ReviewEntry[]> = {};
    for (const e of realItems) {
      const ix = sectionOf(e).index;
      if (ix == null) continue;
      if (!(ix in byIdx)) {
        byIdx[ix] = [];
        idxOrder.push(ix);
      }
      byIdx[ix].push(e);
    }
    idxOrder.sort((a, b) => a - b);
    for (const ix of idxOrder) {
      const entryItems = byIdx[ix];
      if (entryItems.every((e) => e.is_deleted)) {
        if (filter === "all")
          body.push(
            <DeletedRow key={"del-" + ix} ix={ix} onUndo={() => onUndoDelete(page, sec.key, ix)} />
          );
        continue;
      }
      const vis = visibleEntryItems(entryItems).filter(filterPass);
      if (!vis.length) continue;
      const added = entryItems.some((e) => e.is_added);
      body.push(
        <EntryHead
          key={"head-" + ix}
          ix={ix}
          added={added}
          onDelete={() => (added ? onRemoveAdded(page, sec.key, ix) : onDeleteEntry(page, sec.key, ix))}
        />
      );
      const own = vis.filter((e) => !nestedInfoOf(e));
      for (const e of own) body.push(<FieldRow key={e.field_id} e={e} ctx={ctx} />);
      // nested sub-sections (cert ▸ specialties)
      const nestedByChild: Record<string, { e: ReviewEntry; ni: NestedInfo }[]> = {};
      const childOrder: string[] = [];
      for (const e of vis) {
        const ni = nestedInfoOf(e);
        if (!ni) continue;
        if (!(ni.childBase in nestedByChild)) {
          nestedByChild[ni.childBase] = [];
          childOrder.push(ni.childBase);
        }
        nestedByChild[ni.childBase].push({ e, ni });
      }
      for (const cb of childOrder)
        body.push(
          <NestedSub
            key={"nsub-" + ix + "-" + cb}
            page={page}
            parentKey={sec.key}
            parentIx={ix}
            childBase={cb}
            bucket={nestedByChild[cb]}
            filter={filter}
            ctx={ctx}
            onAddNested={onAddNested}
            onRemoveNested={onRemoveNested}
          />
        );
    }
  } else {
    for (const e of items.filter((e) => !e.is_deleted && filterPass(e) && e.widget_type !== "removed_entry"))
      body.push(<FieldRow key={e.field_id} e={e} ctx={ctx} />);
  }

  // Phase 2 delete-with-memory: an add-back card per removed_entry (prefilled reconstruct, or leave removed).
  for (const rc of removedCards) body.push(<RemovedEntryCard key={rc.field_id} e={rc} ctx={ctx} />);

  // + Add entry (addable repeating section, "all" view only)
  const addable = filter === "all" && sectionShapeFor(bundle, page, sec.key).length > 0;
  // approve-by-section (repeating with flagged fields)
  const secFlagged = items.filter((e) => !e.is_deleted && requiresApproval(e));
  const pendingSec = secFlagged.filter((e) => !e.is_approved);
  const blockedReq = secFlagged.filter((e) => e.is_required && isEmptyVal(e));

  if (addable)
    body.push(
      <button key="add" className="ap-add" onClick={() => onAddEntry(page, sec.key)}>
        + Add entry
      </button>
    );
  if (repeating && secFlagged.length) {
    body.push(
      <button
        key="secapprove"
        className={clsx("ap-sec-approve", !pendingSec.length && "is-done")}
        disabled={pendingSec.length === 0}
        onClick={() => onApproveSection(page, sec.key)}
      >
        {pendingSec.length ? `✓ Approve section (${pendingSec.length})` : "✓ Section approved"}
      </button>
    );
    if (blockedReq.length)
      body.push(
        <div key="secnote" className="px-4 pb-3 text-xs text-ink-faint">
          {blockedReq.length} required field(s) still need a value before this section can be fully approved.
        </div>
      );
  }

  if (!body.length) return null;

  const heading = items.find((e) => e.section_heading)?.section_heading || sec.label;
  const visCount = liveItems.filter(filterPass).length;
  const nReview = liveItems.filter((e) => e.needs_review).length;
  const nFilled = liveItems.filter((e) => !e.needs_review && e.fill_status !== "skipped").length;
  const nSkip = liveItems.filter((e) => e.fill_status === "skipped").length;

  return (
    <div>
      <button
        className="flex w-full items-center gap-2 bg-panel-raised/40 px-4 py-2.5 text-left transition-colors hover:bg-panel-raised/60"
        aria-expanded={!collapsed}
        onClick={toggleCollapse}
      >
        <span className={clsx("text-ink-faint transition-transform", collapsed && "-rotate-90")}>▾</span>
        <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">{heading}</span>
        <span className="font-mono text-[10px] text-ink-faint">
          ({visCount}
          {visCount !== liveItems.length ? " of " + liveItems.length : ""})
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10px]">
          {nReview ? <GroupDot tone={liveItems.some((e) => e.needs_review && mustReplace(e)) ? "crit" : "warn"} n={nReview} /> : null}
          {nFilled ? <GroupDot tone="ok" n={nFilled} /> : null}
          {nSkip ? <GroupDot tone="skip" n={nSkip} /> : null}
        </span>
      </button>
      {!collapsed && <div>{body}</div>}
    </div>
  );
}

// ── nested sub-section (cert ▸ Specialties) ──
function NestedSub({
  page,
  parentKey,
  parentIx,
  childBase,
  bucket,
  filter,
  ctx,
  onAddNested,
  onRemoveNested,
}: {
  page: string | null;
  parentKey: string;
  parentIx: number;
  childBase: string;
  bucket: { e: ReviewEntry; ni: NestedInfo }[];
  filter: Filter;
  ctx: RowCtx;
  onAddNested: (pg: string | null, pk: string, pi: number, cb: string, stub: ReviewEntry) => void;
  onRemoveNested: (pg: string | null, pk: string, pi: number, cb: string, ci: number) => void;
}) {
  const stub = bucket.find((x) => x.ni?.kind === "stub")?.e;
  const fieldItems = bucket.filter((x) => x.ni?.kind === "field");
  const label = (stub && stub.question_label) || humanize(childBase) + " (0)";
  const singular = humanize(childBase).replace(/ies$/i, "y").replace(/s$/, "");
  const byCi: Record<number, ReviewEntry[]> = {};
  const ciOrder: number[] = [];
  for (const x of fieldItems) {
    const ci = (x.ni as { childIndex: number }).childIndex;
    if (!(ci in byCi)) {
      byCi[ci] = [];
      ciOrder.push(ci);
    }
    byCi[ci].push(x.e);
  }
  ciOrder.sort((a, b) => a - b);
  return (
    <div className="ml-4 border-l border-hairline/60 pl-3">
      <div className="px-4 py-2 font-mono text-[10px] uppercase tracking-label text-ink-faint">{label}</div>
      {stub?.detail && <div className="px-4 pb-1 text-xs text-ink-faint">{stub.detail}</div>}
      {ciOrder.map((ci) => {
        const added = byCi[ci].some((e) => e.is_added);
        return (
          <div key={ci}>
            <div className="flex items-center justify-between px-4 py-1.5">
              <span className="font-mono text-[10px] text-ink-dim">
                {singular} {ci + 1}
                {added ? " · added" : ""}
              </span>
              {added && (
                <button className="ap-del" onClick={() => onRemoveNested(page, parentKey, parentIx, childBase, ci)}>
                  <TrashIcon /> Remove
                </button>
              )}
            </div>
            {byCi[ci].map((e) => (
              <FieldRow key={e.field_id} e={e} ctx={ctx} />
            ))}
          </div>
        );
      })}
      {filter === "all" && stub && Array.isArray(stub.section_field_shape) && stub.section_field_shape.length > 0 && (
        <button className="ap-add" onClick={() => onAddNested(page, parentKey, parentIx, childBase, stub)}>
          + Add {singular.toLowerCase()}
        </button>
      )}
    </div>
  );
}

// ── ONE field row (used in both the review list and the section list) ──
function FieldRow({ e, review, ctx }: { e: ReviewEntry; review?: boolean; ctx: RowCtx }) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!review) ctx.registerRow(e.field_id, rowRef.current);
    return () => {
      if (!review) ctx.registerRow(e.field_id, null);
    };
  }, [e.field_id, review, ctx]);

  const kind = editKindOf(e);
  // Keyed on requiresApproval, not needs_review — a cascade-revealed field demands approval too, and
  // tinting it neutral made it look like settled background while it was still holding up the gate.
  const approvedRow = !!(requiresApproval(e) && e.is_approved);
  const pendingApproval = requiresApproval(e) && !e.is_approved;
  // A field the operator CHANGED that was NOT flagged for review → tint it green (a confirmed edit),
  // mirroring the extension viewer's f-edit. The "autofilled: <bot value>" ref shows too (below).
  const editedRow = !requiresApproval(e) && !!kind;
  // An APPROVED flagged row gets the same left-bar treatment a confirmed edit gets — a bare tint was
  // too close to the amber "still needs you" wash to read as done at a glance.
  const rowTint = approvedRow
    ? "border-l-2 border-verified/60 bg-verified/[0.06]"
    : pendingApproval && mustReplace(e)
      ? "bg-signal/[0.05]"
      : pendingApproval
        ? "bg-amber/[0.04]"
        : editedRow
          ? "border-l-2 border-verified/60 bg-verified/[0.07]"
          : "";

  const editor = <FieldEditor e={e} ctx={ctx} />;
  const showApprove = requiresApproval(e);

  return (
    <div ref={rowRef} className={clsx("px-4 py-3", rowTint)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:w-1/2">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Say APPROVED where the reason-for-flagging badges are, so the row states its own
                outcome instead of leaving the far-right button as the only tell. */}
            {review && approvedRow && (
              <span className="inline-block rounded border border-verified/50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label text-verified">
                ✓ approved
              </span>
            )}
            {review && <ReviewBadges e={e} />}
            <span className="text-sm text-ink">{fmt(e.question_label)}</span>
            {e.is_required && (
              <span className="text-signal" title="required">
                ✱
              </span>
            )}
            <StatusDot e={e} />
          </div>
          {review && explainFill(e) && (
            <p className="mt-1 text-xs leading-relaxed text-ink-dim">{explainFill(e)}</p>
          )}
          {review && e.tree_structure?.chosen && (
            <p className="mt-1 text-xs text-ink-faint">
              tree: «{fmt(e.tree_structure.chosen)}» →{" "}
              {(e.tree_structure.leaves || []).slice(0, 12).join(", ")}
              {(e.tree_structure.leaves || []).length > 12 ? ` … (${e.tree_structure.leaves!.length})` : ""}
            </p>
          )}
          {review && (
            <button className="mt-1 text-xs text-amber hover:underline" onClick={() => ctx.jumpTo(e)}>
              go to field ↓
            </button>
          )}
        </div>
        <div className="min-w-0 sm:w-1/2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{editor}</div>
            {showApprove && <ApproveToggle e={e} onToggle={(on) => ctx.setApproved(e, on)} />}
          </div>
          <FieldNotes e={e} review={review} kind={kind} />
        </div>
      </div>
    </div>
  );
}

function FieldNotes({ e, review, kind }: { e: ReviewEntry; review?: boolean; kind: ReviewEntry["edit_kind"] }) {
  const notes: ReactNode[] = [];
  const wt = e.widget_type;
  // partial-option note (typeahead/tree/radio-without-options)
  // The FILL now says whether these options are a filtered view (options_partial). Older bundles
  // don't carry it, so the length-based inference stays as the fallback — but its `> 2` threshold is
  // gone: a server-backed search that came back with one or two rows is the case that most needs
  // explaining, and it was the only one getting no explanation.
  const partial =
    e.options_partial === true ||
    (e.tree_structure && Array.isArray(e.tree_structure.leaves) && e.tree_structure.leaves.length > 0) ||
    ((wt === "radio" || wt === "checkbox_group") && !(e.options && e.options.length)) ||
    (wt === "typeahead" && !(e.options && e.options.length) && (e.captured_options?.length || 0) > 0);
  const tier =
    (wt === "typeahead" && !(e.options && e.options.length) && (e.captured_options?.length || 0) <= 2) ||
    wt === "hierarchical";
  if (partial) notes.push(<p key="p" className="mt-1 text-xs text-ink-faint">{PARTIAL_NOTE}</p>);
  if (tier) notes.push(<p key="t" className="mt-1 text-xs text-ink-faint">{TIER_NOTE}</p>);
  if (isPrePopulated(e))
    notes.push(
      <p key="pre" className="mt-1 text-xs text-ink-faint">
        {e.flag === "already-filled-match"
          ? "Pre-populated — matches your profile; not filled by ApplyPilot."
          : "Pre-populated — not filled by ApplyPilot; verify it's what you want."}
      </p>
    );
  if (!review && e.needs_review && !isPrePopulated(e) && explainFill(e))
    notes.push(<p key="d" className="mt-1 text-xs text-ink-dim">{explainFill(e)}</p>);
  // autofilled ref (only when the BOT actually had a value)
  if (kind && norm(e.original_ai_value) !== "")
    notes.push(
      <p key="af" className="mt-1 font-mono text-[11px] text-ink-faint">
        autofilled: <b className="text-ink-dim">{fmt(e.original_ai_value)}</b>
      </p>
    );
  return <>{notes}</>;
}

// ── the per-widget EDITOR (buildEditor equivalent) ──
function FieldEditor({ e, ctx }: { e: ReviewEntry; ctx: RowCtx }) {
  const wt = e.widget_type;
  const cur = e.current_value;
  const onCommit = (v: string | null, patch?: Partial<ReviewEntry>) => ctx.commit(e, v, patch ? { patch } : undefined);
  // "Today" writes one self-evident value, so it also approves — see commit()'s approve option.
  const onCommitApproved = (v: string | null) => ctx.commit(e, v, { approve: true });

  // file_upload: the résumé + top-level Documents are uploaded elsewhere (the profile /
  // attachments manager); per-entry attachments attach on the form. Display-only here.
  if (wt === "file_upload")
    return (
      <div className="text-sm text-ink-dim">
        {cur ? <span className="text-ink">{fmt(cur)}</span> : <span className="text-ink-faint">— manage files in your profile —</span>}
      </div>
    );
  if (wt === "section_stub" || wt === "nested_section_stub") return null;

  // tree-AI (cert): searchable over the chosen category's leaves (partial)
  // The menu's PROMPT row is not an answer, and on Workday it is TEMPORARY: once a real option is
  // chosen the placeholder leaves the menu and cannot be chosen again (operator 2026-08-02). Offering
  // it here would offer something the form no longer allows — and picking it would replay a value
  // Workday counts as empty, which is exactly how a live Waystar page got rejected. Stripped ONCE
  // here so every choice editor below (select / segmented / combobox) is covered by one rule.
  const opts = withoutPlaceholderOptions(e.options);
  const leaves = withoutPlaceholderOptions(e.tree_structure?.leaves ?? null);
  const capOpts = withoutPlaceholderOptions(e.captured_options);
  if (e.tree_structure && Array.isArray(e.tree_structure.leaves) && leaves.length)
    return <Combobox value={cur} options={leaves} onCommit={onCommit} />;
  // RADIO with a small option set → segmented Yes/No-style buttons (the same look as the profile's
  // toggles), which is how the field actually renders on the form. A large radio set falls back to a select.
  if (wt === "radio" && opts.length && opts.length <= 4)
    return <RadioButtons value={cur} options={opts} onCommit={onCommit} />;
  // CHECKBOX GROUP (2026-07-25): a pick-one set of checkboxes in ONE wrapper (the OFCCP disability
  // self-ID — "Yes, I have a disability…" / "No…" / "I do not want to answer"). Radio-like, so it gets
  // the same editors. Its options come from the page scan (read straight from the DOM), so a voluntary
  // self-ID question the bot correctly left BLANK still renders a real picker instead of a textbox.
  // Long legal option labels wrap badly as segmented buttons → always the select.
  // A checkbox GROUP is a SET, and some are genuinely multi (PSECU's ethnicityMulti keeps two
  // checked and saves both). A <select> could only ever express one, so the review silently
  // narrowed what the form allows. Render it the way the form does — real checkboxes.
  if (wt === "checkbox_group" && opts.length)
    return <CheckboxGroupBox entry={e} options={opts} onCommit={onCommit} />;
  if ((wt === "dropdown" || wt === "radio") && opts.length)
    return <SelectBox value={cur} options={opts} onCommit={onCommit} />;
  if (wt === "radio" || wt === "checkbox_group") return <TextBox value={cur} onCommit={onCommit} />;
  if (wt === "checkbox")
    return (
      <label className="inline-flex items-center gap-2 text-sm text-ink-dim">
        <input
          type="checkbox"
          className="ap-check"
          checked={checkedOf(cur)}
          onChange={(ev) => onCommit(String(tokenFor(e.original_ai_value, ev.target.checked)))}
        />
        <span>{checkedOf(cur) ? "Checked" : "Unchecked"}</span>
      </label>
    );
  if (wt === "typeahead") {
    if (opts.length) return <Combobox value={cur} options={opts} onCommit={onCommit} />;
    const co = capOpts;
    // A PARTIAL list must not be a pick-one <select>: captured_options is only the page the
    // fill could read (live 2026-07-31 — 60 of a ~2000-school picker, alphabetical, so the
    // right answer is usually absent). A select there is a dead end on a REQUIRED field. Show
    // the captured options to choose from AND let the reviewer type the value the form really
    // wants — the replay searches the live widget for it by name.
    if (co.length > 2) return <PartialCombobox value={cur} options={co} onCommit={onCommit} />;
    return <TierEditor e={e} ctx={ctx} />;
  }
  if (wt === "hierarchical") return <TierEditor e={e} ctx={ctx} />;
  if (wt === "date")
    return <DateSeg value={cur} order={e.date_order} onCommit={onCommit} onCommitToday={onCommitApproved} />;
  if (wt === "textarea") return <TextBox value={cur} onCommit={onCommit} textarea />;
  return <TextBox value={cur} onCommit={onCommit} />;
}


// Checkbox GROUP — the form's own shape. Ticking a second option ADDS it (that is what the page
// does); unticking removes it. The committed value is the joined set, so everything downstream —
// the submit gate's blank test, the review-page reconcile, the replay — keeps reading one string,
// while `selected_options` carries the authoritative array.
function CheckboxGroupBox({
  entry,
  options,
  onCommit,
}: {
  entry: ReviewEntry;
  options: string[];
  onCommit: (v: string | null, extra?: Partial<ReviewEntry>) => void;
}) {
  const selected = groupSelection(entry);
  const isOn = (o: string) => selected.some((s) => norm(s) === norm(o));
  const toggle = (o: string) => {
    // Preserve the FORM's option order, not click order — it is the order a reviewer reads.
    const next = isOn(o) ? selected.filter((s) => norm(s) !== norm(o)) : [...selected, o];
    const ordered = options.filter((opt) => next.some((s) => norm(s) === norm(opt)));
    const extras = next.filter((s) => !options.some((opt) => norm(opt) === norm(s))); // an approved value not on this form
    const all = [...ordered, ...extras];
    onCommit(all.length ? joinGroupValue(all) : null, { selected_options: all });
  };
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((o) => (
        <label key={o} className="inline-flex cursor-pointer items-start gap-2 text-sm text-ink-dim hover:text-ink">
          <input type="checkbox" className="ap-check mt-0.5 shrink-0" checked={isOn(o)} onChange={() => toggle(o)} />
          <span>{o}</span>
        </label>
      ))}
      {selected.length > 1 && (
        <p className="mt-0.5 font-mono text-[10px] text-ink-faint">{selected.length} selected — this form accepts more than one.</p>
      )}
    </div>
  );
}
// ── small editor primitives ──
function SelectBox({
  value,
  options,
  onCommit,
}: {
  value: string | null | undefined;
  options: string[];
  onCommit: (v: string | null) => void;
}) {
  const list = options.slice();
  // An off-list CURRENT value is normally preserved as a row so an edit never silently drops it —
  // but NOT a prompt row. A bundle can hold one (an older build let the AI pick "Select One"), and
  // re-offering it would let the reviewer approve a non-answer. It falls through to "— choose —".
  const phValue = isPlaceholderOption(value);
  if (value != null && value !== "" && !phValue && !list.includes(value)) list.unshift(value);
  return (
    <select className="ap-input" value={phValue ? "" : value ?? ""} onChange={(e) => onCommit(e.target.value || null)}>
      <option value="" className="bg-panel text-ink-faint">— choose —</option>
      {list.map((o) => (
        <option key={o} value={o} className="bg-panel text-ink">
          {o}
        </option>
      ))}
    </select>
  );
}

// Radio → segmented buttons (the profile's Yes/No toggle look). Reflects how the field renders on the
// form; selecting commits that option. Used for small radio sets (yes/no + a few); larger sets → select.
function RadioButtons({
  value,
  options,
  onCommit,
}: {
  value: string | null | undefined;
  options: string[];
  onCommit: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap overflow-hidden rounded-md border border-hairline">
      {options.map((o, idx) => {
        const active = norm(value) === norm(o);
        return (
          <button
            key={o}
            type="button"
            onClick={() => onCommit(o)}
            className={clsx(
              "flex-1 whitespace-nowrap px-3 py-1.5 text-sm transition-colors",
              idx > 0 && "border-l border-hairline",
              active ? "bg-amber font-semibold text-cockpit" : "text-ink-dim hover:bg-panel-raised/40 hover:text-ink"
            )}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** Editor for a PARTIAL option list (captured_options): the fill could only read one page of a
 *  long/searchable list, so the right answer may not be in it. Filter what we captured, or type
 *  the exact value the form wants — the replay searches the live widget by name. Never a plain
 *  <select>, which would strand a required field whose answer is outside the captured page. */
function PartialCombobox({
  value,
  options,
  onCommit,
}: {
  value: string | null | undefined;
  options: string[];
  onCommit: (v: string | null) => void;
}) {
  const [v, setV] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  useEffect(() => setV(value ?? ""), [value]);
  const q = v.trim().toLowerCase();
  const matches = (q === "" ? options : options.filter((o) => o.toLowerCase().includes(q))).slice(0, 40);
  const commit = (s: string) => { setV(s); setOpen(false); onCommit(s.trim() === "" ? null : s); };
  return (
    <div className="relative">
      <input
        className="ap-input"
        type="text"
        value={v}
        placeholder="Type the exact value, or pick below"
        onChange={(ev) => { setV(ev.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); onCommit(v.trim() === "" ? null : v); }, 150)}
        onKeyDown={(ev) => ev.key === "Enter" && commit(v)}
      />
      <p className="mt-1 text-xs text-ink-faint">
        Showing {options.length} option{options.length === 1 ? "" : "s"} we could read from this form — it has more. Type the exact value if it is not listed.
      </p>
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-hairline bg-panel shadow-lg">
          {matches.map((o) => (
            <button key={o} type="button" onMouseDown={(ev) => ev.preventDefault()} onClick={() => commit(o)}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-panel-raised">
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TextBox({
  value,
  onCommit,
  textarea,
}: {
  value: string | null | undefined;
  onCommit: (v: string | null) => void;
  textarea?: boolean;
}) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  const commit = () => onCommit(v.trim() === "" ? null : v);
  return textarea ? (
    <textarea
      className="ap-input min-h-[72px]"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
    />
  ) : (
    <input
      className="ap-input"
      type="text"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

// A single-layer typeahead editor: click in → a LARGE dropdown of ALL the options (not pre-filtered by
// the current value), type to filter. The input shows the current value when unfocused; on focus the
// filter starts EMPTY so the full list is visible. The current value is highlighted; "clear" is demoted
// to a small footer, not the first item. (operator 2026-07-21)
function Combobox({
  value,
  options,
  onCommit,
}: {
  value: string | null | undefined;
  options: string[];
  onCommit: (v: string | null) => void;
}) {
  const [q, setQ] = useState(""); // the FILTER query (starts empty → show ALL options)
  const [open, setOpen] = useState(false);
  const matches = q.trim() === "" ? options : options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (v: string | null) => {
    onCommit(v);
    setQ("");
    setOpen(false);
  };
  const hasValue = value != null && String(value).trim() !== "";
  return (
    <div className="relative">
      <input
        className="ap-input"
        type="text"
        // unfocused → show the current value; focused → the filter query (empty until they type → all options)
        value={open ? q : hasValue ? String(value) : ""}
        placeholder={hasValue ? String(value) : "click to choose · type to filter…"}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQ(""); // reset the filter so the FULL option list shows on click
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches.length) {
            e.preventDefault();
            pick(matches[0]);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-hairline bg-panel-raised shadow-lg">
          {matches.length === 0 && <div className="px-3 py-2 text-xs text-ink-faint">no matches</div>}
          {matches.map((o) => (
            <button
              key={o}
              className={clsx("ap-opt", norm(o) === norm(value) && "bg-amber/10 font-medium text-amber")}
              onMouseDown={(ev) => (ev.preventDefault(), pick(o))}
            >
              {o}
            </button>
          ))}
          {hasValue && (
            <button
              className="ap-opt border-t border-hairline/60 text-xs text-ink-faint"
              onMouseDown={(ev) => (ev.preventDefault(), pick(null))}
            >
              — clear —
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const DATE_META: Record<string, { ph: string; max: number }> = {
  month: { ph: "MM", max: 2 },
  day: { ph: "DD", max: 2 },
  year: { ph: "YYYY", max: 4 },
};
function DateSeg({
  value,
  order,
  onCommit,
  onCommitToday,
}: {
  value: string | null | undefined;
  order: string[] | null | undefined;
  onCommit: (v: string | null) => void;
  /** "Today" commits AND approves (the click is the decision). Falls back to onCommit if not given. */
  onCommitToday?: (v: string | null) => void;
}) {
  // NORMALIZE, never trust: an unrecognized token used to render as the input's placeholder (live —
  // raw `dateSectionMonth-display` ids printed as the field's content). normalizeDateOrder heals a raw
  // or stale order, and anything it can't map degrades to a plain text box instead of showing junk.
  const norm = normalizeDateOrder(order);
  const segs = norm.length ? norm : null;
  const [parts, setParts] = useState<string[]>(() => String(value ?? "").split("/"));
  useEffect(() => setParts(String(value ?? "").split("/")), [value]);
  if (!segs) return <TextBox value={value} onCommit={onCommit} />;
  const setPart = (i: number, raw: string, max: number) => {
    const digits = raw.replace(/\D/g, "").slice(0, max);
    const next = segs.map((_, k) => (k === i ? digits : parts[k] || ""));
    setParts(next);
  };
  const commit = () => {
    const vals = segs.map((_, i) => (parts[i] || "").trim());
    onCommit(vals.every((v) => v === "") ? null : vals.join("/"));
  };
  return (
    <div className="flex items-center gap-1">
      {segs.map((s, i) => {
        const m = DATE_META[s] || { ph: s, max: 4 };
        return (
          <span key={s} className="flex items-center gap-1">
            {i > 0 && <span className="text-ink-faint">/</span>}
            <input
              className={clsx("ap-input text-center", s === "year" ? "w-16" : "w-12")}
              inputMode="numeric"
              placeholder={m.ph}
              maxLength={m.max}
              value={parts[i] || ""}
              onChange={(e) => setPart(i, e.target.value, m.max)}
              onBlur={commit}
            />
          </span>
        );
      })}
      {/* "Today" — the one date a form asks for that the profile can never hold is today's (a signature
          or acknowledgement date), and it's the field most likely to come back as BECAME REQUIRED.
          Commits the computed values DIRECTLY rather than going through `commit()`, which reads the
          `parts` state that this same click is setting (a stale-state race). */}
      <button
        type="button"
        className="btn-ghost ml-1 shrink-0 px-2 py-1 text-[11px]"
        title="Fill in today's date and approve it"
        onClick={() => {
          const vals = todayForDateOrder(segs);
          setParts(vals);
          (onCommitToday || onCommit)(vals.join("/"));
        }}
      >
        Today
      </button>
    </div>
  );
}

// TIER editor (hierarchical / tree fields): an ORDERED candidate list (most specific first),
// stored on entry.tiers; current_value tracks the TOP tier (the effective value).
function TierEditor({ e, ctx }: { e: ReviewEntry; ctx: RowCtx }) {
  const tiers = Array.isArray(e.tiers)
    ? e.tiers
    : e.current_value != null && e.current_value !== ""
      ? [e.current_value]
      : [];
  const [draft, setDraft] = useState("");
  const setTiers = (next: string[]) => ctx.setTiers(e, next);
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    setTiers([...tiers, v]);
    setDraft("");
  };
  return (
    <div className="rounded-md border border-hairline bg-panel-raised/40 p-2">
      <div className="mb-1 flex items-baseline gap-2 text-xs">
        <span className="font-mono uppercase tracking-label text-ink-faint">Filled</span>
        <span className={clsx("font-mono", e.current_value ? "text-ink" : "text-ink-faint")}>
          {e.current_value ? String(e.current_value) : "— blank —"}
        </span>
      </div>
      <div className="mb-1.5 text-[11px] text-ink-faint">Values to try on re-fill (most specific first)</div>
      <div className="flex gap-1">
        <input
          className="ap-input flex-1"
          type="text"
          placeholder="value to try"
          value={draft}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => ev.key === "Enter" && (ev.preventDefault(), add())}
        />
        <button className="btn-ghost text-xs" onClick={add}>
          Try this next
        </button>
      </div>
      {tiers.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {tiers.map((t, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-ink-faint">{i + 1}.</span>
              <span className="flex-1 text-ink-dim">{t}</span>
              <button
                className="text-ink-faint hover:text-signal"
                onClick={() => setTiers(tiers.filter((_, k) => k !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── small presentational bits ──
function ReviewBadges({ e }: { e: ReviewEntry }) {
  const badges: ReactNode[] = [];
  if (isSuperHard(e))
    badges.push(
      <Badge key="sh" tone="crit">
        {e.flag === "ai-closest-forced" ? "AI FORCED" : "LOW-CONF AI"}
      </Badge>
    );
  // "BECAME REQUIRED" and "REVEALED" are both cascade_revealed, but they are different news for the
  // human: one merely appeared, the other is a question the form is now DEMANDING an answer to. Checked
  // first so exactly one of the two shows (operator 2026-07-27).
  if (isBecameRequired(e))
    badges.push(
      <Badge
        key="br"
        tone="warn"
        title="The form made this field required after you reviewed this application — it was optional (or absent) then, so there's no approved answer for it yet. Answer it here, then submit again."
      >
        ✱ BECAME REQUIRED
      </Badge>
    );
  else if (isCascadeRevealed(e))
    badges.push(
      <Badge key="cr" tone="warn" title="This field appeared only after an earlier value committed — confirm it.">
        ⤴ REVEALED
      </Badge>
    );
  if (isSensitive(e))
    badges.push(
      <Badge key="ll" tone="crit">
        ⚠ LEGALLY-LOADED — VERIFY
      </Badge>
    );
  else if (isEeoGuess(e))
    badges.push(
      <Badge key="eeo" tone="warn">
        AI-GUESSED DEMOGRAPHIC — VERIFY
      </Badge>
    );
  else if (needsAnswer(e))
    badges.push(
      <Badge key="na" tone="crit">
        NEEDS ANSWER
      </Badge>
    );
  else if (isAiFlag(e) && !isSuperHard(e))
    badges.push(
      <Badge key="ai" tone="info" title="AI helped fill this — matched your profile to the form, or inferred it. See the note below.">
        AI-FILLED
      </Badge>
    );
  else if (isPrePopulated(e))
    badges.push(
      <Badge key="pre" tone="info">
        PRE-POPULATED
      </Badge>
    );
  return <>{badges}</>;
}

const BADGE_TONE: Record<"crit" | "warn" | "info", string> = {
  crit: "border-signal/50 text-signal",
  warn: "border-amber/50 text-amber",
  info: "border-hairline text-ink-dim",
};
function Badge({ tone, title, children }: { tone: "crit" | "warn" | "info"; title?: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-block rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-label",
        BADGE_TONE[tone]
      )}
    >
      {children}
    </span>
  );
}

const DOT: Record<ReturnType<typeof statusOf>, string> = {
  ok: "bg-verified",
  warn: "bg-amber",
  crit: "bg-signal",
  skip: "bg-ink-faint",
};
function StatusDot({ e }: { e: ReviewEntry }) {
  // Debug tooltip — the precise engine detail lives here (and in the bundle + SW logs); the visible
  // card copy is the intuitive explainFill() line.
  const tip = [e.widget_type, e.canonical_field, e.match_tier, e.flag, "confidence: " + e.confidence, e.detail]
    .filter(Boolean)
    .join("  ·  ");
  return <span className={clsx("ml-1 h-2 w-2 shrink-0 rounded-full", DOT[statusOf(e)])} title={tip} />;
}

function ApproveToggle({ e, onToggle }: { e: ReviewEntry; onToggle: (on: boolean) => void }) {
  const [note, setNote] = useState<string | null>(null);
  const click = () => {
    if (!e.is_approved && !canApprove(e)) {
      setNote("Fill in this required field before approving.");
      setTimeout(() => setNote(null), 4000);
      return;
    }
    setNote(null);
    onToggle(!e.is_approved);
  };
  return (
    <div className="shrink-0">
      <button
        className={clsx(
          "rounded-md border px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-label transition-colors",
          e.is_approved
            ? "border-verified/50 bg-verified/10 text-verified"
            : "border-hairline text-ink-dim hover:border-ink-dim"
        )}
        onClick={click}
      >
        {e.is_approved ? "✓ Approved" : "Approve"}
      </button>
      {note && <div className="mt-1 max-w-[10rem] text-[10px] text-signal">{note}</div>}
    </div>
  );
}

// Loud halt banner — WHY a fill didn't reach the review page (error / empty-required / cancelled /
// other) + the exact form errors + an edit-my-profile link. Only shows when the walk did NOT complete.
function WalkStatusBanner({ ws, onePage }: { ws: WalkStatus; onePage?: boolean }) {
  if (ws.completed) return null;
  const errors = (ws.page_errors || []).filter(Boolean);
  const empties = ws.empty_fields || [];
  const pg = ws.stopped_page ?? "?";
  // Greenhouse / Lever / Ashby applications are a SINGLE page with no review step, so Workday's
  // "before reaching the review page" and "on page N" describe things that do not exist there
  // (operator, 2026-08-05). Same facts, wording that matches the form the operator is looking at.
  const onPage = onePage ? "" : ` on page ${pg}`;
  const reason = ws.cancelled
    ? `This fill was cancelled mid-run${onePage ? "" : " before reaching the review page"}.`
    : errors.length
      ? `The form rejected a value${onPage}, so the fill couldn't continue.`
      : empties.length
        ? `Required fields${onPage} had no value in your profile, so the fill couldn't continue.`
        : onePage
          ? "The fill didn't get through the whole form."
          : `The fill stopped on page ${pg} before reaching the review page.`;
  // "Edit my profile" only makes sense when a PROFILE VALUE is the problem (the form rejected a value,
  // or a required field was empty). A cancellation — or any stop with no data problem detected — isn't a
  // profile issue, so it gets a re-run message instead of pointing the operator at their profile.
  const isDataProblem = errors.length > 0 || empties.length > 0;
  return (
    <div className="rounded-lg border border-signal/50 bg-signal/[0.07] px-5 py-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="text-lg leading-none">⛔</span>
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="font-display text-sm font-semibold text-signal">Fill didn&apos;t finish — needs your attention</div>
          <p className="text-sm text-ink">{reason}</p>
          {errors.length > 0 && (
            <div className="space-y-1">
              <div className="font-mono text-[10px] uppercase tracking-label text-ink-faint">Errors on the form</div>
              <ul className="space-y-1">
                {errors.map((er, i) => (
                  <li
                    key={i}
                    className="rounded border border-signal/30 bg-cockpit px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-signal"
                  >
                    {er}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {empties.length > 0 && (
            <p className="text-xs text-ink-dim">
              Empty required field{empties.length > 1 ? "s" : ""}: {empties.map((f) => f.field).join(", ")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-0.5">
            {isDataProblem ? (
              <>
                <Link href="/app/profile" className="btn-ghost text-xs">
                  Edit my profile
                </Link>
                <span className="text-xs text-ink-faint">
                  {errors.length
                    ? "Fix the value on your profile, re-sync, then refill."
                    : "Add the missing value to your profile, re-sync, then refill."}
                </span>
              </>
            ) : ws.cancelled ? (
              <span className="text-xs text-ink-faint">Nothing&apos;s wrong with your data — just start the fill again from the extension.</span>
            ) : (
              <span className="text-xs text-ink-faint">Check that page on the form, then run the fill again — this is often a transient.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ApprovalBar({
  approval,
  onApproveAll,
  incomplete,
}: {
  approval: ReturnType<typeof approvalEnvelope>;
  onApproveAll: () => void;
  incomplete?: boolean;
}) {
  const [refillClicked, setRefillClicked] = useState(false);
  const total = approval.to_approve_count;
  const done = approval.approved_count;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  // When the fill DIDN'T reach the review page, the primary action is REFILL (not submit) — and it's
  // NOT gated on approving everything: approve the fields that are correct, then refill. Otherwise the
  // usual submit-readiness guidance.
  const note = incomplete
    ? refillClicked
      ? "Approvals saved. On the Workday tab, open the extension and click “CDP REFILL” — your approved fields replay (the same commit as submit, so they won’t re-flag) and everything else re-fills fresh from your profile."
      : "This fill didn’t finish. Approve the fields that are already correct (optional), then Refill — approved fields replay and won’t re-flag; the rest re-fill fresh."
    : approval.submit_ready
      ? "Ready to submit — run “Replay + SUBMIT” in the extension; it pulls these approved values. (Real submit stays behind the eyes-on, disposable-app gate.)"
      : approval.unreplaced_placeholders
        ? `Replace ${approval.unreplaced_placeholders} AI placeholder${approval.unreplaced_placeholders > 1 ? "s" : ""} on the form, then approve the remaining flagged fields.`
        : `Approve the ${approval.pending_count} remaining flagged field${approval.pending_count === 1 ? "" : "s"} to continue.`;
  return (
    <div className="bezel space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-[11px] tracking-label text-ink-dim">
          {total === 0 ? (
            <>
              <b className="text-verified">Nothing flagged</b> — all fields approved by default
            </>
          ) : (
            <>
              <b className="text-ink">
                {done} / {total}
              </b>{" "}
              flagged fields approved
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost text-xs"
            disabled={total === 0 || done === total}
            onClick={onApproveAll}
          >
            Approve all reviewed
          </button>
          {incomplete ? (
            <button
              className="rounded-md bg-amber/20 px-3 py-1.5 text-xs font-medium text-amber transition-colors hover:bg-amber/30"
              onClick={() => setRefillClicked(true)}
              title="Approvals are saved automatically — re-run the fill from the extension"
            >
              Refill
            </button>
          ) : (
            <button
              className={clsx(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                approval.submit_ready
                  ? "bg-verified/20 text-verified hover:bg-verified/30"
                  : "cursor-not-allowed bg-panel-raised text-ink-faint"
              )}
              disabled={!approval.submit_ready}
              title={approval.submit_ready ? "Approved — submit from the extension" : note}
            >
              Approve &amp; continue to submit
            </button>
          )}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-raised">
        <div
          className={clsx(
            "h-full transition-all",
            incomplete ? "bg-amber" : approval.submit_ready ? "bg-verified" : "bg-amber"
          )}
          style={{ width: pct + "%" }}
        />
      </div>
      <p className="text-xs text-ink-dim">{note}</p>
    </div>
  );
}

function SaveBadge({ state, canPersist }: { state: SaveState; canPersist: boolean }) {
  if (!canPersist)
    return <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">preview — not saved</span>;
  const map: Record<SaveState, { t: string; c: string }> = {
    idle: { t: "", c: "" },
    saving: { t: "saving…", c: "text-ink-faint" },
    saved: { t: "✓ saved", c: "text-verified" },
    error: { t: "⚠ save failed", c: "text-signal" },
  };
  const m = map[state];
  if (!m.t) return null;
  return <span className={clsx("font-mono text-[10px] uppercase tracking-label", m.c)}>{m.t}</span>;
}

function FilterChip({
  label,
  n,
  active,
  tone,
  onClick,
}: {
  label: string;
  n: number;
  active: boolean;
  tone?: "warn" | "edit" | "ok";
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        "rounded-full border px-3 py-1 transition-colors",
        active
          ? "border-ink-dim bg-panel-raised text-ink"
          : tone === "ok"
            ? "border-verified/40 text-ink-dim hover:border-verified"
            : "border-hairline text-ink-dim hover:border-ink-dim"
      )}
    >
      <span className={clsx(tone === "warn" && "text-amber", tone === "edit" && "text-ink", tone === "ok" && "text-verified")}>
        {label}
      </span>{" "}
      <span className="text-ink-faint">{n}</span>
    </button>
  );
}

function SectionLabel({ title, count, tone }: { title: string; count: string; tone?: "warn" | "ok" }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h3
        className={clsx(
          "font-mono text-[11px] uppercase tracking-label",
          tone === "warn" ? "text-amber" : tone === "ok" ? "text-verified" : "text-ink-dim"
        )}
      >
        {title}
      </h3>
      <span className={clsx("font-mono text-[10px]", tone === "ok" ? "text-verified/80" : "text-ink-faint")}>{count}</span>
      <span className="h-px flex-1 bg-hairline/60" />
    </div>
  );
}

function GroupDot({ tone, n }: { tone: "crit" | "warn" | "ok" | "skip"; n: number }) {
  const c = { crit: "bg-signal", warn: "bg-amber", ok: "bg-verified", skip: "bg-ink-faint" }[tone];
  return (
    <span className="flex items-center gap-1">
      <span className={clsx("h-1.5 w-1.5 rounded-full", c)} />
      <span className="text-ink-faint">{n}</span>
    </span>
  );
}

function EntryHead({ ix, added, onDelete }: { ix: number; added: boolean; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between border-t border-hairline/40 px-4 pt-3">
      <span className="font-mono text-[11px] uppercase tracking-label text-ink-dim">
        Entry {ix + 1}
        {added ? " · added" : ""}
      </span>
      <button className="ap-del" onClick={onDelete}>
        <TrashIcon /> {added ? "Remove" : "Delete"}
      </button>
    </div>
  );
}

function DeletedRow({ ix, onUndo }: { ix: number; onUndo: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs text-ink-faint">
      <s>Entry {ix + 1}</s>
      <span>removed</span>
      <button className="text-amber hover:underline" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}

// Phase 2 (delete-with-memory): an entry the fill DELETED because a required field couldn't be filled,
// but whose values it REMEMBERED. The card shows the remembered fields (missing ones highlighted) + two
// actions: "Add it back" reconstructs the entry PREFILLED (ctx.addBack); "Leave removed" accepts the
// deletion (ctx.leaveRemoved). One or the other must happen before the app is submit-ready.
function RemovedEntryCard({ e, ctx }: { e: ReviewEntry; ctx: RowCtx }) {
  const remembered = e.remembered_fields || [];
  const unfilled = new Set((e.unfilled_fields || []).map((u) => u.recName));
  const accepted = !!e.is_approved;
  return (
    <div
      ref={(n) => ctx.registerRow(e.field_id, n)}
      className={clsx(
        "mx-4 mb-3 rounded-lg border p-3",
        accepted ? "border-hairline bg-panel-raised/40" : "border-amber/40 bg-amber/[0.06]"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-label text-ink">
          {accepted ? "✓ " : "⚠ "}
          {e.question_label || "Entry removed"}
        </span>
        {accepted && (
          <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">removed — accepted</span>
        )}
      </div>
      {e.detail && <p className="mt-1 text-xs leading-relaxed text-ink-dim">{e.detail}</p>}
      {remembered.length > 0 && (
        <ul className="mt-2 space-y-1">
          {remembered.map((f) => {
            const missing = unfilled.has(f.recName) || f.value == null || String(f.value).trim() === "";
            const isAi = typeof f.filled_by === "string" && f.filled_by.indexOf("ai-") === 0;
            return (
              <li key={f.recName} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-ink-faint">{f.label || f.recName}</span>
                <span className={clsx("truncate text-right", missing ? "text-amber" : "text-ink")}>
                  {missing ? "— you'll supply this —" : f.value}
                </span>
                {isAi && !missing && (
                  <span className="shrink-0 rounded bg-amber/20 px-1 text-[10px] uppercase tracking-label text-amber">AI</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!accepted && (
        <div className="mt-3 flex items-center gap-2">
          <button className="ap-add" onClick={() => ctx.addBack(e)}>
            ↩ Add it back (prefilled)
          </button>
          <button className="btn-ghost text-xs" onClick={() => ctx.leaveRemoved(e)}>
            Leave removed
          </button>
        </div>
      )}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

// helper: build a nested sub-section stub record for a freshly-added parent entry
function nestedStubRecord(
  page: string | null,
  key: string,
  newIx: number,
  childBase: string,
  shp: FieldShape[],
  sample: ReviewEntry | undefined
): ReviewEntry {
  return {
    field_id: (page != null ? page + "::" : "") + "formField-" + key + "[" + newIx + "]." + childBase + "._stub",
    page: page != null ? page : null,
    field_index: null,
    question_label: humanize(childBase) + " (0)",
    widget_type: "nested_section_stub",
    canonical_field: key + "[" + newIx + "]." + childBase + "._stub",
    is_required: false,
    current_value: null,
    original_ai_value: null,
    is_edited: false,
    edit_kind: null,
    is_added: true,
    added_at: nowIso(),
    is_approved: false,
    approved_at: null,
    page_number: sample ? sample.page_number : null,
    page_label: sample ? sample.page_label : null,
    confidence: "none",
    confidence_source: "added",
    needs_review: true,
    needs_review_reason: "nested_section",
    fill_status: "not_filled",
    fill_error: null,
    detail: "nested repeating sub-section (" + key + " ▸ " + childBase + ") — add or verify entries here",
    match_tier: null,
    flag: "nested-section-stub",
    options: null,
    captured_options: null,
    tree_structure: null,
    date_order: null,
    tiers: null,
    character_count: null,
    section_field_shape: shp.map((s) => ({
      recName: s.recName,
      widget_type: s.widget_type,
      path: s.path != null ? s.path : s.recName,
      label: s.label,
      is_required: s.is_required,
      date_order: s.date_order || null,
      options: Array.isArray(s.options) ? s.options : null,
    })),
    container_prefix: key + "-<idx>--" + childBase + "-",
    nested_parent: { base: key, index: newIx },
    nested_child_base: childBase,
    section_known: false,
  };
}
