const statusEl = document.getElementById("status");
const setStatus = (msg) => { statusEl.textContent = msg; };

// "Load default profile" — temporary stand-in for the future website→extension
// handoff. Today it reads the bundled data/profile.json and writes it into
// chrome.storage.local; later an external website (resume upload + profile UI)
// will be what populates storage. The fill engine only ever reads from storage,
// so this seeding step is the only thing that changes over time.
document.getElementById("load-profile").addEventListener("click", async () => {
  setStatus("Loading profile…");
  try {
    // Seed BOTH the profile (user data) and application_defaults (answer-preference
    // policy, e.g. how_did_you_hear) into storage. Both are part of the same
    // website→extension handoff; the engine reads them from storage at fill time.
    const [profileRes, defaultsRes] = await Promise.all([
      fetch(chrome.runtime.getURL("data/profile.json")),
      fetch(chrome.runtime.getURL("data/application_defaults.json"))
    ]);
    if (!profileRes.ok) {
      setStatus("data/profile.json not found — copy data/profile.example.json and fill it in.");
      return;
    }
    const profile = await profileRes.json();
    const toSet = { profile };
    let defaultsMsg = " (application_defaults.json missing — source → needs_review)";
    if (defaultsRes.ok) {
      toSet.defaults = await defaultsRes.json();
      defaultsMsg = " + defaults";
    }
    await chrome.storage.local.set(toSet);
    const keys = Object.keys(profile);
    setStatus(`Profile loaded${defaultsMsg} (${keys.length} sections: ${keys.slice(0, 4).join(", ")}…).`);
    console.log("[ApplyPilot] Seeded chrome.storage.local — profile keys:", keys, "| defaults:", toSet.defaults ? Object.keys(toSet.defaults) : "(none)");
  } catch (e) {
    setStatus("Failed to load profile: " + e.message);
    console.log("[ApplyPilot] Load profile error:", e);
  }
});

// "Fill current page" — ask the service worker to inject the engine into the
// active tab. The per-field table lands in the SERVICE WORKER console.
document.getElementById("fill-page").addEventListener("click", () => {
  setStatus("Filling current page… (see the service worker console for the table)");
  chrome.runtime.sendMessage({ type: "RUN_FILL" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup may have closed; SW console still has the table
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false) {
      setStatus("Couldn't fill: " + resp.error);
    } else if (resp.ok) {
      const n = resp.summary && resp.summary.needs_review_count;
      const reviewMsg = (n != null) ? ` — ${n} need review` : "";
      let attachMsg = "";
      if (resp.attach) {
        attachMsg = resp.attach.attached
          ? ` · resume attached (${resp.attach.fileName || ""})`
          : ` · resume: ${resp.attach.skipped ? "none stored" : "NOT attached"}`;
      }
      setStatus("Done. " + JSON.stringify(resp.summary.byStatus) + reviewMsg + attachMsg + " — see the service worker console for the table.");
    }
  });
});

// "Fill 2 pages (walk)" — M15. Ask the SW to drive a two-page walk: fill page 1,
// click "Save and Continue", wait for the next page to load, re-inject, fill page 2,
// stop (hard cap of 2). The proven single-page "Fill current page" path is left
// untouched for isolated debugging. Per-page tables land in the SERVICE WORKER
// console; the popup just reports how far the walk got and why it stopped.
document.getElementById("walk-pages").addEventListener("click", () => {
  setStatus("Walking 2 pages… (see the service worker console for per-page tables)");
  chrome.runtime.sendMessage({ type: "RUN_WALK" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup may have closed; SW console still has the logs
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false) {
      setStatus("Couldn't walk: " + resp.error);
    } else if (resp.ok) {
      setStatus(`Walk done — filled ${resp.pagesFilled} page(s); stopped: ${resp.stoppedReason}. See the service worker console.`);
    }
  });
});

// CDP RECON (Step 1 of the CDP actuation port): ask the SW to attach
// chrome.debugger to THIS tab and probe hidden-tab input (text/dropdown/radio/
// checkbox + the keyboard contingency). The SW gates on the tab going hidden,
// so minimize within 60s of clicking. Everything lands in the SW console.
document.getElementById("cdp-recon").addEventListener("click", () => {
  setStatus("CDP recon… MINIMIZE the window now (60s window). Findings land in the service worker console as [CDP-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Recon failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Recon done — ${resp.errors} probe error(s), ${resp.sideEffects} side effect(s). Paste the [CDP-RECON] summary from the SW console.`);
    }
  });
});

