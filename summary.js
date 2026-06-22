// Viewer + EDITOR for the persistent per-field review summary (reviewSummary in
// chrome.storage.local), written by background.js after a completed fill.
//
// M14 (Review stage, slice 1): dropdown/choice fields are EDITABLE. A human pick is
// written back into the SAME reviewSummary record — current_value becomes the pick,
// original_ai_value preserves the bot's value, is_edited flips, and edit_kind records
// provenance (override | filled_blank | cleared) for the later strict-replay round.
// Text/radio/checkbox stay display-only this slice; replay/submit + approval are later.
//
// Edits update the DOM in place (no full re-render → no scroll jump / heavy rebuild).
// All values go through textContent / option.value — Workday labels and option texts
// are untrusted page content; never innerHTML.

const root = document.getElementById("root");
let currentBundle = null; // the loaded reviewSummary, mutated in place on edit

// Tiny element helper. props: { class, text, ...attrs }; children: node | string | array.
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
};

const fmt = (v) => (v == null || v === "" ? "—" : String(v));
const norm = (v) => (v == null ? "" : String(v));

// Provenance of a human edit, for the later replay round (override vs gap-fill differ).
const editKindOf = (entry) => {
  const o = norm(entry.original_ai_value), c = norm(entry.current_value);
  if (o === c) return null;          // unchanged
  if (o === "") return "filled_blank"; // AI left it blank, human supplied a value
  if (c === "") return "cleared";      // AI had a value, human cleared it
  return "override";                   // AI had a value, human changed it
};

// Which option list + partialness drives a choice field's editor; null = not editable.
//   dropdown     → full options (complete option set, raised cap)
//   typeahead    → captured_options (the filtered set the bot's search surfaced — PARTIAL)
//   hierarchical → options (the source picker's level-1 leaves — PARTIAL)
const editorFor = (entry) => {
  if (entry.widget_type === "dropdown") return { list: entry.options || [], partial: false };
  if (entry.widget_type === "typeahead") return { list: entry.captured_options || [], partial: true };
  if (entry.widget_type === "hierarchical") return { list: entry.options || [], partial: true };
  return null;
};

const PARTIAL_NOTE =
  "These are the options that matched the original search — not the full list. " +
  "To choose a different value, edit this field on the form directly.";

const persist = () => chrome.storage.local.set({ reviewSummary: currentBundle });

// field_id → the value text node in the NEEDS REVIEW card (so an edit can keep it fresh).
const reviewValueNodes = {};

const refreshButton = () => {
  const btn = el("button", { text: "Refresh" });
  btn.addEventListener("click", load);
  return btn;
};

// The "edited" indicator for a row, reflecting edit_kind (null → no indicator).
const editedBadge = (entry) => {
  const kind = editKindOf(entry);
  if (!kind) return null;
  if (kind === "filled_blank") return el("span", { class: "edit-tag filled", text: "you filled (AI left blank)" });
  if (kind === "cleared") return el("span", { class: "edit-tag", text: `cleared (AI chose: ${fmt(entry.original_ai_value)})` });
  return el("span", { class: "edit-tag", text: `edited (AI chose: ${fmt(entry.original_ai_value)})` });
};

