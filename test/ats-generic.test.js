// GENERIC form driver — the pure resolution layer, pinned against FIXTURES CAPTURED FROM REAL
// FORMS during the 2026-08-11/12 recon (docs/generic-filler-plan.md, dom-patterns 2026-08-11..12).
//
// Every test here names the form that earned it. These are regressions, not examples: each one
// failed at some point during the recon, and several encode a mistake this plan made first and
// measured its way out of (the heading rung, the exclusion rule, "native select ⇒ free options").
//
// ⚠ ALSO GUARDS THE BLAST RADIUS: the generic kind must never leak into the three supported ATS
// families or Workday. See "isolation" at the bottom.
const { test } = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

// ── identity durability ─────────────────────────────────────────────────────────────────
test("generic identity: real durable ids pass, real per-render ids are rejected", () => {
  const d = ats.atsGenericIdDurable;
  // Dayforce — semantic, and it even carries the repeating index, so entry scoping is free
  assert.ok(d("jobPostingApplication_personalInfo_email"));
  assert.ok(d("jobPostingApplication_educationHistory_0_degreeName"));
  // Paylocity / KEF / Greenhouse / Lever — clean names
  assert.ok(d("info.firstName"));
  assert.ok(d("public-site-address-city"));
  assert.ok(d("first-name"));
  assert.ok(d("cResume"));
  assert.ok(d("question_16203685008"));
  assert.ok(d("urls[LinkedIn]"));
  // Wix build ids survive a session (they change only on republish) — accepted, and a change just
  // fails to re-find the field, which is an honest needs_review rather than a wrong fill.
  assert.ok(d("collection_comp-lpjwscz6"));

  // Workable — regenerated on EVERY render, so it can never key a replay
  assert.ok(!d("input_files_input_QQUpFBNbEVDkaqRr"));
  // Dayforce/rc-select — a per-render SEQUENTIAL counter (and these two also share a duplicate
  // label, "Country dialing code", so they have neither a durable id nor a unique name)
  assert.ok(!d("rc_select_4"));
  assert.ok(!d("rc_select_5"));
  // Paylocity — opaque signed tokens on repeating-entry fields
  assert.ok(!d("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdef"));
  // degenerate
  assert.ok(!d("4128182"));
  assert.ok(!d(""));
  assert.ok(!d(null));
});

// ── required-ness: four mechanisms, and a form may use exactly one ──────────────────────
test("generic required: Paylocity marks it ONLY in the label text", () => {
  const r = ats.atsGenericRequiredFromLabel;
  assert.strictEqual(r("First Name (required)"), true);
  assert.strictEqual(r("Email Address (required)"), true);
  assert.strictEqual(r("Address Line 2(optional)"), false);
  // Workday/Greenhouse/Lever asterisks — and Lever's is MID-STRING, ahead of an inline error, so
  // an end-anchored test is not enough
  assert.strictEqual(r("AI Policy for Application*"), true);
  assert.strictEqual(r("Current location ✱No location found. Try entering a different"), true);
  // says nothing
  assert.strictEqual(r("Middle Name"), null);
  assert.strictEqual(r(""), null);
});

test("generic label cleaning: the required marker is stripped before it becomes a QUESTION", () => {
  const c = ats.atsGenericCleanLabel;
  // left in, these are carried into normalizeLabel and can never match a stored bucket wording
  assert.strictEqual(c("First Name (required)"), "First Name");
  assert.strictEqual(c("Address Line 2(optional)"), "Address Line 2");
  assert.strictEqual(c("AI Policy for Application*"), "AI Policy for Application");
  assert.strictEqual(c("Do you require visa sponsorship? *"), "Do you require visa sponsorship?");
  assert.strictEqual(c("Email:"), "Email");
  assert.strictEqual(c("  spaced   out  "), "spaced out");
});

