// Viewer + EDITOR for the persistent per-field review summary (reviewSummary in
// chrome.storage.local), written by the fill engine after a completed fill/walk.
//
// Layout: a dense, glance-and-verify table. A compact header + summary/filter strip,
// a SUBMIT-BLOCKED banner when a required field still holds an AI placeholder, a
// "Needs review" list at the top (flag-driven prominence: LEGALLY-LOADED / DEMOGRAPHIC /
// NEEDS-ANSWER first and loud, regardless of confidence), then ALL fields grouped into
// collapsible sections (derived from canonical_field). Repeating-section entries
// (canonical_field shaped `sectionName[idx].field`) get an "Entry N" header with a
// per-entry trash (soft delete + Undo).
//
// EDITING (M14 semantics): every field carries an in-place editor pre-filled with what
// the bot put — dropdown/radio → <select>, checkbox → a real <input type=checkbox>,
// typeahead with a full option list → a type-to-filter combobox, else a text box. A pick
// writes back into the SAME record: current_value ← pick (null = cleared), edit_kind/
// is_edited recomputed, original_ai_value preserved, persisted to chrome.storage.local.
// When a value differs from the bot's, an "autofilled: <bot value>" reference shows. The
// same field can appear in both the review list and the section list; commit() refreshes
// EVERY editor for that field_id so the two stay in sync (no full re-render on edit).
//
// SECURITY: all page-derived text (Workday labels, option texts, values) is set via
// textContent / option.value / createTextNode — NEVER innerHTML (untrusted page content).

const root = document.getElementById("root");
let currentBundle = null;            // the loaded reviewSummary, mutated in place on edit
let currentFilter = "all";           // all | review | edited
const collapsed = new Set();         // section keys the user collapsed
const fieldRefreshers = new Map();   // field_id -> Set<fn>  (keeps every editor for a field in sync)
const fieldRowNodes = new Map();     // field_id -> section row (jump target)

// Tiny element helper. props.text → textContent (never innerHTML); props.onX → addEventListener.
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) { if (c == null) continue; n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
  return n;
};
const fmt = (v) => (v == null || v === "" ? "—" : String(v));
const norm = (v) => (v == null ? "" : String(v));
const autofilledOf = (e) => (e.original_ai_value != null ? e.original_ai_value : e.current_value);
// Friendly page caption from a bundle/page (Plan 2): page_label wins; an "accumulated (N pages)"
// envelope shows as-is; otherwise a cdpPageKey ("pathname|field,field,…") or the page-engine
// field-set key collapses to its last path segment, never the raw composite string.
const cleanPageName = (b) => {
  if (!b) return "—";
  if (b.page_label) return b.page_label;
  const p = b.page;
  if (typeof p === "string") {
    if (/^accumulated/.test(p)) return p;
    const seg = (p.split("|")[0] || p).split("/").filter(Boolean).pop();
    if (seg) return seg;
  }
  return fmt(p);
};
// editKindOf / checkedOf / tokenFor / effectiveValue / approvalEnvelope / requiresApproval live in
// summary-lib.js (loaded BEFORE this script — globals here, requireable in tests). Do NOT redeclare.
const PARTIAL_NOTE = "Options the search surfaced — not the full list. Edit on the form for other values.";
const persist = () => chrome.storage.local.set({ reviewSummary: currentBundle });

// Section grouping. Keys = the REAL canonical-field prefixes the fill engine emits
// (FIELD_MAP flat paths like personal_info.* + PAGE_SECTIONS names, which are camelCase).
// humanize() splits camelCase as a fallback so an unmapped name still reads cleanly.
const SECTION_LABELS = {
  personal_info: "Personal Information", self_identification: "Self-Identification", agreements: "Agreements",
  workExperience: "Work Experience", education: "Education", language: "Languages", website: "Websites",
  certification: "Certifications", skill: "Skills", _documents: "Documents", _other: "Other Fields",
};
const humanize = (k) => SECTION_LABELS[k] || k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const sectionOf = (e) => {
  const cf = e.canonical_field || "";
  let m = cf.match(/^([A-Za-z_]+)\s*\[(\d+)\]/); if (m) return { key: m[1], label: humanize(m[1]), index: +m[2] }; // repeating: base[idx]
  m = cf.match(/^([A-Za-z_]+)\./); if (m) return { key: m[1], label: humanize(m[1]), index: null };               // flat: prefix.rest
  if (e.widget_type === "file_upload") return { key: "_documents", label: "Documents", index: null };
  return { key: "_other", label: "Other Fields", index: null };
};