// The current_value cell: value text + (for choice fields) an editable widget beside it
// + an edited indicator. Edits update value text, badge, the row tint, and the NEEDS
// REVIEW value node in place — no re-render.
const valueCell = (entry, tr) => {
  const td = el("td");
  const valNode = el("span", { class: "cellval", text: fmt(entry.current_value) });
  td.appendChild(valNode);

  const m = editorFor(entry);
  if (!m) return td; // text / radio / checkbox → display-only this slice

  const list = m.list || [];
  const badgeSlot = el("div", { class: "badge-slot" });

  const refreshLocal = () => {
    valNode.textContent = fmt(entry.current_value);
    badgeSlot.textContent = "";
    const b = editedBadge(entry);
    if (b) badgeSlot.appendChild(b);
    tr.classList.toggle("edited", !!editKindOf(entry));
    const rv = reviewValueNodes[entry.field_id];
    if (rv) rv.textContent = fmt(entry.current_value);
  };

  // Graceful degrade: a partial set too small to be a useful pick-list → value + note.
  if (m.partial && list.length <= 2) {
    td.appendChild(el("div", { class: "partial-note", text: PARTIAL_NOTE }));
  } else {
    const sel = el("select", { class: "editor" });
    const cur = entry.current_value;
    if (cur == null || cur === "") {
      const ph = document.createElement("option");
      ph.value = ""; ph.textContent = "— choose —"; ph.selected = true;
      sel.appendChild(ph);
    }
    const opts = list.slice();
    if (cur != null && cur !== "" && !opts.includes(cur)) opts.unshift(cur); // keep current selectable
    for (const o of opts) {
      const oEl = document.createElement("option");
      oEl.value = o; oEl.textContent = o;
      if (o === cur) oEl.selected = true;
      sel.appendChild(oEl);
    }
    sel.addEventListener("change", () => {
      entry.current_value = sel.value === "" ? null : sel.value;
      entry.edit_kind = editKindOf(entry);
      entry.is_edited = entry.edit_kind !== null;
      persist();
      refreshLocal();
    });
    td.appendChild(sel);
    if (m.partial) td.appendChild(el("div", { class: "partial-note", text: PARTIAL_NOTE }));
  }

  td.appendChild(badgeSlot);
  const b0 = editedBadge(entry);
  if (b0) badgeSlot.appendChild(b0);
  return td;
};

