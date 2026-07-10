# Resume tailoring based on the job — design doc

Living plan for the resume match-score + tailoring feature. Built as focused,
separately-committed rounds. (Origin: approved plan from the planning session.)

## Progress
- **Round 1 M1-A — shipped.** `score.js` (`scoreJob` / `verdictForScore` /
  `buildCandidateSummary`, UMD-lite) + `RUN_SCORE_JOB` SW handler in
  `background.js` + `test/score.test.js` (14 tests). Full suite 514 green.
- **Round 1 M1-B — shipped.** Popup "Score this job" UI + JD-paste stub
  (`popup.html` / `popup.js`).
- **Round 1 live-verify — PENDING (operator):** load unpacked, AI toggle ON +
  key, paste a real JD, click Score → plausible 1–10 + gaps in the popup and
  `[SCORE]` in the SW console; AI OFF ⇒ no LLM call.

## Context

ApplyPilot (this MV3 extension) needs: (1) a reusable **JD-match score**
("should I even apply?" + a way to rank resume variants), (2) a **multi-resume
pick-best** mode (drop several finished resume PDFs; pick the best per job), and
(3) three **user-selectable tailoring modes** — selection-only, selection +
constrained surface-rewrite, and an aggressive Simplify-style full-rewrite.

Research verdict: for a curated, no-fabrication answer bank, **selection +
reorder beats rewriting** (hallucination = high JD-alignment + low
content-preservation; gaps → "nothing to claim," never invented). All three
modes still ship as opt-ins with escalating guardrails.

**Locked decisions:**
1. **Split architecture.** Score + pick-best run **in the extension** (Rounds
   1–2) via the `llm.js` seam — no backend, operator's own key. Tailoring +
   LaTeX→PDF run **on the backend** (Round 3+).
2. **Match score = LLM-semantic**, rubric from
   `ApplyPilot-oss-reference/src/applypilot/scoring/scorer.py` (1–10 + ATS keywords).
3. **JD text: captured separately by the operator.** The extension READS it from
   `jobContext.jd` (a popup paste textarea is the interim stub). Not built here.
4. **Tailored output = a real attachable PDF** built on the backend by compiling
   `data/resume.tex` (sb2nov) with **`pdflatex` / TeX Live** (NOT tectonic — the
   template uses pdfLaTeX-only `\pdfgentounicode` / `glyphtounicode` /
   `[T1]{fontenc}`). Host likely Vercel + Supabase — both serverless/edge and
   **can't run `pdflatex` natively**, so Round 3 needs a dedicated compile
   container (called from Vercel) or an HTML/CSS→PDF fallback (oss-reference
   `pdf.py`). Does not block Rounds 1–2.

## Reuse (don't rebuild)
- `llm.js` — `callLLM({provider,model,apiKey,system,user,maxTokens})` → `{ok,text}`,
  never throws, retries 429/5xx, multi-provider. `act.llm` in-fill; direct in the
  SW `RUN_LLM_TEST`.
- `db.js` — IndexedDB `ApplyPilot`/`resume`, key `resume:default`, `getResume(key)`
  takes any key. **Missing:** `listResumes()` / `deleteResume(key)` (Round 2).
- `attachResume` (background.js) — variant-agnostic; two callers read the fixed
  key via `getResume()` (background.js ~1532 CDP, ~2197 page).
- `data/profile.json` (schema 2.0) — rankable units: `work_experience[]`,
  `projects[]`, flat `skills[]`, `education[]`. Gitignored — DO NOT edit.
- Tests: `node:test`, `npm test`. Pure → `require`+assert; LLM → fake `fetch`;
  brain → fake `act.llm`. No build step; deps vendored as static files.

---

## Round 1 (DONE) — extension-side match score

No backend, no PDF, no live-path change.

- **M1-A `score.js` + SW handler + tests.** `scoreJob({profile,jd}, llm)` →
  `{score(1-10)|null, verdict, matched_requirements[], gaps[], keywords[],
  rationale, error?}`. `llm` injected (`{ok,text}` shape); never throws; JD gate
  (`< MIN_JD_CHARS` → `no-jd`, no spend); tolerant JSON parse; `verdictForScore`
  is the code-side bucket source of truth; `buildCandidateSummary` excludes
  PII/demographics/auth. `RUN_SCORE_JOB` in `background.js`: reads profile +
  `jobContext.jd` + `llmConfig`, gated on the AI toggle, persists `lastMatchScore`.
- **M1-B popup UI.** "Score this job" button + JD-paste stub + result render.

---

## Round 2 (next) — multi-resume pick-best

Its own round: adds pdf.js + threads into both live attach sites. **Gated on M2-0.**

- **M2-0 pdf.js extraction RECON (gate).** Extract text from the real sb2nov
  `data/resume.pdf`, eyeball for lossy/reordered/ligature-mangled output BEFORE
  building ranking. Branch on evidence (in-extension pdf.js vs operator-provided
  per-variant summary vs backend `pdfplumber` vs `.tex` source).
- **M2-A `db.js` `listResumes()`/`deleteResume()` + variant upload UI** (keys
  `resume:variant:<id>`, keep `resume:default`; mark one active).
- **M2-B pdf.js extraction at upload** (store `text` per variant) — only if M2-0 passed.
- **M2-C comparative ranking.** `rankVariants(...)` = ONE comparative LLM call
  (all variants + JD, "rank these"), NOT N independent `scoreJob` calls
  (cross-call variance manufactures confident wrong picks). `pickBestResume` takes
  rank 1. `resolveActiveResumeKey()` — ONE resolver both attach sites call
  (default `resume:default`); no duplicated inline default.
- **M2-D pick-best UI** (ranking + winner + override).

---

## Round 3 (deferred) — backend tailoring + LaTeX→PDF + mode selector

Reuse/adapt oss-reference `scorer/tailor/validator/pdf` on the backend.

- **Backend `/tailor`** (`mode` = `select` | `rewrite-surface` | `rewrite-full`):
  profile + JD (+ base resume) → mode's LLM step → anti-fabrication `validator` →
  compile `resume.tex` → return tailored content + PDF (base64). Selection safe
  default; surface-rewrite locks facts/metrics + diffs; full-rewrite opt-in,
  always `needs_review`, anchor-checked, diffed.
- **Extension client:** "Tailor for this job" → POST backend → store returned PDF
  as `resume:tailored:<jobId>` variant → attach (+ `resolveActiveResumeKey`).
  Mode selector in the popup; tailored content + score surfaced in `summary.html`.
- **LaTeX-host decision (OPEN):** compile container (Fly/Render) called from Vercel
  (exact sb2nov fidelity) vs HTML/CSS→PDF on Vercel (no LaTeX, close-but-not-exact).

## Open decisions / risks
- **pdf.js extraction quality on sb2nov (M2-0 gate)** — the load-bearing unknown.
- **JD storage key/shape** — assumed `jobContext.jd`; confirm when capture lands.
- **Match-score scale** — 1–10 (oss-reference rubric).
- **LaTeX host on Vercel/Supabase (Round 3)** — container vs HTML→PDF.
- **Anti-fabrication** — reuse oss-reference `validator.py` for rewrite modes;
  selection can't fabricate by construction.
