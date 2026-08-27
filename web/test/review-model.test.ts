import { test } from "node:test";
import assert from "node:assert/strict";
import { explainFill, aiJustification, orderForReview, reviewPriority, isBecameRequired, normalizeDateOrder, todayForDateOrder } from "../lib/review-model";
import type { ReviewEntry } from "../lib/review-summary";

// explainFill turns the engine's terse `detail` log line into intuitive, applicant-facing copy on the
// review card. Contract: the FRONTEND never shows the raw engine string — the precise `detail` stays in
// the bundle + service-worker logs for debugging.
const mk = (e: Partial<ReviewEntry>): ReviewEntry =>
  ({
    field_id: "P::formField-x",
    page: "P",
    question_label: "Q",
    widget_type: "dropdown",
    canonical_field: "education[0].degree",
    is_required: true,
    needs_review: true,
    fill_status: "filled",
    ...e,
  }) as ReviewEntry;

test("ai-canonicalized: names the profile value it mapped FROM and the option it chose", () => {
  const msg = explainFill(
    mk({
      flag: "ai-canonicalized",
      current_value: "Bachelors",
      detail: 'AI canonicalized stated "Bachelor of Science" → "Bachelors" (vocab map, not inferred)',
    })
  )!;
  assert.match(msg, /Bachelor of Science/, "quotes the profile value");
  assert.match(msg, /Bachelors/, "quotes the chosen option");
  assert.match(msg, /wasn’t an exact option/, "explains WHY it needed matching");
  assert.doesNotMatch(msg, /vocab map|canonicalized/, "no raw engine jargon on the frontend");
});

test("ai-choice represented (flat typeahead): reads as a match, not an inference", () => {
  const msg = explainFill(
    mk({
      flag: "ai-choice",
      match_tier: "ai-choice",
      current_value: "Electrical Engineering",
      detail: 'AI: "Electrical Engineering" (genuinely represented in the list)',
    })
  )!;
  assert.match(msg, /matched it to the closest one — “Electrical Engineering”/);
  assert.doesNotMatch(msg, /represented in the list/, "no raw engine string");
});

test("ai-choice source-tree: distinct phrasing from a flat pick", () => {
  const msg = explainFill(mk({ flag: "ai-choice", match_tier: "ai-source-tree", current_value: "LinkedIn" }))!;
  assert.match(msg, /in this form’s list/);
});

test("ai-closest-forced: flags it as the riskiest answer", () => {
  const msg = explainFill(mk({ flag: "ai-closest-forced", current_value: "Nearest", confidence: "low" }))!;
  assert.match(msg, /required/);
  assert.match(msg, /Double-check this one/);
});

test("ai-eeo-guess: says you didn't state it and to verify/clear", () => {
  const msg = explainFill(mk({ flag: "ai-eeo-guess", current_value: "Prefer not to say" }))!;
  assert.match(msg, /didn’t state this/);
  assert.match(msg, /Verify or clear/);
});

// The card's job is WHY, not WHAT — the value is already in the editor beside it. Every AI prompt
// already asks for a short justification and the engine already stored it; these fixtures are the REAL
// `detail` strings off a live Linear/Ashby bundle (2026-08-12).
test("an AI fill explains ITSELF — the model's reason, not a re-quote of the value", () => {
  const msg = explainFill(
    mk({ flag: "ai-text", current_value: "2 weeks", detail: "AI: Standard professional notice period inferred from profile context." })
  )!;
  assert.match(msg, /Standard professional notice period inferred from profile context/);
  assert.doesNotMatch(msg, /AI filled this as/, "the old value-repeating phrasing is gone");
  assert.doesNotMatch(msg, /“2 weeks”/, "the value is NOT repeated — the editor shows it");
  assert.match(msg, /Verify/, "still tells them to check it");
});

test("no usable reason ⇒ a plain line, still never a value re-quote", () => {
  const msg = explainFill(mk({ flag: "ai-text", current_value: "United States of America", detail: null }))!;
  assert.doesNotMatch(msg, /United States/);
  assert.match(msg, /AI answered this from your profile/);
});