const render = () => {
  const bundle = currentBundle;
  root.textContent = "";
  for (const k of Object.keys(reviewValueNodes)) delete reviewValueNodes[k];

  if (!bundle || !Array.isArray(bundle.entries)) {
    root.appendChild(el("div", { class: "empty", text: "No summary yet — run “Fill current page” from the popup." }));
    root.appendChild(refreshButton());
    return;
  }

  // ── Header ───────────────────────────────────────────────────────────────
  root.appendChild(el("h1", { text: "ApplyPilot — Last fill summary" }));
  root.appendChild(el("div", { class: "meta", text: `${fmt(bundle.page)}  ·  ${fmt(bundle.tenant)}  ·  ${fmt(bundle.captured_at)}` }));

  const counts = el("div", { class: "counts" });
  counts.appendChild(el("span", { text: `Total: ${bundle.total}` }));
  counts.appendChild(el("span", { text: `Needs review: ${bundle.needs_review_count}` }));
  for (const [k, v] of Object.entries(bundle.counts || {})) counts.appendChild(el("span", { text: `${k}: ${v}` }));
  root.appendChild(counts);

  const byType = el("div", { class: "counts" });
  for (const [k, v] of Object.entries(bundle.by_type || {})) byType.appendChild(el("span", { text: `${k}: ${v}` }));
  root.appendChild(byType);

  root.appendChild(refreshButton());

  // ── SUBMIT-BLOCKED banner (AI-2) — a REQUIRED field the AI declined holds a placeholder that
  // MUST NOT ship. Removal is a CHECKED precondition of submit, not just conspicuous: this banner
  // is the visible gate now (the deferred strict-replay SUBMIT must live-re-read + refuse too). ──
  const needsAnswer = (e) => e.flag === "ai-text-needs-answer";
  const blocked = bundle.entries.filter((e) => needsAnswer(e));
  if (blocked.length) {
    root.appendChild(el("div", { class: "submit-blocked", text: `⛔ SUBMIT BLOCKED — ${blocked.length} required field(s) still hold an AI placeholder. Replace each on the form before submitting.` }));
  }

  // ── NEEDS REVIEW first (informational; editors live in the ALL FIELDS table) ──
  // LEGALLY-LOADED (ai-choice-sensitive) + NEEDS-YOUR-ANSWER (ai-text-needs-answer) render FIRST and
  // loud, REGARDLESS of confidence — prominence keys off the FLAG, never confidence. A "reasoning-
  // from-absence" answer (criminal→No) is exactly the one the model marks HIGH, so confidence must
  // NOT bury it; ditto a must-replace placeholder. Confidence prioritizes scrutiny only AMONG the rest.
  const isSensitive = (e) => e.flag && /sensitive/.test(e.flag);
  const isAiFlag = (e) => e.flag && e.flag.indexOf("ai-") === 0;
  const isEeoGuess = (e) => e.flag === "ai-eeo-guess"; // AI-3: a GUESSED demographic — must be verified
  const mustReplace = (e) => isSensitive(e) || needsAnswer(e) || isEeoGuess(e);
  const flaggedAll = bundle.entries.filter((e) => e.needs_review);
  const flagged = [...flaggedAll.filter(mustReplace), ...flaggedAll.filter((e) => !mustReplace(e))]; // must-replace FIRST (flag-driven)
  root.appendChild(el("h2", { text: `Needs review (${flagged.length})` }));
  if (!flagged.length) {
    root.appendChild(el("div", { class: "meta", text: "Nothing flagged." }));
  } else {
    for (const e of flagged) {
      const sensitive = isSensitive(e);
      const isAi = isAiFlag(e);
      const card = el("div", { class: mustReplace(e) ? "review sensitive" : "review" });
      const label = el("div", { class: "label" });
      label.appendChild(document.createTextNode(`${fmt(e.question_label)}  (${fmt(e.widget_type)})  `));
      // The loud marker is flag-driven: conspicuous at ANY confidence.
      if (sensitive) label.appendChild(el("span", { class: "badge sensitive", text: "⚠ LEGALLY-LOADED — VERIFY" }));
      if (needsAnswer(e)) label.appendChild(el("span", { class: "badge sensitive", text: "⚠ NEEDS YOUR ANSWER — REPLACE BEFORE SUBMIT" }));
      if (isEeoGuess(e)) label.appendChild(el("span", { class: "badge sensitive", text: "⚠ AI-GUESSED DEMOGRAPHIC — VERIFY" }));
      if (isAi) label.appendChild(el("span", { class: "badge ai-inferred", text: "AI-INFERRED" }));
      card.appendChild(label);
      const reason = el("div", { class: "reason" });
      reason.appendChild(document.createTextNode(`reason: ${fmt(e.needs_review_reason)}  ·  status: ${fmt(e.fill_status)}  ·  value: `));
      const rv = el("span", { text: fmt(e.current_value) });
      reviewValueNodes[e.field_id] = rv; // kept fresh when the field is edited below
      reason.appendChild(rv);
      card.appendChild(reason);
      // AI provenance — the flag (which AI path) + confidence, so the human sanity-checks HOW it answered.
      if (isAi) card.appendChild(el("div", { class: "reason", text: `AI provenance: ${fmt(e.flag)}  ·  confidence: ${fmt(e.confidence)}` }));
      if (e.detail) card.appendChild(el("div", { class: "detail", text: e.detail })); // the AI's RATIONALE (names its basis)
      const opts = e.options || e.captured_options;
      if (opts && opts.length) {
        // Cap the flat-text dump (options can now be ~250 for plain dropdowns).
        const shown = opts.slice(0, 15).join(", ") + (opts.length > 15 ? ` … (${opts.length} total)` : "");
        card.appendChild(el("div", { class: "options", text: "options: " + shown }));
      }
      root.appendChild(card);
    }
  }

  // ── ALL FIELDS table (choice fields editable) ─────────────────────────────
  root.appendChild(el("h2", { text: "All fields" }));
  const cols = ["field_index", "question_label", "widget_type", "canonical_field", "is_required", "current_value", "fill_status", "confidence", "match_tier"];
  const table = el("table");
  const head = el("tr");
  for (const c of cols) head.appendChild(el("th", { text: c }));
  table.appendChild(head);

  for (const e of bundle.entries) {
    const tr = el("tr", e.needs_review ? { class: "flagged" } : {});
    if (editKindOf(e)) tr.classList.add("edited");
    for (const c of cols) {
      if (c === "current_value") {
        tr.appendChild(valueCell(e, tr));
      } else if (c === "confidence") {
        const td = el("td");
        td.appendChild(el("span", { class: "badge " + (e.confidence || "none"), text: fmt(e.confidence) }));
        tr.appendChild(td);
      } else if (c === "is_required") {
        tr.appendChild(el("td", { text: e.is_required ? "yes" : "no" }));
      } else {
        tr.appendChild(el("td", { text: fmt(e[c]) }));
      }
    }
    table.appendChild(tr);
  }
  root.appendChild(table);
};

const load = () => {
  chrome.storage.local.get("reviewSummary", ({ reviewSummary }) => {
    currentBundle = reviewSummary || null;
    render();
  });
};

load();
