// Multi-ATS (Greenhouse / Lever / Ashby) — the pure parts + the driver against a FAKE
// actuation. The injected fns are exercised for self-containment (no closure references)
// and the driver for the safety semantics: candidates clear the match ladder vs LIVE
// options, AI fills are always flagged, read-back failures end needs_review (never a
// silent wrong value), EEO unstated stays blank.
const { test } = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

// ── detection + URL shaping ─────────────────────────────────────────────────────────────
test("detectAts: the four families + null for everything else", () => {
  assert.strictEqual(ats.detectAts("https://job-boards.greenhouse.io/figma/jobs/61191"), "greenhouse");
  assert.strictEqual(ats.detectAts("https://boards.greenhouse.io/figma/jobs/61191"), "greenhouse");
  assert.strictEqual(ats.detectAts("https://job-boards.eu.greenhouse.io/x/jobs/1"), "greenhouse");
  assert.strictEqual(ats.detectAts("https://jobs.lever.co/kraken123/19e6-uuid/apply"), "lever");
  assert.strictEqual(ats.detectAts("https://jobs.eu.lever.co/co/uuid"), "lever");
  assert.strictEqual(ats.detectAts("https://jobs.ashbyhq.com/openai/de06790a"), "ashby");
  assert.strictEqual(ats.detectAts("https://magna.wd3.myworkdayjobs.com/x/job/1"), "workday");
  assert.strictEqual(ats.detectAts("https://wd5.myworkdaysite.com/recruiting/x"), "workday");
  assert.strictEqual(ats.detectAts("https://example.com/careers"), null);
  assert.strictEqual(ats.detectAts("not a url"), null);
  // lookalike hosts must NOT match (a hostile page must never route into the fill)
  assert.strictEqual(ats.detectAts("https://jobs.lever.co.evil.com/x"), null);
  assert.strictEqual(ats.detectAts("https://fakegreenhouse.io/x/jobs/1"), null);
});

test("atsFormUrl: lever /apply + ashby /application appended once, greenhouse unchanged", () => {
  assert.strictEqual(ats.atsFormUrl("lever", "https://jobs.lever.co/co/uuid"), "https://jobs.lever.co/co/uuid/apply");
  assert.strictEqual(ats.atsFormUrl("lever", "https://jobs.lever.co/co/uuid/apply"), "https://jobs.lever.co/co/uuid/apply");
  assert.strictEqual(ats.atsFormUrl("lever", "https://jobs.lever.co/co/uuid/?lever-origin=applied"), "https://jobs.lever.co/co/uuid/apply");
  assert.strictEqual(ats.atsFormUrl("ashby", "https://jobs.ashbyhq.com/openai/uuid"), "https://jobs.ashbyhq.com/openai/uuid/application");
  assert.strictEqual(ats.atsFormUrl("ashby", "https://jobs.ashbyhq.com/openai/uuid/application"), "https://jobs.ashbyhq.com/openai/uuid/application");
  assert.strictEqual(ats.atsFormUrl("greenhouse", "https://job-boards.greenhouse.io/figma/jobs/1?gh_jid=1"), "https://job-boards.greenhouse.io/figma/jobs/1?gh_jid=1");
});

test("atsCompanyFromUrl: first path segment, prettified; null off-family", () => {
  assert.strictEqual(ats.atsCompanyFromUrl("https://job-boards.greenhouse.io/anthropic/jobs/1"), "Anthropic");
  assert.strictEqual(ats.atsCompanyFromUrl("https://jobs.lever.co/kraken123/uuid/apply"), "Kraken123");
  assert.strictEqual(ats.atsCompanyFromUrl("https://jobs.ashbyhq.com/openai/uuid"), "Openai");
  assert.strictEqual(ats.atsCompanyFromUrl("https://example.com/x"), null);
});

// ── the label router ────────────────────────────────────────────────────────────────────
const PROFILE = {
  personal_info: { first_name: "Kevin", last_name: "Wang", email: "k@x.com", phone_number: "8506660266", city: "Tallahassee", state_province: "Florida", preferred_first_name: "John" },
  work_authorization: { authorized_to_work_in_us: true, requires_sponsorship_now: false, requires_sponsorship_future: false },
  self_identification: { gender: "Male", hispanic_or_latino: "No, I am not Hispanic", race_ethnicity: "Asian", veteran_status: "I am not a protected veteran", disability_status: "No, I don't have a disability" },
  websites: [{ type: "linkedin", url: "linkedin.com/in/wangykev" }, { type: "github", url: "github.com/wangykev" }, { type: "portfolio", url: "" }],
  employment_history_companies: ["Rivian"],
  work_experience: [{ company: "Rivian", currently_work_here: true }],
  how_did_you_hear: { preferred: ["LinkedIn", "Handshake"] },
  application_questions: { availability_and_preferences: { salary_expectation: "", earliest_start_date: "" }, background_and_compliance: { at_least_18_years_old: true } },
};

test("router: work authorization → Yes ladder; sponsorship (now-or-future) → No ladder", () => {
  const r1 = ats.atsRouteLabel("Are you authorized to work in the country for which you applied?", {}, PROFILE, {});
  assert.deepStrictEqual(r1.candidates, ["Yes", "True"]);
  const r2 = ats.atsRouteLabel("Will you now or in the future require sponsorship for employment visa status?", {}, PROFILE, {});
  assert.deepStrictEqual(r2.candidates, ["No", "False"]);
});

test("router: sponsorship answers Yes when EITHER now or future is true", () => {
  const p = JSON.parse(JSON.stringify(PROFILE));
  p.work_authorization.requires_sponsorship_future = true;
  const r = ats.atsRouteLabel("Do you need visa sponsorship now or in the future to work in the US?", {}, p, {});
  assert.deepStrictEqual(r.candidates, ["Yes", "True"]);
});

test("router: links from websites[] with https ensured; empty url → no route (falls to AI/blank)", () => {
  // ensureHttps canonicalizes a bare APEX host to www. (the 2026-07-26 lockstep rule)
  assert.strictEqual(ats.atsRouteLabel("LinkedIn Profile", {}, PROFILE, {}).value, "https://www.linkedin.com/in/wangykev");
  assert.strictEqual(ats.atsRouteLabel("GitHub URL", {}, PROFILE, {}).value, "https://www.github.com/wangykev");
  assert.strictEqual(ats.atsRouteLabel("Portfolio URL", {}, PROFILE, {}), null);
});

test("router: 'US person' / export-control wordings BAIL (never answered from work-auth)", () => {
  assert.strictEqual(ats.atsRouteLabel("Are you a US person as defined by export control regulations, authorized to work?", {}, PROFILE, {}), null);
});

test("router: EEO stated → deterministic candidates; unstated → eeoUnstated (blank, never inferred)", () => {
  assert.deepStrictEqual(ats.atsRouteLabel("Veteran Status", {}, PROFILE, {}).candidates, ["I am not a protected veteran"]);
  const p = JSON.parse(JSON.stringify(PROFILE));
  p.self_identification.gender = "";
  assert.strictEqual(ats.atsRouteLabel("Gender", {}, p, {}).eeoUnstated, true);
});

test("router: empty salary/start-date fall through to AI (null) rather than filling ''", () => {
  assert.strictEqual(ats.atsRouteLabel("What are your salary expectations for this position?", {}, PROFILE, {}), null);
  assert.strictEqual(ats.atsRouteLabel("When can you start a new role?", {}, PROFILE, {}), null);
});

test("router: how-did-you-hear → the preferred ladder; pronouns → skip", () => {
  assert.deepStrictEqual(ats.atsRouteLabel("How did you hear about this job?", {}, PROFILE, {}).candidates, ["LinkedIn", "Handshake"]);
  assert.strictEqual(ats.atsRouteLabel("Pronouns", {}, PROFILE, {}).skip, true);
});

// ── static-map routing + composes ───────────────────────────────────────────────────────
test("routeField: greenhouse statics — names/email map, resume kind, dial kind, EEOC stated", () => {
  const f = (n) => ({ fieldName: n, label: n, widgetType: "text" });
  assert.strictEqual(ats.atsRouteField("greenhouse", f("first_name"), PROFILE, {}, {}, new Map()).raw, "Kevin");
  assert.strictEqual(ats.atsRouteField("greenhouse", f("resume"), PROFILE, {}, {}, new Map()).kind, "resume");
  assert.strictEqual(ats.atsRouteField("greenhouse", f("country"), PROFILE, {}, {}, new Map()), null); // no personal_info.country in this fixture → falls through
  assert.deepStrictEqual(ats.atsRouteField("greenhouse", f("gender"), PROFILE, {}, {}, new Map()).raw, "Male");
});

test("routeField: lever composes — full name, current company, city+state location", () => {
  const f = (n) => ({ fieldName: n, label: n, widgetType: "text" });
  assert.strictEqual(ats.atsRouteField("lever", f("name"), PROFILE, {}, {}, new Map()).value, "Kevin Wang");
  assert.strictEqual(ats.atsRouteField("lever", f("org"), PROFILE, {}, {}, new Map()).value, "Rivian");
  assert.strictEqual(ats.atsRouteField("lever", f("location"), PROFILE, {}, {}, new Map()).value, "Tallahassee, Florida");
  assert.strictEqual(ats.atsRouteField("lever", f("urls[GitHub]"), PROFILE, {}, {}, new Map()).value, "https://www.github.com/wangykev");
});

test("routeField: bucket (exact wording) wins over the label recognizers' absence", () => {
  const lib = require("../lib.js");
  const idx = new Map([[lib.normalizeLabel("Favorite editor?"), { profile_path: null, value: ["Vim"] }]]);
  const r = ats.atsRouteField("greenhouse", { fieldName: "question_1", label: "Favorite editor?", widgetType: "select" }, PROFILE, {}, {}, idx);
  assert.deepStrictEqual(r.candidates, ["Vim"]);
  assert.strictEqual(r.source, "bucket");
});

test("routeField: employment question → deterministic No from a complete employer list", () => {
  const r = ats.atsRouteField("greenhouse", { fieldName: "question_2", label: "Have you ever worked for Figma before, as an employee or a contractor/consultant?", widgetType: "select" }, PROFILE, {}, { company: "Figma" }, new Map());
  assert.ok(r, "expected the employment recognizer to fire");
  assert.deepStrictEqual(r.candidates, ["No"]);
  assert.strictEqual(r.source, "employment");
});

test("dial strip: 'United States +1' → 'United States' (matching only; commit uses full text)", () => {
  assert.strictEqual(ats.atsDialStrip("United States +1"), "United States");
  assert.strictEqual(ats.atsDialStrip("Åland Islands +358"), "Åland Islands");
  assert.strictEqual(ats.atsDialStrip("Canada"), "Canada");
});

// ── injected fns are self-contained (stringify → new Function parses; no closures) ──────
test("every injected fn survives stringification (the cdpEval contract)", () => {
  for (const name of ["atsInjScan", "atsInjSetText", "atsInjReadValue", "atsInjOpenAndReadOptions", "atsInjReadOptions", "atsInjTypeInCombo", "atsInjCommitOption", "atsInjCloseCombo", "atsInjCheckOption", "atsInjSetChecked", "atsInjClickYesNo", "atsInjAttachFile", "atsInjSubmitState", "atsInjErrors", "atsInjSelectNative"]) {
    const src = String(ats[name]);
    assert.doesNotThrow(() => new Function("return (" + src + ")"), name + " does not parse standalone");
    // no references to OTHER ats.js top-level identifiers (would be undefined in the page)
    for (const other of ["atsLib", "atsFd", "ATS_STATIC_MAPS", "atsRouteField", "atsRouteLabel", "atsComposeValue"]) {
      assert.ok(!src.includes(other), name + " references " + other + " (not self-contained)");
    }
  }
});

// ── the driver against a fake actuation ─────────────────────────────────────────────────
function fakeAct(page) {
  // `page` maps injected-fn NAMES to handlers — the fake page.
  return {
    aiEnabled: !!page.aiEnabled,
    llm: page.llm || (async () => ({ ok: false, error: "no-llm" })),
    delay: async () => {}, delayFull: async () => {},
    attachResume: page.attachResume || (async () => ({ ok: true, name: "resume.pdf", verified: true })),
    eval: async (fn, ...args) => {
      const h = page[fn.name];
      if (!h) throw new Error("fake page has no handler for " + fn.name);
      return h(...args);
    },
  };
}

const GH_SCAN = {
  ats: "greenhouse", url: "https://job-boards.greenhouse.io/figma/jobs/1", title: "t",
  fields: [
    { fieldName: "first_name", inputSel: "#first_name", widgetType: "text", label: "First Name", isRequired: true, value: null, domIndex: 0 },
    { fieldName: "question_9", inputSel: "#question_9", widgetType: "select", label: "Are you authorized to work in the country for which you applied?", isRequired: true, value: null, domIndex: 1 },
    { fieldName: "gender", inputSel: "#gender", widgetType: "select", label: "Gender", isRequired: false, value: null, domIndex: 2 },
    { fieldName: "resume", inputSel: "#resume", widgetType: "file_upload", label: "Resume", isRequired: true, value: null, domIndex: 3 },
  ],
};

test("driver: text + select fill deterministically, verified, exact → filled (no flag)", async () => {
  const values = {};
  const act = fakeAct({
    atsInjScan: () => GH_SCAN,
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] != null ? values[sel] : null }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: (sel) => ({ ok: true, open: true, options: (sel === "#question_9" ? ["Yes", "No"] : ["Male", "Female", "Decline To Self Identify"]).map((t) => ({ text: t, disabled: false })) }),
    atsInjCommitOption: (sel, text) => { values[sel] = text; return { ok: true }; },
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, { company: "Figma" }, {});
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));
  assert.strictEqual(by.first_name.status, "filled");
  assert.strictEqual(by.first_name.after, "Kevin");
  assert.strictEqual(by.question_9.status, "filled");
  assert.strictEqual(by.question_9.after, "Yes");
  assert.strictEqual(by.question_9.matchTier, "exact-normalized");
  assert.strictEqual(by.gender.status, "filled");
  assert.strictEqual(by.resume.status, "filled");
  assert.strictEqual(out.needsReview.length, 0);
});

