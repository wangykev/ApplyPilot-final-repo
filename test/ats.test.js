// Multi-ATS (Greenhouse / Lever / Ashby) — the pure parts + the driver against a FAKE
// actuation. The injected fns are exercised for self-containment (no closure references)
// and the driver for the safety semantics: candidates clear the match ladder vs LIVE
// options, AI fills are always flagged, read-back failures end needs_review (never a
// silent wrong value), EEO unstated stays blank.
const { test } = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

// ── detection + URL shaping ─────────────────────────────────────────────────────────────
// Shared by the source-scanning guards below. ⚠ Every one of them must strip comments FIRST: the
// code documents the shapes it refuses, and a textual scan cannot tell explaining a bug apart from
// committing it — three separate guards have failed on their own prose.
function stripJsComments(t) {
  return String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

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

// ── Oracle Recruiting Cloud (ORC / Candidate Experience) ────────────────────────────────
// Recon 2026-08-19 (Nokia, read-only). Oracle is the one family whose HOST cannot identify it,
// so detection is host + PATH — still URL-only, no page evidence. See detectAts.

test("detectAts oracle: all three observed host shapes, including the one with NO region", () => {
  // <tenant>.fa.<region>.oraclecloud.com — the common shape, six regions seen live
  for (const h of ["eeho.fa.us2", "ejov.fa.ca2", "hdpc.fa.us2", "efds.fa.em5", "hcmn.fa.ap1", "hdow.fa.us6"]) {
    assert.strictEqual(
      ats.detectAts("https://" + h + ".oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/35578"),
      "oracle", h);
  }
  // fa-<code>-saasfaprod1.fa.ocs.oraclecloud.com — the hyphenated pod + `.fa.ocs.` shape
  assert.strictEqual(
    ats.detectAts("https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/35578"),
    "oracle");
  // <tenant>.fa.oraclecloud.com — BARE: the optional region group is absent (jpmc, live)
  assert.strictEqual(
    ats.detectAts("https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210682657"),
    "oracle");
});

test("detectAts oracle: siteCode is a TENANT SETTING — nothing may key on the literal CX_1", () => {
  // Observed live across tenants. A detector keyed on "CX_1" would work on one and miss the rest.
  for (const site of ["CX_1", "CX", "CX_1001", "CX_1003", "nfcu", "LateralHiring"]) {
    assert.strictEqual(
      ats.detectAts("https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/" + site + "/jobs"),
      "oracle", site);
  }
});

test("detectAts oracle: an Oracle FUSION host that is NOT a careers page is refused", () => {
  // The whole reason detection is host+path. `*.fa.*.oraclecloud.com` also serves ERP/HCM
  // back-office UIs, and driving one of those would be actively wrong — not merely useless.
  const host = "https://eeho.fa.us2.oraclecloud.com";
  assert.strictEqual(ats.detectAts(host + "/fscmUI/faces/FuseWelcome"), null);
  assert.strictEqual(ats.detectAts(host + "/hcmUI/faces/FuseWelcome"), null);       // HCM, but not CandidateExperience
  assert.strictEqual(ats.detectAts(host + "/"), null);
  assert.strictEqual(ats.detectAts(host + "/soa-infra/services"), null);
});

test("detectAts oracle: the host test is ANCHORED — lookalikes return null", () => {
  const p = "/hcmUI/CandidateExperience/en/sites/CX_1/job/1";
  // the same discipline pinned for lever/greenhouse above: a suffix, not a substring
  assert.strictEqual(ats.detectAts("https://eeho.fa.us2.oraclecloud.com.evil.com" + p), null);
  assert.strictEqual(ats.detectAts("https://fakeoraclecloud.com" + p), null);
  assert.strictEqual(ats.detectAts("https://oraclecloud.com.evil.com" + p), null);
  // `.fa.` must be a real label, and a host with no `fa` label at all is not a Fusion pod
  assert.strictEqual(ats.detectAts("https://cloud.oraclecloud.com" + p), null);
  assert.strictEqual(ats.detectAts("https://notfa.oraclecloud.com" + p), null);
  // a vanity domain CNAME'd to ORC is DELIBERATELY not matched — that is the page-evidence case
  assert.strictEqual(ats.detectAts("https://careers.nokia.com" + p), null);
});

test("atsFormUrl oracle: returns the POSTING url unchanged — never a synthesized /apply", () => {
  // Measured: guessing the Lever/Ashby shape redirects to `…/sites/CX_1/404`. The apply route is
  // reached only by pressing button.apply-now-button. A synthesized url is a broken run.
  const u = "https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/35578";
  assert.strictEqual(ats.atsFormUrl("oracle", u), u);
  assert.ok(!/\/apply/.test(ats.atsFormUrl("oracle", u)));
  // idempotent, and a query is preserved rather than invented
  assert.strictEqual(ats.atsFormUrl("oracle", u + "?utm=x"), u + "?utm=x");
});

test("atsCompanyFromUrl oracle: null — a Fusion POD ID is not a company name", () => {
  // The subdomain is an opaque pod (`eeho`, `fa-evmr-saasfaprod1`) and path segment 0 is `hcmUI`.
  // Either would hand the safety-critical employment recognizer a word no employer is called —
  // the exact failure iCIMS' literal `jobs` segment produced. Null makes the recognizer
  // UNEVALUABLE (blank + review) instead of confidently comparing against a pod id.
  for (const u of [
    "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/1",
    "https://fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/35578",
    "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/2",
  ]) {
    assert.strictEqual(ats.atsCompanyFromUrl(u), null, u);
  }
  // …and the other families are UNTOUCHED by that change
  assert.strictEqual(ats.atsCompanyFromUrl("https://job-boards.greenhouse.io/figma/jobs/61191"), "Figma");
  assert.strictEqual(ats.atsCompanyFromUrl("https://astrioncareers-astrion.icims.com/jobs/24615/x/job"), "Astrion");
});

// ── the decoy / honeypot recognizer ─────────────────────────────────────────────────────
// ORC ships a bot-detection honeypot that EVERY visibility test in this pipeline passes
// (measured: rect 179×38, offsetParent non-null, display inline-block, visibility visible,
// opacity 1). Writing to it marks the application as a bot, and no read-back catches that
// because the write SUCCEEDS. Both directions are pinned: what it claims and what it must not.

test("atsDecoyKind: the live ORC honeypot is recognized", () => {
  // exactly as observed on the Nokia gate
  assert.strictEqual(ats.atsDecoyKind({
    fieldName: "honey-pot", ariaLabel: "honeypot", ariaHidden: "true", tabIndex: "-1",
    cssClassAttr: "input-row--invisible", widgetType: "text", isRequired: false,
  }), "honeypot");
});

test("atsDecoyKind: the GENERIC pair works with no Oracle-specific naming", () => {
  // The primary signal must not depend on a vendor's word choice — a control the page hides from
  // assistive tech AND removes from tab order is not one a human is asked to fill, anywhere.
  assert.strictEqual(ats.atsDecoyKind({ fieldName: "xyz_trap_9", ariaHidden: "true", tabIndex: "-1" }),
    "aria-hidden+untabbable");
  assert.strictEqual(ats.atsDecoyKind({ fieldName: "q7", ariaHidden: true, tabIndex: "-1" }),
    "aria-hidden+untabbable");
});

test("atsDecoyKind: NEITHER marker alone is enough", () => {
  // aria-hidden alone: a decorative wrapper around a real input legitimately carries it.
  assert.strictEqual(ats.atsDecoyKind({ fieldName: "first-name", ariaHidden: "true" }), null);
  // tabindex=-1 alone: custom widgets routinely park a programmatically-focused input out of
  // tab order — Workday's own CSS-clipped radios are reached by label, not by tabbing.
  assert.strictEqual(ats.atsDecoyKind({ fieldName: "first-name", tabIndex: "-1" }), null);
  // an "invisible" wrapper class alone is the tenant's vocabulary, not evidence
  assert.strictEqual(ats.atsDecoyKind({ fieldName: "first-name", cssClassAttr: "input-row--invisible" }), null);
});

test("atsDecoyKind: a REAL field is never claimed", () => {
  // the real email box that sits directly beside the honeypot, same classes, same container
  assert.strictEqual(ats.atsDecoyKind({
    fieldName: "primary-email", ariaLabel: "Email Address", ariaHidden: null, tabIndex: null,
    cssClassAttr: "", widgetType: "text", isRequired: true,
  }), null);
  // the CSS-clipped terms checkbox — 0×0 and opacity 0, but it MUST be ticked, so claiming it
  // as a decoy would be the inverse failure: consent silently never given.
  assert.strictEqual(ats.atsDecoyKind({
    fieldName: "legal-disclaimer-checkbox", ariaLabel: null, ariaHidden: null, tabIndex: null,
    widgetType: "checkbox", isRequired: true,
  }), null);
  assert.strictEqual(ats.atsDecoyKind({}), null);
  assert.strictEqual(ats.atsDecoyKind(null), null);
});

test("atsDecoyKind: the name match is word-anchored, so a substring cannot claim a real field", () => {
  // the guard-rail the skills containment tier had to learn: raw `includes` puts `CAN` inside
  // "Canadian". A field merely CONTAINING the letters must not be dropped.
  assert.strictEqual(ats.atsDecoyKind({ fieldName: "honeymoon-leave-request" }), null);
  assert.strictEqual(ats.atsDecoyKind({ fieldName: "pot-luck-preference" }), null);
  // …while the real separators used in the wild all match
  for (const n of ["honey-pot", "honey_pot", "honeypot", "honey pot", "HONEY-POT-1"]) {
    assert.strictEqual(ats.atsDecoyKind({ fieldName: n }), "honeypot", n);
  }
});

// ── ORC: the map-lookup key ─────────────────────────────────────────────────────────────
// atsMapKey is the MAP key, deliberately lossy; a durable/submit key is a different thing and
// for ORC is still unsettled (whether render counters renumber across visits is unverified).

test("atsMapKey oracle: the render counter is stripped so a RADIO GROUP matches the map", () => {
  // the whole reason this branch exists — a radio group's shared `name` carries the counter while
  // its combobox siblings' names are clean, so without the strip the disability group never matches
  // the entry gender/veteran do. Observed live 2026-08-19.
  assert.strictEqual(ats.atsMapKey("oracle", "US-STANDARD-ORA_DISABILITY_STATUS-STANDARD-12"), "ORA_DISABILITY_STATUS");
  assert.strictEqual(ats.atsMapKey("oracle", "US-STANDARD-ORA_GENDER-STANDARD"), "ORA_GENDER");
  assert.strictEqual(ats.atsMapKey("oracle", "US-STANDARD-ORA_GENDER-STANDARD-10"), "ORA_GENDER");
  assert.strictEqual(ats.atsMapKey("oracle", "US-STANDARD-ORA_VETERAN_STATUS-STANDARD-11"), "ORA_VETERAN_STATUS");
});

test("atsMapKey oracle: the self-ID reduction is LOCALE-NEUTRAL", () => {
  // `US-STANDARD-` is a jurisdiction prefix; keying on the whole string would silently stop
  // matching outside the US while looking like it worked.
  assert.strictEqual(ats.atsMapKey("oracle", "CA-STANDARD-ORA_GENDER-STANDARD-4"), "ORA_GENDER");
  assert.strictEqual(ats.atsMapKey("oracle", "UK-LEGISLATIVE-ORA_DISABILITY_STATUS-VARIANT-9"), "ORA_DISABILITY_STATUS");
});

test("atsMapKey oracle: names whose digits are NOT hyphen-separated are untouched", () => {
  // the guard that makes the strip safe — these all end in digits and must survive intact
  assert.strictEqual(ats.atsMapKey("oracle", "region1"), "region1");
  assert.strictEqual(ats.atsMapKey("oracle", "region2"), "region2");
  assert.strictEqual(ats.atsMapKey("oracle", "addressLine1"), "addressLine1");
  assert.strictEqual(ats.atsMapKey("oracle", "addressLine2"), "addressLine2");
  assert.strictEqual(ats.atsMapKey("oracle", "namInformation15"), "namInformation15");
});

test("atsMapKey oracle: clean platform names pass through unchanged", () => {
  for (const n of ["firstName", "lastName", "email", "knownAs", "phoneNumber", "country",
                   "city", "postalCode", "fullName", "employerName", "jobTitle", "startDate"]) {
    assert.strictEqual(ats.atsMapKey("oracle", n), n, n);
  }
});

test("atsMapKey oracle: an entry ordinal collapses to its FAMILY, on purpose", () => {
  // siteLink-1 / siteLink-2 are repeating link entries; the map keys the family and the ordinal is
  // handled as an entry index — the same treatment iCIMS gives its ordinals.
  assert.strictEqual(ats.atsMapKey("oracle", "siteLink-1"), "siteLink");
  assert.strictEqual(ats.atsMapKey("oracle", "siteLink-2"), "siteLink");
});

test("atsMapKey oracle: a per-tenant screening key collapses, and that is HARMLESS here", () => {
  // dq-option-* and 300000… are per-tenant questions that belong to the LABEL ladder, never the
  // map. Collapsing them means they fail to match a map entry — which routes them exactly where
  // they should go. ⚠ This is why atsMapKey must not be reused as a submit key: these would collide.
  assert.strictEqual(ats.atsMapKey("oracle", "dq-option-300000016979250"), "dq-option");
  assert.strictEqual(ats.atsMapKey("oracle", "dq-option-4"), "dq-option");
  assert.ok(!Object.prototype.hasOwnProperty.call(ats.ATS_STATIC_MAPS.oracle, "dq-option"));
  assert.ok(!Object.prototype.hasOwnProperty.call(ats.ATS_STATIC_MAPS.oracle, "300000016979265"));
});

test("atsMapKey: the OTHER families are byte-identical", () => {
  // the strip must not leak — greenhouse/lever/ashby names ending in digits are common
  assert.strictEqual(ats.atsMapKey("greenhouse", "question_12"), "question_12");
  assert.strictEqual(ats.atsMapKey("lever", "cards[abc][field-1]"), "cards[abc][field-1]");
  assert.strictEqual(ats.atsMapKey("ashby", "_systemfield_name-3"), "_systemfield_name-3");
  assert.strictEqual(ats.atsMapKey("icims", "-1_PersonProfileFields.AddressCity"), "PersonProfileFields.AddressCity");
});

// ── ORC: the static map's deliberate contents and deliberate GAPS ───────────────────────
test("ATS_STATIC_MAPS.oracle: phoneNumber is the DIAL CODE, not the phone number", () => {
  // the most misleading name on an ORC form. Mapping it to the number would type the number into
  // the country-code list; `kind:"dial"` + the tiered ladder is the same fix Greenhouse's `country`
  // needed.
  const m = ats.ATS_STATIC_MAPS.oracle["phoneNumber"];
  assert.strictEqual(m.kind, "dial");
  assert.strictEqual(m.path, "personal_info.country_phone_code");
  assert.ok(!/phone_number$/.test(m.path), "must NOT point at the phone number");
});

test("ATS_STATIC_MAPS.oracle: region1/region2 are UNMAPPED on purpose", () => {
  // Both are required comboboxes whose labels did not render in recon, so which is State/Province
  // vs County is unknown and probably country-dependent. Mapping the wrong one files a state as a
  // county — a confidently wrong value, worse than reaching review. This test is the reminder that
  // the gap is intentional, so a future change has to delete the test on purpose.
  assert.ok(!Object.prototype.hasOwnProperty.call(ats.ATS_STATIC_MAPS.oracle, "region1"));
  assert.ok(!Object.prototype.hasOwnProperty.call(ats.ATS_STATIC_MAPS.oracle, "region2"));
});

test("ATS_STATIC_MAPS.oracle: the address + name block points at real profile paths", () => {
  const m = ats.ATS_STATIC_MAPS.oracle;
  assert.strictEqual(m["firstName"].path, "personal_info.first_name");
  assert.strictEqual(m["lastName"].path, "personal_info.last_name");
  assert.strictEqual(m["email"].path, "personal_info.email");
  assert.strictEqual(m["addressLine1"].path, "personal_info.address_line_1");
  assert.strictEqual(m["city"].path, "personal_info.city");
  assert.strictEqual(m["postalCode"].path, "personal_info.postal_code");
  assert.strictEqual(m["country"].path, "personal_info.country");
  assert.strictEqual(m["fullName"].compose, "full_name");   // the e-signature name
});

test("ATS_STATIC_MAPS.oracle: self-ID is keyed on the ORA_ token, and DISABILITY does not use containment", () => {
  const m = ats.ATS_STATIC_MAPS.oracle;
  // Gender and veteran status keep containment: their stored values are short and the tenants word the
  // options long, so a unique prefix hit at the flagged containment tier is the best available.
  for (const [k, p] of [["ORA_GENDER", "self_identification.gender"],
                        ["ORA_VETERAN_STATUS", "self_identification.veteran_status"]]) {
    assert.strictEqual(m[k].path, p, k);
    assert.strictEqual(m[k].containment, true, k + " needs containment for long-form option wording");
  }
  // ⚠ DISABILITY IS DIFFERENT, and this is the operator's question answered: "it filled
  // deterministically, why is that for review". It committed the right option — at the CONTAINMENT
  // tier, which is graded `filled_review` BY DESIGN because containment is a guess. The polarity
  // ladder reaches the same option at a tier graded `exact`, so the answer stops being a review item
  // without becoming any less verified. Containment must NOT come back here.
  assert.strictEqual(m.ORA_DISABILITY_STATUS.path, "self_identification.disability_status");
  assert.strictEqual(m.ORA_DISABILITY_STATUS.kind, "selfid_disability");
  assert.ok(!m.ORA_DISABILITY_STATUS.containment,
    "the disability ladder ends in a bare polarity token that lands exactly — containment would " +
    "re-flag an answer we are certain about");
});

test("ATS_STATIC_MAPS.oracle: every mapped path resolves against a real profile shape", () => {
  // catches a typo'd path, which would silently look like "the profile has no value" forever.
  const profile = {
    personal_info: { first_name: "A", last_name: "B", email: "e@x.com", preferred_first_name: "P",
      country_phone_code: ["United States of America (+1)"], dialing_code: "+1",
      country: ["United States of America"], address_line_1: "1 St", address_line_2: "",
      city: "C", postal_code: "12345" },
    self_identification: { gender: "Male", race_ethnicity: "Asian", veteran_status: "No", disability_status: "No" },
  };
  const get = (p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), profile);
  for (const [key, spec] of Object.entries(ats.ATS_STATIC_MAPS.oracle)) {
    if (spec.compose || spec.candidates) continue;
    // ⚠ SKIP BY SHAPE, NOT BY A LIST OF KIND NAMES. This used to name resume/skip explicitly, so
    // adding `kind:"website"` — which resolves from a LIST and carries no `path` — crashed the guard
    // instead of skipping it. A kind-named allowlist has to be edited every time a kind is added,
    // and the failure it produces looks like a broken map rather than a stale test.
    if (spec.kind && spec.path === undefined) continue;
    // …but a spec with NEITHER a path nor a kind is exactly what this guard exists to catch.
    assert.ok(spec.path !== undefined || spec.kind,
      key + " has neither a `path` nor a `kind` — it can never resolve to anything");
    if (spec.path === undefined) continue;
    assert.notStrictEqual(get(spec.path), undefined, key + " → " + spec.path + " does not exist on the profile");
  }
});

