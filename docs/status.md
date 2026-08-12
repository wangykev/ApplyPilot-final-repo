# Current state & open items

Live working state. **Full milestone-by-milestone history: `docs/progress-log.md`** — append new milestone
entries there (one focused change, verified on a real page, one commit each, so we can bisect).

As of 2026-07-02 the CDP path is the primary, live-verified fill: full-page fold, N-page walk machinery,
résumé attach, AI-0/1/4, inline + tree AI rescues, nested cert specialties, review-summary source-of-truth,
Plan 2 approve/merge. Unit suite green (`npm test`, `node:test` — ~450 tests as of 2026-07-02; 862 on the
discover branch).

---

## Active

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

### MANUAL ASSIST — the popup's own surface — BUILT 2026-08-10

Branch `manual-assist-ui` (rebased onto main 2026-08-12); see the progress-log entry
`2026-08-10 — MANUAL ASSIST` and the CLAUDE.md section. The popup is now a **match card + two buttons**
("Fill form" → walk to review, AI-gated; "Fill page" → this page only), with the whole old dev console
folded behind `Developer tools`. **Both buttons work on Workday AND on Greenhouse / Lever / Ashby**, and
the ATS "Fill page" fills IN PLACE — no reload, no page overrides, no landing work. Neither button pushes
a review bundle; a tracker row is written only when a SUBMIT is actually detected, as `fill_mode:'manual'`
with an EMPTY-entries bundle carrying the review-page scan. Extension suite **1416/1416**, website
**279/279** + typecheck clean, both popup states rendered and eyeballed.

**Remaining — three things, in this order:**

1. **Re-paste `web/supabase/main.sql`, then `verify.sql`** (section 0019 adds `applications.fill_mode`;
   every verify row must read PASS — the two new ones are `fill_mode column` / `fill_mode constrained`).
   Re-pasting is verified safe by execution, including over live rows. Until it runs, the row still
   lands — the report route drops the unknown column and retries — but WITHOUT the `manual` label.
2. **Live-verify the two buttons.** Workday: "Fill page" on an application page (expect a fast fill, no
   dropdown re-opens, nothing on the website's review page), then "Fill form" from a JD page (expect it
   to reach review and stop). **Non-Workday:** open a Greenhouse/Lever/Ashby application and press
   "Fill page" — expect it to fill WITHOUT reloading and without touching anything already typed. That
   last point is the one to watch: it fills a live React document without installing the page overrides,
   which is the whole reason it is safe (see the ATS section of CLAUDE.md). If a combobox misbehaves,
   that is the first place to look.
3. **The submit detector is waiting on its first real submit.** Workday's post-submit page has never been
   observed. When you do submit one by hand, check the SW console: either `✓ submit detected` (done), or
   an `ASSIST-WATCH … page I don't recognise as a confirmation` line quoting the page — paste that line
   and `SUBMIT_CONFIRM_RX` (lib.js) gets the real wording.

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