// CDP FILL FULL PAGE (M38 Part 1 — the fold): flat fields + every present repeating
// section in one click. Run on My Experience (page 2); minimize within 60s. [CDP-PAGE].
document.getElementById("cdp-fill-page").addEventListener("click", () => {
  setStatus("CDP full-page fill starting… keep the tab VISIBLE for a fast fill (watch it) or minimize for slow/background. Results land in the service worker console as [CDP-PAGE].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_PAGE" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false) {
      setStatus("Full-page fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`${resp.session_warning ? "⚠ " + resp.session_warning + "\n" : ""}Full-page fill done — ${JSON.stringify(resp.counts)}, ${resp.needs_review} need review${resp.audit_flagged ? `, ${resp.audit_flagged} AUDIT-flagged` : ""}. See [CDP-PAGE].`);
    }
  });
});

// CDP WALK (M31): fill page 1 + a GUARDED Save & Continue with VPS/session detection.
// Halts "session expired" on a dead session; "advanced" on a clean transition (page-2
// fill deferred). On a LIVE session this DOES advance the application. Minimize within 60s.
document.getElementById("cdp-walk").addEventListener("click", () => {
  setStatus("CDP walk: filling each page → Save & Continue → to the REVIEW page (NEVER submits). Keep the tab VISIBLE to watch. Clear orphan cert specialties first. See [CDP-WALK].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_WALK" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false) {
      setStatus("CDP walk failed: " + resp.error + " — see the service worker console.");
    } else if (resp.reached_review) {
      setStatus(`✓ CDP walk reached the REVIEW page — ${resp.pages_filled} page(s) filled, NOT submitted. "View last summary". See [CDP-WALK].`);
    } else if (resp.session_expired) {
      setStatus(`⚠ SESSION EXPIRED after ${resp.pages_filled} page(s) — refresh, log in, reopen the form, retry. See [CDP-WALK].`);
    } else if (resp.stopped === "resume-not-attached") {
      setStatus(`⚠ Walk halted: resume not attached (required upload blocks advance). Upload a resume in the popup + clear any bad attachment, then re-run. ${resp.pages_filled} page(s) filled. See [CDP-WALK].`);
    } else if (resp.stopped && resp.stopped.indexOf("nav-timeout") === 0) {
      setStatus(`⚠ CDP walk halted at page ${resp.nav_timeout_page} (nav-timeout — page may be dirty, eyeball it). ${resp.pages_filled} page(s) filled. See [CDP-WALK].`);
    } else {
      setStatus(`CDP walk stopped — ${resp.stopped} (${resp.pages_filled} page(s) filled). See [CDP-WALK].`);
    }
  });
});

// CDP REFILL = REPLAY the reviewed bundle. After reviewing/editing/approving on the website, refill
// pulls that bundle and REPLAYS it onto the form — approved-flagged + unflagged + manually-changed fields
// alike — SKIP-IF-CORRECT (leaves a field already right, no edit) and NO re-fill / NO re-recon (the first
// fill already reconned). Same guarded walk to REVIEW; NEVER submits. (Identical to the DRY replay walk.)
document.getElementById("cdp-refill").addEventListener("click", () => {
  setStatus("CDP refill — pulling your website review, then REPLAYING the reviewed values (skip-if-correct; no re-fill, no re-recon); any page the first fill NEVER reached gets a FRESH fill → continues to REVIEW. Keep the tab VISIBLE. NEVER submits. See [CDP-REPLAY-WALK].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_REPLAY_WALK", refill: true }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.ok === false && resp.error === "no-bundle") setStatus('No saved review to refill — fill + review an application first.');
    else if (resp.ok === false) setStatus("Refill failed: " + resp.error + " — see the service worker console.");
    else if (resp.reached_review) setStatus(`✓ Refill reached REVIEW — ${resp.pages_replayed} page(s), NOT submitted. See [CDP-REPLAY-WALK].`);
    else if (resp.stopped === "replay-page-not-in-bundle") setStatus(`⚠ Refill HALTED on page ${resp.page} — no profile loaded, so a never-filled page can't be fresh-filled. Click "Load default profile", then refill. See [CDP-REPLAY-WALK].`);
    else if (resp.session_expired) setStatus(`⚠ SESSION EXPIRED during refill after ${resp.pages_replayed} page(s). See [CDP-REPLAY-WALK].`);
    else setStatus(`Refill stopped — ${resp.stopped} (${resp.pages_replayed != null ? resp.pages_replayed : "?"} page(s)). See [CDP-REPLAY-WALK].`);
  });
});

