# Current state & open items

Live working state. **Full milestone-by-milestone history: `docs/progress-log.md`** — append new milestone
entries there (one focused change, verified on a real page, one commit each, so we can bisect).

As of 2026-07-02 the CDP path is the primary, live-verified fill: full-page fold, N-page walk machinery,
résumé attach, AI-0/1/4, inline + tree AI rescues, nested cert specialties, review-summary source-of-truth,
Plan 2 approve/merge. Unit suite green (`npm test`, `node:test` — ~450 tests as of 2026-07-02; 862 on the
discover branch).

---

## Active

### NEXT (0) — iCIMS: LIVE-VERIFIED through the address block; next is Education (operator 2026-08-16)

**Steps 1 and 2 are LIVE-VERIFIED** on `astrioncareers-astrion.icims.com/jobs/24615`, build `icims-addr-1`:

- the frame arms — `the application is inside an iframe — driving it there (112 controls)`;
- the "Create a login" trio reports `filled` with `after="(stored login)"` / `"(stored password)"` —
  never a real value;
- the address block fills deterministically: Street1 `"715 Middlebrooks Circle"`, City `"Tallahassee"`,
  Zip `"32312"`, **Country `filled · exact-normalized · "United States"`**, **State `filled ·
  exact-normalized · "Florida"`** — all unflagged, no AI.
- page totals went `filled 12 / filled_review 9 / needs_review 9` → **`filled 21 / filled_review 8 /
  needs_review 1`**.

⚠ **The credential re-check has still never fired live** — no run has yet had the password manager
repopulate the login box after the fill. The run to watch for ends `needs_review` +
`credential-overwritten`, not a silent `filled`.

**Step 3 (Education + entry scoping) is LIVE-VERIFIED** on build `icims-edu-3`. The whole education
section fills deterministically and `needs_review` on the page is **0**:

| field | result |
|---|---|
| School | `filled` · exact · "Carnegie Mellon University" |
| Other School | `filled` · "N/A" |
| Degree / Major | `filled` · exact · "Bachelor of Science" / "Electrical and computer engineering" |
| Minor | `skipped` (empty in profile) |
| Did You Graduate | `filled` · exact · **"No"** |
| Graduation Month / Year · Start Year | `filled` · "May" / "2028" · "2024" |
| Country / State | `filled` · exact · "United States" / **"Pennsylvania"** |

Page totals across the three steps: `filled 12 → 21 → 29`, `needs_review 9 → 1 → 0`.

**The seal is demonstrated, not just asserted:** the only "Florida" anywhere in that run is
`PersonProfileFields.AddressState` (the home address, where it belongs), while `EducationState` is
Pennsylvania — derived from the education entry's OWN location.

Three faults were fixed in this round, each of which had produced a confidently wrong or missing
answer, and each worth remembering:
- the search settle polled for STILLNESS; the pre-search list satisfies every such proxy. Measured:
  the school search takes **~4s**, and a 675ms give-up said "no option matched". Now it matches on
  every read and stops at the first hit.
- `currently_enrolled` is **not exposed by the website's education editor**, so a synced profile
  carries the default `false` and a 2028 graduand was answered "Yes, graduated". A future graduation
  date now decides first.
- Country is State's declared PARENT and had no deterministic source, so it was deferred to the AI —
  and the deterministic "Pennsylvania" ran against an empty child list. A US state in the entry's
  location now implies the country, filling the parent in the same pass ahead of the child.

Remaining, in rough order:
1. **Education** — the one `needs_review` left: `CandProfileFields.School` found no match for
   `"Carnegie Mellon University"` *after searching* the AJAX list. That is the new widget behaving
   correctly (it searched, then reported honestly) — the question is what the field actually offers.
   `-1_CandProfileFields.EducationCountry` / `EducationState` are the same declared parent→child pair
   as the address, so they should come along with it.
2. **The résumé parse postback.** iCIMS parses server-side and re-renders the panel under new ids seconds
   after the attach reports success, blanking the fill. Until that is handled the résumé is `kind:"skip"`.
   Still the single biggest remaining piece.
3. **Multi-entry repeating sections.** `atsMapKey` strips the entry ordinal, which is correct for ONE
   address against one form entry — but a SECOND entry would map to the same profile address. Phones /
   Certifications / Experience all have the same shape (`a.iCIMS_Anchor` "Add More (…)").
4. **The `rcf<NNNN>` custom questions** — per-customer, routed by label today; check what falls to AI and
   what wants a bucket.