// ── the label ladder, and the ORDER regression this plan created itself ─────────────────
test("generic labels: BREEZY — placeholder beats an ancestor section heading", () => {
  // Live: putting the heading rung ABOVE placeholder made four fields resolve to the SAME string,
  // "Personal Details", where placeholder was correct. This is that regression, pinned.
  const raw = {
    url: "https://victory.breezy.hr/p/x/apply", title: "Staff Software Engineer",
    fields: [
      { attrId: "cName", inputSel: "#cName", widgetType: "text", domIndex: 0,
        labelCandidates: { placeholder: "Full Name", heading: "Personal Details" } },
      { attrId: "cEmail", inputSel: "#cEmail", widgetType: "text", domIndex: 1,
        labelCandidates: { placeholder: "Email Address", heading: "Personal Details" } },
      { attrId: "cPhoneNumber", inputSel: "#cPhoneNumber", widgetType: "text", domIndex: 2,
        labelCandidates: { placeholder: "Phone Number", heading: "Personal Details" } },
      { attrId: "cAddress", inputSel: "#cAddress", widgetType: "text", domIndex: 3,
        labelCandidates: { placeholder: "Address", heading: "Personal Details" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.deepStrictEqual(s.fields.map((f) => f.label), ["Full Name", "Email Address", "Phone Number", "Address"]);
  assert.ok(s.fields.every((f) => f.labelVia === "placeholder"));
});

test("generic labels: BREEZY — a radio group DOES take its heading (no placeholder to fall back on)", () => {
  // …and the rung exists precisely for this: without it, race_ethnicity resolved to its FIRST
  // OPTION's label, "White (not Hispanic or Latino)", on a REQUIRED demographic.
  const raw = {
    fields: [
      { attrId: "race_ethnicity", inputSel: 'input[name="race_ethnicity"]', widgetType: "radio", domIndex: 0,
        reqAttr: true, options: ["White (not Hispanic or Latino)", "Asian (not Hispanic or Latino)", "I don't wish to answer"],
        labelCandidates: { heading: "Race or Ethnicity" } },
      { attrId: "gender", inputSel: 'input[name="gender"]', widgetType: "radio", domIndex: 1,
        reqAttr: true, options: ["Male", "Female", "I don't wish to answer"],
        labelCandidates: { heading: "Gender" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].label, "Race or Ethnicity");
  assert.strictEqual(s.fields[0].labelVia, "heading");
  assert.strictEqual(s.fields[1].label, "Gender");
  // the option list survives so review can render a real picker
  assert.strictEqual(s.fields[0].options.length, 3);
  assert.ok(s.fields.every((f) => f.isRequired));
});

test("generic labels: a heading claimed by 2+ fields is a SECTION heading and is refused", () => {
  const raw = {
    fields: [
      { attrId: "cSummaryOne", inputSel: "#one", widgetType: "text", domIndex: 0, labelCandidates: { heading: "Experience" } },
      { attrId: "cSummaryTwo", inputSel: "#two", widgetType: "text", domIndex: 1, labelCandidates: { heading: "Experience" } },
      { attrId: "cGpaValue", inputSel: "#gpa", widgetType: "text", domIndex: 2, labelCandidates: { heading: "GPA" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  // refused → no label at all, so the field keeps its DURABLE id as identity and the id stands in
  // as the display label. It reaches review unlabelled-but-addressable rather than mislabelled.
  assert.strictEqual(s.fields[0].labelVia, "none");
  assert.strictEqual(s.fields[0].fieldName, "cSummaryOne");
  assert.strictEqual(s.fields[0].identityFrom, "attr");
  assert.strictEqual(s.fields[0].label, "cSummaryOne");
  assert.strictEqual(s.fields[2].label, "GPA");          // unique heading is kept
  assert.strictEqual(s.fields[2].labelVia, "heading");
});

test("generic labels: the full rung order is honoured", () => {
  const raw = {
    fields: [
      { attrId: "x", inputSel: "#x", widgetType: "text", domIndex: 0,
        labelCandidates: { ariaLabel: "A", ariaLabelledby: "B", labelFor: "C", labelWrap: "D", unitLabel: "E", placeholder: "F", heading: "G" } },
      { attrId: "y", inputSel: "#y", widgetType: "text", domIndex: 1,
        labelCandidates: { labelFor: "C", unitLabel: "E", placeholder: "F" } },
      { attrId: "z", inputSel: "#z", widgetType: "checkbox", domIndex: 2,
        labelCandidates: { adjacentText: "By providing your phone number you agree…" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].labelVia, "ariaLabel");
  assert.strictEqual(s.fields[1].labelVia, "labelFor");
  // the consent-checkbox rung: BOTH the DOM ladder and Chrome's AX tree fail to name Breezy's
  // smsConsent box — its text is a sibling, not a label
  assert.strictEqual(s.fields[2].labelVia, "adjacentText");
});

// ── identity fallback + the duplicate-label problem ─────────────────────────────────────
test("generic identity: DAYFORCE — duplicate labels + non-durable ids get an ORDINAL", () => {
  // The two dialing-code selects have NEITHER a durable id (rc_select_4/5) NOR a unique label
  // ("Country dialing code" ×2) — the worst case on any form in the corpus.
  const raw = {
    fields: [
      { attrId: "rc_select_4", inputSel: "#rc_select_4", widgetType: "select", domIndex: 0,
        labelCandidates: { ariaLabel: "Country dialing code" } },
      { attrId: "rc_select_5", inputSel: "#rc_select_5", widgetType: "select", domIndex: 1,
        labelCandidates: { ariaLabel: "Country dialing code" } },
      { attrId: "jobPostingApplication_personalInfo_email", inputSel: "#e", widgetType: "text", domIndex: 2,
        labelCandidates: { labelFor: "Email Address" }, reqAttr: true },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].fieldName, "label:Country dialing code#0");
  assert.strictEqual(s.fields[1].fieldName, "label:Country dialing code#1");
  assert.strictEqual(s.fields[0].identityFrom, "label");
  // a durable id is used as-is and never ordinal-suffixed
  assert.strictEqual(s.fields[2].fieldName, "jobPostingApplication_personalInfo_email");
  assert.strictEqual(s.fields[2].identityFrom, "attr");
  assert.deepStrictEqual(s.diag.duplicateLabels, ["country dialing code"]);
  assert.strictEqual(s.diag.nonDurableIds, 2);
});

test("generic identity: a UNIQUE label is NOT ordinal-suffixed (it must key stably across visits)", () => {
  const raw = { fields: [{ attrId: "rc_select_9", inputSel: "#rc_select_9", widgetType: "select", domIndex: 0, labelCandidates: { ariaLabel: "Highest degree" } }] };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].fieldName, "label:Highest degree");
});

test("generic identity: no durable id AND no label ⇒ unidentified, reported, never fillable", () => {
  const raw = { fields: [{ attrId: null, inputSel: '[data-apg="g3"]', widgetType: "text", domIndex: 3, labelCandidates: {} }] };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].unidentified, true);
  assert.strictEqual(s.fields[0].identityFrom, "none");
  assert.match(s.fields[0].fieldName, /^unidentified#/);
});

// ── required: the merge, and the "no signal anywhere" state ─────────────────────────────
test("generic required: PAYLOCITY — label text is the only signal, and it must win", () => {
  const raw = {
    fields: [
      { attrId: "info.firstName", inputSel: "#fn", widgetType: "text", domIndex: 0,
        reqAttr: false, reqMarker: false, labelCandidates: { unitLabel: "First Name (required)" } },
      { attrId: "info.middleName", inputSel: "#mn", widgetType: "text", domIndex: 1,
        reqAttr: false, reqMarker: false, labelCandidates: { unitLabel: "Middle Name" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].isRequired, true);
  assert.strictEqual(s.fields[0].reqVia, "label-text");
  assert.strictEqual(s.fields[0].label, "First Name");   // marker stripped from the question
  assert.strictEqual(s.fields[1].isRequired, false);
  assert.strictEqual(s.diag.noRequiredSignalAnywhere, false);
});

test("generic required: KEF — a form with NO required signal is REPORTED, not read as 'none required'", () => {
  // Only `email` was marked on the real form; here nothing is, which is the state that must be
  // surfaced rather than silently trusted (under-flagging is the dangerous direction).
  const raw = {
    fields: [
      { attrId: "first-name", inputSel: "#f", widgetType: "text", domIndex: 0, labelCandidates: { labelFor: "First name" } },
      { attrId: "last-name", inputSel: "#l", widgetType: "text", domIndex: 1, labelCandidates: { labelFor: "Last name" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.diag.noRequiredSignalAnywhere, true);
});

test("generic required: ANY mechanism saying required wins (over-flag is the safe direction)", () => {
  const mk = (over) => ats.atsGenericPostProcess({ fields: [Object.assign({ attrId: "q", inputSel: "#q", widgetType: "text", domIndex: 0, labelCandidates: { labelFor: "Q" } }, over)] }).fields[0].isRequired;
  assert.strictEqual(mk({ reqAttr: true }), true);
  assert.strictEqual(mk({ reqMarker: true }), true);
  assert.strictEqual(mk({ labelCandidates: { labelFor: "Q (required)" } }), true);
  assert.strictEqual(mk({}), false);
});

// ── label confidence: a MIS-ASSIGNED label is not merely a polluted one ────────────────
test("generic labels: PAYLOCITY — a label taken from a shared unit is flagged low-confidence", () => {
  // Live, `info.maximumDesiredSalary` resolved to a NEIGHBOURING field's label, "Desired Salary
  // Type". It looks perfectly plausible and is wrong, so it must be reviewable rather than trusted.
  const raw = {
    fields: [{ attrId: "info.maximumDesiredSalary", inputSel: "#mx", widgetType: "text", domIndex: 0,
      labelShared: true, labelCandidates: { unitLabel: "Desired Salary Type" } }],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].labelLowConfidence, true);
});

// ── native-select options: "free" is FALSE when the list is a placeholder ───────────────
test("generic options: a placeholder-only native select carries NO options (KEF)", () => {
  // KEF Robotics' "Are you a US Citizen?" is a real <select> holding exactly ["Choose an option"],
  // unchanged after 4s. mustOpen is decided from the list's CONTENTS, never the tag name.
  const raw = {
    fields: [
      { attrId: "collection_comp-lpjwscz6", inputSel: "#c", widgetType: "dropdown_native", domIndex: 0,
        options: [], optionsPlaceholderOnly: true, labelCandidates: { labelFor: "Are you a US Citizen?" } },
      { attrId: "real", inputSel: "#r", widgetType: "dropdown_native", domIndex: 1,
        options: ["Yes", "No"], optionsPlaceholderOnly: false, labelCandidates: { labelFor: "Authorized?" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].options, null);
  assert.strictEqual(s.fields[0].optionsPlaceholderOnly, true);
  assert.deepStrictEqual(s.fields[1].options, ["Yes", "No"]);
});

// ── the exclusion set is REPORTED, never silently dropped ──────────────────────────────
test("generic scan: excluded controls are carried through to the caller", () => {
  const s = ats.atsGenericPostProcess({
    excluded: [{ id: "hp_7f2b", why: "tabindex-1", cls: "" }, { id: "", why: "aria-hidden+opacity0", cls: "requiredInput" }],
    fields: [],
  });
  assert.strictEqual(s.excluded.length, 2);
  assert.strictEqual(s.excluded[0].id, "hp_7f2b");   // Breezy's honeypot
});

// ── the injected scanner must be SELF-CONTAINED (same rule as every other injected fn) ──
test("atsInjScanGeneric: stringifies without closure references", () => {
  const src = ats.atsInjScanGeneric.toString();
  // it may only reach for page globals + its own locals
  for (const forbidden of ["atsLib", "atsFd", "ATS_POLL", "atsGenericIdDurable", "atsGenericCleanLabel", "require("]) {
    assert.ok(!src.includes(forbidden), "injected scanner must not reference " + forbidden);
  }
  // and it must actually be a function body we can hand to Runtime.evaluate
  assert.ok(/^function atsInjScanGeneric\(\)/.test(src));
});

// ── the review picker ───────────────────────────────────────────────────────────────────
test("atsCaptureChoiceOptions: opens an unfilled combobox, attaches options, CONFIRMS the close", () => {
  // Operator requirement: a reconnable dropdown must show up in review. A field the fill filled had
  // its options read at commit time and a deferred field had them read by the defer pass — the gap
  // is a choice field we neither filled nor deferred.
  const calls = [];
  const act = {
    eval: async (fn, sel, force) => {
      const n = fn && fn.name;
      calls.push(n + ":" + sel);
      if (n === "atsInjOpenAndReadOptions") return { ok: true };
      if (n === "atsInjReadOptions") {
        // after a close, report shut; before it, report the list
        const closed = calls.some((c) => c.startsWith("atsInjCloseCombo:"));
        return closed ? { open: false, options: [] } : { open: true, options: [{ text: "Yes" }, { text: "No" }] };
      }
      if (n === "atsInjCloseCombo") return { ok: true };
      return { ok: true };
    },
    delayFull: async () => {},
  };
  const scan = { fields: [{ fieldName: "label:Sponsorship", inputSel: "#s", widgetType: "select", label: "Do you require sponsorship?" }] };
  const results = [{ fieldName: "label:Sponsorship", status: "skipped" }];
  return ats.atsCaptureChoiceOptions(act, "generic", scan, results).then((r) => {
    assert.strictEqual(r.captured, 1);
    assert.deepStrictEqual(results[0].options, ["Yes", "No"]);
    // the close is not optional: a menu left mounted swallows the next widget's open-click
    assert.ok(calls.some((c) => c.startsWith("atsInjCloseCombo:")), "must close the menu it opened");
  });
});

test("atsCaptureChoiceOptions: a server-ranked widget is SKIPPED (it can never BE the picker)", () => {
  const act = { eval: async () => { throw new Error("must not open a location widget"); }, delayFull: async () => {} };
  const scan = { fields: [{ fieldName: "label:Where are you based?", inputSel: "#l", widgetType: "select", label: "Where are you currently based?" }] };
  const results = [{ fieldName: "label:Where are you based?", status: "skipped" }];
  return ats.atsCaptureChoiceOptions(act, "generic", scan, results).then((r) => {
    assert.strictEqual(r.captured, 0);
    assert.strictEqual(r.skipped, 1);
    assert.ok(!results[0].options);
  });
});

test("atsCaptureChoiceOptions: never re-reads a field that already carries options", () => {
  const act = { eval: async () => { throw new Error("must not open an already-populated field"); }, delayFull: async () => {} };
  const scan = { fields: [{ fieldName: "q", inputSel: "#q", widgetType: "select", label: "Q" }] };
  const results = [{ fieldName: "q", status: "needs_review", options: ["A", "B"] }];
  return ats.atsCaptureChoiceOptions(act, "generic", scan, results).then((r) => assert.strictEqual(r.captured, 0));
});

test("atsCaptureChoiceOptions: a radio/native list is attached from the SCAN, with no open at all", () => {
  const act = { eval: async () => { throw new Error("must not open a scan-known widget"); }, delayFull: async () => {} };
  const scan = { fields: [{ fieldName: "g", inputSel: 'input[name="g"]', widgetType: "radio", label: "G", options: ["A", "B"] }] };
  const results = [{ fieldName: "g", status: "skipped" }];
  return ats.atsCaptureChoiceOptions(act, "generic", scan, results).then((r) => {
    assert.strictEqual(r.captured, 1);
    assert.deepStrictEqual(results[0].options, ["A", "B"]);
  });
});

// ── the résumé: no static map exists for a generic form, so it is recognized ────────────
test("generic résumé: recognized from the widget + label, and NEVER from a neighbour slot", () => {
  const route = (f) => ats.atsRouteField("generic", f, {}, {}, {}, null);
  // KEF Robotics ("Upload Resume"), Lever-style ("Resume/CV"), a bare "Attach"
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "fileInputcomp-x", label: "Upload Resume" }).kind, "resume");
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "cResume", label: "" }).kind, "resume");
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "f1", label: "Resume/CV" }).kind, "resume");
  // the slots a form puts NEXT to it must never receive the résumé
  for (const l of ["Cover Letter", "Upload Cover Letter", "Transcript", "Portfolio", "Writing sample", "References"]) {
    assert.strictEqual(route({ widgetType: "file_upload", fieldName: "x", label: l }).kind, "skip", l + " must not be the résumé");
  }
});

test("generic résumé: an UNLABELLED file input is the résumé only when it is the form's only one", () => {
  const route = (f) => ats.atsRouteField("generic", f, {}, {}, {}, null);
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "u1", label: "", soleFileInput: true }).kind, "resume");
  // several unlabelled slots ⇒ not decidable ⇒ left for the operator rather than guessed
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "u1", label: "" }).kind, "skip");
});

