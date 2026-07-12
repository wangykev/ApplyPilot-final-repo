# ApplyPilot — Profile Learning (self-completing profile)

> **Scope & plan document.** The whole point of this initiative: the extension should get
> *better at every application*. Each answer a human confirms in review becomes part of a
> growing profile, so the next application to a similar question fills itself. Over time the
> human reviews less and less. This doc is the north star + the build plan; it supersedes the
> ad-hoc "add unmapped things to profile" sketch in `summary.js:446` (the FUTURE FILL-BACK
> CONTRACT comment).

Status: **planned, not yet built.** Sign-off pending. Built incrementally, one milestone per
commit, unit + live-verified (recon-first), per the project's working principles.

---

## 1. North star

The **profile is durable memory; the fill engine is stateless.** The engine always reads the
profile from `chrome.storage.local` and returns results — it never learns on its own. Learning
happens at the **review gate**: when a human approves an answer, that answer is written back into
the profile-shaped memory, so a future application auto-fills it.

The end state: a first application to a new tenant surfaces many review items; the tenth surfaces
almost none, because the profile has accumulated the user's real answers to the questions that
recur across Workday tenants (work authorization, EEO, screening yes/nos, standard picks).

## 2. Core principle — remember everything except essays and resumes

Every field type a human confirms is persisted back into memory:

- **short text, dropdown, radio, typeahead, checkbox** → remembered.

Two exceptions, by *nature*, not by exclusion:

- **Essays / long free-text** (`textarea`): role- and company-specific (cover-letter-shaped);
  reusing verbatim on a different job would be wrong. Answered fresh each time by the LLM (AI-2).
  **Not remembered.**
- **Resumes / file uploads**: binary files, not profile-shaped. Stored in IndexedDB (`db.js`)
  and AI-tailored per application (Phase 2+). **Not in the profile.**

> The essay exclusion maps cleanly to a widget check (`textarea` excluded; single-line `text`
> remembered). The resume exclusion maps to `file_upload` (its own store). Deferred nuance:
> *some* essays are genuinely reusable ("describe a time you led a team") — an opt-in
> essay-remember could be revisited later, but v1 leaves all essays ephemeral.

## 3. The memory model — one logical store, two physical (promotable)

| Store | Holds | Keyed by | Owner / lifecycle |
|---|---|---|---|
| **`profile`** (`chrome.storage.local`) | mapped/known fields | canonical dotted path (`FIELD_MAP`) | the website→extension handoff contract |
| **`answerBank`** (`chrome.storage.local`) | the unmapped long tail | normalized question text (`answerKey(label)`) | extension-owned; **promotable into `profile`** |
| **IndexedDB `resume`** (`db.js`) | résumé bytes | fixed key `resume:default` | existing |
| *(essays)* | — | — | ephemeral; never stored |

Conceptually **`profile ∪ answerBank` = "everything the user has ever answered."** The split is
an implementation detail:

- **Known, recurring fields** get a real `FIELD_MAP` entry + a canonical profile path — you
  define the path once (this is where checkboxes with stable ids also live, e.g.
  `personal_info.has_preferred_name`, the `agreements.*` family).
- **The long tail** — arbitrary tenant-specific questions you can't pre-map — goes to
  `answerBank`, keyed by the question text.

**`answerBank` shape** (flat, so promotion is a straight copy):

```jsonc
{
  "are you legally authorized to work in the united states?": {
    "value": "Yes",                 // the confirmed answer (string, or boolean-as-"true"/"false" for checkboxes)
    "questionText": "Are you legally authorized to work in the United States?*", // verbatim, for display/audit
    "widgetType": "radio",          // dropdown|radio|typeahead|text|checkbox
    "sensitive": false,             // legallyLoaded/isEeoField on the label at save time
    "savedAt": 0                    // stamped by the SW (script can't call Date.now())
  }
}
```