5. **Multi-step.** The Astrion form is step 1 of 4 (the progress rail reads 1·2·3·4). `runAtsSubmitRun`
   assumes one page, one click, one confirmation — that assumption does not hold here.

**Tooling note:** `AP_DEV_ATS_SCAN` is frame-aware for iCIMS now, but it attaches its own debugger — a
call that times out client-side leaves the attach held and the next one fails `attach-failed: Another
debugger is already attached`. Fire it without awaiting in-page (the CDP ceiling is ~45s) and give a
wedged attach time to clear.

⚠ There is ~6000 lines of earlier iCIMS work on the unmerged branch `worktree-generic-filler-design`
(education tier, work-experience tier, address tier, the parse-postback round, a login gate the author
would not call reliable). It was NOT ported — this branch restarted from main deliberately — but it is
worth mining before building any of the four above, the way the credential tier was mined for this step.

### NEXT (1) — BATCH the questions page into ONE AI call (operator 2026-08-05)

A screening page can hold many AI-answered questions and today each one is its OWN `act.llm` round trip,
fired serially from inside the per-field loop — N calls, N latencies, N prompts' worth of tokens.

Wanted: identify the AI-needing questions up front, scan them (a choice widget's live options), fire **ONE**
call for all of them, fill the DETERMINISTIC fields while it is in flight, then commit the AI answers when
it lands — faster AND cheaper.

*Why it is not a small change:* the AI fallback fires INSIDE the field loop, and `aiFillField` commits on the
STILL-OPEN widget, so batching means deferring the commit and re-opening later. Every per-field semantic must
survive: the match-ladder gate on the live options, `filled_review` always, the EEO re-tag, forced picks for
required, `maps_to` / `suggested_category` for the teach flow, per-answer confidence + justification.

Prompt shape and the safety contract are unchanged per question — only the transport is batched. **Do it as
its own milestone with unit pins.**

### NEXT (2) — the REAL (non-simulate) submit on a DISPOSABLE application, EYES-ON (the hard gate)

Two routes now:

- The **website `/app/run` Submit button** is armed-capable TODAY (`AP_SUBMIT_APPLICATION` with `arm:true`,
  behind its two-step confirm). **Use Rehearse first** — it runs the identical path and stops at "would
  submit".
- The **popup** button stays hardcoded `simulateSubmit:true` (flip that ONE flag to arm it).

The to-review walk + the whole gate are live-verified in simulate.

Still live-verify-PENDING units: AI-2 essays (no essay page observed yet), AI-3 EEO-inference/canonicalization
(Magna exact-matches), the AI-4 dup-language Tier-0 (phantom-dup not reproducible), the reload-retry restart
(built, unit-green, live-verify on next transient), the failed-AI-rescue honesty fix + proactive nested
delete.

---

## Built, live-verify pending

### Website SUBMIT button + per-application LOGIN tracking — BUILT 2026-07-26

This branch; see progress-log and the `workday-walk` / `review-and-submit` skills. `/app/run` gains
**Rehearse (no submit)** + **Submit** (two-step confirm) driving the new `AP_SUBMIT_APPLICATION`;
`applications.login_*` (migration `0011`) records WHICH Workday account each application was filed with,
shown on the tracker detail.

Fixed en route: a submit run could have replayed ANOTHER application's approved bundle (the untargeted review
pull — see the `review-and-submit` skill). Extension suite **724/724**; web typecheck + build green.

**Remaining:** run migration `0011`, then live-verify — Rehearse on an already-approved job (expect "would
submit", nothing submitted) BEFORE ever arming Submit, and confirm the login line appears on the tracker row.

### Job DISCOVERY (Discover button → the queue) — REBUILT FROM A LIVE TRACE 2026-07-30

Branch `discover-jobs`; see the `job-discovery` skill + progress-log. `/app/run` Discover sweeps the Simplify
board + the operator's signed-in LinkedIn/Handshake, resolves each find to the EMPLOYER's real application
link, drops anything already applied-to/queued/closed/board-only, ranks everything and queues the best N.

The 2026-07-26 build's LinkedIn scrapers matched zero against the real DOM; both boards are now rebuilt on
traced anchors and share one driver. Extension **862/862**, web **107/107** (incl. the cross-loading LOCKSTEP
test), typecheck + build green.

**Verified live, in-page, against the operator's own session:** both list scrapers (25/25 LinkedIn cards with
0 field shifts, 24 Handshake), both detail APIs (real employer links on Greenhouse/Workday/Google/Lever), the
search-URL contracts (`start=25` paginates, `jobType=3` filters, the closed `sort` set), and the full location
resolver (typed "Seattle" → suggestions → `geoId=104116203`).

