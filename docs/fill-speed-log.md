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

### 3. Lateness is LATENCY, not lost coverage — classify the PREDICATE before "hardening" any wait

The tempting inference from conclusion 1 is that a starved clock makes wall-clock-bounded poll loops
*miss* things. **Audited across all 59 such loops (round 6): it does not.** Every one on a run path
watches either a MONOTONE predicate (X appears / X is gone — a sparse poll notices late, it cannot miss)
or a STABILITY predicate (N equal reads — where sparse reads are *stronger* evidence, so drift makes
these SAFER and the adaptive FAST path is the weak regime). Only a **transient** predicate (true, then
false again) can be starved, and there are none: where a real transient matters the code installs a
page-side `MutationObserver` instead of sampling.

**Consequences, both load-bearing:** a wait that timed out wants a bigger **BUDGET**, never an attempts
floor — and "the poll didn't look often enough" is not an available explanation for a failed wait here.
Full table + the sweep in round 6.

### 4. The profile is "median fast, tail catastrophic"

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
4. **`[TRANSITION]`'s poll count was an ARITHMETIC ESTIMATE, not a count** (fixed 2026-08-10). It read
   `Math.round(elapsed / intervalMs)` — i.e. it assumed the interval was honored, which is precisely
   what drift breaks. Now a literal counter. `sawNewPageMs` / `confirmMs` were always real `Date.now()`
   deltas and are unaffected.

   ⚠ **Measured live, the error runs the OPPOSITE way from the one predicted here** — worth keeping,
   because the prediction was written confidently and was wrong. I expected it to OVERSTATE (a starved
   500ms interval measured at 2694ms would print ~5 polls per real read). In a real 5-page run it
   **UNDERSTATED, by up to 6×**, because `cdpAdaptiveDelay` collapses the interval FAR BELOW the
   requested 500ms whenever the tab measures fast:

   | transition | counted | actual mean | requested | old estimate would print |
   |---|---|---|---|---|
   | 1 → 2 | 12 | 551ms | 500ms | ~13 ✓ |
   | 2 → 3 | **58** | 113ms | 500ms | ~13 ✗ (4.5× low) |
   | 3 → 4 | 26 | 273ms | 500ms | ~14 ✗ |
   | 4 → 5 | 18 | 77ms | 500ms | **~3** ✗ (6× low) |
   | 5 → 6 | 21 | 117ms | 500ms | ~5 ✗ (4.2× low) |

   The general lesson is the one that survives either direction: **the estimate is not a count, and it
   errs whichever way the true interval deviates** — high when the clock is starved, low when adaptive
   pacing collapses the beat. On a hidden run the collapse dominates. It also retires round 4's
   "it sometimes exits in 1 poll": real counts are **12–58**, and the smallest number in that table is
   an artefact of the estimate, not an observation.

⚠ **General rule this is an instance of: never print a poll count you did not COUNT.** A derived
count is an assertion that the clock kept time — the one assumption every measurement on this page
exists to test.

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

## 2026-08-10 — round 4: "I press next and it waits 5s before filling" — WHERE THAT GAP GOES

Operator: *"when I press next page, it waits 5 seconds before starting to fill, but I can see the page
loaded in after 2 — what are the other 3 seconds doing?"* A single duration cannot answer that, so
`cdpWaitNextPage` now splits it and the walk logs `[TRANSITION]`.

**Measured (cat.wd5, hidden, fresh req):**

| transition | Workday rendered the new page | WE then spent (steady-confirm) |
|---|---|---|
| page 1 → 2 | **2257ms** | **120ms** |
| page 2 → 3 | **6859ms** | **66ms** |

Then, per page, `settle` (`awaitFieldSetSettled`): **1.3s · 5.9s · 1.9s**.

### The answer: the gap is overwhelmingly WORKDAY, plus one fixed 1.2s window of ours

Our per-transition overhead is **66–120ms** — negligible, and far below the ~1s I predicted from reading
the code. The prediction was wrong because `cdpAdaptiveDelay` already collapses that 500ms poll interval
when the tab measures fast. ⚠ **Do not re-derive this from the code; the adaptive pacing hides it.**

So the ~3 unaccounted seconds break down as roughly: **~0.1s** transition confirm (ours) + **~1.2–1.3s**
settle (ours, a fixed window) + **the remainder is Workday still mounting fields after the page visually
appeared**.

**The load-bearing insight: "the page looks loaded" ≠ "the field set is complete."** Page 2's settle ran
**5.9s** because fields were genuinely still arriving nearly six seconds after the page was on screen.
That is exactly what the settle exists to catch, and it is why the eye disagrees with the engine.

### The only real lever, and its cost

`awaitFieldSetSettled` uses `NO_GROWTH_MS = 1200`: even when the field count is stable on the very first
read, it waits a full 1.2s to prove it. On the stable pages (settle ≈1.3s) that 1.2s is pure proof-cost —
about **1s per page**, so ~4–5s per run. On page 2 (settle 5.9s) it is doing real work and would not be
touched.

⚠ Shortening it is NOT free, and CLAUDE.md flags exactly this: settle polls must use `delayFull`, never
the adaptive beat, because a collapsed window **makes a half-rendered page look stable**. Any change here
trades a fixed ~1s/page against the risk of filling a page whose fields are still mounting — which is a
correctness risk, not a speed one. A safer shape than simply lowering the constant: let the settle COUNT
the stability the transition wait already witnessed, rather than restarting its window from zero.

**Not yet done — deliberately.** The operator's constraint is "don't change behaviour, make existing
behaviour faster", and lowering this window changes when we are willing to start filling.

**DONE 2026-08-10 (`settle-seed-1`), LIVE-VERIFIED.** `cdpWaitNextPage` now hands the settle the field-count
stability it already observed (`{count, since}`) and the settle COUNTS it instead of re-proving it from
zero. The bar is unchanged (still `NO_GROWTH_MS` of an unchanged count). Live: settles **1.2s · 0.5s**
against the previous build's 1.3 · 5.9 · 1.9s, transition `1912ms/188ms`, all M40 audits clean. Four
safety properties, each mutation-checked: a seed that DISAGREES resets the window in full; the credit is
capped so ≥2 of the settle's own 150ms polls always land; the credit is clamped at 0 (unclamped, a
clock-skewed `since` stalls to the 12s ceiling — measured 12096ms); `since` is never earlier than a real
observation.

---

## 2026-08-10 — round 5: ONBOARDING flakiness (retry-heavy clicks + lag) — MEASURED

Operator: *"a lot of buttons that we click need to be retried and maybe some lag during the whole
onboarding situation."* The `[PACE]` instrumentation answers it directly.

### Onboarding paces overrun 40–50× — and the overrun is CONSTANT, not proportional

From one run's onboarding phase (`sw` = the SW timer, which onboarding still uses by design):

| requested | actual | over |
|---|---|---|
| 50ms | **2482ms** | 50× |
| 50ms | 2034ms | 41× |
| 50ms | 2199ms | 44× |
| 50ms | 2577ms | 52× |
| 200ms | 2482ms | 12× |
| 500ms | **3290ms** | 6.6× |

⚠ **The overrun is ~2–2.5s REGARDLESS of what is requested.** That is the single most useful fact here:
the MV3 timer simply fires ~2.5s late, so **lowering a requested pace cannot help** — only changing the
clock can. Onboarding is the one stage still on the starved clock, deliberately: the fill/replay walks
were moved to the page's worker-backed timer (round 2), but onboarding NAVIGATES, and a navigating
document's timer does not fire (that exclusion exists because the un-gated version HALTED a run).

**Why this reads as "buttons need retrying":** `submitAndWait` escalates on a `[500, 20000]` ladder,
where the 500ms rung is a deliberately FAST re-click for a click that landed before Workday enabled the
button. Measured, that rung is **3290ms**. The retry machinery is being timed against a clock that is not
keeping time — the first click's pre-click settle (200ms) is really ~2.5s, and the "fast" recovery is not
fast. `waitFor`'s own comment states the assumption this breaks: *"the reads are fast (~62ms apart —
`pace(500)` scales down when the tab is fast)"*. On a hidden run they are ~1.2s apart.

### The `resume-upload-input` halt: NOT a sampling problem — budget raised 25s → 45s

This halted **three runs in one session**, every time at exactly its **25000ms** hidden budget. It is
tempting (and I initially proposed) to fix it with an attempts floor. **The data refuses that:** those
timeouts did **21–29 reads**, i.e. it looked every ~1.2s — plenty. The control had simply not rendered.
Proof it is variance, not a real failure: the very NEXT run satisfied the same wait in **7.0s** on the
same tenant.

25s was also the SMALLEST hidden budget in the flow, on one of its heaviest pages (Workday mounts an
upload widget, then parses a résumé). Siblings on the same hidden tab already allow far more:
`post-resume-upload(parse)` 50s, `post-continue-application` 45s, `sign-in-form-render` 30s. Raised to
**45s**. The failure direction decides it: too short halts a HEALTHY run and needs an operator; too long
costs seconds on a genuinely broken page before reaching the same halt.

> ⚠ **SUPERSEDED 2026-08-11 — the 45s change was DROPPED when this branch merged `main`.** `main`'s
> `98b99df` had independently fixed the same halt, better: the wait now runs up to **three** budgets and
> **hard-reloads once** in between, and — the deciding difference — a `stillBlank` test stops
> IMMEDIATELY on a page that rendered *something other than* the upload control, so a genuinely wrong
> page no longer pays the full budget at all. A single long budget always paid full freight. Three
> budgets plus the reload also exceed 45s, and the reload covers a wedged SPA bundle that no amount of
> waiting can fix.
>
> **The measurement above still stands and is why the merge kept `main`'s side rather than splitting the
> difference:** the halts were not a sampling problem (existence is monotone — a sparse poll notices
> late, it cannot miss), so an attempts floor was never the lever, and the remaining question was only
> *how* to buy more time. `main` answered that better.

### DONE (`onboard-clock-1`) — the scoped onboarding clock, LIVE-VERIFIED

`waitFor`'s poll loop now arms the page clock for the interval FOLLOWING a successful in-page `scan()`,
and disarms in a `finally`. Self-correcting by construction: navigation is exactly what makes `scan()`
fail, so the one state where the page clock is unsafe is the one state that turns it off; only another
successful scan re-arms it. Onboarding stays globally SW-timed — this is the one loop that opts in, and it
clicks nothing between iterations.

**Live result (cat.wd5, hidden, fresh req):**