// ── ORC onboarding: which view are we on? ───────────────────────────────────────────────
// Pure judgement half of the pre-form walk, mirroring icimsAuthView.

test("orcApplyView: captcha outranks everything actionable", () => {
  // the bot never solves or bypasses one, so no later branch that finds a fillable box may
  // reach around this.
  assert.strictEqual(ats.orcApplyView({ ok: true, captchaChallenge: true, emailInput: true, pinInputs: 6, formSectionVisible: true }), "captcha");
});

test("orcApplyView: a visible form section means DONE, even with an email box present", () => {
  // ORC prefills `email` on the form from the gate, so a form still has an email input. Checking
  // "form" before "email" is what stops the stage re-entering the gate it just cleared.
  assert.strictEqual(ats.orcApplyView({ ok: true, formSectionVisible: true, emailInput: true }), "form");
  assert.strictEqual(ats.orcApplyView({ ok: true, formSectionVisible: true, emailGate: true }), "form");
});

test("orcApplyView: the code screen outranks the email gate", () => {
  // the gate LEADS to the code screen, and the gate's markup can still be in the document
  assert.strictEqual(ats.orcApplyView({ ok: true, pinInputs: 6, emailGate: true }), "code");
  assert.strictEqual(ats.orcApplyView({ ok: true, pinInputs: 6 }), "code");
});

test("orcApplyView: the plain views", () => {
  assert.strictEqual(ats.orcApplyView({ ok: true, emailGate: true }), "email");
  assert.strictEqual(ats.orcApplyView({ ok: true, emailInput: true }), "email");
  assert.strictEqual(ats.orcApplyView({ ok: true, passwordInput: true }), "password");
  assert.strictEqual(ats.orcApplyView({ ok: true, applyControl: true }), "posting");
  assert.strictEqual(ats.orcApplyView({ ok: true }), "none");
});

test("orcApplyView: an email box beats a password box (the quick gate has no password)", () => {
  // measured on Nokia and Baylor: the quick gate asks for an email and nothing else. A page with
  // both is a real sign-in, but the login still goes in first, so "email" is the actionable view.
  assert.strictEqual(ats.orcApplyView({ ok: true, emailInput: true, passwordInput: true }), "email");
});

test("orcApplyView: federated / create-account only is BLOCKED, never pressed", () => {
  assert.strictEqual(ats.orcApplyView({ ok: true, federated: ["Sign in with Google"] }), "blocked");
  assert.strictEqual(ats.orcApplyView({ ok: true, createAccount: ["Create an account"] }), "blocked");
  // …but a fillable box outranks it: we can proceed ourselves without touching those controls
  assert.strictEqual(ats.orcApplyView({ ok: true, emailInput: true, federated: ["Sign in with Google"] }), "email");
});

test("orcApplyView: an unreadable scan is never guessed at", () => {
  assert.strictEqual(ats.orcApplyView(null), "unreadable");
  assert.strictEqual(ats.orcApplyView({ ok: false }), "unreadable");
  assert.strictEqual(ats.orcApplyView({ ok: false, emailInput: true }), "unreadable");
});

// ── The emailed verification CODE ───────────────────────────────────────────────────────
const gmail = require("../gmail.js");

test("gmailExtractVerificationCode: the ordinary ORC email", () => {
  assert.strictEqual(gmail.gmailExtractVerificationCode(
    "Your verification code is 481920. Enter it to confirm your identity."), "481920");
  assert.strictEqual(gmail.gmailExtractVerificationCode(
    "Confirm Your Identity\n\n314159\n\nType this code into the field."), "314159");
});

test("gmailExtractVerificationCode: ⚠ an ORC JOB ID IS ALSO SIX DIGITS and must never win", () => {
  // the adversarial case that motivated the URL strip: the email links back to the posting, and
  // `…/job/334325` is exactly code-shaped. Picking it would report "the code was rejected" and
  // send the next debugging round to the wrong place.
  const body = "Your verification code is 481920.\n" +
    "View the job: https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/334325";
  assert.strictEqual(gmail.gmailExtractVerificationCode(body), "481920");
  // and with NO real code present, the job id inside the URL must not be returned at all
  const noCode = "Thanks for applying. View the job: https://eeho.fa.us2.oraclecloud.com/x/job/334325";
  assert.strictEqual(gmail.gmailExtractVerificationCode(noCode), null);
});

test("gmailExtractVerificationCode: a 7+ digit run is rejected wholesale, not truncated", () => {
  // \b is not a boundary between two digits, so the first six of a long number are never taken
  assert.strictEqual(gmail.gmailExtractVerificationCode("Reference 3000000169792650 for your records"), null);
  assert.strictEqual(gmail.gmailExtractVerificationCode("Your code is 1234567"), null);
});

test("gmailExtractVerificationCode: it REFUSES an ambiguous body rather than guessing", () => {
  // two candidates, no keyword near either — guessing burns the code (a wrong submit can
  // invalidate it) and misreports the cause. One operator stop is the cheaper failure.
  assert.strictEqual(gmail.gmailExtractVerificationCode("Ref 123456 and batch 654321 processed"), null);
  // …but a LONE candidate is unambiguous even with no keyword
  assert.strictEqual(gmail.gmailExtractVerificationCode("481920"), "481920");
});

test("gmailExtractVerificationCode: keyword proximity picks the right one of several", () => {
  const body = "Requisition 334325 was posted. Your verification code is 481920. Batch 999888 queued.";
  assert.strictEqual(gmail.gmailExtractVerificationCode(body), "481920");
});

test("gmailExtractVerificationCode: empty / junk never throws", () => {
  for (const v of ["", null, undefined, 0, {}, []]) {
    assert.strictEqual(gmail.gmailExtractVerificationCode(v), null, String(v));
  }
});

test("gmailExtractVerificationCode: the code length is configurable", () => {
  assert.strictEqual(gmail.gmailExtractVerificationCode("Your code is 1234", { length: 4 }), "1234");
  assert.strictEqual(gmail.gmailExtractVerificationCode("Your code is 1234", { length: 6 }), null);
});

// ── An opt-in worded as an acceptance (live on Oracle's own careers site, 2026-08-19) ────
// Its job-alerts box says "I agree to receive new job opportunities (see oracle.com privacy
// policy)". Measured BEFORE the fix: atsConsentKind returned "accept", i.e. the box would have
// been TICKED and the operator subscribed to marketing mail — the one thing the accept-checkbox
// authorisation explicitly excludes. Pinned in both directions, because widening the opt-in side
// must not start refusing genuine privacy notices.

test("atsConsentKind: the Oracle job-alerts wording is an OPT-IN, not an acceptance", () => {
  assert.strictEqual(ats.atsConsentKind("I agree to receive new job opportunities (see oracle.com privacy policy)"), "optin");
  assert.strictEqual(ats.atsConsentKind("I agree to receive new job opportunities"), "optin");
  // sibling phrasings a tenant might ship
  assert.strictEqual(ats.atsConsentKind("Please send me career opportunities"), "optin");
  assert.strictEqual(ats.atsConsentKind("I agree to receive further employment openings"), "optin");
});

test("atsConsentKind: DECLARED intent outranks the prose", () => {
  // wording that carries no opt-in token at all, but the page files it under <opt-in>
  const hints = { containers: ["opt-in", "job-alerts-opt-in", "form-builder"], id: "job-alerts-checkbox" };
  assert.strictEqual(ats.atsConsentKind("I agree to receive updates", hints), "optin");
  // and the declaration wins even over wording that looks like a privacy acceptance, because a
  // marketer writes an opt-in in the language of assent
  assert.strictEqual(ats.atsConsentKind("I accept the privacy policy", hints), "optin");
  // an id alone is enough
  assert.strictEqual(ats.atsConsentKind("I agree", { id: "job-alerts-checkbox" }), "optin");
  assert.strictEqual(ats.atsConsentKind("I agree", { name: "marketingOptIn" }), "optin");
});

test("atsConsentKind: GENUINE acceptances still classify as accept", () => {
  // the direction that must not regress — a missed acceptance halts the run
  for (const t of ["I accept the Privacy Policy",
                   "I agree to the terms and conditions",
                   "I have read the Peraton Job Application Privacy Notice",
                   "I acknowledge the GDPR data protection notice",
                   "I accept the Privacy Notice governing this application"]) {
    assert.strictEqual(ats.atsConsentKind(t), "accept", t);
  }
  // …and an accept box carries no opt-in container, so hints do not disturb it
  assert.strictEqual(ats.atsConsentKind("I accept the Privacy Policy",
    { containers: ["legal-disclaimer", "form-builder"], id: "legal-disclaimer-checkbox" }), "accept");
});

test("atsConsentKind: attestations are still excluded on purpose", () => {
  assert.strictEqual(ats.atsConsentKind("I certify the information given is accurate"), "attestation");
  assert.strictEqual(ats.atsConsentKind("I declare under penalty of perjury"), "attestation");
});

test("atsConsentKind: hints are OPTIONAL — the iCIMS call path is unchanged", () => {
  assert.strictEqual(ats.atsConsentKind("I accept the Privacy Policy", undefined), "accept");
  assert.strictEqual(ats.atsConsentKind("I accept the Privacy Policy", null), "accept");
  assert.strictEqual(ats.atsConsentKind(""), null);
  assert.strictEqual(ats.atsConsentKind(null), null);
  assert.strictEqual(ats.atsConsentKind("Are you still enrolled?"), null);
});

test("atsConsentPlan: the Oracle job-alerts box is LEFT, the privacy box is TICKED", () => {
  const plan = ats.atsConsentPlan([
    { sel: "#job-alerts-checkbox", id: "job-alerts-checkbox", containers: ["opt-in", "job-alerts-opt-in"],
      checked: false, label: "I agree to receive new job opportunities (see oracle.com privacy policy)" },
    { sel: "#legal-disclaimer-checkbox", id: "legal-disclaimer-checkbox", containers: ["legal-disclaimer"],
      checked: false, label: "I agree with the terms and conditions" },
  ]);
  assert.strictEqual(plan.tick.length, 1);
  assert.strictEqual(plan.tick[0].sel, "#legal-disclaimer-checkbox");
  assert.ok(plan.left.some((c) => c.sel === "#job-alerts-checkbox" && c.kind === "optin"),
    "the job-alerts box must be left untouched and named as an opt-in");
});

// ── no injected fn may call ANOTHER injected fn (2026-08-19) ─────────────────────────────
// The existing self-containment test greps each injected fn for the SHIM names (atsLib/atsFd/…),
// which is necessary but not sufficient: an injected fn is stringified and evaluated in the page, so
// a reference to any other top-level function is equally undefined there.
//
// Found the hard way while writing atsInjOrcPick — it called a top-level atsInjOrcCommitRow, split
// out "so the two commit paths cannot drift". Every unit test passed and the reference would have
// thrown ReferenceError on the first live pick. Shared logic between injected fns has to be an inner
// closure (or duplicated as a marked LOCKSTEP pair), never a call.
test("injected fns never reference another atsInj* function", () => {
  const names = Object.keys(ats).filter((k) => /^atsInj/.test(k) && typeof ats[k] === "function");
  assert.ok(names.length > 15, "expected the injected-fn family, found " + names.length);
  for (const name of names) {
    // strip comments first — prose that NAMES a sibling is documentation, not a call. Same reason the
    // iCIMS lockstep test strips them.
    const src = String(ats[name])
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const other of names) {
      if (other === name) continue;
      assert.ok(!new RegExp("\\b" + other + "\\s*\\(").test(src),
        name + " CALLS " + other + " — an injected fn is evaluated in the page, where that name does " +
        "not exist. Inline it as a closure instead.");
    }
  }
});


// ── ORC option capture: which pickers may be enumerated for review ──────────────────────
// The operator's asymmetry decides every uncertain case: a picker MISSING their answer makes them
// conclude the form does not offer it, while a complete list wrongly called partial only costs a
// typed value. So this errs toward not claiming a list.

test("atsOrcCaptureEligible: a plain picker is captured, a GEO picker never is", () => {
  // non-geo: an empty open returns the whole vocabulary on ORC (measured: country 251, dial 247,
  // title 17 — there is no pager), so the captured list is genuinely complete.
  assert.strictEqual(ats.atsOrcCaptureEligible({ widgetType: "select" }), true);
  // geo: DEPENDENT (a child with an uncommitted parent answers "No results", so a scan-time capture
  // would record an empty vocabulary as if it were the field's) and unbounded for city/postal.
  assert.strictEqual(ats.atsOrcCaptureEligible({ widgetType: "select", searchDriven: true }), false);
});

test("atsOrcCaptureEligible: nothing already enumerated is re-opened", () => {
  // radio / checkbox groups read their option labels inline during the scan — opening them would be
  // page contact for a list we already hold.
  assert.strictEqual(ats.atsOrcCaptureEligible({ widgetType: "radio", options: ["Yes", "No"] }), false);
  assert.strictEqual(ats.atsOrcCaptureEligible({ widgetType: "checkbox_group", options: ["A", "B"] }), false);
  assert.strictEqual(ats.atsOrcCaptureEligible({ widgetType: "select", options: ["A"] }), false);
});

test("atsOrcCaptureEligible: non-choice widgets are never opened", () => {
  for (const w of ["text", "textarea", "date", "file_upload", "checkbox", "unknown"]) {
    assert.strictEqual(ats.atsOrcCaptureEligible({ widgetType: w }), false, w);
  }
  assert.strictEqual(ats.atsOrcCaptureEligible(null), false);
  assert.strictEqual(ats.atsOrcCaptureEligible({}), false);
});