test("generic résumé: postProcess marks soleFileInput only when there is exactly one", () => {
  const one = ats.atsGenericPostProcess({ fields: [
    { attrId: "cResume", inputSel: "#r", widgetType: "file_upload", domIndex: 0, labelCandidates: {} },
    { attrId: "cName", inputSel: "#n", widgetType: "text", domIndex: 1, labelCandidates: { placeholder: "Full Name" } },
  ] });
  assert.strictEqual(one.fields[0].soleFileInput, true);
  assert.strictEqual(one.diag.fileInputs, 1);
  const two = ats.atsGenericPostProcess({ fields: [
    { attrId: "fileA", inputSel: "#a", widgetType: "file_upload", domIndex: 0, labelCandidates: {} },
    { attrId: "fileB", inputSel: "#b", widgetType: "file_upload", domIndex: 1, labelCandidates: {} },
  ] });
  assert.ok(!two.fields[0].soleFileInput);
  assert.ok(!two.fields[1].soleFileInput);
  assert.strictEqual(two.diag.fileInputs, 2);
});

test("isolation: the résumé recognizer does NOT fire for the supported families", () => {
  // they name their resume field in ATS_STATIC_MAPS, and that map is checked FIRST — this guard is
  // here so the generic recognizer can never start claiming their file inputs.
  for (const kind of ["greenhouse", "lever", "ashby"]) {
    const r = ats.atsRouteField(kind, { widgetType: "file_upload", fieldName: "some_unmapped_file", label: "Transcript" }, {}, {}, {}, null);
    assert.ok(!r || r.source !== "generic", kind + " must not use the generic recognizer");
  }
});