// M3 SUBMIT replay (DRY): replay the SAVED approved review-summary bundle onto the current page
// (flat + repeating), NO Next/Submit. Load the same page you filled (fresh). [CDP-REPLAY].
document.getElementById("cdp-replay-page").addEventListener("click", () => {
  setStatus("Dry replay — replaying the SAVED approved bundle onto THIS page (flat + repeating). Keep the tab VISIBLE. NO submit. Findings → SW console [CDP-REPLAY].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_REPLAY_PAGE" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup may have lost focus — SW console has it all
    if (resp.ok === false && resp.error === "no-bundle") {
      setStatus('No saved summary to replay — fill a page first, then dry-replay it. ("View last summary" to confirm.)');
    } else if (resp.ok === false) {
      setStatus("Replay failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Dry replay done — ${resp.flat} flat + ${resp.repeating} repeating record(s), ${resp.needs_review} need review. NO submit. See [CDP-REPLAY].`);
    }
  });
});

// M3 SUBMIT replay WALK (DRY): replay the SAVED approved bundle page-by-page to the review page,
// verifying + advancing (guarded), NEVER submitting. Load page 1 of a filled app. [CDP-REPLAY-WALK].
document.getElementById("cdp-replay-walk").addEventListener("click", () => {
  setStatus("Dry replay WALK — replaying the SAVED approved bundle page-by-page to the REVIEW page (verify + guarded Save & Continue). Keep the tab VISIBLE. NEVER submits. See [CDP-REPLAY-WALK].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_REPLAY_WALK" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup may have lost focus — SW console has it all
    if (resp.ok === false && resp.error === "no-bundle") {
      setStatus('No saved summary to replay — fill + review an application first.');
    } else if (resp.ok === false) {
      setStatus("Replay walk failed: " + resp.error + " — see the service worker console.");
    } else if (resp.reached_review) {
      setStatus(`✓ Replay walk reached the REVIEW page — ${resp.pages_replayed} page(s) replayed + verified, NOT submitted. See [CDP-REPLAY-WALK].`);
    } else if (resp.stopped === "replay-mismatch") {
      setStatus(`⚠ Replay HALTED on page ${resp.page}: ${resp.failed ? resp.failed.length : "some"} field(s) the live form no longer offers — never guessed. See [CDP-REPLAY-WALK].`);
    } else if (resp.stopped === "replay-blocked") {
      setStatus(`⚠ Replay HALTED on page ${resp.nav_timeout_page} — page didn't advance (a required field is empty, likely a cascade-revealed field). Eyeball + re-review. See [CDP-REPLAY-WALK].`);
    } else if (resp.stopped === "replay-page-not-in-bundle") {
      setStatus(`⚠ Replay HALTED on page ${resp.page} — the approved bundle doesn't cover this page. Start on page 1 of the SAME application you filled. See [CDP-REPLAY-WALK].`);
    } else if (resp.session_expired) {
      setStatus(`⚠ SESSION EXPIRED after ${resp.pages_replayed} page(s) — refresh, log in, reopen, retry. See [CDP-REPLAY-WALK].`);
    } else if (resp.stopped === "resume-not-attached") {
      setStatus(`⚠ Replay halted: resume not attached (required upload blocks advance). Upload one + clear any bad attachment, then re-run. See [CDP-REPLAY-WALK].`);
    } else {
      setStatus(`Replay walk stopped — ${resp.stopped} (${resp.pages_replayed} page(s) replayed). See [CDP-REPLAY-WALK].`);
    }
  });
});

