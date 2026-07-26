import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTexUnits,
  applyTexTailor,
  detex,
  vocabFromTex,
  buildTexTailorPrompt,
  shimForXetex,
  decideTexEdits,
  fitTexToPages,
} from "@/lib/tex-tailor";

// A miniature sb2nov-style document: macro DEFINITION decoy before \begin{document}
// (must not become a unit), two experiences + a project, nested braces, an Awards
// section the schema knows nothing about (must pass through).
const TEX = String.raw`\documentclass{article}
\newcommand{\resumeItem}[1]{\item\small{{#1 \vspace{-2pt}}}}
\newcommand{\resumeSubItem}[1]{\resumeItem{#1}\vspace{-4pt}}
\begin{document}
\section{Experience}
\resumeSubheading{Acme Robotics}{2024}{Intern}{NYC}
\resumeItemListStart
  \resumeItem{Built 4 ROS 2 nodes with \textbf{C++} for control}
  \resumeItem{Wrote CAN bus drivers (50\% faster)}
\resumeItemListEnd
\resumeSubheading{Beta Labs}{2023}{Researcher}{LA}
\resumeItemListStart
  \resumeItem{Automated data pipelines in Python}
\resumeItemListEnd
\section{Projects}
\resumeProjectHeading{\textbf{Turntable} $|$ \emph{Altium}}{2025}
\resumeItemListStart
  \resumeItem{Designed a BLDC turntable PCB}
\resumeItemListEnd
\section{Awards}
Dean's List 2020 -- kept verbatim, no schema needed.
\end{document}`;

test("extractTexUnits: bullets after \\begin{document} only; macro-def decoy skipped; contexts + nesting handled", () => {
  const u = extractTexUnits(TEX);
  assert.equal(u.length, 4);
  assert.equal(u[0].id, "T0");
  assert.equal(u[0].plain, "Built 4 ROS 2 nodes with C++ for control");
  assert.equal(u[0].context, "Acme Robotics");
  assert.equal(u[2].context, "Beta Labs");
  assert.equal(u[3].context, "Turntable | Altium");
  assert.equal(detex(String.raw`Wrote CAN bus drivers (50\% faster)`), "Wrote CAN bus drivers (50% faster)");
});

test("prompt: numbered plain-text bullets + section context + JSON contract", () => {
  const { system, user } = buildTexTailorPrompt(extractTexUnits(TEX), "We need C++ and CAN.", "select");
  assert.match(user, /\[T1\] \(Acme Robotics\) Wrote CAN bus drivers/);
  assert.match(system, /SELECT-ONLY/);
  assert.match(system, /"edits"/);
});

test("select: drop honored, replace IGNORED, unmentioned kept; non-bullet bytes identical", () => {
  const r = applyTexTailor(
    TEX,
    JSON.stringify({ edits: [{ id: "T1", action: "drop" }, { id: "T0", action: "replace", text: "Invented Kubernetes claim" }] }),
    "select"
  );
  assert.equal(r.records[1].action, "dropped");
  assert.equal(r.records[0].action, "kept", "replace ignored in select mode");
  assert.ok(!r.tex.includes("Wrote CAN bus drivers"), "dropped bullet gone");
  assert.ok(!r.tex.includes("Kubernetes"));
  assert.ok(r.tex.includes("Built 4 ROS 2 nodes"), "kept bullet intact");
  assert.ok(r.tex.includes("Dean's List 2020"), "unknown section untouched");
  assert.ok(r.tex.includes(String.raw`\newcommand{\resumeSubItem}[1]{\resumeItem{#1}\vspace{-4pt}}`), "preamble byte-identical");
});

test("surface: clean reword replaces (escaped); invented number reverts + counts", () => {
  const r = applyTexTailor(
    TEX,
    JSON.stringify({
      edits: [
        { id: "T2", action: "replace", text: "Automated Python data pipelines & analysis" },
        { id: "T1", action: "replace", text: "Wrote CAN bus drivers (90% faster)" },
      ],
    }),
    "rewrite-surface"
  );
  assert.equal(r.records[2].action, "replaced");
  assert.ok(r.tex.includes(String.raw`Automated Python data pipelines \& analysis`), "replacement LaTeX-escaped");
  assert.equal(r.records[1].action, "kept", "invented 90 reverted");
  assert.match(r.records[1].violation ?? "", /invented number "90"/);
  assert.equal(r.reverted_count, 1);
  assert.ok(r.tex.includes(String.raw`(50\% faster)`), "original bullet restored verbatim");
});

