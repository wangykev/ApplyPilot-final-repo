# ApplyPilot — fill SPEED / timing log

Everything about how fast a fill runs and why it sometimes doesn't: measurements, **refuted theories**,
per-run data, the instrument's own distortions, and fix directions. **Append each new speed round here**
(newest round at the bottom of its own dated section) rather than scattering timing notes across
`CLAUDE.md` / `progress-log.md`.

**Read this before investigating any slow fill.** Most of the obvious explanations have already been
measured and killed; re-deriving them costs a session each.

## How to use this file

1. Read **"Standing conclusions"** below — that is what is true now.
2. Then read **"Refuted — do not re-investigate"**, which is the expensive part.
3. Only then measure. The tooling section says which flags to turn on and which of their numbers lie.

---

## Standing conclusions (what is true now)

### 1. The lag is OUR OWN SERVICE-WORKER TIMERS — `act.delay` overruns 3–69×

`CLAUDE.md`'s invariant is that **ALL pacing goes through `act.delay`** (SW wall-clock, never a page-side
timer). That timer is a `setTimeout` inside an MV3 service worker, and Chrome starves it. So every drift
spike is not a curiosity — it is fill time.

The decisive measurement (2026-08-10, `cat.wd5` page 1, `debugPageTrace`):

```
FIELD "How Did You Hear About Us *" [source] hierarchical REQUIRED · holds "" · plan: AI or blank
    · readHier(source) — ⏸ 13.55s
    · delay(250)       — ⏸ 17.30s      ← a 250ms pace took 17.3 SECONDS (69×)
    · readHier(source) — 0.13s
[GAP +32.8s] ▪ "source" (hierarchical) took 32832ms to reach filled via click-commit
  ⤷ filled "Other" [directed-exact] via click-commit
```

That single field was **32.8s of that page's 43.9s**. The same class appeared throughout the round:

| pace requested | actual | over |
|---|---|---|
| `delay(250)` | 17.30s | 69× |
| `delayFull(600)` | 3.16s | 5.3× |
| `delayRender(300)` | 2.48s | 8.3× |
| `delay(300)` | 1.49s | 5.0× |
| `delayFull(150)` | 1.05s | 7.0× |

### 2. ⚠ Do NOT read drift against the page-thread probe — that is what hid this

This is the trap, and it is worth stating loudly because it inverted the conclusion mid-investigation.
The `[LAG]` summary prints SW drift next to a no-op page probe, which invites reading them together. They
are unrelated, and the **fastest pages had the worst drift**:

| observation | probe p50 | SW drift p95 | page verdict |
|---|---|---|---|
| run 3 page 1 | 31ms | **8947ms** | fast (fill 19.8s) |
| run 1 page 3 | 12ms | 2382ms | fast (fill 3.6s) |
| run 1 page 1 | 3046ms | 2727ms | slow (fill 154.6s) |

Drift vs the probe says "noise, ignore it". Drift vs the `[TRACE]` per-action timings says "a 250ms pace
took 17.3s". **Always grade drift against `[TRACE]`, never against the probe.**

### 3. The profile is "median fast, tail catastrophic"

Which is exactly what "it lags sometimes" feels like from the outside. Page-thread median was healthy on
nearly every page measured (probe p50 **1–42ms**); the p95 blew out to 19.7s. One widget stalls and owns
the page. The same field varies ~6× run to run on identical code and tenant (`source`: 5.5s vs 32.8s).

---

## Refuted — do not re-investigate (each measured, not reasoned)

| Theory | Verdict | Evidence |
|---|---|---|
| **CPU load / machine under load** | **NO** | 515 samples of `\Processor(_Total)\% Processor Time`: mean 13.3%, median 11.0%, max 67.3%, exactly ONE sample above 50%. In matched windows the **slow** page had *lower* CPU (154.6s page: mean 11.4% / max 31.4%) than the **fast** one (29.8s page: mean 13.1% / max 30.8%). |
| **The unread-CDP-event firehose** | **NO** | `UNREAD CDP EVENTS 0` on all 19 page windows recorded. This was the leading suspect written into `cdp.js`'s own comments ("`Runtime.enable` + `DOM.enable` while registering NO onEvent listener … a saturated event loop defers timers"). The counter exists to settle it; it did. |
| **`debugLagTrace` causing the slowness it measures** | **NO** | Suspected because run 1 (trace ON) spent 132.3s in `flat` vs run 2 (trace OFF) 8.8s. An **A/B/A** killed it: ON 501s → OFF 211s → **ON 135s** (the fastest run). Run 1 was the outlier, not the flag. |
| **Attach age / a tab-level rot that worsens over a run** | **NO** | Run 1 page 3 was healthy (probe p50 12ms) at attach age 330s while page 1 was catastrophic at attach age 157s. Later = better. |
| **The résumé-autofill parse leaving page 1 heavy** | **NOT sufficient** | Every run took `autofillWithResume`; page 1 fill ranged 19.8s → 154.6s across them. The parse is constant, the slowness is not. |
| **Hidden-tab throttling (the tab not painting)** | **NOT the driver** | Every run was `pacing hidden-fast (worker timers) | NOT painting (chrome says hidden)`, including the 135s run. The page's worker-backed timers hold up; it is the SW's own timer that does not. |