**Remaining — the operator's step:** (1) reload the unpacked extension, (2) run migration `0010` if not
already, (3) a real sweep from `/app/run` — foreground first, then confirm a background sweep matches. Then:
retire the deferred board-only-apply support, and consider AI ranking.

### Review stage migrated to the WEBSITE — BUILT 2026-07-16

See the `review-and-submit` skill + `WEBSITE.md` M9. The human edit/approve stage now lives on the site
(`ReviewEditor.tsx` full-parity port of `summary.js`; `web/lib/review-approval.ts` LOCKSTEP with
`summary-lib.js`). Walk PUSHES the bundle to the site; SW PULLS the approved bundle before replay →
`runCdpReplayWalk` / `submitPrecondition` unchanged. `AP_SET_SESSION` carries `reviewUrl`. Extension
`summary.html` kept as fallback. Extension suite **593/593**; web typecheck + build green.

**Remaining:** live-verify the end-to-end round-trip on a real tenant (Supabase wired + `/app/connect`); add
the prod site origin to `manifest.json` `externally_connectable` + `host_permissions` before a non-localhost
deploy; then retire the extension viewer.

---

## Done

### SKILLS (`Type to Add Skills`) — BUILT + LIVE-VERIFIED 2026-08-07 (visible AND hidden), on `cat.wd5`

See the `cdp-actuation` skill + dom-patterns 2026-08-07. `fillSkillsCdp` + `isSkillsField` (fill-driver.js),
`skillBaseName` / `matchSkillOption` / `missingSkills` (lib.js, mirrored into the SW `apMatch` literal),
routed in `drivePageFill`'s flat loop and in `replayField`; 20 unit pins in `test/skills.test.js`.

**Remaining:** run it on a real page-2 (the `cat.wd5/solarturbines` draft carries one pre-existing `Docker`
chip, the never-touch fixture), confirm the per-skill wall-clock is acceptable for ~24 skills, and settle two
operator calls — (a) whether a QUALIFIED commit ("Python" → "Python (Programming Language)") should stay
silent `filled` or be flagged for review, and (b) whether a partial fill (some skills absent from Workday's
taxonomy) should nag review or just name them in the detail, which is what it does now.

---

## Operator TODO

- Restore the real cert in `data/profile.json` (the `_TEST_REMOVE` CPP/otherrrr test cert) once
  nested-specialty testing wraps.
- **⚠ DO NOT touch `data/profile.json`** — gitignored, operator-managed; `country:["Afghanistan",…]` is
  intentional test data.

---

## Deferred / parked

- **Long-list click-commit ("Uruguay"):** an out-of-view multi-match click degrades to `needs_review` (safe,
  never a mis-commit); a proper virtualized-list scroll/commit is its own recon round.
- **searchBox-less expand-walk tree tenant:** re-open only if a NEW tenant shows a tree shape with NO
  searchBox (a pure expand-walk, no typing) — that needs its own deterministic drill fill first (the
  page-substrate `fillSource` covers the expand-walk on the page path).
- **Recorded TODO:** a start-of-fill gate on the Workday maintenance page (`isWorkdayMaintenance` already
  detects it — dom-patterns 2026-07-01).
- **Known issue (observed once, unreproduced):** a long-lived/stale extension instance produced a 25s settle
  timeout on a no-match candidate that a reload fixed (same code: ~839ms after reload) — suspect MV3 SW
  respawn or stale `chrome.debugger` state accumulating across many runs (users run ONE install across MANY
  applications, opposite of the dev reload-often pattern). Mitigations if it recurs: defensive `cdpDetach` at
  run start; never trust module-level state (`cdpTabId` etc.) across runs; log SW-lifetime/attach-age on
  ceiling hits; reset per-run caches at run start.
- **Later rounds:** strict-replay SUBMIT (Plan 1 — consumes `effectiveValue` / `is_approved` / `submit_ready`;
  must defensively recompute the envelope on a never-opened bundle and live-re-read + REFUSE on any unreplaced
  AI placeholder); full unattended N-page loop (confirm/close the between-pages input-lock re-install gap);
  auto-populate `jobContext.company`; map standalone `linkedInAccount` / `regionSubdivision1` + the optional
  local-name fields; dial-code tiebreak (parked); account creation; backend.
- **Two AI enhancements over working deterministic paths:** an LLM semantic field-match tier (map an
  unrecognized field to a known answer — guess+fill+flag) and LLM vocabulary canonicalization (canonicalize a
  profile value to the live option set when the tiered lists miss; output still a candidate that clears the
  ladder).
