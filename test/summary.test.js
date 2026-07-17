// Unit tests for summary-lib.js — the PURE helpers behind the review-summary viewer
// (edit provenance, checkbox token families, the effective-replay value, and the Plan-2
// approval roll-up). The viewer (summary.js) is DOM/chrome.* and untestable here; these are
// the logic seams it (and the future SUBMIT) depend on — the first tests for the summary path.
const { test } = require("node:test");
const assert = require("node:assert");
const { editKindOf, checkedOf, tokenFor, effectiveValue, requiresApproval, isCascadeRevealed, approvalEnvelope, submitReady, hasPlaceholder, SUMMARY_PLACEHOLDER_MARK, isCurrentlyWorkHere, isWorkExpEndDate, isHiddenPreferredName, isPreferredNameField, isPreferredCheckField, ensurePreferredNameEntries, visibleEntryItems, newEntryRecords } = require("../summary-lib.js");

// ── 2b: operator-added repeating-section entries ──
test("editKindOf: an is_added entry is STICKY 'added_entry' (even after a value edit)", () => {
  assert.strictEqual(editKindOf({ is_added: true, original_ai_value: null, current_value: null }), "added_entry");
  // a value edit must NOT flip it to filled_blank/override — replay needs to know the entry is NEW
  assert.strictEqual(editKindOf({ is_added: true, original_ai_value: null, current_value: "Acme Inc" }), "added_entry");
  assert.strictEqual(editKindOf({ is_added: true, original_ai_value: "x", current_value: "y" }), "added_entry");
});
test("newEntryRecords: builds engine-format field_id/canonical, is_added, sticky edit_kind, flagged", () => {
  const shape = [
    { recName: "url", path: "url", widget_type: "text", is_required: true, label: "URL*" },
    { recName: "kind", path: "kind", widget_type: "dropdown", is_required: false, label: "Type", options: ["Personal", "Work"] },
  ];
  const recs = newEntryRecords(shape, { page: "p2", pageNumber: 2, pageLabel: "Page 2", sectionKey: "website", index: 4, at: "2026-06-30T00:00:00Z" });
  assert.strictEqual(recs.length, 2);
  const [a, b] = recs;
  assert.strictEqual(a.field_id, "p2::formField-website[4].url");      // engine field_id format
  assert.strictEqual(a.canonical_field, "website[4].url");             // groups under "website", index 4
  assert.strictEqual(a.is_added, true);
  assert.strictEqual(a.added_at, "2026-06-30T00:00:00Z");
  assert.strictEqual(a.edit_kind, "added_entry");
  assert.strictEqual(a.needs_review, true);                            // unverified by construction → must be approved
  assert.strictEqual(a.needs_review_reason, "added_entry");
  assert.strictEqual(a.flag, "added-entry");
  assert.strictEqual(a.current_value, null);
  assert.strictEqual(a.fill_status, "not_filled");
  assert.strictEqual(a.page_number, 2);
  assert.deepStrictEqual(b.options, ["Personal", "Work"]);             // options carried for the editor
  assert.strictEqual(b.question_label, "Type");
  // an added entry's field requires approval (blocks submit_ready until the operator approves)
  assert.strictEqual(requiresApproval(a), true);
});
test("newEntryRecords: missing label falls back to recName; flat page meta tolerated", () => {
  const recs = newEntryRecords([{ recName: "school_or_university", widget_type: "text" }], { sectionKey: "education", index: 0 });
  assert.strictEqual(recs[0].field_id, "formField-education[0].school_or_university"); // no page prefix when page null
  assert.strictEqual(recs[0].canonical_field, "education[0].school_or_university");     // path defaults to recName
  assert.strictEqual(recs[0].question_label, "school_or_university");
});

// ── editKindOf — the replay provenance ──
test("editKindOf: unedited → null (original === current)", () => {
  assert.strictEqual(editKindOf({ original_ai_value: "Bachelors", current_value: "Bachelors" }), null);
  assert.strictEqual(editKindOf({ original_ai_value: null, current_value: null }), null);
  assert.strictEqual(editKindOf({ original_ai_value: "", current_value: null }), null); // "" and null normalize equal
});
test("editKindOf: bot left blank, human filled → filled_blank", () => {
  assert.strictEqual(editKindOf({ original_ai_value: null, current_value: "Masters" }), "filled_blank");
});
test("editKindOf: bot filled, human cleared → cleared", () => {
  assert.strictEqual(editKindOf({ original_ai_value: "Masters", current_value: null }), "cleared");
});
test("editKindOf: human changed a filled value → override", () => {
  assert.strictEqual(editKindOf({ original_ai_value: "Bachelors", current_value: "Masters" }), "override");
});