// M5 ARMED SUBMIT (SIMULATED): replay → review → FULL precondition gate → if it passes, LOG
// "▶▶ WOULD CLICK SUBMIT ◀◀" and STOP. Does NOT actually submit yet (simulateSubmit hardcoded on).
document.getElementById("cdp-submit").addEventListener("click", () => {
  setStatus("Armed SUBMIT (SIMULATED) — replaying to review + running the FULL gate. If every check passes it LOGS 'would click submit' and STOPS (no real submit). Keep the tab VISIBLE. See [CDP-REPLAY-WALK].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_SUBMIT" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup may have lost focus — SW console has it all
    if (resp.ok === false && resp.error === "no-bundle") {
      setStatus('No saved summary to replay — fill + review an application first.');
    } else if (resp.ok === false) {
      setStatus("Armed submit failed: " + resp.error + " — see the service worker console.");
    } else if (resp.would_submit) {
      setStatus(`✅ GATE PASSED — WOULD CLICK SUBMIT (simulated, NOT clicked). Every precondition is satisfied. See [CDP-REPLAY-WALK].`);
    } else if (resp.stopped === "submit-blocked") {
      setStatus(`⛔ SUBMIT BLOCKED — ${resp.blockers ? resp.blockers.length : "some"} precondition(s) not met (see [CDP-REPLAY-WALK] for the list). Nothing submitted.`);
    } else if (resp.stopped === "replay-mismatch") {
      setStatus(`⚠ HALTED on page ${resp.page}: ${resp.failed ? resp.failed.length : "some"} field(s) the live form no longer offers. See [CDP-REPLAY-WALK].`);
    } else if (resp.stopped === "replay-blocked") {
      setStatus(`⚠ HALTED on page ${resp.nav_timeout_page} — page didn't advance (a required field empty / cascade-revealed). Eyeball + re-review. See [CDP-REPLAY-WALK].`);
    } else if (resp.stopped === "replay-page-not-in-bundle") {
      setStatus(`⚠ HALTED on page ${resp.page} — the bundle doesn't cover this page. Start on page 1 of the SAME app. See [CDP-REPLAY-WALK].`);
    } else if (resp.session_expired) {
      setStatus(`⚠ SESSION EXPIRED after ${resp.pages_replayed} page(s) — refresh, log in, reopen, retry. See [CDP-REPLAY-WALK].`);
    } else if (resp.stopped === "resume-not-attached") {
      setStatus(`⚠ Halted: resume not attached (required upload blocks advance). Upload one, then re-run. See [CDP-REPLAY-WALK].`);
    } else {
      setStatus(`Armed submit stopped — ${resp.stopped} (${resp.pages_replayed} page(s) replayed). See [CDP-REPLAY-WALK].`);
    }
  });
});

// SESSION RECON (M30 Step 0): read-only static snapshot to classify live-form vs
// logged-out/expired. No minimize. Run on a VALID form + a LOGGED-OUT state, diff.
document.getElementById("cdp-session-recon").addEventListener("click", () => {
  setStatus("Session recon (static read, no minimize). Run once on a VALID form and once LOGGED-OUT, paste both [SESSION-RECON] blocks from the SW console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_SESSION_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.ok === false) {
      setStatus("Session recon failed: " + resp.error + " — see the service worker console.");
    } else {
      const s = resp.snapshot || {};
      setStatus(`Session recon: fields=${s.formFieldCount}, login=${s.passwordInputPresent || s.signInButtonPresent}, vps=${s.vpsErrorPresent}, sessionBanner=${s.sessionBanner}. Paste [SESSION-RECON] from the SW console.`);
    }
  });
});

// REPEATING-SECTION RECON (M32 Step 0): the first step of porting page-2 (My
// Experience) repeating sections to CDP. Read-only structure dump + Websites
// shape check + a bounded date-spinbutton probe. Run on My Experience (page 2);
// minimize within 60s. Output is [REPEAT-RECON] in the SW console.
document.getElementById("cdp-repeat-recon").addEventListener("click", () => {
  setStatus("Repeating-section recon… open My Experience (page 2), then MINIMIZE now (60s). Findings land in the service worker console as [REPEAT-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_REPEAT_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false && resp.error === "no-repeating-sections") {
      setStatus("No repeating sections on this page — navigate to My Experience (page 2) and re-run.");
    } else if (resp.ok === false) {
      setStatus("Repeating-section recon failed: " + resp.error + " — see the service worker console.");
    } else {
      const sp = (resp.scan && resp.scan.sectionsPresent) || [];
      const dp = resp.probe || {};
      const date = !dp.attempted ? "no date field" : (dp.anyMethodStuck ? "date OK" : "DATE BLOCKED");
      setStatus(`Repeating recon done — sections: ${sp.join(", ") || "none"}; ${date}. Paste the [REPEAT-RECON] summary from the SW console.`);
    }
  });
});