// Review-card prominence predicates (UNCHANGED from the original viewer): prominence keys
// off the FLAG, never confidence — a high-confidence reasoning-from-absence answer
// (criminal→"No") must still be the most conspicuous, not buried.
const isSensitive = (e) => e.flag && /sensitive/.test(e.flag);
const needsAnswer = (e) => e.flag === "ai-text-needs-answer";
const isEeoGuess = (e) => e.flag === "ai-eeo-guess";
const isAiFlag = (e) => e.flag && e.flag.indexOf("ai-") === 0;
// SUPER-HARD: an AI typeahead pick the applicant didn't claim (ai-closest-forced — forced a value
// on a required field with no "Other"), OR any AI guess the model itself flagged LOW confidence —
// the riskiest committed AI answers → loudest, rendered FIRST (≥ legally-loaded).
const isSuperHard = (e) => e.flag === "ai-closest-forced" || (isAiFlag(e) && e.confidence === "low");
const mustReplace = (e) => isSuperHard(e) || isSensitive(e) || needsAnswer(e) || isEeoGuess(e);

const addRefresher = (id, fn) => { if (!fieldRefreshers.has(id)) fieldRefreshers.set(id, new Set()); fieldRefreshers.get(id).add(fn); };
// Shared write-back (M14): current_value ← pick (null = cleared), edit_kind/is_edited recomputed,
// original_ai_value preserved, persisted, then EVERY editor for this field refreshed (sync).
// Plan 2: a VALUE edit RESETS approval (a stale approval must never ride a changed value into
// replay — the field re-enters the review pile), and the header approval strip is refreshed.
const commit = (entry, val) => {
  entry.current_value = val === "" || val == null ? null : val;
  entry.edit_kind = editKindOf(entry); entry.is_edited = entry.edit_kind !== null;
  if (entry.is_approved) { entry.is_approved = false; entry.approved_at = null; }
  persist();
  for (const fn of fieldRefreshers.get(entry.field_id) || []) fn();
  updateApprovalUI();
};

// Plan 2: per-field approval toggle. Sets is_approved + approved_at, persists, refreshes the
// field's rows (the toggle + row tint) and the header strip — in place, no full re-render.
const setApproved = (entry, on) => {
  entry.is_approved = !!on; entry.approved_at = on ? new Date().toISOString() : null;
  persist();
  for (const fn of fieldRefreshers.get(entry.field_id) || []) fn();
  updateApprovalUI();
};
// Reassigned each render() to recompute the envelope + repaint the header strip / submit button
// without a full re-render. A no-op before the first render.
let updateApprovalUI = () => {};

// A 13px trash glyph (SVG via createElementNS — el() is textContent-only by design).
const svgTrash = () => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(k, v);
  for (const d of ["M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6", "M10 11v5", "M14 11v5"]) { const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); svg.appendChild(p); }
  return svg;
};