// ── checkbox token families ──
test("checkedOf: recognizes the truthy token family + boolean", () => {
  for (const v of [true, "Checked", "true", "Yes", "1", "on", "ON"]) assert.strictEqual(checkedOf(v), true, `${v}`);
  for (const v of [false, "Unchecked", "No", "0", "off", null, ""]) assert.strictEqual(checkedOf(v), false, `${v}`);
});
test("tokenFor: round-trips within the bot's original family (no false override on flip-back)", () => {
  // original "Yes" → uncheck → "No" → re-check → "Yes" (same family, so editKindOf reads it correctly)
  assert.strictEqual(tokenFor("Yes", false), "No");
  assert.strictEqual(tokenFor("Yes", true), "Yes");
  assert.strictEqual(tokenFor("Checked", false), "Unchecked");
  assert.strictEqual(tokenFor("True", false), "False");
  assert.strictEqual(tokenFor(true, false), false);   // boolean original → boolean token
  assert.strictEqual(tokenFor(true, true), true);
  assert.strictEqual(tokenFor("weird", true), "Checked"); // unknown family → default
});
test("tokenFor + editKindOf: flipping a checkbox back to the bot's state reads as NOT edited", () => {
  const orig = "Yes";
  const off = tokenFor(orig, false);                          // "No"
  assert.strictEqual(editKindOf({ original_ai_value: orig, current_value: off }), "override");
  const backOn = tokenFor(orig, true);                        // "Yes"
  assert.strictEqual(editKindOf({ original_ai_value: orig, current_value: backOn }), null); // not edited
});

// ── effectiveValue — what SUBMIT (Plan 1) replays ──
test("effectiveValue: returns the edited value + kind + approved + deleted", () => {
  const e = { original_ai_value: "Bachelors", current_value: "Masters", is_approved: true, is_deleted: false };
  assert.deepStrictEqual(effectiveValue(e), { value: "Masters", kind: "override", approved: true, deleted: false });
});
test("effectiveValue: a cleared field → value null, kind cleared", () => {
  assert.deepStrictEqual(effectiveValue({ original_ai_value: "X", current_value: null }), { value: null, kind: "cleared", approved: false, deleted: false });
});
test("effectiveValue: a soft-deleted entry is flagged deleted (SUBMIT skips it)", () => {
  assert.strictEqual(effectiveValue({ original_ai_value: "X", current_value: "X", is_deleted: true }).deleted, true);
});

// ── placeholder detection (lockstep marker) ──
test("hasPlaceholder: detects the AI-2 sentinel", () => {
  assert.strictEqual(hasPlaceholder(SUMMARY_PLACEHOLDER_MARK + " — tell us why]"), true);
  assert.strictEqual(hasPlaceholder("a normal answer"), false);
  assert.strictEqual(hasPlaceholder(null), false);
});

// ── requiresApproval — only flagged, non-deleted fields ──
test("requiresApproval: flagged yes; un-flagged approved-by-default (no); deleted no", () => {
  assert.strictEqual(requiresApproval({ needs_review: true }), true);
  assert.strictEqual(requiresApproval({ needs_review: false }), false);          // un-flagged → approved by default
  assert.strictEqual(requiresApproval({ needs_review: true, is_deleted: true }), false);
});