document.getElementById("cdp-page-recon").addEventListener("click", () => {
  setStatus("Page-identity recon (READ-ONLY)… dumps title/markers/automation-ids/body text for whatever page is showing. See [CDP-PAGE-RECON] in the service worker console, then paste the whole block.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_PAGE_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.ok === false) {
      setStatus("Page recon failed: " + resp.error + " — see the service worker console.");
    } else {
      const m = (resp.dump && resp.dump.markers) || {};
      const tags = Object.keys(m).filter((k) => m[k]);
      setStatus(`Page recon done — title "${(resp.dump && resp.dump.title) || ""}", ${(resp.dump && resp.dump.formFieldCount) || 0} formFields, markers: ${tags.join(", ") || "none"}. See [CDP-PAGE-RECON] — paste the whole block here.`);
    }
  });
});

// ── M16.2: resume upload → IndexedDB ────────────────────────────────────────
// One fixed resume, stored as base64 under resume:default (db.js, loaded before
// this script). The SW reads these bytes and passes them as a string into the
// attach injection — a File can't cross the boundary. FileReader gives a data: URL;
// we strip the "data:…;base64," prefix to store RAW base64 (what atob() wants in
// the page). IndexedDB, not chrome.storage: a real resume's base64 exceeds its quota.
const resumeStatusEl = document.getElementById("resume-status");
const showSavedResume = async () => {
  try {
    const rec = await getResume();
    resumeStatusEl.textContent = rec && rec.filename ? `Saved resume: ${rec.filename}` : "Saved resume: none";
  } catch (e) {
    resumeStatusEl.textContent = "Saved resume: (read error) " + e.message;
  }
};
showSavedResume();

document.getElementById("resume-file").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  resumeStatusEl.textContent = `Saving ${file.name}…`;
  const reader = new FileReader();
  reader.onerror = () => {
    resumeStatusEl.textContent = "Failed to read file: " + (reader.error && reader.error.message);
  };
  reader.onload = async () => {
    try {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      await saveResume({
        key: RESUME_KEY,
        filename: file.name,
        mime: file.type || "application/pdf",
        size: file.size,
        base64,
        savedAt: Date.now()
      });
      await showSavedResume();
      console.log("[ApplyPilot] Resume saved to IndexedDB:", file.name, `(${file.size} bytes, base64 ${base64.length} chars)`);
    } catch (err) {
      resumeStatusEl.textContent = "Failed to save resume: " + err.message;
      console.log("[ApplyPilot] Resume save error:", err);
    }
  };
  reader.readAsDataURL(file);
});

// "View last summary" — open the persistent reviewSummary viewer in its own tab.
// summary.html is an extension page, so it's reachable via getURL without any
// web_accessible_resources entry, and summary.js can read chrome.storage directly.
document.getElementById("view-summary").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("summary.html") });
});

// Clear the accumulated review summary — the reset for a fresh application. The CDP
// full-page fill / walk accumulates write-per-page (so the walk builds ONE whole-
// application summary), which means prior/stale pages persist across runs; this is the
// manual reset. The popup can write chrome.storage directly (no SW round-trip).
document.getElementById("clear-summary").addEventListener("click", () => {
  chrome.storage.local.remove("reviewSummary", () => setStatus("Review summary cleared — the next fill starts a fresh summary."));
});

// Job-context (per-posting company) — TEMPORARY manual entry. This is a SEPARATE
// storage key from `profile`/`defaults` (those are stable across applications);
// later the JD-page extraction will write `jobContext` automatically. Restore the
// saved value on open so it's visible; "Set company" persists it to storage.
const companyEl = document.getElementById("company");
chrome.storage.local.get("jobContext", ({ jobContext }) => {
  if (jobContext && jobContext.company) companyEl.value = jobContext.company;
});
document.getElementById("set-company").addEventListener("click", async () => {
  const company = companyEl.value.trim();
  await chrome.storage.local.set({ jobContext: { company } });
  setStatus(company ? `Company set for this application: "${company}".` : "Company cleared.");
  console.log("[ApplyPilot] jobContext set:", { company });
});

// QUESTIONS RECON (AI-1 Step 1): read-only dump of the screening-questions page — verbatim
// labels + each dropdown's options + a clean-close proof (open→read→dismiss, NEVER commits).
// Output is [Q-RECON] in the service worker console.
document.getElementById("cdp-questions-recon").addEventListener("click", () => {
  setStatus("Screening-questions recon… open the QUESTIONS page (page 3+) and keep it VISIBLE. Findings land in the service worker console as [Q-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_QUESTIONS_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // SW console has it all
    if (resp.ok === false) { setStatus("Questions recon failed: " + resp.error + " — see the service worker console."); return; }
    const dirty = resp.strayed ? ` ⚠ ${resp.strayed} STRAYED` : "";
    setStatus(`Recon done — ${resp.dropdowns.length} dropdown(s), ${resp.dropdowns.length - resp.strayed} clean${dirty}. See [Q-RECON] in the SW console.`);
  });
});