// Per-entry SOFT delete for repeating sections (like the form's per-entry Delete). Marks every
// field of the entry is_deleted, persists, re-renders. Deleted entries drop out of the counts /
// needs-review / active list; an Undo restores them. The later strict-replay round honors
// is_deleted (skips the entry on submit) — nothing is removed from the bundle here.
const entryFieldsOf = (page, key, index) => currentBundle.entries.filter((e) => e.page === page && sectionOf(e).key === key && sectionOf(e).index === index);
const setEntryDeleted = (page, key, index, del) => { for (const e of entryFieldsOf(page, key, index)) e.is_deleted = del; persist(); render(); };
const entryHead = (sec, ix, page) => {
  const h = el("div", { class: "ehead" }, [el("span", { class: "et", text: `Entry ${ix + 1}` })]);
  const del = el("button", { class: "del", title: "Delete this entry" }, [svgTrash(), el("span", { text: "Delete" })]);
  del.addEventListener("click", () => setEntryDeleted(page, sec.key, ix, true));
  h.appendChild(del);
  return h;
};
const deletedRow = (sec, ix, page) => {
  const u = el("button", { class: "undo", text: "Undo" });
  u.addEventListener("click", () => setEntryDeleted(page, sec.key, ix, false));
  return el("div", { class: "edel" }, [el("s", { text: `Entry ${ix + 1}` }), document.createTextNode("removed"), u]);
};

// Build the in-place editor for a field, pre-filled with the current value. Returns
// { node, set(v), partial? } or null (file_upload → display-only). `set` lets commit()
// sync a second copy of the same field elsewhere on the page.
function buildEditor(entry) {
  const wt = entry.widget_type, cur = entry.current_value;
  const onCommit = (v) => commit(entry, v);
  const selectFrom = (opts) => {
    const sel = el("select", { class: "editor" });
    const list = opts.slice();
    if (cur == null || cur === "") { const ph = document.createElement("option"); ph.value = ""; ph.textContent = "— choose —"; sel.appendChild(ph); }
    else if (!list.includes(cur)) list.unshift(cur);
    for (const o of list) { const oe = document.createElement("option"); oe.value = o; oe.textContent = o; if (o === entry.current_value) oe.selected = true; sel.appendChild(oe); }
    sel.addEventListener("change", () => onCommit(sel.value));
    return { node: sel, set: (v) => { sel.value = v == null ? "" : String(v); } };
  };
  const textInput = (tag) => {
    const inp = el(tag, { class: "editor", type: "text" });
    inp.value = cur == null ? "" : String(cur);
    inp.addEventListener("change", () => onCommit(inp.value));
    return { node: inp, set: (v) => { inp.value = v == null ? "" : String(v); } };
  };
  const combobox = (list) => {
    const wrap = el("div", { class: "ta-wrap" });
    const inp = el("input", { class: "editor", type: "text", placeholder: "type to filter…" });
    inp.value = cur == null ? "" : String(cur);
    const box = el("div", { class: "ta-list", hidden: "" });
    wrap.appendChild(inp); wrap.appendChild(box);
    const matches = () => { const q = inp.value.trim().toLowerCase(); return q === "" ? list.slice() : list.filter((o) => String(o).toLowerCase().includes(q)); };
    const pick = (v) => { onCommit(v); inp.value = entry.current_value == null ? "" : String(entry.current_value); if (v === "" || v == null) draw(true); else { box.hidden = true; box.textContent = ""; } };
    const draw = (all) => {
      box.textContent = "";
      const cr = el("div", { class: "ta-opt ta-clear", text: "— clear —" }); cr.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(""); }); box.appendChild(cr);
      for (const o of (all ? list.slice() : matches())) { const r = el("div", { class: String(o) === norm(entry.current_value) ? "ta-opt sel" : "ta-opt", text: String(o) }); r.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(String(o)); }); box.appendChild(r); }
      box.hidden = false;
    };
    inp.addEventListener("focus", () => { inp.select(); draw(true); });
    inp.addEventListener("input", () => draw(false));
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); const ms = matches(); if (ms.length) pick(String(ms[0])); } else if (ev.key === "Escape") box.hidden = true; });
    inp.addEventListener("blur", () => setTimeout(() => { box.hidden = true; }, 150));
    return { node: wrap, set: (v) => { inp.value = v == null ? "" : String(v); } };
  };
  if (wt === "file_upload") return null;
  // TREE-AI (cert): the recon captured the chosen category's leaves → a searchable editor over them
  // (partial — only that category, not the whole tree). Checked before widget_type (cert is mis-tagged typeahead).
  if (entry.tree_structure && Array.isArray(entry.tree_structure.leaves) && entry.tree_structure.leaves.length) return Object.assign(combobox(entry.tree_structure.leaves), { partial: true });
  if (wt === "dropdown" && entry.options && entry.options.length) return selectFrom(entry.options);
  if (wt === "radio" && entry.options && entry.options.length) return selectFrom(entry.options);
  if (wt === "radio") return Object.assign(textInput("input"), { partial: true }); // options not captured → free text + the partial note (don't silently degrade to a bare box)
  if (wt === "checkbox") {
    const cb = el("input", { class: "editor-check", type: "checkbox" });
    cb.checked = checkedOf(entry.current_value);
    cb.addEventListener("change", () => onCommit(tokenFor(entry.original_ai_value, cb.checked)));
    return { node: cb, set: (v) => { cb.checked = checkedOf(v); } };
  }
  if (wt === "typeahead") { if (entry.options && entry.options.length) return Object.assign(combobox(entry.options), { partial: false }); const co = entry.captured_options || []; if (co.length > 2) return Object.assign(selectFrom(co), { partial: true }); return Object.assign(textInput("input"), { partial: co.length > 0 }); }
  if (wt === "hierarchical") { const opts = entry.options || entry.captured_options || []; if (opts.length > 2) return Object.assign(selectFrom(opts), { partial: true }); return Object.assign(textInput("input"), { partial: opts.length > 0 }); }
  if (wt === "textarea") return textInput("textarea");
  return textInput("input"); // text / date / unknown
}

