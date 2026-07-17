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
  requiresApproval,
  approvalEnvelope,
  hasPlaceholder,
  isHiddenPreferredName,
  isCurrentlyWorkHere,
  visibleEntryItems,
  newEntryRecords,
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
  // RESETS approval (re-review). null = cleared.
  const commit = useCallback(
    (entry: ReviewEntry, val: string | null) => {
      const value = val === "" || val == null ? null : val;
      const merged: ReviewEntry = { ...entry, current_value: value };
      const edit_kind = editKindOf(merged);
      const patch: Partial<ReviewEntry> = {
        current_value: value,
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
  const reviewCount = useMemo(() => live.filter((e) => e.needs_review).length, [live]);
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
  const blocked = useMemo(() => live.filter(needsAnswer), [live]);

  const flagged = useMemo(() => {
    const all = live.filter((e) => e.needs_review);
    return [
      ...all.filter(isSuperHard),
      ...all.filter((e) => mustReplace(e) && !isSuperHard(e)),
      ...all.filter((e) => !mustReplace(e)),
    ];
  }, [live]);

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
    (e: ReviewEntry) => (filter === "review" ? !!e.needs_review : filter === "edited" ? !!editKindOf(e) : true),
    [filter]
  );

  const registerRow = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  }, []);

  // shared props threaded into the field renderer — STABLE (memoized over stable callbacks) so a
  // field row's ref-registration effect doesn't re-run on every keystroke elsewhere on the page.
  const ctx = useMemo<RowCtx>(
    () => ({ commit, setApproved, setTiers, registerRow, jumpTo }),
    [commit, setApproved, setTiers, registerRow, jumpTo]
  );

  return (
    <div className="space-y-6">
      {/* halt banner — WHY the fill didn't reach the end (loud, top of page) */}
      {bundle.walk_status && <WalkStatusBanner ws={bundle.walk_status} />}

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
          label="Needs review"
          n={reviewCount}
          tone="warn"
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
      <ApprovalBar approval={approval} onApproveAll={approveAll} />

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
          <SectionLabel title="Needs review" count={`${flagged.length} to verify`} tone="warn" />
          <div className="space-y-2">
            {flagged.map((e) => (
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
  commit: (e: ReviewEntry, v: string | null) => void;
  setApproved: (e: ReviewEntry, on: boolean) => void;
  setTiers: (e: ReviewEntry, tiers: string[]) => void;
  registerRow: (id: string, node: HTMLDivElement | null) => void;
  jumpTo: (e: ReviewEntry) => void;
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
  const realItems = items.filter((e) => e.widget_type !== "section_stub");
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
    for (const e of items.filter((e) => !e.is_deleted && filterPass(e)))
      body.push(<FieldRow key={e.field_id} e={e} ctx={ctx} />);
  }

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
  const approvedRow = !!(e.needs_review && e.is_approved);
  const rowTint = approvedRow
    ? "bg-verified/[0.05]"
    : e.needs_review && mustReplace(e)
      ? "bg-signal/[0.05]"
      : e.needs_review
        ? "bg-amber/[0.04]"
        : "";

  const editor = <FieldEditor e={e} ctx={ctx} />;
  const showApprove = requiresApproval(e);

  return (
    <div ref={rowRef} className={clsx("px-4 py-3", rowTint)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:w-1/2">
          <div className="flex flex-wrap items-center gap-1.5">
            {review && <ReviewBadges e={e} />}
            <span className="text-sm text-ink">{fmt(e.question_label)}</span>
            {e.is_required && (
              <span className="text-signal" title="required">
                ✱
              </span>
            )}
            <StatusDot e={e} />
          </div>
          {review && e.detail && <p className="mt-1 text-xs leading-relaxed text-ink-dim">{e.detail}</p>}
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
  const partial =
    (e.tree_structure && Array.isArray(e.tree_structure.leaves) && e.tree_structure.leaves.length > 0) ||
    (wt === "radio" && !(e.options && e.options.length)) ||
    (wt === "typeahead" && !(e.options && e.options.length) && (e.captured_options?.length || 0) > 2);
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
  if (!review && e.needs_review && e.detail && !isPrePopulated(e))
    notes.push(<p key="d" className="mt-1 text-xs text-ink-dim">{e.detail}</p>);
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
  const onCommit = (v: string | null) => ctx.commit(e, v);

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
  if (e.tree_structure && Array.isArray(e.tree_structure.leaves) && e.tree_structure.leaves.length)
    return <Combobox value={cur} options={e.tree_structure.leaves} onCommit={onCommit} />;
  // RADIO with a small option set → segmented Yes/No-style buttons (the same look as the profile's
  // toggles), which is how the field actually renders on the form. A large radio set falls back to a select.
  if (wt === "radio" && e.options && e.options.length && e.options.length <= 4)
    return <RadioButtons value={cur} options={e.options} onCommit={onCommit} />;
  if ((wt === "dropdown" || wt === "radio") && e.options && e.options.length)
    return <SelectBox value={cur} options={e.options} onCommit={onCommit} />;
  if (wt === "radio") return <TextBox value={cur} onCommit={onCommit} />;
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
    if (e.options && e.options.length) return <Combobox value={cur} options={e.options} onCommit={onCommit} />;
    const co = e.captured_options || [];
    if (co.length > 2) return <SelectBox value={cur} options={co} onCommit={onCommit} />;
    return <TierEditor e={e} ctx={ctx} />;
  }
  if (wt === "hierarchical") return <TierEditor e={e} ctx={ctx} />;
  if (wt === "date") return <DateSeg value={cur} order={e.date_order} onCommit={onCommit} />;
  if (wt === "textarea") return <TextBox value={cur} onCommit={onCommit} textarea />;
  return <TextBox value={cur} onCommit={onCommit} />;
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
  if (value != null && value !== "" && !list.includes(value)) list.unshift(value);
  return (
    <select className="ap-input" value={value ?? ""} onChange={(e) => onCommit(e.target.value || null)}>
      <option value="">— choose —</option>
      {list.map((o) => (
        <option key={o} value={o}>
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

function Combobox({
  value,
  options,
  onCommit,
}: {
  value: string | null | undefined;
  options: string[];
  onCommit: (v: string | null) => void;
}) {
  const [q, setQ] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  useEffect(() => setQ(value ?? ""), [value]);
  const matches = q.trim() === "" ? options : options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (v: string | null) => {
    onCommit(v);
    setOpen(false);
  };
  return (
    <div className="relative">
      <input
        className="ap-input"
        type="text"
        value={q}
        placeholder="type to filter…"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches.length) {
            e.preventDefault();
            pick(matches[0]);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <div className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-md border border-hairline bg-panel-raised shadow-lg">
          <button className="ap-opt text-ink-faint" onMouseDown={(ev) => (ev.preventDefault(), pick(null))}>
            — clear —
          </button>
          {matches.map((o) => (
            <button
              key={o}
              className={clsx("ap-opt", o === norm(value) && "bg-amber/10 text-amber")}
              onMouseDown={(ev) => (ev.preventDefault(), pick(o))}
            >
              {o}
            </button>
          ))}
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
}: {
  value: string | null | undefined;
  order: string[] | null | undefined;
  onCommit: (v: string | null) => void;
}) {
  const segs = Array.isArray(order) && order.length ? order : null;
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
  if (isCascadeRevealed(e))
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
      <Badge key="ai" tone="info">
        AI-INFERRED
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
  const tip = [e.widget_type, e.canonical_field, e.match_tier, e.flag, "confidence: " + e.confidence]
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
function WalkStatusBanner({ ws }: { ws: WalkStatus }) {
  if (ws.completed) return null;
  const errors = (ws.page_errors || []).filter(Boolean);
  const empties = ws.empty_fields || [];
  const pg = ws.stopped_page ?? "?";
  const reason = ws.cancelled
    ? "This fill was cancelled mid-run before reaching the review page."
    : errors.length
      ? `The form rejected a value on page ${pg}, so the fill couldn't continue.`
      : empties.length
        ? `Required fields on page ${pg} had no value in your profile, so the fill couldn't continue.`
        : `The fill stopped on page ${pg} before reaching the review page.`;
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
            <Link href="/app/profile" className="btn-ghost text-xs">
              Edit my profile
            </Link>
            <span className="text-xs text-ink-faint">Fix the value on your profile, re-sync, then refill.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ApprovalBar({
  approval,
  onApproveAll,
}: {
  approval: ReturnType<typeof approvalEnvelope>;
  onApproveAll: () => void;
}) {
  const total = approval.to_approve_count;
  const done = approval.approved_count;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  const note = approval.submit_ready
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
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-raised">
        <div
          className={clsx("h-full transition-all", approval.submit_ready ? "bg-verified" : "bg-amber")}
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
  tone?: "warn" | "edit";
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        "rounded-full border px-3 py-1 transition-colors",
        active ? "border-ink-dim bg-panel-raised text-ink" : "border-hairline text-ink-dim hover:border-ink-dim"
      )}
    >
      <span className={clsx(tone === "warn" && "text-amber", tone === "edit" && "text-ink")}>{label}</span>{" "}
      <span className="text-ink-faint">{n}</span>
    </button>
  );
}

function SectionLabel({ title, count, tone }: { title: string; count: string; tone?: "warn" }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h3 className={clsx("font-mono text-[11px] uppercase tracking-label", tone === "warn" ? "text-amber" : "text-ink-dim")}>
        {title}
      </h3>
      <span className="font-mono text-[10px] text-ink-faint">{count}</span>
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
