// test/discover-window.test.js — an ABSENT sinceDays means the declared default, not one day.
//
// This existed as a live failure before it existed as a test. The website's Discover panel has no
// sinceDays control (the "Posted within N days" knob was removed 2026-07-30), so it never sends one
// — and the two board URL builders fell back to `|| 1` while `matchPercent` fell back to
// DISCOVER_DEFAULTS.sinceDays. Two different answers to the same missing option, so every sweep from
// the site asked LinkedIn for the last 24 HOURS while the scorer believed the window was 30 days.
//
// Measured 2026-09-06, two sweeps minutes apart, identical settings, the only difference an explicit
// sinceDays: the 1-day window returned 0 new jobs (everything found scored 21-37% and fell under the
// threshold); the wide window returned 7 at 63-83%, six confirmed Summer 2027 in the JD. A 2027
// internship is posted months ahead, so a 24-hour filter is the wrong net for it.
//
// Run: node --test test/discover-window.test.js

const test = require("node:test");
const assert = require("node:assert");
const { discoverWindowSecs, DISCOVER_DEFAULTS } = require("../discover.js");

const DAY = 86400;

test("an ABSENT sinceDays falls back to the DECLARED default, never to 1 day", () => {
  const expected = DISCOVER_DEFAULTS.sinceDays * DAY;
  assert.strictEqual(discoverWindowSecs({}), expected);
  assert.strictEqual(discoverWindowSecs(undefined), expected);
  assert.strictEqual(discoverWindowSecs({ sinceDays: undefined }), expected);
  assert.strictEqual(discoverWindowSecs({ keywords: "firmware intern" }), expected);
  // The regression itself: one day must NOT be the answer for an absent option.
  assert.notStrictEqual(discoverWindowSecs({}), DAY);
});

test("the default is WIDE — freshness is scored by matchPercent, not filtered here", () => {
  // DISCOVER_DEFAULTS' own comment: "a wide window costs nothing: an old posting simply scores low
  // and falls under the threshold, while a wider net finds more of what IS fresh." A narrow default
  // would silently re-break the sweep, so the intent is pinned rather than left to the constant.
  assert.ok(DISCOVER_DEFAULTS.sinceDays >= 14,
    "the recency window is deliberately wide; narrowing it makes every website sweep miss postings");
});

test("an explicit sinceDays is honoured exactly", () => {
  assert.strictEqual(discoverWindowSecs({ sinceDays: 1 }), DAY);
  assert.strictEqual(discoverWindowSecs({ sinceDays: 21 }), 21 * DAY);
  assert.strictEqual(discoverWindowSecs({ sinceDays: "7" }), 7 * DAY);   // the SW passes strings
  assert.strictEqual(discoverWindowSecs({ sinceDays: 0.5 }), Math.round(0.5 * DAY));
});

test("a junk or non-positive sinceDays falls back rather than producing a nonsense window", () => {
  // A negative or zero window would ask the board for "posted within -3 days". Falling back is the
  // safe direction: too wide only costs reading time, since the score still gates queueing.
  const expected = DISCOVER_DEFAULTS.sinceDays * DAY;
  for (const bad of [0, -3, NaN, "soon", null, {}, []]) {
    assert.strictEqual(discoverWindowSecs({ sinceDays: bad }), expected,
      "sinceDays=" + JSON.stringify(bad) + " must fall back to the default window");
  }
});

test("the window is always a positive whole number of seconds", () => {
  for (const d of [1, 0.001, 30, 365]) {
    const s = discoverWindowSecs({ sinceDays: d });
    assert.ok(Number.isInteger(s) && s >= 1, "sinceDays=" + d + " produced " + s);
  }
});