// ── the submit gate: a WIZARD's "Next Step" is not a submit ─────────────────────────────
test("generic submit: a multi-step page is a FORM but has NO submit control", () => {
  // Paylocity's primary button is literally "Next Step" (44 fields, multi-page). Detection must
  // accept the page as an application form; the submit GATE must still refuse to click.
  const fields = [{ fieldName: "info.email", label: "Email Address (required)", widgetType: "text" }];
  const wizard = ats.atsLooksLikeApplicationForm(fields, { hasSubmit: false, multiStep: true });
  assert.strictEqual(wizard.ok, true, "a wizard page IS an application form");
  assert.strictEqual(wizard.hasSubmit, false, "…but it offers nothing to submit");
  assert.strictEqual(wizard.multiStep, true);
  // and a page with neither is refused
  const neither = ats.atsLooksLikeApplicationForm(fields, { hasSubmit: false, multiStep: false });
  assert.strictEqual(neither.ok, false);
  // a real submit still passes exactly as before (the three supported families' path)
  const real = ats.atsLooksLikeApplicationForm(fields, { hasSubmit: true });
  assert.strictEqual(real.ok, true);
  assert.strictEqual(real.multiStep, false);
});

test("isolation: atsLooksLikeApplicationForm still REFUSES page chrome (Crown / Dayforce JD pages)", () => {
  // Crown's only two <form> tags held nothing but search/alert controls; the Dayforce JD page's only
  // controls were cookie-banner checkboxes + a language picker. Both must stay refused.
  const chrome1 = [{ fieldName: "q", label: "Search by Keyword", widgetType: "text" },
                   { fieldName: "locationsearch", label: "Search by Location", widgetType: "text" },
                   { fieldName: "frequency", label: "Select how often (in days) to receive an alert", widgetType: "text" }];
  assert.strictEqual(ats.atsLooksLikeApplicationForm(chrome1, { hasSubmit: true }).ok, false);
  const chrome2 = [{ fieldName: "lang-select", label: "English (United States)", widgetType: "text" }];
  assert.strictEqual(ats.atsLooksLikeApplicationForm(chrome2, { hasSubmit: true, multiStep: true }).ok, false);
});