test("aiJustification REFUSES engine strings — `detail` must never leak to the card", () => {
  // The represented-typeahead path writes `AI: "<value>" (engine note)`: an AI: prefix, but jargon
  // about the MATCH rather than a reason.
  assert.equal(aiJustification(mk({ detail: 'AI: "Electrical Engineering" (genuinely represented in the list)' })), null);
  assert.equal(aiJustification(mk({ detail: "audit-mismatch before=X after=Y auditLoc=div[data-automation-id]" })), null);
  assert.equal(aiJustification(mk({ detail: "no profile mapping for this question" })), null, "not an AI: line at all");
  // The "no reason given" fallbacks every AI path writes when the model returned none.
  assert.equal(aiJustification(mk({ detail: "AI: generated answer" })), null);
  assert.equal(aiJustification(mk({ detail: "AI: inferred — commit failed" })), null);
  // A reason that merely restates the value is the duplication this exists to remove.
  assert.equal(aiJustification(mk({ current_value: "Remote", detail: "AI: Remote" })), null);
});

test("aiJustification strips the engine scaffolding around a real reason", () => {
  // Workday's choice path appends ` → \"<value>\"`; the value must not come back in through the reason.
  assert.equal(
    aiJustification(mk({ current_value: "No", detail: 'AI: no criminal record in profile → "No" — LEGALLY-LOADED, verify' })),
    "no criminal record in profile"
  );
  assert.equal(
    aiJustification(mk({ detail: "AI: Country listed in personal_info address profile." })),
    "Country listed in personal_info address profile"
  );
});

test("ai-eeo-guess keeps its loud framing but carries the reason instead of the value", () => {
  const msg = explainFill(
    mk({ flag: "ai-eeo-guess", current_value: "Prefer not to say", detail: "AI: profile states no gender" })
  )!;
  assert.match(msg, /didn’t state this/);
  assert.match(msg, /Verify or clear/);
  assert.match(msg, /profile states no gender/);
  assert.doesNotMatch(msg, /“Prefer not to say”/);
});

test("bucket: reads as a taught answer, not an AI guess", () => {
  const msg = explainFill(mk({ flag: "bucket", current_value: "Yes", needs_review: true }))!;
  assert.match(msg, /taught ApplyPilot/);
});

test("deterministic containment/fuzzy: closest-match phrasing", () => {
  const msg = explainFill(mk({ flag: null, match_tier: "containment", current_value: "United States" }))!;
  assert.match(msg, /closest match/);
});

test("unknown flag with a technical detail → generic intuitive line, NEVER the raw detail", () => {
  const raw = "audit-mismatch before=X after=Y auditLoc=div[data-automation-id]";
  const msg = explainFill(mk({ flag: "audit-mismatch", current_value: "Y", detail: raw }))!;
  assert.doesNotMatch(msg, /auditLoc|before=|after=/, "raw engine detail is not surfaced");
  assert.match(msg, /double-check/i);
});

test("a truly unrecognized needs_review flag falls back to an intuitive nudge, not the raw detail", () => {
  const msg = explainFill(mk({ flag: "some-future-flag", detail: "internal debug string", needs_review: true }))!;
  assert.equal(msg, "Please double-check this field.");
});

test("not flagged, no detail → nothing to say", () => {
  assert.equal(explainFill(mk({ flag: null, detail: null, needs_review: false, fill_status: "filled" })), null);
});


// ── orderForReview — NEW review items at the TOP (operator 2026-07-28) ──────────────────────────────
// When a submit run sends questions BACK to review, they are the reason the operator reopened the page.
// In pure form order they landed among fields already approved once, which is where they get missed.
test("orderForReview: BECAME REQUIRED sorts first, then other revealed, then the loud AI tiers", () => {
  const plain = mk({ field_id: "a", question_label: "Plain" });
  const superHard = mk({ field_id: "b", question_label: "Forced AI", flag: "ai-closest-forced", confidence: "low" });
  const revealed = mk({ field_id: "c", question_label: "Revealed", cascade_revealed: true });
  const became = mk({ field_id: "d", question_label: "Date", cascade_revealed: true, flag: "cascade-required" });
  const order = orderForReview([plain, superHard, revealed, became]).map((e) => e.question_label);
  assert.deepEqual(order, ["Date", "Revealed", "Forced AI", "Plain"]);
  assert.equal(reviewPriority(became), 0);
  assert.ok(isBecameRequired(became) && !isBecameRequired(revealed), "only the cascade-required flag is 'became required'");
});