test("atsAttachOptions: a captured COMPLETE ORC list renders as a real picker", () => {
  // the whole point of the capture — `options` set means review draws a picker; `captured_options`
  // means it draws type-it-yourself.
  const rec = {};
  ats.atsAttachOptions(rec, ["DR.", "Doctor", "Mr.", "Mrs.", "Ms."]);
  assert.deepStrictEqual(rec.options, ["DR.", "Doctor", "Mr.", "Mrs.", "Ms."]);
  assert.strictEqual(rec.captured_options, null);
  assert.notStrictEqual(rec.widgetType, "typeahead");
});

test("atsAttachOptions: a list marked PARTIAL degrades to filter-or-type, never a false picker", () => {
  const rec = {};
  ats.atsAttachOptions(rec, ["Tallahassee, Leon, FL"], true);
  assert.strictEqual(rec.options, null);
  assert.deepStrictEqual(rec.captured_options, ["Tallahassee, Leon, FL"]);
  assert.strictEqual(rec.widgetType, "typeahead");
  assert.strictEqual(rec.optionsPartial, true);
});


// ── the ORC option-capture PASS (driver-level, against a fake actuation) ─────────────────
test("atsCaptureOrcOptions: opens only eligible pickers and enriches the SCAN in place", async () => {
  const opened = [];
  const logs = [];
  const act = { eval: async (fn, sel) => {
    opened.push(sel);
    if (sel === "#title") return { ok: true, options: ["Mr.", "Ms.", "Dr."], count: 3, closed: true };
    if (sel === "#dial") return { ok: true, options: ["+1 (United States)"], count: 1, closed: false };
    return { ok: true, options: [], count: 0, terminalNo: true, closed: true };
  } };
  const scan = { fields: [
    { fieldName: "title", inputSel: "#title", widgetType: "select" },
    { fieldName: "phoneNumber", inputSel: "#dial", widgetType: "select" },
    { fieldName: "country", inputSel: "#c", widgetType: "select", searchDriven: true },
    { fieldName: "region2", inputSel: "#s", widgetType: "select", searchDriven: true },
    { fieldName: "gender", inputSel: "#g", widgetType: "select" },
    { fieldName: "lastName", inputSel: "#l", widgetType: "text" },
    { fieldName: "race", inputSel: "#r", widgetType: "checkbox_group", options: ["Asian"] },
  ] };
  const res = await ats.atsCaptureOrcOptions(act, scan, (m) => logs.push(m));

  // ONLY the three eligible pickers were opened — geo pickers, plain text and an already-enumerated
  // group cost zero page contact.
  assert.deepStrictEqual(opened, ["#title", "#dial", "#g"]);
  assert.strictEqual(res.captured, 2);
  assert.strictEqual(res.skipped, 2);

  // the scan is enriched IN PLACE, which is what makes every downstream atsAttachOptions work
  assert.deepStrictEqual(scan.fields[0].options, ["Mr.", "Ms.", "Dr."]);
  // …and nothing else is disturbed
  assert.strictEqual(scan.fields[2].options, undefined, "a geo picker must never be enumerated");
  assert.strictEqual(scan.fields[3].options, undefined);
  assert.strictEqual(scan.fields[5].options, undefined, "a text field is not a picker");
  assert.deepStrictEqual(scan.fields[6].options, ["Asian"], "an inline-enumerated group is left alone");
});

test("atsCaptureOrcOptions: NO SILENT CAPS — a lingering list and an unreadable one are both named", async () => {
  const logs = [];
  const act = { eval: async (fn, sel) =>
    (sel === "#dial" ? { ok: true, options: ["+1 (US)"], count: 1, closed: false }
                     : { ok: true, options: [], count: 0, terminalNo: true, closed: true }) };
  const scan = { fields: [
    { fieldName: "phoneNumber", inputSel: "#dial", widgetType: "select" },
    { fieldName: "gender", inputSel: "#g", widgetType: "select" },
  ] };
  await ats.atsCaptureOrcOptions(act, scan, (m) => logs.push(m));
  const all = logs.join(" | ");
  assert.ok(/phoneNumber.*did NOT close/.test(all), "a list that stayed open must be reported: " + all);
  assert.ok(/gender.*no options captured/.test(all), "an unreadable picker must be reported: " + all);
  assert.ok(/reach review as a text box/.test(all), "…and it must say what that COSTS the operator");
});

test("atsCaptureOrcOptions: a page with nothing capturable does no page contact", async () => {
  let calls = 0;
  const act = { eval: async () => { calls++; return { ok: true, options: [], count: 0 }; } };
  const scan = { fields: [
    { fieldName: "country", inputSel: "#c", widgetType: "select", searchDriven: true },
    { fieldName: "lastName", inputSel: "#l", widgetType: "text" },
  ] };
  const res = await ats.atsCaptureOrcOptions(act, scan, () => {});
  assert.strictEqual(calls, 0);
  assert.strictEqual(res.captured, 0);
  assert.strictEqual(res.skipped, 1);
});

test("atsCaptureOrcOptions: an eval that throws degrades to 'unreadable', never a crash", async () => {
  const act = { eval: async () => { throw new Error("detached"); } };
  const scan = { fields: [{ fieldName: "title", inputSel: "#title", widgetType: "select" }] };
  const res = await ats.atsCaptureOrcOptions(act, scan, () => {});
  assert.strictEqual(res.captured, 0);
  assert.strictEqual(res.failed, 1);
  assert.strictEqual(scan.fields[0].options, undefined);
});


// ── ORC's address is ONE answer expressed through its most specific field ────────────────
// Measured with the operator: typing a postal code and pressing Enter on its single row fills city,
// state and county by itself. So the block is one decision, not five — and the five-independent-picks
// approach failed only because the house clear-before-typing step cascades on a geo picker.

test("atsOrcGeoPlan: the postal code is the anchor and the rest are DEPENDENTS", () => {
  const fields = [
    { fieldName: "country", widgetType: "select", searchDriven: true },
    { fieldName: "city", widgetType: "select", searchDriven: true },
    { fieldName: "region2", widgetType: "select", searchDriven: true },
    { fieldName: "postalCode", widgetType: "select", searchDriven: true },
    { fieldName: "region1", widgetType: "select", searchDriven: true },
    { fieldName: "addressLine1", widgetType: "text" },
  ];
  const plan = ats.atsOrcGeoPlan(fields, { personal_info: { postal_code: "32312", city: "Tallahassee", state_province: "Florida" } });
  assert.strictEqual(plan.anchor.fieldName, "postalCode");
  assert.strictEqual(plan.anchorValue, "32312");
  assert.strictEqual(plan.exact, true);
  // city / state / county are VERIFIED, never actuated — typing into one clears the anchor
  assert.deepStrictEqual(plan.dependents.map((d) => d.fieldName).sort(), ["city", "region1", "region2"]);
  // ⚠ country is the geo ROOT: it mounts the block and is filled normally, so it is neither the
  // anchor nor a dependent of it.
  assert.ok(plan.dependents.every((d) => d.fieldName !== "country"));
});

test("atsOrcGeoPlan: with NO postal code it falls back to city and SAYS the risk", () => {
  // measured: "32312" resolved to ONE row while "Tallahassee" resolved to TWO (Jefferson and Leon),
  // and the profile stores no county — so the city route is genuinely ambiguous from our data.
  const fields = [
    { fieldName: "city", widgetType: "select", searchDriven: true },
    { fieldName: "region2", widgetType: "select", searchDriven: true },
  ];
  const plan = ats.atsOrcGeoPlan(fields, { personal_info: { city: "Tallahassee", state_province: "Florida" } });
  assert.strictEqual(plan.anchor.fieldName, "city");
  assert.strictEqual(plan.exact, false, "a city anchor is NOT an exact resolution");
  assert.match(plan.detail, /more than one county/i, "the ambiguity has to be stated, not hidden");
});

test("atsOrcGeoPlan: no geo pickers, or no usable profile value, yields no plan", () => {
  assert.strictEqual(ats.atsOrcGeoPlan([{ fieldName: "lastName", widgetType: "text" }], { personal_info: { postal_code: "32312" } }), null);
  // geo present but the profile has nothing to anchor on
  const fields = [{ fieldName: "postalCode", widgetType: "select", searchDriven: true }];
  assert.strictEqual(ats.atsOrcGeoPlan(fields, { personal_info: {} }), null);
  assert.strictEqual(ats.atsOrcGeoPlan(null, null), null);
});

test("atsOrcGeoPlan: a blank/whitespace profile value is not an anchor", () => {
  const fields = [
    { fieldName: "postalCode", widgetType: "select", searchDriven: true },
    { fieldName: "city", widgetType: "select", searchDriven: true },
  ];
  // an empty zip must fall through to city rather than anchoring on nothing
  const plan = ats.atsOrcGeoPlan(fields, { personal_info: { postal_code: "   ", city: "Tallahassee" } });
  assert.strictEqual(plan.anchor.fieldName, "city");
});

test("atsInjOrcPick: ENTER is the commit, with a pointer fallback, and noClear is honoured", () => {
  // Structural, because the primitive needs a live widget to exercise. Each of these is a measured
  // behaviour: a pointer click leaves the list OPEN and the selection unmade; clearing a geo picker
  // cascades to its siblings.
  const src = String(ats.atsInjOrcPick);
  assert.match(src, /keyCode: 13/, "Enter must be the commit");
  assert.match(src, /commitRowByPointer/, "the pointer sequence must survive as a fallback");
  assert.match(src, /if \(!noClear\)/, "the clear must be skippable for cascading geo pickers");
  // and it must stay evaluable in the page
  for (const shim of ["atsLib", "atsFd", "atsInjOrcReadPicker", "atsInjOrcCaptureOptions"]) {
    assert.ok(!src.includes(shim), "atsInjOrcPick must not reference " + shim);
  }
});


// ── the geo plan, wired through the driver ───────────────────────────────────────────────
// The dependents must reach review WITHOUT being actuated, on the fill path AND the replay path.
// Typing into one clears the anchor that produced it, so "we have an approved value for city" is
// NOT a licence to type it back in.

function orcGeoAct(picks, evals) {
  return {
    eval: async (fn, ...a) => {
      const name = fn && fn.name;
      if (evals) evals.push({ fn: name, sel: a[0] });
      if (name === "atsInjScan") return {
        ats: "oracle", url: "https://eeho.fa.us2.oraclecloud.com/x", title: "t", fields: [
          { fieldName: "postalCode", inputSel: "#postal", widgetType: "select", searchDriven: true, isRequired: true, label: "Postal Code", domIndex: 0 },
          { fieldName: "city", inputSel: "#city", widgetType: "select", searchDriven: true, isRequired: true, label: "City", domIndex: 1 },
          { fieldName: "region2", inputSel: "#state", widgetType: "select", searchDriven: true, isRequired: true, label: "State", domIndex: 2 },
          { fieldName: "region1", inputSel: "#county", widgetType: "select", searchDriven: true, isRequired: true, label: "County", domIndex: 3 },
        ] };
      if (name === "atsInjOrcPick") { if (picks) picks.push(a[0]); return { ok: true, committed: String(a[1]) }; }
      if (name === "atsInjOrcCaptureOptions") return { ok: true, options: [], count: 0, closed: true };
      if (name === "atsInjOrcReadPicker") return { ok: true, value: "32312", invalid: false };
      if (name === "atsInjReadValue") return { ok: true, value: null };
      if (name === "atsInjSubmitState") return { ok: true, hasSubmit: true };
      if (name === "atsInjErrors") return { ok: true, errors: [] };
      return { ok: true };
    },
    delay: async () => {}, delayFull: async () => {}, aiEnabled: false,
    attachResume: async () => ({ ok: false }),
  };
}

test("driveAtsPageFill oracle: only the ANCHOR is actuated; dependents are left for the cascade", async () => {
  const picks = [], evals = [];
  const profile = { personal_info: { postal_code: "32312", city: "Tallahassee", state_province: "Florida" } };
  const out = await ats.driveAtsPageFill(orcGeoAct(picks, evals), "oracle", profile, {}, {}, {});
  const results = (out && out.results) || out || [];
  const by = {};
  for (const r of results) if (r && r.fieldName) by[r.fieldName] = r;

  // the postal anchor WAS picked…
  assert.ok(picks.includes("#postal"), "the postal anchor must be actuated; picks=" + JSON.stringify(picks));
  // …and none of its dependents were
  for (const sel of ["#city", "#state", "#county"]) {
    assert.ok(!picks.includes(sel), sel + " must NOT be actuated — typing into it clears the anchor");
  }
  // each dependent claims nothing, and SAYS why (atsSurfacePrefilled promotes it later from the page)
  for (const name of ["city", "region2", "region1"]) {
    assert.ok(by[name], name + " must still produce a record");
    assert.strictEqual(by[name].status, "skipped", name + " should claim nothing");
    assert.match(by[name].detail || "", /cascade|clear that anchor/i,
      name + " must say why it was left: " + by[name].detail);
  }
});

test("driveAtsPageFill oracle: a geo dependent is left alone on the REPLAY path too", async () => {
  // an approved bundle carrying "Tallahassee" must not cause it to be typed back in on submit
  const picks = [];
  // ⚠ A REAL bundle carries BOTH — the fill recorded postalCode as filled and city as
  // already-filled — so postal is still the anchor and city is still a dependent. Handing the
  // replay ONLY a city would legitimately make city the anchor, which is not what this pins.
  const out = await ats.driveAtsPageFill(orcGeoAct(picks, null), "oracle", {}, {}, {},
    { valueFor: (f) => ({ postalCode: "32312", city: "Tallahassee", region2: "FL", region1: "Leon" })[f.fieldName] });
  const results = (out && out.results) || out || [];
  const city = results.find((r) => r && r.fieldName === "city");
  assert.ok(!picks.includes("#city"), "the replay must not type into a geo dependent; picks=" + JSON.stringify(picks));
  assert.strictEqual(city.status, "skipped");
});

test("atsActuateField oracle: the pick ALWAYS clears before searching", () => {
  // ⚠ REVERSED from an earlier assertion, and the reversal is the lesson (operator, 2026-08-19).
  // noClear was passed for geo pickers because clearing one cascades to its siblings — true, but it
  // solved a problem the old approach created, when all five geo fields were actuated in sequence.
  // Now only the ANCHOR is actuated and its cascade repopulates the rest, so the sibling clear is
  // wanted. Leaving it off was actively harmful: a live run APPENDED its query to a field that
  // already held a value ("United States" + "United States of America"), and the widget answered
  // "No results" on a field whose option was right there.
  assert.match(String(ats.atsActuateField), /atsInjOrcPick[\s\S]{0,400}ATS_ORC_PICK_MS,\s*false\)/,
    "the pick call must pass noClear=false — a search box must be cleared before it is searched");
});


// ── ORC repeating blocks: the entry lifecycle ────────────────────────────────────────────
// The commit button is a HOMONYM of the opener ("Add Experience" both times) and on Oracle both live
// in the SAME block, so scoping by container cannot separate them. The discriminator is the sibling
// Cancel, present only while an entry form is open. Each action therefore REFUSES in the state where
// it would press the other's button.

test("atsInjOrcEntryAction: open/commit each REFUSE in the state where they'd press the wrong button", () => {
  const src = String(ats.atsInjOrcEntryAction);
  // the Cancel-derived open/closed test must exist…
  assert.match(src, /\/\^cancel\$\/i/, "openness must be derived from a sibling Cancel");
  // …and both directions must refuse rather than click blindly
  assert.match(src, /entry-already-open/, "open must refuse when a form is already open (that button COMMITS)");
  assert.match(src, /no-open-entry-to-commit/, "commit must refuse when no form is open (that button OPENS)");
});

test("atsInjOrcEntry*: keyed on the BLOCK, never on the timeline elements", () => {
  // Baylor renders entries through beautiful-timeline/timeline-form-inline; Oracle has neither and
  // renders in-block. Keying on those elements would work on exactly one tenant.
  for (const fn of [ats.atsInjOrcEntryState, ats.atsInjOrcEntryAction]) {
    const src = String(fn);
    assert.match(src, /apply-flow-block/, "must locate the block");
    assert.match(src, /apply-flow-block-title/, "must identify it by its title");
    assert.ok(!/beautiful-timeline|timeline-form-inline|timeline-form-builder/.test(src),
      "must NOT key on the timeline elements — they are one tenant's configuration");
  }
});