// ── END-TO-END against a REAL captured scan ─────────────────────────────────────────────
// This raw object is the VERBATIM output of atsInjScanGeneric run against the live
// https://www.kefrobotics.com/careers/gnc form on 2026-08-12 (a custom Wix employer page — the pure
// long-tail case). It is the closest thing to an integration test the resolution layer can have.
const KEF_LIVE_SCAN = {
  ats: "generic", url: "https://www.kefrobotics.com/careers/gnc", title: "GNC | KEF Robotics",
  usedFormTag: true, excluded: [], submitState: { hasSubmit: true, texts: ["Upload Resume", "Submit"] },
  fields: [
    { attrId: "first-name", domIndex: 0, inputSel: 'input[name="first-name"]', widgetType: "text", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "First name", unitLabel: "First name" } },
    { attrId: "last-name", domIndex: 1, inputSel: 'input[name="last-name"]', widgetType: "text", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "Last name", unitLabel: "Last name" } },
    { attrId: "email", domIndex: 2, inputSel: 'input[name="email"]', widgetType: "text", reqAttr: true, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "Email", unitLabel: "Email" } },
    { attrId: "collection_comp-lpjwscz6", domIndex: 3, inputSel: "#collection_comp-lpjwscz6", widgetType: "dropdown_native", reqAttr: false, reqMarker: false, labelShared: false, options: [], optionsPlaceholderOnly: true, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "Are you a US Citizen?", unitLabel: "Are you a US Citizen?" } },
    { attrId: "textarea_comp-lpjwyoei", domIndex: 4, inputSel: "#textarea_comp-lpjwyoei", widgetType: "textarea", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "How many years of experience do you have with GNC/SLAM?", placeholder: "Add answer here", unitLabel: "How many years of experience do you have with GNC/SLAM?" } },
    { attrId: "textarea_comp-lpjwpit22", domIndex: 5, inputSel: "#textarea_comp-lpjwpit22", widgetType: "textarea", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "Optional cover letter", unitLabel: "Optional cover letter" } },
    { attrId: "fileInputcomp-lpjx9isk", domIndex: 6, inputSel: "#fileInputcomp-lpjx9isk", widgetType: "file_upload", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { adjacentText: "Upload Resume Upload supported file (Max 15MB)", heading: "GNC Engineer, Slam focus", unitLabel: "Upload Resume" } },
  ],
};

