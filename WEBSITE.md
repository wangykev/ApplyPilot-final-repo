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
| `AP_SYNC_PROFILE` | write the handoff bundle | `chrome.storage.local` ← `profile`, `defaults`, `jobContext` (RAW fields only) |
| `AP_SYNC_RESUME` | store the resume | IndexedDB via `saveResume({filename,mime,size,base64,savedAt})` |
| `AP_SET_SESSION` | reporting credential | `chrome.storage.local` ← `{ ingestUrl, ingestKey }` |
| `AP_SET_LLM` *(optional)* | mirror AI config | `chrome.storage.local` ← `llmConfig` |

- **Extension ID:** v1 = the user pastes their extension ID (from `chrome://extensions`) once on the
  Connect page; the website stores it and targets `chrome.runtime.sendMessage(id, …)`. The page must
  be on an origin listed in `externally_connectable.matches`. Hardening (P6): pin a stable ID via a
  manifest `key`.

### 2. Extension → Backend (report application status) — P2 (credential plumbed in v1)

After a fill/walk, the SW POSTs to `{ingestUrl}` with `Bearer {ingestKey}`:
`{ company, role, url, status, needs_review_count, captured_at }`. A Next.js route validates the
per-user ingest key (an `api_keys` row) and inserts an `applications` row. Per-user API key avoids
extension-side OAuth token refresh.

---

## Data contracts (sourced from the extension — keep in lockstep)

### Profile — **store RAW only** (schema v2.0)
The extension's `prepareProfile` (`background.js`) DERIVES `*Parsed` (dates), `bulletsText`,
`_allFluent`, and the filtered/sorted order at fill time. The website stores **only raw user
fields** — never the derived ones. Reference: `data/profile.example.json`.

- `personal_info` — names, address, email, phone, `country`*, `country_phone_code`* (*=tiered array).
- `websites[]` — `{type, label, url}` (url gets `https://` prepended by the extension).
- `education[]` — `{school_or_university, degree*, field_of_study*, minor, gpa, gpa_scale, from_year("YYYY"), to_year("YYYY"), graduation_date("YYYY-MM"), currently_enrolled, …}`.
- `work_experience[]` — `{job_title, company, location, currently_work_here, from("YYYY-MM"), to("YYYY-MM"), bullets[], tech_stack[]}`.
- `projects[]`, `languages[]` `{language, reading, speaking, writing}`, `certifications[]` `{certification*, certification_number, issued_date("YYYY-MM-DD"), expiration_date}`.
- `skills[]`, `work_authorization`, `story_bank[]`, `essay_drafts{}`, `application_questions{}`, `self_identification`, `agreements`.
- `how_did_you_hear` `{preferred[], fallback}` (profile WINS over `defaults`).
- `employment_history_companies[]` — **maintained by hand**, NOT derived from `work_experience`
  (safety-critical for the "previously worked here?" auto-No). `[]`=unfilled (flags review),
  `["none"]`=never employed.

\* **Tiered arrays** (most-specific first) account for tenant-specific dropdown text. The editor
offers a candidates multi-input for: `personal_info.country`, `personal_info.country_phone_code`,
`education[].degree`, `education[].field_of_study`, `certifications[].certification`.

### Defaults — `data/application_defaults.json`
`{ how_did_you_hear, field_of_study, degree, gpa_range }`, each `{ preferred[], fallback }`.

### jobContext — `{ company }` (per-application).

### AI config — `llmConfig` shape (extension `chrome.storage.local.llmConfig`)
`{ provider: "anthropic"|"gemini"|"openai", model, apiKey, enabled }`. Model lists from `LLM_MODELS`
(`llm.js`); default `gemini-3.1-flash-lite`. `web/lib/llm.ts` is a TS port of `callLLM` (never-throws
contract) — single source for resume parsing + AI-config parity.

### Resume — IndexedDB `ApplyPilot`/`resume`/`resume:default`
`{ key, filename, mime, size, base64, savedAt }` (raw base64, not a data: URL). Base64 string crosses
the messaging boundary; the extension's `saveResume` (`db.js`) writes it.

### reviewSummary — for hosted summaries (P3)
Envelope `{ schema_version, page, url, tenant, captured_at, total, counts, by_type,
needs_review_count, entries[] }`; per-entry `{ field_id, question_label, widget_type,
canonical_field, is_required, current_value, original_ai_value, is_edited, edit_kind, confidence,
confidence_source, needs_review, needs_review_reason, fill_status, options, captured_options,
match_tier, flag, … }`. Port `summary.js` viewer/editor to React over this schema.

---

## Database model (Supabase Postgres, RLS keyed to `auth.uid()`)

- `profiles` — one row/user: `profile_json`, `defaults_json`, `job_context_json`, `ai_config` (provider/model/key/enabled), `updated_at`.
- `resumes` — `id, user_id, kind('default'|'variant'), job_id?, filename, mime, size, storage_path, created_at`.
- `applications` — `id, user_id, company, role, url, status('queued'|'filling'|'needs_review'|'submitted'|'interviewing'|'offer'|'rejected'), needs_review_count, review_bundle_json?, applied_at, …`.
- `queue_items` — `id, user_id, url, status, position, created_at`.
- `reminders` — `id, application_id, due_at, note`.
- `api_keys` — `id, user_id, key_hash, label, last_used_at` (the extension ingest credential).

---

## Roadmap (phased — architected now, built per phase)

- **v1 (in progress)** — auth · resume upload + AI parse · profile editor · job context · AI config · **extension auto-sync**. The core "upload your resume and feed the extension" loop.
- **P2** — Tracker + Queue: applications dashboard (status lights), pasted-URL queue, extension→backend report POST, queue pull endpoint.
- **P3** — Hosted review summaries: React port of `summary.js` over the `reviewSummary` schema; extension pushes the bundle; edits write back.
- **P4** — Analytics dashboard + pipeline stages + reminders.
- **P5** — AI-tailored resume variants + cover letter generation.
- **P6** — Auto-discover jobs (board integrations) + production hardening (pinned extension ID via manifest `key`, encrypted keys, deploy).

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
2. Run `web/supabase/migrations/0001_init.sql` in the SQL editor (creates tables + RLS + the private `resumes` bucket).
3. Auth → Providers → enable **Email** and **Google** (set the Google OAuth client + the `…/auth/callback` redirect).
4. Remove `NEXT_PUBLIC_DEV_PREVIEW` from `.env.local` to enforce real auth.

### Production deploy (when ready)
- Deploy `web/` to Vercel; set the same env vars (with `NEXT_PUBLIC_SITE_URL` = the prod origin).
- Add the prod origin to **both** the extension `manifest.json` `externally_connectable.matches` **and** `host_permissions`, then reload the extension. (Optional hardening: pin a stable extension id via a manifest `key`.)