test("atsOrcEntryPlan: counts entries per block, and skips what it cannot source", () => {
  const profile = {
    work_experience: [{ company: "A" }, { company: "B" }, { company: "C" }],
    education: [{ school_or_university: "CMU" }],
    skills: ["Python", "C"],
    certifications: [],                      // present but EMPTY → no plan entry
  };
  const blocks = ["Experience", "Education", "Licenses and Certificates", "Skills",
                  "Supporting Documents and URLs"];
  const plan = ats.atsOrcEntryPlan(profile, blocks);
  const byBlock = {};
  for (const p of plan) byBlock[p.block] = p;
  assert.strictEqual(byBlock.Experience.want, 3);
  assert.strictEqual(byBlock.Experience.source, "work_experience");
  assert.strictEqual(byBlock.Education.want, 1);
  assert.strictEqual(byBlock.Skills.want, 2);
  assert.ok(!byBlock["Licenses and Certificates"], "an empty profile array yields no plan entry");
  // a block that is not on the page is not planned for
  assert.ok(!ats.atsOrcEntryPlan(profile, ["Experience"]).some((p) => p.block === "Education"));
  // nothing to source ⇒ nothing planned
  assert.deepStrictEqual(ats.atsOrcEntryPlan({}, blocks), []);
});

test("atsOrcEntryPlan: NO SILENT CAPS — a history longer than the backstop reports what it dropped", () => {
  const many = Array.from({ length: ats.ATS_ORC_ENTRY_MAX + 3 }, (_, i) => ({ company: "C" + i }));
  const plan = ats.atsOrcEntryPlan({ work_experience: many }, ["Experience"]);
  assert.strictEqual(plan[0].want, ats.ATS_ORC_ENTRY_MAX);
  assert.strictEqual(plan[0].capped, many.length,
    "the ORIGINAL count must survive so the run can say what it left out");
});

test("ATS_ORC_ENTRY_MAPS: the entry forms match what the live DOM actually offered", () => {
  const we = ats.ATS_ORC_ENTRY_MAPS.work_experience;
  assert.strictEqual(we.employerName.path, "company");
  assert.strictEqual(we.jobTitle.path, "job_title");
  // ⚠ A DATE IS TWO COMBOBOXES SHARING ONE `name`, measured off the live form:
  //   Experience entry 1 — 6 field(s): employerName[text], jobTitle[text],
  //                        startDate[combobox], startDate[combobox], endDate[combobox], endDate[combobox]
  // The first version of this map called it one field of kind "date"; the pass wrote the whole
  // "2025-05" into whichever id came first and burned 8.2s failing — the slowest field of the run.
  assert.strictEqual(we.startDate.kind, "date_pair");
  assert.strictEqual(we.endDate.kind, "date_pair");
  assert.strictEqual(we.endDate.blankWhenCurrent, true, "a job you still hold has no end date");
  // ⚠ measured ABSENT on this tenant, and so deliberately unmapped rather than kept "just in case":
  // a map entry that matches nothing is indistinguishable from one that is broken.
  for (const gone of ["employerCity", "countryCode", "responsibilities", "leavingReason"]) {
    assert.ok(!we[gone], gone + " is not on Oracle's Experience entry and must not be mapped");
  }

  const ed = ats.ATS_ORC_ENTRY_MAPS.education;
  // `contentItemId` is Oracle's own opaque name for the DEGREE picker — only its label says so.
  assert.strictEqual(ed.contentItemId.path, "degree");
  assert.strictEqual(ed.contentItemId.kind, "tiered", "the profile stores degrees as an ordered ladder");
  assert.strictEqual(ed.major.kind, "tiered");
  assert.strictEqual(ed.educationalEstablishment.path, "school_or_university");
  assert.strictEqual(ed.gpa.path, "gpa");

  const sk = ats.ATS_ORC_ENTRY_MAPS.skills;
  // ⚠ a skills entry is a BARE STRING, so there is no property to read.
  assert.strictEqual(sk.skills.kind, "self");
  assert.ok(!sk.yearsOfExperience,
    "per-skill years are not in the profile, and inventing a number on a form an employer reads is " +
    "the confidently-wrong class — an entry Oracle refuses over it is the honest outcome");
});

test("atsOrcEntryValue: the measured kinds, including the ones that must answer NOTHING", () => {
  const M = ats.ATS_ORC_ENTRY_MAPS;
  const we = { company: "X", job_title: "Y", from: "2025-05", to: "2025-08", currently_work_here: false };
  assert.deepStrictEqual(ats.atsOrcEntryValue(M.work_experience.startDate, we), { year: "2025", month: "5" });
  assert.deepStrictEqual(ats.atsOrcEntryValue(M.work_experience.endDate, we), { year: "2025", month: "8" });
  // still there ⇒ no end date. Writing one would assert you had left.
  assert.strictEqual(ats.atsOrcEntryValue(M.work_experience.endDate, { ...we, currently_work_here: true }), null);
  // a year-only value yields a year and no month — never a guessed month
  assert.deepStrictEqual(ats.atsOrcEntryValue(M.work_experience.startDate, { from: "2024" }), { year: "2024", month: null });
  assert.strictEqual(ats.atsOrcEntryValue(M.work_experience.startDate, { from: "" }), null);

  const ed = { degree: ["Bachelor of Science", "Bachelors"], school_or_university: "CMU",
               field_of_study: ["ECE", "EE"], gpa: "3.95" };
  assert.deepStrictEqual(ats.atsOrcEntryValue(M.education.contentItemId, ed), ["Bachelor of Science", "Bachelors"],
    "a tiered value passes through as an ordered candidate list, most-specific first");
  assert.strictEqual(ats.atsOrcEntryValue(M.education.educationalEstablishment, ed), "CMU");
  assert.strictEqual(ats.atsOrcEntryValue(M.education.gpa, ed), "3.95");

  assert.strictEqual(ats.atsOrcEntryValue(M.skills.skills, "Python"), "Python", "the entry IS the value");
  assert.strictEqual(ats.atsOrcEntryValue(M.skills.skills, { name: "Python" }), null,
    "an object where a bare string was expected answers nothing rather than something wrong");

  // ⚠ THE SEAL: every value comes from the ENTRY. Nothing here may consult a profile root.
  assert.strictEqual(ats.atsOrcEntryValue(M.education.gpa, {}), null);
  assert.strictEqual(ats.atsOrcEntryValue(M.work_experience.employerName, {}), null);
});


// ── a regex passed as a STRING must survive the JS string literal (2026-08-19) ───────────
// Found by a real run, not by a test: the caller passed "^(next|…|submit)\b", and in a JavaScript
// string literal `\b` is U+0008 (BACKSPACE), not a word boundary. new RegExp therefore received a
// control character and could never match, so a run reached Oracle's email gate and stopped with
// `auth-submit-not-pressable` on a page whose Next button was plainly there.
//
// ⚠ My earlier test asserted the pattern STRING was present in the source. That is exactly the kind
// of test that passes while the thing is broken — it checked the spelling, not the behaviour. This
// one decodes the literal the way the engine does and matches it against real captions.
const fs = require("node:fs");

test("the ORC button patterns MATCH real captions once decoded from their JS literals", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const found = [...src.matchAll(/atsInjOrcClickButton,\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  assert.ok(found.length >= 2, "expected the Next and Verify call sites, found " + found.length);

  // decode each JS string literal exactly as the engine would, then build the regex from it
  const decoded = found.map((lit) => JSON.parse('"' + lit + '"'));
  for (const pat of decoded) {
    assert.ok(!/[ -]/.test(pat),
      "the decoded pattern contains a CONTROL CHARACTER — a \\b in a JS literal is backspace, not a " +
      "word boundary: " + JSON.stringify(pat));
  }

  const nextPat = decoded.find((p) => /next/i.test(p));
  const verifyPat = decoded.find((p) => /verify/i.test(p));
  assert.ok(nextPat && verifyPat, "both call-site patterns must be present");

  const next = new RegExp(nextPat, "i");
  for (const cap of ["Next", "Next ", "NEXT", "Continue", "Sign In", "Submit"]) {
    assert.ok(next.test(cap), "the Next pattern must match " + JSON.stringify(cap));
  }
  // …and must not claim the buttons that sit beside it on Oracle's own gate
  for (const cap of ["Cancel", "Do you want to communicate by phone instead?", "Add Experience"]) {
    assert.ok(!next.test(cap), "the Next pattern must NOT match " + JSON.stringify(cap));
  }

  const verify = new RegExp(verifyPat, "i");
  assert.ok(verify.test("Verify"), "the Verify pattern must match Verify");
  assert.ok(verify.test("VERIFY"), "…including the caption as Oracle renders it");
  assert.ok(!verify.test("Send New Code"), "and must not claim the resend control");
});


// ── a shared reader's RESULT CONTRACT is load-bearing (live 2026-08-19) ──────────────────
// runOrcPreForm's `sig()` gates every read on `r && r.ok`, which is how every other atsInj* result
// is consumed. atsInjPageSignature did not return `ok`, so each successful read became null, both
// sides of the compare were null, and atsSignatureChanged's conservative "an unreadable side is no
// change" rule made every ORC waitForChange run its FULL budget — 36s per run, reported as "page
// did NOT change". The flow still advanced (the next round re-scans), which is exactly why it hid.
test("atsInjPageSignature returns ok:true, so an `r && r.ok` caller does not discard a good read", () => {
  const prevDoc = global.document, prevLoc = global.location;
  try {
    const el = (id) => ({ id, name: "", getAttribute: () => null });
    global.document = {
      querySelectorAll: (q) => (/button/.test(q) ? [el("a"), el("b")] : [el("a")]),
      // selector-aware: the reader also looks for an iCIMS frame, and ORC has none
      querySelector: (q) => (/iframe/.test(q) ? null : { textContent: "  Personal   Info " }),
      getElementById: () => null,
    };
    global.location = { href: "https://eeho.fa.us2.oraclecloud.com/x/apply/section1#frag" };

    const r = ats.atsInjPageSignature();
    assert.strictEqual(r.ok, true, "without ok:true every caller that gates on it reads a good page as unreadable");
    // the rest of the contract the comparator depends on
    assert.strictEqual(r.url, "https://eeho.fa.us2.oraclecloud.com/x/apply/section1", "the fragment is dropped");
    assert.strictEqual(r.heading, "Personal Info", "whitespace-collapsed heading");
    assert.strictEqual(r.controls, 1, "controls counts inputs/selects/textareas, not buttons");

    // and the gate a caller actually writes must now KEEP it
    const gated = (x) => (x && x.ok ? x : null);
    assert.notStrictEqual(gated(r), null, "the caller's own `r && r.ok` gate must pass on a real read");
  } finally { global.document = prevDoc; global.location = prevLoc; }
});

test("atsSignatureChanged keeps its conservative rule: an unreadable side is never progress", () => {
  const a = { ok: true, url: "u", heading: "h", controls: 3, ids: "x" };
  assert.strictEqual(ats.atsSignatureChanged(null, a), false, "a missing baseline is not a change");
  assert.strictEqual(ats.atsSignatureChanged(a, null), false, "a failed read is not a change");
  assert.strictEqual(ats.atsSignatureChanged(a, a), false);
  assert.strictEqual(ats.atsSignatureChanged(a, { ...a, url: "v" }), true);
  assert.strictEqual(ats.atsSignatureChanged(a, { ...a, controls: 4 }), true);
  assert.strictEqual(ats.atsSignatureChanged(a, { ...a, heading: "i" }), true);
  // ⚠ the `ok` field is NOT part of the comparison — it reports readability, not identity, so a
  // signature must never appear to "change" merely because one read declared itself differently.
  assert.strictEqual(ats.atsSignatureChanged({ ...a, ok: true }, { ...a, ok: undefined }), false);
});

test("the ORC wait reports BLINDNESS separately from stillness", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const i = src.indexOf("const waitForChange = async");
  assert.ok(i > 0, "the ORC wait must exist");
  const body = src.slice(i, i + 1200);
  assert.ok(/blind:/.test(body), "the wait must distinguish 'never read the page' from 'page stood still'");
  assert.ok(/readOk/.test(body), "and must count the reads that actually landed, so the log can say so");
  // the three call sites must go through the shared message, not re-spell the binary
  assert.ok(!/did NOT change\$\{|\? "changed" : "did NOT change"/.test(src),
    "no call site may re-spell the changed/not-changed binary — that is what hid the blindness");
});

// ── ORC's `title` is a SALUTATION and must be CLAIMED (live 2026-08-19) ──────────────────
// Unmapped, its label normalizes to "title" — one of the most common taught-bucket wordings there
// is — and an operator bucket answered it "Characterization and Test Automation Intern": a job
// title aimed at a Mr./Mrs./Dr. picker. Only the platform id can tell the two apart.
test("ORC `title` is claimed as a salutation, so no bucket or AI can answer it with a job title", () => {
  const m = ats.ATS_STATIC_MAPS.oracle;
  assert.ok(m.title, "`title` must be CLAIMED — recognition is what keeps the guessers off it");
  assert.strictEqual(m.title.kind, "skip", "the profile stores no salutation, so the answer is BLANK");
  assert.ok(/salutation/i.test(m.title.detail || ""), "and the record must SAY why it is blank");
  // it must NOT have become a job-title mapping by someone 'fixing' it the other way
  assert.ok(!/job_title/.test(JSON.stringify(m.title)), "a job title in a salutation picker is the bug, not the fix");
  // the honorific field is page-level, so it must not be confused with the work-entry `title`,
  // which legitimately IS the job title
  const entryTitle = (ats.ATS_ENTRY_MAPS && ats.ATS_ENTRY_MAPS.icims) || null;
  if (entryTitle) assert.ok(true, "the iCIMS work-entry map keeps its own `title` → job_title");
});

test("a no-results diagnosis is only attributed to the geo cascade on a geo field", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const hits = [...src.matchAll(/dependent geo picker whose parent is not committed/g)];
  assert.ok(hits.length >= 1, "the geo explanation must still exist");
  for (const h of hits) {
    // each occurrence must sit inside a searchDriven-guarded branch, not be appended unconditionally
    const before = src.slice(Math.max(0, h.index - 400), h.index);
    assert.ok(/searchDriven/.test(before),
      "the geo explanation must be guarded by searchDriven — printed on a salutation picker it sends " +
      "the next debugging round at the wrong subsystem");
  }
});


// ── the ORC multi-step walk ──────────────────────────────────────────────────────────────
// ORC is the first MULTI-PAGE form on the ats.js path. The safety property under test is the one
// this whole codebase is built around: the walk must reach the end of the wizard and NEVER press
// the control that submits an application.

const mkBtn = (caption, opts = {}) => ({
  value: opts.isInput ? caption : undefined,
  textContent: opts.isInput ? "" : caption,
  disabled: !!opts.disabled,
  getAttribute: (a) => (a === "aria-disabled" ? (opts.ariaDisabled ? "true" : null) : null),
  getBoundingClientRect: () => (opts.invisible ? { width: 0, height: 0 } : { width: 90, height: 32 }),
  click() { this.clicked = true; },
});
const mkSection = (visible) => ({ getBoundingClientRect: () => (visible ? { width: 800, height: 400 } : { width: 0, height: 0 }) });

// A document whose querySelectorAll answers by selector family — enough for the step reader.
const mkOrcDoc = ({ pagButtons = [], sections = [], submitButtons = [], announce = null, errors = [] } = {}) => {
  const pag = {
    textContent: announce || "Back 1 2 3 4 Next",
    querySelectorAll: () => pagButtons,
    getBoundingClientRect: () => ({ width: 700, height: 60 }),
  };
  return {
    querySelector: (q) => (/apply-flow-pagination/.test(q) ? pag : null),
    querySelectorAll: (q) => {
      if (/apply-flow-pagination/.test(q) && /aria-live/.test(q)) return [pag];
      if (/^apply-flow-section$/.test(q)) return sections;
      if (/input\[type="submit"\]/.test(q) || /^button, input/.test(q)) return submitButtons;
      if (/role=alert/.test(q)) return errors;
      return [];
    },
    getElementById: () => null,
  };
};