---

## Tooling — and which of its numbers lie

`debugLagTrace` and `debugPageTrace` are still the right instruments. `debugPageTrace` is the one that
cracked this (it timed `delay(250)` at 17.30s). Three `debugLagTrace` readings must be discounted:

1. **Probe p95/max is mostly OUR OWN long in-page polls.** The probe is an **unguarded**
   `setInterval(500ms)` firing a `Runtime.evaluate` without awaiting the previous one (`cdp.js:254-272`),
   and CDP commands to a target are serviced **in order**. Once servicing exceeds 500ms the probes queue
   behind each other and behind anything of ours holding an eval open. Run 5 page 1 read p50 42ms / p95
   19710ms — the p95 was `readHier` holding one eval. **Trust p50. Treat p95 as "something of ours held
   the queue".**
2. **An in-page wait abandoned at teardown is billed "THIS COMMAND'S OWN WORK" for its whole lifetime.**
   At one teardown, four evals reported **166892ms / 132484ms / 66996ms / 13560ms all at the same
   timestamp**, each with "the channel is free". They were long-lived polls settling together, not 166s of
   work. `cdpSend` times issue→resolve and cannot tell waiting from working.
3. **Drift is REAL** (see Standing conclusion 1). The old "possibly an artefact of timing with a timer
   inside an MV3 worker" hedge is retired.

**Measuring CPU without measuring your instrument:** a first sampler that enumerated `Get-Process` every
tick made `powershell` itself the busiest process on the box. Sample total CPU only
(`\Processor(_Total)\% Processor Time`), one counter, no process walk.