const statusOf = (e) => {
  if (e.fill_status === "skipped") return "skip";
  if (e.fill_status === "error" || e.fill_status === "not_filled") return "crit";
  if (e.needs_review) return mustReplace(e) ? "crit" : "warn";
  return "ok";
};

// One field row, used in BOTH the review list and the section list (editors kept in sync
// via the field_id refresher). opts.review → loud flag label + reason line + "go to field".
const fieldRow = (e, opts = {}) => {
  const row = el("div", { class: "row" });
  if (!opts.review) fieldRowNodes.set(e.field_id, row); // the section row is the jump target

  const lab = el("div", { class: "lab" });
  if (opts.review) {
    // super-hard shows ALONGSIDE legally-loaded/demographic/needs-answer (never hides them — safety-first)
    if (isSuperHard(e)) lab.appendChild(el("span", { class: "lb superhard", text: e.flag === "ai-closest-forced" ? "AI FORCED" : "LOW-CONF AI" }));
    if (isSensitive(e)) lab.appendChild(el("span", { class: "lb crit", text: "LEGALLY-LOADED" }));
    else if (isEeoGuess(e)) lab.appendChild(el("span", { class: "lb eeo", text: "DEMOGRAPHIC" }));
    else if (needsAnswer(e)) lab.appendChild(el("span", { class: "lb crit", text: "NEEDS ANSWER" }));
    else if (isAiFlag(e) && !isSuperHard(e)) lab.appendChild(el("span", { class: "lb ai", text: "AI" }));
  }
  lab.appendChild(document.createTextNode(fmt(e.question_label)));
  if (e.is_required) lab.appendChild(el("span", { class: "req", title: "required", text: "✱" }));
  row.appendChild(lab);

  const val = el("div", { class: "val" });
  const ed = buildEditor(e);
  if (ed) val.appendChild(ed.node); else val.appendChild(el("span", { class: e.current_value ? "static" : "static empty", text: fmt(e.current_value) }));
  if (ed && ed.partial) val.appendChild(el("div", { class: "partial-note", text: PARTIAL_NOTE }));
  const afref = el("div", { class: "afref" });
  val.appendChild(afref);
  // Plan 2: an Approve toggle on every FLAGGED row (needs_review) — the explicit human sign-off
  // the future SUBMIT gate reads. Un-flagged fields are approved-by-default → no toggle.
  let apBtn = null;
  if (requiresApproval(e)) {
    apBtn = el("button", { class: "apbtn" });
    apBtn.addEventListener("click", () => setApproved(e, !e.is_approved));
    val.appendChild(el("div", { class: "approve" }, [apBtn]));
  }
  row.appendChild(val);

  const tip = [e.widget_type, e.canonical_field, e.match_tier, e.flag, "confidence: " + e.confidence].filter(Boolean).join("  ·  ");
  row.appendChild(el("span", { class: "dot " + statusOf(e), title: tip }));

  if (opts.review) {
    const r = el("div", { class: "reason" });
    if (e.detail) r.appendChild(el("span", { text: e.detail }));
    // TREE-AI recon: surface the chosen category + the options the AI picked from (operator-requested).
    if (e.tree_structure && e.tree_structure.chosen) {
      const ts = e.tree_structure, lv = Array.isArray(ts.leaves) ? ts.leaves : [];
      r.appendChild(el("span", { text: `tree: «${fmt(ts.chosen)}» → ${lv.slice(0, 12).join(", ")}${lv.length > 12 ? ` … (${lv.length})` : ""}` }));
    }
    const j = el("button", { class: "jump", text: "go to field ↓" }); j.addEventListener("click", () => jumpToField(e)); r.appendChild(j);
    row.appendChild(r);
  }

  const refresh = () => {
    if (ed && ed.set) ed.set(e.current_value);
    const kind = editKindOf(e);
    afref.textContent = "";
    if (kind) { afref.appendChild(document.createTextNode("autofilled: ")); afref.appendChild(el("b", { text: fmt(autofilledOf(e)) })); }
    if (apBtn) { apBtn.classList.toggle("on", !!e.is_approved); apBtn.textContent = e.is_approved ? "✓ Approved" : "Approve"; }
    const approved = !!(e.needs_review && e.is_approved); // an approved flagged row reads green, not warn/crit
    row.classList.toggle("f-approved", approved);
    row.classList.toggle("f-crit", !approved && !!(e.needs_review && mustReplace(e)));
    row.classList.toggle("f-warn", !approved && !!(e.needs_review && !mustReplace(e)));
    row.classList.toggle("f-edit", !e.needs_review && !!kind);
  };
  addRefresher(e.field_id, refresh); refresh();
  return row;
};