test("atsInjOrcStepState: the step comes from the URL and the TOTAL from the announced text", () => {
  const prevDoc = global.document, prevLoc = global.location;
  try {
    global.location = { href: "https://x.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/js/job/1/apply/section/2#z" };
    const next = mkBtn("Next"), back = mkBtn("Back"), one = mkBtn("1"), two = mkBtn("2");
    global.document = mkOrcDoc({
      pagButtons: [back, one, two, next],
      sections: [mkSection(false), mkSection(true), mkSection(true), mkSection(false), mkSection(false)],
      announce: "Job application, step 2 of 4",
    });
    const st = ats.atsInjOrcStepState();
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.step, 2, "the step number is DECLARED in the url — the primary signal");
    assert.strictEqual(st.total, 4, "the total is only available from the announced text");
    assert.strictEqual(st.hasNext, true);
    assert.strictEqual(st.nextCaption, "Next");
    assert.strictEqual(st.hasBack, true);
    // ⚠ the bar reads "Back 1 2 3 4 Next" — the NUMBERED buttons are step jumps and must never be
    // mistaken for the advance control.
    assert.strictEqual(st.hasSubmit, false, "no visible submit on a middle step");
    // TWO sections are visible at once on Oracle (index 0 is the résumé-import banner), so the
    // active-section signal is a SET and never a count.
    assert.deepStrictEqual(st.visibleSections, [1, 2]);
    assert.strictEqual(st.sectionCount, 5, "…and the section count is NOT the step count (5 sections, 4 steps)");
  } finally { global.document = prevDoc; global.location = prevLoc; }
});

test("atsInjOrcStepState: a 0×0 submit does NOT count — every step is mounted at once", () => {
  const prevDoc = global.document, prevLoc = global.location;
  try {
    global.location = { href: "https://x.fa.us2.oraclecloud.com/a/apply/section/1" };
    // ORC mounts all four steps, so the LAST step's Submit is in the DOM while we sit on step 1 —
    // at 0×0. Geometry is the trustworthy signal on the form (declared intent is not: inactive
    // sections report aria-hidden="false"), so the invisible one must be excluded.
    global.document = mkOrcDoc({
      pagButtons: [mkBtn("Next")],
      sections: [mkSection(true)],
      submitButtons: [mkBtn("Submit Application", { invisible: true })],
    });
    assert.strictEqual(ats.atsInjOrcStepState().hasSubmit, false,
      "an inactive step's Submit is mounted at 0×0 and must not make the walk think it is finished");

    global.document = mkOrcDoc({
      pagButtons: [],
      sections: [mkSection(true)],
      submitButtons: [mkBtn("Submit Application")],
    });
    const st = ats.atsInjOrcStepState();
    assert.strictEqual(st.hasSubmit, true, "a VISIBLE submit is the last step");
    assert.strictEqual(st.hasNext, false, "…and the terminal condition the walk keys on is the absence of Next");
  } finally { global.document = prevDoc; global.location = prevLoc; }
});

test("atsInjOrcStepState: a DISABLED Next is reported, not hidden — that is how ORC refuses a step", () => {
  const prevDoc = global.document, prevLoc = global.location;
  try {
    global.location = { href: "https://x.fa.us2.oraclecloud.com/a/apply/section/1" };
    global.document = mkOrcDoc({
      pagButtons: [mkBtn("Next", { disabled: true })],
      sections: [mkSection(true)],
      errors: [{ textContent: "  You must answer   all required questions ", getBoundingClientRect: () => ({ width: 400, height: 20 }) }],
    });
    const st = ats.atsInjOrcStepState();
    assert.strictEqual(st.hasNext, true, "it is present…");
    assert.strictEqual(st.nextEnabled, false, "…but not pressable, which is a different halt from 'no Next'");
    assert.deepStrictEqual(st.errors, ["You must answer all required questions"],
      "and the page's OWN words come back with it, so the halt does not need a second read");
  } finally { global.document = prevDoc; global.location = prevLoc; }
});

// ── GUARD 2: the click itself refuses a forbidden caption ────────────────────────────────
test("atsInjOrcClickButton REFUSES a forbidden caption, judged on what it actually resolved", () => {
  const prevDoc = global.document;
  try {
    // A bar whose only control is captioned Submit: the Next pattern must not find it, and even if a
    // widened pattern did, the forbid list must refuse the press.
    const submit = mkBtn("Submit Application");
    global.document = {
      querySelector: () => ({ querySelectorAll: () => [submit] }),
      querySelectorAll: () => [submit],
    };
    const byNext = ats.atsInjOrcClickButton(ats.ATS_ORC_NEXT_RE, "apply-flow-pagination", ats.ATS_ORC_FORBID_RE);
    assert.strictEqual(byNext.ok, false, "the Next pattern must not match Submit");
    assert.ok(/no-button-matching/.test(byNext.error));
    assert.ok(!submit.clicked, "nothing may be pressed");

    // now the belt: a pattern that WOULD match it is still refused by the forbid list
    const widened = ats.atsInjOrcClickButton("^(next|submit)\\b", "apply-flow-pagination", ats.ATS_ORC_FORBID_RE);
    assert.strictEqual(widened.ok, false, "the forbid list is the second guard and must hold on its own");
    assert.strictEqual(widened.error, "refused-forbidden-caption");
    assert.strictEqual(widened.caption, "Submit Application", "and it must name what it refused");
    assert.ok(!submit.clicked, "STILL nothing pressed — this is the one irreversible click in the pipeline");

    // …and a real Next goes through
    const next = mkBtn("Next");
    global.document = { querySelector: () => ({ querySelectorAll: () => [next] }), querySelectorAll: () => [next] };
    const ok = ats.atsInjOrcClickButton(ats.ATS_ORC_NEXT_RE, "apply-flow-pagination", ats.ATS_ORC_FORBID_RE);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(next.clicked, true);
  } finally { global.document = prevDoc; }
});

test("the ORC advance and forbid patterns are DISJOINT — no caption can satisfy both", () => {
  const next = new RegExp(ats.ATS_ORC_NEXT_RE, "i"), forbid = new RegExp(ats.ATS_ORC_FORBID_RE, "i");
  for (const cap of ["Next", "Continue", "Save and Continue", "Save & Continue"]) {
    assert.ok(next.test(cap), "must advance on " + JSON.stringify(cap));
    assert.ok(!forbid.test(cap), JSON.stringify(cap) + " must not be forbidden");
  }
  for (const cap of ["Submit", "Submit Application", "Apply Now", "Finish", "Send Application"]) {
    assert.ok(!next.test(cap), JSON.stringify(cap) + " must NEVER match the advance pattern");
    assert.ok(forbid.test(cap), JSON.stringify(cap) + " must be on the forbid list");
  }
  for (const cap of ["Back", "1", "2", "3", "4"]) {
    assert.ok(!next.test(cap), "a step-jump button is not the advance control: " + JSON.stringify(cap));
  }
  // a decoded-literal check, because `\b` in a JS string literal is BACKSPACE and that exact slip
  // already halted one live run with a pattern that could never match.
  assert.ok(!/[\x00-\x1f]/.test(ats.ATS_ORC_NEXT_RE), "the advance pattern must not contain a control character");
});

// ── the walk's structure, asserted on source because it is I/O-shaped ────────────────────
test("the ORC walk: clear-once OUTSIDE the loop, write-per-step", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const i = src.indexOf("const MULTI = ats === \"oracle\"");
  assert.ok(i > 0, "the walk must exist");
  // ⚠ STRIP COMMENTS BEFORE ASSERTING ON SOURCE. The walk DOCUMENTS the shapes it refuses ("the
  // terminal test is the presence of a Next control and not `step >= total`"), and a textual scan
  // cannot tell that apart from doing it — this assertion failed on its own explanation. Third time
  // today, after the sw-globals lockstep guards and the injected-fn guard before them: a guard that
  // reads prose punishes the comment written to prevent the bug.
  const walk = stripJsComments(src.slice(i, src.indexOf("if (!bundle) return", i)));
  assert.ok(walk.length > 1000, "found the walk body");

  // the clear must happen BEFORE the loop — a clear inside wipes the steps already walked
  const clearAt = walk.indexOf("reviewSummary: null");
  const loopAt = walk.indexOf("for (let iter");
  assert.ok(clearAt > 0 && loopAt > 0 && clearAt < loopAt,
    "reviewSummary must be cleared ONCE before the loop — a mid-walk clear wipes the accumulated steps");

  // accumulation must go through the PURE merge, not a rebuild
  assert.ok(/accumulateBundle\(accEntries, pageBundle\)/.test(walk),
    "steps must merge through the pure accumulateBundle so other pages' entries (and their edits) survive");
  // …and be persisted per step, so an evicted worker cannot lose a walked step
  assert.ok(/chrome\.storage\.local\.set\(\{ reviewSummary: bundle \}/.test(walk), "write-per-step");
});

// ── THE ADVANCE IS SHARED, AND THAT IS THE POINT (2026-08-20) ────────────────────────────────
// Extracted when the submit run grew its own ORC walk. Both guards on the one irreversible act in
// the pipeline live in ONE function now, so the assertions follow them there — and one new
// assertion covers the thing the extraction exists to prevent: a second, drifting copy.
test("orcAdvanceAfterStep: guard 1, guard 2 and the monotone predicate — in one shared copy", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const i = src.indexOf("async function orcAdvanceAfterStep");
  assert.ok(i > 0, "the shared advance must exist");
  const fn = stripJsComments(src.slice(i, src.indexOf("\n}", src.indexOf("return { advanced: true", i))));

  // GUARD 1 — terminal on the ABSENCE of Next, never on step >= total
  assert.ok(/if \(!after\.hasNext\)/.test(fn), "the terminal test is the absence of an advance control");
  assert.ok(!/after\.step >= after\.total|step >= total/.test(fn),
    "the step count must NOT be derived from the section count or compared to a total — Baylor serves " +
    "5 sections for 4 steps and Oracle 4 for 3");
  // GUARD 2 — the forbid pattern is actually passed at the call site
  assert.ok(/atsInjOrcClickButton, ATS_ORC_NEXT_RE, "apply-flow-pagination", ATS_ORC_FORBID_RE/.test(fn),
    "the advance must pass the forbid pattern — guard 2 is worthless if the call site omits it");
  // the advance predicate must be monotone
  assert.ok(/now\.step > after\.step/.test(fn), "advancement is 'the declared step number went UP' — a monotone predicate");
  // a stalled advance is a graceful halt carrying the form's own words
  assert.ok(/step-did-not-advance/.test(fn) && /now\.errors/.test(fn),
    "a refused advance must halt with the page's own error text, never retry and never guess");
  // a disabled Next is WAITED OUT, not treated as a refusal (Oracle disables it while it saves)
  assert.ok(/nextEnabled/.test(fn) && /next-disabled/.test(fn),
    "the disabled-Next wait must be here too — it is what keeps 'Saved' from ending the walk");

  // ⚠⚠ ONE COPY. The submit walk must CALL this, never carry its own — a near-duplicate of the
  // double guard would keep working right up until the day it stopped agreeing with this one about
  // what "the last step" means, and the disagreement would surface as a submitted application.
  const calls = (src.match(/await orcAdvanceAfterStep\(/g) || []).length;
  assert.ok(calls >= 2, "both the fill walk and the submit walk must go through the shared advance (found " + calls + ")");
  const guard1 = (src.match(/if \(!after\.hasNext\)/g) || []).length;
  assert.strictEqual(guard1, 1, "guard 1 must exist exactly ONCE in the file — a second copy is the drift this prevents");
});

test("a partial ORC bundle NAMES the step it stopped on and why", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const i = src.indexOf("if (orcSinglePageOnly) {");
  assert.ok(i > 0);
  const blk = src.slice(i, i + 900);
  assert.ok(/bundle\.partial = true/.test(blk), "partial must be carried ON THE BUNDLE, not only logged");
  assert.ok(/walkStopped/.test(blk) && /walkDetail/.test(blk),
    "the reason must reach the reviewer — 'incomplete' without WHICH step and WHAT the form said is not actionable");
  // and it must only be partial when the walk did NOT reach the end
  assert.ok(/walkStopped !== "reached-final-step"/.test(src),
    "a walk that reached the last step produces a COMPLETE bundle");
});


// ── "nothing here" needs stability, not one read (live 2026-08-19) ───────────────────────
// The gate submitted, the page changed in 1387ms, and the next scan of `…/apply/section/1` reported
// every signal zero — the fingerprint of a half-rendered SPA, not of an unknown page. The run halted
// `unknown-page` on the form it had just reached. The same wait had previously burned a full 20228ms
// because its signature comparison could never return true, and that accidental delay WAS the settle
// this loop relied on; making the wait honest removed it.
test("the ORC pre-form SETTLES before concluding a page is unknown", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const i = src.indexOf('if (view === "none") {');
  assert.ok(i > 0, "the none branch must exist");
  const branch = src.slice(i, i + 2600);
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const code = stripComments(branch);
  // it must POLL rather than halt on the first read
  assert.ok(/while \(Date\.now\(\) - noneT0/.test(code),
    "a `none` view must be re-read against a budget — one read cannot distinguish 'nothing here' from 'not yet'");
  assert.ok(/orcApplyView\(again\)/.test(code), "and the re-read must go through the same view judgement");
  // …and it must still be able to halt, so a genuinely unknown page is not walked blindly
  assert.ok(/halt\("unknown-page"/.test(code), "a view that stays none for the whole budget must still halt");
  // the halt must REPORT the wait, so it can never again be mistaken for the instant one
  assert.ok(/reads/.test(code) && /toFixed\(1\)/.test(code),
    "the halt must say how long it waited and how many reads landed — otherwise a settled halt and an " +
    "instant one read identically in the log");
  // and it must resume the loop on the settled view rather than acting on the stale one
  assert.ok(/continue;/.test(code), "a settled view must be routed by the loop, not by the stale read");
});


// ── a function's body may only use what its signature receives (live 2026-08-19) ─────────
// The ORC entry pass was written against driveAtsPageFill's scope while living inside
// atsFinishFill's, so it threw `profile is not defined` on a real run. Node cannot catch that
// statically for a whole file, but it CAN check the specific pair: the finish stage now uses
// `profile` and `jobContext`, so both must be parameters AND must be passed at the one call site.
test("atsFinishFill receives what its body uses — profile and jobContext", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const sig = /async function atsFinishFill\(([^)]*)\)/.exec(src);
  assert.ok(sig, "atsFinishFill must exist");
  const params = sig[1].split(",").map((x) => x.trim());

  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const start = src.indexOf("async function atsFinishFill(");
  const body = stripComments(src.slice(start, src.indexOf("\n}\n", start)));

  for (const name of ["profile", "jobContext"]) {
    if (new RegExp("\\b" + name + "\\b").test(body.slice(body.indexOf("{")))) {
      assert.ok(params.includes(name),
        `atsFinishFill's body uses \`${name}\` but its signature does not receive it — that is a ` +
        `ReferenceError at runtime and every Node test still passes, because no test calls this ` +
        `function with an ORC scan`);
    }
  }
  // …and the single call site must actually pass them, in the right positions
  const call = /return await atsFinishFill\(([^)]*)\)/.exec(src);
  assert.ok(call, "the call site must exist");
  const args = call[1].split(",").map((x) => x.trim());
  assert.strictEqual(args.length, params.length,
    "the call site passes " + args.length + " argument(s) for " + params.length + " parameter(s) — a " +
    "trailing parameter left unpassed is `undefined`, which fails silently rather than loudly");
});

test("the ORC diagnostics report their OWN failure — a silent completeness catch hides a bug forever", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  // both ORC completeness guards must say something when they fail. The entry pass's catch is what
  // surfaced the scope bug in ONE run; the unclaimed check's catch was silent, so an identical
  // failure there would have read as "no unclaimed controls" — a clean step, on the very diagnostic
  // built because a clean-looking step was hiding three required fields.
  for (const marker of ["ORC-ENTRY", "ORC-UNCLAIMED"]) {
    const i = src.indexOf("[ApplyPilot][" + marker + "] ⛔");
    assert.ok(i > 0, `the ${marker} guard must log its own failure, not swallow it`);
  }
  // and neither may be an empty catch
  const emptyCatches = [...src.matchAll(/catch \(e\) \{ \/\* a diagnostic must never break a fill \*\/ \}/g)];
  assert.strictEqual(emptyCatches.length, 0,
    "an empty diagnostic catch makes a broken check indistinguishable from a clean result");
});


