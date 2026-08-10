"use strict";
// CROSS-RUN OPTION-VOCABULARY CACHE (captureChoiceOptions, 2026-08-10).
//
// Why it exists: captureChoiceOptions re-opens choice widgets purely to hand the REVIEW EDITOR a real
// picker, and that was the biggest deterministic cost left after the pacing fix —
// scrapeTaOptions(countryPhoneCode) measured 14.37s for ~249 options, with `capture` running 4.7-21.1s on
// page 1 across runs (docs/fill-speed-log.md). The vocabularies are FIXED, so the SW now remembers them
// between runs and hands them back in.
//
// Why it is SAFE to reuse a list from an earlier run — the property these tests exist to protect:
// rec.options is consumed ONLY by the review editor's picker. No fill or replay decision reads it
// (replayField replays the approved VALUE through the live match ladder). So the worst a stale entry can
// do is offer review an option the tenant no longer lists, which then fails the ladder into needs_review
// instead of committing anything wrong. What must NEVER happen is the cache changing a FILL — so these
// pin that the fill's own records/verification are untouched, and that a failed scrape is never cached.
const test = require("node:test");
const assert = require("node:assert");
const { drivePageFill, DEFAULT_BUDGETS } = require("../fill-driver.js");

// A dropdown whose trigger ALREADY shows the profile's top candidate → tier-0 "kept without actuation",
// so it carries no options and is exactly the record captureChoiceOptions re-opens.
const KEPT_DD = {
  wrapperSel: "[w-country]", fieldName: "country", widgetType: "dropdown", label: "Country",
  triggerText: "United States of America",
  options: [{ text: "Select One", disabled: true }, { text: "Canada" }, { text: "United States of America" }, { text: "Uruguay" }],
};
const US_PROFILE = { personal_info: { country: ["United States of America", "United States"] } };
// Collapse every ceiling/interval so a poll this minimal fake doesn't satisfy costs milliseconds instead
// of running to a real 5-25s budget (the first draft of these tests took 6s each for that reason).
const T = (() => {
  const t = Object.assign({}, DEFAULT_BUDGETS);
  for (const k of Object.keys(t)) {
    if (typeof t[k] !== "number") continue;
    if (/Ceiling|Timeout|Budget|Window|MaxBeat|NoMatch/i.test(k)) t[k] = Math.min(t[k], 150);
    else if (/Interval|Beat|Settle/i.test(k)) t[k] = Math.min(t[k], 10);
  }
  return t;
})();

// Minimal act: only what the kept-dropdown path + captureDropdownOptions touch. Kept local (rather than
// importing makeFakeAct, which is not exported) so these tests state their own contract.
function makeAct(field, { openFails = false } = {}) {
  const log = [];
  let open = false;
  const st = () => ({
    open,
    triggerText: field.triggerText,
    options: open ? field.options.map((o) => ({ text: o.text, disabled: !!o.disabled })) : [],
    optionCount: open ? field.options.length : 0,
  });
  return {
    log,
    aiEnabled: false,
    delay: async () => {}, delayFull: async () => {}, delayRender: async () => {},
    scanPage: async () => ({ url: "https://cat.wd5.myworkdayjobs.com/apply", fields: [field] }),
    openDropdown: async (loc) => { log.push(["openDropdown", loc.wrapperSel]); if (openFails) return null; open = true; return st(); },
    readDropdownState: async () => st(),
    pressEscape: async () => { log.push(["pressEscape"]); open = false; },
    closeDropdownConfirmed: async () => { open = false; return true; },
    readAuditRaw: async () => ({}),
  };
}

// captureChoiceOptions is internal, so drive it the way production does — through drivePageFill.
const fill = (act, optionCache) =>
  drivePageFill(act, US_PROFILE, {}, {}, T, optionCache === undefined ? {} : { optionCache });

test("cache MISS: scrapes the vocabulary and WRITES it into the cache for later runs", async () => {
  const act = makeAct(KEPT_DD);
  const cache = {};
  const out = await fill(act, cache);
  const rec = out.results.find((r) => r.fieldName === "country");
  assert.ok(rec, "the kept dropdown produced a record");
  // The capture re-opened the widget (that is the cost we are trying to stop paying every run)…
  assert.ok(act.log.some(([m]) => m === "openDropdown"), "a miss must actually scrape");
  // …and the vocabulary is now remembered under the dropdown's stem key.
  assert.deepStrictEqual(cache["dd:country"], ["Canada", "United States of America", "Uruguay"],
    "disabled placeholder excluded; the rest cached for reuse");
});

test("cache HIT: reuses the remembered list and does NOT re-open the widget", async () => {
  const act = makeAct(KEPT_DD);
  const cache = { "dd:country": ["Canada", "United States of America", "Uruguay"] };
  const out = await fill(act, cache);
  const rec = out.results.find((r) => r.fieldName === "country");
  assert.ok(!act.log.some(([m]) => m === "openDropdown"),
    "THE WHOLE POINT: a remembered vocabulary must cost zero page contact");
  assert.deepStrictEqual(rec.options, ["Canada", "United States of America", "Uruguay"],
    "review still gets a real picker, from the cache");
});

test("a cache hit does not change the FILL — the kept value and its verification are untouched", async () => {
  const cold = await fill(makeAct(KEPT_DD), {});
  const warm = await fill(makeAct(KEPT_DD), { "dd:country": ["Canada", "United States of America", "Uruguay"] });
  const pick = (o) => { const r = o.results.find((x) => x.fieldName === "country"); return { status: r.status, after: r.after, flag: r.flag, matchTier: r.matchTier }; };
  assert.deepStrictEqual(pick(warm), pick(cold),
    "the cache may only affect rec.options (the review picker), never the fill outcome");
});

test("a FAILED scrape is never cached — one bad run must not poison every later run's picker", async () => {
  const act = makeAct(KEPT_DD, { openFails: true });
  const cache = {};
  await fill(act, cache);
  assert.deepStrictEqual(cache, {}, "no entry written when the widget never opened");
});

test("no cache passed at all ⇒ unchanged behaviour (scrapes, nothing to persist)", async () => {
  const act = makeAct(KEPT_DD);
  const out = await fill(act, undefined);
  const rec = out.results.find((r) => r.fieldName === "country");
  assert.ok(act.log.some(([m]) => m === "openDropdown"), "still scrapes without a cache");
  assert.deepStrictEqual(rec.options, ["Canada", "United States of America", "Uruguay"]);
});

test("an EMPTY cached list is treated as a miss, not as 'this field has no options'", async () => {
  const act = makeAct(KEPT_DD);
  const cache = { "dd:country": [] };
  await fill(act, cache);
  assert.ok(act.log.some(([m]) => m === "openDropdown"),
    "an empty remembered list must not suppress the scrape (that would leave review with no picker forever)");
});
