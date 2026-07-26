# ApplyPilot Web

The living design + tracking doc for **ApplyPilot Web** — the main website users go to in order to
upload their resume, build their profile, configure AI, and drive the ApplyPilot Chrome extension.
Same role for the website that `docs/dom-patterns.md` plays for the extension: decisions, contracts,
and a per-milestone log so we can bisect intent.

> **Authority:** the extension's `CLAUDE.md` is authoritative for extension behavior. This doc is
> authoritative for the website + the website↔extension integration contract. When they touch the
> same surface (the handoff message types, the profile schema), keep them in lockstep.

---

## What this is

ApplyPilot today is a local-first Chrome MV3 extension that auto-fills Workday applications from a
profile in `chrome.storage.local` + a resume in IndexedDB. There was **no website and no backend**.
ApplyPilot Web adds the account-backed front door: sign in, upload/AI-parse a resume, edit the
profile, configure AI, set job context, and **auto-sync all of it straight into the extension** — and
(later phases) queue jobs, track applications, host review summaries, and analyze the pipeline.

## Stack & decisions (locked)

- **Frontend:** Next.js (App Router, TypeScript) + Tailwind CSS, in `web/` (self-contained; the
  extension stays vanilla JS).
- **Backend:** **Supabase** — Auth (Google + email), Postgres (with RLS), Storage (resume bytes).
- **Resume:** AI auto-parse into the profile, then manual edit. Guess + review, never silent.
- **Handoff:** **direct auto-sync** website → extension (requires extension changes — in scope).
- **Tracker:** the extension reports application status back to the backend automatically (P2).
- **Queue:** pasted Workday URLs for v1; architected for auto-discover later (P6).
- **Run:** local dev first (`cd web && npm run dev`), deploy-ready. The user provisions Supabase +
  Vercel; we ship migrations + `.env.example` + setup steps.
- **Aesthetic:** dark / techy, built as a **night flight-deck / instrument-panel** identity (below).

## Aesthetic — night flight-deck

Deliberately **not** the generic "near-black + acid-green" dark cluster. Grounded in ApplyPilot's
*autopilot/cockpit* subject and its **safety-flag** semantic ("guess + fill + FLAG, never silent
trust"): a status-light vocabulary used as **real information**, reused everywhere (resume parse,
profile completeness, queue, tracker, summary).

| Token | Hex | Role |
|---|---|---|
| `cockpit` | `#0A0E14` | page background — deep blue-black, not pure black |
| `panel` | `#121821` | instrument bezel surface |
| `panel-raised` | `#1A2230` | raised card |
| `ink` | `#E6EDF5` | primary text (warm off-white) |
| `ink-dim` | `#7E8C9E` | muted text |
| `amber` | `#FFB627` | **single brand accent** — the "needs-review" instrument warning |
| `verified` | `#36D6A0` | status: filled / verified |
| `signal` | `#FF5C5C` | status: stop / never-submit (used sparingly) |

- **Type:** Display **Space Grotesk** · Body **IBM Plex Sans** · Mono **IBM Plex Mono** (instrument
  readouts: field labels, counts, statuses). Loaded via `next/font`.
- **Signature element:** a live **"fill → review" status panel** in the hero — fields toggle empty →
  filled (teal ✓) → a couple flag amber **NEEDS REVIEW**, visualizing the safety contract. The same
  status-light component is the app's reused status vocabulary.
- **Quality floor:** responsive to mobile, visible keyboard focus, `prefers-reduced-motion`
  respected, sentence-case action-named copy ("Sync to extension" → toast "Synced").

---

## Architecture — the two integration directions (the crux)

### 1. Website → Extension (push profile + resume + session)

`externally_connectable` + `chrome.runtime.onMessageExternal` in the extension. The website sends
messages to the extension by ID; the extension writes them to its own storage (the documented
handoff contract).

- **`manifest.json`** gains `externally_connectable.matches` (the website origins) and backend
  `host_permissions` (so the SW can POST status reports in P2).
- **`background.js`** gains an `onMessageExternal` listener mirroring the existing `onMessage`
  dispatch style, handling:

| Message `type` | Action | Storage |
|---|---|---|
| `AP_PING` | detection + status | returns `{ ok, version, hasProfile, hasResume }` |
| `AP_SYNC_PROFILE` | write the handoff bundle | `chrome.storage.local` ← `profile`, `jobContext`, `buckets` (RAW); `defaults` **MERGED** (not clobbered) |
| `AP_SYNC_RESUME` | store the resume | IndexedDB via `saveResume({filename,mime,size,base64,savedAt})` |
| `AP_SET_SESSION` | reporting + review-pull credential | `chrome.storage.local` ← `{ ingestUrl, ingestKey, reviewUrl }` |
| `AP_SET_LLM` *(optional)* | mirror AI config | `chrome.storage.local` ← `llmConfig` |
| `AP_CLEAR_RESUME` | remove the stored resume (inverse of `AP_SYNC_RESUME`) | IndexedDB `deleteResume()` — idempotent |
| `AP_DISCOVER_JOBS` | **sweep the job boards** (the `/app/run` Discover button) — reads only, writes NOTHING | returns `{ ok, jobs[], stats, notes[] }`; the WEBSITE persists them via `saveDiscovered` |
| `AP_DISCOVER_RECON` | read-only DOM dump of the LinkedIn/Handshake search pages, for tightening the list scrapers | returns `{ ok, recon }` — queues nothing |

- **Live sync (M13).** Connecting once is enough: after the extension id is saved on the device
  (`localStorage["applypilot.extensionId"]`, the Connect page), every profile / bucket / AI-config /
  resume edit is pushed to the extension automatically from the browser via `lib/extension-sync.ts`
  (`liveSync(kind)` — fetches the current slice server-side, then sends the matching `AP_*` message; a
  debounced, fire-and-forget no-op when not connected here). The `session`/reporting key is **never**
  re-minted by a routine edit — that stays a Connect-page action. Feedback surfaces via a single
  `<LiveSyncToast/>` in the app shell.