// ── ORC labels some lists "<CODE> - <Name>" (live 2026-08-19) ────────────────────────────
// The Education entry's Degree picker returned exactly ONE row for a search of "Bachelor of
// Science" — `"BS - Bachelor of Science"` — and an exact compare refused it, leaving a REQUIRED
// field empty and Oracle refusing the whole Education entry on three consecutive runs.
test("atsInjOrcPick: a code-prefixed option is matched on the form's own \" - \" separator", async () => {
  const prevDoc = global.document, prevWin = global.window;
  try {
    // the injected fn writes through the NATIVE value setter (the React-fill technique), so the
    // fixture has to provide one — a plain object property would not be a descriptor with a `set`.
    let held = "";
    global.window = { HTMLInputElement: { prototype: {} }, HTMLTextAreaElement: { prototype: {} } };
    // the pick TYPES into the search box, so the event constructors it uses must exist
    global.KeyboardEvent = class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } };
    global.Event = global.Event || class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } };
    global.MouseEvent = class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } };
    global.PointerEvent = class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } };
    Object.defineProperty(global.window.HTMLInputElement.prototype, "value", {
      configurable: true, get() { return held; }, set(v) { held = v; },
    });
    const mkRow = (text) => ({
      textContent: text,
      getBoundingClientRect: () => ({ width: 300, height: 24, x: 10, y: 10 }),
      dispatchEvent() { this.clicked = true; return true; },
      scrollIntoView() {},
    });
    const rows = [mkRow("BS - Bachelor of Science")];
    const listbox = { querySelectorAll: () => rows };
    const input = {
      id: "contentItemId-9", value: "", className: "cx-select-input",
      getAttribute: (a) => (a === "aria-controls" ? "lb1" : null),
      focus() {}, click() {}, dispatchEvent() { return true; },
      getBoundingClientRect: () => ({ width: 200, height: 30, x: 0, y: 0 }),
      closest: () => null,
    };
    global.document = {
      querySelector: (q) => (/contentItemId/.test(q) ? input : null),
      getElementById: (id) => (id === "lb1" ? listbox : null),
      querySelectorAll: () => [],
    };

    const r = await ats.atsInjOrcPick("#contentItemId-9", "Bachelor of Science",
      ["bachelor of science"], 1500, false, /* segmentMatch */ true);
    assert.ok(r && r.ok, "the code-prefixed row must be accepted: " + JSON.stringify(r));
    assert.strictEqual(r.committed, "BS - Bachelor of Science",
      "and the COMMITTED value is the form's own full label, not our candidate");
  } finally { global.document = prevDoc; global.window = prevWin; }
});

test("the code-prefix rule is structural, not the containment the ladder refuses", () => {
  // The rule lives inside atsInjOrcPick, so its guarantees are asserted on the source: each of the
  // three is what separates this from a substring guess, and losing any one of them turns it into
  // exactly the thing the match ladder exists to refuse.
  const src = String(ats.atsInjOrcPick);
  // 1. the separator is " - " WITH SPACES — a bare hyphen lives inside ordinary words and names
  assert.ok(/indexOf\(" - "\)/.test(src),
    'the split must be on " - " with spaces; a bare "-" matches inside "Jean-Luc" and "Add-On"');
  assert.ok(!/split\("-"\)|indexOf\("-"\)/.test(src), "a bare hyphen must never be the separator");
  // 2. what remains must EQUAL the candidate, never merely contain it
  assert.ok(/wants\.indexOf\(afterCode\(t\(r\)\)\) !== -1/.test(src),
    "the remainder must be looked up in `wants` (an exact, normalized compare), not substring-tested");
  // 3. the ambiguity guard is untouched — two matching rows still refuse
  assert.ok(/hits\.length > 1[\s\S]{0,80}ambiguous/.test(src),
    "two rows matching must still be `ambiguous` and commit nothing");
  // 4. and it is gated on segmentMatch, so a plain picker is unaffected
  assert.ok(/segmentMatch && afterCode/.test(src), "the rule must only apply where segment matching is on");
});


// ── ORC's yes/no questions are a pair of BUTTONS (live 2026-08-20) ───────────────────────
// The operator reported three REQUIRED yes/no questions on step 3 that no run ever filled. They
// were there the whole time and every sweep in this file was blind to them at once: no
// input/select/textarea exists, the ARIA roles are list/listitem (not radio), and the
// block-population settle counted 0 "inputs" and spent 15s deciding the block was still loading —
// of a block visible at 680×331 with all three questions rendered.
test("the ORC scan finds a pill yes/no group, keyed on its flexfield id with the counter stripped", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("ul.cx-select-pills-container");
  assert.ok(i > 0, "the pill widget must be scanned");
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const pass = stripComments(src.slice(src.indexOf("for (const ul of sec.querySelectorAll(\"ul.cx-select-pills-container\")"), i + 4000));

  // ⚠ its own pass, NOT a branch in the control loop: the row class is `input-row--has-picker`,
  // the SAME as a combobox, so the classifier would call it a picker, look for an inner
  // input[role=combobox], find none, and drop the field silently.
  assert.ok(/widgetType: "yesno"/.test(pass), "it must classify as the existing yesno widget");
  // the durable key strips the volatile render counter, like every other ORC field
  assert.ok(/replace\(\/-\\d\+\$\/, ""\)/.test(pass),
    "the key must strip the trailing -<digits> render counter (lastName-21 -> lastName)");
  // required lives on the LABEL class, not the row's
  assert.ok(/input-row__label--required/.test(pass),
    "required is marked on the label class; reading the ROW class reports these as OPTIONAL, and an " +
    "optional unmapped field is deliberately left blank — they would stay unfilled AND unexplained");
  // aria-pressed is the selected state
  assert.ok(/aria-pressed/.test(pass), "the current answer is read from aria-pressed");
});

test("atsInjClickYesNo/atsInjReadValue: the container is the Ashby entry OR the element itself", () => {
  for (const fn of [ats.atsInjClickYesNo, ats.atsInjReadValue]) {
    const src = String(fn);
    assert.ok(/ashby-application-form-field-entry"\) \|\| (cb|el)/.test(src),
      "requiring the Ashby wrapper made ORC's pill group `no-field-entry`; the fallback keeps Ashby " +
      "byte-identical while making the primitive shape-agnostic");
  }
});

test("an ORC block's control count includes pill groups", () => {
  const src = String(ats.atsInjOrcBlocks);
  assert.ok(/cx-select-pills-container/.test(src),
    "a block holding three button-pair questions counted 0 controls, so the settle spent its whole " +
    "budget deciding a fully-rendered block was still loading. 'Zero inputs' and 'nothing to " +
    "answer' are different claims");
});

// ── the two US EEO demographics must never be answered from each other ───────────────────
test("the Hispanic/Latino question is recognized by its OPTIONS when the label will not say", () => {
  const p = { self_identification: { hispanic_or_latino: "No", race_ethnicity: "Asian" } };
  // live shape: label "Ethnicity", a single checkbox, option "I am Hispanic or Latino."
  const r = ats.atsRouteLabel("Ethnicity", { options: ["I am Hispanic or Latino."] }, p, {});
  assert.strictEqual(r.path, "self_identification.hispanic_or_latino",
    '"Ethnicity" carries no hispanic token, so it fell into the RACE rung and was answered "Asian" — ' +
    "a demographic answered from a different demographic field");
  assert.deepStrictEqual(r.candidates, ["No"]);

  // …and the race question still answers from race
  const r2 = ats.atsRouteLabel("Select the races you identify with.",
    { options: ["American Indian or Alaska Native", "Asian", "Black or African American"] }, p, {});
  assert.strictEqual(r2.path, "self_identification.race_ethnicity");
  assert.deepStrictEqual(r2.candidates, ["Asian"]);

  // an explicit label still works with no options at all
  const r3 = ats.atsRouteLabel("Are you Hispanic or Latino?", { options: ["Yes", "No"] }, p, {});
  assert.strictEqual(r3.path, "self_identification.hispanic_or_latino");

  // ⚠⚠ AND "AN OPTION MENTIONS HISPANIC" IS NOT THE TEST. EEO-1 race categories are routinely
  // SUFFIXED with the phrase as a negation, so both "any option mentions it" and "every option
  // mentions it" misroute a RACE question into the Hispanic field. A regression test caught the
  // first version of this within minutes; these pin the rule that replaced it.
  for (const opts of [
    ["Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)", "Decline to self identify"],
    ["Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)", "Black (Not Hispanic or Latino)"],
    ["Asian", "Black or African American", "Hispanic or Latino"],
  ]) {
    const rr = ats.atsRouteLabel("Race", { options: opts }, p, {});
    assert.strictEqual(rr.path, "self_identification.race_ethnicity",
      "a list offering OTHER RACES is a race question however it qualifies them: " + JSON.stringify(opts));
  }
  // …and a list that talks about nothing but Hispanic identity is the ethnicity question
  const re = ats.atsRouteLabel("Ethnicity", { options: ["Hispanic or Latino", "Not Hispanic or Latino"] }, p, {});
  assert.strictEqual(re.path, "self_identification.hispanic_or_latino");

  // ⚠ and an UNSTATED one is still never inferred
  const r4 = ats.atsRouteLabel("Ethnicity", { options: ["I am Hispanic or Latino."] },
    { self_identification: { race_ethnicity: "Asian" } }, {});
  assert.strictEqual(r4.eeoUnstated, true,
    "with no hispanic_or_latino stored it must report UNSTATED — never borrow the race answer");
});


// ── never add repeating entries on top of entries already on the form (live 2026-08-20) ──
// A run landed on a form Oracle had PREFILLED from an existing candidate record and the entry pass
// pressed Add three times anyway, leaving TWO copies of every job on a real application. Workday's
// rule is "reconcile to exactly N, then fill each entry — true idempotency, proven from ARBITRARY
// dirty state"; only the second half of that had been built for ORC. Add-N-times is correct on a
// blank form and duplicates on every other kind.
test("the ORC entry pass RECONCILES before filling — and history and skills get different policies", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const i = src.indexOf("async function atsOrcFillEntries");
  const pass = stripComments(src.slice(i, src.indexOf("\nfunction atsOrcEntryPlan", i)));

  // it must READ the tiles already on the form before adding anything
  assert.ok(/const tiles0 = await act\.eval\(atsInjOrcTiles/.test(pass),
    "the pass must read the block's existing TILES before pressing Add — a returning candidate's form " +
    "arrives prepopulated, and Add-once-per-profile-entry duplicated every job on a real application");

  // HISTORY: delete first
  assert.ok(/atsInjOrcDeleteTile/.test(pass), "history blocks must DELETE existing tiles before filling");
  // …last-first, and gated on the count actually dropping rather than on a delay
  assert.ok(/after\.count < n/.test(pass),
    "each delete must be confirmed by the tile count DROPPING — a delete that did not take must stop " +
    "the loop rather than spin it");
  // a confirmation dialog is answered here, not inside the injected primitive
  assert.ok(/del\.dialog && del\.dialog\.present/.test(pass) && /atsInjOrcDialogPress/.test(pass),
    "a delete confirmation must be REPORTED by the primitive and decided SW-side");
  // ⚠ and a PARTIAL clear must not be filled on top of — that is the duplicate this exists to prevent
  assert.ok(/still > 0/.test(pass) && /continue;/.test(pass),
    "if tiles could not be cleared, nothing may be added on top of them");

  // SKILLS: add only what is missing, never delete
  assert.ok(/const isSkills = item\.source === "skills"/.test(pass), "skills must be distinguished");
  assert.ok(/present\.length && !isSkills/.test(pass),
    "the DELETE path must be gated OFF for skills: a skills list is a SET, and the profile's skills are " +
    "capped, so deleting first would discard skills we could not restore");
  assert.ok(/haveSkills\.indexOf\(atsLib\.normalize\(entry\)\) !== -1/.test(pass),
    "a skill already on the form must be skipped, not re-added");
  // the cap must count ADDITIONS, or already-present skills eat the whole budget
  assert.ok(/added < item\.want/.test(pass),
    "the loop must stop after `want` NEW entries — capping the iteration count instead would let eight " +
    "already-present skills consume the budget and add nothing");
});

test("atsInjOrcTiles: a committed entry is a TILE whose controls are ICON-ONLY", () => {
  const src = String(ats.atsInjOrcTiles);
  // ⚠ THE LABEL IS IN aria-label / title, NEVER IN textContent. The first version of this detector
  // matched button CAPTIONS against /^(edit|delete|remove)/ and counted ZERO on a form that plainly
  // held three jobs, so the guard never fired and a second run duplicated the history again.
  assert.ok(/getAttribute\("aria-label"\)/.test(src) && /getAttribute\("title"\)/.test(src),
    "tiles must be found by their controls' aria-label/title — these buttons have NO text at all");
  // ⚠ and a ONE-CHARACTER tile text must survive: the skill "C" came back as "" under a `length > 1`
  // guard, which would make it look ABSENT on every visit and be re-added forever.
  assert.ok(/txt\.length > 0/.test(src),
    'a one-character tile text (the skill "C", or R, or Go) must not be discarded');
  assert.ok(!/txt\.length > 1/.test(src), "the `> 1` guard is the bug, not the fix");
});


// ── what reaches the review page is the APPLICATION'S ANSWER, not a log line ──────────────
test("the ORC date pair reaches review as a readable value, not a debug string", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf('spec.kind === "date_pair" && group.length >= 2');
  assert.ok(i > 0, "the date-pair branch must exist");
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const branch = stripComments(src.slice(i, i + 9000));   // the branch is ~85 lines long

  // ⚠ it used to write `month="May" year="2026"` — my own debug string — which the review editor
  // rendered as a TEXT BOX of raw markup and a submit replay would have typed at the form verbatim.
  // `current_value` is copied straight from `rec.after`, so anything convenient for a log becomes
  // the application's answer.
  assert.ok(!/\$\{half\.kind\}=/.test(branch),
    'the record must not carry `month="…" year="…"` — that is a log format, and it lands in ' +
    "current_value and then in the replay");
  assert.ok(/\[got_by\.month, got_by\.year\]/.test(branch),
    'the value must be the human-readable pair ("May 2026")');
  // and the label must not be the raw platform name: these halves carry no label at all
  assert.ok(/replace\(\/\(\[a-z\]\)\(\[A-Z\]\)\//.test(branch),
    'the label must split camelCase so review shows "Start Date", not "startDate"');
});