test("#3: preferred first/last are HIDDEN when 'I have a preferred name' is unchecked (mirror the form)", () => {
  const check = (val) => ({ field_id: "P1::formField-preferredCheck", canonical_field: "personal_info.has_preferred_name", widget_type: "checkbox", current_value: val, page: "P1" });
  const fName = { field_id: "P1::formField-preferredName--firstName", canonical_field: "personal_info.preferred_first_name", widget_type: "text", current_value: "John", page: "P1" };
  // unchecked → hidden
  let es = [check("false"), fName];
  assert.strictEqual(isHiddenPreferredName(fName, es), true);
  // checked → shown
  es = [check("true"), fName];
  assert.strictEqual(isHiddenPreferredName(fName, es), false);
  // no controlling checkbox present → shown (don't hide blindly)
  assert.strictEqual(isHiddenPreferredName(fName, [fName]), false);
  // a non-preferred field is never hidden by this rule
  assert.strictEqual(isHiddenPreferredName({ field_id: "P1::formField-legalName--firstName", canonical_field: "personal_info.first_name", page: "P1" }, [check("false")]), false);
});

test("#3 (bug fix): a REALISTIC field_id whose page-key prefix LISTS preferredName--* must not hide the whole page", () => {
  // The real field_id embeds cdpPageKey = "pathname|sorted-field-names", which contains preferredName--firstName
  // etc. Testing the WHOLE field_id matched every page-1 field → the entire page vanished. Match the tail only.
  const pk = "/apply|country,legalName--firstName,preferredCheck,preferredName--firstName,preferredName--lastName,source";
  const mk = (name, cf, wt, val) => ({ field_id: pk + "::formField-" + name, canonical_field: cf, widget_type: wt || "text", current_value: val, page: pk });
  const check = mk("preferredCheck", "personal_info.has_preferred_name", "checkbox", "false");
  const pref = mk("preferredName--firstName", "personal_info.preferred_first_name", "text", "John");
  const legal = mk("legalName--firstName", "personal_info.first_name", "text", "Kevin");
  const src = mk("source", "personal_info.how_did_you_hear", "hierarchical", "LinkedIn");
  const all = [check, pref, legal, src];
  assert.strictEqual(isHiddenPreferredName(pref, all), true, "the preferred-name field IS hidden");
  assert.strictEqual(isHiddenPreferredName(legal, all), false, "legalName must NOT be hidden (this was the whole-page bug)");
  assert.strictEqual(isHiddenPreferredName(src, all), false, "source must NOT be hidden");
  assert.strictEqual(isHiddenPreferredName(check, all), false, "the checkbox itself is not a preferred-name field");
});

test("ensurePreferredNameEntries: synthesizes first+last (engine ids/canonicals) right AFTER the checkbox when absent", () => {
  const check = { field_id: "P1::formField-preferredCheck", canonical_field: "personal_info.has_preferred_name", widget_type: "checkbox", current_value: "true", page: "P1", page_number: 1, page_label: "My Information" };
  const other = { field_id: "P1::formField-source", canonical_field: "personal_info.how_did_you_hear", widget_type: "hierarchical", current_value: "LinkedIn", page: "P1" };
  const out = ensurePreferredNameEntries([check, other], check);
  assert.strictEqual(out.length, 4, "two rows added");
  // inserted immediately after the checkbox (index 0), before `other`
  assert.strictEqual(out[1].canonical_field, "personal_info.preferred_first_name");
  assert.strictEqual(out[2].canonical_field, "personal_info.preferred_last_name");
  assert.strictEqual(out[3].field_id, other.field_id, "the pre-existing field stays after the synthesized rows");
  // engine-format field ids so replay recognizes them
  assert.strictEqual(out[1].field_id, "P1::formField-preferredName--firstName");
  assert.strictEqual(out[2].field_id, "P1::formField-preferredName--lastName");
  // they are preferred-name fields, editable text, optional, flagged for the operator to fill
  assert.strictEqual(isPreferredNameField(out[1]), true);
  assert.strictEqual(out[1].widget_type, "text");
  assert.strictEqual(out[1].is_required, false);
  assert.strictEqual(out[1].needs_review, true);
  assert.strictEqual(out[1].is_added, true);
  assert.strictEqual(out[1].page_number, 1);
});