test("orderForReview: STABLE — form order still decides inside a tier", () => {
  const a = mk({ field_id: "1", question_label: "First" });
  const b = mk({ field_id: "2", question_label: "Second" });
  const c = mk({ field_id: "3", question_label: "Third" });
  assert.deepEqual(orderForReview([a, b, c]).map((e) => e.question_label), ["First", "Second", "Third"]);
});

test("orderForReview: two new items keep their form order relative to each other", () => {
  const d1 = mk({ field_id: "x", question_label: "Date", cascade_revealed: true, flag: "cascade-required" });
  const d2 = mk({ field_id: "y", question_label: "Please check one of the boxes below", cascade_revealed: true, flag: "cascade-required" });
  const plain = mk({ field_id: "z", question_label: "Plain" });
  assert.deepEqual(orderForReview([plain, d1, d2]).map((e) => e.question_label),
    ["Date", "Please check one of the boxes below", "Plain"]);
});


// ── normalizeDateOrder — the viewer heals its own input (live 2026-07-28, twice) ─────────────────────
// DateSeg fell back to `{ ph: segment }` for unknown tokens, so a bundle whose date_order held RAW scan
// ids printed them as the input placeholders. A bundle is DURABLE (and an older extension build may
// still be installed), so the page must normalize rather than trust.
test("normalizeDateOrder: RAW scan automation-ids heal to the form's segment order", () => {
  assert.deepEqual(
    normalizeDateOrder(["dateSectionMonth-display", "dateSectionMonth-input", "dateSectionDay-display", "dateSectionDay-input", "dateSectionYear-display", "dateSectionYear-input"]),
    ["month", "day", "year"],
    "6 raw ids → 3 deduped segments, in the form's own order"
  );
  assert.deepEqual(normalizeDateOrder(["dateSectionMonth-input", "dateSectionYear-input"]), ["month", "year"]);
  assert.deepEqual(normalizeDateOrder(["dateSectionYear-display"]), ["year"], "year-only composites keep their shape");
});

test("normalizeDateOrder: an already-clean order passes through unchanged", () => {
  assert.deepEqual(normalizeDateOrder(["month", "day", "year"]), ["month", "day", "year"]);
  assert.deepEqual(normalizeDateOrder(["year"]), ["year"]);
});

test("normalizeDateOrder: junk yields [] so the editor degrades to a text box, never prints the token", () => {
  assert.deepEqual(normalizeDateOrder(["date", "date", "date"]), [], "unrecognized tokens are dropped, not shown");
  assert.deepEqual(normalizeDateOrder([]), []);
  assert.deepEqual(normalizeDateOrder(null), []);
  assert.deepEqual(normalizeDateOrder("month/day/year"), [], "a non-array is not an order");
});


// ── todayForDateOrder — the review page's "Today" button (operator 2026-07-28) ───────────────────────
// The one date a form asks for that the profile can never hold is TODAY (a signature / acknowledgement
// date), and it's the field most likely to come back as BECAME REQUIRED.
test("todayForDateOrder: shaped to the form's OWN segment order, zero-padded", () => {
  const d = new Date(2026, 6, 5); // 5 Jul 2026, LOCAL
  assert.deepEqual(todayForDateOrder(["month", "day", "year"], d), ["07", "05", "2026"]);
  assert.deepEqual(todayForDateOrder(["month", "year"], d), ["07", "2026"], "a month/year composite gets only what it asks for");
  assert.deepEqual(todayForDateOrder(["year"], d), ["2026"]);
  assert.deepEqual(todayForDateOrder(["day", "month", "year"], d), ["05", "07", "2026"], "a DD/MM tenant gets its own order, not ours");
});