// REVIEW-PAGE CHECK (end-to-end fill-verify): on the FINAL review page, scrape the displayed values
// and diff them vs the saved reviewSummary bundle. Disagreements flag fill bugs. READ-ONLY — never
// submits. Output is [REVIEW-CHECK] in the service worker console.
document.getElementById("cdp-review-check").addEventListener("click", () => {
  setStatus("Review-page check… navigate to the FINAL review page (the walk stops there) and keep it VISIBLE. Findings land in the service worker console as [REVIEW-CHECK].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_REVIEW_CHECK" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // SW console has it all
    if (resp.ok === false) { setStatus("Review check failed: " + resp.error + " — are you on the review page? See the SW console."); return; }
    if (!resp.reconciled) { setStatus(`Scraped ${resp.scraped} value(s) but ${resp.note === "no-bundle" ? "no saved summary to check against" : resp.note} — see [REVIEW-CHECK].`); return; }
    const c = resp.counts;
    const bugs = c.disagree + c.missing_on_review;
    setStatus(`Review check: ${c.agree} agree · ${c.disagree} DISAGREE · ${c.missing_on_review} missing${bugs ? " ⚠ investigate" : " ✓"}. See [REVIEW-CHECK] in the SW console.`);
  });
});

// ── AI config (AI-0) — READ-ONLY MIRROR ─────────────────────────────────────
// The WEBSITE'S AI PAGE IS THE ONLY EDITOR. It owns chrome.storage.local.llmConfig and
// pushes it through AP_SET_LLM; that object now holds the per-provider key LIST, the
// per-action model routes and their fallback chains.
//
// Why this panel stopped being an editor: its Save built the flat
// {provider, model, apiKey, enabled} shape and wrote it over the WHOLE object, which
// silently destroyed keys/routes/fallbacks the moment anyone pressed it. Merging would have
// papered over the real problem — two editors for a config that is edited as one unit on the
// website. So: one owner, and this just shows what it decided.
const llmSummaryEl = document.getElementById("llm-summary");

// Enough to answer "is my AI set up?" without becoming a second source of truth.
function describeLlmConfig(c) {
  if (!c || !c.provider) return "AI: not configured yet — set it up on the website's AI page.";
  const keyCounts = ["gemini", "anthropic", "openai"]
    .map((p) => {
      const list = typeof llmKeysFor === "function" ? llmKeysFor(c, p) : [];
      const on = list.filter((k) => k.key && k.enabled !== false);
      if (!on.length) return null;
      const free = on.filter((k) => k.tier === "free").length;
      return `${p} ×${on.length}${free ? ` (${free} free)` : ""}`;
    })
    .filter(Boolean);
  const routes = c.routes && typeof c.routes === "object" ? Object.keys(c.routes) : [];
  return [
    `AI fill ${c.enabled ? "ON" : "OFF"} — default ${c.provider}/${c.model || "(no model)"}`,
    keyCounts.length ? `Keys: ${keyCounts.join(", ")}` : "Keys: none — AI calls will fail",
    routes.length ? `Per-action: ${routes.join(", ")}` : "Per-action: all following the default"
  ].join("\n");
}

let llmConfigCache = {};
let webOriginCache = "";
const refreshLlmSummary = () =>
  chrome.storage.local.get(["llmConfig", "webOrigin"], ({ llmConfig, webOrigin }) => {
    llmConfigCache = llmConfig || {};
    webOriginCache = webOrigin || "";
    llmSummaryEl.textContent = describeLlmConfig(llmConfigCache);
  });
refreshLlmSummary();
// The website can push config while this popup is open; mirror it live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.llmConfig || changes.webOrigin)) refreshLlmSummary();
});