- **Extension ID:** v1 = the user pastes their extension ID (from `chrome://extensions`) once on the
  Connect page; the website stores it and targets `chrome.runtime.sendMessage(id, …)`. The page must
  be on an origin listed in `externally_connectable.matches`. Hardening (P6): pin a stable ID via a
  manifest `key`.

### 2. Extension → Backend (report application status) — P2 (credential plumbed in v1)

After a fill/walk, the SW POSTs to `{ingestUrl}` with `Bearer {ingestKey}`:
`{ company, role, url, status, needs_review_count, captured_at, review_bundle }`. A Next.js route
validates the per-user ingest key (an `api_keys` row) and upserts-by-URL an `applications` row.
Per-user API key avoids extension-side OAuth token refresh. **Both** the single-page CDP fill
(`runCdpFillPage`) and the multi-page walk (`runCdpWalk`, on every exit) push the accumulated
review bundle, so the website always has the latest to review.

### 3. Backend → Extension (PULL the approved review bundle) — the review round-trip

The website is the **review surface** (edit + approve — see the review-editor section). Before a
replay/submit, the SW **pulls** the human-approved bundle from `{reviewUrl}`
(`GET /api/extension/review?url=…` with `Bearer {ingestKey}`) and writes it into
`chrome.storage.local.reviewSummary` — the exact slot `runCdpReplayWalk` reads. `pullApprovedBundle`
NEVER throws: not-connected / no-remote-bundle / HTTP error all fall back to the local bundle, so
replay is never blocked by the network. **When the site is connected and has a bundle, it is the
source of truth** (it overwrites the local one — the point of hosting review on the site); the
extension's own `summary.html` stays as a fallback for when the site isn't connected.

---

## Data contracts (sourced from the extension — keep in lockstep)

### Profile — **store RAW only** (schema v2.0)
The extension's `prepareProfile` (`background.js`) DERIVES `*Parsed` (dates), `bulletsText`,
`_allFluent`, and the filtered/sorted order at fill time. The website stores **only raw user
fields** — never the derived ones. Reference: `data/profile.example.json`.