| | before | after |
|---|---|---|
| `[PACE]` overruns per run (onboarding) | 5–6, each **2.0–3.3s** | **0** |
| onboarding poll density | ~1200ms/read | **~70ms/read** (57 reads in 4000ms) |
| onboard→form | 18–124s across the session | 34s, no halt |
| outcome | — | REVIEW, 5 pages, **all 5 M40 audits clean**, 1 re-click |

The poll-density line is the load-bearing one: it is BOTH fixes at once. Waits notice their goal ~17×
sooner (the lag), and every wall-clock-bounded budget now gets the sample count it was designed around
(the flakiness, including the retry ladders that were being timed against a clock running ~2.5s late).

⚠ Guarded by a source-level test: arming must be gated on `lastScanOk`, disarmed in a `finally`, and a
failed scan must drop back to the SW timer. Mutation-checked — arming unconditionally (the version that
HALTED a live run) fails the test.

### Superseded shape (kept for the reasoning)

Give onboarding a clock that keeps time. The safe shape is NOT "turn the page clock on for onboarding"
(it hangs mid-navigation, which is why it is excluded) but something narrower: the `waitFor` poll loop
already performs a successful in-page `scan()` each iteration, which is positive evidence the document is
alive and responsive — a page clock is valid for the interval that FOLLOWS such a scan, and the SW timer
should be used everywhere else. ⚠ Verify live before trusting it: an onboarding click can navigate at any
moment, and the abandon ceiling is itself SW-timed, so a mis-scoped page sleep there can be WORSE (~4s)
than the 2.5s drift it replaces.

---

## 2026-08-10 — round 6: the poll-loop audit — THE ATTEMPTS-FLOOR BRANCH IS CLOSED

Round 3 ended with "the systemic fix is the loop shape … it touches ~30 loops". This round actually
enumerated and classified them. **The count was wrong (59, not ~30) and the conclusion is the opposite of
the one round 3 pointed at: no run-path loop in this codebase needs an attempts floor.**

### The criterion

A wall-clock-bounded poll loop is only starved of COVERAGE by a slow clock if the thing it watches can
stop being true. So classify by the PREDICATE, not by the loop:

| class | predicate | what a sparse poll costs | correct fix |
|---|---|---|---|
| **A · rising monotone** | "wait until X exists / holds V" — element mounted, value committed, count grew, rect laid out, page advanced | notices LATE, by at most one interval. **Cannot miss.** | **BUDGET** (never an attempts floor) |
| **B · falling monotone** | "wait until X is GONE" — `closeDropdownConfirmed`'s `optionCount === 0`, entry deleted | same: notices late only | **BUDGET** |
| **C · stability** | "N equal reads" / "no growth for W ms" — every settle | ⚠ **the opposite** — see below | **a minimum wall-clock SPAN** |
| **D · transient** | "true, then false again" | genuinely MISSES it | an attempts floor |

### Result of the sweep: **class D is EMPTY on every run path**

All 59 sites are A, B or C. The two the previous session guessed were transient are not:
`cdpRectReady` / `cdpEvalRectReady` (cdp.js) wait for a rect to BECOME non-zero — a rising edge, class A.
The one genuinely density-sensitive loop is `background.js:2181` in the **dropdown RECON probe**, and it
is density-sensitive because it *samples a curve* (does the option list grow 36→38→40 or render
atomically?) rather than waiting for a condition. It is a diagnostic, not a run path.

**This is architectural, not luck.** Where a true transient matters — a DOM change that happens BETWEEN
two reads — this codebase does not sample at all; it installs a page-side `MutationObserver`
(`cdpInstallQuietWatch`, `cdpInstallGroupWatch` in cdp.js) and reads the accumulated record. That is the
right answer to a transient and it is already in place, which is why no polling loop was ever left
holding one.

⚠ So: **do not add an attempts floor anywhere.** It buys nothing against a class A/B predicate (they
cannot be missed), and against class C it is actively wrong — see below. This closes the item; it does
not defer it.

### The inversion: drift makes settle polls SAFER, and the FAST path is where they are weakest

Class C is the one place sampling density changes an ANSWER rather than a latency — and it runs the
other way from the intuition. A stability poll exits on agreement between reads, so **sparse reads make
a false "settled" LESS likely** (two reads 2.7s apart are stronger evidence than two 40ms apart). The
real hazard is the opposite regime: `cdpAdaptiveDelay` collapsing the interval to ~40ms on a fast tab,
where two agreeing reads can both land inside one mounting pause.

That is why CLAUDE.md's rule is "settle polls use `delayFull`, never `delayRender`" — and it is the same
reasoning that already rejected "invalidate the stability pair on a pace overrun" (the field count grows
monotonically during hydration, so a wider gap is *stronger* evidence). Both point at the same guard:
**a minimum wall-clock SPAN, which is interval-independent.** `awaitFieldSetSettled`'s `NO_GROWTH_MS`
(1200) and `cdpWaitNextPageInner`'s 600ms errors-must-persist window are both exactly this, and both are
already correct.

### Budgets: only one wait had a real timeout on record, and it is already fixed

Re-derived only where there is a concrete failing run to test against, per the standing rule:

| wait | timeouts on record | verdict |
|---|---|---|
| `waitFor(resume-upload-input)` | 3 runs, all at exactly 25000ms | **SUPERSEDED — see below.** Round 5 raised the single budget 25s → 45s; the merge with `main` dropped that for a better fix. |
| `cdpWaitNextPage` (15s) | 2 exhaustions | **unchanged — both were TRUE NEGATIVES** (swallowed Save clicks, recovered by re-clicking). The wait answered correctly; there is nothing here to widen. An attempts floor was rejected separately: 30 polls × 2694ms = **81s per transition** on the walk's most frequent wait. |

### Fixed in passing

- **`background.js:5982` assigned `errSteady`** — an identifier that does not exist. background.js is
  sloppy-mode (no `"use strict"`, and it cannot be strict: `importScripts` shares ONE global scope), so
  it silently created a global and the flicker timer was **never reset on an un-hydrated read**. Effect:
  an `errSince` set before a mid-transition un-hydrated gap survived it, so the 600ms
  errors-must-persist guard could be satisfied by a timestamp from BEFORE the gap — the exact flicker
  that guard exists to reject. Now `errSince = 0`.

### New instruments

- **`polls` is a literal counter** (see the tooling section) and `[TRANSITION]` now prints the ACTUAL
  mean interval next to the requested one, so a starved clock is visible on the line itself.
- **`cdpClockProbe` (`[CLOCKS]`, cdp.js)** — times the SW timer and the PAGE timer over the SAME
  interval, both arms started together, since drift is bursty and two probes minutes apart prove
  nothing. Runs once per page under `debugLagTrace`. Reading: **SW late + page on time ⇒ the worker is
  starved and the tab is fine**; both late ⇒ the tab really is throttled.
  ⚠ Its `page-perf` column is `performance.now()`, which is REAL TIME — it keeps advancing through a
  freeze. It is **not** a freeze detector, and reading it as one would answer "no freezing" every time.
  Freeze is callback LATENESS (the `PAGE` column). It does earn its place for two narrower things:
  confirming our SW-side `Date.now()` readings are honest, and catching a document REPLACEMENT (a
  navigation resets the time origin → a nonsense delta).
- **`warnNoWorkerTimers` — a loud `console.warn` banner** when the worker-timers polyfill fails to
  install. The `hidden-SLOW (no worker timers)` regime is a documented code path that has **never once
  been observed on a Workday tenant**, yet waits keep getting hardened against it. Now it announces
  itself: banner absent ⇒ the regime is not in play and nothing needs to defend against it; banner
  present ⇒ a uniformly slow run is explained rather than mysterious.

### LIVE VERIFICATION (cat.wd5 `R0000387234-1`, hidden, fresh req, build `clock-probe-1`)

`✓✓ reached the REVIEW page after 5 page(s)`. All five `[CLOCKS]` and five `[TRANSITION]` lines
produced. The tracker push 401'd (stale ingest key — a known, unrelated issue), which does not affect
the measurements. One prior run halted `auth-unknown` at onboarding and a plain re-run signed straight
in, exactly as the `live-testing` skill documents.

**`[CLOCKS]`, all five pages, pre-fill:**

| page | SW | PAGE | page-perf | worker-timers |
|---|---|---|---|---|
| 1 | 271ms (+21) | 271ms (+21) | 269ms | ON |
| 2 | 260ms (+10) | 260ms (+10) | 259ms | ON |
| 3 | 261ms (+11) | 262ms (+12) | 260ms | ON |
| 4 | 270ms (+20) | 270ms (+20) | 263ms | ON |
| 5 | 256ms (+6) | 273ms (+23) | 265ms | ON |

`worker-timers ON` every page ⇒ **the `hidden-SLOW` banner correctly never fired**, which is the
negative confirmation that regime is still not in play on this tenant.

⚠ **But read what this does and does NOT establish — the first version of this instrument oversold
itself twice, and both faults are now fixed:**

1. **The probe sampled the calm, then reported the calm.** Every pre-fill sample read both clocks
   healthy — while the SAME run logged `delayFull(600ms) actually took 1312ms — 712ms OVERRUN`
   mid-fill. Pre-fill is the quietest instant on the page, so one sample there structurally cannot see
   a bursty stall. **Fixed:** the probe now also fires POST-fill, bracketing the fill. Two samples
   still cannot prove absence, but they can CATCH a burst, which one provably could not. So these five
   rows are **not** evidence that the run was free of starvation — the `[PACE]` line proves it was not.
2. **The log line printed the LEGEND, not the verdict.** Every line ended with the full
   "SW late + PAGE on time ⇒ the worker is starved and the tab is FINE …" explanation — including the
   lines where nothing was late, i.e. asserting a conclusion the sample contradicted. **Fixed:** the
   line now computes the verdict from its own numbers, and the all-clear case says so explicitly,
   including that drift is bursty so a quiet sample does not clear the run.

**What the five samples DO establish:** at each page's pre-fill instant, page timers and the SW timer
agreed to within 6–23ms of a 250ms request, and `page-perf` tracked both — so at those instants the
tab was neither frozen nor throttled, and our SW-side `Date.now()` readings are honest. That is a real
if narrow result, and it is consistent with the standing model (bursty SW starvation on an otherwise
healthy tab), not a refutation or a confirmation of it.

### Confirming run (cat.wd5 `R0000385755`, hidden, fresh req, build `clock-probe-2`)

