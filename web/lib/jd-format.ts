/**
 * jd-format.ts — turn a scraped job description into READABLE blocks.
 *
 * The scrape (`scrapeJobPosting`, discover.js) emits a plain string with two minimal markers taken
 * from the real DOM: `## ` for a heading, `- ` for a list item. Everything else is a paragraph.
 * Parsing them here — rather than shipping HTML from the scrape — keeps the stored value a plain
 * string for every other consumer (LLM grounding, the summary regexes, the queue, `atsPostingGone`).
 *
 * WHY THE MARKERS EXIST AT ALL, since it would look simpler to infer structure here: after
 * `innerText` the information is GONE, not merely obscured. On Linear's posting the heading
 * "What we offer" (13 chars, 3 words, no terminal period) is indistinguishable from the bullet
 * "GitHub, Slack, Notion" (21 chars, 3 words, no terminal period) — by length, wording, punctuation
 * or position. So a render-time heuristic is a coin flip on every short line, and this file
 * deliberately does not attempt one.
 *
 * LEGACY TEXT (every row written before the markers, e.g. by the website's `saveRunJob`) therefore
 * renders as paragraphs — correct, if plainer. What it DOES still get is the metadata fix below,
 * which is the single ugliest thing about an unformatted posting.
 *
 * NOTHING IS EVER DROPPED. Boilerplate ("Apply for this Job", a privacy-link run) is reformatted,
 * never removed: this view is how someone reads the posting they are applying to, and silently
 * withholding part of it to look tidier is the one thing it must not do.
 */
export type JdBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "meta"; rows: { label: string; value: string }[] };

/**
 * Labels an ATS renders as its own little sidebar field. `innerText` splits each one from its value,
 * so a posting opens with a column of one-word stutter — "Location", blank, "Europe", blank,
 * "Employment Type", blank, "Full time" — which is what makes an otherwise fine posting read as
 * broken. Pairing them back up is the highest-value formatting win and needs no guessing: the label
 * side is a closed set.
 */
const META_LABELS = new Set([
  "location", "locations", "location type", "employment type", "job type", "type", "work type",
  "workplace type", "remote status", "department", "team", "division", "function", "category",
  "salary", "salary range", "compensation", "pay", "pay range", "level", "seniority", "job level",
  "experience level", "office", "offices", "req id", "requisition id", "job id", "posted",
  "posted date", "date posted", "schedule", "shift", "hours", "duration", "start date", "travel",
  "clearance", "reports to", "manager", "job family", "business unit", "brand", "region", "country",
  "city", "state", "work authorization", "visa", "education", "degree",
]);

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const labelKey = (s: string): string => norm(s).replace(/[:*]+$/, "").toLowerCase();

/** A plausible metadata VALUE: short, and not itself a label. A long sentence is prose, not a field. */
const looksLikeValue = (s: string): boolean => {
  const t = norm(s);
  return t.length > 0 && t.length <= 80 && !META_LABELS.has(labelKey(t)) && !/[.!?]$/.test(t);
};

/**
 * Split into blocks. Blank-line separated, which is what the scrape emits; a single newline inside a
 * block is preserved as a space so a wrapped line does not become its own paragraph.
 */
export function formatJd(text: string | null | undefined): JdBlock[] {
  const raw = String(text || "");
  if (!raw.trim()) return [];

  const chunks = raw
    .split(/\n\s*\n/)
    .map((c) => norm(c))
    .filter(Boolean);

  const blocks: JdBlock[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];

    if (c.startsWith("## ")) {
      const t = norm(c.slice(3));
      if (!t) continue;
      // ⚠ A HEADING CAN BE A FIELD LABEL. Ashby marks its sidebar metadata ("Location", "Department")
      // as <h2>, so a marked heading whose text is a known label and whose next block is a short value
      // is that field — rendering it as a section would reproduce the very stutter this file fixes, only
      // with bigger type. Checked BEFORE the heading is emitted, and only for the closed label set.
      const after = chunks[i + 1];
      if (META_LABELS.has(labelKey(t)) && after && !after.startsWith("- ") && looksLikeValue(after.replace(/^##\s+/, ""))) {
        const row = { label: t.replace(/[:*]+$/, ""), value: norm(after.replace(/^##\s+/, "")) };
        const prev = blocks[blocks.length - 1];
        if (prev && prev.kind === "meta") prev.rows.push(row);
        else blocks.push({ kind: "meta", rows: [row] });
        i++;
        continue;
      }
      blocks.push({ kind: "heading", text: t });
      continue;
    }

    if (c.startsWith("- ")) {
      // Gather the whole run so the renderer emits ONE list, not N one-item lists.
      const items: string[] = [];
      let j = i;
      for (; j < chunks.length && chunks[j].startsWith("- "); j++) {
        const t = norm(chunks[j].slice(2));
        if (t) items.push(t);
      }
      i = j - 1;
      if (items.length) blocks.push({ kind: "bullets", items });
      continue;
    }

    // A metadata label followed by its value — merged with an immediately preceding meta block so a
    // sidebar's worth of fields renders as one grid instead of a stack of two-line pairs.
    const next = chunks[i + 1];
    if (META_LABELS.has(labelKey(c)) && next && !next.startsWith("- ") && !next.startsWith("## ") && looksLikeValue(next)) {
      const row = { label: norm(c).replace(/[:*]+$/, ""), value: norm(next) };
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "meta") prev.rows.push(row);
      else blocks.push({ kind: "meta", rows: [row] });
      i++; // consume the value
      continue;
    }

    // `Label: value` on ONE line is the same field, already paired by the page.
    const inline = c.match(/^([A-Z][A-Za-z /&-]{2,28}):\s+(.{1,80})$/);
    if (inline && META_LABELS.has(labelKey(inline[1])) && looksLikeValue(inline[2])) {
      const row = { label: norm(inline[1]), value: norm(inline[2]) };
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === "meta") prev.rows.push(row);
      else blocks.push({ kind: "meta", rows: [row] });
      continue;
    }

    blocks.push({ kind: "para", text: c });
  }

  return blocks;
}