- `personal_info` — `first_name`, `last_name`, `has_preferred_name` + `preferred_first_name` + `preferred_last_name` (revealed by an "I have a preferred name" checkbox — the extension's `preferredCheck`/`preferredName--first/last` already map these), address, email, phone, `country`*, `country_phone_code`* (*=tiered array).
- `websites[]` — `{type, url}` (url gets `https://` prepended; `label` was dropped — the extension only fills url). The editor pins **3 fixed rows** (LinkedIn / GitHub / Personal Website, **type locked**); added rows carry a custom type.
- `education[]` — `{school_or_university, degree*, field_of_study*, minor, gpa, gpa_scale, from_year("YYYY"), to_year("YYYY"), graduation_date("YYYY-MM"), currently_enrolled, …}`.
- `work_experience[]` — `{job_title, company, location, currently_work_here, from("YYYY-MM"), to("YYYY-MM"), role_description, tech_stack[]}`. **`role_description` (one Workday-style textarea, dash-bulleted) REPLACED `bullets[]`** — `coerceProfile` migrates legacy bullets → `- ` lines; the extension's `prepareProfile` derives `bulletsText` from it (bullets fallback), so `WORK_EXPERIENCE_MAP` is unchanged.
- `languages[]` `{language, reading, speaking, writing, fluent}` — `fluent` (tri-bool) is the human-set "I am fluent" box; `prepareProfile` uses it when set, else derives from reading∧speaking∧writing. `certifications[]` `{certification*, certification_number, issued_date("YYYY-MM-DD"), expiration_date, specialties[]}`; each specialty `{specialty, start_date("YYYY-MM-DD"), end_date, attachment}` — nested repeating, matches the extension's `CERT_NESTED`. `projects[]`.
- **Boolean convention (2026-07-16).** True CHECKBOX widgets are plain **`boolean`** (default `false`) — a checkbox has no "unanswered" state on a form, so `has_preferred_name`, `work_experience[].currently_work_here`, `education[].currently_enrolled` are booleans (`coerceProfile` migrates legacy `null`→`false`; the extension unchecks a false/absent mapped box). **`triBool`** (`true|false|null`) is reserved for genuine yes/no *questions* where "unanswered" is meaningful — `work_authorization.*`, `screening.*` (leave blank / flag rather than guess) — and for `languages[].fluent` (`null` = auto-derive from reading∧speaking∧writing).
- `additional_files[]` — `{label, file}` general documents (transcripts, portfolios) → the private `attachments` bucket (see below).
- `skills[]`, `work_authorization`, `self_identification`, `screening`, `agreements`.
- `how_did_you_hear` `{preferred[], fallback}` — a fallback source list (profile WINS over `defaults`); the editor shows `preferred[]` only (the extension fills the real source when the queue knows it, else works down the list).
- `employment_history_companies[]` — **maintained by hand**, NOT derived from `work_experience`
  (safety-critical for the "previously worked here?" auto-No). `[]`=unfilled (flags review),
  `["none"]`=never employed.

\* **Tiered arrays** (most-specific first) account for tenant-specific dropdown text:
`personal_info.country`, `personal_info.country_phone_code`, `work_authorization.citizenship_country`,
`education[].degree`, `education[].field_of_study`, `certifications[].certification`. The editor shows a
primary control (a country dropdown, or a free-text box) + a subtle in-field ▾ that opens an
**Advanced-choices popup** holding the ordered fallback list (country picks EXPAND to their known
candidates via `lib/countries.ts`, avoiding the ambiguous single-"United States" match).

### Answer buckets — `profiles.buckets_json` (Profile v2)
The platform-agnostic answer store that generalizes `FIELD_MAP` + question-wording matching. A **bucket**
= one canonical answer + the wordings that map to it. Two modes:
- **Mode A** (`profile_path` set) — value comes from that profile field; editing the field re-fills every
  wording, on every ATS.
- **Mode B** (`value` set, no `profile_path`) — a standalone answer for the long tail; promotable later.

Element shape: `{ id, profile_path, value (string[] — a candidate list), category, widget_hint,
questions[], selectors{} }` (`coerceBuckets` upgrades a legacy string `value`; a legacy `sensitive` key is
dropped on parse — deterministic bucket fills are never flagged, so buckets carry no sensitivity, and there's
no field-type gate: the extension adapts to the LIVE form widget). `widget_hint` is now only a DISPLAY hint
for the editor — the **"Answer type"**: **Text / Yes-No / Checkbox** (Text also covers dropdown/type-ahead via
its candidate ladder). Edited two ways in `ProfileEditor`:
- **per-field label popups** (`BucketFieldPopup`, shared with the teach page) — click a field label → edit the
  wordings that map to it, creating the Mode-A bucket on first use;
- **the remembered-answers UI** for **Mode-B** answers: a categorized answer **merges into its matching
  profile section** (Screening / Work authorization / Self-identification / Personal information — shown as a
  plain field below that section's inputs); a custom / Experience / Education category gets its **own card**;
  everything else lands in **"Other remembered answers"**, the single **Add** entry point. Each answer displays
  like a normal profile field (the question as the label + its value control — text ladder, Yes/No toggle, or a
  checkbox — with **Advanced + delete on that same line**). An **Advanced/Add popup** works on a **draft** and
  commits ONLY on **Done** (outside-click / Esc / X cancels; a brand-new answer is never created): it edits the
  wordings, answer type, the answer, and the category (pick **"Other"** → type a new category **live**, no
  separate Add — a custom category persists in the dropdown while an answer uses it). Delete is a two-step
  inline confirm.

**Seed:** new profiles are provisioned (`loadBuckets`, provision-if-null) with `STARTER_BUCKETS` — Mode-A
wording→field bindings only, no baked answers.

Matching hierarchy in the extension (`drivePageFill`): platform accelerator (Workday automation-id via
`FIELD_MAP`) → exact-normalized **label** wording (the bucket, `buildBucketIndex`/`fillFromBucket`) → AI
fallback. **No fuzzy** in the deterministic tier; a bucket value is only ever a CANDIDATE through the match
ladder (never blind), consulted BEFORE the AI pass. Matching is LABEL-only — `bucket.selectors` (per-platform
ids) is unused scaffolding. This SUPERSEDES the earlier `answerBank` sketch.

### Teach the tool — `/app/teach` (approved AI answers → buckets)
The learning loop's curation surface. After a fill is reviewed + **approved** (the review editor persists the
approved bundle to `applications.review_bundle_json`), its answers that DIDN'T fill deterministically become
teaching cards, so they fill deterministically (no review) next time.
- **Data (`lib/teach.ts`, pure + unit-tested in `test/teach.test.ts` via the `tsx` runner):**
  `teachableCards(apps, buckets, profile, dismissed)` = every **approved + bucket-eligible** entry with a
  value that either was flagged **`needs_review`** OR was **manually edited on review** (`wasManuallyEdited`
  — an `override` / `filled_blank`; a human override of a *clean* deterministic fill is a signal the fill
  was wrong, so it teaches too). Deduped by normalized question, minus anything already bucketed or
  dismissed — read across the user's reviewed applications.
- **Split-screen (`components/app/teach/`):** the current teach card is on the **left**; the **profile is
  physically displayed AND editable on the right** (`ProfilePanel`, from `flattenProfileFields` + the simple
  list sections **Skills / Employer history / Websites**). It's a **sticky, self-scrolling** column that
  **auto-scrolls to + highlights the recommended field** when a card appears, so the card and its target field
  stay on one screen. Clicking a field's **name** opens its wordings bucket (`BucketFieldPopup`); clicking its
  **answer** opens an editor (`AnswerEditPopup`) that modifies the profile value and shows the **ladder** for
  candidate/tiered fields (country / phone-code / citizenship / sources). Both persist via `saveProfile` /
  `saveBuckets`.
- **Recommendation precedence: `canonical_field` (the mapped home — free/exact) → the fill-time `maps_to`
  piggyback → a teach-time LLM fallback** (`recommendField` server action → `callLLM` with the user's
  `ai_config`), which fires ONLY when nothing is known (e.g. an unmapped pre-populated field). A
  fuzzy/containment match (`isFuzzyTier`) on a known field shows a "possible typo/variant — verify" note; a
  recommended field that's **blank in the profile** shows a warning to add the answer.
- **Two-step add flow (reuses the profile page's add-a-remembered-answer flow).** The card leads with ONE
  smart primary — **"Add to your &lt;field&gt;"** (the recommended field) — that opens the **end-step confirm
  popup** (`TeachAddPopup`, keyed on a `ConfirmTarget = field | existing`). The popup opens straight into the
  MISSING half (`decideTeachRoute`, pure + tested): the field already holds this answer → **wording** (just
  remember the phrasing); empty/different → **answer** (set the value, or append to the ladder — reorderable
  — AND file the wording). The element being added is **highlighted in amber** (`highlight` prop on
  `TieredField` / `TagListField` / `ProfileFieldEditor`) so the user confirms exactly what changes. If the AI
  picked the wrong field, **"Wrong field?"** opens the **`TargetPicker`** — a filterable list of every profile
  field + standalone saved answer, plus **"Make a completely new answer"**. A brand-new answer opens the SAME
  **`RememberedAnswerPopup`** the profile page uses (extracted to `components/app/RememberedAnswerPopup.tsx`,
  shared LOCKSTEP), prefilled from the card. A card with no recommended field leads with **"Save as a new
  answer"** instead. **Skip** persists in `profiles.teach_dismissed_json` (migration `0004`) so a skipped card
  doesn't reappear. Writes via `saveBuckets` / `saveProfile` → synced to the extension.

### Attachments — private `attachments` Storage bucket (Profile v2)
Per-specialty files + `additional_files[]` upload to a private Supabase bucket, namespaced
`attachments/<uid>/<uuid>-<name>` (`POST /api/attachments/upload` → a `{path,filename,size,mime}` ref stored
in `profile_json`). Migration `0003_attachments.sql`. *(The extension attaching these per-field on Workday
is a follow-up; the website owns upload/storage/management today.)*

### Defaults — `data/application_defaults.json`
`{ how_did_you_hear, field_of_study, degree, gpa_range }`, each `{ preferred[], fallback }`.

### jobContext — `{ company }` (per-application).
The standalone `/app/job` editor page + its sidebar entry were removed; the value still lives in
`profiles.job_context_json` and is fed to the extension via **Connect** and used as a default in the **Cover
letter** page (no dedicated editor UI for now).

### AI config — `llmConfig` shape (extension `chrome.storage.local.llmConfig`)
`{ provider: "anthropic"|"gemini"|"openai", model, apiKey, enabled }`. Model lists from `LLM_MODELS`
(`llm.js`); default `gemini-3.1-flash-lite`. `web/lib/llm.ts` is a TS port of `callLLM` (never-throws
contract) — single source for resume parsing + AI-config parity.

### Resume — IndexedDB `ApplyPilot`/`resume`/`resume:default`
`{ key, filename, mime, size, base64, savedAt }` (raw base64, not a data: URL). Base64 string crosses
the messaging boundary; the extension's `saveResume` (`db.js`) writes it.

### reviewSummary — the hosted review EDITOR (P3 → now the primary review surface)
Envelope `{ schema_version, page, page_number, page_label, url, tenant, captured_at, total, counts,
by_type, needs_review_count, section_shapes, approval, entries[] }`; per-entry `{ field_id, page,
page_number, page_label, question_label, widget_type, canonical_field, is_required, current_value,
original_ai_value, is_edited, edit_kind, is_approved, approved_at, is_deleted, is_added,
cascade_revealed, confidence, confidence_source, needs_review, needs_review_reason, fill_status,
options, captured_options, tree_structure, date_order, tiers, match_tier, flag, … }` (see
`lib/review-summary.ts`). The extension's `summary.js` viewer/editor is ported to React at
`components/app/review/ReviewEditor.tsx` over this schema — **the website is now the primary review
surface**. The PURE edit/approval transforms are `lib/review-approval.ts` (faithful TS port of the
extension's `summary-lib.js` — keep in LOCKSTEP; `test/summary.test.js` is the semantic spec) +
`lib/review-model.ts` (the grouping/prominence/shape logic from `summary.js`). Edits autosave to
`applications.review_bundle_json` via the `saveReviewBundle` server action (recomputes the `approval`
envelope + `needs_review_count` server-side — never trusts a client `submit_ready`). The extension
PULLS this bundle before replay (direction 3 above). **`submit_ready` semantics are unchanged:** every
`needs_review`/`cascade_revealed` field approved AND no unreplaced AI placeholder — but the extension's
`submitPrecondition` recomputes the equivalent itself, so the website's job is to write correct
per-entry `is_approved`/`current_value`/`edit_kind`/`is_deleted`.

---

## Database model (Supabase Postgres, RLS keyed to `auth.uid()`)

- `profiles` — one row/user: `profile_json`, `buckets_json` (answer buckets — migration `0002_buckets.sql`), `defaults_json`, `job_context_json`, `ai_config` (provider/model/key/enabled), `updated_at`.
- `resumes` — `id, user_id, kind('default'|'variant'), job_id?, filename, mime, size, storage_path, created_at`.
- **Storage buckets:** `resumes` (0001) + `attachments` (0003) — both private, objects path-namespaced under `<uid>/`.
- `applications` — `id, user_id, company, role, url, status('queued'|'filling'|'needs_review'|'submitted'|'interviewing'|'offer'|'rejected'), needs_review_count, review_bundle_json?, applied_at, …`.
- `queue_items` — `id, user_id, url, status, position, created_at` + the discovery columns (migration `0010`): `job_key, company, role, source, location, posted_at, job_description`. A PASTED row leaves those null and renders exactly as before; a DISCOVERED row carries its board, freshness and scraped JD. Partial unique index on `(user_id, job_key) where job_key is not null` = one row per job per user, and the race backstop for two concurrent sweeps.
- `reminders` — `id, application_id, due_at, note`.
- `api_keys` — `id, user_id, key_hash, label, last_used_at` (the extension ingest credential).

---

## Roadmap (phased — architected now, built per phase)

- **v1 (done)** — auth · resume upload + AI parse · profile editor · job context · AI config · **extension auto-sync**. The core "upload your resume and feed the extension" loop.
- **P2 (done)** — Tracker + Queue: `/app/queue` (paste Workday URLs → `queue_items`, manage) + `GET /api/extension/queue` (ingest-key pull); `/app/tracker` (applications list, stats strip, status lights, pipeline-stage select, filters) fed by `POST /api/extension/report`. Queue + Tracker promoted to live sidebar nav; dashboard updated; Analytics now the "coming soon" item. A hard-gated `DEV_PREVIEW` sample dataset makes both demoable pre-Supabase.
- **P3 (done)** — Hosted review summaries: `lib/review-summary.ts` + `ReviewSummaryView` render the `reviewSummary` bundle at `/app/tracker/[id]` (needs-review-first, safety badges, grouped all-fields) — read-only; tracker rows link in. The extension now PUSHES its bundle: `reportApplication(bundle, jobContext)` in `background.js` fires after `runCdpFillPage` (fire-and-forget, no-op if the website isn't connected, status never "submitted"); `POST /api/extension/report` upserts-by-URL so re-runs don't duplicate. **Superseded by M9** (the read-only view → a full editor; the walk now reports too; write-back landed as a PULL).
- **P4 (analytics done; reminders pending)** — `/app/analytics`: stat tiles (applications, submitted, interview rate, needs-review load), a labeled pipeline-distribution bar, an outcomes panel (offer/interview rates), and applications-over-time columns — server-rendered SVG, no chart lib, following the dataviz method (status colors always label-paired; palette contrast-validated). Pipeline stages ship via the tracker's status select; per-application **reminders** (the `reminders` table) are the remaining P4 piece.

> **Merged `origin/main` (backend features) — `6219cc2`.** Main added Gmail integration
> (`gmail.js` + manifest `oauth2`/`identity`/gmail host) and the review→submit **replay/approval**
> flow (`summary-lib.js`, `runCdpReplayWalk`). Conflicts (my `reportApplication` + `onMessageExternal`
> vs main dropping the `opts`/skip-lock param) resolved keeping both. **Portability verified:** every
> contract the web app hardcodes — `LLM_MODELS`, profile schema v2.0, the `reviewSummary` envelope,
> the resume record, the `AP_*` handoff — is UNCHANGED by main. Extension suite 578/578 green; web
> production build green.
- **P5 (cover letters done; resume variants pending)** — `/app/cover-letter`: generate a tailored cover letter from the profile + a pasted posting via the user's LLM (`lib/cover-letter.ts` prompt + `generateCoverLetter` action), editable, copy-to-clipboard, grounded-only-in-profile. AI-tailored resume *variants* (resume `variant` rows) are the remaining P5 piece.
- **P6 (auto-discover built, live-verify pending)** — **Job discovery** (M16 below): the Discover button on `/app/run` fills `queue_items` from the Simplify 2026 board + the operator's signed-in LinkedIn/Handshake sessions. Remaining P6: production hardening (pinned extension ID via manifest `key` — now done, encrypted keys, deploy) and more boards.

---

## Milestone log

Incremental, one focused change per milestone, a commit each (so we can bisect) — mirroring the
extension's discipline.

- **M1 — WEBSITE.md** *(done)*: this doc — scope, decisions, contracts, DB model, roadmap, log.
- **M2 — Scaffold + landing** *(done, `5b031c8`)*: `web/` Next.js + TS + Tailwind; flight-deck tokens + fonts; landing page with the signature fill-status hero. Build green; desktop + mobile verified.
- **M3 — Auth + Supabase** *(done)*: `@supabase/ssr` browser/server clients, session middleware (guards `/app/*`), Google + email/password login, `supabase/migrations/0001_init.sql` (full schema + RLS + private `resumes` storage bucket), protected `/app` instrument-rail shell + setup dashboard. Graceful "backend not connected" notice when unconfigured. **Dev-preview bypass** (`NEXT_PUBLIC_DEV_PREVIEW=1`, hard-gated to non-prod) to view the signed-in UI before Supabase is wired. Type-check + login/app render verified.
- **M4 — Profile editor** *(done)*: `lib/profile-schema.ts` (zod schema v2.0 + `emptyProfile`/`coerceProfile`); reusable form primitives (`components/form/fields.tsx` — text/select/tri-bool/tag-list/tiered); full sectioned editor (personal info, websites, work experience, education, skills, languages, certifications, work auth, how-did-you-hear, employer history w/ safety note, self-id, screening defaults); raw-fields-only; `saveProfile` server action upserts `profiles.profile_json`. Type-check + full render verified. *(Deferred to a later pass: essay_drafts, story_bank, projects, long-tail application_questions — not on the extension's current fill path.)*
- **M5 — Resume + AI parse** *(done)*: `lib/llm.ts` (faithful TS port of `llm.js`, never-throws, same `LLM_MODELS`); `lib/ai-config.ts` (`llmConfig`-parity); `lib/resume-prompt.ts` (extraction prompt + tolerant JSON parse); `mergeProfile` (fill-blanks). `POST /api/resume/upload` (PDF → Storage `resumes/<uid>/default-resume.pdf` + `resumes` row) and `POST /api/parse-resume` (`unpdf` text extract → user's LLM → raw profile JSON). Resume UI: drag-drop upload, "Parse with AI", found-summary, "Apply to my profile" (fill-blanks, `applyParsedProfile`), remove. Type-check + render verified. *(Live upload/parse needs the user's Supabase + AI key.)*
- **M6 — AI config + job context** *(done)*: `/app/ai` — provider/model (from `LLM_MODELS`, default `gemini-3.1-flash-lite`)/key/enable toggle + server-side **Test connection** (`testLlm` round-trips a trivial prompt); saved to `profiles.ai_config`. `/app/job` — target company → `profiles.job_context_json`. Type-check + render verified.
- **M7 — Extension wiring** *(done)*: `manifest.json` gained `externally_connectable.matches` (`http://localhost/*`, `127.0.0.1`) + `http://localhost/*` host permission; `background.js` gained the `onMessageExternal` handler (`AP_PING`/`AP_SYNC_PROFILE`/`AP_SET_LLM`/`AP_SET_SESSION`/`AP_SYNC_RESUME`) writing the same `chrome.storage.local`/IndexedDB slots the popup seeds. Website: `lib/extension.ts` client bridge (`pingExtension`/`sendToExtension`, graceful when `chrome.runtime` absent), `getSyncBundle` server action (profile+defaults+jobContext+llmConfig+resume base64 + a freshly-minted ingest key), `/app/connect` (paste ID → check → sync, per-step status), and `POST /api/extension/report` (validates the ingest key via `api_keys`, inserts an `applications` row — the P2 tracker path, ready). Extension suite **325/325 green**; web production build green; bridge graceful-path verified. **Live website↔extension round-trip is the user's step** (load unpacked extension → copy ID → Sync) — needs the extension in the same Chrome profile.
- **M8 — Profile v2: editor overhaul + answer buckets** *(done, merged PR `#10`, live-verified on localhost:3000)*: two halves.
  **(A) Editor UX** — country / phone-code / citizenship pickers (dropdown + an Advanced-choices ▾ popup over the tiered candidates; `lib/countries.ts`); Workday-style segmented **date pickers** (year / month-year / month-day-year, emitting the same canonical strings; month is a typeable "5"→"05 — May" input); Yes/No toggles with a divider bar + bold amber selected state, no blank option (Esc clears); self-identification → dropdowns; **preferred-name** checkbox revealing first/last; websites = 3 fixed rows (LinkedIn/GitHub/Personal Website, type locked) + custom rows; bullets → one dash-bulleted **Role description** box; how-did-you-hear as a fallback list. Schema (`lib/profile-schema.ts` v2.0) gained `preferred_first_name`/`preferred_last_name`, `role_description` (replacing `bullets`), `languages[].fluent`, `certifications[].specialties[]`, `additional_files[]` — all lockstep with the extension (`prepareProfile`, `WORK_EXPERIENCE_MAP`, `CERT_NESTED`, the `preferredName--*` FIELD_MAP entries). **(B) Answer buckets** — `buckets_json` (migration `0002`) + `lib/buckets.ts` + `STARTER_BUCKETS` seed (provision-if-null) + per-field bucket popups; the extension consumes them (`buildBucketIndex`/`fillFromBucket` in `drivePageFill`, match-ladder-gated, before AI) — supersedes the `answerBank` sketch. Plus **attachments** (`0003` bucket + `POST /api/attachments/upload`; per-specialty + `additional_files`). Also fixed: `AP_SYNC_PROFILE` now MERGES `defaults` (a sync no longer wipes the extension's field_of_study/degree/gpa_range). Web typecheck + build green; extension suite 593/593.

- **M9 — Review stage migrated to the website (editor + approval + round-trip)** *(built; live-verify pending)*: the review stage moved OFF the extension's `summary.html` and ONTO the site — the site is now the PRIMARY review surface. `components/app/review/ReviewEditor.tsx` is a faithful React port of `summary.js`'s editor (every widget editable, per-field/section/all approval, submit-ready gating, repeating + nested cert-specialty sections, currently-work-here / preferred-name mirrors) over the extended `reviewSummary` schema; pure transforms in `lib/review-approval.ts` (port of `summary-lib.js`) + `lib/review-model.ts`. `saveReviewBundle` autosaves edits to `applications.review_bundle_json` (RLS; recomputes approval + needs_review_count). Round-trip: the walk PUSHES its accumulated bundle on every exit (`reportApplication` in `runCdpWalk`); the extension PULLS the approved bundle before replay (`GET /api/extension/review` + `pullApprovedBundle`, writing `chrome.storage.local.reviewSummary`), so `runCdpReplayWalk`/`submitPrecondition` are UNCHANGED. `AP_SET_SESSION` carries `reviewUrl`. The extension `summary.html` stays as a fallback until this is live-verified. Extension suite 593/593; web typecheck + build green. **Live-verify:** fill → walk reports → edit/approve on `/app/tracker/[id]` → Replay pulls + would-submit (needs Supabase + `/app/connect`).

- **M10 — Teach + Remembered-answers UX overhaul** *(done; web typecheck + build green, `test/teach.test.ts` 15/15)*: reworked how custom answers are authored and taught.
  **Teach page (`/app/teach`)** — swapped the layout (card LEFT, profile RIGHT); the profile panel is now **editable in place** (click a field's name → `BucketFieldPopup` wordings; click its answer → `AnswerEditPopup` value editor with the tiered **ladder** for candidate fields), extended with the simple list sections **Skills / Employer history / Websites** (website URLs are bucketable), made a **sticky self-scrolling** column that **auto-scrolls + highlights** the recommended field, added a **blank-profile warning**, and routed every add-to-profile action through a **confirm popup** (`TeachAddPopup`: question-bucket / answer-into-field / new / existing). Extracted the shared `ProfileFieldEditor` + `BucketFieldPopup`; per-path field metadata in `lib/profile-fields.ts`.
  **Profile page remembered answers** — a categorized Mode-B answer now **merges into its matching section** (or an own card / the "Other" card, the single **Add** entry point); each answer displays as a plain profile field with **Advanced + delete on the same line**; the **Advanced/Add popup is a draft that commits only on Done** (outside-click / Esc / X cancels); **Answer type** trimmed to **Text / Yes-No / Checkbox** (checkbox renders a real checkbox; Text covers dropdown/type-ahead via its ladder — no field-type gate, the extension adapts at fill time); custom category typed **live** (no separate Add); delete is a two-step inline confirm.
  **Removed:** the bucket-level `sensitive` flag + checkbox (deterministic fills are never flagged — the AI-guess legally-loaded flag is separate and untouched); the standalone `/app/job` "Job context" page + its sidebar entry (value still lives in `job_context_json`, fed via Connect + Cover letter). "Screening defaults" → **"Screening"**.
- **M11 — Teach reuses the profile page's add flow** *(done; web typecheck + build green, `test/teach.test.ts` 17/17)*: the teach page no longer maintains a parallel "add to profile" UX — it **reuses the profile page's** exact add-a-remembered-answer popup.
  **Shared popup** — extracted `RememberedAdvancedPopup` (+ `ConfirmDeleteButton` / `RememberedToggle` / `RememberedCheckbox`) out of `ProfileEditor.tsx` into `components/app/RememberedAnswerPopup.tsx`; the profile page imports it (behavior unchanged) and the teach page's "new answer" route opens the SAME popup, prefilled from the card.
  **Two-step add** — collapsed the old four add-buttons into ONE smart primary **"Add to your &lt;field&gt;"** → the **end-step confirm popup** (`TeachAddPopup`, now keyed on a `ConfirmTarget = field | existing`). Pure `decideTeachRoute` / `fieldHoldsAnswer` (`lib/teach.ts`) pick the missing half — **wording** (value already there) vs **answer** (set / append the ladder + file the wording). The added element is **highlighted in amber** (new `highlight` prop on `TieredField` / `TagListField` / `ProfileFieldEditor`), and a candidate ladder stays **reorderable** before Confirm.
  **Wrong-field escape hatch** — a new **`TargetPicker`** (filterable list of every profile field + standalone saved answer + "Make a completely new answer") replaces the scattered "add to existing / save new" buttons; a no-recommendation card leads with "Save as a new answer". The right `ProfilePanel` (in-place profile editing) is unchanged.
- **M12 — Live app updates, AI-config polish, review-CTA + source-ladder UX** *(done; web typecheck + build green, `test/teach.test.ts` 19/19)*: a batch of operator-requested UX fixes.
  **Live fetch (no F5).** Tracker + teach now poll their data in place and patch React state — NOT `router.refresh()` / a hard reload — so a walk's pushed bundle appears without a manual refresh. New cookie-authed JSON endpoints `GET /api/applications` + `GET /api/teach` (return `ok:false` when unconfigured / signed-out so the poller never clobbers the list); `TrackerPanel` holds `apps` in state + a 12s poll; `TeachInbox` background-polls newly-teachable cards into the queue (append-only, `handledRef`-guarded); app pages also refresh on tab focus. A **manually-edited** field is now teachable even when the edit reset its approval (`wasManuallyEdited` / relaxed `isTeachable` in `lib/teach.ts`).
  **AI config.** The AI-fill toggle switch was redrawn (visible white knob); **Save is disabled until the config actually differs** from what's stored (`savedCfg` / `dirty`). The website's AI toggle stays the SINGLE opt-in — the extension MIRRORS it (an extension-side auto-opt-in was reverted).
  **Review CTA.** `ReviewEditor`'s "Edit my profile" prompt shows ONLY on a genuine data problem (`errors.length || empties.length`), not on a **cancelled** fill (a cancel isn't a profile error).
  **Source fallback ladder (profile).** Default `how_did_you_hear.preferred` = **LinkedIn → Handshake → GitHub** with **"Other"** as the always-matching `fallback` (last resort, kept OUT of `preferred` so it can't short-circuit). Changed in lockstep: `emptyProfile()` zod default, `data/profile.example.json`, `data/application_defaults.json`. The profile page now **shows the ladder pre-filled** (seeded when the stored list is empty — mirrors `withDefaultWebsites`) as a **reorderable, side-by-side** chip list (new `horizontal` mode on `TieredField`, ◄ ► arrows) + a surfaced editable **"Last resort"** field.
- **M13 — Live sync (connect once, edits push automatically)** *(done; web typecheck + build green, extension suite 621/621)*: after the extension is connected on a device, editing your data on the website pushes it to the extension with no further "Sync everything" click.
  **Client helper (`web/lib/extension-sync.ts`).** `liveSync(kind)` (`"profile" | "ai" | "resume" | "resume-clear"`) is a **debounced, fire-and-forget no-op unless connected here** (an extension id in `localStorage["applypilot.extensionId"]` AND Chrome extension messaging present). It fetches the current slice from the backend (single source of truth → reflects zod coercion + server-side merges like resume-parse), then sends the matching `AP_*` message via the existing `lib/extension.ts` bridge. Profile pushes **always** carry `profile + defaults + buckets` together (the extension's `AP_SYNC_PROFILE` guard rejects a buckets-only push).
  **Server slices (no key mint, `connect/actions.ts`).** New `getProfileSyncSlice` / `getAiSyncSlice` / `getResumeSyncSlice`; `getSyncBundle` refactored to compose the shared shapers (`shapeProfileSlice`/`shapeAiSlice`) so the per-slice and whole-bundle payloads never drift. The reporting/`session` key is **never** re-minted by a routine edit.
  **Wired save sites** — `ProfileEditor.save` (profile + buckets), `AiConfigForm.save` (AI), `ResumePanel` (upload → resume, apply-parsed → profile, remove → resume-clear), `TeachInbox` (`persistProfile`/`persistBuckets`/`commit`). Feedback via a single `<LiveSyncToast/>` mounted in `app/app/layout.tsx`.
  **Extension side** — new `AP_CLEAR_RESUME` handler (`background.js`) + `deleteResume` (`db.js`, unit-pinned in `test/db.test.js`) so a website resume-removal propagates. All other syncs use the handlers that already shipped in M7 — **only resume-removal requires an extension reload.** Connect page copy updated ("edits sync automatically"). **Live-verify pending:** the browser round-trip on a real Chrome install with the extension.
- **M14 — One-button Run + Sign-in/email page + tracker dedup** *(done; LIVE-VERIFIED on Magna wd3 2026-07-22; web typecheck + build green)*: the site can drive the WHOLE apply pipeline from one button.
  **`/app/run` (`RunPanel.tsx`)** — paste a Workday link, press Run → `sendToExtension(AP_RUN_APPLICATION)` (the extension opens a fresh tab, scrapes the JD, runs onboard → walk to the review page, never submits). Saves the JD to `applications.job_description` (migration `0006`); a **"Job description" modal button** on `/app/tracker/[id]` shows it.
  **`/app/credentials` ("Sign-in & email")** — the Workday sign-in account + the Gmail auto-verify toggle, live-synced to the extension (`AP_SET_CREDENTIALS` / `AP_SET_ONBOARD_CONFIG`, new `credentials`/`onboard` `liveSync` kinds) and stored on `profiles.credentials_json`/`onboard_config` (migration `0007`); a "Connect Gmail" button triggers the extension's Chrome-owned OAuth remotely (`AP_GMAIL_CONNECT`). Password stored plaintext on the owner-only row (same posture as `ai_config`'s API key; UI warns to use a throwaway account). Sidebar + overview setup grid + "Sync everything" include it.
  **Tracker dedup** — a stable `job_key = "<datacenter>:r<reqid>"` (`web/lib/job-key.ts`, lockstep with the extension's `canonicalJobUrl`; migration `0008` + index) so re-runs of a job update ONE row (the raw application url changes every run). Both writers upsert by (user_id, job_key); the tracker/detail render company + title, host only as a fallback.
  **Profile polish** — Save is dirty-gated; "How did you hear" seeds "Other" as the last list entry (the separate last-resort field retired); `web/supabase/schema.sql` is a consolidated one-paste snapshot of all migrations.
- **M15 — Teach-flow correctness** *(done; web typecheck + build green, `test/teach.test.ts` extended)*: the teach page now surfaces exactly what the operator must act on. `isTeachable` UNCHANGED (AI-filled + approved, or a manual edit). A **"Skipped (N)"** section reveals + restores skipped cards. **`coveredKeys(buckets, profile)`** treats a bucket as "covering" a question only when it can actually answer it (Mode-A bound field non-empty / Mode-B value non-empty) — an empty/unanswered bucket (or a profile field the operator removed) resurfaces the question with the "add it back" warning. **#4:** an AI-filled entry is not hidden by `covered` even when a bucket nominally covers it (proof the saved value didn't match this tenant). The card recommends the matching Mode-A bucket's bound field (`bucket_path`) over the AI's `maps_to` hint; `profileValueAt` no longer renders "[object Object]" for object paths. Fixed the "Remember wording" popup flash (persist-then-apply in `commit()`).

- **M16 — Job discovery: a Discover button that fills the queue** *(built 2026-07-26; extension 718/718, web 56/56, typecheck + build green; **live-verify pending**)*: the site can now FIND work, not just run it.
  **`/app/run` → Discover (`DiscoverPanel.tsx`)** — pick sources (Simplify 2026 internships / LinkedIn / Handshake), an optional keyword, a "posted within N days" window and a "read up to N descriptions" cap, then one button. It sends **`AP_DISCOVER_JOBS`** to the extension with `knownKeys` (every `applications` row INCLUDING soft-deleted, plus every `queue_items` row — each contributing both its stored `job_key` and a freshly-derived one, so a legacy row can't re-surface), streams live phases over the existing run-progress port, then **auto-saves the result to the queue** (`saveDiscovered`) and lists what landed. Nothing is applied to.
  **Where the jobs come from.** The **Simplify** board publishes structured JSON (`.github/scripts/listings.json`), so it's a plain fetch with a real `date_posted` — only `active && is_visible` rows survive. **LinkedIn + Handshake** are read out of real, unfocused tabs using **the operator's own cookies** (their explicit choice — no API keys, no credential handling, and discovery never attempts a login); a source that isn't signed in says so and is skipped rather than returning a misleading zero.
  **Dedup (`lib/discover.ts`).** `discoveryJobKey` extends `canonicalJobUrl` with board ids (`linkedin:`/`handshake:`/`greenhouse:`/`lever:`/`ashby:`), Workday FIRST so a Simplify-board job keys identically to the `applications.job_key` written after applying — the invariant that makes "jobs I have not yet applied to" hold across the two tables. **LOCKSTEP with the extension's `discover.js`, and TEST-ENFORCED:** `test/discover.test.ts` cross-loads the real `discover.js` and fails if the two copies disagree. `saveDiscovered` re-derives every key **server-side** (a client-supplied key is ignored), dedupes against both tables, and leans on the partial unique index for races.
  **Storage + UI.** Migration `0010_queue_discovery.sql` adds `job_key/company/role/source/location/posted_at/job_description` to `queue_items`; `/app/queue` rows now lead with company · role, a source badge, location, freshness and a JD toggle (a pasted row is unchanged). `GET /api/extension/queue` returns the metadata too, minus the JD (up to 20k chars/row, and nothing consuming the queue needs it).
  **Known gap, stated plainly:** the LinkedIn/Handshake **list scrapers were written structure-first, NOT DOM-traced** (both need an authenticated session the build environment doesn't have). They anchor on posting-id links and degrade through selector ladders, and a **"Discover recon"** entry point (popup + `AP_DISCOVER_RECON`) dumps the real card markup so they can be tightened from observation — do that before trusting the counts.

## Design directions (under review)

Operator chose the **flight-deck** direction (dark + amber instrument panel). The set is now four
variations on that DNA — same dark cockpit palette + amber "needs-review" accent, differing in
typeface, layout, and logo. Compare at **`/designs`** (a switcher flips between them); the winner's
system propagates to the whole app.
- **Flight deck** (`/designs/flight-deck`) — the original: Space Grotesk, two-column hero with the
  live fill-status panel, heading-indicator dial logo.
- **Avionics** (`/designs/avionics`) — HUD: squared uppercase Chakra Petch, centered reticle-framed
  layout, top status strip, attitude-indicator logo.
- **Radar** (`/designs/radar`) — control tower: Sora, an animated radar-scope hero (blips = fields,
  teal verified / amber review), concentric-rings logo.
- **Cluster** (`/designs/cluster`) — dashboard: heavy Archivo, a bento grid of instrument tiles
  (accuracy gauge, counters, field readout, submit-lock), grid-cell logo.

Landing components live in `web/components/landings/` (`*Landing.tsx` + `DesignSwitcher`); routes
under `web/app/designs/`. The variants reuse the flight-deck Tailwind tokens and vary the display
font via `--font-chakra` / `--font-sora` / `--font-archivo` (added in `app/layout.tsx`). *(The earlier
light "spec-sheet" and mono "console" explorations were set aside once flight-deck was chosen.)*

## How to run (filled in as it's built)

```
cd web
cp .env.example .env.local   # then set Supabase URL + anon key + service role
npm install
npm run dev                  # http://localhost:3000
```

Extension side: load the unpacked extension (`chrome://extensions` → Load unpacked → repo root),
copy its ID, paste it on `/app/connect`, then **Sync to extension**.

### Supabase setup (one-time)
1. Create a Supabase project. Project Settings → API → copy the URL + anon key + service-role key into `web/.env.local`.
2. Run the migrations in `web/supabase/migrations/` **in order**: `0001_init.sql` (tables + RLS + private `resumes` bucket), `0002_buckets.sql` (`profiles.buckets_json`), `0003_attachments.sql` (private `attachments` bucket + RLS).
3. Auth → Providers → enable **Email** and **Google** (set the Google OAuth client + the `…/auth/callback` redirect).
4. Remove `NEXT_PUBLIC_DEV_PREVIEW` from `.env.local` to enforce real auth.

### Production deploy (when ready)
- Deploy `web/` to Vercel; set the same env vars (with `NEXT_PUBLIC_SITE_URL` = the prod origin).
- Add the prod origin to **both** the extension `manifest.json` `externally_connectable.matches` **and** `host_permissions`, then reload the extension. (Optional hardening: pin a stable extension id via a manifest `key`.)
