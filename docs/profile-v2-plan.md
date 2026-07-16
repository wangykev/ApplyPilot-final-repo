# ApplyPilot — Profile v2: editor overhaul + answer buckets (cross-platform)

> **Scope & plan document.** Two intertwined goals: (A) make profile **creation** smooth and quick
> in the website editor, and (B) introduce **answer buckets** — a platform-agnostic answer store that
> unifies `FIELD_MAP` + `answerBank` + a user-curatable question→answer mapping, and becomes the
> matching substrate as ApplyPilot expands beyond Workday (Ashby, Greenhouse, Lever, …).
>
> **Authority:** extension `CLAUDE.md` governs extension behavior; `WEBSITE.md` governs the website +
> the website↔extension contract. This doc plans changes that touch **both**, so every schema change
> is a lockstep change — keep `web/lib/profile-schema.ts`, the extension's `prepareProfile`
> (`background.js`), and the section maps (`fill-driver.js` + `background.js`) in sync.
>
> Status: **planned, not yet built.** Sign-off pending. Built incrementally, one milestone per commit,
> unit + live-verified, per the project's working principles. This plan **supersedes and absorbs** the
> `answerBank` design in `docs/profile-learning-plan.md` (the "self-completing profile" — see §B.7).

---

## North star

Two things, one initiative:

1. **Fast, low-friction profile creation.** The website editor should let a user pick from real,
   familiar choices (country dropdowns, date pickers, checkboxes) instead of hand-typing candidate
   strings — while preserving the tiered-candidate power the extension's match ladder needs.
2. **Answer buckets — the durable, cross-platform answer memory.** A *bucket* is one canonical answer
   plus the set of question-wordings that resolve to it. Editing the answer once re-fills **every
   wording, on every platform**. Buckets are what make the tool get better at every application, and
   what let us add non-Workday ATSes without re-architecting matching.

The invariants that don't move: **the profile is durable memory, the engine is stateless; every choice
fill is a candidate that must clear the match ladder against the LIVE options (no blind commit); the
human review gate is the safety; the walk never submits.**

---

# Part A — Profile editor UX overhaul (`web/`)

All items live in `web/app/app/profile/ProfileEditor.tsx` + `web/components/form/fields.tsx`, and most
change `web/lib/profile-schema.ts` (the contract). Grouped by blast radius.

## A.0 — The one hard invariant: date string formats never change

The extension's `prepareProfile` (`background.js:386`) parses stored date **strings**:
`parseYear` (`"YYYY"`), `parseYearMonth` (`"YYYY-MM"`), `parseYearMonthDay` (`"YYYY-MM-DD"`). A new
date *widget* is fine; the stored *string* must stay byte-identical per field:

| Field | Format |
|---|---|
| `education[].from_year` / `to_year` | `"YYYY"` |
| `education[].graduation_date` | `"YYYY-MM"` |
| `work_experience[].from` / `to` | `"YYYY-MM"` |
| `certifications[].issued_date` / `expiration_date` | `"YYYY-MM-DD"` |
| `screening.earliest_start_date` | `"YYYY-MM-DD"` |

If the picker emits anything else, `prepareProfile`'s parsers silently drop the date. **Non-negotiable.**

## A.1 — Website-only changes (no extension change)

| Item | Change | Notes |
|---|---|---|
| **Websites → drop `label`** | `websiteSchema` becomes `{ type, url }`. | Verified safe: extension `WEBSITE_MAP` fills **only `url`** — it never reads `label` (or even `type`). `type` stays as harmless metadata. |
| **Degree / Field of Study placeholder** | Tiered input empty-state reads *"Add a candidate if the first N options aren't on the form"*, **N = current candidate count** (adaptive). | Pure `TieredField` copy; explains the tiered-candidate concept in situ. |
| **"Field of Study" label → "Major / Field of Study"** | Display label only. | — |
| **Self-identification → dropdowns, drop "optional"** | The 5 fields (`gender`, `hispanic_or_latino`, `race_ethnicity`, `veteran_status`, `disability_status`) become `<select>`s with standard EEO option sets; remove the "optional" caption. | Extension already fills a **stated** demographic deterministically; a fixed option set only helps matching. Option lists TBD (standard US EEO). |

## A.2 — Lockstep changes (website schema **and** extension)

### Country / phone code / citizenship — pick-then-reveal-candidates
`personal_info.country`, `personal_info.country_phone_code`, `work_authorization.citizenship_country`
are **tiered arrays on purpose** — the match ladder needs per-tenant wordings.