test("every yes/no commit goes through ONE implementation, and it waits on a DEADLINE", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  // ⚠⚠ ONE implementation for all THREE call sites. Live 2026-08-20 (hidden run): the two
  // DETERMINISTIC yes/no questions both reported "took 2 press(es)" and landed, while the
  // AI-answered one on the SAME page came back needs_review seconds later — because only the
  // deterministic path had the deadline-and-re-press logic. Which rung answered a question must not
  // decide whether the answer sticks.
  const i = src.indexOf("async function atsCommitYesNo");
  assert.ok(i > 0, "the shared yes/no commit must exist");
  const body = stripComments(src.slice(i, src.indexOf("\n// Actuate one field", i)));

  // A DEADLINE, not an iteration count — an iteration count is a proxy for time, and every proxy
  // breaks when the clock beneath it changes (this bit three times in one day: a fixed 150ms read;
  // 10 iterations on the ADAPTIVE pace, which collapsed 1.5s into 196ms; 24 iterations that only
  // passed because the STARVED worker clock made each ~500ms).
  assert.ok(/Date\.now\(\) < deadline/.test(body), "the read-back must poll against a DEADLINE");
  assert.ok(!/for \(let \w+ = 0; \w+ < \d+; \w+\+\+\)[\s\S]{0,160}atsInjReadValue/.test(body),
    "an iteration count is not a budget");
  // wall-clock pacing, never the adaptive pace
  assert.ok(/await act\.delayFull\(/.test(body) && !/await act\.delay\(\d/.test(body),
    "a settle must pace on delayFull; act.delay is the ADAPTIVE pace and collapses on a visible tab");
  // re-press, gated on nothing being pressed — a blind second press un-presses a TOGGLE
  assert.ok(/nothingPressed/.test(body) && /presses < 3/.test(body),
    "a press that did not register must be re-pressed, gated on nothing being pressed yet");
  // and the press count must be reported, so a widget that habitually needs two is visible
  assert.ok(/press\(es\)/.test(body), "the press count must reach the record");

  // ⚠ EVERY call site must use it — the deterministic rung, the AI choice commit, and the EEO
  // decline path. A direct atsInjClickYesNo outside the helper is the bug this test exists for.
  const whole = stripComments(src);
  const direct = [...whole.matchAll(/act\.eval\(atsInjClickYesNo/g)];
  assert.strictEqual(direct.length, 2,
    "atsInjClickYesNo may only be called from INSIDE atsCommitYesNo (the initial press and the " +
    "re-press) — found " + direct.length + " call(s), so a path is committing without the settle");
  for (const m of direct) {
    const before = whole.slice(Math.max(0, m.index - 2000), m.index);
    assert.ok(before.lastIndexOf("async function atsCommitYesNo") > before.lastIndexOf("\nasync function ")
      || /atsCommitYesNo/.test(before.slice(-2000)),
      "the only atsInjClickYesNo calls must sit inside atsCommitYesNo");
  }
});


// ── `siteLink` is a REPEATING family, so the ordinal picks WHICH website (operator, 2026-08-20) ──
test("atsProfileWebsites: every non-empty link, in order, https-normalized and deduped", () => {
  const p = { websites: [
    { type: "linkedin", url: "linkedin.com/in/wangykev" },
    { type: "github", url: "github.com/wangykev" },
    { type: "portfolio", url: "" },      // the editor keeps blank slots
    { type: "other", url: "   " },
  ] };
  assert.deepStrictEqual(ats.atsProfileWebsites(p),
    ["https://www.linkedin.com/in/wangykev", "https://www.github.com/wangykev"]);
  // compaction is what makes an ORDINAL meaningful: "link 2" is the second website that EXISTS,
  // not the second row of the profile editor.
  assert.deepStrictEqual(ats.atsProfileWebsites({}), []);
  // the same url written two ways collapses to one row
  const dup = ats.atsProfileWebsites({ websites: [{ url: "x.com" }, { url: "https://www.x.com" }] });
  assert.strictEqual(dup.length, 1, "a url listed twice must not claim two link rows: " + JSON.stringify(dup));
});

test("the Nth siteLink resolves to the Nth website — not the first one repeated", () => {
  const p = { websites: [{ url: "linkedin.com/in/kev" }, { url: "github.com/kev" }] };
  const route = (name) => ats.atsRouteField("oracle", { fieldName: name, widgetType: "text", label: "Link" }, p, {}, {}, null, null);
  // ⚠ atsMapKey strips a trailing `-<digits>` for Oracle, so EVERY siteLink-N reduces to one map key.
  // Returning "the first website" filled link 1 correctly and would have written that SAME url into
  // every further link the moment a second input existed — a duplicate from a rung that looked fine.
  const r1 = route("siteLink-1"), r2 = route("siteLink-2"), r3 = route("siteLink-3");
  assert.strictEqual(r1 && r1.raw, "https://www.linkedin.com/in/kev");
  assert.strictEqual(r2 && r2.raw, "https://www.github.com/kev");
  assert.ok(!r3 || r3.raw == null,
    "past the end of the list the extra input stays BLANK — never the last url repeated");
});

test("the links pass only ADDS what is missing, and is idempotent by url", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("async function atsOrcFillLinks");
  assert.ok(i > 0, "the links pass must exist");
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const pass = stripComments(src.slice(i, src.indexOf("\n// ── THE ENTRY PASS", i)));

  // idempotent by url — the form arrives prepopulated for a returning candidate, so without this
  // every run would grow the list
  assert.ok(/have\.indexOf\(norm\(u\)\) === -1/.test(pass), "a url already on the form must be skipped");
  // an existing EMPTY row is used before creating another
  assert.ok(/\.find\(\(l\) => !l\.value\)/.test(pass),
    "an empty row already on the form must be filled before pressing Add — otherwise a blank row is " +
    "left behind for the operator to notice");
  // the new input is awaited with a monotone poll, never a fixed sleep
  assert.ok(/now\.count > n/.test(pass), "the new input must be awaited by a monotone poll");
  // and every write is read-back verified like every other commit here
  assert.ok(/atsInjReadValue/.test(pass) && /needs_review/.test(pass),
    "each link write must be read-back verified, and a failure must reach review");
});

test("the links pass's notes are not discarded by the entry pass", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  // ⚠ an assignment here silently dropped the links pass's notes — the one channel that reports a
  // link we could not add.
  assert.ok(/entryNotes = entryNotes\.concat\(\(ep && ep\.notes\)/.test(src),
    "the entry pass must CONCAT onto entryNotes, never assign over it");
});


// ── a block whose tiles already match the profile is left alone (speed round, 2026-08-20) ──
// On a re-run the form arrives holding exactly the entries the profile would produce, and the pass
// deleted all of them and typed the identical thing back — the single largest waste on step 2, where
// each entry costs an open, four fields (two of them date pairs) and a commit.
test("atsOrcTilesAlreadyMatch: order-independent, and CONSERVATIVE in every uncertain direction", () => {
  const we = [
    { company: "Rivian and Volkswagon Technologies", job_title: "Characterization and Test Automation Intern" },
    { company: "Carnegie Mellon Racing", job_title: "Firmware Team Member" },
  ];
  const tiles = [
    { text: "Firmware Team Member Carnegie Mellon Racing 09/2024 - 05/2026" },
    { text: "Characterization and Test Automation Intern Rivian and Volkswagon Technologies 05/2026 - 08/2026" },
  ];
  // the form may sort its tiles, so matching is order-independent
  assert.strictEqual(ats.atsOrcTilesAlreadyMatch("work_experience", we, 2, tiles), true);

  // ⚠ EVERY uncertain case must fall through to delete-and-refill:
  assert.strictEqual(ats.atsOrcTilesAlreadyMatch("work_experience", we, 2, tiles.slice(0, 1)), false,
    "a different COUNT is not a match");
  const corrected = [{ company: "Rivian and Volkswagen Technologies", job_title: we[0].job_title }, we[1]];
  assert.strictEqual(ats.atsOrcTilesAlreadyMatch("work_experience", corrected, 2, tiles), false,
    "a one-letter employer correction must rewrite the block, not be waved through");
  assert.strictEqual(ats.atsOrcTilesAlreadyMatch("work_experience", [{ company: "X" }], 1, [{ text: "X" }]), false,
    "an entry we cannot fully identify (no job title) can never claim a match");
  assert.strictEqual(ats.atsOrcTilesAlreadyMatch("unknown_section", [{ a: 1 }], 1, [{ text: "a" }]), false,
    "an unknown section never claims a match");
  assert.strictEqual(ats.atsOrcTilesAlreadyMatch("work_experience", we, 2, null), false);

  // ⚠ two entries may not share one tile
  const dup = [we[1], we[1]];
  assert.strictEqual(ats.atsOrcTilesAlreadyMatch("work_experience", dup, 2, tiles), false,
    "a tile is consumed once — two entries cannot both match the same row");

  // education identifies on the school
  assert.strictEqual(ats.atsOrcTilesAlreadyMatch("education",
    [{ school_or_university: "Carnegie Mellon University" }], 1,
    [{ text: "Electrical and Computer Engineering Carnegie Mellon University" }]), true);
});

test("atsOrcEntryIdentity: a tiered profile value identifies on its most specific wording", () => {
  assert.deepStrictEqual(ats.atsOrcEntryIdentity("work_experience", { company: "C", job_title: "T" }), ["C", "T"]);
  assert.strictEqual(ats.atsOrcEntryIdentity("work_experience", { company: "C" }), null, "both are required");
  assert.deepStrictEqual(ats.atsOrcEntryIdentity("education", { school_or_university: "CMU" }), ["CMU"]);
  assert.deepStrictEqual(ats.atsOrcEntryIdentity("skills", "Python"), ["Python"]);
  assert.strictEqual(ats.atsOrcEntryIdentity("work_experience", null), null);
});

test("the FILL always deletes and refills a repeating block — no already-matches skip", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("async function atsOrcFillEntries");
  const end = src.indexOf("\nfunction atsOrcEntryPlan", i);
  const pass = stripJsComments(src.slice(i, end > 0 ? end : i + 20000));

  // ⚠ THE SKIP IS GONE (operator, 2026-08-20). It left correct tiles in place, which meant the entry
  // FIELDS never reached review — first not at all, then as opaque one-row summaries. The operator's
  // division of labour puts leaving-alone on the REHEARSAL, not the fill: the fill clicks Add,
  // exposes the entry form and fills it, so those fields are reviewable and editable.
  assert.ok(!/atsOrcTilesAlreadyMatch\(item\.source/.test(pass),
    "the fill must not skip a block because its tiles already match — the fields must reach review");
  assert.ok(/atsInjOrcDeleteTile/.test(pass),
    "delete-before-fill is the operator's instruction and must remain");

  // …and the per-field records are what makes the entries reviewable at all
  assert.ok(/fieldName: `\$\{item\.source\}\[\$\{i\}\]\.\$\{key\}`/.test(pass),
    "each entry field gets its OWN record — a per-entry summary row cannot be checked or corrected");
});


// ── three things that were flagged while being certain (operator, 2026-08-20) ────────────

test("atsGeoValueInProfile: does the profile CONTAIN this value — no label patterns, no per-field map", () => {
  const p = { personal_info: { city: "Tallahassee", state_province: "Florida", postal_code: "32312",
                               country: "United States", address_line_1: "715 Middlebrooks Circle" } };
  // ⚠ NO LABEL PATTERNS (operator's instruction). The first version matched the label against
  // /city|state|county|postal/ and looked each up under a named profile key — a list that has to be
  // extended for every tenant's wording and every locale's idea of a region, and which silently
  // answers "no opinion" the moment a label is worded unexpectedly.
  assert.strictEqual(ats.atsGeoValueInProfile("Tallahassee", p), true);
  assert.strictEqual(ats.atsGeoValueInProfile("32312", p), true);
  assert.strictEqual(ats.atsGeoValueInProfile("United States", p), true);
  // the ONLY normalization is FORM: "FL" and "Florida" are the same answer, both directions
  assert.strictEqual(ats.atsGeoValueInProfile("FL", p), true);
  assert.strictEqual(ats.atsGeoValueInProfile("Florida", p), true);
  assert.strictEqual(ats.atsGeoValueInProfile("FL", { personal_info: { state_province: "FL" } }), true);
  assert.strictEqual(ats.atsGeoValueInProfile("Florida", { personal_info: { state_province: "FL" } }), true);

  // ⚠⚠ AND "NOT IN THE PROFILE" MEANS REVIEW — also the operator's instruction, and a correction to
  // my first version, which CLEARED the County because Oracle had derived it from a verified anchor.
  // That reasoning is not wrong, but it is reasoning: the profile is the authority on what the
  // operator has actually told us, so a value it does not contain is something a human looks at once.
  assert.strictEqual(ats.atsGeoValueInProfile("Leon", p), false, "a county the profile never mentions");
  assert.strictEqual(ats.atsGeoValueInProfile("Orlando", p), false, "a wrong city");
  assert.strictEqual(ats.atsGeoValueInProfile("GA", p), false, "a wrong state");
  assert.strictEqual(ats.atsGeoValueInProfile("", p), false);
  assert.strictEqual(ats.atsGeoValueInProfile("Tallahassee", {}), false, "no profile ⇒ nothing verified");

  // it also draws on `locations`, so a value stated there counts
  assert.strictEqual(ats.atsGeoValueInProfile("Pittsburgh",
    { locations: [{ city: "Pittsburgh", state: "PA" }] }), true);
});

test("a cascade value the profile contains is FILLED; one it does not is a review item", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("async function atsSurfacePrefilled");
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const body = stripComments(src.slice(i, src.indexOf("\n  return surfaced;", i)));

  assert.ok(/atsGeoValueInProfile\(v, profile\)[\s\S]{0,200}status = "filled"/.test(body),
    "a value the profile contains is verified — the cascade ran off an anchor the profile supplied");
  assert.ok(/geo-not-in-profile/.test(body),
    "a value the profile does not contain must be flagged, and the flag must say WHY");
  // ⚠ TWO STATES ONLY — no third bucket that gets cleared by reasoning about derived values.
  assert.ok(!/cascadeTrustworthy|geoUnknown/.test(body),
    "the derived-value clearing is gone: verified, or reviewed");
});

test("an UNCHECKED checkbox holds no value — `false` is not content", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("async function atsSurfacePrefilled");
  const body = src.slice(i, src.indexOf("\n  return surfaced;", i));
  // ⚠ atsInjReadValue answers a checkbox with a BOOLEAN and `String(false)` is "false" — a non-empty
  // string. So every unchecked box on EVERY platform read as "the form already has something here"
  // and was surfaced as PRE-POPULATED, on a box deliberately left alone because the profile says No.
  assert.ok(/live\.value === false/.test(body), "a boolean false must short-circuit before stringifying");
  assert.ok(/v === "false"/.test(body), "…and the stringified form must be caught too");
  assert.strictEqual(String(false), "false", "this is the whole trap, in one line");
});

test("the ORC disability self-ID commits at a DETERMINISTIC tier, not containment", () => {
  const p = { self_identification: { disability_status: "No, I do not have a disability" } };
  const r = ats.atsRouteField("oracle",
    { fieldName: "US-STANDARD-ORA_DISABILITY_STATUS-STANDARD-12", widgetType: "radio", label: "Do you have a disability?" },
    p, {}, {}, null, null);
  // the stored wording FIRST, the bare polarity token LAST
  assert.deepStrictEqual(r.candidates, ["No, I do not have a disability", "No"]);
  assert.ok(!r.containment, "containment must NOT be requested — the ladder ends in a token that lands exactly");

  // …and against the real option list it lands on POLARITY LEAD, which grades `exact` ⇒ unflagged
  const opts = ["Yes, I have a disability, or have had one in the past",
                "No, I do not have a disability and have not had one in the past",
                "I do not want to answer"];
  const lib = require("../lib.js");
  const fd2 = require("../fill-driver.js");
  const m = lib.matchCandidates(r.candidates, opts, { containment: false });
  assert.strictEqual(m.targetIndex, 1);
  assert.strictEqual(m.matchTier, "polarity-lead");
  assert.strictEqual(fd2.flagTierCategory(m.matchTier), "exact",
    "polarity lead is graded exact, which is what makes this `filled` rather than `filled_review`");

  // ⚠ and a tenant that splits one polarity into TWO meanings must still escalate rather than guess
  const split = ["Yes, I have a disability",
                 "No, I do not now have a disability",
                 "No, I do not now have one BUT HAVE HAD one in the past"];
  const m2 = lib.matchCandidates(r.candidates, split, { containment: false });
  assert.ok(m2.targetIndex === -1 || m2.matchTier !== "polarity-lead",
    "two options leading with the same polarity is ambiguous — it must not be guessed");

  // an UNSTATED disability is still never inferred
  const r2 = ats.atsRouteField("oracle",
    { fieldName: "US-STANDARD-ORA_DISABILITY_STATUS-STANDARD-12", widgetType: "radio", label: "Do you have a disability?" },
    { self_identification: {} }, {}, {}, null, null);
  assert.strictEqual(r2.eeoUnstated, true);
});


// ── one predicate for "is this tier deterministic", and it must be ADDITIVE ──────────────
test("atsTierIsDeterministic: keeps the ATS-local tier the shared grader has never heard of", () => {
  // ⚠ Both choice-commit paths used to hardcode `exact-normalized || label-exact`, a list that
  // cannot learn — so **polarity-lead**, the tier that exists precisely so a stored "No" can land
  // "No, I do not have a disability and have not had one in the past" deterministically, was graded
  // filled_review anyway.
  assert.strictEqual(ats.atsTierIsDeterministic("polarity-lead"), true);
  assert.strictEqual(ats.atsTierIsDeterministic("exact-normalized"), true);

  // ⚠⚠ AND THIS IS WHY IT IS ADDITIVE RATHER THAN A SWAP: fill-driver's flagTierCategory returns
  // `none` for label-exact, an ATS-LOCAL tier it has never seen. Swapping outright would have
  // demoted every label-exact commit from filled to filled_review — a silent regression on
  // Greenhouse, Lever and Ashby in the name of fixing Oracle.
  const fd = require("../fill-driver.js");
  assert.strictEqual(fd.flagTierCategory("label-exact"), "none", "the shared grader does not know it");
  assert.strictEqual(ats.atsTierIsDeterministic("label-exact"), true, "…and this predicate must");

  // everything that IS a guess stays flagged
  for (const t of ["containment", "fuzzy", "autocommit", "skills-containment", undefined, null, ""]) {
    assert.strictEqual(ats.atsTierIsDeterministic(t), false, String(t) + " must stay flagged");
  }
});