const render = () => {
  const bundle = currentBundle;
  root.textContent = ""; fieldRefreshers.clear(); fieldRowNodes.clear();
  if (!bundle || !Array.isArray(bundle.entries)) { root.appendChild(el("div", { class: "empty", text: "No summary yet — run a fill, then open “View last summary”." })); return; }
  const entries = bundle.entries;
  const live = entries.filter((e) => !e.is_deleted);           // deleted entries drop out of counts/list
  const removed = entries.length - live.length;
  const editedCount = live.filter((e) => editKindOf(e)).length;
  const reviewCount = live.filter((e) => e.needs_review).length;
  const liveCounts = live.reduce((a, e) => { a[e.fill_status] = (a[e.fill_status] || 0) + 1; return a; }, {});

  // ── header ──
  root.appendChild(el("div", { class: "head" }, [
    el("div", { class: "brand" }, [
      el("div", { class: "logo", "aria-hidden": "true", text: "✈" }),
      el("div", { class: "title", text: "Review your application" }),
      el("div", { class: "meta" }, [document.createTextNode(cleanPageName(bundle)), el("span", { class: "d", text: "·" }), document.createTextNode(fmt(bundle.tenant)), el("span", { class: "d", text: "·" }), document.createTextNode(relTime(bundle.captured_at))]),
    ]),
    el("div", { class: "toolbar" }, [
      el("button", { class: "tbtn", text: "Expand all", onclick: () => { collapsed.clear(); render(); } }),
      el("button", { class: "tbtn", text: "Collapse all", onclick: () => { groupKeys().forEach((k) => collapsed.add(k)); render(); } }),
      el("button", { class: "tbtn", text: "↻ Refresh", onclick: load }),
    ]),
  ]));

  // ── summary + filter strip ──
  const fl = (key, glyph, label, count) => { const c = el("button", { class: "fl", "aria-pressed": currentFilter === key ? "true" : "false" }, [glyph ? el("span", { class: "gl " + glyph }) : null, document.createTextNode(label + " "), el("span", { class: "n", text: String(count) })]); c.addEventListener("click", () => setFilter(currentFilter === key && key !== "all" ? "all" : key)); return c; };
  const bar = el("div", { class: "bar" }, [fl("all", null, "All", live.length), fl("review", "warn", "Needs review", reviewCount), fl("edited", "edit", "Edited", editedCount)]);
  const info = el("div", { class: "info" });
  info.appendChild(el("b", { text: String(liveCounts.filled || 0) })); info.appendChild(document.createTextNode(" filled"));
  if (liveCounts.skipped) { info.appendChild(document.createTextNode("  ·  ")); info.appendChild(el("b", { text: String(liveCounts.skipped) })); info.appendChild(document.createTextNode(" skipped")); }
  if (liveCounts.error) { info.appendChild(document.createTextNode("  ·  ")); info.appendChild(el("b", { text: String(liveCounts.error) })); info.appendChild(document.createTextNode(" error")); }
  if (removed) { info.appendChild(document.createTextNode("  ·  ")); info.appendChild(el("b", { text: String(removed) })); info.appendChild(document.createTextNode(" removed")); }
  bar.appendChild(info); root.appendChild(bar);

  // ── approval strip (Plan 2) — progress over the FLAGGED fields + "Approve all reviewed" +
  // a disabled-until-submit_ready "Approve & continue to submit" button that does NOT submit
  // (SUBMIT/replay is Plan 1). Un-flagged fields are approved-by-default (not counted here). ──
  const apbar = el("div", { class: "apbar" });
  const apProg = el("div", { class: "ap-prog" });
  const apTrack = el("div", { class: "ap-track" }, [el("div", { class: "ap-fill" })]);
  const apFill = apTrack.firstChild;
  const apAll = el("button", { class: "apbtn-all", text: "Approve all reviewed" });
  const submitBtn = el("button", { class: "submit-btn", text: "Approve & continue to submit" });
  const submitNote = el("div", { class: "submit-note" });
  apAll.addEventListener("click", () => {
    const at = new Date().toISOString();
    for (const e of currentBundle.entries.filter(requiresApproval)) { e.is_approved = true; e.approved_at = at; }
    persist();
    for (const e of currentBundle.entries.filter(requiresApproval)) for (const fn of fieldRefreshers.get(e.field_id) || []) fn();
    updateApprovalUI();
  });
  submitBtn.addEventListener("click", () => { /* SUBMIT/strict-replay is Plan 1 — intentionally inert here */ });
  apbar.appendChild(apProg); apbar.appendChild(apTrack); apbar.appendChild(apAll); apbar.appendChild(submitBtn);
  root.appendChild(apbar); root.appendChild(submitNote);

  updateApprovalUI = () => {
    const ap = approvalEnvelope(currentBundle.entries);
    currentBundle.approval = ap; // kept in the in-memory bundle; persisted on the next write (toggle/edit/all)
    const total = ap.to_approve_count, done = ap.approved_count;
    apProg.textContent = "";
    if (total === 0) { apProg.appendChild(el("b", { text: "Nothing flagged" })); apProg.appendChild(document.createTextNode(" — all fields approved by default")); }
    else { apProg.appendChild(el("b", { text: `${done} / ${total}` })); apProg.appendChild(document.createTextNode(" flagged fields approved")); }
    apFill.style.width = (total === 0 ? 100 : Math.round((done / total) * 100)) + "%";
    apAll.disabled = total === 0 || done === total;
    submitBtn.disabled = !ap.submit_ready;
    submitNote.textContent = ap.submit_ready
      ? "Ready to submit — but SUBMIT isn’t built yet (Plan 1). Your approvals are saved."
      : ap.unreplaced_placeholders
        ? `Replace ${ap.unreplaced_placeholders} AI placeholder${ap.unreplaced_placeholders > 1 ? "s" : ""} on the form, then approve the remaining flagged fields.`
        : `Approve the ${ap.pending_count} remaining flagged field${ap.pending_count === 1 ? "" : "s"} to continue.`;
  };
  updateApprovalUI();

  // ── SUBMIT-BLOCKED banner (a REQUIRED field still holds an AI placeholder) ──
  const blocked = live.filter(needsAnswer);
  if (blocked.length) root.appendChild(el("div", { class: "submit-blocked" }, [el("span", { text: "⛔", "aria-hidden": "true" }), el("div", {}, [el("b", { text: `Submit blocked — ${blocked.length} required field${blocked.length > 1 ? "s" : ""} still hold${blocked.length > 1 ? "" : "s"} an AI placeholder. ` }), el("span", { class: "s", text: "Replace each on the form before submitting." })])]));

  // ── NEEDS REVIEW (compact rows, must-replace first — prominence keys off the FLAG) ──
  const flaggedAll = live.filter((e) => e.needs_review);
  const flagged = [
    ...flaggedAll.filter(isSuperHard),                              // super-hard FIRST
    ...flaggedAll.filter((e) => mustReplace(e) && !isSuperHard(e)), // then the rest of must-replace
    ...flaggedAll.filter((e) => !mustReplace(e)),                   // then everything else
  ];
  if (flagged.length && currentFilter !== "edited") {
    root.appendChild(el("div", { class: "blab" }, [el("h2", { text: "Needs review" }), el("span", { class: "ct", text: `${flagged.length} to verify` }), el("span", { class: "rule" })]));
    const tbl = el("div", { class: "tbl review" });
    const grp = el("div", { class: "grp" }); const body = el("div", { class: "gbody" });
    for (const e of flagged) body.appendChild(fieldRow(e, { review: true }));
    grp.appendChild(body); tbl.appendChild(grp); root.appendChild(tbl);
  }

  // ── ALL FIELDS (grouped, collapsible) ──
  root.appendChild(el("div", { class: "blab" }, [el("h2", { text: currentFilter === "all" ? "All fields" : currentFilter === "review" ? "Flagged fields" : "Edited fields" }), el("span", { class: "ct", text: `${live.length} total` }), el("span", { class: "rule" })]));
  const host = el("div", { id: "field-list" }); root.appendChild(host); renderFieldList(host);
};