test("driver: a commit that does not persist ends needs_review, never a silent claim", async () => {
  const act = fakeAct({
    atsInjScan: () => ({ ...GH_SCAN, fields: [GH_SCAN.fields[1]] }),
    atsInjOpenAndReadOptions: () => ({ ok: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [{ text: "Yes" }, { text: "No" }] }),
    atsInjCommitOption: () => ({ ok: true }),          // the click "succeeds"…
    atsInjReadValue: () => ({ ok: true, value: null }), // …but the value never lands
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.match(out.results[0].detail, /did not persist/);
});

test("driver: unmapped REQUIRED select falls to AI — flagged, choice must be a live option", async () => {
  const values = {};
  const act = fakeAct({
    aiEnabled: true,
    llm: async () => ({ ok: true, text: JSON.stringify({ choice: "Maybe", justification: "j", confidence: "High" }) }),
    atsInjScan: () => ({ ...GH_SCAN, fields: [{ fieldName: "question_77", inputSel: "#q77", widgetType: "select", label: "Completely custom question?", isRequired: true, value: null, domIndex: 0 }] }),
    atsInjSetText: () => ({ ok: true, after: "" }),
    atsInjOpenAndReadOptions: () => ({ ok: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [{ text: "Alpha" }, { text: "Beta" }] }),
    atsInjCommitOption: (sel, t) => { values[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const r = out.results[0];
  assert.strictEqual(r.status, "needs_review"); // "Maybe" is NOT a live option → refused
  assert.match(r.detail, /which this form doesn't offer/);
});

test("driver: AI choice that IS a live option commits and is ALWAYS filled_review", async () => {
  const values = {};
  const act = fakeAct({
    aiEnabled: true,
    llm: async () => ({ ok: true, text: JSON.stringify({ choice: "Beta", justification: "profile says beta", confidence: "Medium" }) }),
    atsInjScan: () => ({ ...GH_SCAN, fields: [{ fieldName: "question_77", inputSel: "#q77", widgetType: "select", label: "Completely custom question?", isRequired: true, value: null, domIndex: 0 }] }),
    atsInjOpenAndReadOptions: () => ({ ok: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [{ text: "Alpha" }, { text: "Beta" }] }),
    atsInjCommitOption: (sel, t) => { values[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const r = out.results[0];
  assert.strictEqual(r.status, "filled_review");
  assert.strictEqual(r.flag, "ai-choice");
  assert.strictEqual(r.after, "Beta");
});

test("driver: OPTIONAL unmapped field stays blank (no AI spend), REQUIRED text gets the placeholder on decline", async () => {
  const values = {};
  const act = fakeAct({
    aiEnabled: true,
    llm: async () => ({ ok: true, text: JSON.stringify({ skip: true, reason: "no basis" }) }),
    atsInjScan: () => ({
      ...GH_SCAN, fields: [
        { fieldName: "question_1", inputSel: "#q1", widgetType: "textarea", label: "Anything else?", isRequired: false, value: null, domIndex: 0 },
        { fieldName: "question_2", inputSel: "#q2", widgetType: "textarea", label: "Why do you want to join?", isRequired: true, value: null, domIndex: 1 },
      ],
    }),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));
  assert.strictEqual(by.question_1.status, "skipped");           // optional → no AI call, blank
  // required + the AI has no basis → a real, submittable "N/A" (never machine jargon on an
  // employer's form — operator 2026-07-31), still needs_review so approval gates the submit
  assert.strictEqual(by.question_2.status, "needs_review");
  assert.strictEqual(by.question_2.flag, "ai-no-basis");
  assert.strictEqual(values["#q2"], "N/A");
  assert.ok(!/NEEDS YOUR ANSWER|declined/i.test(values["#q2"]), "no jargon reaches the form");
});

test("driver: EEO select with NO stated value stays blank + eeo_declined (never AI-inferred)", async () => {
  const p = JSON.parse(JSON.stringify(PROFILE));
  p.self_identification.gender = "";
  const act = fakeAct({
    aiEnabled: true,
    llm: async () => { throw new Error("the AI must NOT be called for an optional EEO field"); },
    atsInjScan: () => ({ ...GH_SCAN, fields: [{ fieldName: "gender", inputSel: "#gender", widgetType: "select", label: "Gender", isRequired: false, value: null, domIndex: 0 }] }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", p, {}, {}, {});
  assert.strictEqual(out.results[0].status, "skipped");
  assert.strictEqual(out.results[0].flag, "eeo_declined");
});

test("driver: audit — a value the page lost after the fill flips the record to needs_review", async () => {
  let reads = 0;
  const act = fakeAct({
    atsInjScan: () => ({ ...GH_SCAN, fields: [GH_SCAN.fields[0]] }),
    atsInjSetText: (sel, v) => ({ ok: true, after: v }),
    // first read (verify) shows the value; the audit read shows the page dropped it
    atsInjReadValue: () => (++reads === 1 ? { ok: true, value: "Kevin" } : { ok: true, value: null }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.strictEqual(out.results[0].flag, "audit-mismatch");
});

test("driver: replay mode (valueFor) fills from the approved bundle, not the profile", async () => {
  const values = {};
  const act = fakeAct({
    atsInjScan: () => ({ ...GH_SCAN, fields: [GH_SCAN.fields[0], GH_SCAN.fields[3]] }),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {
    valueFor: (f) => (f.fieldName === "first_name" ? "EDITED-NAME" : f.fieldName === "resume" ? "resume.pdf" : undefined),
  });
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));
  assert.strictEqual(by.first_name.after, "EDITED-NAME"); // the APPROVED value, not profile "Kevin"
  assert.strictEqual(by.resume.status, "filled");
});

test("driver: records feed buildReviewBundle unchanged (schema smoke)", async () => {
  const fd = require("../fill-driver.js");
  const act = fakeAct({
    atsInjScan: () => ({ ...GH_SCAN, fields: [GH_SCAN.fields[0]] }),
    atsInjSetText: (sel, v) => ({ ok: true, after: v }),
    atsInjReadValue: () => ({ ok: true, value: "Kevin" }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const bundle = fd.buildReviewBundle(out.results, { page: "/figma/jobs/1", pageNumber: 1, pageLabel: "Application", url: out.url, tenant: "Figma", capturedAt: new Date().toISOString() });
  assert.strictEqual(bundle.entries.length, 1);
  assert.strictEqual(bundle.entries[0].current_value, "Kevin");
  assert.strictEqual(bundle.entries[0].fill_status, "filled");
  assert.ok(bundle.schema_version);
});

// ── canonicalJobUrl ↔ ATS form/posting keying (the submit-run lookup depends on it) ─────
test("canonicalJobUrl: posting and form URLs key identically on all three ATSs", () => {
  const lib = require("../lib.js");
  assert.strictEqual(lib.canonicalJobUrl("https://jobs.lever.co/Co/UUID"), lib.canonicalJobUrl("https://jobs.lever.co/co/uuid/apply"));
  assert.strictEqual(lib.canonicalJobUrl("https://jobs.ashbyhq.com/openai/uuid"), lib.canonicalJobUrl("https://jobs.ashbyhq.com/openai/uuid/application"));
  assert.strictEqual(lib.canonicalJobUrl("https://job-boards.greenhouse.io/figma/jobs/61?gh_jid=61"), lib.canonicalJobUrl("https://job-boards.greenhouse.io/figma/jobs/61"));
  // Workday req-id keys unchanged (regression)
  assert.strictEqual(lib.canonicalJobUrl("https://magna.wd3.myworkdayjobs.com/x/job/T/Software_R00123/apply"), "wd3:r00123");
});

// ── the Scale AI sponsorship/auth collision (live 2026-07-31) ───────────────────────────
test("router: a SPONSORSHIP question that mentions 'work authorization' routes to sponsorship, NEVER auth", () => {
  // "…require company sponsorship to retain or extend your work authorization…" — the auth
  // rung matched the tail and answered "Yes" (authorized) where the correct answer is "No"
  // (no sponsorship needed): a silent wrong deterministic fill. Sponsorship wins; the auth
  // rung refuses any label mentioning sponsor*.
  const r = ats.atsRouteLabel(
    "Will you now or in the future require company sponsorship to retain or extend your work authorization in the country where the job is located?",
    {}, PROFILE, {}
  );
  assert.deepStrictEqual(r.candidates, ["No", "False"]);
  assert.match(r.detail, /requires_sponsorship/);
});

test("router: identity ALIASES are NOT code rungs — they live in the website's bucket wordings (operator 2026-07-31)", () => {
  // "Phone" / current-employer / country-of-residence / preferred-name phrasings route through
  // the BUCKET tier (DEFAULT_ALIAS_WORDINGS in web/lib/teach.ts — visible + editable on
  // /app/teach), never through hidden regexes here. The router must return null for them.
  assert.strictEqual(ats.atsRouteLabel("Who is your current or most recent employer?", {}, PROFILE, {}), null);
  assert.strictEqual(ats.atsRouteLabel("What is your current country of residence?", {}, PROFILE, {}), null);
  assert.strictEqual(ats.atsRouteLabel("Phone", {}, PROFILE, {}), null);
  // …but a matching BUCKET (what the website seeds) fills it through the ordinary bucket tier:
  const lib = require("../lib.js");
  const idx = new Map([[lib.normalizeLabel("Phone"), { profile_path: "personal_info.phone_number", value: [] }]]);
  const r = ats.atsRouteField("lever", { fieldName: "q1", label: "Phone", widgetType: "text" }, PROFILE, {}, {}, idx);
  assert.strictEqual(r.raw, "8506660266");
  assert.strictEqual(r.source, "bucket");
});

test("router: the full-name COMPOSE stays code-side (no single profile field can express it)", () => {
  assert.strictEqual(ats.atsRouteLabel("Full Name", {}, PROFILE, {}).value, "Kevin Wang");
  assert.strictEqual(ats.atsRouteLabel("Name of your referrer", {}, PROFILE, {}), null); // anchored — never a stray "name" hit
});

// ── the APPLY-ELSEWHERE decoy (operator 2026-07-31, Anthropic/Constellation) ─────────────
test("redirect: the strong phrases match the live Anthropic wordings — and ordinary postings never do", () => {
  assert.ok(ats.ATS_REDIRECT_STRONG_RE.test("You do not need to submit this Greenhouse application."));
  assert.ok(ats.ATS_REDIRECT_STRONG_RE.test("Please note that you will not be considered unless you complete the Constellation application form."));
  assert.ok(ats.ATS_REDIRECT_STRONG_RE.test("you don't need to fill out this application"));
  // never on ordinary language a real form uses:
  assert.ok(!ats.ATS_REDIRECT_STRONG_RE.test("Please complete this application form below."));
  assert.ok(!ats.ATS_REDIRECT_STRONG_RE.test("You will be considered for future roles."));
  assert.ok(!ats.ATS_REDIRECT_STRONG_RE.test("Submit your application when ready."));
});

test("redirect: the anchor pick prefers apply-labeled text, refuses ambiguity, ignores noise links", () => {
  const anchors = [
    { href: "https://www.anthropic.com/jobs", text: "", nearPhrase: false },
    { href: "https://bit.ly/afpsafety", text: "Apply using this link", nearPhrase: false },
    { href: "https://alignment.anthropic.com/2024/fellows/", text: "Anthropic Fellows for AI Safety Research", nearPhrase: false },
    { href: "https://bit.ly/afpsafety", text: "application", nearPhrase: true }, // same href twice = still ONE target
  ];
  assert.strictEqual(ats.atsPickRedirectAnchor(anchors), "https://bit.ly/afpsafety");
  // two DIFFERENT apply-labeled targets → ambiguous → null (report, never guess)
  assert.strictEqual(ats.atsPickRedirectAnchor([
    { href: "https://a.example/apply", text: "Apply here" },
    { href: "https://b.example/apply", text: "Apply using this link" },
  ]), null);
  assert.strictEqual(ats.atsPickRedirectAnchor([]), null);
});

test("redirect: atsInjDetectRedirect is self-contained (the cdpEval contract)", () => {
  const src = String(ats.atsInjDetectRedirect);
  assert.doesNotThrow(() => new Function("return (" + src + ")"));
  for (const other of ["atsLib", "atsFd", "ATS_REDIRECT_STRONG_RE", "atsPickRedirectAnchor"]) {
    assert.ok(!src.includes(other), "references " + other);
  }
});

// ── canonical_field: a deterministic rung must NAME its profile path (the teach hand-off) ──
test("router: profile-backed rungs carry `path` so the review entry gets canonical_field", () => {
  // Live 2026-07-31: Zoox "Race" filled deterministically from the profile but the EEO rung
  // returned candidates with NO path → canonical_field empty → the teach page said "no
  // existing field matched" and offered to create a duplicate answer instead of binding to
  // self_identification.race_ethnicity.
  const cases = [
    ["Race", "self_identification.race_ethnicity"],
    ["Gender", "self_identification.gender"],
    ["Veteran Status", "self_identification.veteran_status"],
    ["Disability Status", "self_identification.disability_status"],
    ["Are you Hispanic/Latino?", "self_identification.hispanic_or_latino"],
    ["Are you legally authorized to work in the United States?", "work_authorization.authorized_to_work_in_us"],
    ["Will you now or in the future require sponsorship?", "work_authorization.requires_sponsorship_now"],
    ["How did you hear about this job?", "how_did_you_hear.preferred"],
  ];
  for (const [label, path] of cases) {
    const r = ats.atsRouteLabel(label, {}, PROFILE, {});
    assert.ok(r, "no route for " + label);
    assert.strictEqual(r.path, path, label);
  }
});

// ── a STATED value the form can't take must SURFACE, not vanish (live 2026-07-31) ────────
test("driver: stated-but-unmatched flags the record so review + teach can see it", async () => {
  const act = fakeAct({
    atsInjScan: () => ({ ...GH_SCAN, fields: [{ fieldName: "gender", inputSel: "#gender", widgetType: "select", label: "Gender", isRequired: false, value: null, domIndex: 0 }] }),
    atsInjOpenAndReadOptions: () => ({ ok: true }),
    // the form words gender as Man/Woman — the profile says "Male": no exact, no containment
    atsInjReadOptions: () => ({ ok: true, open: true, options: [{ text: "Man" }, { text: "Woman" }, { text: "Prefer not to say" }] }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCloseCombo: () => ({ ok: true }),
    atsInjReadValue: () => ({ ok: true, value: null }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.strictEqual(out.results[0].flag, "stated-value-unmatched");
  assert.match(out.results[0].detail, /isn't one of this form's options/);
  assert.ok(out.results[0].options.includes("Man"), "the live options ride along so review can pick one");
});

// ── the landing may not be the form: apply-link following (live 2026-07-31) ──────────────
test("atsPickApplyLink: prefers a DRIVABLE ats link, refuses ambiguity, falls back to one apply-labelled link", () => {
  const isAts = ats.detectAts;
  // a company careers page linking to its real Greenhouse form
  assert.strictEqual(ats.atsPickApplyLink([
    { href: "https://stripe.example/careers", text: "Careers", kind: "text" },
    { href: "https://job-boards.greenhouse.io/co/jobs/1", text: "Apply now", kind: "text" },
  ], isAts), "https://job-boards.greenhouse.io/co/jobs/1");
  // two DIFFERENT drivable targets, both apply-labelled → refuse
  assert.strictEqual(ats.atsPickApplyLink([
    { href: "https://jobs.lever.co/a/uuid1/apply", text: "Apply", kind: "text" },
    { href: "https://jobs.ashbyhq.com/b/uuid2/application", text: "Apply", kind: "text" },
  ], isAts), null);
  // no drivable link, but exactly one apply-LABELLED one → follow it and re-classify on landing
  assert.strictEqual(ats.atsPickApplyLink([
    { href: "https://acme.example/jobs/7", text: "Apply for this role", kind: "text" },
    { href: "https://acme.example/about", text: "About us", kind: "href" },
  ], isAts), "https://acme.example/jobs/7");
  // a Workday requisition is surfaced (the caller hands it to the Workday pipeline)
  assert.strictEqual(ats.atsPickApplyLink([
    { href: "https://co.wd5.myworkdayjobs.com/x/job/Eng_R1", text: "Apply", kind: "text" },
  ], isAts), "https://co.wd5.myworkdayjobs.com/x/job/Eng_R1");
  assert.strictEqual(ats.atsPickApplyLink([], isAts), null);
});

test("atsInjFindApplyLinks is self-contained (the cdpEval contract)", () => {
  const src = String(ats.atsInjFindApplyLinks);
  assert.doesNotThrow(() => new Function("return (" + src + ")"));
  for (const other of ["atsLib", "atsFd", "detectAts", "atsPickApplyLink"]) assert.ok(!src.includes(other), "references " + other);
});

// ── a reviewed choice field must ALWAYS carry the form's options (live 2026-07-31) ────────
test("driver: an AI pick that is not a live option still leaves the OPTIONS on the record", async () => {
  // Otherwise review renders "please fill it in yourself" with nothing to pick from, even
  // though the fill had just read the whole list — the operator is stranded on a required field.
  const act = fakeAct({
    aiEnabled: true,
    llm: async () => ({ ok: true, text: JSON.stringify({ choice: "Carnegie Mellon University", justification: "j", confidence: "High" }) }),
    atsInjScan: () => ({ ...GH_SCAN, fields: [{ fieldName: "q_uni", inputSel: "#uni", widgetType: "select", label: "Which university did you attend?", isRequired: true, value: null, domIndex: 0 }] }),
    atsInjOpenAndReadOptions: () => ({ ok: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [{ text: "Other (School Not Listed)" }, { text: "MIT" }, { text: "Stanford University" }] }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: () => ({ ok: true }),
    atsInjReadValue: () => ({ ok: true, value: null }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const r = out.results[0];
  assert.strictEqual(r.status, "needs_review");
  assert.deepStrictEqual(r.options, ["Other (School Not Listed)", "MIT", "Stanford University"],
    "a SHORT list keeps every option — each is a legitimate choice");
  assert.match(r.detail, /pick the right option here/);
});

// ── a TRUNCATED option list must not render as a pick-one <select> (live 2026-07-31) ─────
// PARTIAL IS PROVENANCE, NOT LENGTH (revised 2026-08-07). The caller says whether the list was
// reached by TYPING; length alone was throwing away options we had already read — Discord's dial
// `country` menu holds all 244 entries in the DOM and `discipline--0` all 72, so the old >= 60 rule
// stored 60 of them and told the operator it was "not the full list".
test("atsAttachOptions: a list read unfiltered is complete however long; a searched one is partial", () => {
  const short = { widgetType: "dropdown" };
  ats.atsAttachOptions(short, ["Yes", "No"]);
  assert.deepStrictEqual(short.options, ["Yes", "No"]);
  assert.strictEqual(short.widgetType, "dropdown", "a complete list stays a select");
  assert.ok(!short.captured_options);

  // 244 countries read on OPEN — the whole list, and review must get all of it
  const countries = { widgetType: "dropdown" };
  ats.atsAttachOptions(countries, Array.from({ length: 244 }, (_, i) => "Country " + i));
  assert.strictEqual(countries.options.length, 244, "an unfiltered read is the complete list");
  assert.strictEqual(countries.captured_options, null);
  assert.strictEqual(countries.widgetType, "dropdown", "a complete list stays a pick-one");
  assert.ok(!countries.optionsPartial);

  // the SAME length, reached by typing → a filtered view, and it must say so
  const searched = { widgetType: "dropdown" };
  ats.atsAttachOptions(searched, Array.from({ length: 244 }, (_, i) => "Country " + i), true);
  assert.strictEqual(searched.options, null, "a partial list must NOT masquerade as the full option set");
  assert.strictEqual(searched.widgetType, "typeahead", "review renders a type-to-filter editor + partial note");
  assert.strictEqual(searched.optionsPartial, true);

  // a page-sized read reached by typing is partial too (live: 100 of ~3300 schools)
  const exact = { widgetType: "dropdown" };
  ats.atsAttachOptions(exact, Array.from({ length: 60 }, (_, i) => "S" + i), true);
  assert.strictEqual(exact.widgetType, "typeahead", "a searched page is partial, not complete");

  // …and a list too big to store is truncated, but SAYS it was — never silently
  const huge = { widgetType: "dropdown" };
  ats.atsAttachOptions(huge, Array.from({ length: 2000 }, (_, i) => "School " + i));
  assert.strictEqual(huge.options, null);
  assert.strictEqual(huge.captured_options.length, 400);
  assert.strictEqual(huge.optionsPartial, true, "a truncated list must never claim to be complete");

  const none = { widgetType: "dropdown" };
  ats.atsAttachOptions(none, []);
  assert.ok(!none.options && !none.captured_options);
});

// ── review must show the options CLOSEST to the intended value (live 2026-07-31) ──────────
test("atsNearOptions: ranks the real choices for the value we wanted", () => {
  const schools = ["Aalborg University", "Carnegie Mellon University - Pittsburgh", "Carnegie Mellon University - Silicon Valley", "Mellon College", "Institut Polytechnique"];
  const near = ats.atsNearOptions(schools, "Carnegie Mellon University", 10);
  assert.deepStrictEqual(near.slice(0, 2), ["Carnegie Mellon University - Pittsburgh", "Carnegie Mellon University - Silicon Valley"],
    "both campuses first — that IS the operator's choice");
  assert.ok(!near.includes("Institut Polytechnique"), "an option sharing no tokens is excluded");
  // a query with no significant tokens can't rank anything
  assert.deepStrictEqual(ats.atsNearOptions(schools, "of", 5), []);
  assert.deepStrictEqual(ats.atsNearOptions([], "x", 5), []);
});

test("driver: on a LONG list the review options narrow to the near-matches; a short list keeps all", async () => {
  const long = Array.from({ length: 300 }, (_, i) => "Nowhere University " + i).concat(["Carnegie Mellon University - Pittsburgh", "Carnegie Mellon University - Silicon Valley"]);
  const act = fakeAct({
    aiEnabled: true,
    llm: async () => ({ ok: true, text: JSON.stringify({ choice: "Carnegie Mellon University", justification: "j", confidence: "High" }) }),
    atsInjScan: () => ({ ...GH_SCAN, fields: [{ fieldName: "q_uni", inputSel: "#uni", widgetType: "select", label: "Which university?", isRequired: true, value: null, domIndex: 0 }] }),
    atsInjOpenAndReadOptions: () => ({ ok: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: long.map((t) => ({ text: t })) }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: () => ({ ok: true }),
    atsInjReadValue: () => ({ ok: true, value: null }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const r = out.results[0];
  const shown = r.captured_options || r.options || [];
  assert.ok(shown.includes("Carnegie Mellon University - Pittsburgh"), "the operator must SEE the real choices");
  assert.ok(shown.length <= 20, "a 302-option list is narrowed to the relevant neighbourhood");
});

// ── a SERVER-BACKED list that answers LATE (live 2026-08-04, Discord's school picker) ────────
// Traced on a hidden tab, from the instant the query was typed: 0 options + "No options" at 4ms,
// "Loading..." at 24ms, "Swarthmore College" at 4049ms. So the fill's flat 2s budget could never
// have worked — and its retry made it worse by RE-TYPING, which restarts the widget's own
// debounce and discards the search already in flight.
// A PAGE of a long server-backed list — 100 rows, the way Greenhouse actually renders one. Fixtures
// used to stand this in with a single row, which the driver now (correctly) reads as a COMPLETE list
// and therefore does not search — so the stand-in has to look like the thing it stands for.
const PAGE_OF_SCHOOLS = Array.from({ length: 100 }, (_, i) => "Aalborg University " + i);

const SCHOOL_BUCKETS = [{ questions: ["School"], profile_path: "education.0.school_or_university" }];
const SCHOOL_PROFILE = Object.assign({}, PROFILE, { education: [{ school_or_university: "Swarthmore College" }] });
const SCHOOL_SCAN = {
  ...GH_SCAN,
  fields: [{ fieldName: "school--0", inputSel: "#school--0", widgetType: "select", label: "School", isRequired: true, value: null, domIndex: 0 }],
};

test("driver: a list still LOADING is waited out, and the search is never restarted", async () => {
  // The fake answers LATER than the soft search budget — the shape that used to end needs_review.
  const ANSWER_MS = 2600;
  let query = "", typedAt = null, committed = null;
  const typeCalls = [];
  const act = fakeAct({
    atsInjScan: () => SCHOOL_SCAN,
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjTypeInCombo: (sel, t) => { typeCalls.push(t); query = t; typedAt = Date.now(); return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: query }),
    atsInjReadOptions: () => {
      // page 1 of a 3300-school list: the value we want is NOT on it
      if (!query) return { ok: true, open: true, options: PAGE_OF_SCHOOLS.map((t) => ({ text: t })), loading: false };
      const answered = typedAt != null && Date.now() - typedAt >= ANSWER_MS;
      // …and while the server search runs, the widget shows an EMPTY menu ("No options")
      return { ok: true, open: true, options: answered ? [{ text: "Swarthmore College" }] : [], loading: !answered };
    },
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", SCHOOL_PROFILE, {}, {}, { buckets: SCHOOL_BUCKETS });
  const r = out.results[0];
  assert.strictEqual(r.status, "filled", "a slow list is not an absent option: " + r.detail);
  assert.strictEqual(r.after, "Swarthmore College");
  assert.strictEqual(typeCalls.filter((t) => t === "Swarthmore College").length, 1, "the query is typed once");
});

test("driver: a list that never finishes loading says SO, instead of 'listed no options'", async () => {
  const saved = Object.assign({}, ats.ATS_POLL);
  Object.assign(ats.ATS_POLL, { open: 20, openCeil: 120, retry: 20, retryCeil: 120, search: 20, searchCeil: 200, restore: 20, restoreCeil: 60, showing: 20, showingCeil: 60 });
  try {
    let query = "";
    const typeCalls = [];
    const act = fakeAct({
      atsInjScan: () => SCHOOL_SCAN,
      atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
      atsInjTypeInCombo: (sel, t) => { typeCalls.push(t); query = t; return { ok: true }; },
      atsInjReadComboInput: () => ({ ok: true, value: query }),
      atsInjReadOptions: () => ({ ok: true, open: true, options: [], loading: true }), // never answers
      atsInjCommitOption: () => ({ ok: true }),
      atsInjReadValue: () => ({ ok: true, value: null }),
      atsInjCloseCombo: () => ({ ok: true }),
    });
    const out = await ats.driveAtsPageFill(act, "greenhouse", SCHOOL_PROFILE, {}, {}, { buckets: SCHOOL_BUCKETS });
    const r = out.results[0];
    assert.strictEqual(r.status, "needs_review");
    assert.match(r.detail, /still loading/, "the operator must learn the FORM was slow, not that the answer is missing");
    // and it must never have restarted that search: re-typing throws away what is in flight
    assert.strictEqual(typeCalls.filter((t) => t === "Swarthmore College").length, 1,
      "a widget that reported LOADING is waited out, never re-typed");
  } finally { Object.assign(ats.ATS_POLL, saved); }
});

test("driver: a LOCAL list that rendered raggedly still gets its one re-type nudge", async () => {
  // The counterpart to the rule above, pinned so protecting async searches does not quietly
  // remove the recovery that a client-side widget (no loading state, e.g. Greenhouse's #country)
  // does need: nothing is in flight, so one re-type can only help.
  const saved = Object.assign({}, ats.ATS_POLL);
  Object.assign(ats.ATS_POLL, { open: 20, openCeil: 40, retry: 200, retryCeil: 200, search: 20, searchCeil: 20, restore: 20, restoreCeil: 20, showing: 20, showingCeil: 20 });
  try {
    let query = "", committed = null;
    const typeCalls = [];
    const act = fakeAct({
      atsInjScan: () => SCHOOL_SCAN,
      atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
      atsInjTypeInCombo: (sel, t) => { typeCalls.push(t); query = t; return { ok: true }; },
      atsInjReadComboInput: () => ({ ok: true, value: query }),
      // empty until the query has been typed TWICE — a widget that needed the nudge. `loading` is
      // never set: a client-side list has no fetch to report.
      atsInjReadOptions: () => {
        const nudged = typeCalls.filter((t) => t === "Swarthmore College").length >= 2;
        if (!query) return { ok: true, open: true, options: PAGE_OF_SCHOOLS.map((t) => ({ text: t })) };
        return { ok: true, open: true, options: nudged ? [{ text: "Swarthmore College" }] : [] };
      },
      atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
      atsInjReadValue: () => ({ ok: true, value: committed }),
      atsInjCloseCombo: () => ({ ok: true }),
    });
    const out = await ats.driveAtsPageFill(act, "greenhouse", SCHOOL_PROFILE, {}, {}, { buckets: SCHOOL_BUCKETS });
    assert.strictEqual(out.results[0].status, "filled", "the nudge must still exist for a local widget");
    assert.strictEqual(committed, "Swarthmore College");
  } finally { Object.assign(ats.ATS_POLL, saved); }
});

test("driver: the option a by-name search found is not cleared away before the click", async () => {
  // A long server-backed list does not carry the value on its unfiltered first page at all, so
  // clearing the query to 'unfilter' the menu throws away the very option we matched, and the
  // commit then fails option-not-found. Modelled exactly: the menu shows what the query matches,
  // and a click only lands on an option that is currently VISIBLE (as in the real DOM).
  const PAGE1 = PAGE_OF_SCHOOLS;
  const ALL = PAGE1.concat(["Swarthmore College"]);
  let query = "", committed = null;
  const visible = () => (query ? ALL.filter((s) => s.toLowerCase().startsWith(query.toLowerCase())) : PAGE1);
  const act = fakeAct({
    atsInjScan: () => SCHOOL_SCAN,
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjTypeInCombo: (sel, t) => { query = t; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: query }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: visible().map((t) => ({ text: t })), loading: false }),
    atsInjCommitOption: (sel, t) => (visible().includes(t) ? ((committed = t), { ok: true }) : { ok: false, error: "option-not-found" }),
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", SCHOOL_PROFILE, {}, {}, { buckets: SCHOOL_BUCKETS });
  const r = out.results[0];
  assert.strictEqual(r.status, "filled", "the searched option must still be on screen when we click it: " + r.detail);
  assert.strictEqual(committed, "Swarthmore College");
});

test("driver: a PAGED list never claims the profile answer is absent", async () => {
  // Live 2026-08-04: the school field reported 'your profile answer isn't one of this form's
  // options' after reading 100 of ~3300 schools whose search had timed out — sending the operator
  // to look for a missing option that is really there, and hiding the real problem.
  const page1 = Array.from({ length: 100 }, (_, i) => "University " + i);   // page-sized read
  let query = "";
  const act = fakeAct({
    atsInjScan: () => SCHOOL_SCAN,
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjTypeInCombo: (sel, t) => { query = t; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: query }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: page1.map((t) => ({ text: t })) }),
    atsInjCommitOption: () => ({ ok: false, error: "option-not-found" }),
    atsInjReadValue: () => ({ ok: true, value: null }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", SCHOOL_PROFILE, {}, {}, { buckets: SCHOOL_BUCKETS });
  const r = out.results[0];
  assert.strictEqual(r.status, "needs_review");
  assert.doesNotMatch(r.detail, /isn't one of this form's options/, "a paged list cannot prove absence");
  assert.match(r.detail, /never answered our search/);
  // and review must get a TYPE-or-filter editor, not a pick-one <select> of the near-matches:
  // narrowing 100 read options down to 20 must not launder a paged list into a complete one
  assert.strictEqual(r.optionsPartial, true, "a narrowed page is still a partial list");
  assert.strictEqual(r.options, null, "options[] would render as the whole truth");
  assert.ok((r.captured_options || []).length, "the operator still sees what we did read");

  // …but a SHORT, complete list CAN prove it, and must keep saying so plainly.
  const act2 = fakeAct({
    atsInjScan: () => SCHOOL_SCAN,
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjTypeInCombo: (sel, t) => { query = t; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: query }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [{ text: "MIT" }, { text: "Stanford University" }] }),
    atsInjCommitOption: () => ({ ok: false, error: "option-not-found" }),
    atsInjReadValue: () => ({ ok: true, value: null }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out2 = await ats.driveAtsPageFill(act2, "greenhouse", SCHOOL_PROFILE, {}, {}, { buckets: SCHOOL_BUCKETS });
  assert.match(out2.results[0].detail, /isn't one of this form's options/);
});

// ── a NUMBERED option list must not defeat an exact profile answer (live 2026-08-05) ──────
test("atsEnumStrip: list numbering is display scaffolding, not part of the answer", () => {
  assert.strictEqual(ats.atsEnumStrip("1. United States of America"), "United States of America");
  assert.strictEqual(ats.atsEnumStrip("2) Canada"), "Canada");
  assert.strictEqual(ats.atsEnumStrip("10. Located Elsewhere"), "Located Elsewhere");
  // …and values that merely START with digits keep every character
  assert.strictEqual(ats.atsEnumStrip("1 - 3 years"), "1 - 3 years");
  assert.strictEqual(ats.atsEnumStrip("401(k) eligible"), "401(k) eligible");
  assert.strictEqual(ats.atsEnumStrip("2026 graduate"), "2026 graduate");
  assert.strictEqual(ats.atsEnumStrip(""), "");
});

test("driver: a numbered dropdown fills from the exact profile value, committing the REAL text", async () => {
  // GitLab's "Where are you currently based?*" renders "1. United States of America" while the
  // profile holds "United States of America": exact missed, containment is off for dropdowns by
  // design, and fuzzy scored 88.9% against the 90 bar — so a REQUIRED field the profile answers
  // perfectly was left empty for the operator.
  let committed = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/gitlab/jobs/1", title: "t",
      fields: [{ fieldName: "q_based", inputSel: "#q_based", widgetType: "select", label: "Where are you currently based?", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: ["1. United States of America", "2. Canada", "3. Located Elsewhere"].map((t) => ({ text: t })) }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const buckets = [{ questions: ["Where are you currently based?"], profile_path: "personal_info.country" }];
  const profile = { ...PROFILE, personal_info: { ...PROFILE.personal_info, country: "United States of America" } };
  const out = await ats.driveAtsPageFill(act, "greenhouse", profile, {}, {}, { buckets });
  const r = out.results[0];
  assert.strictEqual(r.status, "filled", "an exact profile answer must not be lost to list numbering: " + r.detail);
  assert.strictEqual(r.matchTier, "exact-normalized");
  assert.strictEqual(committed, "1. United States of America", "the click uses the option's REAL text");
  assert.strictEqual(r.after, "1. United States of America");
});

test("driver: an unmounted menu is not an empty menu — the open poll SETTLES", async () => {
  // A react-select paints its list a beat after the open click. Believing that beat ("0 options")
  // is what read a required 3-option question as empty and mis-routed it (2026-08-05). The soft
  // deadline is deliberately 1ms here: only a settle — not a bigger number — can pass this.
  const saved = Object.assign({}, ats.ATS_POLL);
  Object.assign(ats.ATS_POLL, { open: 1, openCeil: 2000, retry: 1, retryCeil: 20, search: 1, searchCeil: 20, restore: 1, restoreCeil: 20, showing: 1, showingCeil: 200 });
  try {
    // Faithful widget: a click TOGGLES the menu (the documented rule), and after opening it needs
    // a couple of reads before its list paints. So giving up on the first empty read and then
    // force-clicking just shuts it again — the failure loop seen live.
    let isOpen = false, openedAt = 0, committed = null; const opens = [];
    const MOUNT_MS = 60;   // the menu paints 60ms after the click — a TIME, like the real widget
    const act = fakeAct({
      atsInjScan: () => ({
        ats: "greenhouse", url: "https://job-boards.greenhouse.io/gitlab/jobs/1", title: "t",
        fields: [{ fieldName: "q_based", inputSel: "#q_based", widgetType: "select", label: "Where are you currently based?", isRequired: true, value: null, domIndex: 0 }],
      }),
      atsInjOpenAndReadOptions: (sel, force) => { opens.push(!!force); isOpen = !isOpen; openedAt = Date.now(); return { ok: true, opened: isOpen }; },
      atsInjReadOptions: () => {
        if (!isOpen || Date.now() - openedAt < MOUNT_MS) return { ok: true, open: false, options: [] };  // mounting
        return { ok: true, open: true, options: ["1. United States of America", "2. Canada"].map((t) => ({ text: t })) };
      },
      atsInjTypeInCombo: () => ({ ok: true }),
      atsInjReadComboInput: () => ({ ok: true, value: "" }),
      atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
      atsInjReadValue: () => ({ ok: true, value: committed }),
      atsInjCloseCombo: () => ({ ok: true }),
    });
    const profile = { ...PROFILE, personal_info: { ...PROFILE.personal_info, country: "United States of America" } };
    const out = await ats.driveAtsPageFill(act, "greenhouse", profile, {}, {}, {});
    assert.strictEqual(out.results[0].status, "filled", "the poll must wait for the menu to mount: " + out.results[0].detail);
    assert.strictEqual(committed, "1. United States of America");
    // The load-bearing assertion, and the one that is independent of any clock: waiting for the
    // menu to mount means the forced-toggle recovery never has to run. A clock-only poll gives up
    // on the mounting beat and then force-clicks — which SHUTS the menu it was waiting for.
    assert.deepStrictEqual(opens, [false], "one plain open, no forced toggles");
  } finally { Object.assign(ats.ATS_POLL, saved); }
});

test('driver: "where are you based?" answered by a 3-option pick-one, not a places lookup', async () => {
  // Live 2026-08-05, GitLab: the label reads like a places question, so the fill typed a city and
  // waited out a suggestion service that never answers — reporting "places never loaded" on a
  // REQUIRED field whose own widget was already showing the answer.
  let committed = null; const typed = [];
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/gitlab/jobs/1", title: "t",
      fields: [{ fieldName: "q_based", inputSel: "#q_based", widgetType: "location", label: "Where are you currently based?", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: ["1. United States of America", "2. Canada", "3. Located Elsewhere"].map((t) => ({ text: t })) }),
    atsInjTypeInCombo: (sel, t) => { if (t) typed.push(t); return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const profile = { ...PROFILE, personal_info: { ...PROFILE.personal_info, country: "United States of America" } };
  const out = await ats.driveAtsPageFill(act, "greenhouse", profile, {}, {}, {});
  const r = out.results[0];
  assert.strictEqual(r.status, "filled", "the widget's own list answers it: " + r.detail);
  assert.strictEqual(committed, "1. United States of America");
  assert.deepStrictEqual(typed, [], "no city was typed at a widget that is not a places box");

  // …and a REAL places widget (no options until you type) still types and waits.
  let asked = null;
  const act2 = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/x/jobs/1", title: "t",
      fields: [{ fieldName: "candidate-location", inputSel: "#candidate-location", widgetType: "location", label: "Location (City)", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: asked ? [{ text: "Tallahassee, FL, USA" }] : [] }),
    atsInjTypeInCombo: (sel, t) => { if (t) asked = t; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: asked || "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out2 = await ats.driveAtsPageFill(act2, "greenhouse", profile, {}, {}, {});
  assert.strictEqual(asked, "Tallahassee", "a places box is still asked by city");
  assert.strictEqual(out2.results[0].status, "filled");
});

test("router: a location question survives a TIERED country list (no crash, every tier tried)", async () => {
  // The profile stores ladders as arrays, and personal_info.country is one of them. Handing the
  // array to the match ladder threw `s.toLowerCase is not a function` and killed the field
  // mid-fill (live 2026-08-05). Every tier must arrive as its own candidate.
  const profile = { ...PROFILE, personal_info: { ...PROFILE.personal_info, country: ["Afghanistan", "United States of America"] } };
  const r = ats.atsRouteLabel("Where are you currently based?", {}, profile, {});
  assert.ok(Array.isArray(r.candidates), "tiered candidates, not one joined string");
  assert.ok(r.candidates.every((c) => typeof c === "string"), "no nested arrays reach the ladder");
  assert.ok(r.candidates.includes("United States of America"));
  assert.strictEqual(typeof r.value, "string");

  // and end to end: the later tier is the one that matches the form's numbered option
  let committed = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/gitlab/jobs/1", title: "t",
      fields: [{ fieldName: "q_based", inputSel: "#q_based", widgetType: "select", label: "Where are you currently based?", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: ["1. United States of America", "2. Canada"].map((t) => ({ text: t })) }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", profile, {}, {}, {});
  assert.strictEqual(out.results[0].status, "filled", out.results[0].detail);
  assert.strictEqual(committed, "1. United States of America");
});

// ── the RÉSUMÉ goes in the résumé slot, and nowhere else (live 2026-08-04) ─────────────────
test("replay: the résumé is attached ONLY to the résumé field, never the cover letter", async () => {
  // Greenhouse renders the cover letter as a file dropzone too. The replay used to treat every
  // file field as the résumé, which put Kevin's résumé in the cover-letter slot on a rehearsal —
  // on a real submit that files the wrong document, and no gate can catch it (the strict verify
  // only re-checks approved VALUES, and the bundle carries no file for a skipped field).
  const attached = [];
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/discord/jobs/1", title: "t",
      fields: [
        { fieldName: "resume", inputSel: "#resume", widgetType: "file_upload", label: "Resume", isRequired: true, value: null, domIndex: 0 },
        { fieldName: "cover_letter", inputSel: "#cover_letter", widgetType: "file_upload", label: "Cover Letter", isRequired: false, value: null, domIndex: 1 },
      ],
    }),
    attachResume: async (ref) => { attached.push(ref.inputSel); return { ok: true, name: "resume.pdf", verified: true }; },
  });
  // a submit/replay run: valueFor answers for BOTH entries (the cover letter was skipped, so it
  // carries an empty value — which is NOT permission to attach something)
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, { valueFor: () => "" });
  assert.deepStrictEqual(attached, ["#resume"], "exactly one attach, to the résumé field");
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));
  assert.strictEqual(by.resume.status, "filled");
  assert.strictEqual(by.cover_letter.status, "skipped");
  assert.match(by.cover_letter.detail, /cover letter|not the r/i);
});

test("replay: a dial composite keeps its dial routing, so an approved code commits", async () => {
  // The replay used to route every non-file field as a plain value, actuating Greenhouse's
  // phone-dial composite as an ordinary select. Live 2026-08-05 that ended `skipped` and blocked
  // an otherwise-clean submit. The approved value here is the bare country: only the dial path
  // (which strips the option's trailing "+<digits>" for matching) can land it.
  let committed = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/gitlab/jobs/1", title: "t",
      fields: [{ fieldName: "country", inputSel: "#country", widgetType: "select", label: "Country", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [{ text: "United States +1" }, { text: "Canada +1" }] }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, { valueFor: () => "United States" });
  assert.strictEqual(out.results[0].status, "filled", "the dial path must survive the replay: " + out.results[0].detail);
  assert.strictEqual(committed, "United States +1", "the click uses the option's real text");
});

test("driver: a BUSY page is waited out; the quiet watch is what says the menu isn't coming", async () => {
  // Ported from the Workday branch: the page stamps its last mutation, the SW does the waiting.
  // While the subtree is still churning, an absent menu means "mid-reaction", not "no such menu" —
  // the distinction my read-latency proxy could only guess at (live 2026-08-05).
  const saved = Object.assign({}, ats.ATS_POLL);
  Object.assign(ats.ATS_POLL, { open: 1, openCeil: 3000, retry: 1, retryCeil: 1, search: 1, searchCeil: 1, restore: 1, restoreCeil: 1, showing: 1, showingCeil: 1, busyIdleMs: 300 });
  try {
    const MOUNT_AT = Date.now() + 900;     // the menu appears well after the soft deadline
    let quietCalls = 0, committed = null;
    const act = fakeAct({
      atsInjScan: () => ({
        ats: "greenhouse", url: "https://job-boards.greenhouse.io/gitlab/jobs/1", title: "t",
        fields: [{ fieldName: "gender", inputSel: "#gender", widgetType: "select", label: "Gender", isRequired: false, value: null, domIndex: 0 }],
      }),
      atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
      atsInjReadOptions: () => (Date.now() < MOUNT_AT
        ? { ok: true, open: false, options: [] }
        : { ok: true, open: true, options: [{ text: "Male" }, { text: "Female" }] }),
      atsInjTypeInCombo: () => ({ ok: true }),
      atsInjReadComboInput: () => ({ ok: true, value: "" }),
      atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
      atsInjReadValue: () => ({ ok: true, value: committed }),
      atsInjCloseCombo: () => ({ ok: true }),
    });
    act.quietInstall = async () => ({ ok: true });
    act.quietRead = async () => { quietCalls++; return { ok: true, idleMs: 40 }; };   // still mutating
    const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
    assert.ok(quietCalls > 0, "the poll must consult the quiet watch before believing an empty menu");
    assert.strictEqual(out.results[0].status, "filled", "a busy page is waited out: " + out.results[0].detail);
    assert.strictEqual(committed, "Male");
  } finally { Object.assign(ats.ATS_POLL, saved); }
});

test("replay: an approved value that carries the form's own numbering still matches", async () => {
  // A commit stores the option's REAL text, so the bundle holds "1. United States of America".
  // Stripping the numbering from the live options but not from the approved value made the replay
  // of a field the fill had just filled report "isn't one of this form's options" (live 2026-08-05).
  let committed = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/gitlab/jobs/1", title: "t",
      fields: [{ fieldName: "q_based", inputSel: "#q_based", widgetType: "select", label: "Where are you currently based?", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: ["1. United States of America", "2. Canada"].map((t) => ({ text: t })) }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, { valueFor: () => "1. United States of America" });
  assert.strictEqual(out.results[0].status, "filled", "the approved value must match the option it came from: " + out.results[0].detail);
  assert.strictEqual(committed, "1. United States of America");
});

test("router: a signature/completion date is TODAY, and only for that question", async () => {
  // Live 2026-08-05, Lever: eeo[disabilitySignatureDate] reached the AI free-text path and came back
  // "As soon as possible" — an availability answer on a date field, after a 19.2s LLM call.
  const mmddyyyy = /^\d{2}\/\d{2}\/\d{4}$/;
  for (const label of ["Date", "Today's Date", "Signature Date", "Date Signed"]) {
    const r = ats.atsRouteLabel(label, {}, PROFILE, {});
    assert.ok(r && mmddyyyy.test(String(r.value)), label + " should route to today's date, got " + JSON.stringify(r && r.value));
    assert.strictEqual(r.source, "signature-date");
  }
  // …and NEVER a date that names a different event — stamping today on one of these is a wrong answer
  for (const label of ["Start Date", "Earliest start date", "Date of Birth", "Graduation Date", "Expiration Date"]) {
    const r = ats.atsRouteLabel(label, {}, PROFILE, {});
    assert.notStrictEqual(r && r.source, "signature-date", label + " must not be answered with today");
  }
  // it fills deterministically, unflagged, through the ordinary text path
  const values = {};
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "lever", url: "https://jobs.lever.co/shieldai/uuid/apply", title: "t",
      fields: [{ fieldName: "eeo[disabilitySignatureDate]", inputSel: "#sig", widgetType: "text", label: "Date", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
  });
  const out = await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});
  assert.strictEqual(out.results[0].status, "filled", "deterministic, so no review flag: " + out.results[0].detail);
  assert.ok(mmddyyyy.test(String(values["#sig"])), "wrote today's date, got " + JSON.stringify(values["#sig"]));
});

test("radio: the bundle stores the option we chose, not a label that carries its description", async () => {
  // Lever's EEO options render the whole description inside the label, so the read-back is a
  // paragraph while the option vocabulary is the answer alone. Persisting the paragraph made the
  // REPLAY of a verified fill come back stated-value-unmatched (live 2026-08-05, Shield AI).
  const OPTION = "Asian (Not Hispanic or Latino)";
  const DISPLAY = OPTION + "A person having origins in any of the original peoples of the Far East, Southeast Asia, or the Indian Subcontinent.";
  const scan = {
    ats: "lever", url: "https://jobs.lever.co/shieldai/uuid/apply", title: "t",
    fields: [{ fieldName: "eeo[race]", inputSel: 'input[name="eeo[race]"]', widgetType: "radio",
      label: "Race", isRequired: false, value: null, domIndex: 0,
      options: [OPTION, "White (Not Hispanic or Latino)", "Decline to self identify"] }],
  };
  const act = fakeAct({
    atsInjScan: () => scan,
    atsInjCheckOption: () => ({ ok: true }),
    atsInjReadValue: () => ({ ok: true, value: DISPLAY }),   // the label, description and all
  });
  const profile = { ...PROFILE, self_identification: { ...PROFILE.self_identification, race_ethnicity: OPTION } };
  const out = await ats.driveAtsPageFill(act, "lever", profile, {}, {}, {});
  const r = out.results[0];
  assert.ok(r.status === "filled" || r.status === "filled_review", "the click verified: " + r.detail);
  assert.strictEqual(r.after, OPTION, "the persisted value must be in the form's own option vocabulary");

  // and that value replays: it now matches the live option list
  let checked = null;
  const act2 = fakeAct({
    atsInjScan: () => scan,
    atsInjCheckOption: (sel, t) => { checked = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: checked ? checked + "some description" : null }),
  });
  const out2 = await ats.driveAtsPageFill(act2, "lever", profile, {}, {}, { valueFor: () => OPTION });
  assert.strictEqual(checked, OPTION);
  assert.notStrictEqual(out2.results[0].status, "needs_review", "the approved value must replay: " + out2.results[0].detail);
});

// ── DEFERRED AI: one batched call per page ──────────────────────────────────────────────
// The old shape fired one call per unanswered field, 4 at a time. Concurrency hid latency but
// still spent N REQUESTS against a key metered at 15/minute, and it had to PREDICT which fields
// the deterministic pass would fail before that pass had run. These pin the replacement: the
// deterministic pass finishes, what it could not answer is deferred, ONE call asks about exactly
// those, and a second actuation pass fills them through the unchanged safety path.

test("AI free-text: a page makes ONE call for every question it could not answer", async () => {
  // Live 2026-08-05, Shield AI (Lever): 7 per-field calls of 1.6-5.2s were 26.2s of a 32.6s fill.
  let calls = 0;
  const values = {};
  const fields = Array.from({ length: 6 }, (_, i) => ({
    fieldName: "cards[u" + i + "][field0]", inputSel: "#c" + i, widgetType: "textarea",
    label: "Why do you want to work here? (" + i + ")", isRequired: true, value: null, domIndex: i,
  }));
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user }) => {
      calls++;
      const ids = [...String(user).matchAll(/"id":"(q\d+)"/g)].map((m) => m[1]);
      return { ok: true, text: JSON.stringify({ answers: ids.map((id) => ({ id, answer: "ANSWER-" + id, justification: "j", confidence: "High" })) }) };
    },
    atsInjScan: () => ({ ats: "lever", url: "https://jobs.lever.co/x/uuid/apply", title: "t", fields }),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});

  assert.strictEqual(calls, 1, `6 unanswered questions must cost exactly ONE call — made ${calls}`);
  // …and every field still got ITS OWN answer, flagged, through the normal commit path
  assert.strictEqual(out.results.length, 6);
  const seen = new Set();
  for (const r of out.results) {
    assert.strictEqual(r.status, "filled_review", r.fieldName + ": " + r.detail);
    assert.strictEqual(r.flag, "ai-text", "an AI answer is ALWAYS flagged");
    assert.ok(String(r.after || "").startsWith("ANSWER-"), r.fieldName + " got " + JSON.stringify(r.after));
    seen.add(r.after);
  }
  assert.strictEqual(seen.size, 6, "each field got its OWN answer, not one answer smeared across six");
  assert.strictEqual(new Set(Object.keys(values)).size, 6, "each field written once, to its own selector");
});

test("AI choice: choice questions ride the SAME one call, each pick still cleared vs live options", async () => {
  // The Lever measurement's 7 slow calls were all `cards[…]` RADIOS, whose options come from the
  // scan. They now share the page's single call with everything else.
  let calls = 0; const checked = {};
  const fields = Array.from({ length: 6 }, (_, i) => ({
    fieldName: "cards[u" + i + "][field0]", inputSel: 'input[name="cards[u' + i + '][field0]"]',
    widgetType: "radio", label: "Custom screening question " + i, isRequired: true, value: null, domIndex: i,
    options: ["A United States Citizen", "A Permanent Resident", "Neither"],
  }));
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user }) => {
      calls++;
      const ids = [...String(user).matchAll(/"id":"(q\d+)"/g)].map((m) => m[1]);
      return { ok: true, text: JSON.stringify({ answers: ids.map((id) => ({ id, choice: "A United States Citizen", justification: "profile", confidence: "High" })) }) };
    },
    atsInjScan: () => ({ ats: "lever", url: "https://jobs.lever.co/x/uuid/apply", title: "t", fields }),
    atsInjCheckOption: (sel, t) => { checked[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: checked[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});

  assert.strictEqual(calls, 1, `6 radios must cost exactly ONE call — made ${calls}`);
  for (const r of out.results) {
    assert.strictEqual(r.status, "filled_review", r.fieldName + ": " + r.detail);
    assert.strictEqual(r.after, "A United States Citizen");
    assert.ok(/ai-/.test(String(r.flag)), "an AI answer is ALWAYS flagged, got " + r.flag);
  }
  assert.strictEqual(Object.keys(checked).length, 6, "each field committed to its own group");
});

test("AI batch: the call asks ONLY about what the deterministic pass could not answer", async () => {
  // This is the whole reason the batch runs AFTER the deterministic pass rather than before it
  // (Workday's aiBatch fires first and must PREDICT, paying tokens for every misprediction).
  let asked = null, calls = 0;
  const byAction = {};
  const values = {};
  const fields = [
    // answered from the profile — must never reach the prompt
    { fieldName: "first_name", inputSel: "#first_name", widgetType: "text", label: "First Name", isRequired: true, value: null, domIndex: 0 },
    { fieldName: "q_auth", inputSel: "#q_auth", widgetType: "radio", label: "Are you authorized to work in the country for which you applied?", isRequired: true, value: null, domIndex: 1, options: ["Yes", "No"] },
    // nothing in the profile answers these — TWO of each kind, because the "one question is not a
    // batch" rule applies PER KIND now that each kind rides its own route
    { fieldName: "q_why", inputSel: "#q_why", widgetType: "textarea", label: "Why do you want to work here?", isRequired: true, value: null, domIndex: 2 },
    { fieldName: "q_why2", inputSel: "#q_why2", widgetType: "textarea", label: "Describe a hard problem you solved.", isRequired: true, value: null, domIndex: 3 },
    { fieldName: "q_shift", inputSel: "#q_shift", widgetType: "radio", label: "Are you willing to work night shifts?", isRequired: true, value: null, domIndex: 4, options: ["Yes", "No"] },
    { fieldName: "q_wknd", inputSel: "#q_wknd", widgetType: "radio", label: "Are you willing to work weekends?", isRequired: true, value: null, domIndex: 5, options: ["Yes", "No"] },
  ];
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user, action }) => {
      calls++; asked = (asked || "") + "\n" + String(user); byAction[action || "(none)"] = String(user);
      const ids = [...String(user).matchAll(/"id":"(q\d+)"/g)].map((m) => m[1]);
      return { ok: true, text: JSON.stringify({ answers: ids.map((id) => ({ id, choice: "Yes", answer: "Because I like it.", justification: "j", confidence: "Medium" })) }) };
    },
    atsInjScan: () => ({ ats: "greenhouse", url: "https://job-boards.greenhouse.io/x/jobs/1", title: "t", fields }),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjCheckOption: (sel, t) => { values[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));

  // ONE CALL PER KIND — 6 questions, 4 of them unanswered, and still only two requests.
  assert.strictEqual(calls, 2, "one batched call per kind, not per question");
  // …and each kind went to ITS OWN configured route (see ATS_BATCH_ACTION)
  assert.deepStrictEqual(Object.keys(byAction).sort(), ["essay", "fill"]);
  assert.ok(/Why do you want to work here/.test(byAction.essay), "prose questions ride the ESSAY route");
  assert.ok(/hard problem/.test(byAction.essay));
  assert.ok(/night shifts/.test(byAction.fill), "picks ride the FILL route");
  assert.ok(!/night shifts/.test(byAction.essay), "a pick must never be sent to the essay model");
  assert.ok(!/Why do you want to work here/.test(byAction.fill), "an essay must never be sent to the fill model");
  assert.ok(!/First Name/.test(asked), "a field the profile answered must NEVER be asked about");
  assert.ok(!/authorized to work/.test(asked), "a field the deterministic ladder answered must NEVER be asked about");
  // and the deterministic answers are untouched, unflagged
  assert.strictEqual(by.first_name.status, "filled");
  assert.strictEqual(by.first_name.after, "Kevin");
  assert.strictEqual(by.q_auth.status, "filled");
  assert.strictEqual(by.q_auth.after, "Yes");
  assert.strictEqual(by.q_auth.flag, null, "a deterministic answer carries no AI flag");
});

test("AI batch: a decision is DISCARDED when the live options differ from the list it was asked with", async () => {
  // The pick must always reflect what the form is showing. If the live list has changed since the
  // list the question was ASKED with (a cascade, a re-render), the batched pick is thrown away and
  // that question is re-asked on its own — never committed against a list it never saw.
  let calls = 0; const askedWith = [];
  const fields = [
    // scan options are STALE — the live read below disagrees
    { fieldName: "q1", inputSel: "#q1", widgetType: "select", label: "Pick one", isRequired: true, value: null, domIndex: 0, options: ["Stale A", "Stale B"] },
    // a second question so the batch actually fires (one question is not a batch)
    { fieldName: "q2", inputSel: "#q2", widgetType: "radio", label: "Second question", isRequired: true, value: null, domIndex: 1, options: ["Yes", "No"] },
  ];
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user }) => {
      calls++; askedWith.push(String(user));
      const ids = [...String(user).matchAll(/"id":"(q\d+)"/g)].map((m) => m[1]);
      if (ids.length) return { ok: true, text: JSON.stringify({ answers: ids.map((id) => ({ id, choice: id === "q1" ? "Stale A" : "Yes", justification: "j", confidence: "High" })) }) };
      return { ok: true, text: JSON.stringify({ choice: "Live One", justification: "re-asked", confidence: "High" }) };
    },
    atsInjScan: () => ({ ats: "greenhouse", url: "https://job-boards.greenhouse.io/x/jobs/1", title: "t", fields }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [{ text: "Live One" }, { text: "Live Two" }, { text: "Live Three" }] }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: () => ({ ok: true }),
    atsInjCheckOption: () => ({ ok: true }),
    atsInjReadValue: (a, sel) => ({ ok: true, value: sel === "#q1" ? "Live One" : "Yes" }),
    atsInjCloseCombo: () => ({ ok: true }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));

  assert.strictEqual(calls, 2, "the stale pick must be re-asked against the LIVE list");
  assert.ok(/Pick one/.test(askedWith[1]), "the RE-ASK is the one whose list changed");
  assert.strictEqual(by.q1.after, "Live One", "the committed value is a LIVE option, never the stale pick");
  // …and the question whose list did NOT change was served by the batch, costing nothing extra
  assert.strictEqual(by.q2.after, "Yes");
});

test("AI batch: a question the batch omits falls back to its own call, and the page still fills", async () => {
  let calls = 0; const checked = {};
  const fields = [
    { fieldName: "a", inputSel: "#a", widgetType: "radio", label: "Question A", isRequired: true, value: null, domIndex: 0, options: ["Yes", "No"] },
    { fieldName: "b", inputSel: "#b", widgetType: "radio", label: "Question B", isRequired: true, value: null, domIndex: 1, options: ["Yes", "No"] },
  ];
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user }) => {
      calls++;
      // the batch answers only the FIRST id it was given; the per-field re-ask is the single shape
      if (/QUESTIONS:/.test(String(user))) {
        return { ok: true, text: JSON.stringify({ answers: [{ id: "q1", choice: "Yes", justification: "j", confidence: "High" }] }) };
      }
      return { ok: true, text: JSON.stringify({ choice: "No", justification: "own call", confidence: "Low" }) };
    },
    atsInjScan: () => ({ ats: "lever", url: "https://jobs.lever.co/x/uuid/apply", title: "t", fields }),
    atsInjCheckOption: (sel, t) => { checked[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: checked[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));

  assert.strictEqual(calls, 2, "1 batch + 1 fallback for the omitted question");
  assert.strictEqual(by.a.after, "Yes", "the batched answer landed");
  assert.strictEqual(by.b.after, "No", "the omitted question made its own call");
  for (const r of out.results) assert.strictEqual(r.status, "filled_review", r.fieldName + ": " + r.detail);
});

test("AI batch: a FAILED batch costs nothing but a per-field call each — the pre-batch behaviour", async () => {
  let calls = 0; const checked = {};
  const fields = Array.from({ length: 3 }, (_, i) => ({
    fieldName: "f" + i, inputSel: "#f" + i, widgetType: "radio", label: "Question " + i,
    isRequired: true, value: null, domIndex: i, options: ["Yes", "No"],
  }));
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user }) => {
      calls++;
      if (/QUESTIONS:/.test(String(user))) return { ok: false, error: "overloaded" };   // the batch fails
      return { ok: true, text: JSON.stringify({ choice: "Yes", justification: "own call", confidence: "High" }) };
    },
    atsInjScan: () => ({ ats: "lever", url: "https://jobs.lever.co/x/uuid/apply", title: "t", fields }),
    atsInjCheckOption: (sel, t) => { checked[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: checked[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});

  assert.strictEqual(calls, 4, "1 failed batch + one call per field — a batch failure never costs COVERAGE");
  for (const r of out.results) {
    assert.strictEqual(r.status, "filled_review", r.fieldName + ": " + r.detail);
    assert.strictEqual(r.after, "Yes");
  }
});

test("AI batch: answers are cached BY QUESTION — a cascade re-mount costs no further call", async () => {
  // A cascade round re-enters the fill loop with late-mounted fields. The same QUESTION under a new
  // automation-id must reuse the answer already paid for — and so cannot be given a contradicting one.
  let calls = 0, scans = 0; const checked = {};
  const round1 = [
    { fieldName: "a", inputSel: "#a", widgetType: "radio", label: "Shared question", isRequired: true, value: null, domIndex: 0, options: ["Yes", "No"] },
    { fieldName: "b", inputSel: "#b", widgetType: "radio", label: "Other question", isRequired: true, value: null, domIndex: 1, options: ["Yes", "No"] },
  ];
  // same wording, different id — exactly what a re-mount looks like
  const late = { fieldName: "a_v2", inputSel: "#a_v2", widgetType: "radio", label: "Shared question", isRequired: true, value: null, domIndex: 2, options: ["Yes", "No"] };
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user }) => {
      calls++;
      const ids = [...String(user).matchAll(/"id":"(q\d+)"/g)].map((m) => m[1]);
      return { ok: true, text: JSON.stringify({ answers: ids.map((id) => ({ id, choice: "Yes", justification: "j", confidence: "High" })) }) };
    },
    atsInjScan: () => { scans++; return { ats: "lever", url: "https://jobs.lever.co/x/uuid/apply", title: "t", fields: scans === 1 ? round1 : round1.concat([late]) }; },
    atsInjCheckOption: (sel, t) => { checked[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: checked[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));

  assert.ok(by.a_v2, "the cascade round must still fill the late-mounted field");
  assert.strictEqual(calls, 1, `the re-mounted question must reuse the cached answer — made ${calls} call(s)`);
  assert.strictEqual(by.a_v2.after, by.a.after, "the same question cannot get two different answers on one page");
  assert.strictEqual(by.a_v2.status, "filled_review", "a cached AI answer is still ALWAYS flagged");
});

test("AI batch: ONE deferred question is not a batch — it takes its own path, unchanged", async () => {
  let asked = null, calls = 0; const checked = {};
  const fields = [{ fieldName: "only", inputSel: "#only", widgetType: "radio", label: "The one question", isRequired: true, value: null, domIndex: 0, options: ["Yes", "No"] }];
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user }) => { calls++; asked = String(user); return { ok: true, text: JSON.stringify({ choice: "Yes", justification: "j", confidence: "High" }) }; },
    atsInjScan: () => ({ ats: "lever", url: "https://jobs.lever.co/x/uuid/apply", title: "t", fields }),
    atsInjCheckOption: (sel, t) => { checked[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: checked[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});
  assert.strictEqual(calls, 1, "still exactly one call — wrapping it in a batch prompt only adds a parse that can fail");
  assert.ok(!/QUESTIONS:/.test(asked), "a single question uses the single-question prompt");
  assert.strictEqual(out.results[0].after, "Yes");
});

test("AI batch: a deferred combobox is READ then CLOSED, and re-opened only to commit", async () => {
  // Nothing is committed while the batch is in flight, so the menu the defer pass opened has to be
  // closed — a react-select menu left mounted swallows the next widget's open-click.
  const events = [];
  const fields = [
    { fieldName: "s1", inputSel: "#s1", widgetType: "select", label: "First dropdown", isRequired: true, value: null, domIndex: 0 },
    { fieldName: "s2", inputSel: "#s2", widgetType: "select", label: "Second dropdown", isRequired: true, value: null, domIndex: 1 },
  ];
  let open = {};
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ user }) => {
      events.push("llm");
      const ids = [...String(user).matchAll(/"id":"(q\d+)"/g)].map((m) => m[1]);
      return { ok: true, text: JSON.stringify({ answers: ids.map((id) => ({ id, choice: "Alpha", justification: "j", confidence: "High" })) }) };
    },
    atsInjScan: () => ({ ats: "greenhouse", url: "https://job-boards.greenhouse.io/x/jobs/1", title: "t", fields }),
    atsInjOpenAndReadOptions: (sel) => { open[sel] = true; events.push("open:" + sel); return { ok: true, opened: true }; },
    atsInjReadOptions: (sel) => (open[sel] ? { ok: true, open: true, options: [{ text: "Alpha" }, { text: "Beta" }] } : { ok: true, open: false, options: [] }),
    atsInjCloseCombo: (sel) => { open[sel] = false; events.push("close:" + sel); return { ok: true }; },
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: (sel, t) => { events.push("commit:" + sel + "=" + t); return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: "Alpha" }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});

  assert.strictEqual(events.filter((e) => e === "llm").length, 1, "both dropdowns share ONE call");
  // both menus are closed BEFORE the call goes out — no menu is left open across it
  const llmAt = events.indexOf("llm");
  assert.ok(events.indexOf("close:#s1") >= 0 && events.indexOf("close:#s1") < llmAt, "s1's menu must close before the call: " + events.join(" | "));
  assert.ok(events.indexOf("close:#s2") >= 0 && events.indexOf("close:#s2") < llmAt, "s2's menu must close before the call: " + events.join(" | "));
  assert.ok(events.lastIndexOf("open:#s1") > llmAt, "the commit pass re-opens the widget: " + events.join(" | "));
  for (const r of out.results) {
    assert.strictEqual(r.status, "filled_review", r.fieldName + ": " + r.detail);
    assert.strictEqual(r.after, "Alpha");
  }
});

test("atsParseBatchReply: both kinds, fenced JSON, and anything of the wrong shape yields no entry", () => {
  const items = [
    { id: "q1", kind: "choice", question: "Pick", options: ["Yes", "No"] },
    { id: "q2", kind: "text", question: "Write" },
    { id: "q3", kind: "choice", question: "Other", options: ["A"] },
    { id: "q4", kind: "text", question: "Empty" },
  ];
  const m = ats.atsParseBatchReply("```json\n" + JSON.stringify({
    answers: [
      { id: "q1", choice: "Yes", justification: "profile says so", confidence: "High", maps_to: "a.b", suggested_category: "Screening" },
      { id: "q2", answer: "  I want this job.  ", justification: "from profile" },
      { id: "q3", answer: "A" },                                   // choice answered under the TEXT key
      { id: "q4", answer: "   " },                                 // the AI declining
      { id: "q9", choice: "Yes" },                                 // never asked about
    ],
  }) + "\n```", items);

  assert.deepStrictEqual([...m.keys()], ["q1", "q2", "q3"]);
  assert.deepStrictEqual(m.get("q1"), { ok: true, choice: "Yes", justification: "profile says so", confidence: "High", maps_to: "a.b", suggested_category: "Screening", promptOptions: ["Yes", "No"] });
  // a free-text answer keeps atsAiWriteText's FIXED "Low" confidence and is trimmed
  assert.deepStrictEqual(m.get("q2"), { ok: true, answer: "I want this job.", confidence: "Low", justification: "from profile" });
  // CROSS-KEY: a choice answered under "answer" (or text under "choice") is still an answer. Dropping
  // it silently sent that question off to buy its own call — both live misses were on MIXED batches.
  // Safe because a choice is still only a CANDIDATE that must clear the match ladder vs live options.
  assert.strictEqual(m.get("q3").choice, "A", "a choice arriving under the TEXT key must not be discarded");
  assert.deepStrictEqual(m.get("q3").promptOptions, ["A"]);
  const swapped = ats.atsParseBatchReply(JSON.stringify({ answers: [{ id: "q2", choice: "text under the choice key" }] }), items);
  assert.strictEqual(swapped.get("q2").answer, "text under the choice key", "and the same the other way round");
  // …but a genuinely EMPTY answer is still the AI declining, under either key
  assert.strictEqual(ats.atsParseBatchReply(JSON.stringify({ answers: [{ id: "q1", choice: "", answer: "" }] }), items).size, 0);
  // …and the tolerant shapes the single-answer parser also accepts
  assert.strictEqual(ats.atsParseBatchReply(JSON.stringify([{ id: "q1", choice: "No" }]), items).get("q1").choice, "No");
  assert.strictEqual(ats.atsParseBatchReply(JSON.stringify({ q1: { choice: "No" } }), items).get("q1").choice, "No");
  assert.strictEqual(ats.atsParseBatchReply("not json at all", items).size, 0);
  assert.strictEqual(ats.atsParseBatchReply("", items).size, 0);
});

test("atsSameOptionSet: order-insensitive, and any real difference re-asks", () => {
  assert.ok(ats.atsSameOptionSet(["A", "B"], ["B", "A"]), "react-select may reorder a list it did not change");
  assert.ok(ats.atsSameOptionSet(["United States"], ["  united   states "]), "normalized comparison");
  assert.ok(!ats.atsSameOptionSet(["A", "B"], ["A", "B", "C"]), "a grown list is a different list");
  assert.ok(!ats.atsSameOptionSet(["A", "B"], ["A", "C"]), "a changed member is a different list");
  assert.ok(!ats.atsSameOptionSet(undefined, ["A"]), "no recorded list ⇒ never reusable");
  assert.ok(!ats.atsSameOptionSet(["A"], undefined));
});

test("AI routing: a long answer goes to the ESSAY model, a pick to the FILL model", async () => {
  // `act.llm` resolves `action || "fill"`, so omitting it silently sent every long answer to the
  // model configured for yes/no picks — the AI page's "Fill — essays and long answers" slot went
  // unused on GH/Lever/Ashby while the Workday twin had always used it (2026-08-12).
  // Pinned on the SINGLE-question path too, because that path bypasses the batch entirely.
  const seen = [];
  const values = {};
  const fields = [
    { fieldName: "essay1", inputSel: "#essay1", widgetType: "textarea", label: "Tell us why you want this role.", isRequired: true, value: null, domIndex: 0 },
    { fieldName: "pick1", inputSel: "#pick1", widgetType: "radio", label: "Can you work weekends?", isRequired: true, value: null, domIndex: 1, options: ["Yes", "No"] },
  ];
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ action, user }) => {
      seen.push({ action: action || "(none)", isEssay: /Tell us why/.test(String(user)) });
      return { ok: true, text: JSON.stringify({ answer: "Because it fits my background.", choice: "Yes", justification: "j", confidence: "High" }) };
    },
    atsInjScan: () => ({ ats: "lever", url: "https://jobs.lever.co/x/uuid/apply", title: "t", fields }),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjCheckOption: (sel, t) => { values[sel] = t; return { ok: true }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});

  // one of each kind ⇒ neither batches ⇒ each takes its own per-field call, and the ROUTE still has
  // to be right — which is the whole point.
  const essayCall = seen.find((c) => c.isEssay);
  const pickCall = seen.find((c) => !c.isEssay);
  assert.ok(essayCall, "the long answer must have been asked about");
  assert.strictEqual(essayCall.action, "essay", "a long answer must resolve the ESSAY route, never the default fill route");
  assert.ok(pickCall, "the pick must have been asked about");
  assert.notStrictEqual(pickCall.action, "essay", "a yes/no pick must NOT be billed to the essay model");
});

test("AI routing: a DATE is a short factual answer, so it goes to FILL, never the essay model", async () => {
  // A date reaches atsAiWriteText for its prompt SHAPE, but it is not prose. Workday's aiFillDate
  // routes a date to "fill"; the two paths must agree, and a date must never join the essay batch.
  assert.strictEqual(ats.atsAiBatchKind({ widgetType: "date" }), "date", "its own kind — never batched");
  assert.strictEqual(ats.atsAiBatchKind({ widgetType: "textarea" }), "text");
  assert.strictEqual(ats.atsAiBatchKind({ widgetType: "radio" }), "choice");

  const seen = [];
  const values = {};
  const act = fakeAct({
    aiEnabled: true,
    llm: async ({ action }) => { seen.push(action || "(none)"); return { ok: true, text: JSON.stringify({ answer: "2026-09-01", confidence: "Low" }) }; },
    atsInjScan: () => ({ ats: "greenhouse", url: "https://job-boards.greenhouse.io/x/jobs/1", title: "t",
      fields: [{ fieldName: "start", inputSel: "#start", widgetType: "date", label: "When could you start?", isRequired: true, value: null, domIndex: 0 }] }),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  assert.deepStrictEqual(seen, ["fill"], "a date must resolve the FILL route");
  assert.ok(String(out.results[0].after || "").length, "and it still fills: " + out.results[0].detail);
});

test("cascade: a late field that filled DETERMINISTICALLY is not made to demand approval", async () => {
  // `requiresApproval` (web/lib/review-approval.ts) is `needs_review || cascade_revealed`, so tagging
  // every late-discovered row demanded a HUMAN SIGN-OFF for it. Live on Shield AI: the self-ID
  // signature `Name` ("Kevin Wang", composed from the profile) and `Date` ("08/12/2026", the
  // signature-date rule) both came back filled / needs_review:false / confidence:high and still sat
  // in the review pile. The ATS re-scan mostly catches fields that were still MOUNTING during the
  // first scan — a scan-timing artifact — so a clean verified fill clears the same bar every other
  // auto-approved field clears. Anything NOT cleanly filled keeps the flag.
  let scans = 0;
  const first = [{ fieldName: "last_name", inputSel: "#last_name", widgetType: "text", label: "Last Name", isRequired: true, value: null, domIndex: 0 }];
  const late = [
    // fills deterministically from the profile → must NOT be flagged
    { fieldName: "first_name", inputSel: "#first_name", widgetType: "text", label: "First Name", isRequired: true, value: null, domIndex: 1 },
    // nothing answers this and the form offers no options → ends needs_review → KEEPS the flag
    { fieldName: "sig_unknown", inputSel: "#sig_unknown", widgetType: "select", label: "Some late question", isRequired: false, value: null, domIndex: 2, options: [] },
  ];
  const values = {};
  const act = fakeAct({
    atsInjScan: () => { scans++; return { ats: "greenhouse", url: "https://job-boards.greenhouse.io/x/jobs/1", title: "t", fields: scans === 1 ? first : first.concat(late) }; },
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] || null }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [] }),
    atsInjCloseCombo: () => ({ ok: true }),
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));

  assert.strictEqual(by.first_name.status, "filled", "precondition: it filled deterministically");
  assert.ok(!by.first_name.cascadeRevealed,
    "a late field that filled AND verified must not be made to demand approval just for being late");
  assert.notStrictEqual(by.sig_unknown.status, "filled");
  assert.strictEqual(by.sig_unknown.cascadeRevealed, true,
    "a late field that did NOT cleanly fill still carries the flag and still faces the gate");
});

test("atsBatchMaxTokens: a free-text answer is budgeted as a paragraph, a pick as a line", () => {
  const choice = { id: "q1", kind: "choice" }, text = { id: "q2", kind: "text" };
  assert.strictEqual(ats.atsBatchMaxTokens([choice, choice]), 512 + 800);
  assert.strictEqual(ats.atsBatchMaxTokens([text, text]), 512 + 1400);
  assert.strictEqual(ats.atsBatchMaxTokens([choice, text]), 512 + 400 + 700);
});

test("location: a Greenhouse suggestion list is waited for, whatever google.maps says", async () => {
  // Traced live 2026-08-06 on Reddit: `google.maps` is absent and no maps script is ever requested,
  // yet typing "Tallahassee" returns "Tallahassee, Florida, United States" from GREENHOUSE'S OWN
  // service. A probe I added the day before skipped the wait whenever google.maps was missing, which
  // was every Greenhouse form — manufacturing "suggestions never loaded" on a widget that works.
  let typed = null, committed = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/reddit/jobs/1", title: "t",
      fields: [{ fieldName: "candidate-location", inputSel: "#candidate-location", widgetType: "location", label: "Location (City)", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjPlacesReady: () => ({ ok: true, places: false }),   // no google.maps — must NOT matter
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, loading: false,
      options: (typed ? ["Tallahassee, Florida, United States", "Tallahassee, Georgia, United States"] : []).map((t) => ({ text: t })) }),
    atsInjTypeInCombo: (sel, t) => { if (t) typed = t; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: typed || "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, {});
  assert.strictEqual(typed, "Tallahassee", "asked by city");
  assert.strictEqual(committed, "Tallahassee, Florida, United States", "the city+state suggestion is picked");
  assert.notStrictEqual(out.results[0].status, "needs_review", "a working widget must not be reported broken: " + out.results[0].detail);
});

test("location: a bucket-supplied city still matches the widget's own suggestion, and nothing is discarded", async () => {
  // Live 2026-08-06, Ashby/Cohere: the box offered "Pittsburgh, Pennsylvania, United States", the
  // bucket value was "Pittsburgh, PA", and because a bucket routes BEFORE the label ladder the field
  // was matched as a strict dropdown → no hit, 17.5s spent, and the record then claimed the widget
  // "listed no options" while handing review nothing to pick.
  const SUGGESTIONS = ["Pittsburgh, Pennsylvania, United States", "Pittsburgh, Kansas, United States"];
  let typed = null, committed = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "ashby", url: "https://jobs.ashbyhq.com/cohere/uuid/application", title: "t",
      fields: [{ fieldName: "ap-ats-combobox-3", inputSel: "#ap-ats-combobox-3", widgetType: "select", label: "Location", isRequired: false, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    // suggestions appear only once the city has been typed — a places-style widget
    atsInjReadOptions: () => ({ ok: true, open: true, options: (typed ? SUGGESTIONS : []).map((t) => ({ text: t })), loading: false }),
    atsInjTypeInCombo: (sel, t) => { if (t) typed = t; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: typed || "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const buckets = [{ questions: ["Location"], value: ["Pittsburgh, PA"] }];
  const out = await ats.driveAtsPageFill(act, "ashby", PROFILE, {}, {}, { buckets });
  const r = out.results[0];
  assert.strictEqual(typed, "Pittsburgh", "a location box is asked by CITY, not by the whole string");
  assert.notStrictEqual(r.status, "skipped", "the widget offered a real match: " + r.detail);
  assert.strictEqual(committed, "Pittsburgh, Pennsylvania, United States");
});

test("a search that saw options never reports 'listed no options'", async () => {
  // The same run's second defect: the suggestions vanish when the query is cleared, and the record
  // then described a widget that had just offered five as having offered none — with nothing attached
  // for review to pick from.
  let typed = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/x/jobs/1", title: "t",
      fields: [{ fieldName: "q1", inputSel: "#q1", widgetType: "select", label: "Pick one", isRequired: true, value: null, domIndex: 0, options: [] }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    // options exist ONLY while the query is present; clearing loses them (the live shape)
    atsInjReadOptions: () => ({ ok: true, open: true, options: (typed ? [{ text: "Something Else" }, { text: "Another Thing" }] : []), loading: false }),
    atsInjTypeInCombo: (sel, t) => { typed = t || null; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: typed || "" }),
    atsInjCommitOption: () => ({ ok: false, error: "option-not-found" }),
    atsInjReadValue: () => ({ ok: true, value: null }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const buckets = [{ questions: ["Pick one"], value: ["Not On The List"] }];
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, { buckets });
  const r = out.results[0];
  assert.doesNotMatch(String(r.detail), /listed no options/, "it saw options — say so: " + r.detail);
  const shown = r.options || r.captured_options || [];
  assert.ok(shown.includes("Something Else"), "review must get the options the search surfaced");
});

test("assertion-lead: the same self-ID answer in different words, and it refuses when unsure", () => {
  // Live 2026-08-06, Lever/gopuff diversity survey: the profile holds "I am not a protected veteran"
  // (the Workday/Greenhouse wording), the form offers "I am not a U.S. veteran". Neither contains the
  // other and fuzzy scores ~63%, so a STATED answer reached review.
  const VET = ["I identify as a U.S. veteran", "I am not a U.S. veteran", "Prefer not to answer"];
  assert.strictEqual(ats.atsAssertionLead("I am not a protected veteran", VET), "I am not a U.S. veteran");
  assert.strictEqual(ats.atsAssertionLead("I identify as a veteran", VET), "I identify as a U.S. veteran");
  // a POSITIVE assertion must never answer a NEGATIVE option — that would invert a legal self-ID
  assert.strictEqual(ats.atsAssertionLead("I identify as a veteran", ["I am not a U.S. veteran", "Prefer not to answer"]), null);
  // 2+ candidates of the same polarity ⇒ refuse rather than guess a demographic
  assert.strictEqual(ats.atsAssertionLead("I am not a veteran", ["I am not a veteran A", "I am not a veteran B"]), null);
  // a value that is not a first-person assertion is none of this bridge's business
  assert.strictEqual(ats.atsAssertionLead("Asian", VET), null);
  assert.strictEqual(ats.atsAssertionLead("", VET), null);
  assert.strictEqual(ats.atsAssertionLead("I am not a veteran", []), null);
});

test("driver: a stated veteran status fills through the assertion bridge, flagged not silent", async () => {
  let checked = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "lever", url: "https://jobs.lever.co/gopuff/uuid/apply", title: "t",
      fields: [{ fieldName: "surveysResponses[u][responses][field5]", inputSel: 'input[name="vet"]', widgetType: "radio",
        label: "Are you a veteran?", isRequired: false, value: null, domIndex: 0,
        options: ["I identify as a U.S. veteran", "I am not a U.S. veteran", "Prefer not to answer"] }],
    }),
    atsInjCheckOption: (sel, t) => { checked = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: checked }),
  });
  const out = await ats.driveAtsPageFill(act, "lever", PROFILE, {}, {}, {});
  const r = out.results[0];
  assert.strictEqual(checked, "I am not a U.S. veteran");
  assert.strictEqual(r.matchTier, "assertion-lead");
  assert.strictEqual(r.status, "filled_review", "a non-exact tier is always flagged, never silent");
});

test("an AI-GUESSED demographic wears the loud badge, and ordinary questions do not", async () => {
  // Live 2026-08-06, Reddit: a veteran question ("No military service") and a transgender question
  // answered from the profile's GENDER both wore an ordinary `ai-choice` badge. The Workday path has
  // used `ai-eeo-guess` — the review editor's loudest — since AI-3; this path never set it.
  const mk = (label, options) => fakeAct({
    aiEnabled: true,
    llm: async () => ({ ok: true, text: JSON.stringify({ choice: options[0], justification: "j", confidence: "High" }) }),
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/reddit/jobs/1", title: "t",
      fields: [{ fieldName: "q", inputSel: "#q", widgetType: "select", label, isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: options.map((t) => ({ text: t })) }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: () => ({ ok: true }),
    atsInjReadValue: () => ({ ok: true, value: options[0] }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  // the wordings that were missed
  for (const label of ["Military service", "Do you identify as transgender?", "What are your pronouns?", "Do you identify as LGBTQ+?", "What is your age range?"]) {
    const out = await ats.driveAtsPageFill(mk(label, ["No military service", "I am a veteran"]), "greenhouse", PROFILE, {}, {}, {});
    assert.strictEqual(out.results[0].flag, "ai-eeo-guess", label + " must carry the demographic badge");
  }
  // …and a normal screening question must NOT be mislabelled as a demographic
  // (deliberately a question no recogniser owns — "how did you hear" has its own deterministic ladder
  // and would never reach the AI at all)
  const out = await ats.driveAtsPageFill(mk("Which internal team interests you most?", ["Platform", "Ads"]), "greenhouse", PROFILE, {}, {}, {});
  assert.strictEqual(out.results[0].flag, "ai-choice", "an ordinary question keeps the ordinary badge");
  // an over-18 question is legally loaded but NOT a protected characteristic
  const age = await ats.driveAtsPageFill(mk("Are you over the age of 18?", ["Yes", "No"]), "greenhouse", PROFILE, {}, {}, {});
  assert.notStrictEqual(age.results[0].flag, "ai-eeo-guess");
});

test("replay: an APPROVED typed location counts as committed; a FILL still asks for review", async () => {
  // Greenhouse's candidate-location needs google.maps.places, which never loads in this browser — a
  // human gets no suggestions either. On a REPLAY the operator has already approved the exact text and
  // the box holds it, so calling it needs_review fails the strict verify and blocks the gate forever
  // (live 2026-08-06, Reddit: the only failure left in an otherwise clean rehearsal).
  const mk = () => {
    let typed = null;
    return { act: fakeAct({
      atsInjScan: () => ({
        ats: "greenhouse", url: "https://job-boards.greenhouse.io/reddit/jobs/1", title: "t",
        fields: [{ fieldName: "candidate-location", inputSel: "#candidate-location", widgetType: "location", label: "Location (City)", isRequired: true, value: null, domIndex: 0 }],
      }),
      atsInjPlacesReady: () => ({ ok: true, places: false }),   // the library never loaded
      atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
      atsInjReadOptions: () => ({ ok: true, open: true, options: [] }),
      atsInjTypeInCombo: (sel, t) => { if (t) typed = t; return { ok: true }; },
      atsInjReadComboInput: () => ({ ok: true, value: typed || "" }),
      atsInjCloseCombo: () => ({ ok: true }),
      atsInjReadValue: () => ({ ok: true, value: typed }),
    }) };
  };
  // REPLAY: the approved value is in the box ⇒ committed (flagged), so the gate can pass
  const rep = await ats.driveAtsPageFill(mk().act, "greenhouse", PROFILE, {}, {}, { valueFor: () => "Tallahassee, Florida" });
  assert.strictEqual(rep.results[0].status, "filled_review", "an approved typed location is committed: " + rep.results[0].detail);
  assert.strictEqual(rep.results[0].flag, "location-typed-unverified", "…and it stays flagged, never silent");

  // FILL: nobody has approved anything yet, so it must still reach review
  const fill = await ats.driveAtsPageFill(mk().act, "greenhouse", PROFILE, {}, {}, {});
  assert.strictEqual(fill.results[0].status, "needs_review", "a fresh fill still asks the human");

  // …AND THE AUDIT OVERRULES ALL OF IT. Live 2026-08-06 on Reddit the box did NOT keep the text, the
  // M40 re-read found it empty, and the field was downgraded — so the gate refused a form whose
  // required location really was blank. That is the safety property; without it this grade would let a
  // submit through with an empty required field.
  let typed2 = null;
  const discards = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/reddit/jobs/1", title: "t",
      fields: [{ fieldName: "candidate-location", inputSel: "#candidate-location", widgetType: "location", label: "Location (City)", isRequired: true, value: null, domIndex: 0 }],
    }),
    atsInjPlacesReady: () => ({ ok: true, places: false }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: [] }),
    atsInjTypeInCombo: (sel, t) => { if (t) typed2 = t; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: typed2 || "" }),
    atsInjCloseCombo: () => { typed2 = null; return { ok: true }; },   // the widget DISCARDS free text
    atsInjReadValue: () => ({ ok: true, value: typed2 }),
  });
  const lost = await ats.driveAtsPageFill(discards, "greenhouse", PROFILE, {}, {}, { valueFor: () => "Tallahassee, Florida" });
  assert.strictEqual(lost.results[0].status, "needs_review", "a box that discarded the value is NOT committed: " + lost.results[0].detail);
  assert.match(String(lost.results[0].detail), /audit/i, "and the audit is what says so");
});

test("degree level: bridges the granularity gap, and NEVER invents a credential", () => {
  // Live 2026-08-06, Discord: the reconned 10-option list offers "Bachelor's Degree" while the profile
  // states "Bachelor of Science" (ladder: "Bachelors", "Bachelor of Science (BS)"). The apostrophe and
  // the "Degree" suffix defeat exact, containment (off for dropdowns) and fuzzy (~56%).
  const GENERIC = ["Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctor of Medicine (M.D.)", "High School"];
  assert.strictEqual(ats.atsDegreeMatch(["Bachelor of Science", "Bachelors"], GENERIC), "Bachelor's Degree");
  assert.strictEqual(ats.atsDegreeMatch(["Master of Science"], GENERIC), "Master's Degree");
  assert.strictEqual(ats.atsDegreeMatch(["MBA"], GENERIC), "Master's Degree");

  // ⚠ THE ONE THAT MATTERS: a PhD is not an MD. A first cut bucketed every doctorate together and
  // matched "Doctor of Medicine (M.D.)" because it was the only doctorate on the list — a confident
  // wrong credential, the worst failure this project has.
  assert.strictEqual(ats.atsDegreeMatch(["Doctor of Philosophy"], GENERIC), null);
  assert.strictEqual(ats.atsDegreeMatch(["PhD"], GENERIC), null);
  assert.strictEqual(ats.atsDegreeMatch(["Doctor of Medicine"], GENERIC), "Doctor of Medicine (M.D.)");
  assert.strictEqual(ats.atsDegreeMatch(["PhD"], ["Bachelor's Degree", "Doctorate"]), "Doctorate");
  assert.strictEqual(ats.atsDegreeMatch(["Juris Doctor"], GENERIC), null, "a JD is not an MD either");

  // two options at the SAME level is a real choice — the human makes it
  assert.strictEqual(ats.atsDegreeMatch(["Bachelor of Science"], ["Bachelor of Science", "Bachelor of Arts"]), null);
  // and a value that names no level is none of this bridge's business
  assert.strictEqual(ats.atsDegreeMatch(["Yes"], GENERIC), null);
  assert.strictEqual(ats.atsDegreeMatch([], GENERIC), null);
});

test("driver: a degree question fills through the level bridge, flagged; other dropdowns unaffected", async () => {
  let committed = null;
  const mk = (label) => fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/discord/jobs/1", title: "t",
      fields: [{ fieldName: "degree--0", inputSel: "#degree--0", widgetType: "select", label, isRequired: false, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    atsInjReadOptions: () => ({ ok: true, open: true, options: ["Associate's Degree", "Bachelor's Degree", "Master's Degree"].map((t) => ({ text: t })) }),
    atsInjTypeInCombo: () => ({ ok: true }),
    atsInjReadComboInput: () => ({ ok: true, value: "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const buckets = [{ questions: ["Degree", "Highest level of education"], value: ["Bachelor of Science"] }];
  const out = await ats.driveAtsPageFill(mk("Degree"), "greenhouse", PROFILE, {}, {}, { buckets });
  assert.strictEqual(committed, "Bachelor's Degree");
  assert.strictEqual(out.results[0].matchTier, "degree-level");
  assert.strictEqual(out.results[0].status, "filled_review", "a non-exact tier is always flagged");

  // the bridge is gated on the LABEL: an unrelated dropdown with degree-ish values must not use it
  committed = null;
  const other = await ats.driveAtsPageFill(mk("Which team?"), "greenhouse", PROFILE, {}, {}, { buckets });
  assert.notStrictEqual(other.results[0].matchTier, "degree-level");
});

test("a COMPLETE list is matched whole, never searched — typing would filter the answer away", async () => {
  // Traced live 2026-08-06 on Discord's degree box: opening it renders all 10 options, and typing the
  // profile's own wording ("Bachelor of Science") filters that to "No options", because the widget
  // matches TYPED TEXT while the form's vocabulary is "Bachelor's Degree". Searching a list you can
  // already see in full can only hide the answer.
  const typed = [];
  let committed = null;
  const act = fakeAct({
    atsInjScan: () => ({
      ats: "greenhouse", url: "https://job-boards.greenhouse.io/discord/jobs/1", title: "t",
      fields: [{ fieldName: "degree--0", inputSel: "#degree--0", widgetType: "select", label: "Degree", isRequired: false, value: null, domIndex: 0 }],
    }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    // the widget filters on the typed text, exactly like the live one
    atsInjReadOptions: () => {
      const all = ["Associate's Degree", "Bachelor's Degree", "Master's Degree"];
      const q = typed[typed.length - 1] || "";
      const shown = q ? all.filter((t) => t.toLowerCase().includes(q.toLowerCase())) : all;
      return { ok: true, open: true, loading: false, options: shown.map((t) => ({ text: t })) };
    },
    atsInjTypeInCombo: (sel, t) => { typed.push(t || ""); return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: typed[typed.length - 1] || "" }),
    atsInjCommitOption: (sel, t) => { committed = t; return { ok: true }; },
    atsInjReadValue: () => ({ ok: true, value: committed }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const buckets = [{ questions: ["Degree"], value: ["Bachelor of Science"] }];
  const out = await ats.driveAtsPageFill(act, "greenhouse", PROFILE, {}, {}, { buckets });
  assert.strictEqual(committed, "Bachelor's Degree", "matched from the whole list: " + out.results[0].detail);
  assert.deepStrictEqual(typed.filter(Boolean), [], "a complete list must never be searched");
});

test("atsListIsComplete: a short settled list is complete; a page or a loading one is not", () => {
  const opts = (n) => ({ ok: true, open: true, options: Array.from({ length: n }, (_, i) => ({ text: "o" + i })) });
  assert.strictEqual(ats.atsListIsComplete(opts(10)), true);
  assert.strictEqual(ats.atsListIsComplete(opts(59)), true);
  assert.strictEqual(ats.atsListIsComplete(opts(60)), false, "a page-sized read is a PAGE, not the whole list");
  assert.strictEqual(ats.atsListIsComplete(opts(100)), false);
  assert.strictEqual(ats.atsListIsComplete({ ok: true, open: true, options: [] }), false, "nothing rendered proves nothing");
  assert.strictEqual(ats.atsListIsComplete({ ok: true, open: true, loading: true, options: [{ text: "a" }] }), false, "still fetching");
  assert.strictEqual(ats.atsListIsComplete(null), false);
});

// An employer page that EMBEDS the ATS form in an iframe (Greenhouse's #grnhse_app widget) must
// be followed into the frame, and an ambiguous page must refuse rather than pick one.
test("embedded form: a single ATS iframe is followed, ambiguity refuses", () => {
  const det = (u) => (/greenhouse/.test(u) ? "greenhouse" : /lever/.test(u) ? "lever" : null);
  assert.equal(
    ats.atsPickEmbeddedForm(["https://www.youtube.com/embed/x", "https://job-boards.greenhouse.io/embed/job_app?token=1"], det),
    "https://job-boards.greenhouse.io/embed/job_app?token=1"
  );
  // the same frame twice is ONE choice, not an ambiguity
  assert.equal(ats.atsPickEmbeddedForm(["https://job-boards.greenhouse.io/a", "https://job-boards.greenhouse.io/a"], det), "https://job-boards.greenhouse.io/a");
  // two DIFFERENT ATS frames: refuse
  assert.equal(ats.atsPickEmbeddedForm(["https://job-boards.greenhouse.io/a", "https://jobs.lever.co/b"], det), null);
  assert.equal(ats.atsPickEmbeddedForm(["https://cdn.example.com/x"], det), null);
  assert.equal(ats.atsPickEmbeddedForm([], det), null);
});

// The apply-BUTTON finder must match real apply wording and reject near-misses; it is the
// last resort before a run gives up, so a false negative abandons a fillable application.
test("apply button: matches apply wording, rejects near-misses", () => {
  const src = String(ats.atsInjClickApplyButton);
  const m = src.match(/APPLY_RE = (\/[^;]+\/i)/);
  assert.ok(m, "APPLY_RE literal present");
  const re = eval(m[1]);
  for (const good of ["Apply", "Apply Now", "Apply now", "Apply here", "Apply for this job"]) assert.ok(re.test(good), good);
  for (const bad of ["Reapply later", "Application status", "Applying soon"]) assert.ok(!re.test(bad), bad);
  // no stray control characters (a corrupted escape once made this regex match nothing)
  const ctrl = [...src].some((c) => { const n = c.codePointAt(0); return n < 32 && n !== 10 && n !== 13 && n !== 9; });
  assert.equal(ctrl, false, "no control chars in the injected source");
});

// A stored review entry must still match its field on a LATER page load. Ashby regenerates the
// form-instance uuid it prefixes onto every custom question, which once made a clean submit
// fail with "approved value has NO matching field on the live form".
test("durable field name: strips per-session uuid prefixes, keeps real names", () => {
  const d = ats.atsDurableFieldName;
  const q = "fe19ec8e-680c-4f8d-bc5b-0c0866587f75";
  // same question, two page loads, two different form-instance prefixes
  assert.equal(d("2c63133a-e790-4cd0-854c-95c852291caa_" + q), q);
  assert.equal(d("1103cd1e-73df-4bad-9f49-b61f3c364829_" + q), q);
  assert.equal(d("2c63133a-e790-4cd0-854c-95c852291caa__systemfield_name"), "__systemfield_name");
  // NEGATIVES: a bare question id is the name itself, and ordinary names are untouched
  assert.equal(d(q), q);
  assert.equal(d("_systemfield_email"), "_systemfield_email");
  assert.equal(d("first_name"), "first_name");
  assert.equal(d("cards[abc][field0]"), "cards[abc][field0]");
  assert.equal(d(null), "");
});

// A REQUIRED choice the profile can't answer takes the form's OWN decline option rather than
// staying blank and blocking the submit. The negatives matter more than the positives: a real
// answer must never be mistaken for a decline.
test("decline option: recognised only when the form truly offers one", () => {
  const d = ats.atsDeclineOption;
  assert.equal(d(["Female", "Male", "Other", "I don't wish to answer"]), "I don't wish to answer");
  assert.equal(d(["Yes", "No", "Decline To Self Identify"]), "Decline To Self Identify");
  assert.equal(d(["Asian", "White", "Prefer not to say"]), "Prefer not to say");
  assert.equal(d(["Hispanic or Latino", "Not Hispanic or Latino", "I do not wish to disclose"]), "I do not wish to disclose");
  // NEGATIVES — no decline offered, so the field must stay blank for a human
  assert.equal(d(["Yes", "No"]), null);
  assert.equal(d(["Male", "Female"]), null);
  // a substantive answer that merely contains 'not' is NOT a decline
  assert.equal(d(["I do not have a disability", "Yes, I have a disability"]), null);
  assert.equal(d(["Not Hispanic or Latino", "Hispanic or Latino"]), null);
  // ambiguous (two declines) refuses rather than guessing
  assert.equal(d(["Prefer not to say", "Decline to answer"]), null);
  assert.equal(d([]), null);
});

// A preferred-name question with NO preferred name in the profile answers from the legal name,
// at the granularity the field asks for. An AI guess here is both unnecessary and wrong-shaped:
// the answer is already in the profile.
test("preferred name: falls back to the legal name, at the right granularity", () => {
  const v = (l, prof) => { const r = ats.atsPreferredNameValue(l, prof); return r ? r.value : null; };
  const NONE = { personal_info: { first_name: "Kevin", last_name: "Wang", has_preferred_name: false, preferred_first_name: "", preferred_last_name: "" } };
  assert.equal(v("Preferred Name", NONE), "Kevin Wang");
  assert.equal(v("Preferred Name (if applicable)", NONE), "Kevin Wang");
  assert.equal(v("What is the name you would prefer us to use?", NONE), "Kevin Wang");
  // GRANULARITY: a surname box must never receive the full name
  assert.equal(v("Preferred First Name", NONE), "Kevin");
  assert.equal(v("Preferred Last Name", NONE), "Wang");
  assert.equal(v("Preferred Given Name", NONE), "Kevin");
  assert.equal(v("Preferred Family Name", NONE), "Wang");

  // A STATED preferred name always wins over the legal one
  const SET = { personal_info: { first_name: "Kevin", last_name: "Wang", has_preferred_name: true, preferred_first_name: "Kev", preferred_last_name: "W" } };
  assert.equal(v("Preferred First Name", SET), "Kev");
  assert.equal(v("Preferred Last Name", SET), "W");
  assert.equal(v("Preferred Name", SET), "Kev W");
  // ...but an explicit "I have no preferred name" beats stale text left in those boxes
  const STALE = { personal_info: { first_name: "Kevin", last_name: "Wang", has_preferred_name: false, preferred_first_name: "Kev" } };
  assert.equal(v("Preferred First Name", STALE), "Kevin");

  // NEGATIVES — neighbours that share the words but are DIFFERENT questions
  for (const l of ["Pronouns", "Preferred Pronouns", "Name Pronunciation", "Do you have a preferred name?", "Full Name", "Preferred Location", "Preferred Work Location"]) {
    assert.equal(v(l, NONE), null, l);
  }
  // no name in the profile at all ⇒ nothing to derive
  assert.equal(v("Preferred Name", { personal_info: {} }), null);
});

// The rung must fire for TEXT widgets and stay out of the way of choice widgets.
test("preferred name: routed for text widgets, deterministic and unflagged", () => {
  const prof = { personal_info: { first_name: "Kevin", last_name: "Wang", has_preferred_name: false } };
  const r = ats.atsRouteLabel("Preferred Name", { widgetType: "text" }, prof, {});
  assert.equal(r && r.value, "Kevin Wang");
  assert.notEqual(r.source, "bucket"); // not a taught answer — derived from the profile
  // a choice widget asking about preferred names is a different question: fall through
  const c = ats.atsRouteLabel("Preferred Name", { widgetType: "radio" }, prof, {});
  assert.ok(!c || c.value === undefined, "choice widget must not get a name string");
});

// A settled field count only proves the page stopped changing. Live 2026-08-02 an employer
// careers page's direct-mail signup settled at 2 fields, so the run filled a MARKETING widget
// and filed an application record for it. A form must be IDENTIFIED, not merely counted.
test("form identity: a marketing widget is not an application form", () => {
  const look = ats.atsLooksLikeApplicationForm;
  const SUB = { hasSubmit: true }, NOSUB = { hasSubmit: false };
  const dm = [{ fieldName: "dm-reservation-number" }, { fieldName: "dm-postal-code" }];
  assert.equal(look(dm, NOSUB).ok, false);
  assert.match(look(dm, NOSUB).why, /submit/i);
  // even WITH a submit control it has no identity anchor
  assert.equal(look(dm, SUB).ok, false);

  // all three real form shapes must pass
  assert.equal(look([{ fieldName: "first_name", label: "First Name" }, { fieldName: "email", label: "Email" }, { fieldName: "resume", widgetType: "file_upload" }], SUB).ok, true);
  assert.equal(look([{ fieldName: "name", label: "Full name" }, { fieldName: "email", label: "Email" }], SUB).ok, true);
  assert.equal(look([{ fieldName: "_systemfield_name", label: "Name" }, { fieldName: "_systemfield_resume", widgetType: "file_upload" }], SUB).ok, true);

  // a real form whose submit control we can't see is NOT accepted — we could never submit it
  assert.equal(look([{ fieldName: "email", label: "Email" }], NOSUB).ok, false);
  assert.equal(look([], SUB).ok, false);
  assert.equal(look(null, null).ok, false);
});

// react-select MULTI widgets (Greenhouse's demographic questions) hold their selection as CHIPS,
// and a second commit APPENDS rather than replaces. Both facts were learned the hard way:
// reading only .select__single-value fell through to the empty search input, so three REQUIRED
// fields that had filled CORRECTLY were reported as `commit did not persist (read null)`; and a
// re-run could append a contradictory second chip (Male + Female on one sex question).
// Exercised against a minimal fake DOM — these are injected functions, so this is the only way
// to pin their behaviour outside a browser.
test("react-select multi: chips are the value, and a commit never appends", () => {
  const mkChip = (label) => ({
    className: "select__multi-value",
    textContent: label + "\u00d7",           // the chip includes its remove button's glyph
    querySelector: (sel) => (/multi-value__label/.test(sel) ? { textContent: label } : null),
  });
  // shell.querySelectorAll returns chips; querySelector('.select__single-value') finds none
  const mkShell = (chips) => ({
    querySelector: (sel) => (/single-value/.test(sel) ? null : null),
    querySelectorAll: (sel) => (/multi-value/.test(sel) ? chips : []),
  });
  const install = (chips, inputValue) => {
    const shell = mkShell(chips);
    const el = { value: inputValue, closest: (sel) => (sel === ".select" ? shell : null) };
    global.document = { querySelector: () => el, querySelectorAll: () => [el], getElementById: () => null };
    return el;
  };
  const prevDoc = global.document;
  try {
    // READ: the chip is the value, and the remove-button glyph is not part of it
    install([mkChip("Male")], "");
    assert.equal(ats.atsInjReadValue("greenhouse", "#x", "select").value, "Male");
    // several chips read as a list
    install([mkChip("Male"), mkChip("Female")], "");
    assert.equal(ats.atsInjReadValue("greenhouse", "#x", "select").value, "Male, Female");
    // NO chips ⇒ unchanged behaviour (a single-select falls back to the input value)
    install([], "");
    assert.equal(ats.atsInjReadValue("greenhouse", "#x", "select").value, null);
  } finally {
    global.document = prevDoc;
  }
});

// A Greenhouse EMBED url identifies its job ONLY in the query string, and canonicalJobUrl drops
// the query — so every employer's embedded application collapsed to ONE job_key. Live 2026-08-02
// a submit run pulled a DIFFERENT company's approved bundle: the review page showed all approved
// while the gate refused, naming a field belonging to the other application.
test("job key: embedded Greenhouse applications do not collide", () => {
  const c = require("../lib.js").canonicalJobUrl;
  const asana = c("https://job-boards.greenhouse.io/embed/job_app?for=asana&token=8092044");
  const sofi = c("https://job-boards.greenhouse.io/embed/job_app?for=sofi&token=7781335003");
  assert.notEqual(asana, sofi, "two embedded applications must not share a key");
  assert.match(asana, /8092044/);
  // the SAME job through a different embed url (validity tokens rotate) still keys the same
  assert.equal(c("https://job-boards.greenhouse.io/embed/job_app?for=asana&validityToken=ZZZ&token=8092044"), asana);

  // EVERYTHING ELSE UNCHANGED — these are the shapes the key already had to collapse
  assert.equal(c("https://jobs.lever.co/spotify/08d82da1/apply"), "https://jobs.lever.co/spotify/08d82da1");
  assert.equal(c("https://jobs.ashbyhq.com/cohere/b9c8/application"), "https://jobs.ashbyhq.com/cohere/b9c8");
  assert.equal(c("https://acme.wd3.myworkdayjobs.com/en-US/x/job/Y_R00244793/apply"), "wd3:r00244793");
  // a NON-embed url keeps dropping its query, as before
  assert.equal(c("https://www.sofi.com/careers/job/?gh_jid=7781335003"), "https://www.sofi.com/careers/job");
});

// Greenhouse's #country is a DIAL composite: options read "<Country> +<code>" while the profile
// stores "United States of America (+1)". Stripping only the option's code leaves
// "united states" vs "united states of america" — unmatched by exact, containment AND fuzzy, so
// every such field silently reached review (live 2026-08-02). Two signals must AGREE: same dial
// code AND one name prefixes the other. The refusals matter as much as the hits.
test("dial match: code + name agree, and neither signal is trusted alone", () => {
  const opts = [
    "United States +1", "Canada +1", "Puerto Rico +1", "Afghanistan +93",
    "United Arab Emirates +971", "United Kingdom +44",
    "Congo +242", "Congo, Democratic Republic of the +243",
  ];
  const pick = (cand) => { const r = ats.atsDialMatch([cand], opts); return r ? opts[r.index] : null; };

  assert.equal(pick("United States of America (+1)"), "United States +1", "the live failure");
  assert.equal(pick("United States (+1)"), "United States +1");
  assert.equal(pick("United Kingdom (+44)"), "United Kingdom +44");
  // THE +1 COLLISION: the code alone would be ambiguous; the NAME decides
  assert.equal(pick("Canada (+1)"), "Canada +1");
  // THE PREFIX TRAP: a bare prefix would let "Congo" swallow the DRC; the CODE decides
  assert.equal(pick("Congo (+242)"), "Congo +242");
  assert.equal(pick("Congo, Democratic Republic of the (+243)"), "Congo, Democratic Republic of the +243");

  // REFUSALS
  assert.equal(pick("Mexico (+52)"), null, "code not offered");
  assert.equal(pick("Narnia (+1)"), null, "code shared but no name agrees");
  assert.equal(pick("United States of America"), null, "no dial code: not a dial candidate");
  assert.equal(ats.atsDialMatch([], opts), null);
  assert.equal(ats.atsDialMatch(["United States (+1)"], []), null);
  // 2+ options satisfying both is not a confident answer
  assert.equal(ats.atsDialMatch(["United States (+1)"], ["United States +1", "United States +1"]), null);
});

// A commit read-back must POLL. act.delay is ADAPTIVE (collapses to ~20ms when page timers
// measure fast), so "delay then read once" sampled the widget before React had committed its
// re-render and reported `commit did not persist (read null)` on a commit that worked — live
// 2026-08-02 on two Greenhouse dropdowns, HIDDEN runs only. Here the value appears on the THIRD
// read: a single sample sees null, a poll sees "No".
test("commit read-back: polls until the value appears, instead of sampling once", async () => {
  let reads = 0;
  const act = {
    delay: async () => {}, delayFull: async () => {}, delayRender: async () => {}, aiEnabled: false,
    eval: async (fn, ...args) => {
      const n = (fn && fn.name) || "";
      if (n === "atsInjReadOptions") return { ok: true, open: true, options: [{ text: "Yes" }, { text: "No" }] };
      if (n === "atsInjOpenAndReadOptions") return { ok: true };
      if (n === "atsInjCommitOption") return { ok: true };
      if (n === "atsInjReadValue") { reads++; return { ok: true, value: reads >= 3 ? "No" : null }; }
      return { ok: true };
    },
  };
  const rec = {};
  const f = { fieldName: "610", label: "I have a disability (please select one):", widgetType: "select", isRequired: true, options: [] };
  await ats.atsActuateField(act, "greenhouse", f, { inputSel: "#610" }, rec, ["No"], null, {}, {}, {});
  assert.equal(rec.after, "No", "detail was: " + rec.detail);
  assert.ok(/^filled/.test(String(rec.status)), "status was " + rec.status);
  assert.ok(reads >= 3, "it actually polled (reads=" + reads + ")");
});

// ── SELECT-ALL-THAT-APPLY identity checkboxes (Ashby/Sierra, live 2026-08-07) ──────────────
// The diversity survey renders each identity as its OWN checkbox, so the LABEL is an option
// rather than a question. The profile answers those dimensions in whole sentences, which used
// to match neither /^(yes|true)$/ nor /^(no|false)$/ — so two questions the profile ALREADY
// ANSWERS were reported as "your profile answer isn't one of this form's options". Leaving the
// box unchecked IS that answer, so it must be silent, and it must not actuate anything.
test("checkbox: a stated NEGATIVE leaves an identity box unchecked, silently and untouched", async () => {
  for (const stated of ["No, I don't have a disability", "I am not a protected veteran", "No"]) {
    let touched = false;
    const act = fakeAct({ atsInjSetChecked: () => { touched = true; return { ok: true, checked: true }; } });
    const f = { fieldName: "cb", widgetType: "checkbox", label: "Person with disability", isRequired: false, options: [] };
    const rec = {};
    const produced = await ats.atsActuateField(act, "ashby", f, { inputSel: "#cb" }, rec, [stated], null, {}, {}, {});
    assert.ok(produced, stated + ": the driver must OWN this field, not fall through to needs_review");
    assert.strictEqual(rec.status, "skipped", stated + " → status was " + rec.status);
    assert.ok(!rec.flag, stated + " must not be flagged for review, it is answered");
    assert.strictEqual(touched, false, stated + " must not click the box");
  }
});

test("checkbox: an answer that NAMES the identity ticks it; a different identity does not", async () => {
  const mk = (label) => ({ fieldName: "cb", widgetType: "checkbox", label, isRequired: false, options: [] });
  // exact-normalized name → the affirmative
  let checked = false;
  const act = fakeAct({ atsInjSetChecked: () => { checked = true; return { ok: true, checked: true }; } });
  const rec = {};
  await ats.atsActuateField(act, "ashby", mk("Asian"), { inputSel: "#cb" }, rec, ["Asian"], null, {}, {}, {});
  assert.strictEqual(checked, true, "an answer naming this identity should tick it");
  assert.strictEqual(rec.status, "filled_review", "an EEO box we ticked is always shown to the human");

  // NOT a near-miss: "East Asian" must not decide a box labelled "Asian" (an "East Asian" box may exist)
  let checked2 = false;
  const act2 = fakeAct({ atsInjSetChecked: () => { checked2 = true; return { ok: true, checked: true }; } });
  const rec2 = {};
  const produced2 = await ats.atsActuateField(act2, "ashby", mk("Asian"), { inputSel: "#cb" }, rec2, ["East Asian"], null, {}, {}, {});
  assert.strictEqual(checked2, false, "a containment near-miss must never tick a demographic box");
  assert.strictEqual(produced2, false, "it should fall through so the human picks it");
});

test("checkbox: an ordinary consent is unchanged — required auto-checks, refused required flags", async () => {
  let checked = false;
  const act = fakeAct({ atsInjSetChecked: () => { checked = true; return { ok: true, checked: true }; } });
  const rec = {};
  const f = { fieldName: "consent", widgetType: "checkbox", label: "I agree to the terms", isRequired: true, options: [] };
  await ats.atsActuateField(act, "ashby", f, { inputSel: "#c" }, rec, null, null, {}, {}, {});
  assert.strictEqual(checked, true);
  assert.strictEqual(rec.status, "filled");

  const rec2 = {};
  const act2 = fakeAct({ atsInjSetChecked: () => ({ ok: true, checked: true }) });
  await ats.atsActuateField(act2, "ashby", f, { inputSel: "#c" }, rec2, ["No"], null, {}, {}, {});
  assert.strictEqual(rec2.status, "needs_review", "a required box the profile refuses is never auto-consented");
});

// ── a US state has two spellings, and a places service knows only one (live 2026-08-07) ────
// Same profile, same ATS, two Ashby forms an hour apart: "Pittsburgh, Pennsylvania," committed in
// 2.2s while "Pittsburgh, PA" returned nothing for 17.5s and reached review claiming the places
// service hadn't responded. It had; it just didn't know that spelling. So the QUERY is now the city
// alone — which every spelling agrees on — and the PICK carries the strictness instead.
test("atsPlacePick: reaches past a same-named city to the state we actually hold, either spelling", () => {
  const T = ["Pittsburgh, California, United States", "Pittsburgh, Pennsylvania, United States"];
  assert.deepStrictEqual(ats.atsPlacePick("Pittsburgh, PA", T), { index: 1, tier: "exact-normalized" });
  assert.deepStrictEqual(ats.atsPlacePick("Pittsburgh, Pennsylvania", T), { index: 1, tier: "exact-normalized" });
  // REGION_ABBREV covers Canadian provinces, so they work identically — not an accident
  assert.deepStrictEqual(ats.atsPlacePick("Toronto, ON", ["Toronto, Ontario, Canada"]), { index: 0, tier: "exact-normalized" });
});

test("atsPlacePick: a city offered ONLY in a state we do not hold is answered but FLAGGED", () => {
  const T = ["Pittsburgh, California, United States", "Pittsburgh, Pennsylvania, United States"];
  const r = ats.atsPlacePick("Pittsburgh, TX", T);
  assert.strictEqual(r.tier, "containment", "a different place of the same name is never the exact tier");
  assert.strictEqual(r.stateMismatch, true, "the human has to see this one");
  // …and with no state to check against, the first city row stands as before
  assert.deepStrictEqual(ats.atsPlacePick("Pittsburgh", T), { index: 0, tier: "exact-normalized" });
  // a city that simply is not offered is NOT forced onto some other row
  assert.strictEqual(ats.atsPlacePick("Austin, TX", T), null);
  assert.strictEqual(ats.atsPlacePick("", T), null);
});

test("atsPlacePick: a state ABBREV must sit in its own segment, never match inside a word", () => {
  // ", PA" must not be satisfied by "Palo Alto" or "Spain"; the guard is the segment boundary
  const T = ["Springfield, Palo Alto County, United States", "Springfield, PA, United States"];
  assert.deepStrictEqual(ats.atsPlacePick("Springfield, PA", T), { index: 1, tier: "exact-normalized" });
});

test("the location label is what gates the places path (a bucket routes before the map)", () => {
  for (const l of ["Where are you currently located?", "Where are you currently based?", "Current location", "Location"]) {
    assert.ok(ats.ATS_LOCATION_LABEL_RE.test(l), l + " should read as a location question");
  }
  assert.ok(!ats.ATS_LOCATION_LABEL_RE.test("Preferred work location policy"), "not every label with 'location' is a places box");
});

// ── the how-did-you-hear label tolerates an adverb (live 2026-08-07, Roblox) ─────────────────
// "How did you FIRST hear about this role?" missed the rung, so a REQUIRED question the profile
// answers exactly fell to the AI — which answered "LinkedIn", correctly, after an LLM call, then
// flagged it ai-choice and parked it in review for a human to re-confirm what the profile said.
test("router: how-did-you-hear matches the real wordings boards use, adverb or not", () => {
  const hits = [
    "How did you first hear about this role?",
    "How did you hear about us?",
    "How did you originally hear about this opportunity?",
    "How did you find this job?",
    "Where did you first hear about this position?",
    "How do you hear about this role?",
  ];
  for (const l of hits) {
    const r = ats.atsRouteLabel(l, {}, PROFILE, {});
    assert.ok(r && r.path === "how_did_you_hear.preferred", l + " → " + JSON.stringify(r && r.path));
    assert.deepStrictEqual(r.candidates, ["LinkedIn", "Handshake"], "the ladder is handed over in order");
  }
  // "How'd you hear about us?" too
  assert.ok(ats.atsRouteLabel("How'd you hear about us?", {}, PROFILE, {}).path === "how_did_you_hear.preferred");
  // …and it does not swallow unrelated questions that merely mention hearing or finding. The old
  // wording ended at the verb, so the last one routed here and would have answered an interview
  // question with "LinkedIn".
  for (const l of ["What did you hear about our culture?", "How did you find working with your last team?"]) {
    const r = ats.atsRouteLabel(l, {}, PROFILE, {});
    assert.ok(!r || r.path !== "how_did_you_hear.preferred", l + " should NOT route to the source ladder");
  }
});

// ── grouped controls belong to the grouping pass, in EVERY ATS branch (live 2026-08-07) ─────
// Greenhouse's general element loop skipped only `hidden`, so each box of a checkbox group was
// pushed twice: once as a REQUIRED "text" field keyed on the box's own id, then again as the real
// checkbox_group. On Gusto's 12-box "How did you hear about this opportunity? (select all that
// apply)", each phantom text field bought its own LLM call answering "N/A" with no basis — 12 of
// that form's 21 review items were one question. And it is worse than noise: atsInjSetText on a
// checkbox writes its .value, which is the string that option would SUBMIT. Lever and Ashby have
// always skipped both. No DOM harness exists for the injected scanners, so this pins the invariant
// at the source, the way the self-containment test above does.
test("atsInjScan: no ATS branch treats a radio or checkbox as a plain input", () => {
  const src = String(ats.atsInjScan);
  const skips = [...src.matchAll(/el\.type === "hidden"[^\n]*/g)].map((m) => m[0]);
  assert.ok(skips.length >= 3, `expected a general element loop per ATS branch, found ${skips.length}`);
  skips.forEach((line, i) => {
    assert.ok(/type === "radio"/.test(line) && /type === "checkbox"/.test(line),
      `general element loop #${i + 1} skips only hidden — grouped controls are handled by the grouping ` +
      `pass, and classifying them here creates phantom required text fields over the same boxes: ` +
      line.trim());
  });
});

// ── a protected characteristic can be asked without naming the dimension (live 2026-08-07) ──
// Chime words its GENDER question "I identify as:" — no "gender", no "sex" — so the detector missed
// it and an AI-guessed protected characteristic wore the ordinary `ai-choice` badge, while the field
// directly below it ("I identify my sexual orientation as:") got the loud demographic one.
test("atsIsEeoLabel: the self-identification frame counts, dimension word or not", () => {
  for (const l of [
    "I identify as:",
    "I identify my sexual orientation as:",
    "I identify my race/ethnicity as (please mark all that apply):",
    "How do you identify?",
    "Gender", "Veteran Status:", "Do you have a disability?", "Are you Hispanic or Latino?",
  ]) assert.ok(ats.atsIsEeoLabel(l), l + " should read as a demographic question");

  // and it must not swallow ordinary questions that merely contain the word "identify"
  for (const l of [
    "How did you identify this opportunity?",
    "Please identify your preferred start date",
    "Identify the technologies you have used",
  ]) assert.ok(!ats.atsIsEeoLabel(l), l + " is NOT a demographic question");
});

// ── a closed posting is not a broken pipeline (live 2026-08-07) ──────────────────────────────
// Twilio and Binance both halted "form-not-rendered ... open the tab and check", which sends the
// operator to debug a fill on a job that no longer exists. Both said so before we looked for a form.
test("atsPostingGone: names a dead posting, and stays silent on a healthy one", () => {
  // Lever answers a removed posting with this exact title
  assert.match(String(ats.atsPostingGone({ title: "Not found" },
    "https://jobs.lever.co/binance/7deee48b-bc3a-454b-9224-953d3f65c244",
    "https://jobs.lever.co/binance/7deee48b-bc3a-454b-9224-953d3f65c244/apply")), /Not found/);

  // Greenhouse REDIRECTS a removed posting to the board index, dropping the job id
  assert.ok(ats.atsPostingGone({ title: "Current openings at Twilio" },
    "https://job-boards.greenhouse.io/twilio/jobs/7781659",
    "https://job-boards.greenhouse.io/twilio"), "a board-index landing means the job is gone");

  // …and the URL rule alone catches it even when the title is unhelpful
  assert.match(String(ats.atsPostingGone({ title: "Careers" },
    "https://job-boards.greenhouse.io/twilio/jobs/7781659", "https://job-boards.greenhouse.io/twilio")),
    /7781659/);

  // HEALTHY: the id survives the hop to /apply and /application, so nothing is claimed
  for (const [req, land] of [
    ["https://job-boards.greenhouse.io/discord/jobs/8649856002", "https://job-boards.greenhouse.io/discord/jobs/8649856002"],
    ["https://jobs.lever.co/zoox/5fb23003-057f-4488-84c2-80ca98cc795d", "https://jobs.lever.co/zoox/5fb23003-057f-4488-84c2-80ca98cc795d/apply"],
    ["https://jobs.ashbyhq.com/sierra/8152eaf6-012b-4154-95e2-7d6c52faba93", "https://jobs.ashbyhq.com/sierra/8152eaf6-012b-4154-95e2-7d6c52faba93/application"],
  ]) assert.strictEqual(ats.atsPostingGone({ title: "Some Role" }, req, land), null, req);

  // no evidence at all → no claim (a missing JD must not read as a dead posting)
  assert.strictEqual(ats.atsPostingGone(null, "https://jobs.ashbyhq.com/x/abc", "https://jobs.ashbyhq.com/x/abc"), null);
});

// ── a query can annihilate a COMPLETE list, and the answer survives anyway (live 2026-08-07) ──
// Measured on Discord's `discipline--0`: 72 options on open; typing the profile's own wording
// ("Electrical and Computer Engineering", which that form words differently) filters the menu to
// ZERO; clearing brings all 72 back. Lists of >= 60 take the SEARCH branch, so this looked like a
// correctness risk resting on the restore poll — it is NOT. A search that finds nothing never
// overwrites `read`, so the on-open list survives even if the restore never returns. This pins that
// structural guarantee, which is easy to break by "simplifying" the search loop into an
// unconditional assignment; the fixture's restore deliberately never comes back.
test("combobox: a query that wipes the menu does not lose the list we read on open", async () => {
  // 72 options, exactly like the real discipline box: big enough to take the SEARCH branch
  // (atsListIsComplete only skips typing under ATS_OPTION_CAP), which is the whole point.
  const DEGREES = ["Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctorate", "Other"]
    .concat(Array.from({ length: 67 }, (_, i) => "Field of Study " + i));
  let typedEver = false;
  const act = fakeAct({
    atsInjScan: () => ({ ats: "greenhouse", url: "https://job-boards.greenhouse.io/x/jobs/1", title: "t", fields: [
      { fieldName: "degree--0", inputSel: "#degree--0", widgetType: "select", label: "Degree", isRequired: true, value: null, domIndex: 0 },
    ] }),
    atsInjOpenAndReadOptions: () => ({ ok: true, opened: true }),
    // the widget never recovers its list once a query has touched it — the restore poll times out
    atsInjReadOptions: () => ({ ok: true, open: true, loading: false,
      options: (typedEver ? [] : DEGREES).map((t) => ({ text: t, disabled: false })) }),
    atsInjTypeInCombo: () => { typedEver = true; return { ok: true }; },
    atsInjReadComboInput: () => ({ ok: true, value: "Bachelor of Science" }),
    atsInjCommitOption: () => ({ ok: true }),
    atsInjReadValue: () => ({ ok: true, value: "Bachelor's Degree" }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const profile = { ...PROFILE, education: [{ degree: "Bachelor of Science", school_or_university: "CMU" }] };
  const out = await ats.driveAtsPageFill(act, "greenhouse", profile, {}, {}, {
    buckets: [{ questions: ["Degree"], profile_path: "education.0.degree" }],
  });
  const r = out.results[0];
  assert.ok(typedEver, "the test must actually exercise the search branch");
  assert.notStrictEqual(r.status, "needs_review",
    "the answer was in the list we read on open — detail was: " + r.detail);
  assert.strictEqual(r.after, "Bachelor's Degree");
  // …and review still gets every option we read. It lands in captured_options rather than options
  // because we TYPED for this list, and once a query has touched a menu we cannot tell a restored
  // static list from page one of a server-backed one — see atsAttachOptions.
  assert.strictEqual((r.captured_options || []).length, DEGREES.length,
    "review gets the list we read on open, not the wiped one");
});

// ── A purely NUMERIC requisition id, and percent-encoding (2026-08-09) ─────────────────────────────
// Marvell posts `…-Engineer_2601615` — no "R", no letter prefix — so it matched neither requisition
// tier and fell through to the origin+pathname fallback. That fallback is ENCODING-SENSITIVE: Workday
// serves the location segment as "San-Diego%2C-CA" while a hand-typed or redirected URL carries the
// bare comma, so ONE job produced TWO keys and the submit run refused its own approved bundle:
//   REFUSING: no approved bundle for job_key "…" (no-remote-bundle)
test("canonicalJobUrl: a numeric requisition keys the same from the posting and the form URL", () => {
  const lib = require("../lib.js");
  const posting = "https://marvell.wd1.myworkdayjobs.com/en-US/MarvellCareers/job/San-Diego-CA/Sr-Principal-SoC-Verification-Engineer_2601615";
  const form = "https://marvell.wd1.myworkdayjobs.com/en-US/MarvellCareers/job/San-Diego%2C-CA/Sr-Principal-SoC-Verification-Engineer_2601615/apply";
  assert.strictEqual(lib.canonicalJobUrl(posting), "wd1:2601615");
  assert.strictEqual(lib.canonicalJobUrl(posting), lib.canonicalJobUrl(form), "the encoded comma must not fork the key");
});
test("canonicalJobUrl: percent-encoding never forks the FALLBACK key either", () => {
  const lib = require("../lib.js");
  const a = "https://example.com/en-US/board/job/San-Diego-CA/Some-Role";
  const b = "https://example.com/en-US/board/job/San-Diego%2C-CA/Some-Role";
  // Different spellings of the SAME segment agree; a genuinely different path still does not.
  assert.strictEqual(lib.canonicalJobUrl(b), lib.canonicalJobUrl("https://example.com/en-US/board/job/San-Diego,-CA/Some-Role"));
  assert.notStrictEqual(lib.canonicalJobUrl(a), lib.canonicalJobUrl("https://example.com/en-US/board/job/Austin-TX/Some-Role"));
});
test("canonicalJobUrl: the existing _R and letters+digits tiers are byte-identical", () => {
  const lib = require("../lib.js");
  assert.strictEqual(lib.canonicalJobUrl("https://waystar.wd1.myworkdayjobs.com/en-US/Waystar/job/Atlanta-GA/SWE_R3051"), "wd1:r3051");
  assert.strictEqual(lib.canonicalJobUrl("https://copart.wd12.myworkdayjobs.com/en-US/copart/job/Dallas-TX/SWE_JR109441"), "wd12:jr109441");
  assert.strictEqual(lib.canonicalJobUrl("https://cat.wd5.myworkdayjobs.com/en-US/solarturbines/job/X/Y_R0000381898"), "wd5:r0000381898");
});
test("canonicalJobUrl: a short path number is NOT mistaken for a requisition", () => {
  const lib = require("../lib.js");
  // ≥4 digits required, so an ordinary segment number keys by path as before.
  assert.notStrictEqual(lib.canonicalJobUrl("https://x.wd1.myworkdayjobs.com/en-US/b/job/L/Role_12"), "wd1:12");
});