test("ensurePreferredNameEntries: no-op when both preferred fields already exist (only adds the MISSING one)", () => {
  const check = { field_id: "P1::formField-preferredCheck", canonical_field: "personal_info.has_preferred_name", widget_type: "checkbox", current_value: "true", page: "P1" };
  const first = { field_id: "P1::formField-preferredName--firstName", canonical_field: "personal_info.preferred_first_name", widget_type: "text", current_value: "Jo", page: "P1" };
  // both present → unchanged (same array reference back)
  const both = [check, first, { field_id: "P1::formField-preferredName--lastName", canonical_field: "personal_info.preferred_last_name", widget_type: "text", current_value: "Lee", page: "P1" }];
  assert.strictEqual(ensurePreferredNameEntries(both, check), both, "no additions → returns the list unchanged");
  // only first present → adds only last (no duplicate of first)
  const out = ensurePreferredNameEntries([check, first], check);
  assert.strictEqual(out.length, 3);
  assert.ok(out.some((e) => e.canonical_field === "personal_info.preferred_last_name"), "adds the missing last");
  assert.strictEqual(out.filter((e) => e.canonical_field === "personal_info.preferred_first_name").length, 1, "does not duplicate the existing first");
});

test("approvalEnvelope: a HIDDEN preferred field (checkbox unchecked) does NOT block submit; checking it does", () => {
  const check = (val) => ({ field_id: "P1::formField-preferredCheck", canonical_field: "personal_info.has_preferred_name", widget_type: "checkbox", current_value: val, page: "P1", needs_review: false, is_approved: false, is_deleted: false });
  const synthFirst = { field_id: "P1::formField-preferredName--firstName", canonical_field: "personal_info.preferred_first_name", widget_type: "text", current_value: null, page: "P1", needs_review: true, is_approved: false, is_deleted: false };
  // UNCHECKED → the synthesized preferred field is hidden → excluded from the approval count → submit_ready
  let ap = approvalEnvelope([check("false"), synthFirst]);
  assert.strictEqual(ap.to_approve_count, 0, "hidden preferred field not counted");
  assert.strictEqual(ap.submit_ready, true);
  // CHECKED → it's visible again → it DOES demand approval (blocks submit until approved)
  ap = approvalEnvelope([check("true"), synthFirst]);
  assert.strictEqual(ap.to_approve_count, 1, "visible preferred field counted");
  assert.strictEqual(ap.submit_ready, false);
});

test("M6: a cascade-REVEALED field FORCES approval even if it filled cleanly (needs_review false)", () => {
  assert.strictEqual(isCascadeRevealed({ cascade_revealed: true }), true);
  assert.strictEqual(isCascadeRevealed({ cascade_revealed: false }), false);
  assert.strictEqual(isCascadeRevealed({}), false);
  assert.strictEqual(requiresApproval({ needs_review: false, cascade_revealed: true }), true, "revealed → must be reviewed");
  assert.strictEqual(requiresApproval({ needs_review: false, cascade_revealed: true, is_deleted: true }), false, "deleted → excluded");
  // and it blocks submit until approved (approvalEnvelope counts it via requiresApproval)
  const ap = approvalEnvelope([{ needs_review: false, cascade_revealed: true, is_approved: false, is_deleted: false }]);
  assert.strictEqual(ap.submit_ready, false, "an unapproved revealed field blocks submit");
});

// ── approvalEnvelope / submitReady ──
const mk = (over) => Object.assign({ needs_review: false, is_approved: false, is_deleted: false, flag: null, current_value: null }, over);