- **UI:** a clean searchable dropdown (typeahead) of countries / dial codes. On pick, a **subtle reveal**
  shows the underlying **candidate list** (the expanded tiered array), which the user can edit/reorder.
  Simple default, power-user tunable.
- **Under the hood:** a canonical choice → known candidate list via an **expansion table**
  (e.g. US → `["United States of America", "United States"]`). This is load-bearing: a single
  `"United States"` would be **ambiguous** (contained in both "…of America" and "…Virgin Islands") →
  the match ladder escalates to `needs_review`. The expansion table is what keeps the fill deterministic.
- **Phone code:** may auto-suggest from the chosen country; Workday often auto-derives it (the
  `prefilled-kept` case), so this is largely a fallback.
- **Lockstep:** none in the engine — `resolve()` already passes a tiered array straight through as
  candidates. The change is website-side (the picker + the expansion table). Storage stays tiered.

### Languages — a real, stored "fluent" checkbox
Today `_allFluent` is **derived** by `prepareProfile` (reading ∧ speaking ∧ writing all fluent) and
**not stored**; `LANGUAGE_MAP` maps `_allFluent` → the "native"/"I am fluent" checkbox.

- **Change:** add a **stored, human-controlled** `languages[].fluent` (boolean) to `languageSchema`,
  rendered as a physical checkbox in the editor. The user may set all three proficiencies to Fluent
  **without** ticking it, or tick it independently.
- **Lockstep:** `prepareProfile` uses stored `fluent` when set; **falls back to the old
  isFluent×3 derivation only when `fluent` is null** (back-compat for existing profiles).
  `LANGUAGE_MAP` maps the resolved value to the `native` checkbox (map field already named `native`).