**`answerKey(label)`** (new, in `lib.js`, unit-pinned): lowercase → strip trailing required
markers (`*`/`**`) → collapse whitespace. Tenant-agnostic, so a work-authorization answer
applies across *any* Workday tenant. Exact match only in v1 (a miss falls through to today's
AI/deterministic path — safe). Fuzzy/LLM keying is a deferred enhancement if misses prove common.

## 4. Field-type matrix (fill × remember)

| Widget | How it FILLS | Remembered? | Where |
|---|---|---|---|
| text (short) | profile path, else `answerBank` → value | **yes** | mapped path / bank |
| textarea (essay) | AI-2 fresh each time | **no** | — |
| dropdown | profile/bank candidate → **match ladder** | **yes** | mapped path / bank |
| radio | profile/bank candidate → **match ladder** | **yes** | mapped path / bank |
| typeahead / tree | profile/bank candidate → **match ladder** | **yes** | mapped path / bank |
| checkbox | required → **always check**; non-required → mapped/remembered boolean, else leave default | **yes** (boolean) | mapped path / bank |
| file_upload (resume) | IndexedDB attach (`attachResume`) | **no** | own store |

Every choice-widget fill — including a remembered value — is only ever a **candidate that must
clear the existing match ladder** against the *live* options. No live match → no commit; fall
through to AI/blank. This preserves the accuracy contract: a remembered value can never blind-fill
a wrong option (tenant option sets differ).

## 5. The three flows

1. **FILL** — `profile` + `answerBank` → the form. Existing fill engine, plus a new
   *bank-consult tier* for unmapped fields (§6).
2. **REVIEW** — the human edits/approves in `summary.html` (`reviewSummary` bundle).
3. **REMEMBER** — on approval, with the per-field **"Remember this answer"** opt-in (default OFF),
   the confirmed value is written back: mapped field → `profile.<canonical_field>`; unmapped →
   `answerBank`; checkbox → boolean either place.

## 6. Consume tier — how a remembered answer re-fills

In `drivePageFill` (`fill-driver.js`), for a field that produced nothing deterministically and is
**unmapped**:

1. look up `answerBank[answerKey(label)]`;
2. on a hit, run the stored value as a **candidate through the existing match ladder** vs the live
   options;
3. commit only on a match — **trusted** (unflagged, not in Needs Review) + a visible **"remembered"**
   provenance badge in the All-Fields list;
4. no match → fall through to the AI post-pass / blank exactly as today.

The bank-consult sits **before** the AI post-pass — a human-confirmed memory should beat a fresh
AI guess. The bank is read **SW-side** (`background.js` loads it alongside `profile`/`jobContext`
at the handoff point and passes it into the driver), so the driver stays Node-testable with a fake
bank — mirroring how `profile` already flows.

**Checkboxes:** required → always check (unchanged); non-required → apply the mapped/remembered
boolean if present, else leave the page default.

## 7. Safety model

- **Match-ladder gate** — every remembered value is a candidate that must match a live option; no
  blind commit. The one failure this whole project guards against (silently committing a wrong
  value to an accuracy/truthfulness tool) stays guarded.
- **Save is opt-in per field, default OFF** — no one-off answer or AI guess silently becomes
  permanent.
- **Sensitive answers** (EEO/legal, detected by `legallyLoaded`/`isEeoField` on the question
  label) → a **warning at save time**. At *fill* time they're trusted/unflagged — because an exact
  question-text match means we're replaying the human's *own verbatim prior answer*, not inferring
  one — with the visible "remembered" badge as the audit trail. Residual risk is *staleness*
  (circumstances changed since save); the badge is the mitigation.
- **Checkboxes + consent** — required-always-check means a consent/certification box is ticked to
  advance regardless of memory; the **walk never submits** (human-gated at the review page), so a
  ticked box mid-walk is not a submission. No silent auto-agreement is introduced.
- **`data/profile.json` (gitignored) is never touched** — learning writes the *runtime*
  `chrome.storage.local` `profile`/`answerBank`, never the seed file.

## 8. Prerequisite fork — checkbox rule refactor (lands first)