Both fixes verified live. `✓✓ reached the REVIEW page after 5 page(s)`, **10 `[CLOCKS]` samples**
(5 pages × pre + POST), the verdict now computed per-sample, and the worker-timers banner still silent.

**This run was genuinely quiet** — its two worst paces were `delayFull(150ms)` at 462ms and 327ms
(both under the 400ms verdict threshold) and there were **zero `[PACE]` warnings**. So 10 all-clear
samples here are the instrument being CORRECT, not blind. The blind spot is the one run 1 exposed and
the POST-fill sample now addresses. Neither run has yet CAUGHT a burst in the act; that remains open,
and the honest statement is "not yet observed by this probe", not "not happening".

**The transition counts confirm the understatement finding, harder:**

| transition | counted | actual mean | requested | old estimate |
|---|---|---|---|---|
| 1 → 2 | **76** | 84ms | 500ms | ~13 (**5.8× low**) |
| 2 → 3 | 60 | 86ms | 500ms | ~10 |
| 3 → 4 | 30 | 113ms | 500ms | ~7 |
| 4 → 5 | 22 | 81ms | 500ms | ~4 |
| 5 → 6 | 23 | 172ms | 500ms | ~8 |

Across both runs the true interval was **77–551ms against a 500ms request** — i.e. `cdpAdaptiveDelay`
usually collapses it to ~1/5 of nominal on a hidden tab. Coverage was never the problem it was
theorised to be: these transitions take **22–76 reads**, not the ~3–14 the estimate implied.

---

## 2026-08-11 — round 7: the NON-WORKDAY (ATS) path — what transfers, and what does NOT

First look at Greenhouse / Lever / Ashby (`ats.js`) with the Workday lessons in hand. **The headline is a
refutation of my own change: the page clock does NOT transfer to the ATS path.**

### The ATS path is a genuinely different shape — check this before porting anything

| | Workday | ATS |
|---|---|---|
| actuation | trusted `Input.*` (synthetic when hidden) | **page-side synthetic always**, via `Runtime.evaluate` |
| pacing inside the fill | `act.delay` (SW) everywhere | page-side `sleep()` inside injected code |
| SW poll loops | 28 in background.js + 28 in fill-driver.js | **`ats.js` has ZERO** |

So the fill loop itself is NOT on the starved MV3 clock, and most of Workday's pacing work has nothing to
bite on here. What IS SW-side is the DRIVER: `waitAtsFormReady` (450ms beat), `waitAtsPostingSettled`
(300ms), and the post-navigate settles.

### Drift IS present in the driver — measured

Live, hidden Greenhouse (Roblox) run, with `[PACE]` (always on, no flag):

```
a 450ms pace took 2987ms (sw)     ← waitAtsFormReady, 6.6× over
a 1000ms pace took 3045ms (sw)
```

Real, and it is not merely latency: `waitAtsFormReady` accepts on **three consecutive equal reads**, so a
6.6× beat pushes acceptance from ~900ms to ~6s and its deliberate 2500ms floor stops being what binds.

### ✖ REFUTED — arming the page clock there made it WORSE (do not retry)

I applied the onboarding precedent exactly: arm the page clock only for the interval FOLLOWING a
successful in-page scan, disarm in a `finally`. Measured, same posting, same conditions:

| | pace overruns | shape |
|---|---|---|
| SW clock (before) | **2** | both `(sw)` |
| page clock (after) | **5** | mostly **`page-abandoned`** |

The ATS settle runs immediately after a NAVIGATE, and that is the one state round 3 already identified:
**neither clock is clean during a navigation.** The page arm hangs, and the abandonment ceiling is itself
an SW timer, so each hang costs `want + slack` measured late.

**The flaw in my gate, worth stating because it looked airtight:** a successful `cdpEval` proves the
document EXECUTES, not that its TIMERS fire. `Runtime.evaluate` is not timer-driven. On a freshly
navigated document those two come apart, which is exactly where this was armed. Reverted.

### ⚠ And what the run-to-run numbers do NOT prove

The page-clock run also measured `fill 78.7s` against the previous `fill 23.9s` — a 3.3× regression it
would be very easy, and wrong, to pin on the change. The breakdown says otherwise:

```
run 1 (sw):   23.9s / 26 fields — slowest: candidate-location 9.3s, school--0 3.6s
run 2 (page): 78.7s / 26 fields — slowest: school--0 60.9s, candidate-location 8.0s
```

The entire difference is **`school--0`, a server-backed react-select** whose own search hung — and the
change touched only the two settle loops, never the fill's option poll. LLM was fast in both runs
(750–807ms), so the standing "a slow page is the LLM until proven otherwise" rule is also cleared here.
**One run each cannot separate a code change from a widget with that much variance**; the refutation above
stands on the pace-overrun mechanism, which is independent of it.

### The real ATS costs, as measured (baseline for anyone tuning this)

- `fill 23.9s for 26 field(s) — 919ms/field` on a healthy hidden Greenhouse run.
- **`candidate-location` 8.0–9.3s on BOTH runs** — the known GH places field. Consistent, so it is the
  best-characterised target here.
- **`school--0` 3.6s → 60.9s across two runs of the SAME posting** — a server-backed combobox is the
  dominant and least predictable cost on this path. Any ATS timing claim needs several runs.

### ✖ SUPERSEDED — "HIDDEN IS ~2.4× SLOWER THAN VISIBLE ON ATS" — REFUTED by round 8, read that instead

⚠ **The claim in this subsection is WRONG and the numbers under it are one run per arm.** Round 8 ran the
controlled test (4+4 alternating, with an order-reversed pair and an idle no-tab control) and found NO
hidden LLM penalty: the 2.4× was provider variance plus an ordering artefact — **the second run of a pair
is slower whichever arm it is.** Kept, unedited below, because the reasoning is the honest record of what
one run per arm looks like when it misleads you. The rest of round 7 stands.

The operator's question: Workday hidden ≈ visible, is that true here? **No.** Same Greenhouse posting,
same build, back-to-back:

| | fill | ms/field | slowest field |
|---|---|---|---|
| hidden ×3 | 77.5s · 78.7s · 86.1s | ~3000ms | ONE widget hitting **34–61s** |
| **visible** | **32.8s** | **1263ms** | candidate-location 8.4s — nothing hanging |

The shape matters more than the ratio: hidden runs are not uniformly slower, they have **one
server-backed combobox hanging to its ceiling, and a DIFFERENT one each run** (school--0 60.9s, then
question_68143084 34.1s, then degree--0 19.3s + three questions). Visible runs have no such outlier.

⚠ The `ats-tenants` skill says "visible and hidden runs are IDENTICAL". That is true of the ACTUATION
MECHANISM — all three ATSs commit from synthetic events either way — and it is **not** true of
wall-clock. Do not read the mechanism claim as a timing claim.

**Eliminated: the `hidden-SLOW (no worker timers)` regime.** Every ATS run logged `CSP bypass ON ·
worker-timers ON`, and the loud `warnNoWorkerTimers` banner never fired. So the polyfill IS installed and
page timers ARE worker-backed — the Workday mechanism that makes hidden≈visible is working here and is
still not enough.

### ✖✖ THE CAUSE IS THE LLM, NOT THE FORM — both hypotheses above were WRONG (same day)

I proposed two fixes — a layout-independent option poll, then restoring `Page.startScreencast`. **Both
were aimed at the wrong thing, and the field-level log said so immediately.** Recorded in full because
the reasoning was plausible and someone will re-derive it.

**1. The option poll is ALREADY layout-independent.** `atsInjReadOptions` (ats.js) is pure
`querySelectorAll` + `textContent` — no `getBoundingClientRect`, no visibility test. "Read the
unpositioned menu" is what it already does, so there was nothing to fix.

**2. The hung field was never a widget.** The slowest field in the worst hidden run:

```
question_68143084 (dropdown, req) → filled_review · ai-choice · "Python 3" · 34113ms   ← hidden
question_68143084 (dropdown, req) → filled_review · ai-choice · "Python 3" ·  2911ms   ← visible
```

`ai-choice` — an LLM call. On that same run `school--0` read `loading false · waited 417ms/2 reads ·
1253ms`: the combobox was FAST. The per-call `[LLM]` numbers confirm it outright:

| run | LLM per call | fill |
|---|---|---|
| early hidden | 831 · 1959 · 732 · 972ms | **23.9s** |
| hidden ×3 | 7734 · 9332 · 11521 · 12223 · 13845 · 13976 · 14984 · **34006**ms | 77–86s |
| visible | 1207 · 2853 · 5778 · 8102ms | **32.8s** |

This form has ~4–5 `ai-choice` dropdowns, so +10–30s per call IS the whole gap. **The
standing rule caught this and I nearly walked past it: subtract the `[LLM]` line before blaming a
tenant, the DOM, or the fill code.** It applies to the ATS path verbatim.

**⚠ What is still NOT established: that VISIBILITY causes it.** The 23.9s baseline was *also hidden*, with
fast LLM calls — so "hidden ⇒ slow LLM" does not hold. Provider latency is the documented biggest random
variable here (486ms → 30657ms on identical config, same model, same session). One visible run cannot
separate a visibility effect from ordinary provider variance, and the visible run being the LATEST also
argues against simple time-based degradation. **Do not "fix" hidden-tab ATS speed until this is settled.**

**The controlled test that would settle it:** alternate hidden/visible several times on one posting and
compare the `[LLM]` latency DISTRIBUTIONS, not the fill totals. If a visibility effect is real the
mechanism must be MV3-worker starvation (the LLM call is issued from the service worker and never touches
the tab), which the `[CLOCKS]` probe can corroborate — high SW drift during hidden runs, low during
visible. If the distributions overlap, this is provider noise and the ATS path has no hidden penalty at
all.

### Already refuted elsewhere — do not redo (see the `ats-tenants` skill)

The 2.5s `waitAtsFormReady` floor (replacement instrumented and refuted — no observable signal separates
"finished" from "quiet before the next burst"); screencast forcing; porting `cdpScrapeTaOptions` (these
menus are not virtualized).

---

## 2026-08-11 — round 8: the ATS hidden penalty — ✖ REFUTED, and what the real numbers are

Round 7 left one thing open: *"hidden is ~2.4× slower than visible on ATS"* rested on 3 hidden runs
against **one** visible run, and round 7 itself flagged that one visible run cannot separate a
visibility effect from provider variance. This round ran the controlled test. **There is no hidden LLM
penalty on the ATS path.** The 2.4× was provider variance plus an ordering artefact.