**`AP_BUILD_MARKER` alone does NOT identify which folder Chrome loaded** — every worktree at the same
commit carries the SAME string (the 2026-08-09 wrong-Chrome incident was diagnosed by
`polarity-capture-1`, which is also main's value). Only **bump it, `AP_RELOAD`, and re-read** distinguishes
them. Done for the 2026-08-10 round: `polarity-capture-1` → `fill-speed-probe-1`, re-read live.

---

## 2026-08-10 — round 1: five runs on one tenant

**Method.** Five background (hidden) fill runs on `cat.wd5` / `CaterpillarCareers`, tenant held constant so
run-to-run variance was the only variable, each on a **fresh requisition** (never re-running one form —
that produces Workday's phantom state). CPU sampled continuously to a CSV alongside. Motivation: the
operator's report that a fill "just seems to lag sometimes", and their CPU hypothesis.

| run | trace | onboard→form | p1 fill | p2 | p3 | p4 | p5 | total | note |
|---|---|---|---|---|---|---|---|---|---|
| 1 `R0000380424` | ON | 124s | **154.6s** (flat 132.3s) | 23.5s | 3.6s | 10.4s | 2.4s | 501s | Save swallowed (~105s); p1 probe p50 3046ms |
| 2 `R0000380463` | OFF | 32s | 29.8s (flat 8.8s) | 32.2s | 15.6s | 4.4s | — | 211s | Save swallowed (~32s) |
| 3 `R0000375720` | ON | 23s | 19.8s (flat 4.0s) | 40.2s | 3.2s | 1.9s | 7.0s | **135s** | clean |
| 4 `R0000386123` | ON | — | — | — | — | — | — | halted 62s | `resume-upload-input-missing` |
| 5 `R0000386660` | ON | 18s | 43.9s (flat 34.3s) | 19.7s | 5.0s | 9.7s | 2.2s | 263s | `source` 32.8s |

Four of five reached `✓✓ reached the REVIEW page after 5 page(s)`; all four pushed their bundle to the
tracker (`needs_review`). Nothing was ever submitted.

Per-page probe/drift for run 5 (the clearest single run):

| page | probe p50 | probe p95 | drift p95 | fill | slowest field |
|---|---|---|---|---|---|
| 1 | 42ms | 19710ms | 7642ms | 43.9s | `source` 32.8s |
| 2 | 18ms | 549ms | 1386ms | 19.7s | `education[0].degree` 2.3s |
| 3 | 29ms | 16657ms | 8770ms | 5.0s | — |
| 4 | 208ms | 5550ms | 3209ms | 9.7s | `veteranStatus` 2.0s |
| 5 | 4ms | 592ms | 2218ms | 2.2s | — |

### Other costs measured this round (real, but not the root cause)

- **`readHier(source)` 13.55s on the FIRST read, 0.13s on the second** — the hierarchical expand-walk.
- **`scrapeTaOptions(countryPhoneCode)` 14.37s** (~249 options); `capture` ranged **4.7–21.1s** on page 1
  across runs. Both `countryPhoneCode` and `country` are **fixed vocabularies** (Workday's own country
  list), so they are cacheable across runs/tenants instead of re-scraped every page 1. `CLAUDE.md` already
  skips `capture` for **skills** for the mirror-image reason — skills is a server-side RANKED search so it
  can never BE the picker; these are fixed so they can be cached once.
- **Page 1's first Save & Continue is SWALLOWED on 2 of 4 completed runs.** Signature: `page 1 blocked
  with 0 error(s)` → `no error text on the page — nothing to anchor a remediation on` → `✓ page 1 →
  advanced after re-clicking Save & Continue (1x — the first click was swallowed)`. Cost ~105s (run 1) and
  ~32s (run 2). Largest intermittent cost after the timer drift.
- **`waitFor(resume-upload-input)` timed out at its 25s budget on 1 of 5 runs** and halted the run
  `needs_operator` / `resume-upload-input-missing`; the very next run satisfied the same wait in 7.0s. A
  transient race, **not** accumulated Workday state — a longer budget beats a halt here.

### Fix directions (measurement only — NONE implemented)

1. **Pace off a throttle-immune clock (highest value).** The page already carries worker-backed timers
   (`__apWorkerTimers`, installed for exactly this class of problem), so an in-page `Runtime.evaluate` +
   `awaitPromise` sleep is paced by a clock Chrome does not starve, unlike the SW's `setTimeout`. Cost: it
   holds one `Runtime.evaluate` open for the delay — which is what a pace wants anyway. ⚠ It also
   serializes behind other commands on that target, so measure before/after with `debugPageTrace`, and
   keep `act.delay`'s signature so the substrate/brain split is untouched.
2. **Or measure-and-compensate.** `act.delay` records requested-vs-actual and, after a large overrun,
   SKIPS the next delay — the settle it was buying has already elapsed. Cheap, no new mechanism, and it
   cannot make a wait shorter than the condition it gates because every wait polls its own condition.
3. **Cache the fixed option vocabularies** (`countryPhoneCode`, `country`) — ≈14s/run.
4. **Give the swallowed-first-Save its own fix.**

### Open questions for the next round

- **What starves the SW timer?** Not unread CDP events (measured 0) and not CPU (measured). Remaining
  suspects: Chrome deprioritising MV3 worker timers while the worker awaits many CDP promises; or the
  worker's own message-processing queue. A targeted probe would time `setTimeout` drift with and without
  concurrent CDP traffic on an otherwise idle worker.
- **Is the widget tail (`source` 5.5s vs 32.8s) the same timer problem or a Workday XHR?** `readHier`'s
  13.55s is genuine in-page work; the `delay(250)`→17.3s next to it is ours. Splitting those needs a
  per-poll-iteration trace inside `readHier`.
- Whether a **visible** run shows the same drift. Every run this round was hidden. ⚠ Polling the localhost
  tab with `javascript_tool` ACTIVATES it, so a foreground run must be fired and then left alone.

---

## 2026-08-10 — round 2: the fix (pace on the page's clock) — LIVE VERIFIED

Fix direction 1 from round 1, built and verified. `cdpDelay` (`cdp.js`, the "PACING CLOCK" block) now
sleeps on the PAGE's clock via `Runtime.evaluate` + `awaitPromise`, where `window.setTimeout` is the
worker-backed polyfill, instead of the starved SW `setTimeout`.

**Chosen over detect-and-skip (round 1's option 2) on two pieces of evidence:**
1. **Drift clusters, but the FIRST overrun dominates.** Run 5's cluster was 17.3s, then 1.3s / 2.4s /
   1.5s. Detect-and-skip always eats the head and refunds only the tail — ~3–5s of a ~22s loss.
2. **30+ poll loops bound themselves on a WALL-CLOCK deadline while their INTERVAL rides `act.delay`**
   (`background.js` `while (Date.now() < deadline)` at 1002, 1715, 4042, 4154, 4738, 4800, 5914 …, plus
   `focusText` / `cdpEvalRectReady`'s ceilings). Drift there costs SAMPLES, not just time, and skipping a
   later delay cannot refund a deadline already burned. Fixing the clock repairs all of them at once.

### RESULT (cat.wd5 R0000386123, hidden, build `page-clock-2`)

`✓✓ reached the REVIEW page after 5 page(s)` — and all five M40 audits read "all matched the report"
(13 / 28 / 4 / 4 / 1 fields), so nothing was traded for the speed.

| page 1 | run 1 | run 2 | run 3 | run 5 | **round 2** |
|---|---|---|---|---|---|
| fill | 154.6s | 29.8s | 19.8s | 43.9s | **6.4s** |
| flat | 132.3s | 8.8s | 4.0s | 34.3s | **2.8s** |
| `source` | — | 5.5s | — | 32.8s | **0.41s** |

| whole run | run 1 | run 2 | run 3 | run 5 | **round 2** |
|---|---|---|---|---|---|
| sum of page fills | 194.5s | 82.0s | 72.1s | 80.5s | **30.4s** |
| onboard→review | 501s | 211s | 135s | 263s | **122s** |

Per-page fills round 2: 6.4 · 11.2 · 5.8 · 1.8 · 5.2s. Page 1's Save was NOT swallowed this run.

### ⚠ THE REGRESSION THIS CAUSED FIRST — and why the gate exists

The first live run of the fix **halted the application**, and it is the single most important thing on this
page for anyone touching pacing:

```
waitFor(resume-upload-input) timed out after 25000ms — 21 read(s) OK / 0 failed  tab HIDDEN
stopped: "resume-upload-input-missing"
```

4 of 5 paces logged `page-abandoned`, a 50ms pace taking 3.5–5.0s. Cause: **ONBOARDING pages are mid-
NAVIGATION, and a navigating document's timer does not fire.** The poll's deadline is wall-clock but its
interval is `act.delay`, so a slow clock cost it SAMPLES — 21 polls in 25s where the pre-change run
satisfied the same wait in 7.0s (round 1's run 4 timeout managed 29). A missed transient reads as "the
control never rendered". This is exactly the poll-starvation class described above, met from the other
direction.

**Fix: `cdpSetPageClock(on)` — scoped opt-in, mirroring `cdpSetSyntheticInput` exactly**, which exists for
the same reason (the auth surface is where the clever fast path failed live). FILL and REPLAY enable it;
**onboarding, auth and recon stay SW-timed**; reset to false at every `cdpAttach`. After gating:
zero `[PACE]` warnings during onboarding, and the résumé-upload wait polled normally (2.5s / 4.5s / 6.9s).

**Standing rule: never widen the page clock to onboarding/auth/recon.** A navigating document has no
usable clock.

### Guards, each mutation-checked (reverted, confirmed the test FAILS, restored)

| guard | mutation | test result |
|---|---|---|
| page clock only when `_pageClockOn` | dropped the gate | 2 tests failed |
| page clock only when `_workerTimersActive` | dropped the gate | 1 test failed |
| race vs SW timer at `want+slack` | timer ignores slack | failed: `took 6031ms` |
| thrown eval → REMAINDER only | re-wait full pace | failed: `took 672ms` (bound ~400ms) |

⚠ The double-wait test's FIRST draft threw immediately, which makes "remainder" and "full want"
indistinguishable — it passed both ways and would have read as coverage. It now throws PART WAY through
(250ms into a 400ms pace). Check WHICH path a fixture exercises, not just its verdict.

`test/pacing-clock.test.js` extracts the clock from source between its `PACING CLOCK START/END` markers
(cdp.js can't be `require`d) — if those markers are renamed, the test fails loudly rather than silently
skipping.

### Known-remaining, bounded

- **Page TRANSITIONS still hit the navigation case** — 5 `[PACE]` lines in the verified run
  (`50→1765`, `30→1197`, `50→1347`, `200→4017`, `50→3595`, mostly `page-abandoned`), all clustered around
  Save & Continue. Now BOUNDED by the race rather than open-ended, and ~1.5s each rather than 17s. The
  clean follow-up is to SW-time the transition wait specifically, the same way onboarding is.
- **⚠ The race's escape hatch is itself an SW timer**, so when the page arm hangs AND the worker is
  starved, abandonment fires late (3970ms against a 1550ms ceiling was measured pre-gate). There is no
  third clock; this is the accepted floor, and it is still strictly better than the old unbounded drift.
- `scrapeTaOptions(countryPhoneCode)` caching (≈14s) and the swallowed-first-Save remain untouched —
  separate commits by design.

### Process notes worth keeping

- **`AP_RELOAD` produced TWO worker starts ~700ms apart**, the first still running PRE-EDIT code. Reading
  the marker too early showed the old build and nearly sent this round chasing a phantom. Re-read the
  marker until it is STABLE before firing a run — and a run fired into that window dies with
  `message channel closed before a response was received`.
- **The connected Chrome silently changed mid-session** to one loading the `live-submit-runs` worktree
  (marker `required-date-rescue-1`). `switch_browser` re-paired it. Always bump-and-re-read.
- One full-suite failure (`dropdown tier-keep: a slow-closing list is RE-ESCAPED`) is **pre-existing
  load-sensitive flakiness**, not this change: 675/675 in isolation, it uses `makeFakeAct` and never loads
  cdp.js, and it counts retries against a wall-clock deadline while `node --test` parallelizes files.

---

## 2026-08-10 — round 3: the page-TRANSITION wait (a correctness argument, NOT a speed win)

`cdpWaitNextPage` now save/restores the page clock OFF around its poll (`background.js`, build
`page-clock-3`). It is a 15s WALL-CLOCK budget with a `cdpAdaptiveDelay(500)` interval, and running out is
a **nav-timeout HALT**, so a starved interval there costs a failed run rather than a slow one.

**Be honest about the size of this: it swaps one late clock for another.** Measured, page 2→3 transition:

| transitions paced by | observed |
|---|---|
| page clock (round 2, `page-clock-2`) | `50→1765`, `200→4017`, `50→3595` — all `page-abandoned` |
| SW clock (round 3, `page-clock-3`) | `50→1730 (sw)` |

Better on median, but **not** a clear win on sample count: a 500ms interval is *bounded* at 2000ms under
the page clock (interval + slack) while the SW clock was observed at **2694ms** for the same 500ms request.
So for the 500ms transition interval specifically the two are close.

**Why it still stands, on principle rather than on the timing:** during a navigation the page clock can
hang indefinitely, and our abandon ceiling is ITSELF an SW timer — pre-gate it fired at 3970ms against a
1550ms ceiling. So the page clock has no *reliable* bound during a navigation, whereas SW drift, though
unbounded in theory, measured 1.7–2.7s against page-abandons of 3.5–4.0s. Same direction as the onboarding
gate, smaller stakes.

### ⚠ NEITHER CLOCK IS CLEAN DURING A NAVIGATION — the real remaining bug is the LOOP SHAPE

Round 3's onboarding (SW-timed by design) logged `a 500ms pace took 2694ms (sw)` and
`a 50ms pace took 2632ms (sw)`. So onboarding's poll loops are sample-starved too, just less severely than
under the page clock. **Choosing a clock cannot fix this.** The systemic fix is the loop shape: a poll that
must not give up early should bound itself by **ATTEMPTS as well as wall-clock**, or recompute its deadline
from actual elapsed time, so a late clock costs latency instead of coverage. That is the next real piece of
work in this area, and it is bigger than a clock swap — it touches ~30 loops.

### Where the residual overruns actually are (build `page-clock-3`, one run, positioned)

| when | pace | clock | position |
|---|---|---|---|
| 12s, 15s | 500→2694, 50→2632 | `sw` | onboarding |
| 43s | 600→1815 | `page` | mid page-1 fill |
| 47s | 150→3487, 200→3695 | `page-abandoned` | END of page-1 fill (post-fill audit / pre-Save) |
| 78s | 50→1730 | `sw` | page 2→3 transition |

So the page clock also hangs occasionally *inside* a fill, clustered at the page's end — plausibly while
Workday runs its own post-field XHR/validation. Bounded, and small next to what round 2 removed.

### Round 3 run (cat.wd5 R0000380424 — a DRAFT RE-ENTRY, not comparable to a fresh fill)

⚠ This req had already reached review in round 1, so onboarding recovered into the saved draft and the
pages arrived pre-filled (`dropdown-prefilled-kept`). Reported for completeness, NOT as a baseline:
reached REVIEW after 5 pages, fills 7.1 · 7.3 · 4.1 · 8.8 · 5.8s (33.1s), all five M40 audits "all matched
the report". **Use a genuinely unused requisition for any timing comparison** — this one is only evidence
that the change is safe on the resume path.