// Straight to the editor. The origin is whatever last synced (recorded by AP_SET_LLM), so the
// extension never hardcodes a site URL — dev is localhost, prod will be the real host.
document.getElementById("llm-open-site").addEventListener("click", () => {
  if (!webOriginCache) {
    setStatus("Not synced with the website yet — open its Connect page once, then this jumps straight to the AI page.");
    return;
  }
  chrome.tabs.create({ url: webOriginCache + "/app/ai" });
});
// Debug input-trace toggle — logs every CDP keystroke/click in the SW console. Saved IMMEDIATELY on
// change (no Save button — an easy on/off); cdp.js reads chrome.storage.local.debugInputTrace per run.
const debugInputTraceEl = document.getElementById("debug-input-trace");
chrome.storage.local.get("debugInputTrace", ({ debugInputTrace }) => { debugInputTraceEl.checked = !!debugInputTrace; });
debugInputTraceEl.addEventListener("change", () => chrome.storage.local.set({ debugInputTrace: debugInputTraceEl.checked }));
// Test the STORED config — no `config` in the message, so the SW reads what the website
// saved and rotates through the key list exactly as a real fill would. Writes nothing.
document.getElementById("llm-test").addEventListener("click", () => {
  const c = llmConfigCache;
  if (!c || !c.provider) { setStatus("No AI config yet — set one up on the website's AI page."); return; }
  setStatus(`Testing ${c.provider}/${c.model || "(no model)"}… see [LLM-TEST] in the service worker console.`);
  chrome.runtime.sendMessage({ type: "RUN_LLM_TEST" }, (resp) => {
    if (chrome.runtime.lastError || !resp) { setStatus("Test failed (no response) — see the service worker console."); return; }
    setStatus(resp.ok ? `✓ AI connected — reply: "${resp.text}".` : `✗ AI test failed: ${resp.error}`);
  });
});

// ── Onboarding (pre-form walk): credentials + Gmail auto-verify + start ──────
// credentials → chrome.storage.local.credentials (loaded from data/credentials.json,
// same handoff pattern as the profile). onboardConfig = { gmailEnabled, continueToWalk,
// startUrl } — the toggles + optional start URL, merged read-modify-write.
const credentialsStatusEl = document.getElementById("credentials-status");
const showSavedCredentials = () => chrome.storage.local.get("credentials", ({ credentials }) => {
  credentialsStatusEl.textContent = credentials && credentials.email ? `Credentials: ${credentials.email}` : "Credentials: none loaded";
});
showSavedCredentials();

document.getElementById("load-credentials").addEventListener("click", async () => {
  setStatus("Loading credentials…");
  // NON-dot filename on purpose: Chrome does not serve dotfiles from an unpacked extension via
  // getURL (profile.json works; .credentials.json would 404), so data/credentials.json is the
  // single source. Copy data/credentials.example.json → data/credentials.json. Gitignored (data/*).
  try {
    const res = await fetch(chrome.runtime.getURL("data/credentials.json"));
    if (!res || !res.ok) { setStatus("data/credentials.json not found — copy data/credentials.example.json to data/credentials.json and fill in email + password."); return; }
    const creds = await res.json();
    if (!creds.email || !creds.password) { setStatus("data/credentials.json is missing an email or password."); return; }
    await chrome.storage.local.set({ credentials: { email: creds.email, password: creds.password } });
    showSavedCredentials();
    setStatus(`Credentials loaded for ${creds.email}.`);
    console.log("[ApplyPilot] Loaded account credentials for", creds.email);
  } catch (e) { setStatus("Failed to load credentials: " + e.message); }
});

// Restore + persist onboardConfig. Each control saves immediately (read-modify-write merge).
const onboardGmailEl = document.getElementById("onboard-gmail");
const onboardContinueEl = document.getElementById("onboard-continue");
const onboardUrlEl = document.getElementById("onboard-url");
const saveOnboardConfig = async (patch) => {
  const { onboardConfig } = await chrome.storage.local.get("onboardConfig");
  await chrome.storage.local.set({ onboardConfig: { ...(onboardConfig || {}), ...patch } });
};
chrome.storage.local.get("onboardConfig", ({ onboardConfig }) => {
  const c = onboardConfig || {};
  onboardGmailEl.checked = !!c.gmailEnabled;
  onboardContinueEl.checked = c.continueToWalk === true;
  if (c.startUrl) onboardUrlEl.value = c.startUrl;
});
onboardGmailEl.addEventListener("change", () => saveOnboardConfig({ gmailEnabled: onboardGmailEl.checked }));
onboardContinueEl.addEventListener("change", () => saveOnboardConfig({ continueToWalk: onboardContinueEl.checked }));
onboardUrlEl.addEventListener("change", () => saveOnboardConfig({ startUrl: onboardUrlEl.value.trim() }));