### What was run

4 hidden + 4 visible, alternating, on ONE posting, build `llm-dist-3`, plus **5 idle control probes**.
Every run's visibility is the MEASURED `[ATS-PACING]` label + the `[ATS-TIME]` paint label, never the
`background` flag — and all 8 agreed with intent (`hidden-fast (worker timers)` / `visible-fast`).

Both arms were treated identically: fire, wait out the run **without touching Chrome**, then read. That
matters — polling the dev tab activates it, which would have made the "visible" arm hidden, and polling
only the hidden arm would have loaded the worker asymmetrically.

### ★ The new instrument that settles it: an IDLE control arm (`AP_DEV_LLM_PROBE`)

Hidden-vs-visible cannot answer "whose fault is the latency", because **both arms are measured while a
run drives a tab**. The probe fires N calls through the same `act.llm` seam — same route resolver, same
key rotation, same fast-retry, same `[LLM]` lines — with **no tab, no attach, no fill**. Three-way:

| arm | n | min | p25 | **median** | p75 | max | mean |
|---|---|---|---|---|---|---|---|
| hidden | 28 | 7907 | 10143 | **11203** | 13192 | 45005 | 13333 |
| visible | 28 | 1717 | 11328 | **14438** | 18539 | 47042 | 15795 |
| **idle (no tab at all)** | 21 | 9658 | 10977 | **11922** | 15727 | **46777** | 14800 |

The idle arm lands **between** the two run arms, and `visible vs idle` is indistinguishable
(Mann-Whitney p=0.303). A visible tab costs nothing relative to having no tab — so there is no
tab-driven mechanism to find. The tail says it fastest: **the three slowest calls of the session are one
from each arm** — visible 47042ms, **idle 46777ms**, hidden 45005ms. A 46.8s call with no tab open is
provider latency and cannot be anything else.

### ★ The ordering confound — and the pair that broke it (the decisive result)

In pairs 1–3 hidden ran FIRST and visible SECOND, so "visible slower" was perfectly confounded with
"second-in-pair slower". **Pair 4 was deliberately run V-then-H:**

```
idle-A 15.9s | H1 12.0s → V1 18.6s | idle-B 10.9s | H2 10.6s → V2 12.5s
idle-C 12.2s | H3 11.3s → V3 16.5s | idle-D 11.5s | V4 15.6s → H4 19.5s | idle-E 23.2s
                                                    ^^^^^^^^^^^^^^^^^^^ order reversed
```

**In all four pairs the SECOND run was slower — whichever arm it was.** Reverse the order and the
penalty follows the *slot*, not the visibility. `H4` (hidden, second) was the slowest run of the whole
session at **156.6s**, and `idle-E` right after it was the slowest idle set (23.2s mean) — the provider
degraded through the session, and both run arms and the no-tab arm degraded with it.

So the raw `hidden vs visible` p=0.021 is an artefact of hidden systematically occupying the earlier,
faster slot in 3 of 4 pairs. ⚠ **Do not read that p-value as an effect.** It is what a confound looks
like when you have not controlled it yet.

### The decomposition — where ATS fill time actually goes

| | LLM | everything else | total |
|---|---|---|---|
| hidden mean (n=4) | — | **19.9s** | 113.2s |
| visible mean (n=4) | — | **14.1s** | 124.7s |

**The LLM is 76–91% of the entire fill.** Per run: `100.1s = 84.0 LLM + 16.1 ours`,
`156.6s = 136.6 LLM + 20.0 ours`, `121.7s = 108.9 LLM + 12.8 ours`. Any ATS timing claim that does not
subtract the `[LLM]` line is measuring the provider and calling it a tenant.

**The one real, reproducible hidden cost is in OUR non-LLM work, and it is small:** hidden
`{16.1, 19.2, 24.2, 20.0}` vs visible `{13.1, 13.2, 17.2, 12.8}` — **1.41×, a 5.8s gap** on a 25-field
page (~230ms/field), the two sets nearly non-overlapping. Exact Mann-Whitney (n=4 each, normal approx
invalid this small) gives **p=0.057 — suggestive, NOT significant.** Note this is the *opposite
magnitude* to round 7's claim: ~5% of the fill, not 140%. Worth a dedicated round only if the LLM cost
below is fixed first; until then it is inside the noise of a single LLM call.

⚠ **My own instrument is asymmetric here — checked, and it is too small to matter.** The `[ATS-PACING]`
line I added calls `cdpPacingLabel()`, which returns immediately for a VISIBLE tab but for a hidden one
also runs `cdpTimersFast()`. That probe races against `cdpDelay(TIMER_FAST_MS)` with `TIMER_FAST_MS=200`,
and every hidden run reported `hidden-fast`, which BY DEFINITION means the probe won the race — so the
hidden-only cost is **<200ms, ~3% of the 5.8s gap** (and `_timerLatCache` means the run would have paid
it anyway the first time it asked). The gap is not my instrument. Stated because a one-sided
instrumentation cost landing in exactly the residual you are measuring is the easy way to invent an
effect.

### ⚠ MEASUREMENT TRAP — `ok in Xms` is NOT the call's cost

`[LLM] ok in 855ms (11021ms total across 2 attempt(s))` — the first number is the **winning attempt**,
not what the fill waited. That call cost **11021ms**: `gemini-3.1-flash-lite` returned **HTTP 503** after
10166ms and it fell back to `gemini-3.5-flash-lite`, which answered in 855ms.

Parsing `ok in` cost me a wrong intermediate table in which three 503-fallback calls read 716/777/855ms —
they were really 12266/15886/11021ms. It understated hidden totals and inflated the non-LLM residual
(H4 read 45.3s of "our" time that was actually LLM). **Always parse `(\d+)ms total across`.** Corrected
numbers are the ones above.

### ★ THE ACTUAL LEVER — the fast-retry is misfiring on ~every call (~24% of the fill)

**76 of 77 calls this session exceeded 4s**, i.e. spent BOTH 2s fast tries before the attempt that
answered. At 7 AI calls per page that is **~28s of pure overhead per run — ~24% of an average 118.9s
fill**, and it is the largest single recoverable cost measured on this path.

The rule's premise is currently FALSE. `LLM_FAST_RETRY_RULES` reasons that "observed answer time is well
under 1s, so a call still running at 2s is a stuck socket, not a slow model" — but the honest answer time
this session was **~7–13s** (idle median 11.9s, with no tab in play). Every call therefore looks like a
stuck socket and pays 4s to learn it isn't.

**Its safety invariant held perfectly** — every one of the 77 calls SUCCEEDED, because once the fast tries
are spent the next attempt gets the full budget. So this is purely a LATENCY mistune, never a correctness
or coverage problem, which is exactly why it is safe to tune. **NOT changed here:** the 2000ms is
unit-pinned by two tests and it is the operator's design call. Options, cheapest first: make the cap
adaptive off a rolling p50 of recent answers (the data to do it is already logged), raise it for the
gemini rule, or gate fast-retry on the primary model's recent 503 rate. The 503s are the real signal —
the provider was unhealthy, not the socket.

### The fixture died mid-investigation — check this before reusing round 7's URL

`job-boards.greenhouse.io/roblox/jobs/8072713` (round 7's posting, filled 26 fields hours earlier)
**now 302s to `careers.roblox.com/jobs/8072713`**, UA-independent. That page loads fully with **0 inputs,
0 selects, 0 iframes** and a JS-only "Apply Now" — the Greenhouse form is unreachable.

⚠ **`atsPostingGone` does NOT catch this.** It asks whether the requested job id is still in the landed
URL, and `careers.roblox.com/jobs/8072713?gh_jid=8072713` still contains `8072713`. So a run proceeds and
tries to fill an employer careers page as if it were Greenhouse. Worth a follow-up: an off-HOST redirect
away from the ATS domain is evidence in its own right, independent of the id.

Replacement fixture, verified serving the form directly on the GH host:
**`job-boards.greenhouse.io/cloudflare/jobs/7902104`** (Accounting Intern, Fall 2026) — 35 inputs, 27
`question_*` ids, 15 comboboxes, **7 `ai-choice` LLM calls per run**, 25 fields filled, stable across 9
consecutive runs. Found by probing `boards-api.greenhouse.io/v1/boards/<co>/jobs/<id>?questions=true` for
a board that does not redirect off-host; `databricks`, `duolingo`, `asana` and `samsara` all redirect,
`discord`, `figma`, `airtable`, `reddit` and `cloudflare` do not.

### New instruments (both kept)

- **`AP_DEV_LLM_PROBE`** (`{type, n}`) — the idle control arm described above. Refuses while a run is in
  flight. Logs `[ApplyPilot][LLM-PROBE]`.
- **`[ATS-PACING]`** — `runAtsApplicationRun` now logs `cdpPacingLabel()` the way the Workday path
  already did. The ATS path previously logged no visibility at all, so every hidden-vs-visible claim
  about it rested on the caller's `background` flag, which is an INTENTION and not an observation.

### Do NOT redo

- **Hidden-vs-visible on the ATS path.** Settled: no LLM effect; our own non-LLM work is ~5.8s
  (p=0.057) cheaper visible, i.e. ~5% of a fill. Round 7's 2.4× is refuted.
- **Believing a hidden/visible ATS comparison that does not control ORDER.** The second run of a pair
  is slower whichever arm it is; the provider drifts on a timescale of minutes.
- **Reading `[LLM] ok in Xms` as a call's cost.** Parse the total across attempts.
- Everything in round 7's own "do not redo" list (the page clock here, the option-poll "layout" fix,
  `Page.startScreencast`, attempts floors).

---

## 2026-08-11 — round 9: WHY the call took 10s — it was the MODEL, and three fixes landed

Round 8 proved the LLM was 76–91% of an ATS fill and that visibility had nothing to do with it. It did not
answer the operator's actual question: *"why did a 3.1-flash-lite call take 10 seconds? on Workday it is
usually half a second."*

### ★ THE ANSWER: one sibling model was degraded server-side. Measured, not inferred.

The decisive test is an A/B **on the same key, in the same minute, alternating** — so key, network, tab,
prompt, token count and our own code are all held fixed and only the model varies:

