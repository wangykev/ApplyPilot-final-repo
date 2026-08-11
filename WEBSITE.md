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
| *(no message)* — the extension POSTs | **AI usage ingest** → `POST /api/extension/usage`, Bearer `ingestKey` | batched `llm_calls` rows; the fill is the highest-volume model caller and the SW has no DB |
| `AP_CLEAR_RESUME` | remove the stored resume (inverse of `AP_SYNC_RESUME`) | IndexedDB `deleteResume()` — idempotent |
| `AP_DISCOVER_JOBS` | **sweep the job boards** (the `/app/run` Discover button) — reads only, writes NOTHING | returns `{ ok, jobs[], stats, notes[] }`; the WEBSITE persists them via `saveDiscovered` |
| `AP_DISCOVER_RECON` | read-only DOM dump of the LinkedIn/Handshake search pages, for tightening the list scrapers | returns `{ ok, recon }` — queues nothing |

> **The two ACTUATING messages** (everything else above only PERSISTS a handoff): **`AP_RUN_APPLICATION`**
> (the Run button — fill to the review page, never submits) and **`AP_SUBMIT_APPLICATION`** (the Submit
> button — replay the APPROVED bundle → review-page equality → the submit gate → submit once). The latter
> takes `{ startUrl, arm }`: **without `arm:true` it is a full DRY rehearsal** (identical code path, logs
> "would submit", never clicks), and the site only sends `arm:true` from the second click of a two-step
> confirm. Both return the `login` they signed in as (below).

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
`{ company, role, url, job_key, status, needs_review_count, captured_at, review_bundle, login }`. A Next.js
route validates the per-user ingest key (an `api_keys` row) and upserts-by-`job_key` an `applications` row.
**A report never NULLS a column it wasn't given** (`lib/report-fields.ts`, PURE + unit-tested): `company` / `role` / `url` / `job_key` / `applied_at` are OMITTED from the write when absent, so an UPDATE can't erase them. `reportApplication` sends `role: null` on every report (the extension doesn't know the job title) and a null `company` when the run has no jobContext — which wiped the tracker row's company + role after a Rehearse run (the FILL path only survived because `saveRunJob` rewrites them afterwards from the scraped JD). The report's OWN payload — status / needs_review_count / review_bundle_json — is always written. `login` = `{ email, tenant, host, created, verified, at }`, the account that run actually signed in as →
the `login_*` columns (migration `0011`). It is MATCH-GATED extension-side (see CLAUDE.md → Onboarding), and
an absent/emailless `login` leaves any previously-recorded account untouched — never blanked.
Per-user API key avoids extension-side OAuth token refresh. **Both** the single-page CDP fill
(`runCdpFillPage`) and the multi-page walk (`runCdpWalk`, on every exit) push the accumulated
review bundle, so the website always has the latest to review.

#### 2a. A REJECTED report SELF-HEALS — never lose a completed run (2026-08-11)

`getSession` ROTATES the reporting key (it deletes the user's `api_keys` row and mints a new one), so any
re-link — another browser, a second "Sync everything" — leaves the extension holding a credential the
server no longer knows. Every completed fill then 401s. That used to be **silent data loss**: minutes of
filling, a good bundle, and the only trace was a service-worker line plus an `apReportError` marker that
**nothing ever read**. The user's natural check made it worse — `/app/connect` shows a green "connected"
badge off a plain `AP_PING`, which succeeds regardless of whether the key works.

The contract now:

- **The extension PARKS the payload** on a rejected report (`apPendingReport`, ONE slot — a repair path,
  not an outbox) alongside `apReportError`. A successful report clears both.
- **`AP_REPORT_HEALTH`** (external message) answers the question `AP_PING` cannot: `{ healthy, connected,
  reason, hasPending, pendingCompany }`. Read-only, and returns **no key and no bundle** — only the shape
  of the problem, so the site can REPAIR it rather than describe it.
- **`AP_SET_SESSION` flushes the parked report** (`flushPendingReport`) and returns `{ ok, recovered }`.
  A fresh credential is the one event that can fix the failure, so the retry rides it. `recovered:true`
  means the APPLICATION reached the tracker — not merely that a key was stored.
- **`ReportHealthGuard`** (mounted on `/app/tracker`) checks health on load and, on a real rejection with
  something parked, heals silently: `getSession` → `AP_SET_SESSION` → `router.refresh()`. The user sees
  their application appear plus one quiet line; they are never shown "401" or "stale key".

⚠ **Two guards, both load-bearing, both unit-pinned** (`test/report-recovery.test.js`):
1. The guard heals with the **TRACKING-ONLY** link. It must NEVER call `AP_SYNC_PROFILE` /
   `AP_SYNC_RESUME` / `AP_SET_CREDENTIALS` — silently overwriting the user's profile and résumé to fix a
   reporting key would be far worse than the bug being fixed.
2. Healing **rotates the key**, so it must never run speculatively: only on an actual rejection, at most
   once per mount, and `flushPendingReport` must clear `apReportError` **and** `apPendingReport` together.
   Leaving the error marker set would re-heal on every visit — a rotation loop, and two open tabs would
   rotate each other's keys forever.

**Live-verified 2026-08-11** (cat.wd5 `R0000386422`): a complete 5-page fill 401'd and was parked
(`hasPending:true, pendingCompany:"Cat"`); opening the tracker took the list 9 → 10 with the run restored
and health flipped to `healthy:true`, with zero user action; a revisit healed nothing and showed nothing.

### 3. Backend → Extension (PULL the approved review bundle) — the review round-trip

The website is the **review surface** (edit + approve — see the review-editor section). Before a
replay/submit, the SW **pulls** the human-approved bundle from `{reviewUrl}`
(`GET /api/extension/review?job_key=…` — or the legacy `?url=` — with `Bearer {ingestKey}`) and writes it
into `chrome.storage.local.reviewSummary` — the exact slot `runCdpReplayWalk` reads. **`job_key` is
mandatory for a SUBMIT run:** with only `?url=` (or neither) the route falls back to *the most-recently-
updated application that has a bundle*, so a submit for job B could replay job A's approved answers into
B's form and submit it. When `job_key` is given the route NEVER widens (no match ⇒ `bundle:null`) and the
caller refuses. `pullApprovedBundle`
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
- `websites[]` — `{type, url}` (`label` was dropped — the extension only fills url). The editor pins **3 fixed rows** (LinkedIn / GitHub / Personal Website, **type locked**); added rows carry a custom type. **`url` is stored as the FULL CANONICAL link — scheme AND `www.`** (`ensureHttpsUrl`, lockstep with the extension's `ensureHttps`): `linkedin.com/in/you` → `https://www.linkedin.com/in/you`. Required because the form canonicalizes to the www host, and a bare-host value then fails every equality tier (exact / containment / fuzzy-89-vs-90) → an M40 audit flag and a **blocked submit**. `www.` goes on a bare APEX host only (2 labels, or 3 ending in `co.uk`-style suffixes) — an existing subdomain, an IP, or userinfo is left untouched, since `www.blog.example.com` usually doesn't resolve. Idempotent; applied on parse + editor blur, so stored profiles self-heal on their next save.
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
**The website's AI page is the SOLE editor of this object.** It is pushed via `AP_SET_LLM` and stored
**wholesale, never merged** — the whole thing (default pair, key lists, routes, chains) is edited as one
unit, and a partial merge could leave the extension holding a route naming a provider whose keys were just
removed. The extension **popup shows it read-only**: its Save used to write the flat v1 shape over the whole
object, silently destroying `keys`/`routes`/`fallbacks`. `AP_SET_LLM` also records the sending origin as
`webOrigin`, so the popup can link to the AI page without the extension hardcoding a site URL.

```
{ provider, model, apiKey, enabled,             // v1 fields — still present, see below
  preferFreeFirst: bool,                        // spend free-tier keys before paid ones
  keys:      { [provider]: [{ id, label, key, tier: "free"|"paid", enabled }] },
  fallbacks: [{ provider, model }],             // default chain
  routes:    { [action]: { provider, model, fallbacks: [{provider,model}] } } }
```

`action` ∈ `fill` | `essay` | `resume_parse` | `cover_letter` (`LLM_ACTIONS`, `llm-keys.js`); an unset action
follows the default pair. **`fill` vs `essay` is the distinction that matters to an operator** — dozens of short
screening answers per application (cheap, fast) versus a paragraph or two of prose (worth a stronger model);
`aiFillText` in fill-driver.js is the essay call site, every other `act.llm` defaults to `fill`.
`teach` is NOT a row: `LLM_ACTION_ALIASES` maps it to `fill`, so it rides fill's route and fallback chain —
same kind of judgement, so a separate model would be a knob with no decision behind it. An alias resolves
BEFORE the route lookup, so it picks up fill's override rather than the global default. Model lists from `LLM_MODELS` (`llm.js`); default `gemini-3.1-flash-lite`.

**v1 compatibility is load-bearing in both directions.** Reading: a stored v1 config has no `keys`, and
`llmKeysFor` treats the flat `apiKey` as a single key for the flat provider — an untouched account needs no
migration. Writing: `withLegacyMirror` keeps `apiKey` pointing at whichever key rotation would try first, so
an extension build older than this change still finds a key where it expects one; dropping the field would
silently turn AI fill off on the next sync.

**Free tier is Gemini-only, and membership is enforced rather than cosmetic:** `GEMINI_FREE_TIER` (`llm.js`)
holds per-model `rpm`/`tpm`/`rpd`, and a model absent from it (e.g. `gemini-2.5-pro`) cannot be reached by a
free key at all — so when every Gemini key is marked free, the AI page narrows the model picker to that
table. Per-model daily limits are also why a fallback chain wants a second MODEL, not just a second key.

**Lockstep pairs — drift is a test failure** (`web/test/llm-keys.test.ts` cross-loads the real `.js`):
`llm-keys.js` ↔ `web/lib/llm-keys.ts` (key order, failure classification, route resolution) and `llm.js` ↔
`web/lib/llm.ts` (`callLLM` never-throws contract, `LLM_MODELS`, `GEMINI_FREE_TIER`, `LLM_PRICING`). Key
failure state (cooldowns, rejections) is deliberately **not** in `llmConfig` — that is config the website
owns, so a cooldown stored there would be wiped by the next sync; it lives in memory per runtime
(`cdpLlmKeyState` in the extension, per-request on the server).

**One intentional asymmetry:** `llm.js` keeps its wait-ladder + circuit breaker; the TS port has neither. A
server action that sat out a 75s retry would hang the page the operator is looking at, so server-side the
answer to a spent key is rotation, while a background fill can additionally afford to wait.
`web/lib/llm.ts` exposes `callLLMForAction(config, action, prompt)` — the entry point every server caller
uses (`parse-resume`, `cover-letter`, `teach`).

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
- `applications` — `id, user_id, company, role, url, job_key, status('queued'|'filling'|'needs_review'|'submitted'|'interviewing'|'offer'|'rejected'), needs_review_count, review_bundle_json?, job_description?, applied_at, deleted_at?, …` **+ the LOGIN this application was filed with** (migration `0011`): `login_email, login_tenant, login_host, login_created` (the account was CREATED that run), `login_verified` (the email round-trip completed), `login_at`. Workday accounts are per-tenant, so this is what tells you how to sign back in when a recruiter replies — and after a create-account run it's the only record the account exists. The PASSWORD is deliberately NOT duplicated here; it lives once on `profiles.credentials_json`. `status:'submitted'` is written ONLY by the site's own `saveRunSubmit` (the extension never reports it — the human authorizes a submit).
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

Moved to **`docs/website-progress-log.md`** (2026-08-09) — 28KB of build history that no longer needs to
load with this design doc. **Append new website milestone entries there**, same style (what / why /
how-verified), one commit each so the project stays bisectable.

This file keeps the standing design + contracts; `docs/status.md` keeps the open work.

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
2. Run **`web/supabase/main.sql`** — every migration concatenated in order, and safe to run more than once. It sets up a fresh project AND brings an existing one up to date: no `drop table`, `delete` or `truncate` appears in it, policies/triggers are drop+create, columns are `add ... if not exists`, and constraints drop-if-exists before being added. The numbered files in `web/supabase/migrations/` remain the source of truth; after adding one, append it to `main.sql` too.
3. Auth → Providers → enable **Email** and **Google** (set the Google OAuth client + the `…/auth/callback` redirect).
4. Remove `NEXT_PUBLIC_DEV_PREVIEW` from `.env.local` to enforce real auth.

### Production deploy (when ready)
- Deploy `web/` to Vercel; set the same env vars (with `NEXT_PUBLIC_SITE_URL` = the prod origin).
- Add the prod origin to **both** the extension `manifest.json` `externally_connectable.matches` **and** `host_permissions`, then reload the extension. (Optional hardening: pin a stable extension id via a manifest `key`.)