The remember-checkboxes model builds on a simplified checkbox fill rule. This small refactor is a
fork in the road we clear before the main work.

| Case | Action |
|---|---|
| **Required** (any mapping/value) | **always check** |
| Not required, mapped, has value | reconcile to the value (true→check / false→uncheck) |
| Not required, mapped, empty | leave default |
| Not required, not mapped **and not remembered** | leave default |
| Not required, not mapped **but remembered** | apply the remembered boolean *(added by §6)* |

Code: delete the `refused` branch in `fill-driver.js:2268-2289` (`if (f.isRequired && !refused)`
→ `if (f.isRequired)`); the standalone-checkbox path in `background.js` (page engine) changes in
**lockstep**. Repeating-section checkboxes (`currentlyWorkHere`, "I am fluent") keep their existing
per-entry mapped-boolean handling. **The onboarding account-creation consent checkbox is
untouched** — it runs through its own path (`checkConsent` → `cdpConsentRect`, `background.js:2918`)
on the pre-form auth screen, force-checked regardless of required/mapped, and never reaches
`drivePageFill`.

**Consequence (accepted):** removing `refused` means an explicit profile `false` no longer keeps a
*required* checkbox unchecked — there's no "refuse and don't submit" opt-out via the checkbox path.
The real gate remains that the walk never submits.

## 9. Storage & promotion path

`answerBank` lives in `chrome.storage.local` now — decoupled from the still-in-flux
website→profile write path, so a wholesale profile write can't clobber it. When cloud sync lands
(ApplyPilot Web / Supabase), the flat keyed shape makes promotion a straight copy: the website
reads `answerBank` and folds it into the user's profile record. Nothing in the fill path assumes
the bank stays local.

## 10. Management

- **Review page** — untick "Remember" to forget an entry.
- **Popup** — a raw list of saved answers + delete.
- **Deferred** — a dedicated manager page (browse/edit values/per-tenant scoping).

## 11. Milestones (one focused change, one commit, unit + live-verified)

| # | Milestone | Files |
|---|---|---|
| **M0** | Checkbox rule refactor (the fork) | `fill-driver.js` + `background.js` (lockstep) + units |
| **M1** | `answerBank` store + `answerKey()` + read/write helpers | `lib.js` + `background.js` + units |
| **M2** | Save UI: per-field "Remember" toggle (eligible types) + sensitive warning + forget; mapped write-back to `profile.<path>` | `summary.js` |
| **M3** | Consume tier: SW passes the bank in; `drivePageFill` bank-lookup → match ladder → trusted fill + provenance | `background.js` + `fill-driver.js` + units (fake bank) |
| **M4** | Checkbox remember + consume (extends M0's last branch) | `fill-driver.js` + `summary.js` |
| **M5** | Popup manager (minimal): list + delete | `popup.html` / `popup.js` |
| *later* | promotion to profile/cloud; full manager page; essay-reuse reconsideration | — |

## 12. Relationship to the broader pipeline

- **Onboarding walk** — separate orchestrator (JD → apply → login → verify); **unaffected**.
- **Fill walk** — gains the bank-consult tier and the checkbox refactor.
- **Submit / strict replay** (future, Plan 1) — consumes the human-approved `effectiveValue`s;
  orthogonal to learning, but benefits from a more-complete profile meaning fewer review items.
- **ApplyPilot Web** (future) — eventual owner of `profile` and the sync target for `answerBank`.

## 13. Open / deferred questions

- **Wording drift** on the exact-match key — add a fuzzy or LLM-concept keying tier only if misses
  prove common (overlaps the deferred "LLM semantic field-match tier").
- **Reusable essays** — revisit an opt-in essay-remember for genuinely portable prompts.
- **Cross-tenant vs per-tenant** — default cross-tenant (the value); add a per-tenant override if a
  remembered answer proves tenant-specific.
- **Sensitive staleness** — the badge is the v1 mitigation; a periodic "re-confirm remembered
  demographics" prompt could be added later.