test("LIVE KEF Robotics: the captured scan resolves to the right 7 fields", () => {
  const s = ats.atsGenericPostProcess(KEF_LIVE_SCAN);
  assert.strictEqual(s.fields.length, 7);
  assert.deepStrictEqual(s.fields.map((f) => f.label), [
    "First name", "Last name", "Email", "Are you a US Citizen?",
    "How many years of experience do you have with GNC/SLAM?", "Optional cover letter", "Upload Resume",
  ]);
  assert.deepStrictEqual(s.fields.map((f) => f.widgetType), [
    "text", "text", "text", "dropdown_native", "textarea", "textarea", "file_upload",
  ]);
  // ⚠ the page's ONE <h1> ("GNC Engineer, Slam focus") is a candidate for all 7 fields, so the
  // section-heading guard must refuse it for every one of them
  assert.ok(!s.fields.some((f) => /GNC Engineer/.test(f.label)), "the job title must never become a field label");
  assert.ok(s.fields.every((f) => f.labelVia === "labelFor" || f.labelVia === "unitLabel"));
});

test("LIVE KEF Robotics: only `email` is required, and that is REPORTED not trusted as 'the rest are optional'", () => {
  const s = ats.atsGenericPostProcess(KEF_LIVE_SCAN);
  assert.deepStrictEqual(s.fields.filter((f) => f.isRequired).map((f) => f.fieldName), ["email"]);
  // the citizenship question is plainly required in practice but enforced in JS only — the form does
  // carry SOME signal (email), so this is not the noRequiredSignalAnywhere state
  assert.strictEqual(s.diag.noRequiredSignalAnywhere, false);
});

test("LIVE KEF Robotics: the lazy native select is placeholder-only ⇒ no vocabulary claimed", () => {
  const s = ats.atsGenericPostProcess(KEF_LIVE_SCAN);
  const cit = s.fields.find((f) => f.fieldName === "collection_comp-lpjwscz6");
  assert.strictEqual(cit.options, null);
  assert.strictEqual(cit.optionsPlaceholderOnly, true);
});