| call | model | latency |
|---|---|---|
| 1 | `gemini-3.1-flash-lite` | **11499ms** |
| 2 | `gemini-3.5-flash-lite` | **409ms** |
| 3 | `gemini-3.1-flash-lite` | **7620ms** |
| 4 | `gemini-3.5-flash-lite` | **682ms** |
| 5 | `gemini-3.1-flash-lite` | **10903ms** |
| 6 | `gemini-3.5-flash-lite` | **395ms** |

**A 20× gap between two same-price, same-quota siblings on one free key.** `gemini-3.1-flash-lite` was
also returning **HTTP 503** ("overloaded", once after 10166ms). So:

- **NOT rate limiting.** Both models shared the key and 3.5 was instant throughout.
- **NOT the free tier, the network, our code, the tab, or ATS-vs-Workday.** Round 8's idle no-tab arm had
  already removed those, and a tiny 16-token prompt was just as slow.
- **NOT "the provider" as a whole** — which is where round 8's own standing rule stops being precise
  enough. *A slow page is the LLM* was right; the LLM is not one thing. **Latency belongs to a
  provider+MODEL, and siblings diverge by 20× for hours.**
- The "on Workday it's 0.5s" memory is a **different day**, not a different pipeline: the 486/646/796ms
  figures are from 2026-08-09 when 3.1 was healthy.

⚠ **The operator's AI page had 3.1 as PRIMARY with 3.5 as fallback** — the reverse of
`GEMINI_STARTER_CHAIN`. So every call paid the degraded model first and only reached the fast one when the
slow one outright failed.

### Also measured: only ONE of two keys was ever used

Both keys are free tier, and rotation **only advances when a key FAILS** — so `orderLlmKeys` put the same
key first every time. Across 6 consecutive calls, key 1 served all 6 and **key 2 was never touched.** The
operator independently hit the consequence: *"sometimes I call AI 16 times per minute, the limit is 15."*
Free-tier Gemini meters **15 requests/minute PER KEY**, so the account held 30/min of headroom and was
breaching a 15/min limit inside half of it.

### The three fixes

**1. ADAPTIVE fast-retry cap (`llm.js`).** Round 8 measured 76/77 calls spending both 2s fast tries
(~4s wasted per call, ~28s per page, ~24% of the fill). The static 2000ms was tuned for a ~650ms p50 and
misfires the moment that changes. The cap now follows the observed p50 of recent answers, and **switches
OFF entirely when no short cap could separate "stuck" from "slow"**.

The reasoning that sets it is `P(stuck | still running at the cap)`, not "is the model slow": at a 650ms
p50 almost nothing healthy reaches 2000ms, so a trip is near-certainly a stuck socket and the abort is
close to free; at an 11s p50 EVERY call trips it, so the abort is paid by all and rescues none. `K=3` is
calibrated, not picked: 3 × 650ms ≈ the hand-chosen 2000ms. Cold worker ⇒ the static value, unchanged.

**2. AUTO model (`llm.js` + the AI page).** Model id `"auto"` resolves per call. **Ordered preference with
failover**, per the operator — 3.5-flash-lite is always tried first and a sibling is only reached on
evidence: a **503/5xx sidelines** a model for 2min, or a sibling answering **≥3× quicker** demotes it.
⚠ 429/401 deliberately do NOT demote a model — those are the KEY's problem, and demoting the operator's
primary over a per-key quota would be plainly wrong.