test("approvalEnvelope: un-flagged-only bundle is submit_ready immediately (nothing to approve)", () => {
  const ap = approvalEnvelope([mk({}), mk({})]);
  assert.strictEqual(ap.to_approve_count, 0);
  assert.strictEqual(ap.all_approved, true);
  assert.strictEqual(ap.submit_ready, true);
});
test("approvalEnvelope: a flagged-unapproved field blocks submit; approving it unblocks", () => {
  const flagged = mk({ needs_review: true });
  let ap = approvalEnvelope([mk({}), flagged]);
  assert.strictEqual(ap.to_approve_count, 1);
  assert.strictEqual(ap.pending_count, 1);
  assert.strictEqual(ap.submit_ready, false);
  flagged.is_approved = true;
  ap = approvalEnvelope([mk({}), flagged]);
  assert.strictEqual(ap.approved_count, 1);
  assert.strictEqual(ap.all_approved, true);
  assert.strictEqual(ap.submit_ready, true);
});
test("approvalEnvelope: an unreplaced AI placeholder blocks submit even if all flagged are approved", () => {
  const ph = mk({ needs_review: true, is_approved: true, flag: "ai-text-needs-answer", current_value: SUMMARY_PLACEHOLDER_MARK + " …]" });
  const ap = approvalEnvelope([ph]);
  assert.strictEqual(ap.all_approved, true);            // it's approved...
  assert.strictEqual(ap.unreplaced_placeholders, 1);    // ...but the placeholder text remains
  assert.strictEqual(ap.submit_ready, false);           // so NOT ready
});
test("approvalEnvelope: a replaced placeholder (approved) IS submit_ready", () => {
  const fixed = mk({ needs_review: true, is_approved: true, flag: "ai-text-needs-answer", current_value: "My real answer" });
  assert.strictEqual(approvalEnvelope([fixed]).submit_ready, true);
});
test("approvalEnvelope: a soft-deleted required-flagged entry is EXCLUDED from the denominator", () => {
  const deleted = mk({ needs_review: true, is_deleted: true });
  const ap = approvalEnvelope([mk({}), deleted]);
  assert.strictEqual(ap.to_approve_count, 0);           // deleted doesn't count
  assert.strictEqual(ap.submit_ready, true);
});
test("submitReady: convenience predicate agrees with the envelope", () => {
  assert.strictEqual(submitReady([mk({ needs_review: true })]), false);
  assert.strictEqual(submitReady([mk({ needs_review: true, is_approved: true })]), true);
});

// ── "I currently work here" hides the "To" (endDate) row in the review (mirror the form) ──
const cwhField = (checked) => ({ widget_type: "checkbox", field_id: "P::formField-workExperience[0].currentlyWorkHere", canonical_field: "workExperience[0].currently_work_here", current_value: checked });
const endDateField = (over) => Object.assign({ widget_type: "date", field_id: "P::formField-workExperience[0].endDate", canonical_field: "workExperience[0].to", needs_review: false }, over || {});
const jobField = { widget_type: "text", field_id: "P::formField-workExperience[0].jobTitle", canonical_field: "workExperience[0].job_title" };

test("isCurrentlyWorkHere / isWorkExpEndDate: match the WE map's fields, not others", () => {
  assert.strictEqual(isCurrentlyWorkHere(cwhField("Yes")), true);
  assert.strictEqual(isCurrentlyWorkHere(jobField), false);                       // text field
  assert.strictEqual(isCurrentlyWorkHere({ widget_type: "checkbox", field_id: "P::formField-agreeToTerms" }), false);
  assert.strictEqual(isWorkExpEndDate(endDateField()), true);                     // canonical .to
  assert.strictEqual(isWorkExpEndDate({ field_id: "P::formField-workExperience[1].endDate" }), true); // by id
  assert.strictEqual(isWorkExpEndDate({ canonical_field: "workExperience[0].from" }), false); // startDate
  assert.strictEqual(isWorkExpEndDate(jobField), false);
});

test("visibleEntryItems: 'currently work here' CHECKED drops the (unflagged) To row", () => {
  const items = [cwhField("Yes"), jobField, endDateField()];
  const vis = visibleEntryItems(items);
  assert.ok(!vis.some(isWorkExpEndDate), "endDate hidden when currently-work-here is checked");
  assert.ok(vis.includes(jobField) && vis.some(isCurrentlyWorkHere), "other fields kept");
});

test("visibleEntryItems: UNCHECKED keeps the To row", () => {
  const items = [cwhField(false), jobField, endDateField()];
  assert.strictEqual(visibleEntryItems(items).length, 3);
  assert.ok(visibleEntryItems(items).some(isWorkExpEndDate));
});

test("visibleEntryItems: a FLAGGED endDate (today's-date fallback) is NOT hidden even when checked", () => {
  const items = [cwhField("Yes"), endDateField({ needs_review: true, flag: "we-currentwork-today" })];
  assert.ok(visibleEntryItems(items).some(isWorkExpEndDate), "a needs_review endDate stays visible to be verified");
});

test("visibleEntryItems: a non-WE entry set is returned unchanged", () => {
  const items = [{ widget_type: "dropdown", canonical_field: "education[0].degree" }];
  assert.deepStrictEqual(visibleEntryItems(items), items);
});