test("LIVE KEF Robotics: identified as an application form, and its résumé slot routes", () => {
  const s = ats.atsGenericPostProcess(KEF_LIVE_SCAN);
  const id = ats.atsLooksLikeApplicationForm(s.fields, KEF_LIVE_SCAN.submitState);
  assert.strictEqual(id.ok, true);
  assert.ok(id.hasResume && id.hasEmail && id.hasName);
  assert.strictEqual(s.diag.fileInputs, 1);
  const file = s.fields.find((f) => f.widgetType === "file_upload");
  assert.strictEqual(ats.atsRouteField("generic", file, {}, {}, {}, null).kind, "resume");
  // every id on this form is durable, so identity never falls back to a label here
  assert.strictEqual(s.diag.nonDurableIds, 0);
  assert.ok(s.fields.every((f) => f.identityFrom === "attr"));
});

// ── three bugs found by running the scanner against the LIVE Paylocity form (2026-08-12) ──
test("LIVE Paylocity: a radio group must not take an OPTION's text from unitLabel either", () => {
  // Found live: `info.howDidYouHearAboutUs` resolved to "Advertisement-Print" — its first option —
  // because the field UNIT contains the option labels. Dropping labelFor/labelWrap was not enough.
  // The scanner now recomputes a group's unit label (legend first, else a non-member label), so by
  // the time the resolver sees it the option text is gone. This pins the resolver end of that: an
  // option-looking unitLabel is all the group has, and the ordinal/identity path must still hold.
  const s = ats.atsGenericPostProcess({
    fields: [{ attrId: "info.howDidYouHearAboutUs", inputSel: 'input[name="info.howDidYouHearAboutUs"]',
      widgetType: "radio", domIndex: 0, options: ["Advertisement-Print", "Employee Referral", "Job Board"],
      labelCandidates: { unitLabel: "How did you hear about us?" } }],
  });
  assert.strictEqual(s.fields[0].label, "How did you hear about us?");
  assert.deepStrictEqual(s.fields[0].options, ["Advertisement-Print", "Employee Referral", "Job Board"]);
});

test("LIVE Paylocity: only ONE résumé slot is primary when a form offers two upload routes", () => {
  // btn-forceResume ("Apply with resume") and btn-resume ("Fill out application with my resume") both
  // match the résumé wording. Attaching to both would upload twice and can start two server parses.
  const s = ats.atsGenericPostProcess({
    fields: [
      { attrId: "btn-forceResume", inputSel: "#btn-forceResume", widgetType: "file_upload", domIndex: 0,
        labelCandidates: { adjacentText: "Upload Resume" } },
      { attrId: "btn-resume", inputSel: "#btn-resume", widgetType: "file_upload", domIndex: 1,
        labelCandidates: { unitLabel: "Fill out application with my resume" } },
      { attrId: "btn-coverLetter", inputSel: "#btn-coverLetter", widgetType: "file_upload", domIndex: 2,
        labelCandidates: { unitLabel: "Upload Cover Letter" } },
    ],
  });
  assert.strictEqual(s.diag.fileInputs, 3);
  assert.strictEqual(s.diag.resumeSlots, 2, "the cover letter must not count as a résumé slot");
  assert.strictEqual(s.fields[0].primaryResumeSlot, true);
  assert.strictEqual(s.fields[1].primaryResumeSlot, false);
  const route = (f) => ats.atsRouteField("generic", f, {}, {}, {}, null);
  assert.strictEqual(route(s.fields[0]).kind, "resume");
  assert.strictEqual(route(s.fields[1]).kind, "skip", "the second upload route must not also receive it");
  assert.strictEqual(route(s.fields[2]).kind, "skip", "the cover letter must never receive the résumé");
});

test("LIVE Paylocity: required comes from the label for 10+ fields that carry NO attribute", () => {
  // Measured live: only the `public-site-address-*` fields set aria-required. Everything else marks
  // it as literal "(required)" text — so the label rung is carrying most of this form.
  const mk = (id, label, reqAttr) => ({ attrId: id, inputSel: "#" + id, widgetType: "text", domIndex: 0, reqAttr: !!reqAttr, labelCandidates: { unitLabel: label } });
  const s = ats.atsGenericPostProcess({ fields: [
    mk("info.firstName", "First Name (required)"), mk("info.lastName", "Last Name (required)"),
    mk("info.email", "Email Address (required)"), mk("info.cellPhone", "Mobile Number (required)"),
    mk("info.referredBy", "Referred by (required)"), mk("info.middleName", "Middle Name"),
    mk("public-site-address-city", "City", true),
  ] });
  const req = s.fields.filter((f) => f.isRequired).map((f) => f.fieldName);
  assert.strictEqual(req.length, 6);
  assert.ok(req.includes("info.firstName") && req.includes("info.referredBy"));
  assert.ok(!req.includes("info.middleName"));
  // and the marker is gone from every question
  assert.ok(!s.fields.some((f) => /required/i.test(f.label)), "no question may still carry '(required)'");
  // the label-text rung is what did the work for five of them
  assert.strictEqual(s.fields.filter((f) => f.reqVia === "label-text").length, 5);
  assert.strictEqual(s.fields.find((f) => f.fieldName === "public-site-address-city").reqVia, "attr");
});