const filterPass = (e) => currentFilter === "review" ? !!e.needs_review : currentFilter === "edited" ? !!editKindOf(e) : true;
const groupKeys = () => { const seen = new Set(), out = []; for (const e of (currentBundle ? currentBundle.entries : [])) { const k = e.page + "||" + sectionOf(e).key; if (!seen.has(k)) { seen.add(k); out.push(k); } } return out; };

const pageNumOf = (items) => { const e = items.find((x) => x.page_number != null); return e ? e.page_number : null; };
const pageCaptionOf = (items, pg) => { const e = items.find((x) => x.page_label != null); if (e) return e.page_label; const n = pageNumOf(items); if (n != null) return "Page " + n; return cleanPageName({ page: pg }); };

const renderFieldList = (mount) => {
  mount.textContent = "";
  const entries = currentBundle.entries;
  const pageOrder = [], pages = {};
  for (const e of entries) { if (!pages[e.page]) { pages[e.page] = []; pageOrder.push(e.page); } pages[e.page].push(e); }
  // Plan 2: order pages by page_number (the walk's ordinal) when present, else keep first-
  // appearance. sort() is stable → pages without an ordinal hold their insertion order. Fixes the
  // re-run reordering (accumulateBundle appends a re-written page last; the ordinal restores order).
  pageOrder.sort((a, b) => { const na = pageNumOf(pages[a]), nb = pageNumOf(pages[b]); if (na != null && nb != null) return na - nb; if (na != null) return -1; if (nb != null) return 1; return 0; });
  const multiPage = pageOrder.length > 1;
  let shown = false;

  for (const pg of pageOrder) {
    const order = [], byKey = {};
    for (const e of pages[pg]) { const sec = sectionOf(e); if (!byKey[sec.key]) { byKey[sec.key] = { sec, items: [] }; order.push(sec.key); } byKey[sec.key].items.push(e); }
    const tbl = el("div", { class: "tbl" });

    for (const g of order.map((k) => byKey[k])) {
      const key = pg + "||" + g.sec.key;
      const repeating = g.sec.index != null;                       // base[idx] sections get per-entry headers + delete
      const liveItems = g.items.filter((e) => !e.is_deleted);

      // build the body first — a group is only shown if it ends up with content
      const body = el("div", { class: "gbody" });
      if (repeating) {
        const idxOrder = [], byIdx = {};
        for (const e of g.items) { const ix = sectionOf(e).index; if (!(ix in byIdx)) { byIdx[ix] = []; idxOrder.push(ix); } byIdx[ix].push(e); }
        for (const ix of idxOrder) {
          const items = byIdx[ix];
          if (items.every((e) => e.is_deleted)) { if (currentFilter === "all") body.appendChild(deletedRow(g.sec, ix, pg)); continue; }
          const vis = items.filter(filterPass);
          if (!vis.length) continue;
          body.appendChild(entryHead(g.sec, ix, pg));
          for (const e of vis) body.appendChild(fieldRow(e));
        }
      } else {
        for (const e of g.items.filter((e) => !e.is_deleted && filterPass(e))) body.appendChild(fieldRow(e));
      }
      if (!body.childNodes.length) continue;

      const nFilled = liveItems.filter((e) => !e.needs_review && e.fill_status !== "skipped").length;
      const nReview = liveItems.filter((e) => e.needs_review).length;
      const nSkip = liveItems.filter((e) => e.fill_status === "skipped").length;
      const dots = el("span", { class: "gdots" });
      if (nReview) { dots.appendChild(el("span", { class: "pdot " + (liveItems.some((e) => e.needs_review && mustReplace(e)) ? "crit" : "warn") })); dots.appendChild(el("span", { class: "pdot-l", text: String(nReview) })); }
      if (nFilled) { dots.appendChild(el("span", { class: "pdot ok" })); dots.appendChild(el("span", { class: "pdot-l", text: String(nFilled) })); }
      if (nSkip) { dots.appendChild(el("span", { class: "pdot skip" })); dots.appendChild(el("span", { class: "pdot-l", text: String(nSkip) })); }

      const isC = collapsed.has(key);
      const visCount = liveItems.filter(filterPass).length;
      const grp = el("div", { class: "grp" + (isC ? " collapsed" : "") });
      const head = el("button", { class: "ghead", "aria-expanded": isC ? "false" : "true" }, [el("span", { class: "chev", text: "▾" }), el("span", { class: "gname", text: g.sec.label }), el("span", { class: "gcount", text: `(${visCount}${visCount !== liveItems.length ? " of " + liveItems.length : ""})` }), dots]);
      head.addEventListener("click", () => { collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key); render(); });
      grp.appendChild(head); grp.appendChild(body); tbl.appendChild(grp);
    }
    if (!tbl.childNodes.length) continue;
    shown = true;
    if (multiPage) mount.appendChild(el("div", { class: "pgcap", text: pageCaptionOf(pages[pg], pg) }));
    mount.appendChild(tbl);
  }
  if (!shown) mount.appendChild(el("div", { class: "empty", text: currentFilter === "review" ? "Nothing needs review." : "No edited fields yet." }));
};

const setFilter = (key) => { currentFilter = key; render(); };
const jumpToField = (e) => {
  const key = e.page + "||" + sectionOf(e).key; collapsed.delete(key);
  if (currentFilter !== "all" && !filterPass(e)) currentFilter = "all";
  render();
  const row = fieldRowNodes.get(e.field_id);
  if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.animate([{ background: "#fff3cf" }, { background: "transparent" }], { duration: 1300, easing: "ease-out" }); }
};
const relTime = (iso) => { if (!iso) return "—"; const t = Date.parse(iso); if (isNaN(t)) return String(iso); const s = Math.round((Date.now() - t) / 1000); if (s < 45) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return new Date(t).toLocaleString(); };

const load = () => {
  chrome.storage.local.get("reviewSummary", ({ reviewSummary }) => {
    currentBundle = reviewSummary || null;
    render();
  });
};
load();