test("todayForDateOrder: uses the LOCAL date, not UTC (never sign a form with the wrong day)", () => {
  // 23:30 local on 5 Jul is already 6 Jul in UTC — a UTC read would fill tomorrow.
  const lateLocal = new Date(2026, 6, 5, 23, 30);
  assert.deepEqual(todayForDateOrder(["month", "day", "year"], lateLocal), ["07", "05", "2026"]);
});

test("todayForDateOrder: an empty/absent order yields nothing to fill", () => {
  assert.deepEqual(todayForDateOrder([], new Date()), []);
  assert.deepEqual(todayForDateOrder(null, new Date()), []);
});

// -- "COULDN'T FILL THIS" MUST MEAN THE FIELD IS ACTUALLY EMPTY (live 2026-08-22) --------------
//
// ORC derives City / State / County from the postal code, so the engine deliberately does not type
// into them: it reads them back, sets `current_value`, marks them verified and flags them for a human
// look. That makes the record `needs_review`, and mapFillStatus turns every needs_review into
// `fill_status: "not_filled"` -- so the catch-all printed "ApplyPilot couldn't fill this - please fill
// it in yourself" over a County field holding "Leon".
//
// It cost real confusion: County read as an unfillable required field and sat at the top of the Oracle
// to-do list as a fill gap. It never was one. The submit gate had it right the whole time, because that
// gate tests `current_value` while this copy tested `fill_status` -- two different fields, and only one
// of them knows whether anything was filled.
test("explainFill: a flagged row WITH a value never claims it could not be filled", () => {
  const filledButFlagged = mk({
    question_label: "County",
    fill_status: "not_filled",   // what mapFillStatus does to every needs_review row
    current_value: "Leon",
    flag: "geo-not-in-profile",
    verified: true,
  });
  const copy = String(explainFill(filledButFlagged) || "");
  assert.ok(!/couldn\u2019t fill this|couldn't fill this/i.test(copy),
    "a row holding a value must never be described as unfilled");
  assert.match(copy, /postal code/i, "and it should say where the value came from");
  assert.match(copy, /Leon/, "and name it, so the operator can check it at a glance");
});

test("explainFill: a geo row that DISAGREES with the approved value says so", () => {
  const copy = String(explainFill(mk({
    question_label: "County", fill_status: "not_filled", current_value: "Jefferson",
    flag: "geo-not-approved", verified: true,
  })) || "");
  assert.match(copy, /differs from what you approved/i);
  assert.match(copy, /Jefferson/);
});

test("explainFill: a genuinely EMPTY flagged row still says it could not be filled", () => {
  // The guard must not swallow the real case -- this is the message's whole purpose.
  for (const v of [undefined, null, "", "   "]) {
    const copy = String(explainFill(mk({
      question_label: "Some Question", fill_status: "not_filled", current_value: v as never, flag: null,
    })) || "");
    assert.match(copy, /couldn\u2019t fill this/i,
      "an empty value must still prompt the operator: " + JSON.stringify(v));
  }
});

// The guard on the CATCH-ALL, which the geo tests above do not reach (their flags return earlier).
// A real instance: ORC's date halves. When only the year commits, the record is `commit-not-accepted`
// with `current_value: "2026"` -- a value the operator can see on the form -- and the old copy told
// them nothing had been filled. Mutation-checked: removing the `!hasValue` guard fails this test.
test("explainFill: an UNFLAGGED flagged-for-review row with a value reaches the catch-all and must not claim it is empty", () => {
  const partial = mk({
    question_label: "End Date",
    fill_status: "not_filled",
    current_value: "2026",      // the year committed, the month did not
    flag: null,
    match_tier: null,
  });
  const copy = String(explainFill(partial) || "");
  assert.ok(!/couldn\u2019t fill this|couldn't fill this/i.test(copy),
    "a row the operator can SEE a value in must never be described as unfilled");
});
