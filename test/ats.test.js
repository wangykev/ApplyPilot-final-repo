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
  assert.match(r.detail, /not a live option/);
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