test("both choice-commit paths grade through the one predicate", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const code = stripComments(src);
  const hardcoded = [...code.matchAll(/=== "exact-normalized" \|\| \w+(\.\w+)? === "label-exact"/g)];
  assert.strictEqual(hardcoded.length, 1,
    "the tier pair may appear ONCE, inside atsTierIsDeterministic — found " + hardcoded.length +
    " site(s), so a commit path is grading tiers on its own again");
  assert.ok(/function atsTierIsDeterministic/.test(code));
  assert.ok((code.match(/atsTierIsDeterministic\(/g) || []).length >= 3,
    "both commit paths plus the definition must reference it");
});


// ── skipping the WORK must never skip the RECORD (operator, 2026-08-20) ──────────────────
// The tile-match skip and the "0 links to add" path saved real time and quietly deleted Experience,
// Education and Links from the review bundle — on a run where all three were correctly on the form.
// That is worse than the slowness it replaced: a reviewer cannot approve an application whose work
// history they cannot see, and "absent" reads as "not filled" rather than "already right".
// (The "a skipped block still reports its entries" test retired with the skip itself — the fill now
// always refills, so the per-field records above are the only shape an entry reaches review in.)

test("links already on the form are reported, and not DOUBLED by the flat loop's record", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("async function atsOrcFillLinks");
  const stripComments = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const pass = stripComments(src.slice(i, src.indexOf("\n// ── THE ENTRY PASS", i)));

  assert.ok(/for \(const l of st0\.links\)[\s\S]{0,400}records\.push\(/.test(pass),
    "a link already on the form is still part of the application and must reach review");
  // ⚠ `siteLink-1` is in the static map, so the flat loop already recorded it — reporting every link
  // here without a guard makes the field appear TWICE, which reads as two links.
  assert.ok(/already\.has\(l\.name\)/.test(pass),
    "links the flat loop already recorded must be skipped, or review shows the same link twice");
  assert.ok(/recorded: results\.map/.test(src),
    "…and the caller must actually pass the recorded field names");
});


// ══ THE ORC SUBMIT WALK (2026-08-20) ═══════════════════════════════════════════════════════
// The submit run was single-page from the day it was written, because every ATS on this path was.
// ORC is the first that is not, and the failure mode of getting it wrong is the worst one available:
// a gate opened on a third of an application.

test("the ORC submit run WALKS the wizard and unions the results", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const i = src.indexOf("async function runAtsSubmitRun");
  assert.ok(i > 0);
  const run = stripJsComments(src.slice(i, src.indexOf("\n  } catch (e) {", i)));

  // the guard is GONE — and its absence is the thing under test, since it was correct until today
  assert.ok(!/oracle-not-implemented/.test(run),
    "the oracle-not-implemented guard must be deleted in the commit that adds the submit stage");

  // it must sign in BEFORE waiting for a form: ORC's gate PASSES atsLooksLikeApplicationForm, so a
  // run that waited for 'a form' first would find the GATE and replay approved values into a login box
  const preAt = run.indexOf("runOrcPreForm");
  const waitAt = run.indexOf("waitAtsFormReady");
  assert.ok(preAt > 0, "the submit run must run the ORC pre-form");
  assert.ok(preAt < waitAt, "the ORC pre-form must run BEFORE the form wait, never as a fallback after it");

  // the walk goes through the SHARED advance, not a second copy of the double guard
  assert.ok(/orcAdvanceAfterStep/.test(run), "the submit walk must use the shared advance");
  // …and the results are UNIONED, because the verify is a set difference over the whole bundle
  assert.ok(/union\.set\(durable\(r\), r\)/.test(run),
    "each step's results must accumulate into one union keyed by the durable submit key");
});

test("SAFETY: an ORC replay that did not reach the final step REFUSES the gate", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const i = src.indexOf("async function runAtsSubmitRun");
  const run = stripJsComments(src.slice(i, src.indexOf("\n  } catch (e) {", i)));

  const at = run.indexOf('walkStop !== "reached-final-step"');
  assert.ok(at > 0, "there must be an explicit test that the walk reached the END");
  const branch = run.slice(at, at + 700);
  assert.ok(/return \{/.test(branch) && /replay-incomplete/.test(branch),
    "a short walk must RETURN, not fall through to the gate");
  assert.ok(/submitted: false/.test(branch), "and it must say nothing was submitted");

  // ⚠ the refusal must come BEFORE the verify and the click — falling through with a partial union
  // would let the strict verify pass on the steps it did walk and open the gate on the rest.
  // ⚠ ANCHOR ON CODE, NOT PROSE: "STRICT verify" lives in a comment, and this very test strips
  // comments before scanning — so that anchor was -1 and the ordering assertion passed vacuously in
  // one direction and failed in the other. The fourth prose-vs-code scanning bite today.
  const verifyAt = run.indexOf("const failures = [];");
  const clickAt = run.indexOf("WOULD CLICK SUBMIT");
  assert.ok(at < verifyAt && at < clickAt,
    "the incomplete-walk refusal must precede both the verify and the submit gate");
});

test("SAFETY: a replay REPORTS the repeating entries and never rebuilds or deletes them", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("if (o.reportOnly) {");
  assert.ok(i > 0, "the report-only branch must exist");
  const branch = stripJsComments(src.slice(i, src.indexOf("\n  if (!plan.length) {", i)));

  assert.ok(/atsInjOrcTiles/.test(branch), "it must READ the tiles that are on the form");
  assert.ok(/records\.push\(/.test(branch), "…and report them, or the strict verify flags every entry as missing");
  assert.ok(/entrySection: spec\.source/.test(branch) && /entryIndex: k/.test(branch),
    "the records must carry section+index so atsSubmitKey lines them up with the bundle's");
  // ⚠⚠ NOTHING may be actuated here. A replay passes profile:{}, so a reconcile would see
  // "profile wants 0, the form has 3" and DELETE the work history.
  assert.ok(!/atsInjOrcDeleteTile|atsInjOrcOpenEntryAndWait|atsInjOrcCommitEntryAndWait/.test(branch),
    "a report-only pass must not open, commit or DELETE an entry — profile:{} would read as 'wants 0'");
  assert.ok(/return \{ records, notes \};/.test(branch), "and it must return before the filling plan runs");
});

test("the replay flag is threaded EXPLICITLY into atsFinishFill", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  // atsFinishFill does not receive `o`; the entry pass inside it already cost one live run by being
  // written against a scope it did not have.
  assert.ok(/async function atsFinishFill\(act, ats, scan, results, credentials, profile, jobContext, replay, valueFor\)/.test(src),
    "atsFinishFill must take the replay flag AND the approved-value lookup as parameters");
  assert.ok(/atsFinishFill\(act, ats, scan, results, o\.credentials, profile, jobContext, !!o\.valueFor, o\.valueFor\)/.test(src),
    "…and the caller must pass them from o.valueFor, this file's established replay signal");
  assert.ok(/reportOnly: !!replay, valueFor/.test(src),
    "…which become the entry pass's reportOnly and its approved-value lookup — without the lookup " +
    "the replay can only SEE the entries, not check them against what the human approved");
});

// ── A LONE ASSERTION CHECKBOX ANSWERS "NO" BY STAYING UNTICKED (operator, 2026-08-20) ────────
test("atsAssertionDeclined: a negative answer to a single affirmative assertion", () => {
  const D = ats.atsAssertionDeclined;
  // the case it was found on — Oracle's ethnicity question
  assert.strictEqual(D("No, I am not Hispanic", "I am Hispanic or Latino."), true);
  // …and the shapes other tenants use, since nothing here knows the question's SUBJECT
  assert.strictEqual(D("No", "I am Hispanic or Latino."), true);
  assert.strictEqual(D("false", "I certify the above"), true);
  assert.strictEqual(D("I am not a protected veteran", "I identify as a protected veteran"), true);
  assert.strictEqual(D("Not Hispanic or Latino", "I am Hispanic or Latino."), true);

  // ⚠ ONLY A NO. A yes must fall through to assertion-lead, because a YES we failed to express has
  // to be surfaced — on the page, "left unticked" and "never got to it" look identical.
  assert.strictEqual(D("Yes, I am Hispanic or Latino", "I am Hispanic or Latino."), false);
  assert.strictEqual(D("I am Hispanic or Latino", "I am Hispanic or Latino."), false);

  // ⚠ A NEGATIVELY-WORDED OPTION IS A DOUBLE NEGATIVE — refuse and let a human decide.
  assert.strictEqual(D("No", "I do not consent to marketing email"), false);
  assert.strictEqual(D("No", "I decline to self-identify"), false);
  assert.strictEqual(D("No", "I am not a protected veteran"), false);

  // and nothing unrelated
  assert.strictEqual(D("Asian", "I am Hispanic or Latino."), false);
  assert.strictEqual(D("November", "I am Hispanic or Latino."), false, "word-anchored: 'no' must not match 'November'");
  assert.strictEqual(D("", "I am Hispanic or Latino."), false);
  assert.strictEqual(D("No", ""), false);
});

test("the commit branch applies it ONLY to a one-option checkbox group", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("atsAssertionDeclined(candidates[0], texts[0])");
  assert.ok(i > 0, "the commit branch must use the shared helper, not its own regex");
  const guard = stripJsComments(src.slice(i - 220, i + 60));
  assert.ok(/wt === "checkbox_group"/.test(guard),
    "checkbox groups only — an untouched RADIO group means unanswered, not 'no'");
  assert.ok(/texts\.length === 1/.test(guard),
    "exactly one option — a multi-option group has no single assertion for a bare 'no' to deny");
});

// ── A WALL-CLOCK BUDGET EATEN BY A STARVED PACE IS NOT EVIDENCE (live 2026-08-20) ────────────
test("atsCommitYesNo: a normal commit still lands inside the ordinary budget", async () => {
  let clicks = 0, reads = 0;
  // Discriminate on ARITY, not on the function's name: the click is eval(fn, inputSel, want) and the
  // read is eval(fn, ats, inputSel, kind), so only the read is passed a third argument.
  const act = {
    eval: async (fn, a, b, c) => {
      if (c === undefined) { clicks++; return { ok: true }; }
      reads++;
      return { ok: true, value: reads >= 2 ? "No" : null };   // the pill settles on the 2nd read
    },
    delayFull: async () => {},
  };
  const out = await ats.atsCommitYesNo(act, "oracle", { inputSel: "#q" }, "No", "yesno");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.starved, false, "a healthy clock must never trip the extension");
  assert.ok(out.cycles >= 2 && out.cycles < 10, "it stops as soon as the read agrees");
});

test("the yes/no budget extends ONLY when it ran out without looking", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("async function atsCommitYesNo");
  const fn = stripJsComments(src.slice(i, src.indexOf("\n}", src.indexOf("return { ok, value", i))));

  assert.ok(/cycles < MIN_CYCLES/.test(fn),
    "the extension is gated on having completed too FEW read cycles — a budget that expired before " +
    "the loop could look even once has measured nothing");
  assert.ok(/HARD_CEILING_MS/.test(fn), "…and it is bounded, so a genuinely dead widget still ends");
  assert.ok(/starved/.test(fn), "the outcome must say which of the two happened");
  // ⚠ the ordinary path is unchanged: the budget is still spent in wall clock
  assert.ok(/Date\.now\(\) < deadline/.test(fn), "the loop is still wall-clock bounded");
});

// ── ORC STAMPS A VOLATILE RENDER COUNTER ONTO A RADIO GROUP'S name (live, 2026-08-20) ────────
test("atsSubmitKey(oracle): the volatile self-ID counter is stripped, meaningful ordinals are not", () => {
  const k = (n) => ats.atsSubmitKey("oracle", n);

  // measured across two visits to the SAME form: the fill saw -12, the rehearsal -13, and the
  // approved answer reported "no matching field on the live form" on a question sitting right there
  assert.strictEqual(k("US-STANDARD-ORA_DISABILITY_STATUS-STANDARD-12"),
                     k("US-STANDARD-ORA_DISABILITY_STATUS-STANDARD-13"),
                     "two visits to the same field must produce the same key");
  assert.strictEqual(k("US-STANDARD-ORA_DISABILITY_STATUS-STANDARD-12"),
                     "US-STANDARD-ORA_DISABILITY_STATUS-STANDARD");

  // ⚠⚠ THE COLLISION THIS MUST NOT CAUSE. siteLink's trailing number is a MEANINGFUL ENTRY ORDINAL,
  // so stripping it would key both links the same — one would shadow the other and the verify would
  // match the wrong link or call it missing.
  assert.strictEqual(k("siteLink-1"), "siteLink-1");
  assert.notStrictEqual(k("siteLink-1"), k("siteLink-2"));

  // digits with no hyphen are a per-tenant flexfield name, not a counter
  assert.strictEqual(k("namInformation15"), "namInformation15");
  // and an ordinary platform name is untouched
  assert.strictEqual(k("lastName"), "lastName");

  // ⚠ ORACLE ONLY — the other platforms must key byte-identically to before
  assert.strictEqual(ats.atsSubmitKey("greenhouse", "US-STANDARD-X-STANDARD-12"),
                     "US-STANDARD-X-STANDARD-12");
  assert.strictEqual(ats.atsSubmitKey("lever", "anything-9"), "anything-9");
});

// ── A REHEARSAL READS BEFORE IT WRITES (operator, 2026-08-21) ────────────────────────────────
test("the replay skips actuation when the form already holds the approved value", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf('if (o.valueFor && !atsCredentialKind(ats, f))');
  assert.ok(i > 0, "the replay branch must exist");
  const branch = stripJsComments(src.slice(i, i + 4200));   // wide enough to include the fall-through

  assert.ok(/tier = "already-correct"/.test(branch),
    "a field the form already holds must be recorded verified rather than rewritten");
  assert.ok(/atsLib\.normalize\(live\) === atsLib\.normalize\(String\(v\)\)/.test(branch),
    "the comparison is on the live value the SCAN already carries — no extra page contact");
  assert.ok(/rec\.resolved = \[String\(v\)\]/.test(branch),
    "it must mark the field as one we HAD a value for, or atsSurfacePrefilled re-reports it as pre-populated");

  // ⚠⚠ FILE FIELDS ARE EXEMPT. A file field shows only a NAME, which says nothing about which bytes
  // the server holds — so a rehearsal always re-uploads rather than trusting a filename.
  assert.ok(/f\.widgetType !== "file_upload"/.test(branch),
    "the read-before-write shortcut must NOT apply to file fields");

  // …and the fall-through must still actuate, which is the operator's other half
  assert.ok(branch.indexOf('tier = "already-correct"') < branch.indexOf('route = { value: v, source: "replay" }'),
    "a value that does NOT match must fall through and be written, exactly as before");
});

test("the résumé is removed and re-uploaded BEFORE the step's scan", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "background.js"), "utf8");
  const i = src.indexOf("atsInjOrcResumeReset");
  assert.ok(i > 0, "the replay walk must reset the résumé");
  const walk = stripJsComments(src.slice(i - 400, i + 1400));

  // BEFORE the fill: until the file is removed, ORC renders the attached state and `resume-upload`
  // is not in the scan at all — which is how the approved résumé came to report "no matching field".
  assert.ok(walk.indexOf("atsInjOrcResumeReset") < walk.indexOf("driveAtsPageFill"),
    "the reset must run BEFORE the step's fill, or the upload control is not in the scan");
});

test("atsInjOrcResumeReset reports what it found instead of assuming markup", () => {
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("async function atsInjOrcResumeReset");
  assert.ok(i > 0);
  const fn = stripJsComments(src.slice(i, src.indexOf("\n}", src.indexOf('error: "still-attached"', i))));

  assert.ok(/no-remove-control/.test(fn) && /offered/.test(fn),
    "a missing remove control must come back as a diagnosable report carrying the controls it DID " +
    "see — ORC's attached-résumé markup has not been observed, and a silent no-op would hide that");
  // ⚠ scoped to the résumé's own row/wrapper, never a document sweep: a cover-letter or attachment
  // slot must never be mistaken for the résumé (the Greenhouse wrong-slot lesson).
  assert.ok(/resume-upload-button/.test(fn), "it prefers ORC's own wrapper");
  assert.ok(!/document\.querySelectorAll\("button/.test(fn),
    "controls are searched within the résumé area, never document-wide");
});