test("LIVE Paylocity: the scanner strips NESTED labels, and finds a group's label[for=<name>]", () => {
  // Both earned live. The question label WRAPS its own option labels, so a plain textContent read gave
  // "How did you hear about us?(optional)Advertisement-PrintCollege-Recruiting Event…". And the
  // question is a label[for="info.howDidYouHearAboutUs"] — pointing at the group's shared NAME, not
  // at any input id — which is the only place it exists on that form.
  const src = ats.atsInjScanGeneric.toString();
  assert.ok(/label,legend,/.test(src), "nested label/legend must be in the filtered-read DROP list");
  assert.ok(/label\[for="' \+ esc\(first\.name\)/.test(src), "a group must look up label[for=<group name>]");
  // the ladder order for a group: legend, then label[for=name], then a non-option label
  const i = src.indexOf('querySelector("legend")');
  const j = src.indexOf("esc(first.name)");
  assert.ok(i > 0 && j > i, "legend must be tried before label[for=<name>]");
});

test("LIVE Paylocity: the resolved group question is clean and its (optional) marker is read", () => {
  // what the live scanner now hands the resolver, verbatim
  const s = ats.atsGenericPostProcess({
    fields: [{ attrId: "info.howDidYouHearAboutUs", inputSel: 'input[name="info.howDidYouHearAboutUs"]',
      widgetType: "radio", domIndex: 0, options: ["Advertisement-Print", "Employee Referral", "Other"],
      labelCandidates: { unitLabel: "How did you hear about us?(optional)" } }],
  });
  assert.strictEqual(s.fields[0].label, "How did you hear about us?");
  assert.strictEqual(s.fields[0].isRequired, false, "(optional) must be read as NOT required");
  assert.ok(!/Advertisement/.test(s.fields[0].label), "no option text may survive in the question");
});

test("LIVE Paylocity: 'Next Step' is reported as multiStep, never as a submit", () => {
  // the scanner's own submitState must use the SAME split as atsInjSubmitState
  const src = ats.atsInjScanGeneric.toString();
  assert.ok(/multiStep:/.test(src), "the generic scanner must report multiStep");
  // and the shared judgement accepts the page as a form while refusing to call it submittable
  const fields = [{ fieldName: "info.email", label: "Email Address", widgetType: "text" }];
  const id = ats.atsLooksLikeApplicationForm(fields, { hasSubmit: false, multiStep: true });
  assert.strictEqual(id.ok, true);
  assert.strictEqual(id.hasSubmit, false);
});

// ── ISOLATION: the generic kind must not leak into the supported families ───────────────
test("isolation: detectAts NEVER returns 'generic'", () => {
  const urls = [
    "https://job-boards.greenhouse.io/x/jobs/1", "https://jobs.lever.co/x/uuid",
    "https://jobs.ashbyhq.com/x/uuid", "https://magna.wd3.myworkdayjobs.com/x/job/1",
    "https://recruiting.paylocity.com/Recruiting/Jobs/Details/1", "https://example.com/careers",
    "https://jobs.dayforcehcm.com/en-US/x/y/jobs/1", "https://www.kefrobotics.com/careers/gnc",
  ];
  for (const u of urls) assert.notStrictEqual(ats.detectAts(u), "generic");
});

test("isolation: atsCaptureChoiceOptions is a NO-OP for the three supported families", () => {
  const act = { eval: async () => { throw new Error("must not touch a non-generic run"); }, delayFull: async () => {} };
  const scan = { fields: [{ fieldName: "q", inputSel: "#q", widgetType: "select", label: "Q" }] };
  const mk = () => [{ fieldName: "q", status: "skipped" }];
  return Promise.all(["greenhouse", "lever", "ashby", "workday", undefined].map((kind) => {
    const results = mk();
    return ats.atsCaptureChoiceOptions(act, kind, scan, results).then((r) => {
      assert.strictEqual(r.captured, 0, kind + " must be untouched");
      assert.ok(!results[0].options, kind + " must be untouched");
    });
  }));
});

test("isolation: atsFormUrl leaves a generic/unknown URL untouched", () => {
  const u = "https://recruiting.paylocity.com/Recruiting/Jobs/Details/4128182";
  assert.strictEqual(ats.atsFormUrl("generic", u), u);
});