document.getElementById("gmail-connect").addEventListener("click", () => {
  setStatus("Connecting to Gmail (a Chrome account picker/consent may appear)… see [GMAIL-TEST] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_GMAIL_TEST" }, (resp) => {
    if (chrome.runtime.lastError || !resp) { setStatus("Gmail test failed (no response) — see the service worker console."); return; }
    setStatus(resp.ok ? `✓ Gmail connected: ${resp.email} (${resp.messagesTotal} messages). Auto-verify can read this inbox.` : `✗ Gmail test failed: ${resp.error}`);
  });
});

// ── Job discovery (popup DRY RUN) ───────────────────────────────────────────
// The same sweep the website's Discover button drives, minus the backend: with no website
// there are no known job keys to filter against and nowhere to store the result, so this
// only LOGS. It's the debugging / first-look path — the real flow is /app/run → Discover.
const discoverSources = () => ({
  simplify: document.getElementById("discover-simplify").checked,
  linkedin: document.getElementById("discover-linkedin").checked,
  handshake: document.getElementById("discover-handshake").checked,
});

document.getElementById("discover-run").addEventListener("click", () => {
  const query = document.getElementById("discover-query").value.trim();
  const sinceDays = Number(document.getElementById("discover-days").value) || 7;
  setStatus("Discovering jobs (opens board tabs + one tab per posting for its description, then closes them)… see [DISCOVER] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_DISCOVER", sources: discoverSources(), query, sinceDays }, (resp) => {
    if (chrome.runtime.lastError || !resp) { setStatus("Discovery: no response — see the service worker console."); return; }
    if (resp.ok === false) { setStatus("Discovery failed: " + (resp.error || "unknown")); return; }
    const s = resp.stats || {};
    const per = Object.entries(s.bySource || {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
    setStatus(
      `✓ ${s.newJobs} new job(s) — ${per}. Scanned ${s.found}, skipped ${s.skippedKnown} known + ${s.skippedDupe} dupes; ` +
      `read ${s.jdOpened - s.jdFailed}/${s.jdOpened} descriptions. NOTHING was queued (popup dry run).` +
      (resp.notes && resp.notes.length ? " ⚠ " + resp.notes.join(" ") : "")
    );
  });
});

document.getElementById("discover-recon").addEventListener("click", () => {
  setStatus("Discovery recon: opening the board search pages read-only… see [DISCOVER-RECON] in the service worker console for the DOM dump.");
  chrome.runtime.sendMessage({ type: "RUN_DISCOVER_RECON", sources: discoverSources(), query: document.getElementById("discover-query").value.trim() }, (resp) => {
    if (chrome.runtime.lastError || !resp) { setStatus("Recon: no response — see the service worker console."); return; }
    if (resp.ok === false) { setStatus("Recon failed: " + (resp.error || "unknown")); return; }
    const names = Object.keys(resp.recon || {});
    setStatus(`✓ Recon dumped for: ${names.join(", ") || "nothing"}. Open the service worker console and copy the [DISCOVER-RECON] JSON.`);
  });
});

document.getElementById("cdp-onboard").addEventListener("click", () => {
  setStatus("Onboarding: apply → apply manually → login → verify → form. Keep the tab VISIBLE. See [ONBOARD] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_ONBOARD" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup may have closed on the account picker — SW console has it all
    // Order matters: a needs_operator halt is a SUCCESSFUL run that needs a human (show its detail);
    // only a genuine crash (attach/navigate/exception) is ok:false with an `error`. Check reached_form
    // → needs_operator → crash → other, so a halt never renders as "failed: undefined".
    if (resp.reached_form) {
      const walkMsg = resp.walked
        ? (resp.walk && resp.walk.reached_review ? ` Then the fill walk reached REVIEW (${resp.walk.pages_filled} page(s), not submitted).`
           : resp.walk ? ` Then the fill walk stopped: ${resp.walk.stopped || resp.walk.error}.` : "")
        : (resp.walk_error === "no-profile" ? ' (Load a profile to continue into the fill walk.)' : "");
      setStatus(`✓ Reached the application form (${resp.stopped}${resp.account_created ? ", account created" : ""}${resp.verified ? ", email verified" : ""}).${walkMsg}`);
    } else if (resp.needs_operator) {
      setStatus(`⚠ Needs you: ${resp.stopped}. ${resp.detail || ""}`);
    } else if (resp.ok === false) {
      setStatus("Onboarding failed: " + (resp.error || resp.stopped || "unknown") + " — see the service worker console.");
    } else {
      setStatus(`Onboarding stopped: ${resp.stopped || "unknown"}. ${resp.detail || ""} See [ONBOARD].`);
    }
  });
});