**Recovery is the part that needed a second pass, and the operator caught it** ("make sure it doesn't stay
on 3.1 if 3.5 comes back"). The first cut re-probed on staleness but read the WHOLE window, so a re-probe
dropped one fresh fast sample among four stale slow ones, the MEDIAN stayed slow, and a recovered model
needed ~5 probes ≈ **75 minutes** to win its traffic back. Fixed by bounding reads to
`LLM_AUTO_STALE_MS` (15min, inside the operator's "10–20 minutes" ask): **stale measurements are DISCARDED,
not averaged with fresh ones.** A demoted primary therefore ages back to "unmeasured", returns to the front,
and **the next real fill call IS the probe** — no timer, no calls the fill wasn't already making, nothing
running while idle. `LLM_AUTO_MIN_SAMPLES=2` (vs the cap's 4) so re-confirmation costs ~1–2 calls.

**3. PER-SLOT KEY PINNING (`keyId`, AI page → `resolveLlmRoute` → `callLLM`).** Every model slot gets a
**Key** dropdown ("Any key (rotate)" by default). Pinning the primary to key A and its fallback to key B
spends **two** per-minute budgets. The pin is STRICT for the slot — the isolated budget IS the feature, so
it must not spill — and resilience comes from the next slot carrying its own key. An id matching no stored
key is **IGNORED, never obeyed**, so deleting a key degrades to rotation rather than disabling the slot.
`keyId` is part of a slot's dedupe IDENTITY in `resolveLlmRoute`: without that, "3.1 on key A → 3.1 on
key B" collapses to one attempt and the second key is silently discarded.

### LIVE VERIFICATION (build `auto-model-1`)

```
auto → gemini-3.5-flash-lite · 448ms · 669ms · 0 fast-retry aborts
      (same probe on 3.1: 7620–11499ms, 2 aborts every call)
pin  → pinKeyId=<key 2> · 544ms · 508ms · both served by KEY 2
      (before: 6/6 calls served by key 1, key 2 never touched)
```

So the fix chain is worth **~11s → ~0.5s per AI call**, and on a 7-call ATS page that is the difference
between a ~120s fill and a ~25s one. `npm test` 1366/1366 · web 273/273 · `tsc` clean. Every behaviour above
is unit-pinned AND mutation-checked (reverted, confirmed the test FAILS, restored).

### New instrument

**`AP_DEV_LLM_PROBE` grew an A/B mode**: `{n, models:[…], pinKeyId}` calls each model **directly** and
alternates them round-robin, and reports the resolved route + key tiers from the AI page.
Direct is the whole point — `act.llm`'s fallback chain silently answers from the NEXT model when the first
is slow, which makes "model X is slow" unmeasurable. It also accepts `"auto"`, so the picker can be
verified without editing the config under test.

### ★ HIDDEN vs VISIBLE, RE-MEASURED with the LLM no longer dominating — still NO hidden lag

Round 8's hidden-vs-visible ran while the LLM was **76–91% of the fill**, which is a bad place to look for
a ~6s effect in our own code. With AUTO picking a healthy model the LLM drops to **17–27%**, so the
non-LLM work is finally the visible term. Re-ran 3 hidden + 3 visible on the same posting, build
`auto-model-1`, every run's visibility measured from its own `[ATS-PACING]` + paint label:

| run | arm | fill | LLM | everything else | slowest field |
|---|---|---|---|---|---|
| H1 | hidden | 20.0s | 5.3s (27%) | 14.7s | candidate-location 7.9s |
| H2 | hidden | 21.9s | 5.1s (23%) | 16.8s | candidate-location 11.1s |
| H3 | hidden | **32.4s** | 5.4s (17%) | 27.0s | candidate-location 9.2s · country 6.3s |
| V1 | visible | **62.8s** | 15.0s (24%) | 47.8s | question_68396682 29.3s · candidate-location 20.3s |
| V2 | visible | 18.6s | 4.7s (25%) | 13.9s | candidate-location 7.1s |
| V3 | visible | 17.5s | 4.7s (27%) | 12.8s | candidate-location 7.1s |

**fill MEDIAN: hidden 21.9s · visible 18.6s (0.85×). Best run: hidden 20.0s · visible 17.5s.**
**LLM per call is now indistinguishable between arms — hidden median 692ms, visible median 682ms.**

**Verdict: there is no hidden lag on the ATS path.** The 3.3s median gap is well inside the per-run
spread, and **each arm produced exactly ONE outlier** — H3 at 32.4s and V1 at 62.8s — so "one arm has
hanging widgets" does not hold either. V1's 62.8s decomposes into one 10960ms LLM call plus
`candidate-location` at 20.3s against 7.1s on the two neighbouring visible runs.

⚠ **And it points the opposite way to round 8's own residual.** Round 8 measured non-LLM hidden 19.9s vs
visible 14.1s (hidden +5.8s, p=0.057, "suggestive"); this round measures non-LLM **hidden 19.5s vs visible
24.8s** — hidden now *cheaper*. Two measurements disagreeing in DIRECTION is the same noise signature that
killed round 7's 2.4× claim. **Treat the round-8 residual as unproven and do not build on it.** The real
variable on this path is `candidate-location` (7.1–20.3s across six runs of one posting), which is a
server-backed places lookup and arm-independent.

**What the whole fix chain is worth, hidden:** old build mean **113.2s → 21.9s median, 5.2×.** Composed of
the adaptive cap (~28s: seen live as `fast-retry cap … OFF — observed p50 8407ms over the last 4 answers`,
after which that run's LLM totals dropped from 17583/11728/11048/13823ms to 3540/7769/5511ms) and AUTO
(~11s → ~0.7s per call, 7 calls a page).

### ✔ FIXED — "auto" now expands to ONE ATTEMPT PER CANDIDATE, so failover happens IN-CALL

**The bug, found on the operator's own config the moment they switched to Auto:** `resolveLlmRoute`
returned a route of **length 1**. `keyId` is part of a slot's dedupe identity, and two `auto` slots with
the same (empty) `keyId` are identical, so the fallback collapsed. `auto` also resolved to ONE model, so
that single slot was the LAST attempt — and `act.llm`'s loop over the attempt list IS the in-call failover.
Net effect: a persistent 503 ended the call unanswered (field → review) and the sibling was only reached
by a LATER call via the 2min sideline. Strictly weaker than the stated intent, which wants per-CALL
failover: *"try 3.5 first and if it is busy, errors, or something else, then go to 3."*

**The fix** (`llmExpandAutoAttempts`, llm.js — pure, so it is unit-tested rather than living inline in
cdp.js which no Node test can require): one `auto` slot expands to one attempt per candidate, in
`llmAutoOrder`'s health rank.

```
before:  [ {gemini, "auto"} ]                  → attempts: [ 3.5-flash-lite ]            ← no fallback
after:   [ {gemini, "auto"} ]                  → attempts: [ 3.5-flash-lite, 3.1-flash-lite ]
```

Four properties, each unit-pinned and mutation-checked:

- **Health-ranked, not static** — a sidelined primary drops behind the sibling but is kept as a LAST
  RESORT rather than dropped, because a degraded answer beats none (a failed AI call blanks a required
  field and halts a walk).
- **`keyId` rides onto every expansion**, so Auto and per-slot pinning COMPOSE: an auto slot pinned to key
  A becomes `3.5@A → 3.1@A`. Two auto slots on different keys give all four combinations, and attempts
  differing only by KEY survive the dedupe — that is the free tier's per-key minute budget.
- **Re-deduped**, because expansion can collide with a concrete slot the operator also configured
  (`[auto, 3.1] → [3.5, 3.1, 3.1]`); a duplicate is a wasted request on a model that just failed. This
  also makes the original dedupe bug **moot** — one slot already supplies both models.
- **Expanded per CALL, never written to storage.** The order is an observation; freezing it into the saved
  config is exactly what must not happen.

⚠ **The one real behavioural trade, stated because it is not a pure bugfix.** `act.llm` passes
`noRetry: !isLast`, so every attempt but the last fails fast. Previously a lone `auto` slot was last and
its model got the FULL retry ladder (~75s worst case) and never reached the sibling; now it gets one shot
and the sibling takes over holding the ladder. That is faster and likelier to answer — the same
"rotation before waiting" reasoning key rotation already uses — but it IS less persistence on the
preferred model.

**LIVE VERIFIED** (build `auto-expand-1`, hidden Greenhouse run):

```
[LLM] gemini gemini-3.5-flash-lite (auto) thinking:off for "fill" (2 keys) [attempt 1/2]
```

`[attempt 1/2]` is the proof — that suffix only prints when `attempts.length > 1`, and before this change
the same config produced no suffix at all. All 7 calls answered on attempt 1, so attempt 2 never ran:
**the healthy case still costs exactly one request.**

⚠ That run also took 67.8s, and it is worth recording why rather than reading it as a regression: its LLM
calls were `629 · 656 · 671 · 723 · 8257 · 18131 · 5718`ms — **3.5-flash-lite had its own slow spell
mid-run** — plus `candidate-location` at 11.7s. The expansion issued zero extra requests. So the preferred
sibling is not permanently fast either, which is the case AUTO's health tracking and this in-call failover
both exist for.

### Do NOT redo

- **Blaming "the provider" without naming the MODEL.** Siblings diverge 20×. A/B them on one key.
- **Reading a 429 as model ill-health.** It is the key's per-minute quota; 5xx is the model's.
- **Assuming rotation spreads load.** It advances only on FAILURE, so N equal keys still means one key.
- **Hidden-vs-visible on the ATS path.** Measured twice now, on builds where the LLM was 76–91% and 17–27%
  of the fill, and the residual flipped sign. No hidden lag; stop looking for one.
- **Measuring anything on this path with fewer than ~3 runs per arm.** `candidate-location` alone spans
  7.1–20.3s on one posting.

---

## 2026-08-11 — round 10: DEFERRED AI on the ATS path — one call per page instead of N

Rounds 8 and 9 attacked how long each LLM call takes (adaptive fast-retry, AUTO model, key pinning:
~11s → ~0.5s per call). This round attacks **how many calls a page makes**, which nothing had touched.

### The shape that was there, and what was wrong with it

`ats.js` fired ONE call per unanswered field — 7 on the cloudflare fixture, all `ai-choice`. Since
2026-08-05 they ran 4-at-a-time (`atsPrefetchAiText`), which hid latency. It did not reduce REQUESTS,
and requests are the scarce thing:

- **Rotation does not spread them.** Round 9 measured 6/6 calls on key 1 with key 2 never touched —
  rotation advances only on FAILURE. So N calls is N requests through ONE key, and free-tier Gemini
  meters **15 requests/minute PER KEY**. A 7-question page spends half of one key's minute. This is
  exactly the operator's *"sometimes I call AI 16 times per minute, the limit is 15"*.
- **It had to PREDICT.** The prefetch ran before the deterministic pass, so it re-ran `atsRouteField`
  to guess which fields would fall through. Every misprediction is a paid request for a question the
  profile already answered.

### The change

Deterministic pass runs FIRST and to completion → every field it could not answer is RECORDED →
**ONE call** asks about exactly those → a second actuation pass fills them.

⚠ **This is the OPPOSITE ORDER to Workday's `aiBatch`, and they must not be unified.** Workday fires
its batch BEFORE the deterministic pass so the two overlap in time — which is what makes it a
speculative CACHE (a miss just makes its own call) and what forces it to predict. Here the outcome is
already known, so nothing is asked about an answered field. Strictly cheaper on tokens and requests;
paid for with a real second actuation pass, which the Workday cache does not have.

**Safety is unchanged by construction:** a batched answer enters through the SAME seam the prefetch
used (`atsAiFallback`'s `prefetched`). Still a CANDIDATE that must clear the match ladder against the
LIVE options read at commit time, still read-back verified, still ALWAYS `filled_review` + flagged.
A batch that fails, parses badly or omits a question leaves that field to make its own call — so a
batch failure costs LATENCY, never COVERAGE.

### The three details that are load-bearing

- **Cached by QUESTION (`normalizeLabel`), never by automation-id.** The cascade rounds re-enter the
  fill loop with late-mounted fields; the same wording under a new id reuses the answer already paid
  for. That is not only cheaper — it makes it **impossible for one page to hold two different answers
  to the same question**.
- **A deferred combobox is READ then CLOSED**, gated on the option count rather than `aria-expanded`
  (the Workday rule, same reason: a react-select menu left mounted swallows the next widget's
  open-click). The old per-field path opened the menu and then held it open **across the whole LLM
  call**; nothing is committed during the batch, so that window is gone. Mutation-checked — without
  the close, both menus sit open across the call.
- **`location` is deliberately NOT pre-read.** A places box has no list until something is typed, so
  an empty-query open can only return nothing, and it is the most expensive widget on this path
  (`candidate-location` spans 7.1–20.3s on ONE posting).

### What it costs, stated honestly

The one cost this ordering adds is **one extra open+close per deferred react-select combobox**: the
defer pass opens it to read the options, and the commit pass re-opens it because `atsInjCommitOption`
needs a mounted listbox. Radio / yes-no / checkbox-group / native-select options come from the scan
and cost nothing. There is also a **double option-read on a combobox whose menu never renders** — the
defer pass spends its budget, and the commit pass spends it again. That was deliberately not
short-circuited via `optionsUnreadable`: a transient empty read would then permanently strand a
REQUIRED field, and a second chance is the safer direction on a widget that is going to review either
way.

### ★ LIVE VERIFIED (build `deferred-ai-1`, hidden, cloudflare fixture)

`npm test` 1385/1385 · web 273/273 · `tsc` clean, with the discard / cache-key / close behaviours each
mutation-checked. Then two hidden runs on `job-boards.greenhouse.io/cloudflare/jobs/7902104`:

```
[ATS-FILL] question_66595614 (dropdown, req) → deferred_ai · 25ms · deferred to this page's one AI call
      … ×7 (20–29ms each — four fast CDP evals: open + read + close + confirm)
[ATS-FILL] AI batch: 7 deferred question(s) in ONE call (7 choice, 0 text · cap 3312 tokens)
[LLM] gemini gemini-3.5-flash-lite (auto) thinking:off for "fill" (2 keys) [attempt 1/2]
[LLM] ok in 2257ms (2257ms total across 1 attempt(s))            ← the ONLY [LLM] line of the run
[ATS-FILL] question_66595614 … → filled_review · ai-choice · after "Yes" · 84ms · from the batched call
      … ×7 (61–84ms each)
[ATS-FILL] AI pass done: 7 deferred · 7 served by the batch · 0 made their own call (batch asked 7, answered 7)
```

**7 calls → 1. Zero fell back.** All 7 committed a real read-back value and every one is
`filled_review · ai-choice` — the always-flagged rule held. Field counts are identical to the
pre-change baseline on both runs: **15 `filled` · 8 `filled_review` · 2 `skipped` = 25 fields.**

**And the clock says exactly what round 9 predicted it would.** `[ATS-TIME] fill 33.8s for 25 field(s)
… slowest: candidate-location 17.1s, resume 6.5s` — the LLM was **2.3s of 33.8s (6.7%)**, so
`candidate-location` ALONE cost 7× the entire AI spend. Collapsing 7 calls into 1 is invisible in the
wall clock and always was going to be. **The claim this change makes is the REQUEST COUNT, which is
what the 15/min per-key quota bills** — grading it on fill time measures `candidate-location`'s 7.1–20.3s
spread instead.

### ✔ The react-select combobox defer IS live-covered — and how a timing inference got it backwards

I first read the 20–29ms defer cost as proof these were **native `<select>`s** (scan-known options ⇒ no
DOM work), and recorded the combobox path as unverified. **That was wrong.** Inspecting the fixture's
DOM settles it:

```
totalSelects: 0 · totalCombos: 16
question_66595614 … 68396682  →  tag INPUT · role "combobox" · inside a .select shell   (×7)
```

**There is not one native `<select>` on the form.** All 7 deferred questions are react-select, so the
full open→read→**close**→(batch)→re-open→commit dance ran live on every one of them. 20–29ms is what
FOUR fast CDP evals cost, not zero: `atsInjOpenAndReadOptions` + `atsInjReadOptions` +
`atsInjCloseCombo` + the confirming `atsInjReadOptions`, at the ~1ms/command p50 this log already
records. A native select would have been ~5ms (scroll-into-view only).

Two independent confirmations in the same run:
- **`menu still open` never appeared** — `atsCloseComboConfirmed` succeeded on its FIRST attempt for
  all 7, i.e. blur + outside-mousedown really does unmount a react-select menu.
- **All 7 committed real read-back values.** `atsInjCommitOption` returns `no-open-listbox` when the
  menu is not mounted, so the commit pass demonstrably re-opened each widget (61–84ms each).

⚠ **The lesson, which is the reusable part: a duration is not a code path.** Both "no evals" and "four
1ms evals" fit ~25ms, and I picked the wrong one and wrote it into the log as a coverage gap. When the
question is *which branch ran*, read the DOM or add a log line — do not infer it from a timing.

### Regression sweep — 8 postings, all three ATS families, all hidden

| posting | ATS | deferred | served by batch | LLM calls | counts (filled/review/skipped) |
|---|---|---|---|---|---|
| gitlab | GH | 4 (4 choice) | 4 | **1** | 14 / 5 / 2 |
| figma | GH | 2 (2 text) | 2 | **1** | 15 / 3 / 3 |
| discord | GH | 4 (2c 2t) | 4 | **1** | 16 / 6 / 4 |
| reddit | GH | 8 (4c 4t) | 8 | **1** | 15 / 9 / 1 |
| **shieldai** | LEV | 6 (4c 2t) | **0** | **7** | 17 / 7 / 14 |
| matchgroup | LEV | 4 (4 choice) | 4 | **1** | 10 / 5 / 6 |
| ramp | ASH | 5 (2c 3t) | 5 | **1** | 5 / 5 / 3 (+1 needs_review) |
| linear | ASH | 7 (1c 6t) | 6 | **2** | 5 / 7 / 2 |

**8/8 `ok:true`, reached the form, walked.** 40 deferred questions cost **15 calls**; without the one
transient failure below, 34 questions cost **8**. Pre-change that is one call per question.

### ★ The failure mode this design is built for, observed live — and it cost latency, not coverage

`shieldai` logged `[LLM] ok in 1364ms` and then `AI batch answered 0/6`. The call SUCCEEDED and parsed
to nothing. All 6 questions fell back to their own calls, all 6 filled, and the page finished with the
same `17 / 7 / 14` counts as the clean reruns. **Two reruns of the same posting both parsed 6/6 in ONE
call**, so this was a transient bad reply, not a systematic fault.

That is exactly the invariant the design claims — *a batch that fails leaves each field to make its own
call, so a bad batch costs LATENCY, never COVERAGE* — and it is now observed rather than argued. Cost of
the incident: 43s instead of ~13s, from 6 fallback calls (one of which was an 11983ms outlier) plus a
`deadAsync` page reload.

⚠ **Nothing logged WHY**, which is the one thing this shape cannot diagnose from outside: refusal,
truncation mid-JSON, and ids we never asked about all look identical next to `ok in 1364ms`. Fixed —
`atsRunAiBatch` now dumps the reply's length and first 220 chars **on a total parse failure only** (a
partial parse is self-explaining, and the reply carries profile-derived answers), and a PARTIAL parse now
names the missed ids and their KINDS. Armed, not yet fired.

**The one discriminator the log did give:** 1364ms is SHORTER than any successful multi-answer reply
measured this round (reddit 8 answers/1920ms, cloudflare 7/2257ms, linear 7/2884ms). That argues against
truncation — which produces LONG output — and toward a short reply: a refusal (Shield AI is a defense
contractor and its Lever questions are ITAR/export-control, exactly the shape a model declines) or a
structurally wrong one. **Not resolved; do not record a cause until the dump fires.**

### ✔ FIXED — the parser silently dropped an answer that arrived under the OTHER key

Re-reading `atsParseBatchReply` against the sweep found a real fault of ours. It validated STRICTLY per
kind: a `choice` question was only accepted under `choice`, a `text` one only under `answer`. A model
replying `{"answer":"Yes"}` to a choice question had a perfectly good answer **discarded without a
trace**, and that question then paid for its own call.

The sweep's evidence points at it: **both misses were on MIXED batches** — `shieldai` (4 choice + 2 text)
answered 0/6, `linear` (1 choice + 6 text) answered 6/7 — which is precisely where a cross-key reply is
likeliest. Now either key is accepted for either kind.

⚠ **This cannot weaken safety, which is the only reason it is allowed.** A choice arriving under the
wrong key is still just a CANDIDATE and still has to clear the match ladder against the LIVE options
before anything commits; being lenient about which JSON key carried it changes nothing about what may be
written to a form. Unit-pinned and mutation-checked.

⚠ **What the reruns do and do NOT show.** On build `deferred-ai-3` all three re-ran clean in ONE call —
`linear 7/7`, `shieldai 6/6`, `reddit 8/8` (mixed 4c+4t control). **That is NOT proof the fix caused it:**
`shieldai` had already gone 6/6 twice on `deferred-ai-2` before the fix existed, and `linear`'s 6/7 was a
single observation. The fix stands on its own unit-level merit — a provable silent-drop path is closed —
not on these runs.

### ✔ END TO END on all three ATS families (fill → approve on the website → dry rehearsal → gate)

| posting | ATS | approved | strict verify | terminal line |
|---|---|---|---|---|
| matchgroup | Lever | 5/5 flagged | 21 fields | `▶▶ WOULD CLICK SUBMIT ◀◀` |
| discord | Greenhouse | 6/6 flagged | 26 replayed, **0 failures** | `▶▶ WOULD CLICK SUBMIT ◀◀` |
| ramp | Ashby | 6/6 flagged | 14 replayed, **0 failures** | `▶▶ WOULD CLICK SUBMIT ◀◀` |

Each gate line reads `bundle blockers: 0 · submit button: true (disabled false) · captcha challenge
visible: false`. Every run returned `stopped:"simulate"` and `arm` was never passed — the never-submit
invariant held throughout.

### Hidden vs visible ON THIS BUILD — the change is arm-NEUTRAL (12 runs, 6 per arm)

The prior refutations were measured on the OLD code. This build adds ~4 CDP evals per combobox plus a
`delayFull(120)` close-retry, and `act.delay` overruns 3–69× in a hidden MV3 worker — so it needed
re-asking. 12 runs on one posting, **order counterbalanced** (block 1 H-first, block 2 V-first), each
arm confirmed from its own measured `[ATS-PACING]` label, never the intent flag.

**The direct answer — the cost of the code I added is identical in both arms:**

| | defer cost per combobox (median) | `menu still open` retries |
|---|---|---|
| hidden (n=6) | ~15–20ms | **0** |
| visible (n=6) | ~15–20ms | **0** |

The outliers land in BOTH arms (347ms hidden, 332ms visible), and **`atsCloseComboConfirmed` never once
needed its retry in 12 runs** — so the `delayFull(120)` overrun I hypothesised never executes. All 12
runs served 7/7 from one call with identical `15 / 8 / 2` counts.

**Whole-fill medians still differ, and this is NOT attributable to the change:** hidden 20.25s vs
visible 15.6s; LLM arm-independent (hidden 1.45s, visible 2.05s — visible *higher*); `candidate-location`
similar (8.7 vs 8.2). The residual (fill − LLM − candidate-location) is hidden {4.6, 6.8, 7.8, 10.8,
12.3, 30.4} vs visible {4.5, 4.6, 5.5, 6.2, 7.4, 10.6} — heavily overlapping, with one hidden run (a
14.7s single-widget stall) carrying most of the gap.

⚠ **Do not promote this to "hidden is slower."** That claim has now been measured three times on this
path and flipped sign twice. n=6/arm is the largest sample yet and still cannot separate it from
`candidate-location`'s own 7.1–20.3s spread. What IS settled: **the deferred-AI change introduces no
hidden-specific cost.**

### The measurement trap this round nearly walked into

The FIRST run produced `ok:true`, 25 fields, correct counts — and **an empty log**. The MV3 worker was
torn down after the run and the log ring went with it, so the evidence for the only claim being made
(the call count) did not exist. Waiting ~85s before reading is enough to lose it.

**Fix, and worth reusing:** poll `AP_DEV_LOGS` from the localhost tab on a `setInterval` and accumulate
into a page-side Map keyed by `t|msg`, then read the Map afterwards. The lines then survive a worker
restart. This composes with the existing rule that `since` is only a LOWER BOUND — accumulate DURING the
run, filter by cursor after.

---

## 2026-08-12 — round 11: the ROUTE is per-call, so the batch splits by kind

Round 10 collapsed an ATS page's AI questions into one call. Reviewing Workday's `aiBatch` for whether it
should adopt the same ordering turned up two things that mattered more than the ordering question.

### ★ FOUND: ATS long answers were never using the essay model

`act.llm` resolves `resolveLlmRoute(config, action || "fill")`. **`atsAiWriteText` passed no `action`**, so
every free-text answer on Greenhouse/Lever/Ashby — the cover-letter-shaped "why do you want to work here"
boxes — resolved the **Fill** route. The AI page has had a separate `"Fill — essays and long answers"` slot
all along (`LLM_ACTIONS = ["fill","essay","resume_parse","cover_letter"]`), and the Workday twin
`aiFillText` had always used it. Only this path did not, so the operator's essay model sat unused.

### The consequence for round 10's design: ONE CALL PER KIND, not per page

A call carries ONE `action`, so a batch mixing picks and prose must send one kind to the other's model.
The batch now splits — **choice → `"fill"`, text → `"essay"`** — fired CONCURRENTLY. It costs no latency
(the page waits for the slower, not the sum) and is a small quota win, since the two actions can resolve to
different models and different pinned keys. "One question is not a batch" now applies **per kind**.

**LIVE VERIFIED** (build `deferred-ai-4`, hidden):

```
reddit  (4 text + 4 choice)
  AI batch [choice → "fill" route]: 4 deferred question(s) in ONE call
  AI batch [text  → "essay" route]: 4 deferred question(s) in ONE call
  [LLM] … for "fill"  [attempt 1/2]
  [LLM] … for "essay" [attempt 1/2]     ← both HEADERS precede either reply ⇒ genuinely concurrent
  [LLM] ok in 1281ms · ok in 1528ms
  AI pass done: 8 deferred · 8 served by the batch · 0 made their own call

linear  (6 text + 1 choice)
  AI batch [text → "essay" route]: 6 deferred question(s) in ONE call → ok in 2223ms
  the lone choice fell to its own call, on "fill" → 10058ms   ← the per-kind minimum, working
```

### Workday: should it adopt round 10's ORDER? No — but its batch was too NARROW

Read before deciding, and worth recording because the symmetry is tempting and wrong:

- **Workday's batch is fired UN-AWAITED — the overlap IS the design.** The model works while the
  deterministic loop drives the page. Deferring (the ATS order) forfeits that, and Workday has far more to
  hide behind (`capture`/`scrapeTaOptions` run 2–16s).
- **The ATS win was REQUEST COUNT** against a 15/min per-key quota. Workday's batched portion was already
  ONE call, so flipping the order would save prompt tokens, not requests, and pay latency for them.
- **A deferred second pass is also much harder here**: `drivePageFill` carries `only`/`onlySec` re-fill
  modes, cascade recursion, AI-4 remediation re-entry, `sweepAlreadyFilled` and the M40 audit, all assuming
  one pass. ATS was easy only because `atsAiFallback` was a single seam already taking `prefetched`.

**What WAS wrong: the batch covered dropdowns only** — `if (f.widgetType !== "dropdown") continue;`. There
are **13 `act.llm` sites in `fill-driver.js` and exactly one consulted the batch**, so every REQUIRED
free-text question made its own serial call. Worse, `willUseAi` is true for a required text field, so it
*awaited* the batch and then discarded the answer, because `aiFillText` took no pre-answer.

**Fixed by widening, not by re-ordering.** Text candidates are **free**: no options ⇒ `needsOpen:false` ⇒
zero page contact. `aiFillText` gained a `preAnswer` seam matching `aiFillField`'s. `aiBatchAnswer` awaits
**only the route that could serve the field**, so a prose question never blocks on the dropdown call.

### Workday LIVE (build `deferred-ai-6`, hidden, `cat.wd5` R0000385733, fresh req)

```
✓✓ reached the REVIEW page after 5 page(s) — the whole application is filled. NOT submitting (terminal).
[AI-BATCH-RECON] planned 1 [infer:disabilityForm] · needed an open: 1 · OPENED: 0
                 · no kind reaches 2 candidates — no page contact
```

**No regression: 5 pages, REVIEW reached, zero nav-timeouts, zero halts.** And `needed an open: 1 ·
OPENED: 0` is the new per-route gate working live — a dropdown whose route cannot batch is no longer
opened for a prompt nobody sends.

⚠ **The TEXT batching itself is still not live-exercised.** Every page on this tenant had ≤1 AI question,
so no group ever reached 2 and no batch fired at all (1 LLM call for the whole 5-page walk, on `"fill"`).
That is worth knowing in its own right: **on a typical Workday page the batch has little to collapse**,
because most text fields are MAPPED (name, email, address) and the unmapped prose questions that make the
ATS path expensive are rare here. The widening is cheap insurance for an essay-heavy tenant, not a
routine win — do not expect the ATS-sized effect.

### End to end after all of it (ATS, build `deferred-ai-6`)

```
review pull: loaded the website-approved bundle (25 fields, 9/9 flagged approved)
[ATS-SUBMIT] verify: 25 field(s) replayed, 0 failure(s) · blockers: 0 · captcha visible: false
[ATS-SUBMIT] ▶▶ WOULD CLICK SUBMIT ◀◀
```

### Also fixed: the parser dropped an answer that arrived under the other key

Both `parseBatchAiReply` (Workday) and `atsParseBatchReply` validated strictly per kind — a pick was only
accepted under `choice`, prose only under `answer`. A model replying `{"answer":"Yes"}` to a pick had a good
answer **discarded silently**, and that question then paid for its own call. Both misses in round 10's sweep
were on MIXED batches, which is exactly where a cross-key reply is likeliest. Safety is untouched: the value
is still only a CANDIDATE that must clear the match ladder against the LIVE options before anything commits.

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
NAVIGATION, and a navigating document's timer does not fire.**

⚠ **The halt itself was NOT caused by lost samples. That framing was written here first, and it is
WRONG — retired 2026-08-10.** `waitFor(resume-upload-input)` watches **existence**, and existence is
**MONOTONE**: once Workday mounts the control it stays mounted. A sparse poll against a monotone
condition can only notice LATE — by at most one interval — it cannot MISS the event. 21 reads across
25000ms means the final read happened at ~25s and the control was still absent; it genuinely was not
there. The control experiment is already on record: round 1's **run 4 timed out at the same 25s budget
on the SW clock** with 29 reads. Same ~1-in-4 transient, page clock or not. Budget was the correct fix
(round 5, 25s → 45s), and no attempts floor belongs anywhere on this wait.

**The gate still stands, on the firmer argument:** during a navigation the page clock can hang
INDEFINITELY, and our abandon ceiling is ITSELF an SW timer, so a pace there has no reliable bound —
50ms requested, 3.5–5.0s observed. That is a bounding problem, not a coverage one, and it is the same
reason round 3 SW-times the transition wait.

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

> ⚠ **SUPERSEDED by round 6 — do not act on the paragraph above.** The audit it called for was done: there
> are **59** such loops, not ~30, and **every one of them on a run path watches a MONOTONE or a STABILITY
> predicate**, neither of which can be starved of coverage by a late clock. An attempts floor buys nothing
> against the first and is actively wrong against the second (sparse reads make a false "settled" LESS
> likely, not more). Onboarding's real cost here was LATENCY, and round 5's scoped page clock removed it
> (~1200ms/read → ~70ms/read). The loop shape was not the bug.

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

---

## Round 11 (2026-08-17) — iCIMS: hidden is 2.24× visible, and the cause is NOT drift

First tenant measured in the **`hidden-SLOW (no worker timers)`** regime. Round 6's table calls that
regime "a documented code path with a label that has never once been OBSERVED" — it is observed now, on
every iCIMS run, because iCIMS DECLINES the worker-timer polyfill (its sign-in gate is guarded by
invisible hCaptcha, which does not initialise under the polyfill — see `docs/dom-patterns.md`
`2026-08-16 (c)`). So the standing conclusions below were re-tested here rather than assumed.

**A/B, same build, same form, both labels MEASURED (never the `background:` flag), Chrome untouched
during each run so polling could not activate a tab:**

| | HIDDEN | VISIBLE |
|---|---|---|
| pacing label | `hidden-SLOW (no worker timers)` | `visible-fast` |
| fill total | **37.2s** | **16.6s** |
| per field | 348ms | 155ms |
| **sum of per-field times** | **26.5s** | **6.5s** |
| slowest field | 2.38s | 0.98s |
| fields ≥1s | 7 | 0 |
| `[PACE]` overrun total | ~1.1s (1 warning) | ~2.5s (3 warnings) |
| `[LLM]` calls | **0** | **0** |

### What that says

1. **The gap is per-field PAGE CONTACT, not our timers.** Field time is 26.5s vs 6.5s — a 4× ratio that
   accounts for the whole 20.6s difference; non-field overhead is flat (10.7s vs 10.1s). It is
   `cdpAdaptiveDelay` behaving as designed: FULL pacing when hidden and worker timers are unavailable,
   ~10× faster when visible.
2. **⚠ Standing conclusion 1 does NOT transfer to this tenant.** Drift is ~1.1s of 37.2s here, and the
   VISIBLE run had the WORSE overrun (2.5s). On Workday a single `delay(250)` was measured at 17.3s; the
   worst here is 250ms → 1322ms. Do not arrive at an iCIMS slowness with "it's the SW timers".
3. **The LLM is absent entirely.** 0 calls on a 107-field form, because the iCIMS mapping is now
   deterministic. So "a slow page is the LLM until proven otherwise" has nothing to subtract here — this
   is the rare fill where page contact really is the whole cost.
4. Round 4's shape holds anyway: median field is FAST (47 of 107 under 50ms), and a tail of 7 fields at
   1.6–2.4s carries ~11s of the 26.5s.

### ⛔ DO NOT "fix" this by re-enabling the worker-timer polyfill

The obvious optimisation is to give the FORM the polyfill and keep it off only for the gate. **Measured
2026-08-17: the application form carries its own captcha** — `hcaptchaFrames: 2`, `recaptchaFrames: 1`,
one `[data-sitekey]` widget and one `h-captcha-response` input. So the final **Submit Profile is
captcha-gated exactly like the sign-in**, and the failure mode is already known and silent: under the
polyfill hCaptcha never initialises, the submit event fires, iCIMS disables its own button, and nothing
comes back. Trading a 20s hidden fill for a submit that cannot complete is the wrong direction.

### The remaining lever — TESTED in round 12 below, and it worked

Allow the FAST pace on iCIMS even when hidden. The full pace exists to wait out Workday's debounced
REACT re-renders; iCIMS is server-rendered jQuery with no React (`docs/dom-patterns.md` 2026-08-16), and
every pace site here is gated by a read-back or a poll — so by standing conclusion 3 a too-short wait
costs a RETRY, not a miss. Plausible, and it would close most of the 20.6s. Not attempted yet: it is a
pacing change on a tenant whose correctness was only just established (rehearsal 109 replayed / 0
failures), so it wants its own round with the verify count as the acceptance test.

---

## Round 12 (2026-08-17) — fast pacing while HIDDEN closes the iCIMS gap entirely

Round 11's untested lever, tried. `cdpSetFastWhenHidden(true)` — a scoped per-run opt-in, sibling of
`cdpSetSyntheticInput` / `cdpSetPageClock`, reset at every `cdpAttach` — makes `cdpFast()` return true on
a hidden tab for a page whose reactions are not page-timer driven. Enabled for iCIMS on both the fill and
the submit path, right where the worker-timer decline happens, because it exists to compensate for it.

**A DIFFERENT AXIS from the page clock**, and worth keeping straight: `cdpSetPageClock` chooses WHERE a
pace sleeps (the page's worker-backed timer vs the starved SW one) and needs the polyfill iCIMS declines.
This chooses HOW LONG the pace is.

| | HIDDEN before | VISIBLE | **HIDDEN + fast** |
|---|---|---|---|
| pacing label | `hidden-SLOW (no worker timers)` | `visible-fast` | `hidden-fast (page-clock-independent)` |
| fill total | 37.2s | 16.6s | **15.1s** |
| per field | 348ms | 155ms | **141ms** |
| sum of per-field times | 26.5s | 6.5s | **7.8s** |
| slowest field | 2.38s | 0.98s | **1.18s** |
| `needs_review` | 4 | 4 | **4** |
| `[ATS-FILL]` needs_review/error | 0 | 0 | **0** |

**Hidden is now at parity with visible — marginally faster, which is noise, not a win.** The 2.24x gap is
gone, and the whole of it was the per-field pace.

**Acceptance test was the REHEARSAL, not the clock.** A faster fill that quietly commits less is the
failure this could have caused, so the pass condition was the strict verify: `107 field(s) replayed,
0 failure(s)` then `WOULD CLICK SUBMIT`. Plus the fill's own `needs_review` count unchanged at 4 and zero
field-level errors. Timing alone would not have been evidence.

**Why it is safe rather than lucky**, restated because it is the load-bearing part: it applies the SAME
`FAST_FACTOR` (0.1) every VISIBLE run already uses — no new timing regime — and every adaptive-pace site
is gated by a read-back or a poll, so a too-short wait costs a RETRY, never a silent wrong fill
(standing conclusion 3: a monotone or stability predicate is noticed late, never missed). iCIMS earns the
claim specifically: server-rendered jQuery, no React, so a pace waits on an AJAX reply (network events
are not timer-throttled) or a synchronous DOM write after a native setter.

⚠ **Do not generalise this to Workday.** There the full hidden pace exists to wait out debounced REACT
re-renders, which genuinely ride the ~1Hz throttle — the regime standing conclusion 1 measured. The
opt-in is per-run and resets at attach precisely so it cannot leak there.