- **Copy:** delete the explanatory comment ("When reading, speaking, and writing are all Fluent, the
  extension checks the native box"); the checkbox is now the truth.

### Certifications — specialties sub-section
`certificationSchema` has no `specialties`, so `getSyncBundle` can't send them — but the extension
already **fills** nested specialties (`CERT_NESTED` in `fill-driver.js:2793`, records
`certification[i].specialties[j].*`).

- **Change:** add `certifications[].specialties[]` to the schema + a **nested repeating UI** (add/remove
  specialty rows within each certification).
- **Shape:** match `CERT_NESTED.fieldMap` exactly (confirm at build) — specialty name + start/end dates
  (dates follow A.0's canonical string rule).

### Minor(s) — store-only for now
`education[].minor` stays a single `str`; label → **"Minor(s)"** with help text (comma-separate
multiple).

- **Note:** the extension **does not fill minor today** (no `EDUCATION_MAP` entry). So this stores the
  data but won't fill on a form until we add a mapping (and confirm a tenant has a minor field). **Store
  now, wire later.**

### How did you hear about us — keep as a fallback list (don't delete)
- **Change:** keep `how_did_you_hear` `{ preferred[], fallback }`, but frame `preferred[]` as a
  **fallback list** in the UI with a note:
  > *"The extension fills the real source when it's known (from how the job was queued). For a manually
  > pasted link, or when no source is available, it works down this fallback list."*
- **Today:** real-source detection isn't built → always uses the fallback list (the note is true now and
  forward-compatible). Real-source-from-queue-metadata is a **future input** (see Open questions).
- **Related bug to fix regardless:** `getSyncBundle` (`web/app/app/connect/actions.ts:40`) ships
  `defaults = { how_did_you_hear }` only, and `AP_SYNC_PROFILE` overwrites the **whole** `defaults`
  key → wipes the extension's `field_of_study` / `degree` / `gpa_range` defaults. Fix the bundle to
  carry the full defaults object (or merge, not replace).

### Dates — Workday-style segmented picker
- **Change:** a small segmented date component with granularity variants (**year-only** / **month-year**
  / **month-day-year**), matching the Workday feel, replacing the free-text boxes.
- **Constraint:** emits the exact canonical strings from A.0. This is the load-bearing requirement.

---

# Part B — Answer buckets (the architecture)

## B.1 — The core model: one bucket = one canonical answer

A **bucket** is the unit of "an answer the user has given, and every way a form might ask for it." It
**subsumes** three things that exist today (see §B.7):

```jsonc
// One bucket
{
  "id": "work_auth_us",              // stable bucket identity
  "profile_path": "work_authorization.authorized_to_work_in_us", // Mode A — value lives in the profile
  "value": null,                     // Mode B — value lives HERE (standalone) when profile_path is null
  "widget_hint": "radio",            // dropdown | radio | text | checkbox | typeahead
  "sensitive": false,                // EEO/legal — drives the provenance badge + save-time warning
  "questions": [                     // the WORDINGS that resolve here — the UNIVERSAL matcher
    "are you legally authorized to work in the united states?",
    "do you have the legal right to work in the us?"
  ],
  "selectors": {                     // OPTIONAL per-platform accelerators (see B.3)
    "workday": ["legalAuthorization", "..."],
    "ashby": []
  }
}
```

**Two views of one store:** the **answer-centric** view is the clickable-label buckets UI (§B.6); the
**wording-centric** view is what the fill engine looks up (normalized question text → bucket).

## B.2 — Two value modes (both built; promotion path deferred)

- **Mode A — profile-backed** (`profile_path` set, no `value` in the bucket). The value comes from the
  profile field. Edit the field once → every wording, every platform, re-fills. Single source of truth,
  no duplication. This is the "mapped" case (name, work auth, EEO, degree, …).
- **Mode B — standalone** (`profile_path` null, `value` in the bucket). For the unbounded, tenant-
  specific long tail that has no home in the schema. First answered by AI + confirmed in review, then
  remembered here; deterministic thereafter.

**Both ship in v1.** The **B→A promotion** ("cement a standalone answer into the profile") is a
**deliberate later brainstorm** — we'll design the smoothest/easiest UX for it then. Until promoted, a
Mode-B bucket is fully functional; promotion just moves the value into a new schema field and re-points
the bucket (`value` → `profile_path`).

## B.3 — Matching hierarchy (why buckets are the substrate)

Workday is unusual in having `data-automation-id` — a stable, wording-independent field handle. Ashby,
Greenhouse, Lever mostly **don't**. The one signal present on **every** form is the **visible question
label**. So matching is **label-first**, id-as-accelerator:

1. **Platform accelerator** — if the platform exposes a stable id/key and a bucket lists it in
   `selectors`, use it (Workday's `FIELD_MAP` is exactly this, promoted into the bucket model).
2. **Exact-normalized wording** — `answerKey(label)` (lowercase, strip trailing required `*`/`**`,
   collapse whitespace) → bucket. **Exact only. No fuzzy.**
3. **AI fallback** — no bucket hit → the existing AI post-pass (guess + flag + review). A brand-new
   wording of a known question doesn't mis-fill; it goes to AI+review once, then the human adds that
   wording to the bucket so it's deterministic next time. **That's the learning loop.**

**No fuzzy/semantic tier in the deterministic path** — the AI fallback already covers every miss, so
fuzzy would only add silent-wrong-match risk for no benefit (operator decision).

## B.4 — Safety model

- **Match-ladder gate (unchanged).** A bucket value is only ever a **candidate** run through
  `matchCandidates` against the LIVE options for choice widgets — no blind commit, ever. A stale bucket
  value that no longer matches falls through to AI/blank.
- **Deterministic exact match → NOT flagged** (not in the needs-review pile), **including sensitive/EEO**
  when the value is the user's own stated/confirmed answer — it's a verbatim replay, not a guess. It
  carries a subtle **"remembered" provenance badge** (audit trail: where the answer came from), which is
  a marker, **not** a review gate.
- **Only AI-guessed answers are flagged** (`needs_review`); an EEO/legal AI guess gets the loud
  "AI-GUESSED DEMOGRAPHIC — VERIFY" badge. (Containment/fuzzy *option* matches stay `filled_review` as
  today — that's about option-match confidence, orthogonal to buckets.)
- **Sensitive warning fires once, at save/opt-in time** (when the user first chooses to remember an
  EEO/legal answer), not on every fill.
- **Essays excluded.** `textarea` never goes in a bucket — job/company-specific, answered fresh by AI-2.
  `file_upload` excluded (résumé, IndexedDB).
- **Never-submit gate** remains the backstop for everything.
- **Residual risk = staleness** (circumstances changed since save). v1 mitigation: the provenance badge.
  Later: an optional periodic "re-confirm demographics" prompt.

## B.5 — Storage & sync

- **Buckets are profile-owned** → Supabase (a `buckets` table or a `buckets_json` column on `profiles`;
  decide at build). Synced to the extension alongside the profile as an **expanded lookup**
  (`normalized-wording → { source, value|profile_path, widget_hint, sensitive }`).
- **Editing the answer once** updates the fill for all its wordings because they all resolve to one
  value (Mode A: the profile field; Mode B: the bucket's `value`).
- **Extension consumption:** the SW loads buckets from `chrome.storage.local` and hands them to
  `drivePageFill` (mirrors how `profile`/`answerBank` already flow — engine computes, SW does I/O).

## B.6 — The clickable-label UI

- A **top-of-page note**: *"Click any field label to see the questions that map to it."*
- Each fillable label gets a **subtle** affordance (e.g. dotted underline / a small chip on hover).
  Clicking opens a **side drawer** for that field: its question-wordings with add/remove, its value
  (Mode A shows/edits the profile field; Mode B shows the standalone value), and the sensitive marker.
- A place for **standalone (Mode B) buckets** that aren't tied to a profile field (an "Other questions"
  / answer-bank section).
- **First build ships empty, populatable buckets** — every profile field is already a bucket (its
  wordings + its value); the user curates wordings over time. Extension consume-wiring is a follow-up
  milestone.

## B.7 — Relationship to `answerBank` / `profile-learning-plan.md` (don't fork)

The `answerBank` (built, **unmerged**, in the `profile-learning-plan` worktree) is
`{ normalized-question-text → { value, widgetType, sensitive, savedAt } }` — i.e. **a bucket with a
single wording and Mode-B value**. Buckets are its generalization (one answer → many wordings; plus
Mode A). **Do not build a second, parallel store** — that risks two systems disagreeing at fill time.
Reconcile: the bucket store **is** the answerBank's data model; the unmerged branch's fill-time consume
tier (`fillFromRemembered`, match-ladder-gated, sits before the AI pass) is the right consume behavior —
port it onto the bucket lookup. Merge concepts before merging code.

---

## Milestones (one focused change, one commit, unit + live-verified)

> Part A and Part B are independent enough to interleave; A ships user-visible wins fast, B is the deeper
> architecture. Suggested order:

| # | Milestone | Files |
|---|---|---|
| **A1** | Websites drop `label`; Degree/FoS adaptive placeholder; FoS→"Major / Field of Study"; self-id dropdowns + drop "optional" | `profile-schema.ts`, `ProfileEditor.tsx`, `fields.tsx` |
| **A2** | Country/phone/citizenship pick-then-reveal picker + canonical→candidates expansion table | `fields.tsx`, `ProfileEditor.tsx`, a new `lib/countries.ts` |
| **A3** | Workday-style segmented date picker (year / month-year / month-day-year), canonical-string output | `fields.tsx` + all date sites |
| **A4** | Languages stored `fluent` checkbox (+ `prepareProfile` fallback, `LANGUAGE_MAP` lockstep) | `profile-schema.ts`, `ProfileEditor.tsx`, `background.js`, `fill-driver.js` |
| **A5** | Certifications specialties sub-section (schema + nested UI, matches `CERT_NESTED`) | `profile-schema.ts`, `ProfileEditor.tsx` |
| **A6** | How-did-you-hear fallback framing + note; fix the `defaults` clobber in `getSyncBundle` | `ProfileEditor.tsx`, `connect/actions.ts`, `background.js` |
| **A7** | Minor(s) label + help (store-only) | `profile-schema.ts`, `ProfileEditor.tsx` |
| **B1** | Bucket data model + storage (Supabase shape; sync payload; extension load) — reconcile with `answerBank` | `profile-schema.ts`/migration, `connect/actions.ts`, `background.js`, `lib.js` |
| **B2** | Clickable-label buckets UI (empty, populatable): top note, label affordance, drawer, Mode-A/B display | `ProfileEditor.tsx`, new components |
| **B3** | Extension consume-wiring: label-first matching (accelerator → exact wording → AI), match-ladder-gated, "remembered" provenance badge | `fill-driver.js`, `background.js`, `summary.js` |
| *later* | B→A promotion UX; real-source detection; per-platform selectors (Ashby/Greenhouse); fuzzy/semantic tier (only if needed); EEO re-confirm | — |

---

## Open questions / deferred (to brainstorm)

- **B→A promotion UX** — the smoothest way for a user to cement a standalone (Mode-B) bucket into the
  profile as a real field. Design later; both modes work independently until then.
- **Real-source detection** for how-did-you-hear — deriving the actual source from queue/link metadata,
  so the fallback list is genuinely a *fallback*.
- **Per-platform selector schemas** — what stable handles Ashby / Greenhouse / Lever expose (if any),
  to populate `bucket.selectors` as accelerators. Recon each ATS before relying on it (project rule:
  trace the real DOM first).
- **Fuzzy/semantic wording tier** — only if exact-match misses + AI-fallback cost prove painful. Kept
  out of v1 deliberately.
- **EEO staleness** — an optional periodic "re-confirm remembered demographics" prompt.
- **Self-id + country option lists** — confirm the canonical option sets (standard US EEO; ISO country
  list + dial codes).