test("surface is reword-ONLY: a model-proposed drop is IGNORED (same resume, few words changed)", () => {
  const r = applyTexTailor(
    TEX,
    JSON.stringify({ edits: [{ id: "T1", action: "drop" }, { id: "T3", action: "drop" }] }),
    "rewrite-surface"
  );
  assert.ok(r.records.every((x) => x.action === "kept"), "no drops in surface mode");
  assert.equal(r.tex, TEX, "document unchanged when the model only proposed drops");
});

test("full: replacement kept with fabrication risk flagged for out-of-resume tech", () => {
  const r = applyTexTailor(
    TEX,
    JSON.stringify({ edits: [{ id: "T2", action: "replace", text: "Deployed pipelines on Kubernetes" }] }),
    "rewrite-full"
  );
  assert.equal(r.records[2].action, "replaced");
  assert.match(r.records[2].fabrication_risk ?? "", /kubernetes/i);
  assert.ok(r.tex.includes("Deployed pipelines on Kubernetes"));
});

test("a section whose bullets would ALL drop keeps them (never an empty itemize)", () => {
  const r = applyTexTailor(
    TEX,
    JSON.stringify({ edits: [{ id: "T2", action: "drop" }] }), // Beta Labs' only bullet
    "select"
  );
  assert.equal(r.records[2].action, "kept");
  assert.ok(r.tex.includes("Automated data pipelines in Python"));
});

test("unparseable reply → original document verbatim + error", () => {
  const r = applyTexTailor(TEX, "not json at all", "select");
  assert.equal(r.error, "parse-failed");
  assert.equal(r.tex, TEX);
  assert.ok(r.records.every((x) => x.action === "kept"));
});

test("fitTexToPages: MEASURED page fit — reverts the largest-growth rewrite first, converges, notes why", async () => {
  const units = extractTexUnits(TEX);
  const vocab = vocabFromTex(TEX);
  // full mode: both replacements accepted (vocab-clean words)
  const { decisions } = decideTexEdits(
    units,
    [
      { id: "T0", action: "replace", text: "Built 4 ROS 2 nodes with C++ for control " + "and robotic systems control ".repeat(8) }, // huge growth
      { id: "T2", action: "replace", text: "Automated data pipelines in Python daily" }, // tiny growth
    ],
    "rewrite-full",
    vocab
  );
  // fake compiler: a "page" holds the original doc + 100 chars — the huge rewrite
  // (+~250 chars) overflows to page 2; the tiny one (+7 chars) fits
  const compilePages = async (t: string) => Math.max(1, Math.ceil(t.length / (TEX.length + 100)));
  const basePages = await compilePages(TEX);
  const fit = await fitTexToPages(TEX, decisions, basePages, compilePages);
  assert.equal(fit.fitted, true);
  assert.equal(fit.pages, basePages);
  assert.equal(fit.length_reverts, 1, "only the worst offender reverted");
  const t0 = decisions.find((d) => d.unit.id === "T0")!;
  assert.equal(t0.action, "kept");
  assert.match(t0.violation ?? "", /page count/);
  assert.equal(decisions.find((d) => d.unit.id === "T2")!.action, "replaced", "small rewrite survives");
  assert.ok(fit.tex.includes("Automated data pipelines in Python daily"));
});

test("fitTexToPages: already fitting → zero reverts; compiler unavailable → returns unfitted, no loop", async () => {
  const units = extractTexUnits(TEX);
  const { decisions } = decideTexEdits(units, [{ id: "T2", action: "replace", text: "Automated Python pipelines" }], "rewrite-full", vocabFromTex(TEX));
  const ok = await fitTexToPages(TEX, decisions, 1, async () => 1);
  assert.equal(ok.length_reverts, 0);
  assert.equal(ok.fitted, true);
  const dead = await fitTexToPages(TEX, decisions, 1, async () => null);
  assert.equal(dead.fitted, false, "no engine → honestly unfitted");
  assert.equal(dead.length_reverts, 0);
});

test("shimForXetex: guards RAW pdfTeX primitives; idempotent on already-guarded lines", () => {
  const raw = "\\usepackage{tabularx}\n\\input{glyphtounicode}\nx\n\\pdfgentounicode=1\n";
  const shimmed = shimForXetex(raw);
  assert.match(shimmed, /\\ifdefined\\pdfgentounicode\\input\{glyphtounicode\}\\fi/);
  assert.match(shimmed, /\\ifdefined\\pdfgentounicode\\pdfgentounicode=1\\fi/);
  assert.equal(shimForXetex(shimmed), shimmed, "idempotent");
});

test("vocabFromTex: resume-wide words legitimize claims (C++ ok, Kubernetes not)", () => {
  const v = vocabFromTex(TEX);
  assert.ok(v.has("c++"));
  assert.ok(v.has("altium"));
  assert.ok(!v.has("kubernetes"));
});
