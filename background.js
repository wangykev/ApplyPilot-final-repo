// Shared IndexedDB storage helpers (saveResume/getResume/RESUME_KEY). Classic MV3
// service worker, so importScripts brings db.js's functions into the SW scope (the
// popup loads the same file via <script>). Used by the M16.2 attach path to read
// the stored resume's bytes here, then pass them as a string into the injection.
importScripts("db.js", "lib.js", "llm.js", "gmail.js", "cdp.js", "fill-driver.js"); // db.js = IndexedDB storage; lib.js = pure helpers (parse*, match ladder, onboarding classifiers); llm.js = multi-provider LLM adapter (callLLM); gmail.js = Gmail auto-verify adapter (getAuthToken + readonly REST); cdp.js = CDP substrate (off-loop actuation + onboarding navigation); fill-driver.js = the substrate-agnostic CDP fill brain (needs lib.js loaded first)

// ============================================================================
// EXTERNAL messages from ApplyPilot Web (the website → extension handoff).
// Chrome only delivers onMessageExternal for origins in manifest
// externally_connectable.matches, so reaching here already means a trusted
// origin. This is the permanent website→extension contract (see WEBSITE.md):
// the website WRITES profile/defaults/jobContext/llmConfig + the resume bytes
// exactly into the same chrome.storage.local / IndexedDB slots the popup seeds,
// so the fill engine reads them unchanged. The engine is agnostic to how they
// got there. NOTHING here fills or submits — it only persists the handoff.
// ============================================================================
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  // Detection + status: the website pings to confirm the extension is installed
  // and reports what's already stored, so it can show "connected".
  if (type === "AP_PING") {
    (async () => {
      let hasResume = false;
      try { hasResume = !!(await getResume()); } catch (e) { /* ignore */ }
      chrome.storage.local.get("profile", ({ profile }) => {
        sendResponse({
          ok: true,
          app: "ApplyPilot",
          version: chrome.runtime.getManifest().version,
          hasProfile: !!profile,
          hasResume
        });
      });
    })();
    return true;
  }

  // The handoff bundle: profile + defaults + jobContext (RAW fields only).
  if (type === "AP_SYNC_PROFILE") {
    if (message.profile === undefined && message.defaults === undefined && message.jobContext === undefined) {
      sendResponse({ ok: false, error: "nothing to sync" }); return true;
    }
    // MERGE defaults, don't clobber: the website manages only `how_did_you_hear`, but the
    // extension's `defaults` also holds field_of_study/degree/gpa_range (from
    // application_defaults.json). A wholesale overwrite would wipe those, degrading the
    // default-matching ladder — so shallow-merge the incoming keys over the existing object.
    // `buckets` (answer buckets, Profile v2) are fully website-managed → stored wholesale.
    chrome.storage.local.get("defaults", ({ defaults: existingDefaults }) => {
      const data = {};
      if (message.profile !== undefined) data.profile = message.profile;
      if (message.jobContext !== undefined) data.jobContext = message.jobContext;
      if (message.buckets !== undefined) data.buckets = message.buckets;
      if (message.defaults !== undefined) {
        data.defaults = { ...(existingDefaults || {}), ...message.defaults };
      }
      chrome.storage.local.set(data, () => {
        const err = chrome.runtime.lastError;
        sendResponse(err ? { ok: false, error: err.message } : { ok: true, keys: Object.keys(data) });
      });
    });
    return true;
  }

  // AI config — same shape as the popup's llmConfig.
  if (type === "AP_SET_LLM") {
    if (!message.llmConfig || typeof message.llmConfig !== "object") {
      sendResponse({ ok: false, error: "no llmConfig" }); return true;
    }
    chrome.storage.local.set({ llmConfig: message.llmConfig }, () => {
      const err = chrome.runtime.lastError;
      sendResponse(err ? { ok: false, error: err.message } : { ok: true });
    });
    return true;
  }

  // Reporting credential for the extension→backend status path (P2) + the review PULL
  // endpoint (the website is the review surface now; the SW pulls the approved bundle from
  // reviewUrl before replay — see pullApprovedBundle). reviewUrl is optional for backward
  // compat (pullApprovedBundle derives it from ingestUrl when absent).
  if (type === "AP_SET_SESSION") {
    chrome.storage.local.set(
      {
        apSession: {
          ingestUrl: message.ingestUrl || "",
          ingestKey: message.ingestKey || "",
          reviewUrl: message.reviewUrl || "",
        },
      },
      () => {
        const err = chrome.runtime.lastError;
        sendResponse(err ? { ok: false, error: err.message } : { ok: true });
      }
    );
    return true;
  }

  // Resume bytes (base64 STRING — a File/Blob can't cross the message boundary),
  // written to IndexedDB exactly like the popup's upload path.
  if (type === "AP_SYNC_RESUME") {
    (async () => {
      try {
        if (!message.base64) { sendResponse({ ok: false, error: "no base64" }); return; }
        await saveResume({
          filename: message.filename || "resume.pdf",
          mime: message.mime || "application/pdf",
          size: message.size || 0,
          base64: message.base64,
          savedAt: Date.now()
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  sendResponse({ ok: false, error: "unknown message type: " + type });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // CDP RECON (Step 1 of the CDP actuation port): empirically pin down what
  // chrome.debugger INPUT can do to a HIDDEN tab — insertText vs per-char keys,
  // mouse vs keyboard commits, rect validity while hidden, commit latencies —
  // BEFORE the fill driver is built on those answers. Probes only the page's
  // existing widgets with restore-where-possible semantics; needs no profile.
  // Findings land in the SW console as [ApplyPilot][CDP-RECON] lines + one
  // summary JSON. Standalone — touches none of the RUN_FILL machinery.
  if (message.type === "RUN_CDP_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpRecon(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // GMAIL SMOKE TEST (onboarding prereq): prove getAuthToken + a readonly
  // users/me/profile call work, and show the connected inbox. Run this FIRST (after
  // creating the OAuth client) before trusting auto-verify. [GMAIL-TEST] in the SW console.
  if (message.type === "RUN_GMAIL_TEST") {
    (async () => { const out = await runGmailSmokeTest(true); sendResponse(out); })();
    return true; // async sendResponse
  }

  // ONBOARDING WALK (the pre-form stage): drive the ACTIVE tab from a job-description
  // page through Apply → Apply Manually → sign-in/create-account → email verification →
  // land on the application form. Reads credentials + onboardConfig from storage. By
  // default it STOPS on the form (never auto-advances a live application); it chains into
  // the existing CDP fill walk ONLY when onboardConfig.continueToWalk === true. [ONBOARD].
  if (message.type === "RUN_CDP_ONBOARD") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const store = await new Promise((r) => chrome.storage.local.get(["profile", "defaults", "jobContext", "credentials", "onboardConfig"], r));
      const cfg = store.onboardConfig || {};
      const onb = await runCdpOnboard(tab.id, { credentials: store.credentials || null, gmailEnabled: !!cfg.gmailEnabled, startUrl: cfg.startUrl || null });
      if (!onb.ok || !onb.reached_form || cfg.continueToWalk !== true) { sendResponse({ ...onb, walked: false }); return; }
      if (!store.profile) { sendResponse({ ...onb, walked: false, walk_error: "no-profile" }); return; }
      console.log("[ApplyPilot][ONBOARD] reached the form — continueToWalk is ON, chaining into the CDP fill walk.");
      const walk = await runCdpWalk(tab.id, store.profile, store.defaults || {}, store.jobContext || {});
      sendResponse({ ...onb, walked: true, walk });
    });
    return true; // async sendResponse
  }

  // SESSION RECON (M30 Step 0): read-only snapshot to classify live-form vs
  // logged-out/expired. No minimize needed. [SESSION-RECON] in the SW console.
  if (message.type === "RUN_CDP_SESSION_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpSessionRecon(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // REPEATING-SECTION RECON (M32 Step 0): the FIRST step of porting page-2 (My
  // Experience) repeating sections to CDP. READ-ONLY structure dump (sections
  // present → entries → per-entry fields with the composed entry-scoped selector,
  // add-button + delete-button rects) PLUS one bounded, restore-where-possible
  // DATE-SPINBUTTON probe (the key unknown — CDP has no native setter; a total
  // probe failure is a STOP-and-surface known-blocker, not a quiet fallback).
  // Run on My Experience (page 2); MINIMIZE within 60s (the date probe actuates).
  // [REPEAT-RECON] in the SW console. No profile needed.
  if (message.type === "RUN_CDP_REPEAT_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpRepeatRecon(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // CDP QUESTIONS RECON (AI-1 Step 1): READ-ONLY dump of the screening-questions page —
  // verbatim field labels + each dropdown's options + a per-dropdown clean-close PROOF
  // (open→read→dismiss, NEVER commits). [Q-RECON] in the SW console. No profile/LLM.
  if (message.type === "RUN_CDP_QUESTIONS_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpQuestionsRecon(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // REVIEW-PAGE CHECK (end-to-end fill-verify): on the FINAL review page — the one that renders every
  // filled value as read-only text (ground truth of what would submit) — scrape those displayed values
  // and reconcile them against the saved reviewSummary bundle (what the extension RECORDED it filled).
  // Disagreements flag fill bugs (the React value-revert class). READ-ONLY — never clicks Next/Submit.
  // [REVIEW-CHECK] in the SW console.
  if (message.type === "RUN_CDP_REVIEW_CHECK") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpReviewReconcile(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // CDP FILL FULL PAGE (M38 Part 1): the FOLD — one drivePageFill fills flat fields +
  // every present repeating section. [CDP-PAGE] in the SW console.
  if (message.type === "RUN_CDP_FILL_PAGE") {
    chrome.storage.local.get(["profile", "defaults", "jobContext"], ({ profile, defaults, jobContext }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-PAGE] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFillPage(tab.id, profile, defaults, jobContext);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // M3 SUBMIT replay (DRY): replay the SAVED approved review-summary bundle onto the current
  // page (flat + repeating) — NO Next, NO Submit. Uses the bundle, not the profile. [CDP-REPLAY].
  if (message.type === "RUN_CDP_REPLAY_PAGE") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpReplayPage(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // M3/M4 SUBMIT replay WALK: replay the SAVED approved bundle page-by-page to the REVIEW page,
  // verifying each field, advancing with the guarded clickPageNext. authorize:true (M5 armed button)
  // runs the M4 precondition gate at review and clicks SUBMIT once iff every check passes; otherwise
  // DRY (reach review + stop). Defaults to DRY (message.authorize absent). [CDP-REPLAY-WALK].
  if (message.type === "RUN_CDP_REPLAY_WALK") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpReplayWalk(tab.id, { authorize: message.authorize === true, refill: message.refill === true });
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // M5 ARMED SUBMIT: replay to review, run the FULL precondition gate (authorize:true), and — when it
  // passes — would click SUBMIT. ⚠ SAFETY: simulateSubmit:true is HARDCODED here, so this NEVER actually
  // clicks yet; it logs "▶▶ WOULD CLICK SUBMIT ◀◀" and stops (operator's choice). To go LIVE later, change
  // simulateSubmit to false (the ONLY change needed) + honor the eyes-on disposable-app hard gate.
  if (message.type === "RUN_CDP_SUBMIT") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpReplayWalk(tab.id, { authorize: true, simulateSubmit: true });
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // PAGE-IDENTITY RECON (read-only): dump title / URL / automation-ids / headings / body text + state
  // markers for ANY page (maintenance / dead session / login / error / a normal form) so an unknown page
  // state can be DETECTED in code instead of surfacing an opaque "unknown error". [CDP-PAGE-RECON] in SW.
  if (message.type === "RUN_CDP_PAGE_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpPageRecon(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // LLM TEST-CONNECTION (AI-0): round-trip a trivial prompt through the configured provider
  // to prove the call path + key + host_permissions BEFORE wiring the AI into the fill. The
  // popup sends the current config (test-before-save). No tab/attach needed (direct SW fetch).
  if (message.type === "RUN_LLM_TEST") {
    (async () => {
      const cfg = message.config || {};
      console.log("[ApplyPilot][LLM-TEST] testing", cfg.provider, "/", cfg.model, "…");
      const res = await callLLM({ provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, system: "You are a connectivity probe. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 16 });
      if (res.ok) console.log("[ApplyPilot][LLM-TEST] ✓ reply:", JSON.stringify(res.text));
      else console.log("[ApplyPilot][LLM-TEST] ✗", res.error);
      sendResponse(res);
    })();
    return true; // async sendResponse
  }

  // CDP WALK (M31): fill page 1 → guarded Save & Continue → detect VPS/session-death
  // (halt) or a clean transition (report "advanced", stop — page-2 fill deferred).
  if (message.type === "RUN_CDP_WALK") {
    chrome.storage.local.get(["profile", "defaults", "jobContext"], ({ profile, defaults, jobContext }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-WALK] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpWalk(tab.id, profile, defaults || {}, jobContext || {});
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // RUN_FILL = single page (the proven path, untouched). RUN_WALK = M15 two-page
  // walk (fill → Next → re-inject → fill, hard cap 2). Both share the same storage
  // read + active-tab lookup; they diverge on what they do with the tab.
  if (message.type !== "RUN_FILL" && message.type !== "RUN_WALK") return;

  // ─── Profile handoff point ──────────────────────────────────────────────────
  // The engine ALWAYS reads the profile from chrome.storage.local — this is the
  // permanent contract. Today the popup's "Load default profile" seeds storage
  // from data/profile.json, but later an external website (resume upload +
  // profile UI) will write the profile into chrome.storage and the extension
  // fills from there with zero upload at fill-time. The engine is agnostic to how
  // the profile got into storage; only the populating source changes over time
  // (hardcoded/file today → website handoff → maybe cloud sync).
  chrome.storage.local.get(["profile", "defaults", "jobContext"], ({ profile, defaults, jobContext }) => {
    if (!profile) {
      console.log('[ApplyPilot] No profile in storage — click "Load default profile" first.');
      sendResponse({ ok: false, error: "no-profile" });
      return;
    }
    console.log("[ApplyPilot] Profile loaded from storage. Top-level keys:", Object.keys(profile));
    console.log("[ApplyPilot] Defaults loaded:", defaults ? Object.keys(defaults) : "(none — source will needs_review)");
    console.log("[ApplyPilot] Job context:", jobContext || "(none — set the company in the popup)");

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) {
        console.log("[ApplyPilot] No active tab found.");
        sendResponse({ ok: false, error: "no-tab" });
        return;
      }

      if (message.type === "RUN_FILL") {
        console.log("[ApplyPilot] Filling active tab:", tab.url);
        const frameResult = await injectFill(tab.id, profile, defaults, jobContext);
        if (!frameResult) {
          sendResponse({ ok: false, error: "no-result" });
          return;
        }
        logFrameResult(frameResult, null);
        // Post-fill: attach the stored resume if this page has the upload widget
        // (no-op otherwise). Runs BEFORE persist so the bundle patch is saved once.
        const attach = await attachResumeForPage(tab.id, frameResult);
        await persistBundle(frameResult.bundle);
        sendResponse({ ok: true, summary: frameResult.summary, attach });
        return;
      }

      // RUN_WALK
      console.log("[ApplyPilot] Starting two-page walk on active tab:", tab.url);
      const walk = await runWalk(tab.id, profile, defaults, jobContext);
      sendResponse({ ok: true, ...walk });
    });
  });

  return true; // keep the message channel open for the async sendResponse
});

// ============================================================================
// Service-worker helpers (run in the SW, not injected). The SW does all I/O —
// injection, storage, logging, and (M15) the cross-page orchestration. The
// "engine computes / SW does I/O" boundary holds: the SW never reaches into the
// page DOM except by injecting a self-contained function and reading its return.
// ============================================================================

// SW data-prep (uses the pure, unit-tested lib.js helpers — the injected engine can't
// import them). Returns a CLONE of the profile whose repeating-section arrays are
// reduced to their MEANINGFUL entries and pre-annotated with parsed values, so the
// engine's `profile.work_experience` / `profile.education` ARE the lists to fill
// (length = how many entries to add) and the engine does no filtering/parsing itself:
//   work_experience[i]: fromParsed/toParsed ({year,month}|null via parseYearMonth — rejects
//     the "YYYY-MM" placeholder), bulletsText (joinBullets).
//   education[i]: fromYearParsed/toYearParsed (4-digit year|null via parseYear).
// Does not mutate the stored profile.
function prepareProfile(profile) {
  if (!profile) return profile;
  const out = { ...profile };
  if (Array.isArray(profile.work_experience)) {
    // Most-recent job FIRST (sort by end date; currently-held jobs first), regardless of the
    // profile's stored order — so the i-th filled form entry is the i-th most-recent job.
    out.work_experience = sortWorkExperienceByRecency(
      meaningfulEntries(profile.work_experience, ["job_title", "company"])
    ).map((e) => ({
      // roleDescription is now a single textarea (profile v2); fall back to legacy bullets[] for
      // older profiles. WORK_EXPERIENCE_MAP still reads `bulletsText` → the Workday role description.
      ...e, fromParsed: parseYearMonth(e.from), toParsed: parseYearMonth(e.to),
      bulletsText: (e.role_description != null && String(e.role_description).trim() !== "") ? String(e.role_description) : joinBullets(e.bullets)
    }));
  }
  if (Array.isArray(profile.education)) {
    out.education = meaningfulEntries(profile.education, ["school_or_university", "degree"]).map((e) => ({
      ...e, fromYearParsed: parseYear(e.from_year), toYearParsed: parseYear(e.to_year)
    }));
  }
  if (Array.isArray(profile.websites)) {
    out.websites = meaningfulEntries(profile.websites, ["url"]) // entries with a non-empty URL
      .map((e) => ({ ...e, url: ensureHttps(e.url) }));          // → full https:// URL
  }
  if (Array.isArray(profile.languages)) {
    const langs = meaningfulEntries(profile.languages, ["language"]).map((e) => ({
      // Explicit human-set `fluent` (true/false) WINS; a null/unset value falls back to the
      // reading+speaking+writing all-fluent derivation (back-compat for profiles predating the box).
      ...e, _allFluent: (e.fluent == null)
        ? (isFluent(e.reading) && isFluent(e.speaking) && isFluent(e.writing))
        : !!e.fluent // → check the "I am fluent" box
    }));
    // English LAST (operator, 2026-07-06): filling English as the last language entry reduces Workday's
    // spurious "duplicate languages not allowed" ghost error on Save & Continue. Stable partition — the
    // non-English entries keep their order; any English entry moves to the end.
    const isEnglish = (e) => /english/i.test(String((e && e.language) || ""));
    out.languages = [...langs.filter((e) => !isEnglish(e)), ...langs.filter(isEnglish)];
  }
  if (Array.isArray(profile.certifications)) {
    out.certifications = meaningfulEntries(profile.certifications, ["certification"]).map((e) => ({
      ...e, issuedDateParsed: parseYearMonthDay(e.issued_date), expirationDateParsed: parseYearMonthDay(e.expiration_date),
      // nested Specialties fill: parse each specialty's dates (the specialty value passes through). A
      // specialty with no `specialty` value is dropped (nothing to fill the required specialtyParent with).
      specialties: (Array.isArray(e.specialties) ? e.specialties : [])
        .filter((s) => s && s.specialty != null && String(s.specialty).trim() !== "")
        .map((s) => ({ ...s, startDateParsed: parseYearMonthDay(s.start_date), endDateParsed: parseYearMonthDay(s.end_date) }))
    }));
  }
  return out;
}

// Inject fillEngine into frame 0 of `tabId`; resolve the frame's result (or null
// on injection error / no result). Promise-wraps the executeScript callback so the
// walk can `await` it page by page.
function injectFill(tabId, profile, defaults, jobContext) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, frameIds: [0] },
        func: fillEngine,
        args: [prepareProfile(profile), defaults || null, jobContext || null]
      },
      (results) => {
        if (chrome.runtime.lastError) {
          console.log("[ApplyPilot] Injection error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        // executeScript returns one entry per frame; non-main frames (Workday
        // uses iframes) return null. Pick the frame whose result carries results.
        const frameResult = (results || []).map((r) => r.result).find((r) => r && r.results);
        if (!frameResult) {
          console.log("[ApplyPilot] No fill result from any frame.");
          resolve(null);
          return;
        }
        resolve(frameResult);
      }
    );
  });
}

// Persist the per-field review summary — ONLY on a fully completed page run. The
// engine computed the bundle; the SW does the storage I/O. M15 keeps the write
// AS-IS (overwrite per page): in a two-page walk reviewSummary ends as the LAST
// page filled. Multi-page ACCUMULATION (one whole-application summary) is the next
// round — deliberately NOT built here.
function persistBundle(bundle) {
  return new Promise((resolve) => {
    if (!bundle) { resolve(); return; }
    chrome.storage.local.set({ reviewSummary: bundle }, () => {
      console.log(`[ApplyPilot] Summary saved to storage — ${bundle.total} field(s), ${bundle.needs_review_count} need review. Open it with "View last summary" in the popup.`);
      resolve();
    });
  });
}

// M38 Part 2 — accumulate the CDP review-summary across pages, WRITE-PER-PAGE. Thin I/O
// wrapper: read the stored reviewSummary, merge this page's bundle via the PURE
// accumulateBundle (drops THIS page's prior entries, keeps OTHER pages VERBATIM so a
// viewer edit survives, recomputes the envelope), write. Eviction-robust (each page
// writes immediately). The page key is the PRE-fill cdpPageSig (stable per page, distinct
// across pages even on a same-URL SPA).
function persistAccumulated(pageBundle) {
  return new Promise((resolve) => {
    if (!pageBundle) { resolve(); return; }
    chrome.storage.local.get("reviewSummary", ({ reviewSummary }) => {
      const prior = (reviewSummary && Array.isArray(reviewSummary.entries)) ? reviewSummary.entries : [];
      const bundle = accumulateBundle(prior, pageBundle);
      // 2c: section_shapes = a CACHE of DOM-detected field shapes (by section name) carried on the
      // bundle, so the review's add-entry uses detected fields even for a section EMPTY this run
      // (seen on a PRIOR run). Merge prior ∪ this page (this page wins). "Clear summary" resets it.
      bundle.section_shapes = Object.assign({}, (reviewSummary && reviewSummary.section_shapes) || {}, pageBundle.section_shapes || {});
      chrome.storage.local.set({ reviewSummary: bundle }, () => {
        console.log(`[ApplyPilot] Summary saved (accumulated) — page "${pageBundle.page}": +${pageBundle.total} field(s); total ${bundle.total} across ${bundle.entries.length ? new Set(bundle.entries.map((e) => e.page)).size : 0} page(s), ${bundle.needs_review_count} need review. "View last summary".`);
        resolve();
      });
    });
  });
}

// Render a page's fill result to the SW console (table + review queue + source
// diagnostics). `pageLabel` annotates which page in a walk (null for single-page).
function logFrameResult(frameResult, pageLabel) {
  const tag = pageLabel ? ` (${pageLabel})` : "";
  console.log(`[ApplyPilot] Fill summary${tag}:`, frameResult.summary);
  // Explicit columns keep the table readable — the records also carry option
  // arrays (options/captured_options/sourceTrace) we don't want dumped here.
  console.table(frameResult.results, ["fieldName", "label", "widgetType", "isRequired", "mappedPath", "status", "matchTier", "after", "detail"]);
  const review = (frameResult.summary && frameResult.summary.review) || [];
  if (review.length) {
    console.warn(`[ApplyPilot] ⚠ REVIEW BEFORE SUBMIT${tag} — ${review.length} field(s) need a human check:`);
    console.table(review);
  }
  // Source diagnostics — sourcePath + the lightweight trace (retained).
  const rows = frameResult.results || [];
  const sourceRec = rows.find((r) => r.fieldName === "source");
  if (sourceRec && sourceRec.sourceTrace) {
    console.log("[ApplyPilot] SOURCE sourcePath:", sourceRec.sourcePath, "| status:", sourceRec.status, "| after:", sourceRec.after, "| sourceTrace:", sourceRec.sourceTrace);
  }
}

// ── M15: the two-page walk ──────────────────────────────────────────────────
// The injected engine is torn down on every page transition, so the loop CANNOT
// live in the engine — it lives here in the SW (which persists across navigations)
// and re-injects the engine into the ACTIVE tab on each page. Per page: inject
// fill → persist → decide whether to advance → SW clicks Next (guarded) → wait for
// the new page to load + hydrate → re-inject. Hard cap MAX_PAGES so a detection
// bug can't loop forever. This round is exactly two pages / one transition.
async function runWalk(tabId, profile, defaults, jobContext) {
  const MAX_PAGES = 2;
  let pagesFilled = 0;
  let stoppedReason = "max-pages";

  // Plan 2: clear the accumulated summary ONCE at walk START (a fresh application starts clean),
  // then ACCUMULATE per page (was overwrite-per-page → page 1 was lost, the "My-Experience under
  // page 1" bug). The field-set page key + page_number now keep the pages distinct + ordered.
  await new Promise((resolve) => chrome.storage.local.remove("reviewSummary", resolve));

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    console.log(`[ApplyPilot] ── Walk: filling page ${pageNum}/${MAX_PAGES} ──`);
    const frameResult = await injectFill(tabId, profile, defaults, jobContext);
    if (!frameResult) {
      stoppedReason = pageNum === 1 ? "fill-failed" : "fill-failed-after-transition";
      console.log(`[ApplyPilot] Walk: no fill result on page ${pageNum} — stopping (${stoppedReason}).`);
      break;
    }
    logFrameResult(frameResult, `page ${pageNum}`);
    // Post-fill: attach the stored resume on a page that has the upload widget
    // (no-op otherwise). BEFORE persist (so the bundle patch is saved) and BEFORE
    // clicking Next (so the resume is attached before the page advances).
    const attach = await attachResumeForPage(tabId, frameResult);
    if (attach) console.log(`[ApplyPilot] Walk: page ${pageNum} resume attach:`, attach);
    // Stamp the page ordinal (the SW knows it; the engine doesn't) onto the bundle for display
    // order/caption, then ACCUMULATE (keeps prior pages + viewer edits verbatim).
    if (frameResult.bundle) {
      frameResult.bundle.page_number = pageNum;
      frameResult.bundle.page_label = "Page " + pageNum;
      for (const e of frameResult.bundle.entries || []) { e.page_number = pageNum; e.page_label = "Page " + pageNum; }
    }
    await persistAccumulated(frameResult.bundle);
    pagesFilled++;

    const nav = frameResult.nav || {};
    console.log(`[ApplyPilot] Walk: page ${pageNum} nav:`, nav);

    // ── Stop conditions (decided in order) ──
    if (pageNum === MAX_PAGES) { stoppedReason = "max-pages"; break; }
    // Safety: NEVER advance on/past the review page — its footer button reuses the
    // Submit data-automation-id, so advancing there would submit the application.
    if (nav.reviewPagePresent) { stoppedReason = "review-page"; break; }
    // Terminal page: no Next button means there's nowhere to advance.
    if (!nav.nextButtonPresent) { stoppedReason = "no-next-button"; break; }

    // ── Advance: the SW clicks Next (guarded), NOT the engine. Decoupling the
    //    click from the fill guarantees the page's review data was already captured
    //    and persisted before navigation is triggered. ──
    const click = await injectClickNext(tabId);
    console.log("[ApplyPilot] Walk: clickNext result:", click);
    if (!click || !click.clicked) {
      stoppedReason = click && click.refused ? `click-refused:${click.refused}` : "click-failed";
      console.log(`[ApplyPilot] Walk: did not click Next — stopping (${stoppedReason}).`);
      break;
    }

    // ── Wait for the next page to load + hydrate before re-injecting. ──
    const ready = await waitForNextPage(tabId, nav);
    if (!ready) {
      // The signature never changed → the page didn't advance. Most likely a
      // required field blocked Next (Workday won't advance with one empty). Halt
      // gracefully — do NOT error, do NOT guess a value.
      stoppedReason = "nav-timeout";
      console.log("[ApplyPilot] Walk: next page did not load/hydrate in time after clicking Next — halting gracefully (a required field may have blocked advancement).");
      break;
    }
    console.log("[ApplyPilot] Walk: next page ready — re-injecting.");
  }

  console.log(`[ApplyPilot] Walk complete — pagesFilled=${pagesFilled}, stoppedReason=${stoppedReason}.`);
  return { pagesFilled, stoppedReason };
}

// Inject the guarded clickNext into frame 0; resolve its result (or null on
// injection error — e.g. the doc was mid-navigation).
function injectClickNext(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId, frameIds: [0] }, func: clickNext },
      (results) => {
        if (chrome.runtime.lastError) {
          console.log("[ApplyPilot] clickNext injection error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve((results || []).map((r) => r.result).find((r) => r) || null);
      }
    );
  });
}

// Poll-by-reinjection wait for the next page. We don't assume hard navigation vs
// SPA soft-nav — instead we re-inject a tiny probe until the page SIGNATURE differs
// from `prevSig` AND the new page is hydrated (≥1 formField, readyState complete)
// AND its field count holds steady across two consecutive reads (so we don't
// re-inject mid-hydration). Injection errors mean the doc is mid-navigation —
// treat as "not ready, keep polling" (the M10 engine-not-ready race). Timeout →
// false (the walk then halts gracefully).
async function waitForNextPage(tabId, prevSig, timeoutMs = 15000, intervalMs = 400) {
  const prevFields = (prevSig.formFieldIds || []).join("|");
  const start = Date.now();
  let prevAdvancedCount = -1;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const sig = await injectProbe(tabId);
    if (!sig) continue;                                  // mid-navigation — retry
    if (sig.readyState !== "complete") { prevAdvancedCount = -1; continue; }
    if (!(sig.formFieldCount > 0)) { prevAdvancedCount = -1; continue; } // not hydrated yet
    const advanced =
      sig.url !== prevSig.url ||
      sig.pageId !== prevSig.pageId ||
      (sig.formFieldIds || []).join("|") !== prevFields;
    if (!advanced) { prevAdvancedCount = -1; continue; } // still the same page
    // Advanced + hydrated — require the field count to repeat once (settle) so we
    // don't re-inject while React is still mounting fields.
    if (sig.formFieldCount === prevAdvancedCount) return true;
    prevAdvancedCount = sig.formFieldCount;
  }
  return false;
}

// Inject the tiny page probe into frame 0; resolve its signature (or null on a
// transient injection error during navigation).
function injectProbe(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId, frameIds: [0] }, func: probePage },
      (results) => {
        if (chrome.runtime.lastError) { resolve(null); return; } // mid-nav — caller retries
        resolve((results || []).map((r) => r.result).find((r) => r) || null);
      }
    );
  });
}

// ============================================================================
// CDP RECON — Step 1 of the CDP actuation port (simple widgets, hidden tab).
//
// Empirically answers, on the live page with the tab HIDDEN, the can't-guess
// questions the CDP fill driver (Step 2) will be built on:
//   (a) does Input.insertText set a text field's value AND fire the events
//       Workday's React needs (per-char dispatchKeyEvent as fallback — BOTH are
//       exercised every run, per-char doubles as the restore path),
//   (b) do CDP mouse clicks open/select dropdowns and flip radios/checkboxes,
//       with a keyboard contingency (focus + Enter/Space/Arrow) exercised in
//       the SAME run regardless of how (c) lands,
//   (c) REPORTED FIRST: are getBoundingClientRect coords real (non-zero) while
//       hidden — for in-flow fields AND the portaled option popup — plus
//       whether scrollIntoView works hidden (off-viewport fields need it),
//   (d) commit latency per widget hidden (sizes Step 2 wait budgets), and
//       whether the dropdown option list renders atomically or GROWS across
//       reads (decides if a 2-read stability bar is enough).
//
// Probe values: text fields get "CDP1"/"CDP2" then their ORIGINAL value back;
// dropdowns/radios are flipped and then restored where an original value
// exists (any unrestored state is logged under sideEffects — read it).
// All pacing is SW-side (cdpDelay); the page loop stays throttled by design —
// Δperf ≈ 1000ms during the run is EXPECTED, not failure.
// The in-page recon* functions are SELF-CONTAINED (evaluated via cdpEval) and
// mirror fillEngine's classifier/label/skip-guard rules verbatim — they are
// read-only probes, not a parallel fill path.
// ============================================================================

// One full-page scan: targets for each probe + viewport + the (c) rects, all in
// one read. Mirrors classifyField's priority order and the flat-loop's
// repeating-section skip-guard (background.js fillEngine) — keep in sync.
function reconScan() {
  const rectOf = (el) => {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  };
  const classify = (wrapper) => {
    const fieldName = (wrapper.getAttribute("data-automation-id") || "").slice("formField-".length);
    if (fieldName === "source") return "hierarchical";
    if (wrapper.querySelector('input[type="file"]')) return "file_upload";
    if (wrapper.querySelector('[data-uxi-widget-type="multiselect"]')) return "typeahead";
    if (wrapper.querySelector('input[type="radio"]')) return "radio";
    if (wrapper.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    if (wrapper.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    const textLike = Array.from(wrapper.querySelectorAll("input")).filter((el) => {
      const t = (el.getAttribute("type") || "").toLowerCase();
      return t === "" || ["text", "email", "tel", "number", "url"].includes(t);
    });
    if (textLike.length === 1) return "text";
    return "unknown";
  };
  const labelOf = (wrapper) => {
    const legend = wrapper.querySelector("legend");
    if (legend && legend.textContent.trim()) return legend.textContent.trim();
    for (const l of wrapper.querySelectorAll("label")) {
      const t = (l.textContent || "").trim();
      if (t) return t;
    }
    return null;
  };
  // PARTITION (not filter) on the repeating-section guard, so "everything on
  // this page is a repeating section" is visible in the report instead of
  // reading as an empty/wrong page (the My-Experience misread).
  const isRepeating = (w) => !!(w.closest('[data-fkit-id^="workExperience-"]') || w.closest('[data-fkit-id^="education-"]')
    || w.closest('[data-fkit-id^="webAddress-"]') || w.closest('[data-fkit-id^="language-"]')
    || w.closest('[data-fkit-id^="certification-"]'));
  const all = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
  const wrappers = all.filter((w) => !isRepeating(w));
  const selOf = (w) => '[data-automation-id="' + w.getAttribute("data-automation-id") + '"]';

  const out = {
    url: location.href,
    viewport: { innerWidth, innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState },
    bodyRect: rectOf(document.body),
    repeatingFieldCount: all.length - wrappers.length, // skipped by the guard (out of scope this milestone)
    counts: {}, text: null, dropdowns: [], radio: null, checkbox: null, last: null
  };
  for (const w of wrappers) {
    const type = classify(w);
    out.counts[type] = (out.counts[type] || 0) + 1;
    if (type === "text" && !out.text) {
      const input = w.querySelector("input");
      out.text = { wrapperSel: selOf(w), label: labelOf(w), value: input ? input.value : null, rect: rectOf(input) };
    } else if (type === "dropdown") {
      const trigger = w.querySelector('button[aria-haspopup="listbox"]');
      out.dropdowns.push({
        wrapperSel: selOf(w), label: labelOf(w),
        triggerText: trigger ? trigger.textContent.trim() : null,
        rect: rectOf(trigger)
      });
    } else if (type === "radio" && !out.radio) {
      const radios = Array.from(w.querySelectorAll('input[type="radio"]'));
      out.radio = {
        wrapperSel: selOf(w), label: labelOf(w),
        options: radios.map((input) => {
          const lab = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
          return { id: input.id, labelText: lab ? lab.textContent.trim() : "", checked: input.checked, labelRect: rectOf(lab) };
        })
      };
    } else if (type === "checkbox" && !out.checkbox) {
      const input = w.querySelector('input[type="checkbox"]');
      const lab = input && input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
      out.checkbox = { wrapperSel: selOf(w), label: labelOf(w), inputId: input ? input.id : null,
                       checked: input ? input.checked : null, labelRect: rectOf(lab), inputRect: rectOf(input) };
    }
  }
  if (wrappers.length) {
    const lastW = wrappers[wrappers.length - 1];
    out.last = { wrapperSel: selOf(lastW), rect: rectOf(lastW) };
  }
  return out;
}

// Fresh rect for `sel` (optionally scrollIntoView first — instant, not smooth:
// smooth scrolling is rAF-driven and rAF is frozen in a hidden tab).
function reconRect(sel, scroll) {
  const el = document.querySelector(sel);
  if (!el) return null;
  if (scroll && el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
}

// Arm read-only event counters on the wrapper's <input> (which events Workday's
// React actually sees from each input method — the (a) readout). Re-calling
// resets the counts; listeners attach once per wrapper.
function reconArmEvents(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  const input = w && w.querySelector("input");
  if (!input) return false;
  window.__apCdpReconCounts = { keydown: 0, keypress: 0, beforeinput: 0, input: 0, change: 0, keyup: 0, untrusted: 0 };
  window.__apCdpReconArmed = window.__apCdpReconArmed || {};
  if (window.__apCdpReconArmed[wrapperSel]) return true;
  window.__apCdpReconArmed[wrapperSel] = true;
  for (const type of ["keydown", "keypress", "beforeinput", "input", "change", "keyup"]) {
    input.addEventListener(type, (e) => {
      const c = window.__apCdpReconCounts;
      if (!c) return;
      c[type]++;
      if (!e.isTrusted) c.untrusted++;
    }, true);
  }
  return true;
}
function reconReadEvents() { return window.__apCdpReconCounts || null; }

// Text-field state: value + whether the wrapper's input holds focus.
function reconReadText(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  const input = w && w.querySelector("input");
  if (!input) return null;
  return { value: input.value, focused: document.activeElement === input };
}

// Page-side focus fallback (focus() is not isTrusted-gated; subsequent CDP key
// events go to whatever holds focus regardless of how it got there).
function reconFocusSel(sel) {
  const el = document.querySelector(sel);
  if (!el || !el.focus) return false;
  el.focus();
  return document.activeElement === el;
}
function reconFocusById(id) {
  const el = document.getElementById(id);
  if (!el || !el.focus) return false;
  el.focus();
  return document.activeElement === el;
}
function reconReadChecked(id) {
  const el = document.getElementById(id);
  return el ? el.checked : null;
}

// Dropdown state, read fresh each call: trigger text, the aria-controls-scoped
// option list (texts + rects — the M14.1 scoping rule, never a page-wide
// scrape), and the aria-activedescendant highlight (keyboard-nav readout).
function reconReadDropdown(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  const trigger = w && w.querySelector('button[aria-haspopup="listbox"]');
  if (!trigger) return null;
  const id = trigger.getAttribute("aria-controls");
  const lb = id ? document.getElementById(id) : null;
  const options = lb
    ? Array.from(lb.querySelectorAll('[role="option"]')).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: (el.textContent || "").trim(),
          disabled: el.getAttribute("aria-disabled") === "true",
          selected: el.getAttribute("aria-selected") === "true",
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                  cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }
        };
      })
    : [];
  const adFrom = (el) => (el && el.getAttribute && el.getAttribute("aria-activedescendant")) || null;
  const activeId = adFrom(document.activeElement) || adFrom(lb) || adFrom(trigger);
  const activeEl = activeId ? document.getElementById(activeId) : null;
  return {
    triggerText: trigger.textContent.trim(),
    expanded: trigger.getAttribute("aria-expanded"),
    listboxPresent: !!lb,
    optionCount: options.filter((o) => !o.disabled).length,
    options,
    activeText: activeEl ? (activeEl.textContent || "").trim() : null,
    focusedIsTrigger: document.activeElement === trigger,
    activeAutomationId: (document.activeElement && document.activeElement.getAttribute
      && document.activeElement.getAttribute("data-automation-id")) || null
  };
}
function reconReadRadio(wrapperSel) {
  const w = document.querySelector(wrapperSel);
  if (!w) return null;
  return Array.from(w.querySelectorAll('input[type="radio"]')).map((input) => ({
    id: input.id, checked: input.checked, focused: document.activeElement === input
  }));
}

// The recon driver — SW-side orchestration, all pacing via cdpDelay. Each probe
// is individually guarded so one failure can't kill the rest; the summary JSON
// always prints. Detaches in finally on every path.
async function runCdpRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-RECON]", ...a);
  const R = { c: {}, a: {}, b: {}, d: {}, sideEffects: [], errors: [] };
  const guard = async (name, fn) => {
    try { await fn(); } catch (e) {
      const msg = name + ": " + String((e && e.message) || e);
      R.errors.push(msg);
      LOG("probe ERROR —", msg);
    }
  };
  // Poll dropdown state until `pred` holds (SW-paced, generous ceilings — the
  // page's reaction runs throttled; a foreground-tuned timeout false-negatives).
  const pollDropdown = async (wrapperSel, pred, ceilingMs, intervalMs = 300) => {
    const t0 = Date.now();
    let s = null;
    while (Date.now() - t0 < ceilingMs) {
      await cdpDelay(intervalMs);
      s = await cdpEval(reconReadDropdown, wrapperSel);
      if (s && pred(s)) return { state: s, ms: Date.now() - t0, ok: true };
    }
    return { state: s, ms: Date.now() - t0, ok: false };
  };
  const pollChecked = async (id, want, ceilingMs = 10000, intervalMs = 300) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ceilingMs) {
      await cdpDelay(intervalMs);
      if ((await cdpEval(reconReadChecked, id)) === want) return { ok: true, ms: Date.now() - t0 };
    }
    return { ok: false, ms: Date.now() - t0 };
  };

  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — recon starts on the first hidden read (60s window).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, no probes executed.");
      return { ok: false, error: "never-hidden" };
    }
    LOG("tab is hidden — recon starting.");

    const scan = await cdpEval(reconScan);
    if (!scan) return { ok: false, error: "scan-failed" };
    LOG("scan:", JSON.stringify({ url: scan.url, inScopeCounts: scan.counts, repeatingFieldCount: scan.repeatingFieldCount, viewport: scan.viewport }));
    // Page classification for the operator: "nothing in scope" must never read
    // as "broken" (or as the wrong page, when it's a repeating-sections page).
    const simpleCount = ["text", "dropdown", "radio", "checkbox"].reduce((n, t) => n + (scan.counts[t] || 0), 0);
    if (!simpleCount && scan.repeatingFieldCount > 0) {
      LOG("all " + scan.repeatingFieldCount + " field(s) on this page are repeating-section (out of scope this milestone); "
        + "navigate to a page with flat fields (e.g. My Information) and re-run. "
        + "In-scope counts: " + JSON.stringify(scan.counts) + ", repeating: " + scan.repeatingFieldCount + ".");
    } else if (!simpleCount) {
      LOG("⚠ NO simple widgets and NO repeating-section fields on this page (in-scope counts: " + JSON.stringify(scan.counts)
        + ", repeating: 0) — this looks like the apply-landing/resume step, not a form page. "
        + "Navigate to the My Information page (real fields visible) and re-run; (a)/(b)/(d) need them.");
    }

    // ── (c) FIRST: rect validity while hidden ─────────────────────────────
    await guard("(c) rects", async () => {
      const live = (r) => !!(r && r.w > 0 && r.h > 0);
      const sampled = {
        textInput: scan.text ? scan.text.rect : null,
        dropdownTrigger: scan.dropdowns[0] ? scan.dropdowns[0].rect : null,
        radioLabel: scan.radio && scan.radio.options[0] ? scan.radio.options[0].labelRect : null,
        lastWrapper: scan.last ? scan.last.rect : null,
        body: scan.bodyRect
      };
      const widgetRects = [sampled.textInput, sampled.dropdownTrigger, sampled.radioLabel].filter(Boolean);
      // Liveness needs SOMETHING actually sampled. With no simple widgets on the
      // page, fall back to wrapper/body evidence and say so — "nothing to sample"
      // must never read as "zeroed" (the first recon run misreported exactly that).
      const evidence = widgetRects.length ? widgetRects : [sampled.lastWrapper, sampled.body].filter(Boolean);
      R.c.rects = sampled;
      R.c.sampledWidgetRects = widgetRects.length;
      R.c.rectsEvidence = widgetRects.length ? "widget-rects" : "wrapper/body-fallback";
      R.c.rectsLive = evidence.length ? evidence.every(live) : null;
      if (scan.last) {
        const before = scan.last.rect;
        const after = await cdpEval(reconRect, scan.last.wrapperSel, true);
        R.c.scroll = {
          before, after,
          moved: !!(before && after && Math.abs(after.y - before.y) > 1),
          inViewport: !!(after && after.cy >= 0 && after.cy <= scan.viewport.innerHeight)
        };
        await cdpEval(() => { window.scrollTo(0, 0); return true; });
      }
      LOG("(c) RECTS HIDDEN — rectsLive:", R.c.rectsLive,
          "(evidence: " + R.c.rectsEvidence + ", " + widgetRects.length + " widget rect(s) sampled)",
          "| viewport:", scan.viewport.innerWidth + "x" + scan.viewport.innerHeight,
          "| scrollIntoView moved:", R.c.scroll && R.c.scroll.moved, "| detail:", JSON.stringify(sampled));
      if (R.c.rectsLive === false) LOG("(c) ⚠ RECTS ZEROED WHILE HIDDEN — coordinate clicks are dead; keyboard probes below are the decision data. NOT silently working around this.");
    });

    // ── (a) text input: insertText vs per-char keys ───────────────────────
    await guard("(a) text", async () => {
      if (!scan.text) { R.a.skipped = "no text field on page"; LOG("(a) skipped — no text field"); return; }
      const T = scan.text;
      const inputSel = T.wrapperSel + " input";
      R.a.field = { label: T.label, wrapperSel: T.wrapperSel, originalValue: T.value };

      // Focus ladder: CDP click → page focus() → DOM.focus. Records what works.
      const tryFocus = async () => {
        const rect = await cdpEval(reconRect, inputSel, true);
        if (rect && rect.w > 0) {
          await cdpClickAt(rect.cx, rect.cy);
          await cdpDelay(300);
          const s = await cdpEval(reconReadText, T.wrapperSel);
          if (s && s.focused) return "cdp-click";
        }
        if (await cdpEval(reconFocusSel, inputSel)) return "page-focus()";
        try {
          await cdpDomFocus(inputSel);
          const s = await cdpEval(reconReadText, T.wrapperSel);
          if (s && s.focused) return "DOM.focus";
        } catch (e) { /* recorded below as focus failure */ }
        return null;
      };
      R.a.focusMethod = await tryFocus();
      LOG("(a) focus method:", R.a.focusMethod || "NONE WORKED");
      if (!R.a.focusMethod) return;

      // Clear via trusted Select-All + Delete.
      await cdpEval(reconArmEvents, T.wrapperSel);
      await cdpSelectAllDelete();
      await cdpDelay(400);
      const afterClear = await cdpEval(reconReadText, T.wrapperSel);
      R.a.clear = { valueAfter: afterClear && afterClear.value, events: await cdpEval(reconReadEvents) };
      LOG("(a) select-all+Delete:", JSON.stringify(R.a.clear));

      // Probe 1: Input.insertText. Blur (Tab) + a late re-read catches a
      // controlled-input revert when React didn't actually register the value.
      await cdpEval(reconArmEvents, T.wrapperSel);
      let t0 = Date.now();
      await cdpInsertText("CDP1");
      await cdpDelay(700);
      const insRead = await cdpEval(reconReadText, T.wrapperSel);
      const insEvents = await cdpEval(reconReadEvents);
      await cdpKeyTap(CDP_KEYS.tab);
      await cdpDelay(1500);
      const insBlur = await cdpEval(reconReadText, T.wrapperSel);
      R.a.insertText = {
        valueAfter: insRead && insRead.value, events: insEvents,
        valueAfterBlur: insBlur && insBlur.value,
        ok: !!(insBlur && insBlur.value === "CDP1"), latencyMs: Date.now() - t0
      };
      LOG("(a) Input.insertText:", JSON.stringify(R.a.insertText));

      // Probe 2: per-char dispatchKeyEvent — exercised regardless of probe 1,
      // so both paths' data come out of one run.
      if (await tryFocus()) {
        await cdpEval(reconArmEvents, T.wrapperSel);
        await cdpSelectAllDelete();
        await cdpDelay(300);
        t0 = Date.now();
        await cdpTypeChars("CDP2", 40);
        await cdpDelay(700);
        const chRead = await cdpEval(reconReadText, T.wrapperSel);
        const chEvents = await cdpEval(reconReadEvents);
        await cdpKeyTap(CDP_KEYS.tab);
        await cdpDelay(1500);
        const chBlur = await cdpEval(reconReadText, T.wrapperSel);
        R.a.perChar = {
          valueAfter: chRead && chRead.value, events: chEvents,
          valueAfterBlur: chBlur && chBlur.value,
          ok: !!(chBlur && chBlur.value === "CDP2"), latencyMs: Date.now() - t0
        };
        LOG("(a) per-char dispatchKeyEvent:", JSON.stringify(R.a.perChar));
      }

      // Restore the original value with whichever input method proved out.
      if (await tryFocus()) {
        await cdpSelectAllDelete();
        await cdpDelay(300);
        const orig = T.value || "";
        if (orig) {
          if (R.a.insertText && R.a.insertText.ok) await cdpInsertText(orig);
          else await cdpTypeChars(orig, 40);
        }
        await cdpKeyTap(CDP_KEYS.tab);
        await cdpDelay(800);
        const fin = await cdpEval(reconReadText, T.wrapperSel);
        R.a.restored = !!(fin && fin.value === orig);
        if (!R.a.restored) R.sideEffects.push(`text "${T.label}" left as "${fin && fin.value}" (original "${orig}") — restore it manually`);
        LOG("(a) original value restored:", R.a.restored);
      }
    });

    // ── (b)+(d) dropdown: mouse open/select, growth series, keyboard path ──
    await guard("(b) dropdown", async () => {
      const dd = scan.dropdowns.find((d) => d.triggerText && !/select one/i.test(d.triggerText)) || scan.dropdowns[0];
      if (!dd) { R.b.dropdown = { skipped: "no dropdown on page" }; LOG("(b) dropdown skipped — none found"); return; }
      const hasOriginal = !!(dd.triggerText && !/select one/i.test(dd.triggerText));
      const D = { field: { label: dd.label, wrapperSel: dd.wrapperSel, originalText: dd.triggerText, hasOriginal } };
      R.b.dropdown = D;

      // Mouse OPEN + the (d) growth series: poll to first non-zero read, then
      // keep reading a 3s tail — does the list grow like the typeahead did
      // (36→38→40), or render atomically?
      const trigSel = dd.wrapperSel + ' button[aria-haspopup="listbox"]';
      const rect = await cdpEval(reconRect, trigSel, true);
      D.triggerRectHidden = rect;
      if (!rect || rect.w <= 0) { D.mouseOpen = { ok: false, reason: "zero rect" }; LOG("(b) dropdown trigger rect zeroed — mouse open impossible"); }
      else {
        const t0 = Date.now();
        await cdpClickAt(rect.cx, rect.cy);
        const series = [];
        let opened = null;
        while (Date.now() - t0 < 20000) {
          await cdpDelay(300);
          const s = await cdpEval(reconReadDropdown, dd.wrapperSel);
          series.push({ t: Date.now() - t0, count: s ? s.optionCount : -1 });
          if (s && s.optionCount > 0) { opened = s; break; }
        }
        if (opened) {
          const tailStart = Date.now();
          while (Date.now() - tailStart < 3000) {
            await cdpDelay(300);
            const s = await cdpEval(reconReadDropdown, dd.wrapperSel);
            series.push({ t: Date.now() - t0, count: s ? s.optionCount : -1 });
            if (s && s.optionCount > 0) opened = s;
          }
        }
        const counts = series.filter((e) => e.count > 0).map((e) => e.count);
        D.mouseOpen = { ok: !!opened, firstOptionsAtMs: counts.length ? series.find((e) => e.count > 0).t : null, series };
        D.optionListGrows = counts.length > 1 && counts.some((c) => c !== counts[0]);
        D.optionRectsLive = !!opened && opened.options.filter((o) => !o.disabled).slice(0, 3)
          .every((o) => o.rect && o.rect.w > 0 && o.rect.h > 0);
        R.c.portaledOptionRectsLive = D.optionRectsLive; // (c) addendum — portaled popup rects
        LOG("(b) dropdown MOUSE open:", JSON.stringify({ ok: D.mouseOpen.ok, firstOptionsAtMs: D.mouseOpen.firstOptionsAtMs, grows: D.optionListGrows, series }));
        LOG("(c-addendum) portaled option rects live while hidden:", D.optionRectsLive);

        // Mouse SELECT: pick the enabled option right AFTER the original (so the
        // keyboard phase can restore with a single ArrowUp); placeholder-valued
        // dropdowns take the first enabled option (no restore possible).
        if (opened) {
          const enabled = opened.options.filter((o) => !o.disabled);
          let target = null, restorePlan = null;
          if (hasOriginal) {
            const oi = enabled.findIndex((o) => o.text === D.field.originalText);
            if (oi >= 0 && oi + 1 < enabled.length) { target = enabled[oi + 1]; restorePlan = "arrowUp"; }
            else if (oi > 0) { target = enabled[oi - 1]; restorePlan = "arrowDown"; }
          }
          if (!target) { target = enabled.find((o) => o.text !== D.field.originalText) || null; restorePlan = null; }
          if (!target) { D.mouseSelect = { ok: false, reason: "no alternative option" }; }
          else if (!(target.rect && target.rect.w > 0)) { D.mouseSelect = { ok: false, reason: "option rect zeroed" }; }
          else {
            const t1 = Date.now();
            await cdpClickAt(target.rect.cx, target.rect.cy);
            const sel = await pollDropdown(dd.wrapperSel, (s) => s.triggerText === target.text, 10000);
            D.mouseSelect = {
              target: target.text, committed: sel.ok, latencyMs: sel.ms,
              triggerTextAfter: sel.state && sel.state.triggerText,
              listboxClosedAfterClick: !!(sel.state && (!sel.state.listboxPresent || sel.state.optionCount === 0))
            };
            LOG("(b) dropdown MOUSE select:", JSON.stringify(D.mouseSelect));
            if (sel.ok) R.sideEffects.push(`dropdown "${dd.label}" set to "${target.text}" (was "${dd.triggerText}") — keyboard phase attempts restore`);
          }

          // KEYBOARD contingency — exercised regardless of how (c)/mouse landed.
          const K = {};
          D.keyboard = K;
          K.triggerFocused = await cdpEval(reconFocusSel, trigSel);
          if (!K.triggerFocused) { try { await cdpDomFocus(trigSel); K.triggerFocused = "DOM.focus"; } catch (e) { /* reported via K */ } }
          let kOpened = null;
          for (const opener of ["enter", "space", "arrowDown"]) {
            await cdpKeyTap(CDP_KEYS[opener]);
            const o = await pollDropdown(dd.wrapperSel, (s) => s.optionCount > 0, 6000);
            if (o.ok) { kOpened = o.state; K.openedBy = opener; K.openLatencyMs = o.ms; break; }
          }
          LOG("(b) dropdown KEYBOARD open:", JSON.stringify({ focused: K.triggerFocused, openedBy: K.openedBy || "NONE" }));
          if (kOpened) {
            await cdpKeyTap(CDP_KEYS.arrowDown);
            await cdpDelay(700);
            let s = await cdpEval(reconReadDropdown, dd.wrapperSel);
            K.activeAfterArrowDown = s && s.activeText;
            // Restore = the keyboard-select data point: navigate the highlight to
            // the ORIGINAL option (1 step by construction), Enter, verify.
            const restoreTarget = hasOriginal ? D.field.originalText : null;
            if (restoreTarget && restorePlan && s && s.activeText != null) {
              // After ArrowDown the highlight sits one past the selected option in
              // most listboxes; walk (bounded) in the planned direction to original.
              const stepKey = restorePlan === "arrowUp" ? CDP_KEYS.arrowUp : CDP_KEYS.arrowDown;
              let steps = 0;
              while (s && s.activeText !== restoreTarget && steps < 8) {
                await cdpKeyTap(stepKey);
                await cdpDelay(400);
                s = await cdpEval(reconReadDropdown, dd.wrapperSel);
                steps++;
              }
              if (s && s.activeText === restoreTarget) {
                await cdpKeyTap(CDP_KEYS.enter);
                const com = await pollDropdown(dd.wrapperSel, (st) => st.triggerText === restoreTarget, 10000);
                K.enterCommit = { committed: com.ok, latencyMs: com.ms, triggerTextAfter: com.state && com.state.triggerText };
                if (com.ok) R.sideEffects.push(`dropdown "${dd.label}" RESTORED to "${restoreTarget}" via keyboard`);
              } else {
                K.enterCommit = { committed: false, reason: "highlight never reached original (activeText=" + (s && s.activeText) + ")" };
                await cdpKeyTap(CDP_KEYS.escape);
                await cdpDelay(600);
                const closed = await cdpEval(reconReadDropdown, dd.wrapperSel);
                K.escapeCloses = !!(closed && closed.optionCount === 0);
              }
            } else {
              // No safe keyboard-commit target — probe Escape and leave it.
              await cdpKeyTap(CDP_KEYS.escape);
              await cdpDelay(600);
              const closed = await cdpEval(reconReadDropdown, dd.wrapperSel);
              K.escapeCloses = !!(closed && closed.optionCount === 0);
              K.enterCommit = { committed: false, reason: restoreTarget ? "highlight unreadable" : "no original value to restore" };
            }
            LOG("(b) dropdown KEYBOARD nav/commit:", JSON.stringify(K));
            // Keyboard restore failed but mouse changed the value → mouse-restore.
            if (restoreTarget && (!K.enterCommit || !K.enterCommit.committed) && D.mouseSelect && D.mouseSelect.committed) {
              const r2 = await cdpEval(reconRect, trigSel, true);
              await cdpClickAt(r2.cx, r2.cy);
              const o2 = await pollDropdown(dd.wrapperSel, (st) => st.optionCount > 0, 20000);
              const orig2 = o2.ok ? o2.state.options.find((o) => !o.disabled && o.text === restoreTarget) : null;
              if (orig2 && orig2.rect && orig2.rect.w > 0) {
                await cdpClickAt(orig2.rect.cx, orig2.rect.cy);
                const com2 = await pollDropdown(dd.wrapperSel, (st) => st.triggerText === restoreTarget, 10000);
                D.mouseRestore = { restored: com2.ok };
                if (com2.ok) R.sideEffects.push(`dropdown "${dd.label}" RESTORED to "${restoreTarget}" via mouse`);
              } else {
                D.mouseRestore = { restored: false };
              }
              if (!D.mouseRestore.restored) R.sideEffects.push(`dropdown "${dd.label}" NOT restored — set it back to "${restoreTarget}" manually`);
            }
          }
        }
      }
    });

    // ── (b)+(d) radio: mouse label-click, keyboard Space ──────────────────
    await guard("(b) radio", async () => {
      if (!scan.radio || scan.radio.options.length < 2) { R.b.radio = { skipped: "no radio group with 2+ options" }; LOG("(b) radio skipped"); return; }
      const RD = { field: { label: scan.radio.label, wrapperSel: scan.radio.wrapperSel } };
      R.b.radio = RD;
      const opts = scan.radio.options;
      const orig = opts.find((o) => o.checked) || null;
      RD.original = orig ? orig.labelText : null;
      // Mouse target: the flip — if nothing is checked, prefer the /^no\b/i
      // option (safe direction; this group is likely the previous-worker
      // question) and say so loudly in sideEffects.
      const target = orig ? opts.find((o) => !o.checked)
                          : (opts.find((o) => /^no\b/i.test(o.labelText)) || opts[0]);
      const labSel = 'label[for="' + target.id + '"]';
      const rect = await cdpEval(reconRect, labSel, true);
      if (!rect || rect.w <= 0) { RD.mouse = { ok: false, reason: "zero label rect" }; LOG("(b) radio label rect zeroed — mouse click impossible"); }
      else {
        await cdpClickAt(rect.cx, rect.cy);
        const res = await pollChecked(target.id, true);
        RD.mouse = { target: target.labelText, committed: res.ok, latencyMs: res.ms };
        LOG("(b) radio MOUSE label-click:", JSON.stringify(RD.mouse));
      }
      // Keyboard: focus an input + Space. With an original this doubles as the
      // restore; without one, probe another option then mouse-restore "No".
      const kbTarget = orig || opts.find((o) => o.id !== target.id) || target;
      const focused = await cdpEval(reconFocusById, kbTarget.id);
      await cdpKeyTap(CDP_KEYS.space);
      const kres = await pollChecked(kbTarget.id, true);
      RD.keyboard = { target: kbTarget.labelText, inputFocusable: focused, committed: kres.ok, latencyMs: kres.ms };
      LOG("(b) radio KEYBOARD Space:", JSON.stringify(RD.keyboard));
      if (orig) {
        RD.restored = kres.ok;
        if (!kres.ok && RD.mouse && RD.mouse.committed) {
          const r2 = await cdpEval(reconRect, 'label[for="' + orig.id + '"]', true);
          if (r2 && r2.w > 0) { await cdpClickAt(r2.cx, r2.cy); RD.restored = (await pollChecked(orig.id, true)).ok; }
        }
        if (!RD.restored) R.sideEffects.push(`radio "${scan.radio.label}" NOT restored — was "${orig.labelText}", set it back manually`);
      } else {
        // End on the safe target ("No") after the keyboard detour.
        if (kres.ok && kbTarget.id !== target.id) {
          const r2 = await cdpEval(reconRect, labSel, true);
          if (r2 && r2.w > 0) { await cdpClickAt(r2.cx, r2.cy); await pollChecked(target.id, true); }
        }
        R.sideEffects.push(`radio "${scan.radio.label}" had NO original selection — recon left "${target.labelText}" selected (radios can't be unset); review it`);
      }
    });

    // ── (b)+(d) checkbox: mouse label-click flip, keyboard Space restore ───
    await guard("(b) checkbox", async () => {
      if (!scan.checkbox || !scan.checkbox.inputId) { R.b.checkbox = { skipped: "no standalone checkbox on page" }; LOG("(b) checkbox skipped — none on this page (path ships anyway; shares label-activation + checked read-back with radio)"); return; }
      const C = { field: { label: scan.checkbox.label }, original: scan.checkbox.checked };
      R.b.checkbox = C;
      const id = scan.checkbox.inputId;
      const labSel = 'label[for="' + id + '"]';
      const rect = (await cdpEval(reconRect, labSel, true)) || (await cdpEval(reconRect, scan.checkbox.wrapperSel + ' input[type="checkbox"]', true));
      if (!rect || rect.w <= 0) { C.mouse = { ok: false, reason: "zero rect" }; }
      else {
        await cdpClickAt(rect.cx, rect.cy);
        const res = await pollChecked(id, !C.original);
        C.mouse = { committed: res.ok, latencyMs: res.ms };
      }
      LOG("(b) checkbox MOUSE:", JSON.stringify(C.mouse));
      const focused = await cdpEval(reconFocusById, id);
      await cdpKeyTap(CDP_KEYS.space);
      const kres = await pollChecked(id, C.original); // back to original = restore
      C.keyboard = { inputFocusable: focused, committed: kres.ok, latencyMs: kres.ms };
      C.restored = (await cdpEval(reconReadChecked, id)) === C.original;
      if (!C.restored) R.sideEffects.push(`checkbox "${scan.checkbox.label}" left ${!C.original ? "CHECKED" : "UNCHECKED"} (was ${C.original ? "checked" : "unchecked"}) — restore manually`);
      LOG("(b) checkbox KEYBOARD Space:", JSON.stringify(C.keyboard), "restored:", C.restored);
    });

    // ── (d) roll-up + summary ──────────────────────────────────────────────
    const dd = R.b.dropdown || {};
    R.d = {
      dropdownOpenMs: dd.mouseOpen ? dd.mouseOpen.firstOptionsAtMs : null,
      dropdownSelectMs: dd.mouseSelect ? dd.mouseSelect.latencyMs : null,
      dropdownOptionListGrows: dd.optionListGrows != null ? dd.optionListGrows : null,
      radioMs: R.b.radio && R.b.radio.mouse ? R.b.radio.mouse.latencyMs : null,
      checkboxMs: R.b.checkbox && R.b.checkbox.mouse ? R.b.checkbox.mouse.latencyMs : null,
      textInsertMs: R.a.insertText ? R.a.insertText.latencyMs : null
    };
    LOG("RECON SUMMARY (paste this whole block back):");
    console.log("[ApplyPilot][CDP-RECON]", JSON.stringify(R, null, 2));
    if (R.sideEffects.length) LOG("⚠ SIDE EFFECTS — review the page:", JSON.stringify(R.sideEffects));
    return { ok: true, errors: R.errors.length, sideEffects: R.sideEffects.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("recon aborted:", msg);
    console.log("[ApplyPilot][CDP-RECON] partial summary:", JSON.stringify(R, null, 2));
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// SESSION RECON (M30 Step 0) — a READ-ONLY static snapshot to find the signal that
// distinguishes a live apply form from a logged-out / expired / error state. No
// minimize needed (a static DOM read isn't throttle-sensitive). Run once on a VALID
// form and once on a LOGGED-OUT/stale state, paste both [SESSION-RECON] blocks.
// Detaches in finally.
// ============================================================================
async function runCdpSessionRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][SESSION-RECON]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    const snap = await cdpEval(cdpReadSessionState);
    LOG("session snapshot (run once VALID + once LOGGED-OUT to diff):");
    console.log("[ApplyPilot][SESSION-RECON]", JSON.stringify(snap, null, 2));
    return { ok: true, snapshot: snap };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// REPEATING-SECTION RECON (M32 Step 0) — the FIRST step of the page-2 CDP port.
// (1) READ-ONLY structure dump (cdpRepeatingScan): which sections are present,
//     their entry containers + per-entry fields (with the composed entry-scoped
//     selector that the existing handlers reuse), the Add/Delete button rects.
// (2) WEBSITES shape check (sharpening 3): confirm Websites exists on Magna and
//     is the assumed one-url-field shape BEFORE committing to it as the first
//     (date-free) section to prove the machinery.
// (3) DATE-SPINBUTTON probe (the key unknown — CDP has no native setter): try
//     insertText → per-char keys → arrow keys, EACH verified by read-back. A
//     TOTAL failure is a STOP-and-surface KNOWN-BLOCKER (dates unactuatable →
//     defer the composite), per sharpening 1 — never a silent fallback-cascade.
//     Bounded + restore-where-possible (one segment, throwaway app). Hidden-gated
//     (it actuates). Detaches in finally.
// ============================================================================
// CDP QUESTIONS RECON (AI-1 Step 1, READ-ONLY) — the screening-questions page (page 3+).
// Dumps EVERY field's VERBATIM label + type + required (for tuning the legallyLoaded /
// EEO-exclusion regexes against the REAL text), and OPENS each dropdown to capture its
// option list + PROVE it dismisses CLEAN (before==after trigger text — never leaves a
// committed/strayed answer on a real app's page). Radios are read in place (no open).
// Typeaheads/source are NOTED only (not opened — recon-safe vs the typeahead stray bug).
// NO LLM, NO commit. Foreground (watch it). Output is [Q-RECON] in the SW console.
async function runCdpQuestionsRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][Q-RECON]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    LOG("attached. READ-ONLY: opens each dropdown, reads its options, and dismisses it CLEAN (never commits). Keep the tab VISIBLE. Run on the screening QUESTIONS page (page 3+).");
    const act = makeCdpActuation(); // no llmConfig — recon never calls act.llm
    const scan = await act.scanPage();
    if (!scan || !Array.isArray(scan.fields)) { LOG("scan failed."); return { ok: false, error: "scan-failed" }; }
    LOG(`url: ${scan.url} — ${scan.fields.length} field(s).`);

    // (1) VERBATIM label dump — ALL fields (regex tuning needs the EXACT strings, incl. *).
    LOG("── ALL FIELDS (verbatim labels — JSON so exact chars / asterisks / casing show) ──");
    for (const f of scan.fields) {
      console.log("[ApplyPilot][Q-RECON]", JSON.stringify({ fieldName: f.fieldName, widgetType: f.widgetType, isRequired: f.isRequired, label: f.label }));
    }

    // (2) DROPDOWNS — open → settle → read options → dismiss CLEAN (before==after proof).
    const dropdowns = scan.fields.filter((f) => f.widgetType === "dropdown");
    LOG(`── ${dropdowns.length} DROPDOWN(s) — open / read / clean-close ──`);
    const results = [];
    let strayed = 0, notOpened = 0;
    for (const f of dropdowns) {
      const dump = await reconDropdownDump(act, { wrapperSel: f.wrapperSel }, DEFAULT_BUDGETS);
      if (!dump.opened) notOpened++;
      if (!dump.clean) strayed++;
      const optTexts = dump.options.filter((o) => !o.disabled).map((o) => o.text);
      LOG(`• ${JSON.stringify(f.label)} ${f.isRequired ? "[required]" : ""}`);
      LOG(`    clean: ${dump.clean ? "✓ before==after " + JSON.stringify(dump.before) : "✗✗ STRAYED — before " + JSON.stringify(dump.before) + " → after " + JSON.stringify(dump.after)}`);
      LOG(`    opened: ${dump.opened} · enabled options (${optTexts.length}): ${JSON.stringify(optTexts)}`);
      results.push({ fieldName: f.fieldName, label: f.label, required: f.isRequired, clean: dump.clean, opened: dump.opened, optionCount: optTexts.length, options: optTexts });
    }

    // (3) RADIOS — read in place (no open; screening Qs are sometimes radios).
    for (const f of scan.fields.filter((f) => f.widgetType === "radio")) {
      const opts = await act.readRadioState({ wrapperSel: f.wrapperSel });
      LOG(`• RADIO ${JSON.stringify(f.label)} ${f.isRequired ? "[required]" : ""} — options: ${JSON.stringify((opts || []).map((o) => o.labelText))}`);
    }

    // (4) TYPEAHEAD/SOURCE — NOTED only (NOT opened — recon-safe vs the typeahead stray bug).
    for (const f of scan.fields.filter((f) => f.widgetType === "typeahead" || f.widgetType === "hierarchical")) {
      LOG(`• ${f.widgetType.toUpperCase()} ${JSON.stringify(f.label)} — present (NOT opened; fold into aiFillField if the screening page uses these).`);
    }

    if (!dropdowns.length) LOG("⚠ NO dropdowns found — are you on the screening/questions page? (page 3+)");
    LOG(`SUMMARY: ${dropdowns.length} dropdown(s) — clean ${dropdowns.length - strayed}/${dropdowns.length}${strayed ? " ⚠⚠ " + strayed + " STRAYED (recon left a value — DO NOT proceed; investigate)" : (dropdowns.length ? " ✓ all left clean" : "")}${notOpened ? " · " + notOpened + " did not open" : ""}.`);
    return { ok: true, url: scan.url, field_count: scan.fields.length, dropdowns: results, strayed, not_opened: notOpened };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("questions recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// SELF-CONTAINED (evaluated via cdpEval — closes over nothing). Read-only dump of the Workday REVIEW
// page (the final application page that renders every filled value as read-only text). The review DOM
// is highly REGULAR, so this emits STRUCTURED records keyed on STABLE hooks (never the build-variable
// `css-*` emotion classes) rather than guessing from value-presence:
//   • Each field's value is a leaf `<span id="KEY">` whose id IS the form-field name (`jobTitle`,
//     `native`, `url`, a hashed questionnaire id, or a generated `wn5o5e`). The `<span id="attachments">`
//     wrapper has element children so it's skipped; a "No Response" placeholder has no id so it's skipped.
//   • The LABEL is `label[for="KEY"]` resolved WITHIN the field's own row/entry (NEVER document-wide —
//     `for="native"/"url"/"jobTitle"` are DUPLICATED across repeating entries, so a global query returns
//     only the first), or, when there's no <label>, the row's OWN richText <p> (the nearest ancestor
//     holding EXACTLY ONE richText — NEVER the section container, which holds several and would collide).
//   • entryOrdinal = the PANEL ordinal from the nearest `aria-labelledby$="-<N>-panel"` — it RESETS per
//     section (Languages 1/2, Work Experience 1/2/3) and is the ONLY positional signal. fkitPrefix = the
//     base of the nearest `data-fkit-id` matching "<base>-<N>--null" (section IDENTITY). fkitNum is a
//     GLOBAL monotonic counter (differs every form instance) → captured as informational ONLY, never an
//     ordinal. Attachment rows (`attachments-FileUpload`) → one record isAttachment:true, value = the
//     joined file-upload-item-name texts.
// The reconciler (reconcileReviewPage, PURE) matches these records by id + entry, not heuristics. The
// `valueHints` param is kept for call-site compatibility but IGNORED. Never throws; {ok:false,reason}
// if off-page. Returns { ok, url, sections, items, counts }.
function cdpReadReviewPage(valueHints) { // valueHints IGNORED (matching is now id-driven)
  const container = document.querySelector('[data-automation-id="applyFlowReviewPage"]');
  const url = location.href;
  if (!container) return { ok: false, reason: "no-review-page", url };

  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim(); // collapse ALL whitespace (labels)
  const cleanVal = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim(); // value: newlines → spaces too
  const stripStar = (s) => clean(s).replace(/[*\s]+$/, ""); // drop a trailing required "*"/"**"

  // entryOrdinal — nearest ancestor whose aria-labelledby ends "-<N>-panel" (RESETS per section).
  const ordinalOf = (el) => {
    for (let a = el; a && a !== container; a = a.parentElement) {
      const lb = a.getAttribute && a.getAttribute("aria-labelledby");
      if (lb) { const m = /-(\d+)-panel$/.exec(lb); if (m) return parseInt(m[1], 10); }
    }
    return null;
  };
  // fkit identity — nearest ancestor data-fkit-id matching "<base>-<N>--null" (num = informational only).
  const fkitOf = (el) => {
    for (let a = el; a && a !== container; a = a.parentElement) {
      const f = a.getAttribute && a.getAttribute("data-fkit-id");
      if (f) { const m = /^(.+?)-(\d+)--null$/.exec(f); if (m) return { prefix: m[1], num: parseInt(m[2], 10) }; }
    }
    return { prefix: null, num: null };
  };
  // label — ROW/ENTRY-SCOPED. label[for=key] FIRST (nearest ancestor that contains it); else the nearest
  // ancestor holding EXACTLY ONE richText's <p> text. NEVER document-wide, NEVER the multi-richText
  // section container.
  const labelOf = (span, key) => {
    for (let a = span.parentElement, up = 0; a && a !== container && up < 8; up++, a = a.parentElement) {
      const labs = a.getElementsByTagName("label");
      for (let i = 0; i < labs.length; i++) if (labs[i].getAttribute("for") === key) { const t = stripStar(labs[i].textContent); if (t) return t; }
    }
    for (let a = span.parentElement, up = 0; a && a !== container && up < 8; up++, a = a.parentElement) {
      const rts = a.querySelectorAll('[data-automation-id="richText"]');
      if (rts.length === 1) { const p = rts[0].querySelector("p") || rts[0]; const t = stripStar(p.textContent); if (t) return t; }
      if (rts.length > 1) break; // reached a multi-question container (e.g. -section) → stop, don't collide
    }
    return null;
  };

  // ONE document-order walk: track the current h3/h4 section; emit a record per leaf value span + per
  // attachment widget.
  const records = [];
  let curSection = null;
  for (const el of container.querySelectorAll("*")) {
    const tag = el.tagName;
    if (tag === "H3" || tag === "H4") { const t = clean(el.textContent); if (t) curSection = t; continue; }
    const aid = el.getAttribute("data-automation-id");
    if (aid === "attachments-FileUpload") {
      const names = Array.prototype.map.call(el.querySelectorAll('[data-automation-id="file-upload-item-name"]'), (n) => clean(n.textContent)).filter(Boolean);
      const fk = fkitOf(el);
      records.push({ section: curSection, entryOrdinal: ordinalOf(el), fkitPrefix: fk.prefix, fkitNum: fk.num,
                     key: null, label: "Attachments", value: names.join(" "), isAttachment: true });
      continue;
    }
    if (tag === "SPAN" && el.id && el.children.length === 0) { // leaf value span; excludes <span id="attachments"> (has a <p>)
      const value = cleanVal(el.textContent);
      if (!value) continue;
      const fk = fkitOf(el);
      records.push({ section: curSection, entryOrdinal: ordinalOf(el), fkitPrefix: fk.prefix, fkitNum: fk.num,
                     key: el.id, label: labelOf(el, el.id), value, isAttachment: false });
    }
  }

  // section headings (logger/display only) + counts.
  const sections = [];
  for (const h of container.querySelectorAll("h3,h4")) { const t = clean(h.textContent); if (t) sections.push({ tag: h.tagName.toLowerCase(), text: t }); }
  const entrySet = {};
  for (const r of records) if (r.entryOrdinal != null && r.fkitPrefix) entrySet[r.fkitPrefix + "#" + r.entryOrdinal] = 1;

  return { ok: true, url, sections, items: records,
           counts: { records: records.length, entries: Object.keys(entrySet).length, attachments: records.filter((r) => r.isAttachment).length } };
}

// The emails Workday may pre-fill on the review page from the ACCOUNT you signed up with (NOT recorded
// in the bundle): the login credentials email + the profile's auth_strategy.account_email +
// personal_info.email. Passed to reconcileReviewPage so the displayed email is VERIFIED (a match = a
// positive "account-email" agree; a mismatch = a real disagree that blocks submit). Deduped + lowercased.
async function getAccountEmails() {
  return new Promise((resolve) => chrome.storage.local.get(["credentials", "profile"], (r) => {
    const out = [];
    const push = (e) => { if (e != null && String(e).trim()) out.push(String(e).trim().toLowerCase()); };
    if (r && r.credentials) push(r.credentials.email);
    if (r && r.profile) { push(r.profile.auth_strategy && r.profile.auth_strategy.account_email); push(r.profile.personal_info && r.profile.personal_info.email); }
    resolve(Array.from(new Set(out)));
  }));
}

// REVIEW-PAGE CHECK (end-to-end fill-verify): scrape the Workday review page (ground truth) via
// cdpReadReviewPage and reconcile it against the saved reviewSummary bundle (reconcileReviewPage, PURE).
// Disagreements ⇒ a fill bug to investigate. READ-ONLY — attaches, reads, detaches; NEVER clicks Next
// or Submit (the review page's footer button IS Submit). Run ON the review page (the walk stops here).
// Output is [REVIEW-CHECK] in the SW console + a summary in sendResponse. No profile/LLM needed.
async function runCdpReviewReconcile(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][REVIEW-CHECK]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    LOG("attached. READ-ONLY: scrapes the review page's displayed values and diffs them vs the saved reviewSummary bundle. NEVER clicks Next/Submit. Run ON the final review page.");

    // Read the saved bundle (the reconcile source of truth). The scraper is now id-driven — it does NOT
    // need value hints, so nothing is passed to cdpReadReviewPage.
    const bundle = await new Promise((resolve) => chrome.storage.local.get("reviewSummary", (r) => resolve((r && r.reviewSummary) || null)));
    const entries = bundle && Array.isArray(bundle.entries) ? bundle.entries : [];

    const dump = await cdpEval(cdpReadReviewPage);
    if (!dump || !dump.ok) {
      LOG("not on the review page (marker applyFlowReviewPage absent). reason:", dump && dump.reason, "· url:", dump && dump.url);
      return { ok: false, error: (dump && dump.reason) || "no-dump" };
    }
    LOG(`review page: ${dump.counts.records} record(s) — ${dump.counts.entries} repeating entr(y/ies) · ${dump.counts.attachments} attachment(s) · ${dump.sections.length} section(s).`);
    LOG("── SECTIONS ──"); for (const s of dump.sections) console.log("[ApplyPilot][REVIEW-CHECK]", JSON.stringify(s));
    LOG("── STRUCTURED RECORDS (section · entryOrdinal · fkitPrefix · key · label · value) ──"); for (const it of dump.items) console.log("[ApplyPilot][REVIEW-CHECK]", JSON.stringify(it));

    if (!entries.length) {
      LOG("⚠ NO reviewSummary bundle in storage — run the fill/walk first so there's something to check against. (Scraped records above are still shown.)");
      return { ok: true, url: dump.url, scraped: dump.counts.records, reconciled: false, note: "no-bundle" };
    }

    const rec = reconcileReviewPage(dump.items, entries, { accountEmails: await getAccountEmails() });
    const c = rec.counts;
    LOG(`── RECONCILIATION (bundle ${entries.length} entries · ${c.claimed} claimed value-bearing · ${c.skipped} skipped unchecked-box · ${c.placeholders} unreplaced AI) ──`);
    LOG(`AGREE ${c.agree} · DISAGREE ${c.disagree} · MISSING-ON-REVIEW ${c.missing_on_review} · EXTRA-ON-REVIEW ${c.extra_on_review} · AMBIGUOUS ${c.ambiguous}`);
    if (rec.disagree.length) { LOG("‼ DISAGREEMENTS (bundle value ≠ review page — investigate as BUGS):"); for (const d of rec.disagree) console.log("[ApplyPilot][REVIEW-CHECK]", JSON.stringify(d)); }
    else LOG("✓ no value disagreements among matched fields.");
    if (rec.missing_on_review.length) { LOG("⚠ FILLED IN BUNDLE, NOT FOUND ON REVIEW PAGE (value reverted to blank / label wording differs / unshown section):"); for (const m of rec.missing_on_review) console.log("[ApplyPilot][REVIEW-CHECK]", JSON.stringify(m)); }
    if (rec.ambiguous.length) { LOG("? AMBIGUOUS label matches (repeating-section collisions):"); for (const a of rec.ambiguous) console.log("[ApplyPilot][REVIEW-CHECK]", JSON.stringify(a)); }
    if (rec.extra_on_review.length) { LOG(`(info) ${rec.extra_on_review.length} review-page value(s) with no matching bundle entry (pre-filled / not recorded / per-entry attachment):`); for (const e of rec.extra_on_review) console.log("[ApplyPilot][REVIEW-CHECK]", JSON.stringify(e)); }
    // On a MISSING, re-print the structured records so the operator can eyeball which field didn't stick.
    if (rec.missing_on_review.length) { LOG("── STRUCTURED RECORDS (re-shown — locate the missing value) ──"); for (const r of dump.items) console.log("[ApplyPilot][REVIEW-CHECK]", JSON.stringify(r)); }

    return { ok: true, url: dump.url, scraped: dump.counts.records, reconciled: true, counts: c, disagree: rec.disagree, missing_on_review: rec.missing_on_review };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("review check aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

async function runCdpRepeatRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][REPEAT-RECON]", ...a);
  // self-contained segment read (value + focus) for the date probe read-backs
  const readVal = (sel) => cdpEval((s) => {
    const el = document.querySelector(s);
    return el ? { value: el.value, focused: document.activeElement === el, role: el.getAttribute("role") } : null;
  }, sel);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — recon starts on the first hidden read (60s window). Run on My Experience (page 2).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, nothing probed.");
      return { ok: false, error: "never-hidden" };
    }
    LOG("tab is hidden — repeating-section recon starting. (Δperf ~1000ms on the page loop is EXPECTED, not failure.)");

    // ── (1) structure dump ──────────────────────────────────────────────────
    const scan = await cdpEval(cdpRepeatingScan);
    if (!scan) return { ok: false, error: "scan-failed" };
    LOG("sections present:", JSON.stringify(scan.sectionsPresent), "| url:", scan.url);
    if (!scan.sectionsPresent.length) {
      LOG("⚠ NO repeating sections on this page — navigate to My Experience (page 2) and re-run.");
      return { ok: false, error: "no-repeating-sections", scan };
    }
    for (const prefix of scan.sectionsPresent) {
      const sec = scan.sections[prefix];
      LOG("── section", prefix, "— entryCount:", sec.entryCount);
      console.log("[ApplyPilot][REPEAT-RECON]", prefix, JSON.stringify(sec, null, 2));
    }
    LOG("add-buttons (rect + nearest heading — for findSectionAdd / clickSectionAdd):");
    console.log("[ApplyPilot][REPEAT-RECON]", JSON.stringify(scan.addButtons, null, 2));

    // ── (2) Websites shape check (sharpening 3) ───────────────────────────────
    const websites = scan.sections["webAddress-"];
    if (websites) {
      const e0 = websites.entries[0];
      const textFields = e0 ? e0.fields.filter((f) => f.widgetType === "text") : [];
      const anyDate = e0 ? e0.fields.some((f) => f.dateSegments.length > 0) : false;
      const anyHashed = e0 ? e0.fields.some((f) => f.hashedId) : false;
      const looksSimpleOneUrl = !!(e0 && e0.fieldCount === 1 && textFields.length === 1 && !anyDate && !anyHashed);
      LOG("WEBSITES shape check (sharpening 3):", JSON.stringify({
        present: true, entryCount: websites.entryCount,
        firstEntryFieldCount: e0 ? e0.fieldCount : 0,
        firstEntryFields: e0 ? e0.fields.map((f) => ({ field: f.fieldName, widget: f.widgetType, hashed: f.hashedId, dateSegs: f.dateSegments.length, required: f.isRequired })) : [],
        looksSimpleOneUrl
      }, null, 2));
      LOG(looksSimpleOneUrl
        ? "→ Websites looks like the simple one-url shape — a good DATE-FREE first section to prove the machinery."
        : "→ Websites shape DIFFERS from the assumed one-url field — the cleanest-section pick may need to change (sharpening 3).");
    } else {
      LOG("WEBSITES not present on this page — the date-free first-section pick may need to change (sharpening 3). Sections here:", JSON.stringify(scan.sectionsPresent));
    }

    // ── (3) DATE-SPINBUTTON probe (the key unknown) ───────────────────────────
    const dateField = (() => {
      for (const prefix of scan.sectionsPresent) {
        for (const e of scan.sections[prefix].entries) {
          const f = e.fields.find((x) => x.dateSegments.length > 0);
          if (f) return { prefix, entryFkitId: e.entryFkitId, field: f };
        }
      }
      return null;
    })();

    const probe = { attempted: false };
    if (!dateField) {
      LOG("date probe SKIPPED — no date field on this page. (The composite is only needed by date-bearing sections; if the first section is date-free, it waits regardless.)");
    } else {
      probe.attempted = true;
      // M33: target the EDITABLE spinbutton input, NOT the read-only -display span.
      // The original probe used dateSegments[0] = "dateSection*-display" (a span with
      // no .value), so readVal compared undefined==="12" and false-negatived EVERY
      // method regardless of whether the keystrokes actually landed. fillDateComposite
      // fills the -input; a human can type it — so re-probe the real input.
      const seg = dateField.field.dateSegments.find((s) => /-input$/.test(s)) || dateField.field.dateSegments[0];
      const segSel = dateField.field.wrapperSel + ' [data-automation-id="' + seg + '"]';
      probe.target = { section: dateField.prefix, entry: dateField.entryFkitId, field: dateField.field.fieldName, segment: seg, segSel };
      LOG("date probe target:", JSON.stringify(probe.target));
      const orig = await readVal(segSel);
      probe.originalValue = orig ? orig.value : null;
      probe.segmentRole = orig ? orig.role : null; // expect "spinbutton" — confirms we hit the -input, not a -display span
      LOG("date probe segment element:", JSON.stringify({ segment: seg, role: probe.segmentRole, originalValue: probe.originalValue }));
      const want = "12";
      // M33 iter-2: the masked -input is 0-box (coordinate-click impossible — iter-1 proved
      // its rect is dead). Per Claude-in-Chrome's live recipe: focus the VISIBLE -display via
      // a TRIPLE-CLICK, then PER-CHAR type the digits (insertText/value-set no-ops on these
      // spinbuttons). Read-back stays the -input.value (parseInt). Decouple focus from input.
      const displaySel = dateField.field.wrapperSel + ' [data-automation-id="' + seg.replace("-input", "-display") + '"]';
      const yearInputSel = dateField.field.wrapperSel + ' [data-automation-id="dateSectionYear-input"]';
      const tripleClickAt = async (x, y) => {
        const base = { x: Math.round(x), y: Math.round(y), button: "left", pointerType: "mouse" };
        await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: base.x, y: base.y, button: "none", buttons: 0, pointerType: "mouse" });
        for (let i = 1; i <= 3; i++) {
          await cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1, clickCount: i });
          await cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0, clickCount: i });
        }
      };
      const refocus = async (method, dispRect) => {
        if (method === "triple-click-display" && dispRect) await tripleClickAt(dispRect.cx, dispRect.cy);
        else if (method === "el.focus()") await cdpEval(cdpFocusBySel, segSel);
        else { try { await cdpDomFocus(segSel); } catch (e) { /* not found */ } }
        await cdpDelay(150);
      };

      // ── focus ladder: visible-display triple-click → rect-free fallbacks ──
      let focusMethod = null;
      const dispRect = await cdpRectReady(displaySel, true); // the VISIBLE element has a rect
      probe.displayRectLive = !!dispRect;
      if (dispRect) {
        await tripleClickAt(dispRect.cx, dispRect.cy);
        await cdpDelay(250);
        const f = await readVal(segSel);
        if (f && f.focused) focusMethod = "triple-click-display";
      }
      if (!focusMethod) { // rect-free: page el.focus() on the -input
        if (await cdpEval(cdpFocusBySel, segSel)) { await cdpDelay(150); const f = await readVal(segSel); if (f && f.focused) focusMethod = "el.focus()"; }
      }
      if (!focusMethod) { // rect-free: CDP DOM.focus on the -input
        try { await cdpDomFocus(segSel); await cdpDelay(150); const f = await readVal(segSel); if (f && f.focused) focusMethod = "DOM.focus"; } catch (e) { /* not found */ }
      }
      probe.focusMethod = focusMethod;
      LOG("date probe focus:", JSON.stringify({ focusMethod: focusMethod || "NONE", displayRectLive: probe.displayRectLive }));

      if (!focusMethod) {
        probe.insertText = { skipped: "no-focus" };
        probe.typeChars = { skipped: "no-focus" };
        LOG("date probe: could NOT focus the segment input by any method (triple-click-display / el.focus / DOM.focus).");
      } else {
        // (a) CONTRAST: insertText / value-set — expected NOT to stick on these spinbuttons.
        await cdpSelectAllDelete(); await cdpDelay(150);
        await cdpInsertText(want); await cdpDelay(300);
        const a = await readVal(segSel);
        probe.insertText = { read: a ? a.value : null, stuck: !!(a && parseInt(a.value, 10) === parseInt(want, 10)) };
        LOG("date probe (a) insertText [expected: does NOT stick]:", JSON.stringify(probe.insertText));

        // (b) THE recipe — per-char trusted keystrokes (re-assert focus first; (a) may have shifted it).
        await refocus(focusMethod, dispRect);
        await cdpSelectAllDelete(); await cdpDelay(150);
        await cdpTypeChars(want, 80); await cdpDelay(300);
        const b = await readVal(segSel);
        probe.typeChars = { read: b ? b.value : null, stuck: !!(b && parseInt(b.value, 10) === parseInt(want, 10)) };
        LOG("date probe (b) typeChars [THE recipe]:", JSON.stringify(probe.typeChars));

        // auto-advance GATE (not just a logged field): after the 2 month digits, is the YEAR
        // -input focused? Auto-advance is a page reaction on the throttled loop — may lag/no-op
        // hidden. If it fired, type the year too (exercise the full M/Y path). If not, M34 must
        // focus the year segment EXPLICITLY between digits rather than rely on advance.
        const yf = await readVal(yearInputSel);
        probe.autoAdvancedToYear = !!(yf && yf.focused);
        LOG("date probe auto-advance:", JSON.stringify({ autoAdvancedToYear: probe.autoAdvancedToYear }));
        if (probe.autoAdvancedToYear) {
          await cdpTypeChars("2024", 80); await cdpDelay(300);
          const yr = await readVal(yearInputSel);
          probe.year = { read: yr ? yr.value : null, stuck: !!(yr && parseInt(yr.value, 10) === 2024) };
          LOG("date probe year (auto-advanced):", JSON.stringify(probe.year));
        }
      }

      probe.anyMethodStuck = !!((probe.insertText && probe.insertText.stuck) || (probe.typeChars && probe.typeChars.stuck));

      // STOP-and-surface — a total failure stays a recorded known-blocker; a per-char success lifts it.
      if (!probe.anyMethodStuck) {
        LOG("⛔ DATE PROBE FAILED — focus", JSON.stringify(probe.focusMethod || "NONE"), "but NO input method made -input.value stick (insertText + per-char both failed read-back). Dates stay DEFERRED on CDP — record the focus/input trace in dom-patterns.");
      } else {
        const winner = probe.typeChars && probe.typeChars.stuck ? "typeChars (per-char)" : "insertText";
        LOG("✅ date probe: CDP CAN fill the segment — focus via", JSON.stringify(probe.focusMethod), "+ input via", winner, "(read-back verified). M34 can build the composite.");
      }

      // restore-where-possible (re-type the original month, best-effort — per-char, since insertText no-ops)
      probe.restored = false;
      try {
        await refocus(focusMethod, dispRect);
        await cdpSelectAllDelete(); await cdpDelay(120);
        if (probe.originalValue) { await cdpTypeChars(String(probe.originalValue), 80); await cdpDelay(150); }
        const rr = await readVal(segSel);
        probe.restored = !!(rr && parseInt(rr.value, 10) === parseInt(probe.originalValue || "", 10));
      } catch (e) { /* best-effort */ }
      LOG("date probe restore:", probe.restored ? "restored to original" : "left modified (throwaway app — re-fill or discard the entry).");
    }

    // ── summary ───────────────────────────────────────────────────────────────
    LOG("── RECON SUMMARY ──");
    console.log("[ApplyPilot][REPEAT-RECON]", JSON.stringify({
      url: scan.url,
      sectionsPresent: scan.sectionsPresent,
      entryCounts: Object.fromEntries(scan.sectionsPresent.map((p) => [p, scan.sections[p].entryCount])),
      addButtonCount: scan.addButtons.length,
      websitesPresent: !!scan.sections["webAddress-"],
      dateProbe: probe.attempted
        ? { attempted: true, focusMethod: probe.focusMethod || null, anyMethodStuck: probe.anyMethodStuck, autoAdvancedToYear: probe.autoAdvancedToYear || false, methods: { insertText: probe.insertText, typeChars: probe.typeChars }, year: probe.year || null }
        : { attempted: false, reason: "no date field on this page" }
    }, null, 2));
    return { ok: true, scan, probe };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// fillAndPersistPage (M38 Part 3 extraction) — the per-page work shared by the
// single-page fill (runCdpFillPage) AND the N-page walk (runCdpWalk). On an ALREADY-
// ATTACHED tab: compute the accumulation key → fold-fill (drivePageFill: flat + every
// present repeating section + the inline M40 audit) → report → persist the audit
// expectations + build & ACCUMULATE the review bundle (write-per-page). Takes the
// PREPARED profile + a made `act` (the caller owns attach/detach + prepareProfile, so
// the walk prepares once + attaches once across pages). Returns { out, bundle, auditFlags }.
// ============================================================================
async function fillAndPersistPage(act, prepared, defaults, jobContext, LOG, opts) {
  // Accumulation merge key — the PRE-fill cdpPageKey (url PATHNAME [drops the volatile
  // query] + sorted field-set: STABLE per page across re-runs, DISTINCT across pages even
  // on a same-pathname SPA). Computed BEFORE the fill (a field-revealing fill could change
  // the field-set). NOT cdpPageSig (full url incl. query).
  const pageKey = cdpPageKey(await cdpEval(cdpPageScan));
  // Plan 2: the walk passes its 1..N ordinal so the bundle carries a stable page_number (display
  // order) + a friendly page_label; single-page fills (no ordinal) leave them null (viewer derives).
  const pageNumber = (opts && opts.pageNumber != null) ? opts.pageNumber : null;
  const pageLabel = pageNumber != null ? ("Page " + pageNumber) : null;
  // Operator input-lock: install BEFORE any actuation (idempotent — re-creates the overlay on a
  // fresh page after a nav, so the walk re-protects each page). The 4 CDP input primitives gate
  // on the counter it sets; the caller removes it in its finally (alongside cdpDetach).
  await installInputLock();
  // m3b: pass the prior run's DETECTED section shapes as the reveal-by-add cache so mounting an
  // entry to discover an EMPTY unknown section's fields fires at most once per bundle-lifetime
  // (not every fill — the "fast, especially hidden" constraint). headingToBase lets the pre-mount
  // cache check work for an empty section (base unknown until mounted → matched by heading).
  const priorSum = await new Promise((resolve) => chrome.storage.local.get("reviewSummary", (r) => resolve((r && r.reviewSummary) || null)));
  const cachedShapes = (priorSum && priorSum.section_shapes) || {};
  const headingToBase = {};
  for (const e of ((priorSum && priorSum.entries) || [])) {
    if (e && e.widget_type === "section_stub" && e.section_heading && typeof e.canonical_field === "string") headingToBase[e.section_heading] = e.canonical_field.replace(/\._stub$/, "");
  }
  // (The act.attachStoredResume seam — the TEST-ONLY per-cert résumé attach — was verified live
  // 2026-07-02 and then REMOVED with the profile test data. The résumé attaches ONLY to the
  // top-level Documents field, via the post-fill step below.)
  // Profile v2 — answer buckets (wording → answer). SW reads them from storage (engine computes /
  // SW does I/O) and hands them to the driver, which consults them before the AI pass.
  const buckets = await new Promise((resolve) => chrome.storage.local.get("buckets", (r) => resolve((r && Array.isArray(r.buckets)) ? r.buckets : [])));
  const out = await drivePageFill(act, prepared, defaults, jobContext, {}, { cachedShapes, headingToBase, buckets });

  LOG("page:", out.url);
  if (out.sessionWarning) LOG(`⚠⚠ ${out.sessionWarning}`); // M30 early-warning, leads the report
  LOG(`════ NEEDS REVIEW (${out.needsReview.length}) ════`);
  for (const r of out.needsReview) {
    LOG(`  ⚠ [${r.status}] ${r.fieldName} (${r.widgetType}) — "${r.label}" → ${r.detail}${r.after ? ` | currently: "${r.after}"` : ""}`);
  }
  console.table(out.results.map((r) => ({
    field: r.fieldName, type: r.widgetType, status: r.status, after: r.after,
    verified: r.verified, tier: r.matchTier, flag: r.flag, confidence: r.confidence, detail: r.detail
  })));
  LOG("counts:", JSON.stringify(out.counts));
  // Delay-1 recon (instrumentation): per-candidate typeahead/source settle trace — reveals WHERE a
  // slow overwrite-walk (e.g. CPP) spends its time (outcome + ms + filtered option count per candidate).
  for (const r of out.results) {
    if (!Array.isArray(r.settle_trace) || !r.settle_trace.length) continue;
    LOG(`settle trace — ${r.fieldName} (${r.widgetType}):`);
    for (const s of r.settle_trace) {
      LOG(`    cand "${s.candidate}" → ${s.outcome || "?"} (${s.settleMs != null ? s.settleMs + "ms" : "?"}, ${s.count != null ? s.count + " options" : "? options"}, banner:${!!s.banner}, open:${!!s.open}, chip:${s.chips ? `"${s.chips}"` : "none"})${s.note ? " — " + s.note : ""}`);
    }
    LOG(`    → final ${r.fieldName} value: ${r.after ? `"${r.after}"` : "(none)"} [${r.status}] — cross-check vs the settle-end chip (labeling vs wrong-value)`);
  }

  // Walk prereq 1 (resume attach): the CDP fold records file_upload as `skipped` (it can't
  // attach). Here the SW reads the stored resume (IndexedDB) + runs the PROVEN attachResume
  // via cdpEval on the SAME debugger attach (recon 2026-06-21: works VISIBLE, idempotent —
  // clears existing then attaches; gate = file-upload-successful). Patch the file_upload
  // record BEFORE buildReviewBundle so the bundle reflects it. No resume / failed →
  // needs_review (self-explaining); the walk's pre-advance check HALTS on it (a required
  // upload empty blocks Save & Continue). NOTE: attachResume's attached:true is the engine's
  // claim; the FORM accepting it (Save & Continue advances) is the form's truth — the walk's
  // advance is the decisive proof, not this record.
  // Exclude nested-attachment records (a cert's per-entry Attachments — its own in-section attach
  // path): on a page with no top-level upload, the bare find() would grab a cert's record and
  // patch the résumé onto the WRONG field.
  const uploadRec = out.results.find((r) => r.widgetType === "file_upload" && r.flag !== "nested-attachment");
  if (uploadRec) {
    let resumeRec = null;
    try { resumeRec = await getResume(); } catch (e) { /* treat as none */ }
    if (!resumeRec || !resumeRec.base64) {
      uploadRec.status = "needs_review"; uploadRec.verified = false;
      uploadRec.detail = "no resume stored — upload a PDF in the popup first (the required upload blocks Save & Continue)";
      LOG("resume: NOT attached — no resume stored (upload one in the popup).");
    } else {
      let ar = null, arErr = null;
      // The input-lock's capture-phase blocker SWALLOWS attachResume's SYNTHETIC delete/attach clicks
      // (they're dispatchEvent, not the gated cdpClickAt) whenever window.__apActing is 0 — that's why
      // clearing an EXISTING attachment intermittently failed under the walk's lock ("removed 0, N
      // remain"; a clean 0-attachment page worked because the attach's `change` event isn't blocked).
      // Bump __apActing around the attach (exactly how the gated CDP primitives gate themselves) so
      // attachResume's events pass (the input-lock is always installed for the fill).
      try { await cdpEval(() => { window.__apActing = (window.__apActing || 0) + 1; }); } catch (e) { /* no lock/page — ignore */ }
      try { ar = await cdpEval(attachResume, resumeRec.base64, resumeRec.filename || "resume.pdf", resumeRec.mime || "application/pdf"); }
      catch (e) { arErr = String((e && e.message) || e); }
      finally { try { await cdpEval(() => { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }); } catch (e) { /* ignore */ } }
      if (ar && ar.attached) {
        uploadRec.status = "filled"; uploadRec.verified = true; uploadRec.after = ar.fileName || resumeRec.filename || null;
        uploadRec.detail = `resume attached (file-upload-successful, cleared ${ar.deletedCount || 0} existing)`;
        LOG(`resume: attached "${uploadRec.after}".`);
      } else {
        uploadRec.status = "needs_review"; uploadRec.verified = false;
        uploadRec.detail = "resume attach failed — " + (arErr || (ar && ar.detail) || "no confirmation");
        LOG("resume: NOT attached —", uploadRec.detail);
      }
    }
  }

  // M40 post-fill audit: the inline audit already ran inside drivePageFill (its mismatches
  // are in out.results/out.needsReview). Log the audit outcome + PERSIST the expectations
  // (out.audit) so the standalone "re-audit" can re-read the live page later. Overwrite-per-
  // fill — the audit is about the CURRENT live page, not accumulated.
  const auditFlags = out.results.filter((r) => r.flag === "audit-mismatch" || r.flag === "audit-unverifiable");
  LOG(`audit: re-read ${(out.audit || []).length} filled field(s) post-settle —`, auditFlags.length ? `${auditFlags.length} FLAGGED (${auditFlags.map((r) => r.fieldName + ":" + r.flag).join(", ")})` : "all matched the report");
  await new Promise((resolve) => chrome.storage.local.set({ reviewAudit: { pageKey, savedAt: new Date().toISOString(), entries: out.audit || [] } }, resolve));

  // M38 Part 2: build the review-summary bundle from the results + accumulate (write-per-page).
  const tenant = (() => { try { return new URL(out.url).hostname; } catch (e) { return null; } })();
  const bundle = buildReviewBundle(out.results, { page: pageKey, pageNumber, pageLabel, url: out.url, tenant, capturedAt: new Date().toISOString(), sectionShapes: out.sectionShapes });
  await persistAccumulated(bundle);
  return { out, bundle, auditFlags, pageKey };
}

// AI-4: rebuild + re-persist the page bundle from the CURRENT out.results (after remediation
// mutates them) — reuses the SAME pageKey so the accumulation merge replaces this page (no
// duplicate). Keeps the persisted review bundle an honest audit trail of what AI-4 changed.
async function repersistPageBundle(out, pageKey, pageNumber) {
  const tenant = (() => { try { return new URL(out.url).hostname; } catch (e) { return null; } })();
  const pageLabel = (pageNumber != null) ? ("Page " + pageNumber) : null;
  const bundle = buildReviewBundle(out.results, { page: pageKey, pageNumber: pageNumber != null ? pageNumber : null, pageLabel, url: out.url, tenant, capturedAt: new Date().toISOString(), sectionShapes: out.sectionShapes });
  await persistAccumulated(bundle);
  return bundle;
}

// AI-4: re-fill ONE field with a SPECIFIC value (Tier-2's corrected value) through the SAME
// per-widget CDP handler the page fill uses — choice widgets still clear the match ladder (never
// blind-commit). Tier-1 uses drivePageFill(onlyFieldNames) instead (re-fills from the PROFILE).
async function refillFieldWithValue(act, f, value, budgets) {
  const loc = { wrapperSel: f.wrapperSel };
  const v = value == null ? "" : String(value);
  if (f.widgetType === "text") return await fillTextCdp(act, loc, v, budgets, "input");
  if (f.widgetType === "textarea") return await fillTextCdp(act, loc, v, budgets, "textarea");
  if (f.widgetType === "dropdown") return await fillDropdownCdp(act, loc, [v], budgets);
  if (f.widgetType === "typeahead") return await fillTypeaheadCdp(act, loc, [v], budgets);
  if (f.widgetType === "hierarchical") return await fillSourceCdp(act, loc, [v], budgets);
  return { status: "needs_review", after: null, detail: "AI-4: cannot refill widget type " + f.widgetType };
}

// AI-4: merge a remediation record into out.results — replace the existing record for that field
// (so the bundle shows the post-remediation state), else append.
function mergeRemediationRecord(out, rec) {
  const i = out.results.findIndex((r) => r.fieldName === rec.fieldName);
  if (i !== -1) out.results[i] = rec; else out.results.push(rec);
}

// AI-4 validation-error remediation loop (Tier 0 dup-language → Tier 1 flat re-fill → Tier 1.5
// empty-repeating-row DELETE → Tier 1.6 section re-fill → Tier 2 AI), bounded + halt-on-no-progress,
// and NEVER acting without error text (each attempt is gated on a non-empty expanded error read).
// Runs ONLY when the session is LIVE (the caller already excluded sessionDead) and Save & Continue
// stayed put. GLOBAL shared cap across ALL tiers (REMEDIATION_MAX — Hold 1, "not 2+2"); halts the
// instant the error set is UNCHANGED after an action (no point re-firing the same fix). Every action
// is recorded into out.results (flag ai-remediation) + the bundle re-persisted. NEVER submits — the
// re-Save&Continue is the GUARDED clickPageNext (refuses on the review marker).
const REMEDIATION_MAX = 3;
// The re-navigation AFTER a remediation action needs a MORE generous wall-clock ceiling than the
// initial Save. When the tab is HIDDEN the page runs throttled (~1Hz) — CDP actuation is throttle-
// immune but Workday's own post-Save validation + route transition are not. The live hidden page-2→3
// stall (2026-07-03): Tier-0 cleared the throttle-induced phantom "Duplicate language" error, but the
// throttled navigation hadn't finished inside the default 15s, so the walk halted "errors-cleared-
// not-advancing". A genuine validation error still fast-exits in ~1s (errors ⟺ won't-advance), so this
// larger ceiling ONLY extends the no-error slow-nav case; a VISIBLE fast nav returns early either way.
const REMEDIATION_RENAV_CEILING_MS = 40000;
async function remediatePageErrors(act, profile, defaults, jobContext, out, pageKey, page, LOG) {
  const actions = [];
  // expandErrorSamples (lib.js): Workday's top banner concatenates EVERY error into one element —
  // split into individual errors + drop success toasts, so no error hides from the tiers (the
  // 2026-07-01 live Tier-0 dup-language miss was a truncated concatenated banner).
  const readErrors = async () => {
    let st = null; try { st = await cdpEval(cdpReadSessionState); } catch (e) { /* ignore */ }
    return expandErrorSamples((st && st.errorMarkers && st.errorMarkers.samples) || []);
  };
  // POLL for the banner: it renders LATER than the ~1s fast-exit that got us here (live 2026-07-02:
  // remediation read "0 error(s)" and Tier 2 acted BLIND — deleted a correctly-filled cert entry).
  let prevErrors = await readErrors();
  for (let poll = 0; poll < 8 && !prevErrors.length; poll++) { await cdpDelay(500); prevErrors = await readErrors(); }
  // Diagnostic: a HIDDEN (throttled) tab is the 2026-07-03 signature — Workday's page-side validation
  // misfires the "Duplicate language" phantom + navigates slowly under ~1Hz throttling, while a VISIBLE
  // tab advances cleanly. Log it so a stuck hidden run is unambiguous in the trace. Reads REAL visibility
  // (SW-side) — NOT document.visibilityState, which the rAF-override fix may spoof to "visible".
  let _vis = null; try { _vis = await cdpVisibilityLabel(); } catch (e) { /* ignore */ }
  LOG(`AI-4 remediation: page ${page} blocked with ${prevErrors.length} error(s) [tab ${_vis || "?"}]. Attempting (cap ${REMEDIATION_MAX}, halt on no-progress).`);

  for (let attempt = 1; attempt <= REMEDIATION_MAX; attempt++) {
    // NEVER act blind: with no error text there is nothing to anchor a SAFE action on — every tier
    // (incl. the AI) would be guessing (the blind Tier-2 delete_entry lesson). Also the clean exit
    // when an action CLEARED the errors but the page still didn't advance: hand the state to the
    // operator instead of burning the cap on guesses.
    if (!prevErrors.length) {
      LOG(`  no error text on the page — ${attempt === 1 ? "nothing to anchor a remediation on" : "errors cleared but the page did not advance"}; halting (no blind actions).`);
      return { advanced: false, reason: attempt === 1 ? "no-error-text" : "errors-cleared-not-advancing", attempts: attempt - 1, actions };
    }
    let didSomething = false;

    // ── Tier 0 (HARDCODED, DETERMINISTIC, no AI): the known Magna/Workday phantom "Duplicate
    //    language entries are not allowed" bug. Scoped to LANGUAGES. Real-vs-phantom is read from
    //    the already-audited fill results (the M40 audit just confirmed they match the live page):
    //    a REAL dupe (two same language values) → delete only the later occurrence(s); a PHANTOM
    //    (distinct values, Workday's bug) → delete ALL. Recorded with the deleted CONTENT so the
    //    languages are re-addable; the delete loop halts on no-progress. ──
    if (isDuplicateLanguageError(prevErrors)) {
      const entries = languageEntriesFromResults(out.results);
      const plan = languageDeletionPlan(entries);
      LOG(`  attempt ${attempt} (Tier 0, dup-language ${plan.mode}): deleting ${plan.deleteIndices.length}/${entries.length} entry(ies) [${plan.summary}]`);
      let deleted = 0;
      for (const idx of plan.deleteIndices.slice().sort((a, b) => b - a)) { // highest-first → lower indices stay valid
        const before = await act.entryCount("language-");
        if (before <= 0) break;
        const clicked = await act.clickDeleteEntry("language-", idx);
        if (!clicked || !clicked.ok) break;
        let now = before, polls = 0;
        while (polls++ < 20) { now = await act.entryCount("language-"); if (now < before) break; await act.delay(DEFAULT_BUDGETS.interFieldMs); }
        if (now >= before) break; // NO PROGRESS (count didn't drop) → stop, don't spin the bound (Hold B3)
        deleted++;
      }
      mergeRemediationRecord(out, {
        fieldName: "language.duplicate-fix", label: "Duplicate-language workaround", widgetType: "remediation",
        status: "needs_review", flag: "ai-remediation", after: null,
        detail: `AI-4 hardcoded Workday duplicate-language fix (${plan.mode}): deleted ${deleted}/${entries.length} entry(ies) — re-add manually if needed: ${plan.summary}`
      });
      actions.push({ tier: 0, action: "delete-language-" + plan.mode, deleted, languages: plan.summary });
      didSomething = true;
    }

    // ── Tier 1 (DETERMINISTIC, no AI): re-fill the MAPPED fields the error TEXT names, from the
    //    profile, through the SAME drivePageFill path. Replaces the old anchor-click-to-focus
    //    (which didn't fire on Magna; the text-parse does). Unmapped named fields fall through to
    //    the AI tier. Re-filling an already-correct field is harmless (same value). ──
    if (!didSomething) {
      const scan = await act.scanPage();
      const refill = new Set(mappedFieldsFromErrors(prevErrors, scan.fields, FIELD_MAP));
      if (refill.size) {
        LOG(`  attempt ${attempt} (Tier 1, deterministic): error names → re-fill mapped field(s) [${[...refill].join(", ")}] from the profile (no AI).`);
        const rOut = await drivePageFill(act, profile, defaults, jobContext, {}, { onlyFieldNames: refill });
        for (const r of (rOut.results || [])) {
          r.flag = "ai-remediation"; r.status = r.status === "filled" ? "filled_review" : r.status;
          r.detail = "AI-4 Tier-1 deterministic re-fill — " + (r.detail || "");
          mergeRemediationRecord(out, r);
        }
        actions.push({ tier: 1, refilled: [...refill] });
        didSomething = true;
      }
    }

    // ── Tier 1.5 (DETERMINISTIC DELETE, no AI — operator rule 2026-07-02): the error names a
    //    REPEATING-section field → the offending rows are DELETABLE BY NATURE (a repeating section
    //    is optional). Delete every row whose named field reads EMPTY — that's what "is required
    //    and must have a value" points at, and a row the operator hand-FILLED never reads empty,
    //    so it's never deleted. A NESTED (layer-2) field deletes ONLY the inner rows (cert ▸
    //    specialties), never the parent entry. Runs BEFORE the section re-fill: deleting the
    //    blocking row is cheaper and safer than re-running the whole section. ──
    let named = [];
    if (!didSomething) {
      named = prevErrors.map((t) => parseErrorFieldName(t)).filter(Boolean);
      const targets = deleteTargetsFromErrorNames(named);
      if (targets.length) {
        const del = await deleteEmptyErrorRows(act, targets, DEFAULT_BUDGETS);
        if (del.deleted.length) {
          const summary = del.deleted.map((d) => d.kind === "nested"
            ? `${d.section}[${d.parentIndex}] ▸ ${d.child} row ${d.index}`
            : `${d.section} entry ${d.index}`).join(", ");
          LOG(`  attempt ${attempt} (Tier 1.5, deterministic DELETE): error names [${named.join(", ")}] → deleted ${del.deleted.length} EMPTY repeating row(s): ${summary}.`);
          mergeRemediationRecord(out, {
            fieldName: "remediation.row-delete", label: "Removed empty repeating row(s)", widgetType: "remediation",
            status: "needs_review", flag: "ai-remediation", after: null,
            detail: `AI-4 Tier-1.5: deleted ${del.deleted.length} EMPTY row(s) named by the validation error (${summary}) — repeating sections are optional; re-add manually if needed`
          });
          actions.push({ tier: 1.5, action: "delete-empty-rows", deleted: del.deleted });
          didSomething = true;
        }
      }
    }

    // ── Tier 1.6 (DETERMINISTIC, no AI): the error names a section field whose rows are NOT empty
    //    (a value problem, not a missing-row problem) → re-run JUST the owning section(s) via
    //    drivePageFill({onlySections}) — reconcile-UP + re-fill. preserveExtras: the re-run NEVER
    //    reconciles DOWN (entries beyond profile-N may be the operator's manual additions). ──
    if (!didSomething) {
      const secNames = sectionsFromErrorNames(named);
      if (secNames.length) {
        LOG(`  attempt ${attempt} (Tier 1.6, deterministic): error names section field(s) [${named.join(", ")}] → re-run section(s) [${secNames.join(", ")}] (no AI, manual entries preserved).`);
        const rOut = await drivePageFill(act, profile, defaults, jobContext, {}, { onlySections: new Set(secNames), preserveExtras: true });
        for (const r of (rOut.results || [])) {
          r.flag = "ai-remediation"; r.status = r.status === "filled" ? "filled_review" : r.status;
          r.detail = "AI-4 Tier-1.6 section re-fill — " + (r.detail || "");
          mergeRemediationRecord(out, r);
        }
        actions.push({ tier: 1.6, sections: secNames, named });
        didSomething = true;
      }
    }

    // ── Tier 2 (AI, LAST RESORT — only when the deterministic tiers couldn't act): parse the field
    //    name + ask the AI for ONE bounded action (refill a named field / delete a duplicate entry / none). ──
    if (!didSomething) {
      const scan = await act.scanPage();
      let rscan = null; try { rscan = await act.repeatingScan(); } catch (e) { /* flat-only */ }
      const sections = rscan && rscan.sections ? rscan.sections : null;
      const named = prevErrors.map((t) => parseErrorFieldName(t)).filter(Boolean);
      const fieldsForAi = scan.fields.map((f) => {
        const rec = out.results.find((r) => r.fieldName === f.fieldName);
        return { fieldName: f.fieldName, label: f.label, widgetType: f.widgetType, after: rec ? rec.after : null };
      });
      const decision = await aiRemediateError(act, prevErrors, { fields: fieldsForAi, sections }, DEFAULT_BUDGETS);
      LOG(`  attempt ${attempt} (Tier 2, AI): action=${decision.action}` +
        (decision.field ? ` field=${decision.field}` : "") +
        (decision.section ? ` section=${decision.section}#${decision.index}` : "") +
        (named.length ? ` | error named: ${named.join(", ")}` : "") + ` (${decision.reason || ""})`);
      if (decision.action === "refill") {
        const f = scan.fields.find((x) => x.fieldName === decision.field);
        if (f) {
          let r, refillNote;
          if (f.widgetType === "hierarchical") {
            // Source is a click-TREE — NEVER flat-type the AI's guess ("job boards" is what that produced).
            // Re-run the ordered drill from the profile's how_did_you_hear fallback (LinkedIn first) WITH
            // the tree-drill AI context, so it drills category → recon leaves → pick leaf → commit. Required.
            const hdyh = (profile && profile.how_did_you_hear) || (defaults && defaults.how_did_you_hear);
            const cands = hdyh && Array.isArray(hdyh.preferred) && (hdyh.preferred.length || hdyh.fallback)
              ? [...hdyh.preferred, ...(hdyh.fallback ? [hdyh.fallback] : [])]
              : [decision.value];
            const aiForSource = act.aiEnabled
              ? { profile, jobContext, isRequired: true, label: f.label, fieldName: f.fieldName, sourceTree: true }
              : undefined;
            r = await fillSourceCdp(act, { wrapperSel: f.wrapperSel }, cands, DEFAULT_BUDGETS, { ai: aiForSource });
            refillNote = `AI-4 Tier-2 re-drill source from how_did_you_hear [${cands.slice(0, 3).join(", ")}…] — `;
          } else {
            r = await refillFieldWithValue(act, f, decision.value, DEFAULT_BUDGETS);
            refillNote = `AI-4 Tier-2 refill "${decision.value}" — `;
          }
          mergeRemediationRecord(out, Object.assign({ fieldName: f.fieldName, label: f.label, widgetType: f.widgetType }, r, {
            flag: "ai-remediation", status: r.status === "filled" ? "filled_review" : r.status,
            detail: refillNote + (r.detail || decision.reason || "")
          }));
          actions.push({ tier: 2, action: "refill", field: decision.field, value: f.widgetType === "hierarchical" ? "(source drill)" : decision.value });
          didSomething = true;
        } else { LOG(`    AI named field "${decision.field}" not on the page — skipping.`); }
      } else if (decision.action === "delete_entry") {
        const del = await act.clickDeleteEntry(decision.section, decision.index);
        LOG(`    delete_entry ${decision.section}#${decision.index}: ${JSON.stringify(del)}`);
        mergeRemediationRecord(out, {
          // widgetType "remediation" (NOT "section") so buildReviewBundle KEEPS it — a deletion leaves
          // no field to review otherwise, and the plan wants the autonomous deletion conspicuous.
          fieldName: `${decision.section}[${decision.index}]`, label: "Removed duplicate/extra entry", widgetType: "remediation",
          status: "needs_review", flag: "ai-remediation", after: null,
          detail: `AI-4 Tier-2 DELETED ${decision.section} entry #${decision.index} (${decision.reason || "duplicate/extra"}) — verify the remaining entries`
        });
        actions.push({ tier: 2, action: "delete_entry", section: decision.section, index: decision.index });
        didSomething = decision.action ? (del && del.ok) : false;
      } else {
        LOG(`    AI declined (${decision.reason || "none"}) — no safe action.`);
      }
    }

    if (!didSomething) {
      // hand the state to the operator with a TRUTHFUL summary (no click follows, same rule)
      try { await reconPageTruth(act, out.results); } catch (e) { /* read-only — persist regardless */ }
      await repersistPageBundle(out, pageKey, page);
      return { advanced: false, reason: "no-action", attempts: attempt, actions };
    }

    // ── PRE-ADVANCE TRUTH RECON (operator rule 2026-07-02): before EVERY re-Save&Continue, re-recon
    // the live page and re-persist — the summary shows EXACTLY what is on the page at this click
    // (deleted rows drop, shifted/changed values refresh, unvouched values surface as already-filled;
    // the synthetic "remediation" rows never reach the bundle — buildReviewBundle filters them). The
    // latest persist OVERRIDES this page's earlier ones (accumulate merges on the page key). ──
    try { await reconPageTruth(act, out.results); } catch (e) { LOG("  pre-advance recon failed (persisting records as-is):", String((e && e.message) || e)); }
    await repersistPageBundle(out, pageKey, page);

    // ── re-Save & Continue (GUARDED — refuses on the review marker) + wait. ──
    const prevSig = cdpPageSig(await cdpEval(cdpPageScan));
    await cdpWakePage(); // wake a frozen hidden tab so the post-remediation transition can run
    const click = await act.clickPageNext();
    if (!click.clicked) {
      if (click.blockedBy) LOG(`re-Save&Continue refused — a popup/overlay is COVERING the button: ${click.blockedBy}`);
      return { advanced: false, reason: "click-refused:" + (click.refused || "?"), blockedBy: click.blockedBy || null, attempts: attempt, actions };
    }
    // Throttle-generous ceiling (see REMEDIATION_RENAV_CEILING_MS): a hidden tab's post-remediation
    // nav runs at ~1Hz — the default 15s stalled hidden page-2→3 after Tier-0 cleared the errors.
    const res = await cdpWaitNextPage(prevSig, REMEDIATION_RENAV_CEILING_MS);
    if (res.sessionDead) return { sessionDead: true, attempts: attempt, actions };
    if (res.advanced) return { advanced: true, attempts: attempt, actions };

    // ── not advanced → HALT on NO-PROGRESS (error set unchanged); else continue. ──
    // POLL the errors (do NOT single-read): under throttle the banner renders LATER than the wait
    // ceiling — a single read can catch 0 and mislabel a real, still-blocking error as "cleared".
    let newErrors = await readErrors();
    for (let poll = 0; poll < 8 && !newErrors.length; poll++) { await cdpDelay(500); newErrors = await readErrors(); }
    if (errorSetUnchanged(prevErrors, newErrors)) {
      LOG(`  remediation made NO PROGRESS (error set unchanged after the action) — halting.`);
      return { advanced: false, reason: "no-progress", attempts: attempt, actions, errors: newErrors };
    }
    LOG(`  error set changed (${prevErrors.length}→${newErrors.length}) — continuing.`);
    prevErrors = newErrors;
  }
  return { advanced: false, reason: "cap-exhausted", attempts: REMEDIATION_MAX, actions };
}

// ============================================================================
// CDP FILL FULL PAGE (M38 Part 1) — the FOLD: ONE drivePageFill fills the flat
// fields AND every repeating section PRESENT on the page (the fold in fill-driver
// drives each present section via driveRepeatingSectionCdp + PAGE_SECTIONS). Passes
// the PREPARED profile (sections need the annotated arrays). M38 Part 2: builds the
// review-summary bundle from the results + persists it (accumulating write-per-page,
// keyed by the pre-fill cdpPageKey) — "View last summary" in the popup. On page 1 (no
// repeating sections) this fills the flat fields + persists a summary; on page 2 it fills
// the whole page in one click. SINGLE page (no advance) — accumulates, reset via the
// "Clear summary" button. [CDP-PAGE] in the SW console.
// ============================================================================
// AI-0 seam: read the operator's LLM config for act.llm. act.llm enforces the opt-in
// (enabled===false ⇒ no provider call). Only the FILL paths (full-page + walk) thread it in;
// recon/section harnesses build a config-less act (act.llm short-circuits OFF). Returns {} if unset.
async function getLlmConfig() {
  return await new Promise((resolve) => chrome.storage.local.get("llmConfig", (r) => resolve((r && r.llmConfig) || {})));
}

// P3b (website tracker): after a completed page fill, push the review bundle +
// status to the website backend so the operator's Tracker + hosted review summary
// populate. Uses the per-user ingest credential the website synced via AP_SET_SESSION.
// FIRE-AND-FORGET — wrapped so it NEVER throws and NEVER affects the fill; if the
// website isn't connected (no apSession) it's a silent no-op. status is NEVER
// "submitted" (the human submits — the engine only ever fills to review).
async function reportApplication(bundle, jobContext) {
  try {
    if (!bundle) return;
    const { apSession } = await new Promise((res) => chrome.storage.local.get("apSession", res));
    if (!apSession || !apSession.ingestUrl || !apSession.ingestKey) return;
    const needs = bundle.needs_review_count || 0;
    const payload = {
      company: (jobContext && jobContext.company) || bundle.tenant || null,
      role: null,
      url: bundle.url || null,
      status: needs > 0 ? "needs_review" : "filling",
      needs_review_count: needs,
      captured_at: bundle.captured_at || new Date().toISOString(),
      review_bundle: bundle
    };
    const res = await fetch(apSession.ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + apSession.ingestKey },
      body: JSON.stringify(payload)
    });
    console.log("[ApplyPilot] application reported —", res && res.status, `(${payload.status}, ${needs} need review)`);
  } catch (e) {
    console.log("[ApplyPilot] application report skipped:", String((e && e.message) || e));
  }
}

// The website is now the primary REVIEW surface (edit + approve), replacing the extension's
// summary.html. Before a replay/submit, PULL the human-approved bundle the operator saved on
// the site and write it into chrome.storage.local.reviewSummary — so runCdpReplayWalk (which
// reads that slot directly) replays exactly what was approved. Uses the same per-user ingest
// credential the website synced via AP_SET_SESSION; the review pull endpoint is apSession.reviewUrl
// (derived from ingestUrl for older sessions). Matches the application row by the LOCAL bundle's
// url (the key reportApplication upserts by).
//
// CONTRACT: when the website is connected AND returns a bundle, it is the SOURCE OF TRUTH — it
// overwrites the local bundle (the whole point of hosting review on the site). When NOT connected
// (no apSession) or the site has no bundle, this is a silent no-op and the local bundle (from the
// extension's own summary.html fallback) is used unchanged. NEVER throws — a pull failure falls back
// to local so replay is never blocked by the network.
async function pullApprovedBundle(LOG) {
  const log = LOG || ((...a) => console.log("[ApplyPilot][REVIEW-PULL]", ...a));
  try {
    const { apSession, reviewSummary: localBundle } = await new Promise((res) =>
      chrome.storage.local.get(["apSession", "reviewSummary"], res)
    );
    if (!apSession || !apSession.ingestKey) return { pulled: false, reason: "not-connected" };
    const reviewUrl =
      apSession.reviewUrl ||
      (apSession.ingestUrl ? apSession.ingestUrl.replace(/\/report(\?.*)?$/, "/review") : "");
    if (!reviewUrl) return { pulled: false, reason: "no-review-url" };
    const url = localBundle && localBundle.url ? localBundle.url : "";
    const endpoint = reviewUrl + (url ? "?url=" + encodeURIComponent(url) : "");
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: "Bearer " + apSession.ingestKey },
    });
    if (!res.ok) {
      log(`review pull: HTTP ${res.status} — keeping the local bundle.`);
      return { pulled: false, reason: "http-" + res.status };
    }
    const data = await res.json().catch(() => null);
    const bundle = data && data.ok ? data.bundle : null;
    if (!bundle || !Array.isArray(bundle.entries) || !bundle.entries.length) {
      log(`review pull: no approved bundle on the website — keeping the local bundle.`);
      return { pulled: false, reason: "no-remote-bundle" };
    }
    await new Promise((r) => chrome.storage.local.set({ reviewSummary: bundle }, r));
    const ap = bundle.approval || {};
    log(
      `review pull: loaded the website-approved bundle (${bundle.entries.length} fields` +
        (ap.to_approve_count != null ? `, ${ap.approved_count || 0}/${ap.to_approve_count} flagged approved` : "") +
        `) into storage — replay will use these values.`
    );
    return { pulled: true, count: bundle.entries.length, submit_ready: !!ap.submit_ready };
  } catch (e) {
    log(`review pull skipped: ${String((e && e.message) || e)} — keeping the local bundle.`);
    return { pulled: false, reason: "exception" };
  }
}

async function runCdpFillPage(tabId, profile, defaults, jobContext) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-PAGE]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    await cdpInstallPageOverrides(); // hidden-tab SPA-transition unblock (rAF→setTimeout): so a hidden single-page fill behaves like the walk
    // Foreground fast-fill: NO hidden-gate. The fill runs whether the tab is VISIBLE
    // (fast — act.delay scales down; watch it) or HIDDEN (slow/background — full delays,
    // throttle-immune), adapting LIVE as the operator minimizes/restores.
    LOG(`attached. Filling NOW (input-lock ON) — keep the tab VISIBLE for a fast fill (watch it) or MINIMIZE for slow/background; it adapts live. Full-page (flat + every repeating section present).`);

    const prepared = prepareProfile(profile); // sections need the annotated arrays (fromParsed/bulletsText/meaningful)
    const act = makeCdpActuation(await getLlmConfig()); // AI-0 seam: act.llm bound to the operator's config (OFF unless the toggle is on)
    const { out, bundle, auditFlags } = await fillAndPersistPage(act, prepared, defaults, jobContext, LOG);
    await reportApplication(bundle, jobContext); // fire-and-forget → website Tracker (no-op if not connected)
    return { ok: true, counts: out.counts, needs_review: out.needsReview.length, session_warning: out.sessionWarning || null, summary_total: bundle.total, audit_flagged: auditFlags.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("full-page fill aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await removeInputLock(); // BEFORE detach (needs the attach) — stuck-lock is the worst operator failure
    await cdpDetach();
  }
}

// ── M3 (strict-replay SUBMIT — dry harness) ─────────────────────────────────
// Replay the SAVED, human-approved reviewSummary bundle onto the CURRENT live page — FLAT fields
// (replayFlatFields) + repeating sections (replayRepeatingSections, strict: no AI, never drop an
// approved entry). NO Next, NO Submit (dry). Reads the bundle from storage, NOT the profile — that's
// the point of replay. Load the same page you filled (fresh) + keep it VISIBLE to watch the approved
// values land; a value the form no longer offers HALTS that field (needs_review), never guesses.
// [CDP-REPLAY] in the SW console.
async function runCdpReplayPage(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-REPLAY]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    const bundle = await new Promise((resolve) => chrome.storage.local.get("reviewSummary", (r) => resolve(r && r.reviewSummary)));
    if (!bundle || !Array.isArray(bundle.entries) || !bundle.entries.length) {
      LOG('no reviewSummary bundle in storage — fill a page first (this dry-replays the saved approved values). "View last summary" to confirm one exists.');
      return { ok: false, error: "no-bundle" };
    }
    await cdpInstallPageOverrides();
    LOG("DRY REPLAY — replaying the SAVED approved bundle onto THIS live page (flat + repeating). NO Next, NO Submit. Keep the tab VISIBLE; a value the form no longer offers HALTS that field (needs_review), never guesses.");
    const act = makeCdpActuation(await getLlmConfig());
    await installInputLock();
    const scan = await cdpEval(cdpPageScan);
    const present = new Set(((scan && scan.fields) || []).map((f) => f.fieldName));
    const flat = await replayFlatFields(act, bundle.entries, present, DEFAULT_BUDGETS);
    const rep = await replayRepeatingSections(act, bundle.entries, DEFAULT_BUDGETS);
    const results = flat.concat(rep);
    const nr = results.filter((r) => r.status === "needs_review" || r.status === "error");
    LOG(`replayed ${flat.length} flat + ${rep.length} repeating record(s); ${nr.length} need review/failed.`);
    if (nr.length) { LOG("NEEDS REVIEW / FAILED:"); nr.forEach((r) => LOG(`    • ${r.field || r.fieldName} [${r.widgetType}] ${r.status} — ${r.detail || ""}`)); }
    try { console.table(results.map((r) => ({ field: r.field || r.fieldName, type: r.widgetType, status: r.status, after: r.after, verified: r.verified }))); } catch (e) { results.forEach((r) => LOG(JSON.stringify(r))); }
    LOG("dry replay complete — NOTHING submitted, no page advance. (Unknown/generic sections + attachments are deferred.)");
    return { ok: true, flat: flat.length, repeating: rep.length, needs_review: nr.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("replay aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await removeInputLock(); // BEFORE detach
    await cdpDetach();
  }
}

// Re-attach the stored résumé on the CURRENT page (replay path — replayField defers file_upload to
// this SW step). Mirrors fillAndPersistPage's attach block: read the bytes from IndexedDB, bump
// window.__apActing so the input-lock passes attachResume's SYNTHETIC delete/attach clicks, run the
// proven attachResume via cdpEval on the SAME debugger attach, gate on file-upload-successful.
async function replayAttachResume(LOG) {
  let resumeRec = null;
  try { resumeRec = await getResume(); } catch (e) { /* treat as none */ }
  if (!resumeRec || !resumeRec.base64) {
    LOG("resume: NOT attached — no resume stored (upload one in the popup).");
    return { attached: false, detail: "no resume stored — upload a PDF in the popup first" };
  }
  let ar = null, arErr = null;
  try { await cdpEval(() => { window.__apActing = (window.__apActing || 0) + 1; }); } catch (e) { /* no lock/page — ignore */ }
  try { ar = await cdpEval(attachResume, resumeRec.base64, resumeRec.filename || "resume.pdf", resumeRec.mime || "application/pdf"); }
  catch (e) { arErr = String((e && e.message) || e); }
  finally { try { await cdpEval(() => { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }); } catch (e) { /* ignore */ } }
  if (ar && ar.attached) {
    LOG(`resume: attached "${ar.fileName || resumeRec.filename}".`);
    return { attached: true, detail: `attached (cleared ${ar.deletedCount || 0} existing)`, fileName: ar.fileName || resumeRec.filename };
  }
  const detail = "resume attach failed — " + (arErr || (ar && ar.detail) || "no confirmation");
  LOG("resume: NOT attached — " + detail);
  return { attached: false, detail };
}

// ── M3: runCdpReplayWalk — the DRY replay WALK (replay → advance → review; NEVER submits) ───────────
// Replays the SAVED, human-approved reviewSummary bundle page-by-page onto a FRESH application, verifies
// each field, advances with the SAME guarded clickPageNext the fill walk uses (refuses on the review
// page), and STOPS at review. NO clickSubmit exists yet (that's M4) — this is the safe dry run. Strict:
// a value the live form no longer offers HALTS (replay-mismatch); a required field left empty stalls
// advancement and HALTS (replay-blocked — possibly a cascade-revealed field the bundle doesn't cover);
// NO AI, NO AI-4 remediation (fill-path only). Reads the bundle from storage, NOT the profile. Keep the
// tab VISIBLE (eyes-on) for the first walks. [CDP-REPLAY-WALK] in the SW console.
const REPLAY_MAX_PAGES = 8; // mirror WALK_MAX_PAGES — the review/session checks are the real stops; this only backstops a detection-bug loop.
const MAX_RELOAD_RETRIES = 2; // reload-retry cap per RUN (a reload returns Workday to page 1, so a transient render-flake RESTARTS the whole walk) — ≤2 restarts, then halts honestly.

// Reload the attached tab (Page.reload) and wait for it to be INTERACTIVE again — the transient-failure
// retry for both walks (operator ask 2026-07-11). Polls document.readyState==="complete" + a live form
// (or the review marker), bounded; wakes a throttled hidden tab each tick. Returns true when ready. The
// caller re-installs the input-lock + re-runs the page (the reload tore the injected overlay down).
async function reloadAndSettle(LOG, ceilingMs = 12000) {
  try { await cdpReload(); } catch (e) { LOG && LOG("reload failed: " + String((e && e.message) || e)); return false; }
  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    await cdpDelay(500);
    try { await cdpWakePage(); } catch (e) { /* ignore */ }
    let ready = null; try { ready = await cdpEval(() => document.readyState); } catch (e) { continue; } // mid-nav read → keep polling
    if (ready !== "complete") continue;
    let nav = null; try { nav = await cdpEval(cdpReadSessionState); } catch (e) { continue; }
    if (nav && (((nav.formFieldCount || 0) > 0) || nav.applyFlowReviewPresent)) return true; // form/review back → ready
  }
  return false;
}

async function runCdpReplayWalk(tabId, opts) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-REPLAY-WALK]", ...a);
  const refill = !!(opts && opts.refill); // REFILL mode: pages IN the approved bundle REPLAY (skip-if-correct, no re-recon); pages the first fill NEVER reached get a FRESH fill; walk continues to review. Always DRY (never submits).
  const authorize = !!(opts && opts.authorize) && !refill; // per-run submit token (M4). false ⇒ DRY (reach review + stop). REFILL is always DRY (never submits) regardless of the caller.
  const simulateSubmit = !!(opts && opts.simulateSubmit); // M5 SAFETY BRAKE: run the FULL gate + log "WOULD CLICK SUBMIT", but NEVER actually click (operator not ready for a real submit). Flip via the handler's simulateSubmit:false.
  // Walk-status + reporting locals — meaningful in refill mode (fresh fills change the bundle → push it to the website review page). The plain DRY replay walk touches none of these (freshFilledDidHappen stays false ⇒ no report).
  let jobContext = null, prepared = null, defaults = {};
  let freshFilledDidHappen = false, reachedReview = false, walkPage = 0, lastDiag = null;
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    // PULL the website-approved bundle first (the website is the review surface now). No-op +
    // fall back to the local bundle when not connected / the site has none — see pullApprovedBundle.
    await pullApprovedBundle(LOG);
    let bundle = await new Promise((resolve) => chrome.storage.local.get("reviewSummary", (r) => resolve(r && r.reviewSummary)));
    if (!bundle || !Array.isArray(bundle.entries) || !bundle.entries.length) {
      LOG('no reviewSummary bundle in storage — fill + review an application first, then replay it.');
      return { ok: false, error: "no-bundle" };
    }
    // REFILL: load the profile so a page the first fill never reached can be FRESH-filled (recon + fill).
    // Reviewed pages still REPLAY from the bundle — the profile is only for never-filled pages.
    if (refill) {
      const store = await new Promise((r) => chrome.storage.local.get(["profile", "defaults", "jobContext"], r));
      defaults = store.defaults || {};
      jobContext = store.jobContext || {};
      prepared = store.profile ? prepareProfile(store.profile) : null;
      if (prepared) LOG("REFILL mode: bundled pages REPLAY (skip-if-correct, no re-recon); pages the first fill never reached get a FRESH fill; continues to the REVIEW page. NEVER submits.");
      else LOG("⚠ REFILL: no profile in storage — a page not in the bundle can't be fresh-filled and will HALT. Click 'Load default profile' first to enable fresh-fill of never-reached pages.");
    }
    await cdpInstallPageOverrides(); // hidden-tab SPA-transition unblock (same as the fill walk)
    LOG(authorize
      ? `⚠ ARMED REPLAY WALK (authorize=true) — replaying the ${bundle.entries.length} approved field(s) page-by-page; at the REVIEW page it runs the precondition gate and, if EVERY check passes, clicks SUBMIT ONCE. Eyes-on, DISPOSABLE application. Keep the tab VISIBLE.`
      : `DRY REPLAY WALK — replaying the ${bundle.entries.length} approved field(s) page-by-page to the REVIEW page. NEVER submits (not authorized). Keep the tab VISIBLE to watch. A value the form no longer offers, or a required field left empty, HALTS — never a guess.`);
    const act = makeCdpActuation(await getLlmConfig()); // AI OFF for replay regardless (replayRepeatingSections passes aiContext:null; flat replayField never calls AI)
    let pagesReplayed = [];
    let findings = { mismatches: [], cascadeRevealed: [] }; // fed to the submit gate; the walk HALTS on any mismatch/cascade before review, so these stay empty on a clean run (the gate re-checks defensively)
    let submitFired = false; // single-fire sentinel
    let reloadsUsed = 0; // RUN-level reload-retry budget: a reload returns Workday to page 1, so a transient render-flake RESTARTS the whole walk (bounded by MAX_RELOAD_RETRIES)

    restartWalk: while (true) { // a transient-flake reload restarts here from page 1; a clean finish / halt / review-terminal returns out of the function
    pagesReplayed = []; findings = { mismatches: [], cascadeRevealed: [] }; submitFired = false; // reset per attempt
    let prevPageIdentity = null; // flat-fields+sections identity of the page just replayed — to catch a false "advanced" (see the same-page guard)
    for (let page = 1; page <= REPLAY_MAX_PAGES; page++) {
      walkPage = page;
      // ── TOP-OF-ITERATION guards (SUBMIT-NEVER: review terminal checked BEFORE any replay/click). ──
      let nav = null;
      try { nav = await cdpEval(cdpReadSessionState); } catch (e) { /* not-ready → handled below */ }
      if (nav && isWorkdayMaintenance(nav)) {
        LOG(`⛔ WORKDAY MAINTENANCE at page ${page} — retry after the window.`);
        return { ok: true, stopped: "workday-maintenance", workday_maintenance: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
      }
      if (nav && sessionLooksDead(nav)) {
        LOG(`⚠⚠ SESSION EXPIRED at page ${page} — refresh, log in, reopen the form, retry.`);
        return { ok: true, stopped: "session-expired", session_expired: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
      }
      if (nav && nav.applyFlowReviewPresent) {
        reachedReview = true;
        LOG(`✓✓ reached the REVIEW page after replaying ${pagesReplayed.length} page(s) — the whole application is replayed + verified.`);
        // ── REVIEW-PAGE EQUALITY (operator requirement) — the review page must DISPLAY exactly the
        //    approved values. Scrape its label→value pairs and diff vs the approved bundle
        //    (reconcileReviewPage — the SAME read-only check as the "review-page CHECK" button). A
        //    DISAGREE (page shows a different value), a MISSING (approved value not shown), or a scrape
        //    FAILURE (can't confirm) each becomes a HARD gate blocker. extra-on-page is logged, not
        //    blocked (review boilerplate is noisy). Runs even DRY — the operator sees the diff preview. ──
        const reviewDiff = { disagree: [], missing: [], scrapeFailed: false };
        try {
          const hints = bundle.entries
            .filter((e) => e && e.current_value != null && String(e.current_value).trim() !== "" && !isAiPlaceholder(e.current_value))
            .map((e) => ({ label: e.question_label || null, value: String(e.current_value), widget: e.widget_type || null }));
          const dump = await cdpEval(cdpReadReviewPage, hints);
          if (dump && dump.ok && Array.isArray(dump.items)) {
            const rec = reconcileReviewPage(dump.items, bundle.entries, { accountEmails: await getAccountEmails() });
            const c = rec.counts;
            reviewDiff.disagree = rec.disagree || [];
            reviewDiff.missing = rec.missing_on_review || [];
            LOG(`review page vs approved: AGREE ${c.agree} · DISAGREE ${c.disagree} · MISSING ${c.missing_on_review} · EXTRA ${c.extra_on_review} · AMBIGUOUS ${c.ambiguous} (of ${c.claimed} value-bearing entries).`);
            rec.disagree.forEach((d) => LOG(`    ≠ "${d.label || d.canonical_field || d.field_id}": approved "${d.value_bundle}" but the page shows "${d.value_review}"`));
            rec.missing_on_review.forEach((m) => LOG(`    ∅ approved "${m.value_bundle}" ("${m.label || m.canonical_field || m.field_id}") is NOT shown on the review page`));
            if ((rec.extra_on_review || []).length) { LOG(`    (${rec.extra_on_review.length} extra value(s) on the page not in the bundle — logged, NOT blocking:)`); rec.extra_on_review.slice(0, 6).forEach((x) => LOG(`      + "${x.value_review}" (${x.label || "?"})`)); }
          } else {
            LOG(`⚠ could NOT scrape the review page (${(dump && dump.reason) || "no items"}) — cannot confirm it matches the approved values → the gate will block.`);
            reviewDiff.scrapeFailed = true;
          }
        } catch (e) {
          LOG(`⚠ review-page diff failed: ${String((e && e.message) || e)} → the gate will block.`);
          reviewDiff.scrapeFailed = true;
        }

        // ── M4 SUBMIT GATE — the ordered precondition check. Run it ALWAYS (even DRY) so the operator
        //    sees a blocker list; clickSubmit fires ONLY when authorize===true AND every check passes. ──
        let livePlaceholder = false;
        try { livePlaceholder = await cdpEval(() => ((document.body && document.body.innerText) || "").indexOf("[NEEDS YOUR ANSWER") !== -1); } catch (e) { /* ignore — bundle check still applies */ }
        const gate = submitPrecondition(bundle, nav, {
          mismatches: findings.mismatches, cascadeRevealed: findings.cascadeRevealed, livePlaceholder,
          reviewDisagree: reviewDiff.disagree, reviewMissing: reviewDiff.missing, reviewScrapeFailed: reviewDiff.scrapeFailed
        }, { authorize, alreadyFired: submitFired });
        if (!gate.ok) {
          LOG(`submit gate: ${gate.blockers.length} blocker(s) — NOT submitting:`);
          gate.blockers.forEach((b) => LOG(`    ✗ ${b}`));
          if (!authorize) LOG(`(DRY run — reached review + stopped. When every blocker above is cleared, the armed Submit button will submit once.)`);
          return { ok: true, stopped: authorize ? "submit-blocked" : "reached-review", reached_review: true, submit_blocked: authorize || undefined, blockers: gate.blockers, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
        }
        // GATE PASSED + authorized. ── M5 SAFETY BRAKE ── While simulateSubmit is on, LOG what WOULD
        // happen and DO NOT click — no run submits yet (operator's explicit choice). act.clickSubmit is
        // never called in this mode. Flip to a real submit later by launching with simulateSubmit:false
        // (the RUN_CDP_SUBMIT handler sets the flag — a one-line change).
        if (simulateSubmit) {
          submitFired = true; // single-fire (mirrors the real path)
          LOG(`✅✅✅ SUBMIT GATE PASSED — ▶▶ WOULD CLICK SUBMIT NOW ◀◀ (SIMULATE MODE: NOT clicking). Every precondition is satisfied, so an armed run (simulateSubmit:false) would submit the application here.`);
          return { ok: true, stopped: "would-submit", would_submit: true, simulated: true, reached_review: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
        }
        // (real path — not reached while simulateSubmit is on) → the ONE irreversible click.
        LOG(`✓ submit gate PASSED — clicking SUBMIT ONCE (authorized).`);
        const subSig = cdpPageSig(await cdpEval(cdpPageScan));
        const sub = await act.clickSubmit(true);
        submitFired = true; // single-fire — never attempt a second submit this run
        LOG(`clickSubmit:`, JSON.stringify(sub));
        if (!sub.clicked) {
          LOG(`⚠ clickSubmit refused (${sub.refused}${sub.blockedBy ? " — covered by " + sub.blockedBy : ""}) — NOT submitted. Eyeball the review page.`);
          return { ok: true, stopped: "submit-refused:" + (sub.refused || "?"), reached_review: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
        }
        const res = await cdpWaitNextPage(subSig);
        const confirmed = !!(res.advanced && !res.sessionDead && !res.maintenance);
        LOG(confirmed ? `✓✓✓ SUBMITTED — the review page advanced (confirmation). Application submitted.` : `clickSubmit fired but no confirmed advance yet (${JSON.stringify(res)}) — VERIFY on the page.`);
        return { ok: true, stopped: "submitted", submitted: true, confirmed, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
      }

      LOG(`──── REPLAY PAGE ${page} ────${reloadsUsed ? ` (walk restart ${reloadsUsed})` : ""}`);
      await installInputLock(); // per page — navigation tears down the injected overlay; removed once in finally
      const scan = await cdpEval(cdpPageScan);
      const fields = (scan && scan.fields) || [];
      const liveNames = fields.map((f) => f.fieldName);
      // A repeating page (My Experience) has NO flat fields — match it by its live SECTIONS too.
      let rscanLive = null;
      try { rscanLive = await act.repeatingScan(); } catch (e) { /* no repeating substrate → flat-only match */ }
      // ── SAME-PAGE GUARD (backstop for a premature "advanced"): if the live page is IDENTICAL to the
      //    one just replayed — same flat field-set AND same repeating sections — then the prior Save &
      //    Continue did NOT actually move the form (a slow/blocked transition read as advanced). NEVER
      //    re-replay the same page; HALT honestly. Skips a wholly-empty (loading) scan. ──
      const liveSecKey = rscanLive && rscanLive.sections ? Object.keys(rscanLive.sections).sort().join(",") : "";
      const pageIdentity = liveNames.slice().sort().join(",") + "||" + liveSecKey;
      if (prevPageIdentity !== null && (liveNames.length || liveSecKey) && pageIdentity === prevPageIdentity) {
        LOG(`⚠ page ${page}: the form did NOT advance — the live page is IDENTICAL to the step just replayed (Save & Continue was blocked, or the transition didn't settle). HALT — never re-replaying the same page. Eyeball the form; a re-run usually clears a transient race.`);
        return { ok: true, stopped: "did-not-advance", page, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
      }
      prevPageIdentity = pageIdentity;
      const sel = selectPageBundleEntries(bundle.entries, liveNames, rscanLive);
      if (!sel.entries.length || sel.score <= 0) {
        const liveSecs = (rscanLive && rscanLive.sections) ? Object.keys(rscanLive.sections) : [];
        // ── NOT in the approved bundle. In a plain replay/submit walk this is a HARD HALT (can't
        //    replay what wasn't reviewed). In REFILL mode it means the first fill NEVER REACHED this
        //    page (a mid-walk halt) — so FRESH-FILL it (recon + fill + accumulate) and keep walking to
        //    review. Reviewed pages above are untouched; only never-filled pages get a fresh fill. ──
        if (!refill || !prepared) {
          LOG(`⚠ page ${page}: NO matching page in the approved bundle (live flat fields: ${liveNames.slice(0, 8).join(", ") || "none"}; repeating: ${liveSecs.join(", ") || "none"}). ${refill ? "REFILL but no profile in storage — can't fresh-fill." : "The bundle never captured this page"} — HALT.`);
          return { ok: true, stopped: "replay-page-not-in-bundle", page, live_fields: liveNames, live_sections: liveSecs, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
        }
        LOG(`page ${page}: not in the approved bundle — REFILL: fresh-filling this never-reached page (recon + fill + accumulate) + continuing to review.`);
        const { out } = await fillAndPersistPage(act, prepared, defaults, jobContext, LOG, { pageNumber: page });
        // Re-read the ACCUMULATED bundle so later pages' selectPageBundleEntries + the review-page diff include this page.
        bundle = (await new Promise((resolve) => chrome.storage.local.get("reviewSummary", (r) => resolve(r && r.reviewSummary)))) || bundle;
        freshFilledDidHappen = true;
        // Transient-flake reload parity with the fill walk: all-flake failures → reload (→ page 1) + restart.
        const flakes = (out.results || []).filter((r) => r.status === "needs_review" || r.status === "error");
        if (flakes.length && isTransientRenderFailure(flakes) && reloadsUsed < MAX_RELOAD_RETRIES) {
          reloadsUsed++;
          LOG(`⟳ page ${page}: fresh-fill failure(s) are all TRANSIENT render-flakes — reloading (→ page 1) + RESTARTING the walk (reload ${reloadsUsed}/${MAX_RELOAD_RETRIES}): ${flakes.map((r) => r.fieldName).join(", ")}`);
          const ready = await reloadAndSettle(LOG);
          if (ready) continue restartWalk;
          LOG(`⚠ page ${page}: reload did not settle — proceeding with the last fresh fill.`);
        }
        pagesReplayed.push({ page, matched_key: "(fresh-filled)", fresh: true, total: out.results.length, changed: out.results.filter((r) => r.status === "filled" || r.status === "filled_review").length, kept: 0, failed: out.needsReview.length });
        LOG(`page ${page} fresh-fill: ${out.results.length} field(s) — ${out.needsReview.length} need review (they go to the review page).`);
        // Required-upload guard (a missing/failed résumé blocks advancement) — the fresh fill attaches it inline.
        const upRec = out.results.find((r) => r.widgetType === "file_upload");
        if (upRec && upRec.status !== "filled") {
          LOG(`⚠ resume NOT attached on page ${page} (${upRec.detail}) — the required upload blocks advancement. HALT. Upload a resume in the popup, then re-run.`);
          return { ok: true, stopped: "resume-not-attached", resume_detail: upRec.detail, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
        }
        // Fall through to the SHARED guarded advance below (skip the replay-specific verify block).
      } else {
        LOG(`page ${page} → matched approved page "${(sel.pageKey || "").split("|")[0]}" (${sel.score} flat-field overlap; ${sel.entries.length} approved entr${sel.entries.length === 1 ? "y" : "ies"}).`);

        const present = new Set(liveNames);
        const flat = await replayFlatFields(act, sel.entries, present, DEFAULT_BUDGETS);
        const rep = await replayRepeatingSections(act, sel.entries, DEFAULT_BUDGETS);
        const results = flat.concat(rep);

        // Résumé re-attach (replayField defers file_upload). Required upload blocks advance → HALT if it fails.
        if (fields.some((f) => f.widgetType === "file_upload")) {
          const ar = await replayAttachResume(LOG);
          if (!ar.attached) {
            LOG(`⚠ resume NOT attached on page ${page} (${ar.detail}) — the required upload blocks advancement. HALT. Upload a resume in the popup, then re-run.`);
            return { ok: true, stopped: "resume-not-attached", resume_detail: ar.detail, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
          }
        }

        const failed = results.filter((r) => r.status === "needs_review" || r.status === "error");
        const changed = results.filter((r) => (r.status === "filled" || r.status === "filled_review") && r.flag !== "replay-already-correct").length;
        const kept = results.filter((r) => r.flag === "replay-already-correct").length;
        pagesReplayed.push({ page, matched_key: sel.pageKey, total: results.length, changed, kept, failed: failed.length });
        LOG(`page ${page} replay: ${results.length} field(s) — ${changed} changed, ${kept} already-correct, ${failed.length} FAILED.`);

        // ── STRICT verify: any field that did NOT replay cleanly HALTS before advancing (never a guess) —
        //    UNLESS every failure is a TRANSIENT render-flake (options-did-not-render). Then RELOAD (which
        //    returns Workday to page 1) + RESTART the whole walk from page 1, bounded. skip-if-correct makes
        //    the already-good pages fast on the restart. A TERMINAL failure (genuine no-match) never retries. ──
        if (failed.length) {
          if (isTransientRenderFailure(failed) && reloadsUsed < MAX_RELOAD_RETRIES) {
            reloadsUsed++;
            LOG(`⟳ page ${page}: ${failed.length} field(s) failed with a TRANSIENT render-flake — reloading (Workday returns to page 1) + RESTARTING the walk from page 1 (reload ${reloadsUsed}/${MAX_RELOAD_RETRIES}): ${failed.map((r) => r.field || r.fieldName).join(", ")}`);
            const ready = await reloadAndSettle(LOG);
            if (ready) continue restartWalk; // re-run the whole walk from page 1
            LOG(`⚠ page ${page}: reload did not settle in time — halting.`);
          }
          LOG(`⚠ page ${page}: ${failed.length} field(s) did not replay cleanly${reloadsUsed ? ` (persisted through ${reloadsUsed} reload-restart)` : ""} — HALT before advancing (a value the live form no longer offers is never guessed):`);
          failed.forEach((r) => LOG(`    • ${r.field || r.fieldName} [${r.widgetType}] ${r.status} — ${r.detail || ""}`));
          return { ok: true, stopped: "replay-mismatch", page, failed: failed.map((r) => ({ field: r.field || r.fieldName, widget: r.widgetType, status: r.status, detail: r.detail || null })), pages_replayed: pagesReplayed.length, pages: pagesReplayed };
        }
      }

      // ── Guarded advance (clickPageNext independently refuses on the review marker — 2nd guard). ──
      const navAfter = await cdpEval(cdpReadSessionState);
      if (!navAfter || !navAfter.nextButtonPresent) {
        LOG(`no Save & Continue on page ${page} — terminal page (not the review marker). Stop.`);
        return { ok: true, stopped: "no-next-button", pages_replayed: pagesReplayed.length, pages: pagesReplayed };
      }
      // Snapshot the transition signature AFTER the replay/refill (they mutate this page's field set —
      // preferred name, Country cascade), so cdpWaitNextPage detects only a REAL Save & Continue and not
      // the fill's own DOM changes (a pre-replay sig would FALSELY read "advanced" on a blocked page).
      const prevSig = cdpPageSig(await cdpEval(cdpPageScan));
      await cdpWakePage(); // wake a frozen hidden tab so the transition can run
      const click = await act.clickPageNext();
      LOG(`page ${page} Save & Continue:`, JSON.stringify(click));
      if (!click.clicked) {
        LOG(`advance refused on page ${page} (${click.refused}) — stop.`);
        return { ok: true, stopped: "click-refused:" + (click.refused || "?"), pages_replayed: pagesReplayed.length, pages: pagesReplayed };
      }

      // ── Wait for the transition OR session-death OR a nav-timeout (required field empty → HALT). ──
      const res = await cdpWaitNextPage(prevSig);
      if (res.maintenance) { LOG(`⛔ WORKDAY MAINTENANCE after Save & Continue on page ${page}.`); return { ok: true, stopped: "workday-maintenance", workday_maintenance: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
      if (res.sessionDead) { LOG(`⚠⚠ SESSION EXPIRED after Save & Continue on page ${page} — refresh, log in, reopen, retry.`); return { ok: true, stopped: "session-expired", session_expired: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
      if (res.timeout) {
        // CLEAN no-advance fallback first (operator ask): a swallowed Save & Continue re-clicks (up to 2x).
        // Self-guards on error/session-death, so a real validation block still HALTS (never masked).
        const reclick = await reclickNextWhenClean(act, prevSig, 2, LOG);
        if (reclick.sessionDead) { LOG(`⚠⚠ SESSION EXPIRED during the re-click fallback on page ${page}.`); return { ok: true, stopped: "session-expired", session_expired: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
        if (reclick.advanced) { LOG(`✓ page ${page} → advanced after re-clicking Save & Continue (${reclick.attempts || "?"}x — the first click was swallowed).`); continue; }
        // DRY replay does NOT run AI-4 remediation (fill-path only). Still stuck: a nav-timeout means a
        // required field is empty — most likely a CASCADE-REVEALED field the approved bundle never
        // captured → HALT for re-review (re-open the summary, approve the revealed field, re-run).
        let diag = {};
        try {
          const st = await cdpEval(cdpReadSessionState);
          const samples = expandErrorSamples((st && st.errorMarkers && st.errorMarkers.samples) || []);
          if (samples.length) { LOG(`page errors (${samples.length}):`); samples.forEach((s) => LOG("    • " + s)); }
          diag = { page_errors: samples, error_page_text: st ? (st.errorPageText || null) : null };
          lastDiag = diag; // refill stamps this onto walk_status → the website review page shows WHY it stopped
        } catch (e) { /* ignore */ }
        LOG(`⚠ page ${page} did NOT advance (nav-timeout${reclick.errorsPresent ? ", real error present" : ", re-click fallback exhausted"}) — a required field is empty (likely a cascade-revealed field not in the approved bundle). HALT — eyeball the page, re-review/approve, then re-run. (No blind AI remediation on replay.)`);
        return { ok: true, stopped: "replay-blocked", nav_timeout_page: page, pages_replayed: pagesReplayed.length, pages: pagesReplayed, ...diag };
      }
      LOG(`✓ page ${page} → advanced.`);
    }
    break restartWalk; // the for-loop completed all pages without a transient-flake restart → exit the retry loop
    } // restartWalk

    LOG(`⚠ hit the ${REPLAY_MAX_PAGES}-page cap without reaching review — stopping (detection-bug backstop). Eyeball the application.`);
    return { ok: true, stopped: "max-pages-cap", pages_replayed: pagesReplayed.length, pages: pagesReplayed };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("replay walk aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await removeInputLock(); // BEFORE detach — never strand the operator behind the lock
    await cdpDetach();
    // REFILL only: fresh-filling a never-reached page CHANGED the accumulated bundle, so push it to the
    // website review page (same as the fill walk's finally) — STAMPED with a walk_status so the site can
    // say WHY the refill stopped (completed / halted-on-error) + surface the exact page errors. The plain
    // replay/submit walk never sets freshFilledDidHappen ⇒ no report here (it only replays what was reviewed).
    if (freshFilledDidHappen) {
      try {
        const store = await new Promise((r) => chrome.storage.local.get(["reviewSummary", "lastRunAbort"], r));
        const reviewSummary = store.reviewSummary;
        if (reviewSummary) {
          reviewSummary.walk_status = {
            completed: reachedReview,
            stopped_page: walkPage || null,
            page_errors: (lastDiag && lastDiag.page_errors) || [],
            error_text: (lastDiag && lastDiag.error_page_text) || null,
            empty_fields: (lastDiag && lastDiag.empty_fields) || [],
            cancelled: !!(store.lastRunAbort && store.lastRunAbort.reason === "operator-cancelled"),
          };
          await new Promise((r) => chrome.storage.local.set({ reviewSummary }, r));
          await reportApplication(reviewSummary, jobContext);
        }
      } catch (e) { /* reporting NEVER affects the refill result */ }
    }
  }
}

// ============================================================================
// PAGE-IDENTITY RECON (read-only) — fingerprint an UNKNOWN page state so future code can DETECT it
// (e.g. a Workday planned-maintenance page, a dead/expired session, a login redirect, an error page)
// instead of bubbling an opaque "unknown error". Works on ANY page (no form fields needed): attaches,
// evals cdpPageIdentityDump (title / URL / nav status / headings / body-text sample / the distinct
// data-automation-id set / metas + boolean state markers), logs the full dump, detaches. NO actuation.
// ============================================================================
async function runCdpPageRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-PAGE-RECON]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second debugger client.)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    const dump = await cdpEval(cdpPageIdentityDump);
    if (!dump) { LOG("no dump (eval returned null)"); return { ok: false, error: "no-dump" }; }
    LOG("════ PAGE IDENTITY (read-only) ════");
    LOG("url:", dump.url, "| host:", dump.host);
    LOG("title:", JSON.stringify(dump.title), "| readyState:", dump.readyState, "| httpStatus(nav):", dump.httpStatusFromNav);
    LOG("formFields:", dump.formFieldCount, "| passwordField:", dump.hasPasswordField, "| distinct automation-ids:", dump.automationIdCount);
    LOG("MARKERS:", JSON.stringify(dump.markers));
    LOG("headings:", JSON.stringify(dump.headings));
    LOG("automation-ids:", JSON.stringify(dump.automationIds));
    LOG("metas:", JSON.stringify(dump.metas));
    LOG("bodyClass:", dump.bodyClass);
    LOG("── body text sample (≤2000 chars) ──");
    LOG(dump.bodyTextSample);
    LOG("════ END ════ (nothing actuated; paste this whole block to record the page)");
    return { ok: true, dump };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("page recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP WALK (M38 Part 3) — the N-PAGE LOOP. Generalizes the M31 ONE-transition walk:
// for each page, fold-fill + audit + accumulate (fillAndPersistPage) → GUARDED Save &
// Continue → wait for the transition (or session-death) → repeat, until the REVIEW
// page (STOP — never submit), a terminal page, session death, a nav-timeout, or the
// MAX_PAGES cap. The CDP attach SURVIVES navigation — no re-injection; we re-read via
// cdpEval on the same attach (Page is now enabled only for the hidden-tab rAF override
// installer — cdpInstallPageOverrides — which does not affect nav survival). Detaches in
// finally. SUBMIT-NEVER (double guard, reused verbatim from M31): the review terminal
// is checked at the TOP of each iteration BEFORE any fill/click, AND clickPageNext
// refuses on the review marker. Review-page reached = SUCCESS (walked the whole app).
// ============================================================================

// Page signature for transition detection: URL PATHNAME (query stripped) + the sorted formField name
// set. The field-set delta is the load-bearing signal (pageId alone is shared across pages on some
// tenants; dom-patterns). The query is dropped for the SAME reason cdpPageKey drops it — a session /
// tracking token in the query (Magna carries ?utm_source=…&ref=…) mutating mid-transition would flip
// the sig and be read as a FALSE advance while the same page is still mounted. Pathname + field-set
// means only a REAL page change (different questions) registers as an advance.
function cdpPageSig(scan) {
  if (!scan || !scan.fields) return null;
  let path = scan.url || "";
  try { path = new URL(scan.url).pathname; } catch (e) { /* non-URL → keep raw (still stable) */ }
  return path + "|" + scan.fields.map((f) => f.fieldName).sort().join(",");
}

// A CLEAN no-advance fallback (operator ask, 2026-07-10, Magna page 1): Save & Continue registered
// (clicked:true) but the page neither advanced nor showed a validation error — a SWALLOWED / no-op click
// (a Workday debounce/timing miss). Re-click Save & Continue up to `tries` more times, re-waiting each
// time. SAFETY: it re-clicks ONLY when the page is CLEAN — no error markers, not session-dead, not
// already at review — so a real validation error is NEVER masked by a blind re-click (a real block
// halts, as before). Used by BOTH walks after their normal timeout handling, before the give-up halt.
async function reclickNextWhenClean(act, prevSig, tries, LOG) {
  for (let i = 1; i <= tries; i++) {
    let st = null;
    try { st = await cdpEval(cdpReadSessionState); } catch (e) { /* not-ready → treat as no-error, try the click */ }
    if (st && st.applyFlowReviewPresent) return { advanced: true, reachedReview: true };  // it DID reach review
    if (st && sessionLooksDead(st)) return { advanced: false, sessionDead: true, state: st };
    const samples = expandErrorSamples((st && st.errorMarkers && st.errorMarkers.samples) || []);
    if (samples.length || (st && st.errorPageText)) { LOG(`  re-click fallback: error text present — NOT re-clicking (a real validation block, not a swallowed click).`); return { advanced: false, errorsPresent: true }; }
    LOG(`  re-click fallback ${i}/${tries}: clicked but no advance + no error/session-death — re-clicking Save & Continue.`);
    await cdpWakePage();
    const click = await act.clickPageNext();
    if (!click.clicked) { LOG(`  re-click refused (${click.refused || "?"}) — stopping the fallback.`); return { advanced: false, refused: click.refused }; }
    const res = await cdpWaitNextPage(prevSig);
    if (res.advanced) return { advanced: true, attempts: i };
    if (res.sessionDead) return { advanced: false, sessionDead: true, state: res.state };
    if (res.maintenance) return { advanced: false, maintenance: true };
    // still timeout → loop and try again
  }
  return { advanced: false, attempts: tries };
}

// Poll SW-side after Save & Continue: a fresh dead-session read FIRST (a dead session
// shows VPS banners on the SAME page — no transition — so sessionLooksDead is what
// fires), else a hydrated page-signature change (steady across two reads). Mid-nav
// read errors are "not ready, keep polling".
async function cdpWaitNextPage(prevSig, timeoutMs = 15000, intervalMs = 500) {
  const start = Date.now();
  let steady = -1, errSteady = 0;
  while (Date.now() - start < timeoutMs) {
    await cdpDelay(intervalMs);
    // Keep a HIDDEN tab out of the frozen lifecycle so Workday's SPA transition can run — the
    // hidden page-2→3 stall (2026-07-03). No-op when visible/not-frozen. See cdpWakePage.
    await cdpWakePage();
    let state = null;
    try { state = await cdpEval(cdpReadSessionState); } catch (e) { continue; }
    if (state && isWorkdayMaintenance(state)) return { advanced: false, maintenance: true, state }; // transient, retry-later — NOT dead (checked first)
    if (state && sessionLooksDead(state)) return { advanced: false, sessionDead: true, state };
    let scan = null;
    try { scan = await cdpEval(cdpPageScan); } catch (e) { continue; }
    if (!scan || !scan.fields || scan.fields.length === 0) { steady = -1; errSteady = 0; continue; } // not hydrated
    const sig = cdpPageSig(scan);
    if (sig === prevSig) {
      steady = -1; // still page 1
      // FAST validation-error exit: the page did NOT advance AND shows error markers → it errored
      // (Workday never advances past a validation error). errors-present ⟺ won't-advance, so this
      // can't skip a real advance (a successful re-fill clears the errors AND changes sig → the
      // advanced path below fires instead). Two consecutive reads guard a transient flicker during a
      // real transition → ~1s instead of burning the full ceiling. sessionLooksDead is checked first.
      // Count EXPANDED errors, not raw markers: the raw count includes [role=alert] SUCCESS toasts
      // ("resume successfully uploaded"), which persist through a slow clean transition — a toast-only
      // page must never fast-exit as a validation error (2026-07-02).
      const errCount = state ? expandErrorSamples((state.errorMarkers && state.errorMarkers.samples) || []).length : 0;
      errSteady = errCount > 0 ? errSteady + 1 : 0;
      if (errSteady >= 2) return { advanced: false, timeout: true, errorDetected: true, errors: (state.errorMarkers.samples || []) };
      continue;
    }
    errSteady = 0;
    if (scan.fields.length === steady) return { advanced: true, sig };
    steady = scan.fields.length;
  }
  return { advanced: false, timeout: true };
}

const WALK_MAX_PAGES = 8; // generous cap; the review/terminal/session checks are the REAL stops — this only bounds a detection bug from looping forever.

async function runCdpWalk(tabId, profile, defaults, jobContext) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-WALK]", ...a);

  // Walk-status capture for the website review page (WHY a fill didn't reach the end): the review
  // terminal sets reachedReview, the loop tracks walkPage, reportPageErrors stashes lastDiag. Stamped
  // onto the bundle in the finally + reported → the website renders a loud halt banner + edit-profile link.
  let reachedReview = false, walkPage = 0, lastDiag = null;

  // M31.1: surface the EXACT page error text + the fields left EMPTY (no profile value —
  // the likely "required" validation cause) on a stop-with-errors. Takes the CURRENT page's
  // results (per-page in the loop). Reads error state FRESH (errors render post Save & Continue).
  const reportPageErrors = async (pageOut) => {
    let st = null;
    try { st = await cdpEval(cdpReadSessionState); } catch (e) { /* ignore */ }
    // expanded: the top banner concatenates every error into one element — split so each
    // error is its own bullet (and success toasts don't masquerade as errors).
    const samples = expandErrorSamples((st && st.errorMarkers && st.errorMarkers.samples) || []);
    if (samples.length) { LOG(`page errors (${samples.length}):`); samples.forEach((s) => LOG(`    • ${s}`)); }
    if (st && st.errorPageText) LOG(`error-page text: ${st.errorPageText}`);
    if (!samples.length && !(st && st.errorPageText)) LOG("(no error text captured on the page)");
    // Hidden-tab hint: when the page won't advance AND the tab is really hidden AND there's no error
    // text, the likely cause is Chrome freezing/throttling the background tab so Workday's SPA
    // transition stalls (advances fine when visible). The rAF-override fix (cdpInstallPageOverrides)
    // aims to unblock this while hidden; if we STILL land here, that override was insufficient — bring
    // the tab to the FOREGROUND as a fallback and re-run. Reads REAL visibility (SW-side), not the
    // page's (possibly-spoofed) document.visibilityState.
    let _visLabel = "?"; try { _visLabel = await cdpVisibilityLabel(); } catch (e) { /* ignore */ }
    if (_visLabel === "hidden" && !samples.length && !(st && st.errorPageText)) {
      LOG("⚠ the tab is HIDDEN and the page shows no errors but won't advance — the rAF-override fix did not unblock the transition this time. Bring the tab to the FOREGROUND (visible) and re-run; the fill itself works hidden, but page-to-page advancement may still need a visible tab as a fallback.");
    }
    const empties = (pageOut && pageOut.results || []).filter((r) => r.status === "skipped");
    if (empties.length) {
      LOG("fields left EMPTY (no value in the profile/JSON — the likely validation cause):");
      empties.forEach((r) => LOG(`    • ${r.fieldName} — ${r.detail}`));
    }
    lastDiag = { page_errors: samples, error_page_text: st ? (st.errorPageText || null) : null, empty_fields: empties.map((r) => ({ field: r.fieldName, reason: r.detail })) };
    return lastDiag;
  };

  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    await cdpInstallPageOverrides(); // hidden-tab SPA-transition unblock (rAF→setTimeout): so page-to-page advancement runs while backgrounded
    // Foreground fast-fill (M39): NO hidden-gate — fills immediately, visible=fast (watch the
    // whole walk) or minimize=slow/background, adapting live.
    LOG("attached. Walk starting — keep the tab VISIBLE to watch (fast) or minimize (slow/background). Fills each page → guarded Save & Continue → repeats to the REVIEW page (NEVER submits).");
    LOG("note: orphan EMPTY cert Specialties are auto-reconciled during the cert fill (deleted when the profile has none) — no manual pre-clean needed; a blocked page also gets an AI-4 Tier-1.5 section re-fill.");

    // CLEAR the accumulated summary ONCE at walk START, OUTSIDE the loop (its own guard):
    // a fresh application starts clean. The loop only calls the ACCUMULATING persist — a
    // mid-walk clear (from re-entry) would wipe the pages already filled.
    await new Promise((resolve) => chrome.storage.local.remove(["reviewSummary", "reviewAudit"], resolve));
    LOG("cleared the prior review summary + audit (fresh application).");

    const prepared = prepareProfile(profile); // once — each page fills what its own scan presents
    const act = makeCdpActuation(await getLlmConfig()); // AI-0 seam: act.llm bound to the operator's config (OFF unless the toggle is on)
    let pagesFilled = [];
    let reloadsUsed = 0; // RUN-level reload-retry budget: a transient render-flake reloads (→ page 1) + RESTARTS the walk

    restartWalk: while (true) { // a transient-flake reload restarts here from page 1 (the bundle clear stays ABOVE, once per run)
    pagesFilled = []; // reset per attempt
    for (let page = 1; page <= WALK_MAX_PAGES; page++) {
      walkPage = page;
      // ── (a/b) TOP-OF-ITERATION guards: session-death + the REVIEW terminal (SUBMIT-NEVER —
      // checked BEFORE any fill/click, so we never fill or advance the review page). ──
      let nav = null;
      try { nav = await cdpEval(cdpReadSessionState); } catch (e) { /* treat as not-ready below */ }
      if (nav && isWorkdayMaintenance(nav)) {
        LOG(`⛔ WORKDAY PLANNED MAINTENANCE at page ${page} ("Workday is currently unavailable") — NOT a dead session, no re-login needed. Retry after the maintenance window, then re-run.`);
        return { ok: true, stopped: "workday-maintenance", workday_maintenance: true, pages_filled: pagesFilled.length, pages: pagesFilled };
      }
      if (nav && sessionLooksDead(nav)) {
        LOG(`⚠⚠ SESSION EXPIRED at page ${page} (login/VPS/no-form) — refresh, log in, reopen the form, retry.`);
        const diag = await reportPageErrors(null);
        return { ok: true, stopped: "session-expired", session_expired: true, pages_filled: pagesFilled.length, pages: pagesFilled, ...diag };
      }
      if (nav && nav.applyFlowReviewPresent) {
        reachedReview = true;
        LOG(`✓✓ reached the REVIEW page after ${pagesFilled.length} page(s) — the whole application is filled. NOT submitting (terminal). "View last summary" for the accumulated bundle.`);
        return { ok: true, stopped: "reached-review", reached_review: true, pages_filled: pagesFilled.length, pages: pagesFilled };
      }

      // ── (c) Fill this (non-review) page: fold + inline M40 audit + accumulate. ──
      LOG(`──── PAGE ${page} ────`);
      const { out, pageKey } = await fillAndPersistPage(act, prepared, defaults, jobContext, LOG, { pageNumber: page });
      // ── RELOAD-RETRY: if this page's fill failures are ALL TRANSIENT render-flakes, reload (Workday
      //    returns to page 1) + RESTART the fill walk from page 1, bounded. A mix with a real needs-review
      //    field does NOT reload (those go to review as usual). Each page accumulate-replaces, so the
      //    re-walk is idempotent (the already-filled sweep makes the good pages fast). ──
      {
        const flakes = (out.results || []).filter((r) => r.status === "needs_review" || r.status === "error");
        if (flakes.length && isTransientRenderFailure(flakes) && reloadsUsed < MAX_RELOAD_RETRIES) {
          reloadsUsed++;
          LOG(`⟳ page ${page}: fill failure(s) are all TRANSIENT render-flakes — reloading (Workday returns to page 1) + RESTARTING the fill walk from page 1 (reload ${reloadsUsed}/${MAX_RELOAD_RETRIES}): ${flakes.map((r) => r.fieldName).join(", ")}`);
          const ready = await reloadAndSettle(LOG);
          if (ready) continue restartWalk;
          LOG(`⚠ page ${page}: reload did not settle — proceeding with the last fill.`);
        }
      }
      pagesFilled.push({ page, url: out.url, counts: out.counts, needs_review: out.needsReview.length, audit_flagged: out.results.filter((r) => r.flag === "audit-mismatch" || r.flag === "audit-unverifiable").length, reloads: reloadsUsed });

      // ── (c.1) Required-upload guard (walk prereq 1, hold #1): a file_upload that didn't
      // attach (no resume / failed) WILL block Save & Continue → HALT here, self-explaining,
      // BEFORE clickPageNext (not a bare nav-timeout). ──
      const upRec = out.results.find((r) => r.widgetType === "file_upload");
      if (upRec && upRec.status !== "filled") {
        LOG(`⚠ resume NOT attached on page ${page} (${upRec.detail}) — the required upload blocks Save & Continue. Halting. Fix: upload a resume in the popup, clear any bad attachment on the form, re-run.`);
        return { ok: true, stopped: "resume-not-attached", resume_detail: upRec.detail, pages_filled: pagesFilled.length, pages: pagesFilled };
      }

      // (AI-3, operator-decided: required consent checkboxes AUTO-CHECK in the fill — no consent
      //  halt; the bot silently accepts them. An explicit profile `false` stays unchecked = a refusal.)

      // ── (d) Terminal page with no Save & Continue (not the review marker — unusual). ──
      const navAfter = await cdpEval(cdpReadSessionState);
      if (!navAfter || !navAfter.nextButtonPresent) {
        LOG(`no Save & Continue on page ${page} — terminal page (not the review marker). Stop.`);
        return { ok: true, stopped: "no-next-button", pages_filled: pagesFilled.length, pages: pagesFilled };
      }

      // ── (e) Guarded advance (clickPageNext re-checks the review marker — the 2nd guard). ──
      // Capture the transition signature AFTER the fill (not before it): the fill itself mutates this
      // page's field set — leaving "preferred name" unchecked removes its two fields, a Country cascade
      // adds/removes others — so a PRE-fill signature already differs from the settled post-fill DOM.
      // With a stale pre-fill sig, cdpWaitNextPage FALSELY reads "advanced" when Save & Continue was
      // actually BLOCKED (e.g. an invalid ZIP), and the walk re-fills the SAME page as a phantom next
      // page. Snapshotting here means ONLY a real Save & Continue transition changes the signature.
      const prevSig = cdpPageSig(await cdpEval(cdpPageScan));
      await cdpWakePage(); // wake a frozen hidden tab so the Save & Continue transition can run (hidden page-N→N+1 stall)
      const click = await act.clickPageNext();
      LOG(`page ${page} Save & Continue:`, JSON.stringify(click));
      if (!click.clicked) {
        const blockNote = click.blockedBy ? ` — a popup/overlay is COVERING the button: ${click.blockedBy}. Close it, then re-run.` : "";
        LOG(`advance refused on page ${page} (${click.refused})${blockNote} — stop.`);
        return { ok: true, stopped: "click-refused:" + (click.refused || "?"), blocked_by: click.blockedBy || null, pages_filled: pagesFilled.length, pages: pagesFilled };
      }

      // ── (f) Wait for the transition OR session-death OR a nav-timeout (dirty halt). ──
      const res = await cdpWaitNextPage(prevSig);
      if (res.maintenance) {
        LOG(`⛔ WORKDAY PLANNED MAINTENANCE after Save & Continue on page ${page} ("Workday is currently unavailable") — NOT a dead session. Retry after the maintenance window.`);
        return { ok: true, stopped: "workday-maintenance", workday_maintenance: true, pages_filled: pagesFilled.length, pages: pagesFilled };
      }
      if (res.sessionDead) {
        LOG(`⚠⚠ SESSION EXPIRED after Save & Continue on page ${page} — refresh, log in, reopen, retry.`);
        const diag = await reportPageErrors(out);
        return { ok: true, stopped: "session-expired", session_expired: true, pages_filled: pagesFilled.length, pages: pagesFilled, ...diag };
      }
      if (res.timeout) {
        // AI-4: clicked Save & Continue but the page neither advanced nor died → a LIVE validation
        // error (sessionLooksDead already excluded above). Attempt BOUNDED remediation before the
        // dirty halt: Tier-0 dup-language / Tier-1 deterministic re-fill → Tier-2 AI, capped + halt-on-no-progress.
        if (res.errorDetected) LOG(`page ${page} Save & Continue blocked — error markers detected fast (~1s).`);
        // OPERATOR RULE: with AI fill OFF, do NOT auto-remediate — the deterministic Tier-1/1.6 re-fill
        // is the unwanted "refill on error" (and, pre-M-overwrite, a duplicate-page vector). Skip
        // remediation entirely and HALT on any error the deterministic pass couldn't clear; only a
        // harmless re-click (a SWALLOWED Save & Continue, never a re-fill) is still attempted below. AI
        // ON keeps the full AI-4 remediation ladder.
        let rem = { attempts: 0, advanced: false, reason: "ai-off (no remediation — halt on error)", actions: [] };
        if (act.aiEnabled) {
          rem = await remediatePageErrors(act, prepared, defaults, jobContext, out, pageKey, page, LOG);
        } else {
          LOG(`page ${page} nav-timeout with AI fill OFF — NOT re-filling the page (halt-on-error, operator rule). Only a re-click for a swallowed Save & Continue will be tried.`);
        }
        // refresh the page-summary entry with the remediation outcome
        pagesFilled[pagesFilled.length - 1].remediation = { attempts: rem.attempts, advanced: !!rem.advanced, reason: rem.reason || null, actions: rem.actions };
        if (rem.sessionDead) {
          LOG(`⚠⚠ SESSION EXPIRED during remediation on page ${page} — refresh, log in, reopen, retry.`);
          const diag = await reportPageErrors(out);
          return { ok: true, stopped: "session-expired", session_expired: true, pages_filled: pagesFilled.length, pages: pagesFilled, ...diag };
        }
        if (rem.advanced) {
          LOG(`✓ page ${page} → advanced after AI-4 remediation (${rem.attempts} attempt(s)).`);
          continue; // top-of-loop re-checks review/session on the new page
        }
        // Operator ask (2026-07-10): a CLEAN no-advance (clicked:true but the page didn't move AND AI-4
        // found NO error to fix) is a SWALLOWED Save & Continue → RE-CLICK it (up to 2x). Runs only after
        // remediation confirmed there's nothing to remediate; reclickNextWhenClean self-guards on
        // error/session-death, so a real validation block is never masked (it halts as before).
        const reclick = await reclickNextWhenClean(act, prevSig, 2, LOG);
        if (reclick.sessionDead) {
          LOG(`⚠⚠ SESSION EXPIRED during the re-click fallback on page ${page} — refresh, log in, reopen, retry.`);
          const diag = await reportPageErrors(out);
          return { ok: true, stopped: "session-expired", session_expired: true, pages_filled: pagesFilled.length, pages: pagesFilled, ...diag };
        }
        if (reclick.advanced) {
          LOG(`✓ page ${page} → advanced after re-clicking Save & Continue (${reclick.attempts || "?"}x — the first click was swallowed).`);
          continue;
        }
        LOG(`⚠ nav-timeout on page ${page} — ${act.aiEnabled ? `AI-4 remediation (${rem.attempts} attempt(s), ${rem.reason})` : "AI fill OFF (no re-fill — operator halt-on-error rule)"} ${reclick.errorsPresent ? "+ a real error blocks re-click" : "+ re-click fallback (" + (reclick.attempts || 0) + "x)"} did NOT clear it. PAGE ${page} MAY NOW BE DIRTY — eyeball it; do NOT re-run as if fresh. Errors + empty fields:`);
        const diag = await reportPageErrors(out);
        return { ok: true, stopped: "nav-timeout-dirty", nav_timeout_page: page, remediation: { attempts: rem.attempts, reason: rem.reason, actions: rem.actions }, pages_filled: pagesFilled.length, pages: pagesFilled, ...diag };
      }
      LOG(`✓ page ${page} → advanced.`);
      // res.advanced → next iteration (top-of-loop re-checks review/session on the new page).
    }
    break restartWalk; // the for-loop completed all pages without a transient-flake restart → exit the retry loop
    } // restartWalk

    LOG(`⚠ hit the ${WALK_MAX_PAGES}-page cap without reaching review — stopping (a detection-bug backstop). Eyeball the application.`);
    return { ok: true, stopped: "max-pages-cap", pages_filled: pagesFilled.length, pages: pagesFilled };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("walk aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await removeInputLock(); // BEFORE detach (needs the attach) — never strand the operator behind the lock
    await cdpDetach();
    // Push the ACCUMULATED review bundle to the website (the review surface) on EVERY exit —
    // reached-review, a mid-walk halt, or an abort — STAMPED with a walk_status so the review page can
    // say WHY the fill didn't reach the end (halted-on-error / session-expired / cancelled / completed),
    // surface the exact page errors, and offer an edit-profile link. Fire-and-forget; no-op if the
    // website isn't connected (no apSession).
    try {
      const store = await new Promise((r) => chrome.storage.local.get(["reviewSummary", "lastRunAbort"], r));
      const reviewSummary = store.reviewSummary;
      if (reviewSummary) {
        reviewSummary.walk_status = {
          completed: reachedReview,               // reached the review page = the whole app got filled
          stopped_page: walkPage || null,         // the page the walk was on when it ended
          page_errors: (lastDiag && lastDiag.page_errors) || [],       // Workday's top-of-page error text
          error_text: (lastDiag && lastDiag.error_page_text) || null,
          empty_fields: (lastDiag && lastDiag.empty_fields) || [],     // required fields with no profile value
          cancelled: !!(store.lastRunAbort && store.lastRunAbort.reason === "operator-cancelled"),
        };
        await new Promise((r) => chrome.storage.local.set({ reviewSummary }, r));
        await reportApplication(reviewSummary, jobContext);
      }
    } catch (e) { /* reporting NEVER affects the walk result */ }
  }
}

// ============================================================================
// GMAIL SMOKE TEST — the FIRST thing to run after pinning the key + creating the
// OAuth client (the operator's build-order step): prove chrome.identity.getAuthToken
// returns a gmail.readonly token AND a users/me/profile readonly call succeeds, BEFORE
// wiring it into the onboarding flow. Shows the CONNECTED account email so the operator
// confirms it's the inbox their Workday +alias delivers to. Client-side only — the token
// and the profile response never leave the extension. [GMAIL-TEST] in the SW console.
// ============================================================================
async function runGmailSmokeTest(interactive) {
  const LOG = (...a) => console.log("[ApplyPilot][GMAIL-TEST]", ...a);
  let tok = await gmailGetToken(interactive !== false);
  if (!tok.ok) { LOG("getAuthToken FAILED —", tok.error, "(manifest oauth2.client_id set to your Chrome-Extension OAuth client? identity permission present? extension ID matches the client?)"); return { ok: false, error: tok.error }; }
  LOG("got a gmail.readonly token — calling users/me/profile (readonly)…");
  let prof = await gmailApiGet(tok.token, "/profile");
  if (!prof.ok && (prof.status === 401 || prof.status === 403)) {
    LOG("profile call 401/403 — refreshing the token once and retrying.");
    await gmailRemoveCachedToken(tok.token);
    tok = await gmailGetToken(true);
    if (tok.ok) prof = await gmailApiGet(tok.token, "/profile");
  }
  if (!prof.ok) { LOG("profile call FAILED —", prof.error); return { ok: false, error: prof.error }; }
  LOG(`✓ connected to Gmail: ${prof.data.emailAddress} (messagesTotal ${prof.data.messagesTotal}). Readonly access confirmed.`);
  return { ok: true, email: prof.data.emailAddress, messagesTotal: prof.data.messagesTotal };
}

// ============================================================================
// ONBOARDING STAGE (the pre-form walk) — JD page → Apply → Apply Manually →
// sign-in / create-account → email verification (Gmail) → land on the form. Port of
// the Playwright repo's workday.py (navigate_to_first_form_page → handle_application_modal
// → handle_auth_screen → _handle_email_verification), on the CDP substrate, hardened.
//
// Substrate: drives the ACTIVE tab via the cdp.js primitives (same "SW drives, page
// returns" discipline as the walk). Detaches in finally. The FILL WALK is a SEPARATE
// attach (chained by the RUN_CDP_ONBOARD handler only if the operator opts in) — so
// this stage lands on the form and STOPS there by default (conservative: the fill walk
// ADVANCES a live application). No input-lock here — a takeover halt (SSO/2FA/CAPTCHA)
// must leave the operator free to act.
//
// SAFETY: never submits an application; never clicks "Use My Last Application" / any
// affirmative consent-popup control; refuses SSO (halts for manual login). Every halt
// that needs a human returns needs_operator with a self-explaining reason.
// ============================================================================
async function runCdpOnboard(tabId, opts) {
  const LOG = (...a) => console.log("[ApplyPilot][ONBOARD]", ...a);
  const o = opts || {};
  const creds = o.credentials || null;
  const gmailEnabled = !!o.gmailEnabled;
  const startUrl = o.startUrl || null;
  let accountCreated = false, verified = false, softReloads = 0;

  // Adaptive pacing — mirrors the fill's act.delay: ~10× faster when the tab is VISIBLE (or its
  // worker-timers measure fast), FULL (throttle-safe) when hidden/backgrounded. Used for ALL
  // click/type/transition pacing here, so an onboarding run is snappy in the foreground yet safe
  // hidden (a throttled tab never gets raced). The ONE genuine server-commit wait — the 5s
  // post-activation settle — stays a fixed cdpDelay (it must be real wall-clock regardless of
  // visibility). Every pace() site is gated by a subsequent state check (read-back / poll / scan),
  // so a too-short fast wait can only cost a retry, never a silent wrong action.
  const pace = (ms) => cdpAdaptiveDelay(ms);

  const scan = async () => { try { return await cdpEval(cdpOnboardScan); } catch (e) { return null; } };
  const isPastAuth = (s) => !!s && (s.formFieldCount || 0) > 0 && !s.hasAuthEl;
  const presentApply = (s) => {
    const out = [];
    if (s.markers.adventureButton) out.push('[data-automation-id="adventureButton"]');
    if (s.markers.continueButton) out.push('[data-automation-id="continueButton"]');
    if (s.markers.applyManually) out.push('[data-automation-id="applyManually"]');
    return out;
  };

  // Wait for the DOM to settle after a navigation/reload (readyState complete + a small
  // React-hydration beat). Poll-based; mid-nav eval errors are "keep polling".
  const settlePage = async (timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await pace(400);
      await cdpWakePage();
      let ready = null;
      try { ready = await cdpEval(() => document.readyState); } catch (e) { continue; }
      if (ready === "complete") { await pace(700); return true; }
    }
    return false;
  };

  // Workday's transient "Something went wrong / please refresh" soft-error → reload ONCE
  // (capped at 2 across the run) and re-scan. Returns true if it reloaded (caller re-scans).
  const maybeRefresh = async (st) => {
    if (!st || !isWorkdaySoftError(st.bodyText)) return false;
    if (softReloads >= 2) { LOG(`⚠ Workday soft-error persists after ${softReloads} reload(s) — not reloading again.`); return false; }
    softReloads++;
    LOG(`Workday soft-error ("Something went wrong / please refresh") — reloading the page (reload #${softReloads}) and retrying.`);
    await cdpReload();
    await settlePage(9000);
    return true;
  };

  // Poll scan() until pred(scan) is true or a timeout; runs the soft-error reload guard
  // each tick. Returns { matched, scan }.
  const waitFor = async (pred, timeoutMs, label) => {
    const start = Date.now();
    let st = null;
    while (Date.now() - start < timeoutMs) {
      await pace(500);
      await cdpWakePage();
      st = await scan();
      if (!st) continue;
      if (await maybeRefresh(st)) { st = await scan(); if (!st) continue; }
      if (pred(st)) return { matched: true, scan: st };
    }
    LOG(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    return { matched: false, scan: st };
  };

  // Click the first present selector, auto-dismissing a covering popup ONCE (consent-safe,
  // shadow-DOM aware — reuses the clickPageNext machinery). { clicked, sel } / { clicked:false, blockedBy }.
  const clickTarget = async (selectors, label) => {
    for (const sel of selectors) {
      const rect = await cdpRectReady(sel, true);
      if (!rect) continue;
      let cover = await cdpEval(cdpCoverCheck, sel, rect.cx, rect.cy);
      if (cover && cover.blocked) {
        const d = await cdpEval(cdpFindDismissControl, rect.cx, rect.cy);
        if (d && d.found) {
          LOG(`"${label}" covered by ${cover.by} — clicking its dismiss control ${JSON.stringify(d.label)}.`);
          await cdpClickAt(d.cx, d.cy);
          await pace(800);
          cover = await cdpEval(cdpCoverCheck, sel, rect.cx, rect.cy);
        }
      }
      if (cover && cover.blocked) { LOG(`"${label}" is covered by ${cover.by} — refusing a blind click.`); return { clicked: false, blockedBy: cover.by, sel }; }
      await cdpClickAt(rect.cx, rect.cy);
      LOG(`clicked "${label}".`);
      return { clicked: true, sel };
    }
    return { clicked: false };
  };

  // Focus → clear → insertText → read-back a text/email/password input by the first
  // matching selector. Trusted CDP path (survives blur), same technique as the fill's focusText.
  const fillField = async (selectors, value, label) => {
    for (const sel of selectors) {
      const rect = await cdpRectReady(sel, true);
      if (!rect) continue;
      await cdpClickAt(rect.cx, rect.cy);
      await pace(200);
      let s = await cdpEval(cdpReadInputBySel, sel);
      if (!s || !s.focused) { try { await cdpDomFocus(sel); } catch (e) { /* fall through */ } }
      await cdpSelectAllDelete();
      await pace(120);
      await cdpInsertText(String(value));
      await pace(300);
      s = await cdpEval(cdpReadInputBySel, sel);
      const ok = !!s && String(s.value) === String(value);
      LOG(`filled "${label}" — ${ok ? "read-back ok" : "read-back MISMATCH (got " + JSON.stringify(s && s.value) + ")"}.`);
      return { ok, sel };
    }
    LOG(`could not find an input for "${label}" (${selectors.join(", ")}).`);
    return { ok: false };
  };

  const fillVerifyPassword = async (value) => {
    const vp = await fillField(['[data-automation-id="verifyPassword"]'], value, "verify password");
    if (vp.ok) return vp;
    const rect = await cdpEvalRectReady(cdpNthPasswordRect, 1); // 2nd password input
    if (!rect) return { ok: false };
    await cdpClickAt(rect.cx, rect.cy); await pace(200);
    await cdpSelectAllDelete(); await pace(120);
    await cdpInsertText(String(value)); await pace(300);
    LOG("filled verify password (2nd password-input fallback).");
    return { ok: true };
  };

  const checkConsent = async () => {
    let c = await cdpEval(cdpConsentRect);
    if (!c) { LOG("no consent checkbox detected — proceeding (some tenants have none)."); return; }
    if (c.checked) { LOG("consent already checked."); return; }
    await cdpClickAt(c.cx, c.cy);
    await pace(300);
    c = await cdpEval(cdpConsentRect);
    LOG(`consent checkbox — ${c && c.checked ? "checked" : "still unchecked (proceeding anyway)"}.`);
  };

  // Click a submit button and wait for the auth outcome — with a re-click FALLBACK. If the wait
  // times out AND the form is still up (`formStillUp` → the submit control is still present, so we
  // did NOT navigate → the click raced a not-yet-enabled button, or a throttled/hidden page never
  // reacted), RE-CLICK and wait again, bounded by `tries`. The re-click is gated on the form still
  // being up so a retry can never click into a page that already advanced. `done(s)` = the page
  // moved on. Returns { scan } (final scan) or { notFound, blockedBy } if the button was never clickable.
  // tries = 3 → the initial click + up to TWO re-clicks, so a Sign In / Create Account that "does
  // nothing" keeps getting retried (operator ask 2026-07-10). Both submits go through this.
  const submitAndWait = async ({ selectors, label, done, formStillUp, tries = 3, timeoutMs = 20000 }) => {
    let st = null;
    for (let t = 1; t <= tries; t++) {
      const submitted = await clickTarget(selectors, t > 1 ? `${label} (retry ${t - 1})` : label);
      if (!submitted.clicked) return (t > 1) ? { scan: st } : { notFound: true, blockedBy: submitted.blockedBy };
      const w = await waitFor((s) => done(s) || isWorkdaySoftError(s.bodyText), timeoutMs, `${label} outcome`);
      st = w.scan || st;
      if (st && await maybeRefresh(st)) st = await scan() || st;
      if (st && done(st)) return { scan: st };
      // Timed out. Re-click ONLY if still on this submit form; else the page advanced (done just
      // doesn't match yet) → return and let the caller re-evaluate on the next loop iteration.
      if (t < tries && st && formStillUp(st)) { LOG(`${label}: no outcome after ${Math.round(timeoutMs / 1000)}s and the form is still up — re-clicking (raced/not-ready button or a throttled page).`); continue; }
      return { scan: st };
    }
    return { scan: st };
  };

  // Gmail email-verification: find the workday.com link containing the tenant host and
  // navigate the tab to it. Returns { ok } or a needs_operator halt object.
  const doVerify = async (st) => {
    if (!gmailEnabled) return { ok: false, reached_form: false, needs_operator: true, stopped: "verification-required-gmail-off", detail: "Workday requires email verification but Gmail auto-verify is OFF. Enable it (and Connect Gmail) in the popup, or click the link in the email yourself and re-run." };
    const host = st.host || "";
    // Account-exists-but-UNVERIFIED (a prior run created it, verification never completed): Workday's
    // sign-in page shows a "Resend Account Verification" button, and the ORIGINAL email may be stale
    // or expired (past the freshness window / link no longer valid). Click Resend to dispatch a FRESH
    // email BEFORE polling (operator-confirmed on altasciences, 2026-07-10). Harmless when a fresh
    // email already exists (this run just created the account) — the poll takes the newest match.
    try {
      const resend = await cdpEval(cdpResendVerifyRect);
      if (resend) { LOG(`account is unverified — clicking "${resend.label}" to request a FRESH verification email before polling.`); await cdpClickAt(resend.cx, resend.cy); await cdpDelay(2500); }
    } catch (e) { /* best-effort — poll anyway */ }
    LOG(`email verification required — polling Gmail (readonly) for a workday.com link containing "${host}" (up to 120s)…`);
    let tok = await gmailGetToken(true);
    if (!tok.ok) return { ok: false, reached_form: false, needs_operator: true, stopped: "gmail-auth-failed", detail: tok.error };
    const args = { token: tok.token, senderContains: "workday.com", urlMustContain: host, timeoutMs: 120000, pollMs: 5000 };
    let find = await gmailFindVerificationEmail(args);
    if (!find.ok && (find.status === 401 || find.status === 403)) {
      LOG("Gmail token 401/403 — refreshing once and retrying.");
      await gmailRemoveCachedToken(tok.token);
      tok = await gmailGetToken(true);
      if (tok.ok) find = await gmailFindVerificationEmail({ ...args, token: tok.token });
    }
    if (!find.ok) return { ok: false, reached_form: false, needs_operator: true, stopped: "verification-email-not-found", detail: find.error };
    LOG(`verification link found — navigating the tab to it: ${String(find.url).slice(0, 90)}…`);
    const nav = await cdpNavigate(find.url);
    if (!nav.ok) return { ok: false, reached_form: false, needs_operator: true, stopped: "verify-nav-failed", detail: nav.error };
    await settlePage(15000);
    // Workday's activate link ACTIVATES the account then lands on / redirects to the sign-in page,
    // and that redirect takes a beat. WAIT for the sign-in page (or the form, if a tenant auto-signs-in)
    // to actually render before the loop re-attempts sign-in — mirrors the reference's
    // _wait_for_sign_in_page. Without this, the loop re-scanned a transitional page, found no form, and
    // bailed silently ("activated correctly but didn't sign in" — altasciences wd1, 2026-07-09).
    const w = await waitFor(
      (s) => s.passwordInput || s.emailInput || s.signInWithEmail || s.markers.signInLink || s.markers.signInSubmit || s.formFieldCount > 0,
      20000, "post-activation sign-in page");
    let post = w.scan || await scan();
    if (post && await maybeRefresh(post)) post = await scan();
    // Operator's flag: a verify link CAN be session-bound. If the landed page says the link
    // was rejected, surface it (no auth mechanism fixes a session-bound link — verify manually).
    if (post && /this link (has )?expired|no longer valid|link is invalid|unable to verify|link was not recognized/i.test(post.bodyText || "")) {
      return { ok: false, reached_form: false, needs_operator: true, stopped: "verify-link-invalid", detail: "the verification link was rejected — it may be session-bound; open it manually in this browser, then re-run." };
    }
    // Let the server COMMIT the activation before the loop re-signs-in. Signing in the instant after
    // the activate link can leave the account still reading "pending verification" → Workday re-issues
    // a SECOND verification email and the whole cycle repeats (PANW needed two cycles otherwise,
    // 2026-07-09 — "maybe it did it too fast"). A fixed wall-clock settle (once per verify, cheap).
    await cdpDelay(5000);
    LOG(`navigated to the verification link — account activated; sign-in page ${w.matched ? "is up" : "wait timed out, trying anyway"}; settled 5s for activation to commit; re-attempting sign-in.`);
    return { ok: true };
  };

  // Create a Workday account (workday.py _create_account_flow), then let the auth loop
  // re-check outcome (past-auth / verify / already-exists→sign-in).
  const doCreateAccount = async (st) => {
    LOG(`creating a Workday account as ${creds.email}…`);
    if (st.markers.createAccountLink) { await clickTarget(['[data-automation-id="createAccountLink"]'], "Create Account tab"); await pace(900); st = await scan() || st; }
    await fillField(['[data-automation-id="email"]', 'input[type="email"]'], creds.email, "email");
    await fillField(['[data-automation-id="password"]', 'input[type="password"]'], creds.password, "password");
    await fillVerifyPassword(creds.password);
    await checkConsent();
    await cdpDelay(500); // FIXED (not paced) — same as the Sign In submit: the Create Account button enables a beat after the fields fill; don't race it.
    // Submit + wait, with the re-click fallback (raced/not-ready button or a throttled page). "Moved
    // on" = an outcome (verify/wrong/success), a sign-in submit, an already-exists message, OR the
    // social-login CHOOSER reappearing (PANW routes back to it after create-account; signInWithEmail
    // is absent on the create form we submitted, so it only turns true on a genuine re-route). Re-click
    // only while the create form is still up (createAccountSubmit present) — never into an advanced page.
    const r = await submitAndWait({
      selectors: ['[data-automation-id="createAccountSubmitButton"]', '[data-automation-id="click_filter"][aria-label="Create Account"]'],
      label: "Create Account submit",
      done: (s) => classifyAuthOutcome(s) !== "unknown" || s.markers.signInSubmit || s.signInWithEmail || /already (exists|in use)|account (already )?exists|email is already/i.test(s.bodyText || ""),
      formStillUp: (s) => !!s.markers.createAccountSubmit
    });
    if (r.notFound) return { ok: false, reached_form: false, needs_operator: true, stopped: "create-account-submit-not-found", detail: r.blockedBy || "no Create Account button" };
    let post = r.scan || st;
    if (post && /already (exists|in use)|an account (already )?exists|email is already (in use|registered)/i.test(post.bodyText || "")) {
      LOG("Workday says the account already exists — will sign in instead.");
      return { ok: true, alreadyExists: true };
    }
    return { ok: true };
  };

  // Auth loop: try sign-in first; verify→re-sign-in; wrong→create-account→loop.
  const doAuth = async () => {
    // Headroom: on a chooser tenant every real step (chooser reveal, sign-in, create-account, verify,
    // re-sign-in) consumes an iteration, and a stray SECOND verify cycle doubles that — PANW hit
    // exactly 8 with a double-cycle (2026-07-09), i.e. no margin. 12 comfortably survives a
    // chooser→create→verify→(re-verify)→re-sign-in chain while still backstopping a genuinely stuck page.
    const maxAttempts = 12;
    let revealStalls = 0; // consecutive "Sign in with email" reveals where the form never rendered (hidden-tab repaint stall)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let st = await scan();
      if (!st) { await settlePage(6000); st = await scan(); }
      if (!st) return { ok: false, error: "no-page-state-in-auth" };
      if (await maybeRefresh(st)) st = await scan() || st;

      const oc = classifyAuthOutcome(st);
      if (oc === "success" || isPastAuth(st)) { LOG("reached the application form."); return { ok: true, reached_form: true, stopped: "reached-form", account_created: accountCreated, verified }; }
      // doVerify/doCreateAccount use their `ok` as an INTERNAL success signal; a halt object
      // (needs_operator) is a SUCCESSFUL onboarding run that needs a human, so surface it as
      // ok:true (the outer contract: ok:false ⇒ a crash only). The popup keys off needs_operator/detail.
      if (oc === "verify") { const v = await doVerify(st); if (!v.ok) return { ...v, ok: true }; verified = true; continue; }

      // Social-login CHOOSER (e.g. Palo Alto Networks wd5): the email/password form is behind a
      // "Sign in with email" button (alongside federated Apple/Google/LinkedIn buttons we NEVER
      // click). Click it to reveal the normal sign-in screen, then re-loop. Done BEFORE the SSO
      // check so the chooser isn't mistaken for a forced SSO redirect.
      if (!st.passwordInput && !st.emailInput && st.signInWithEmail) {
        LOG('auth is a social-login chooser — clicking "Sign in with email" to reveal the form.');
        const c = await clickTarget(['[data-automation-id="SignInWithEmailButton"]'], "Sign in with email");
        if (!c.clicked) return { ok: true, reached_form: false, needs_operator: true, stopped: "signin-with-email-blocked", detail: c.blockedBy || "could not click Sign in with email" };
        await cdpWakePage();
        const w = await waitFor((s) => s.passwordInput || s.emailInput || s.markers.createAccountLink || s.markers.signInSubmit, 15000, "email-sign-in-form");
        st = w.scan || st;
        // Hidden-render stall: the chooser→form reveal defers on rAF, which is paused when the tab is
        // backgrounded (and this page's CSP evidently blocks the worker-timer workaround). Rather than
        // re-reveal forever (PANW hidden looped to the cap, 2026-07-09), halt after 2 misses with an
        // ACTIONABLE message. The account is already created/activated by now, so a foreground re-run
        // signs straight in. focus-emulation (cdpSetFocusEmulation) is the attempted fix; this is the net.
        if (w.matched) { revealStalls = 0; }
        else if (++revealStalls >= 2) {
          return { ok: true, reached_form: false, needs_operator: true, stopped: "hidden-render-stalled", detail: 'the sign-in form did not render after "Sign in with email" — this Workday page does not repaint while the tab is hidden/backgrounded. Bring the tab to the FOREGROUND (visible) and re-run; the account is already created, so it will sign straight in.' };
        }
        continue;
      }

      if (looksLikeSso(st)) return { ok: true, reached_form: false, needs_operator: true, stopped: "sso", detail: "this tenant uses SSO/federated login — sign in manually, then re-run (it detects the form and continues)." };
      if (!creds || !creds.email || !creds.password) return { ok: true, reached_form: false, needs_operator: true, stopped: "no-credentials", detail: "load credentials (data/credentials.json) in the popup, or sign in manually then re-run." };

      // Prefer the sign-in path (switch to its tab if a link is showing).
      if (st.markers.signInLink) { await clickTarget(['[data-automation-id="signInLink"]'], "Sign In tab"); await pace(800); st = await scan() || st; }

      if (st.passwordInput || st.emailInput) {
        LOG(`sign-in attempt ${attempt} as ${creds.email}.`);
        // data-automation-id FIRST (Workday-canonical + present on observed tenants); the generic
        // input[type=email] is the fallback. Ordering matters only for speed — a missing first
        // selector burns the ~2.5s cdpRectReady ceiling before falling through (live: Comcast has
        // no input[type=email], so the old order stalled 2.6s on the sign-in email field).
        await fillField(['[data-automation-id="email"]', 'input[type="email"]'], creds.email, "email");
        await fillField(['[data-automation-id="password"]', 'input[type="password"]'], creds.password, "password");
        // FIXED (not paced) — a real page-reaction wait, like the 5s activation settle: Workday
        // ENABLES/validates the Sign In submit a beat AFTER the fields fill, and a submit click has
        // no self-correcting gate (unlike fills/tab-clicks, which cdpRectReady/waitFor re-poll). A
        // scaled ~50ms wait on a visible tab clicked the not-yet-ready button and no-op'd ("it
        // doesn't click the sign in", 2026-07-09). 500ms is the reference-proven value.
        await cdpDelay(500);
        // Canonical id first (present on observed tenants → no rectReady stall); the click_filter
        // handle + generic submit are fallbacks. A coordinate click on the button hits Workday's
        // click_filter overlay if present — cdpCoverCheck now allows that (it's the click surface).
        const r = await submitAndWait({
          selectors: ['[data-automation-id="signInSubmitButton"]', '[data-automation-id="click_filter"][aria-label="Sign In"]', 'button[type="submit"]'],
          label: "Sign In submit",
          done: (s) => classifyAuthOutcome(s) !== "unknown",
          formStillUp: (s) => !!s.markers.signInSubmit
        });
        if (r.notFound) return { ok: true, reached_form: false, needs_operator: true, stopped: "signin-submit-not-found", detail: r.blockedBy || "no Sign In button" };
        st = r.scan || st;
        const out = classifyAuthOutcome(st);
        LOG(`sign-in outcome: ${out}.`);
        if (out === "success") return { ok: true, reached_form: true, stopped: "reached-form", account_created: accountCreated, verified };
        if (out === "verify") { const v = await doVerify(st); if (!v.ok) return { ...v, ok: true }; verified = true; continue; }
        if (out === "wrong_credentials") { const cr = await doCreateAccount(st); if (!cr.ok) return { ...cr, ok: true }; accountCreated = true; continue; }
        return { ok: true, reached_form: false, needs_operator: true, stopped: "auth-unknown", detail: `${st.title} — ${(st.bodyText || "").replace(/\s+/g, " ").slice(0, 160)}` };
      }

      // No sign-in form but a create-account affordance → create directly.
      if (st.markers.createAccountLink || st.markers.createAccountSubmit || st.markers.verifyPassword) {
        const cr = await doCreateAccount(st); if (!cr.ok) return { ...cr, ok: true }; accountCreated = true; continue;
      }

      return { ok: true, reached_form: false, needs_operator: true, stopped: "auth-unrecognized", detail: st.title };
    }
    return { ok: true, reached_form: false, needs_operator: true, stopped: "auth-max-attempts", detail: `exceeded ${maxAttempts} auth attempts` };
  };

  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    await cdpInstallPageOverrides();
    await cdpSetFocusEmulation(true); // best-effort: keep a hidden/backgrounded tab repainting (SPA sub-view transitions defer on rAF, paused when hidden)
    LOG("attached. Onboarding: JD → Apply → Apply Manually → sign-in/create-account → verify → land on the form. Keep the tab VISIBLE to watch. Never submits.");

    if (startUrl) {
      LOG("navigating to the start URL:", startUrl);
      const nav = await cdpNavigate(startUrl);
      if (!nav.ok) return { ok: false, error: "navigate-failed:" + nav.error };
      await settlePage(15000);
    }

    let st = await scan();
    if (!st) { await settlePage(9000); st = await scan(); }
    if (!st) return { ok: false, error: "no-page-state (is the tab on a Workday page?)" };
    if (await maybeRefresh(st)) st = await scan() || st;

    if (isPastAuth(st)) { LOG("already on the application form — nothing to onboard."); return { ok: true, reached_form: true, stopped: "already-on-form" }; }
    if (isWorkdayMaintenance({ title: st.title, bodyText: st.bodyText, formFieldCount: st.formFieldCount, passwordInputPresent: st.passwordInput, signInButtonPresent: st.signInButtonPresent })) {
      LOG("⛔ Workday planned-maintenance page — retry after the maintenance window.");
      return { ok: true, reached_form: false, needs_operator: true, stopped: "workday-maintenance" };
    }

    // ── STAGE 1: Apply ──
    const applyChain = presentApply(st);
    const target = pickApplyTarget(applyChain);
    if (target) {
      LOG(`Stage 1 — clicking "${target.label}".`);
      const c = await clickTarget([target.sel], target.label);
      if (!c.clicked) return { ok: true, reached_form: false, needs_operator: true, stopped: "apply-click-blocked", detail: c.blockedBy || "Apply button not clickable" };
      const w = await waitFor((s) => s.markers.applyManually || s.hasAuthEl || s.formFieldCount > 0, 20000, "post-apply");
      st = w.scan || st;
    } else if (st.markers.useMyLastApplication && !st.markers.applyManually) {
      LOG('only "Use My Last Application" is offered on this page — refusing to reuse a prior application; waiting for a manual-apply/auth path…');
    }

    // ── STAGE 2: Apply Manually ──
    st = await scan() || st;
    if (st.markers.applyManually) {
      LOG('Stage 2 — clicking "Apply Manually".');
      const c = await clickTarget(['[data-automation-id="applyManually"]'], "Apply Manually");
      if (!c.clicked) return { ok: true, reached_form: false, needs_operator: true, stopped: "apply-manually-blocked", detail: c.blockedBy || "Apply Manually not clickable" };
      const w = await waitFor((s) => s.hasAuthEl || s.formFieldCount > 0, 20000, "post-apply-manually");
      st = w.scan || st;
    }

    // ── STAGE 3: Auth (+ create-account + verify) ──
    st = await scan() || st;
    if (isPastAuth(st)) { LOG("reached the form (no auth needed)."); return { ok: true, reached_form: true, stopped: "reached-form" }; }
    if (!st.hasAuthEl && !st.signInButtonPresent && st.formFieldCount === 0) {
      const w = await waitFor((s) => s.hasAuthEl || s.signInButtonPresent || s.formFieldCount > 0, 12000, "auth-or-form");
      st = w.scan || st;
      if (isPastAuth(st)) return { ok: true, reached_form: true, stopped: "reached-form" };
    }
    if (st.hasAuthEl || st.signInButtonPresent) { LOG("Stage 3 — auth screen detected."); return await doAuth(); }
    if (st.formFieldCount > 0) return { ok: true, reached_form: true, stopped: "reached-form" };
    return { ok: true, reached_form: false, needs_operator: true, stopped: "unknown-page", detail: `title="${st.title}" — could not find Apply/auth/form. Navigate to the job posting and re-run.` };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("onboarding aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// M16.3: the resume attach as a POST-FILL step (used by both RUN_FILL and the
// walk). The engine reports `nav.uploadWidgetPresent`; here the SW reads the stored
// resume from IndexedDB (I/O the engine can't do) and injects attachResume with the
// bytes passed as STRING args (a File can't cross the boundary — the page rebuilds
// it). On a confirmed attach, the just-built bundle's file_upload entry is patched
// to "filled" so the persisted review summary stays honest. Returns the attach
// result, or null when there's no upload widget on this page.
async function attachResumeForPage(tabId, frameResult) {
  const nav = (frameResult && frameResult.nav) || {};
  if (!nav.uploadWidgetPresent) return null; // page has no resume widget — nothing to do

  let rec;
  try {
    rec = await getResume();
  } catch (e) {
    const r = { attached: false, detail: "IndexedDB read failed: " + String(e) };
    console.log("[ApplyPilot] Resume attach skipped —", r.detail);
    return r;
  }
  if (!rec || !rec.base64) {
    const r = { attached: false, skipped: true, detail: "no resume stored — upload one in the popup first" };
    console.log("[ApplyPilot] Resume attach skipped — no resume stored.");
    return r;
  }

  console.log(`[ApplyPilot] Attaching stored resume: ${rec.filename} (${rec.size} bytes, base64 ${rec.base64.length} chars)`);
  const result = await new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId, frameIds: [0] },
        func: attachResume,
        args: [rec.base64, rec.filename || "resume.pdf", rec.mime || "application/pdf"]
      },
      (results) => {
        if (chrome.runtime.lastError) {
          console.log("[ApplyPilot] attachResume injection error:", chrome.runtime.lastError.message);
          resolve({ attached: false, detail: "injection error: " + chrome.runtime.lastError.message });
          return;
        }
        resolve((results || []).map((r) => r.result).find((r) => r) || { attached: false, detail: "no result" });
      }
    );
  });
  console.log("[ApplyPilot] Resume attach result:", result);

  // Patch the in-memory bundle so the persisted summary reflects the attachment
  // (the engine recorded the upload field as skipped — it can't attach). Only on a
  // confirmed success; a failed/partial attach stays flagged for review.
  if (result.attached && frameResult.bundle && Array.isArray(frameResult.bundle.entries)) {
    const entry = frameResult.bundle.entries.find((e) => e.widget_type === "file_upload");
    if (entry) {
      entry.fill_status = "filled";
      entry.current_value = result.fileName || rec.filename || null;
      entry.needs_review = false;
      entry.needs_review_reason = null;
      entry.detail = "resume attached by the SW (file-upload-successful)";
      // Keep the envelope counts consistent with the patched entry.
      const b = frameResult.bundle;
      b.counts = b.entries.reduce((a, e) => { a[e.fill_status] = (a[e.fill_status] || 0) + 1; return a; }, {});
      b.needs_review_count = b.entries.filter((e) => e.needs_review).length;
    }
  }
  return result;
}

// ============================================================================
// fillEngine — injected into the active tab via chrome.scripting.executeScript.
// Self-contained: it closes over NOTHING from the service worker (it is
// stringified and run in the page), and receives the profile as an argument.
// The profile arrives as `profile` (from storage) instead of a hardcoded const,
// resolved per field through FIELD_MAP + resolve(). `defaults` carries
// application_defaults.json (answer-preference policy, e.g. how_did_you_hear).
// `jobContext` carries per-posting data ({ company } for now) — a SEPARATE storage
// key from profile/defaults, used by the "previously employed here?" matcher.
// ============================================================================
async function fillEngine(profile, defaults, jobContext) {
  // ============================================================
  // 1. Shared helpers (lifted from M6–M8 scratchpads)
  // ============================================================

  // Poll for an element matching `selector`; resolve it or null on timeout.
  const waitFor = async (selector, timeoutMs = 5000, intervalMs = 50) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  };

  // Is `el` actually visible? Workday leaves HIDDEN [role="option"] nodes from OTHER
  // widgets in the DOM (a closed dropdown's options, a multiselect's pre-rendered
  // list), so a page-wide option scrape otherwise captures the wrong widget's options.
  // No offsetParent check — it's null for position:fixed (portaled) popups.
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };

  // TODO(dup): normalize / fuzzyRatio / matchCandidates have SW-side duplicates in
  // lib.js (used by the CDP fill driver + unit tests). The engine can't import
  // (it's stringified into the page), so they are intentional copies — CHANGE IN
  // LOCKSTEP with lib.js (the lib.js copies carry the mirror of this marker).

  // Normalize an option string for matching: lowercase, strip a trailing
  // "(+digits)" suffix, collapse whitespace.
  const normalize = (s) =>
    s.toLowerCase().replace(/\s*\(\+\d+\)\s*$/, "").replace(/\s+/g, " ").trim();

  // Simple Levenshtein-ratio fuzzy match (0-100). Typo tolerance only —
  // used by the match ladder at a >=90 threshold (see CLAUDE.md), never
  // as a loose matcher.
  const fuzzyRatio = (a, b) => {
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (a === b) return 100;
    const m = a.length, n = b.length;
    if (m === 0 || n === 0) return 0;
    const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
    const dist = d[m][n];
    return Math.round((1 - dist / Math.max(m, n)) * 100);
  };

  // Type a string into an input the React-aware way: native setter + input event.
  const setSearchValue = (input, value) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // Three-strategy click ladder: pointer-event sequence, then native el.click(),
  // then a bare synthetic MouseEvent. Returns the strategy used.
  const robustClick = async (el) => {
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
      return { strategy: "pointer-sequence" };
    } catch (e) {
      // fall through
    }
    try {
      el.click();
      return { strategy: "native-click" };
    } catch (e) {
      // fall through
    }
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { strategy: "synthetic-click" };
    } catch (e) {
      return { strategy: "all-failed", error: String(e) };
    }
  };

  // Settle-poll the portaled option list. Comcast typeaheads filter LIVE as you
  // type, so scraping on a fixed delay races the filter. Poll the enabled-option
  // count and accept the list only after two consecutive equal, non-zero reads.
  const settlePoll = async (timeoutMs = 3000, intervalMs = 120) => {
    // VISIBLE + enabled, and EXCLUDING selected-item chip lists
    // ([role="option"] inside [data-automation-id="selectedItemList"] — e.g. source's
    // "LinkedIn" / a phone-code chip), so captured_options is the open typeahead's own
    // results, not cross-widget strays. Also keeps the settle count honest.
    const scrapeOptions = () =>
      Array.from(document.querySelectorAll('[role="option"]'))
        .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true"
          && !el.closest('[data-automation-id="selectedItemList"]'));

    let optionEls = [];
    let prevCount = -1;
    let stableReads = 0;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const current = scrapeOptions();
      if (current.length === prevCount && current.length > 0) {
        stableReads++;
        if (stableReads >= 2) { optionEls = current; break; }
      } else {
        stableReads = 0;
      }
      prevCount = current.length;
      optionEls = current; // keep the latest in case we time out
    }
    return optionEls;
  };

  // Ordered-candidate match ladder (shared by dropdown + typeahead). Candidates
  // are tried most-specific first; NO low-threshold fuzzy — a loose bar silently
  // selects a WRONG value. Returns { targetIndex, matchTier, matchedCandidate };
  // targetIndex === -1 means escalate to needs_review rather than guess.
  // opts.containment (default TRUE) — WIDGET-DEPENDENT (LOCKSTEP with lib.js, 2026-07-16): dropdown/radio
  // pass {containment:false} (a substring match is a GUESS — "PA"→"Armed Forces Pacific" — so they escalate
  // to review instead); typeahead/cert/source keep it ON (typed-partial ⊆ completion is the correct,
  // chip-verified + filled_review-flagged commit signal). Mid-string includes needs a candidate >= 3 chars.
  const matchCandidates = (candidates, optionTexts, opts) => {
    const allowContainment = !opts || opts.containment !== false;
    // Tier 1: exact after normalize() (which strips a trailing "(+N)").
    for (const cand of candidates) {
      const nc = normalize(cand);
      const idx = optionTexts.findIndex((t) => normalize(t) === nc);
      if (idx !== -1) return { targetIndex: idx, matchTier: "exact-normalized", matchedCandidate: cand };
    }
    // Tier 2: containment — startsWith then includes, AMBIGUITY-SAFE (exactly one), skipped for
    // dropdown/radio (opts). Mid-string includes requires >= 3 chars (a 2-char abbrev is too promiscuous).
    if (allowContainment) {
      for (const cand of candidates) {
        const nc = normalize(cand);
        const sw = []; optionTexts.forEach((t, i) => { if (normalize(t).startsWith(nc)) sw.push(i); });
        if (sw.length === 1) return { targetIndex: sw[0], matchTier: "containment", matchedCandidate: cand };
        if (sw.length > 1) continue; // ambiguous prefix → try next (more-specific) candidate, else escalate
        if (nc.length >= 3) {
          const inc = []; optionTexts.forEach((t, i) => { if (normalize(t).includes(nc)) inc.push(i); });
          if (inc.length === 1) return { targetIndex: inc[0], matchTier: "containment", matchedCandidate: cand };
        }
        // 0 or 2+ includes (or a too-short candidate) → not a confident containment match
      }
    }
    // Tier 3: fuzzy >= 90 — TYPO TOLERANCE ONLY.
    let best = -1, bestScore = 0, bestCand = null;
    for (const cand of candidates) {
      const nc = normalize(cand);
      optionTexts.forEach((t, i) => {
        const score = fuzzyRatio(nc, normalize(t));
        if (score > bestScore) { bestScore = score; best = i; bestCand = cand; }
      });
    }
    if (bestScore >= 90) return { targetIndex: best, matchTier: `fuzzy-${bestScore}`, matchedCandidate: bestCand };
    return { targetIndex: -1, matchTier: null, matchedCandidate: null };
  };

  // The field's visible question/label text. Prefer a <legend> (the question for
  // radio/checkbox fieldsets), then the first non-empty <label>, then aria-label.
  // Recorded for every row so unmapped fields self-identify in the table.
  const getLabel = (wrapper) => {
    const legend = wrapper.querySelector("legend");
    if (legend && legend.textContent.trim()) return legend.textContent.trim();
    for (const l of wrapper.querySelectorAll("label")) {
      const t = (l.textContent || "").trim();
      if (t) return t;
    }
    const ariaEl = wrapper.matches("[aria-label]") ? wrapper : wrapper.querySelector("[aria-label]");
    return ariaEl ? ariaEl.getAttribute("aria-label").trim() : null;
  };

  // Required-vs-optional. Workday marks required fields with an
  // <abbr title="required">*</abbr> inside the label/legend (docs/dom-patterns.md);
  // ARIA fallbacks cover other tenants. Drives the required-field review escalation
  // in the bundle, so accuracy matters — verify against known required/optional
  // fields when adding a tenant.
  const isRequired = (wrapper) => {
    // Workday's required marker is an <abbr> holding "*". Comcast uses
    // <abbr title="required">; US Bank uses a bare <abbr aria-hidden="true">*</abbr>
    // (no title/aria-label) — so detect the asterisk CONTENT, not just the title.
    // Without this, US Bank dropdowns (Country*/State*/Phone Device Type*) read false.
    for (const a of wrapper.querySelectorAll("abbr")) {
      const meta = (a.getAttribute("title") || "") + " " + (a.getAttribute("aria-label") || "");
      if (/required/i.test(meta) || (a.textContent || "").includes("*")) return true;
    }
    // ARIA / data signals on the control (text inputs, multiselects).
    if (wrapper.querySelector('[aria-required="true"], [data-required="true"]')) return true;
    if (wrapper.querySelector('[data-automation-id="requiredMarker"]')) return true;
    // Fallback: the visible label/legend text ends with "*" (safe direction — a
    // stray asterisk over-flags into review, never hides a real required field).
    const labelEl = wrapper.querySelector("legend") || wrapper.querySelector("label");
    if (labelEl && /\*\s*$/.test((labelEl.textContent || "").trim())) return true;
    return false;
  };

  // ============================================================
  // 2. Classifier — widget type for a formField-* wrapper.
  // Rules from docs/dom-patterns.md, priority order (first match wins).
  // ============================================================
  const classifyField = (wrapper) => {
    const formFieldId = wrapper.getAttribute("data-automation-id") || "";
    const fieldName = formFieldId.slice("formField-".length);

    // 1. Known hierarchical picker (button+listbox DOM, but drills into
    //    sub-options). Must come first — shares DOM with the dropdown branch.
    if (fieldName === "source") return "hierarchical";
    // 1b. File upload (resume) — a hidden <input type="file">. Early, before the
    //     text branch (which excludes type="file" anyway). The engine does NOT
    //     attach (it can't read IndexedDB); it just reports presence — the SW does
    //     the attach as a post-fill step (see maybeAttachResume).
    if (wrapper.querySelector('input[type="file"]')) return "file_upload";
    // 2. Typeahead — searchable multiselect widget.
    if (wrapper.querySelector('[data-uxi-widget-type="multiselect"]')) return "typeahead";
    // 3. Radio — any radio input descendant.
    if (wrapper.querySelector('input[type="radio"]')) return "radio";
    // 4. Dropdown — single-select button trigger.
    if (wrapper.querySelector('button[aria-haspopup="listbox"]')) return "dropdown";
    // 5. Checkbox — a single checkbox input.
    if (wrapper.querySelectorAll('input[type="checkbox"]').length === 1) return "checkbox";
    // 6. Text — exactly one text-like input.
    const textLike = Array.from(wrapper.querySelectorAll("input")).filter((el) => {
      const t = (el.getAttribute("type") || "").toLowerCase();
      return t === "" || ["text", "email", "tel", "number", "url"].includes(t);
    });
    if (textLike.length === 1) return "text";
    // 7. Unknown.
    return "unknown";
  };

  // ============================================================
  // 3. Handlers — async (wrapper, value, fieldName) → record fragment.
  // `value` is a string for text, an ordered candidate array for choice fields.
  // ============================================================

  // Text — M4/M5. Native setter + input + change so React keeps the value.
  const fillText = async (wrapper, value, fieldName) => {
    const input = wrapper.querySelector("input");
    if (!input) return { status: "error", detail: "no input in wrapper" };
    const before = input.value;
    setSearchValue(input, value); // native setter + input event
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      status: "filled",
      after: input.value,
      verified: input.value === value,
      detail: before ? `overwrote "${before}"` : null
    };
  };

  // Dropdown — M6, with the ordered-candidate match ladder.
  const fillDropdown = async (wrapper, candidates, fieldName) => {
    const trigger = wrapper.querySelector('button[aria-haspopup="listbox"]');
    if (!trigger) return { status: "error", detail: "no listbox trigger" };
    const before = trigger.textContent.trim();

    await robustClick(trigger);

    // Scope the scrape to THIS field's OWN listbox via the trigger's aria-controls
    // (VERIFIED by the M14 trace: ctny0→countries, ctny1→states, ctny2→phone-types —
    // unlike `source`, where aria-controls pointed at the wrong node). The page also
    // carries decoy [role="listbox"][data-automation-id="selectedItemList"] CHIP lists
    // (the source/phone-code selected values "LinkedIn"/"(+1)") AND a prior dropdown's
    // listbox can stay open (State saw country's ctny0) — a page-wide scrape grabs both.
    // Polling for the aria-controls listbox doubles as the open-gate (a bare
    // ul[role="listbox"] wait can match a pre-existing chip list before ours mounts).
    let ownList = null;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const id = trigger.getAttribute("aria-controls");
      const lb = id ? document.getElementById(id) : null;
      if (lb && lb.querySelector('[role="option"]')) { ownList = lb; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    let optionEls;
    if (ownList) {
      optionEls = Array.from(ownList.querySelectorAll('[role="option"]'))
        .filter((el) => el.getAttribute("aria-disabled") !== "true");
    } else {
      // Fallback (no resolvable aria-controls on some tenant): visible options EXCLUDING
      // the selected-item chip lists. Doesn't isolate a sibling dropdown's open listbox,
      // but observed Workday tenants set aria-controls — this just avoids a hard failure.
      if (!(await waitFor('ul[role="listbox"]'))) return { status: "error", detail: "listbox did not open", after: before };
      optionEls = Array.from(document.querySelectorAll('[role="option"]'))
        .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true" && !el.closest('[data-automation-id="selectedItemList"]'));
    }
    const optionTexts = optionEls.map((el) => el.textContent.trim());

    // DROPDOWN = select from a full list → NO containment (a substring is a guess: "PA" must not become
    // "Armed Forces Pacific"). Exact → fuzzy(typo) → escalate. (LOCKSTEP with fillDropdownCdp, 2026-07-16.)
    const { targetIndex, matchTier } = matchCandidates(candidates, optionTexts, { containment: false });
    if (targetIndex === -1) {
      return { status: "needs_review", detail: "no candidate matched", after: before, options: optionTexts };
    }

    await robustClick(optionEls[targetIndex]);
    await new Promise((r) => setTimeout(r, 200));

    const after = trigger.textContent.trim();
    return {
      status: "filled",
      after,
      verified: normalize(after).includes(normalize(optionTexts[targetIndex])),
      matchTier,
      detail: null,
      options: optionTexts
    };
  };

  // Radio — M7. Click the styled <label for=...>, not the hidden input.
  const fillRadio = async (wrapper, candidates, fieldName) => {
    const radios = Array.from(wrapper.querySelectorAll('input[type="radio"]'));
    if (radios.length === 0) return { status: "error", detail: "no radio inputs" };

    const labelFor = (input) => document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
    const options = radios.map((input) => {
      const labelEl = labelFor(input);
      return { input, labelEl, labelText: labelEl ? labelEl.textContent.trim() : "", checked: input.checked };
    });

    const beforeOpt = options.find((o) => o.checked);
    const before = beforeOpt ? beforeOpt.labelText : null;

    // Labels are short and clean — case-insensitive exact, candidates in order.
    let target = null;
    for (const cand of candidates) {
      const found = options.find((o) => o.labelText.toLowerCase() === cand.toLowerCase());
      if (found) { target = found; break; }
    }
    const optionLabels = options.map((o) => o.labelText);
    if (!target) return { status: "needs_review", detail: "no candidate matched radio labels", after: before, options: optionLabels };
    if (!target.labelEl) return { status: "error", detail: "matched radio has no label to click", after: before, options: optionLabels };

    await robustClick(target.labelEl);
    await new Promise((r) => setTimeout(r, 200));

    const checkedNow = radios.find((r) => r.checked);
    const after = checkedNow ? (labelFor(checkedNow) ? labelFor(checkedNow).textContent.trim() : null) : null;
    return {
      status: "filled",
      after,
      verified: !!after && candidates.some((c) => c.toLowerCase() === after.toLowerCase()),
      matchTier: "label-exact",
      detail: null,
      options: optionLabels
    };
  };

  // Typeahead — M8. Open-before-find, clear, type, settle-poll, match, click.
  const fillTypeahead = async (wrapper, candidates, fieldName) => {
    const opener =
      wrapper.querySelector('[data-automation-id="multiselectInputContainer"]') ||
      wrapper.querySelector('[data-uxi-widget-type="selectinput"]') ||
      wrapper.querySelector("input") ||
      wrapper;
    await robustClick(opener);
    if (opener.focus) opener.focus();

    const formFieldId = wrapper.getAttribute("data-automation-id");
    const input = await waitFor(
      '[data-automation-id="' + formFieldId + '"] input[data-automation-id="searchBox"]',
      2000
    );
    if (!input) return { status: "error", detail: "search input not found after opening" };

    // Type candidates as search terms IN ORDER until the filter yields options — a
    // too-specific first term (e.g. one with a "(+1)" suffix the tenant's search may
    // not index, since it's display text) must not dead-end. Then match ALL candidates
    // against whichever filtered set appears. When the first term yields results
    // (the common case), this breaks immediately — identical to the prior behavior.
    let optionEls = [];
    for (const term of candidates) {
      input.focus();
      setSearchValue(input, "");
      await new Promise((r) => setTimeout(r, 80));
      setSearchValue(input, term);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      optionEls = await settlePoll();
      if (optionEls.length) break;
    }
    if (!optionEls.length) return { status: "needs_review", detail: "no options appeared after typing", after: null };
    const optionTexts = optionEls.map((el) => el.textContent.trim());

    // DIRECTED typeahead pick (we choose from the filtered list) → NO containment (a substring pick is a
    // guess); exact/typo only, else escalate → AI rescue for required. (LOCKSTEP with fillTypeaheadCdp.)
    const { targetIndex, matchTier } = matchCandidates(candidates, optionTexts, { containment: false });
    if (targetIndex === -1) {
      // captured_options is the LIVE-FILTERED set the search surfaced (what the match
      // was made against) — not the full underlying list. No cap needed; it's small.
      return { status: "needs_review", detail: "no candidate matched", after: null, captured_options: optionTexts };
    }

    await robustClick(optionEls[targetIndex]);
    await new Promise((r) => setTimeout(r, 150));

    // Best-effort close on a neutral, non-label target. Cosmetic only.
    const neutral = document.querySelector('[data-automation-id="applyFlowMyInfoPage"]') || document.body;
    if (neutral) await robustClick(neutral);

    const selectedItem = wrapper.querySelector('[data-automation-id="selectedItem"]');
    const after = (selectedItem && selectedItem.textContent.trim()) || input.value || optionTexts[targetIndex];
    return {
      status: "filled",
      after,
      verified: !!after && normalize(after).includes(normalize(optionTexts[targetIndex])),
      matchTier,
      detail: null,
      captured_options: optionTexts
    };
  };

  // Source — hierarchical "How Did You Hear About Us" picker. Its DOM is
  // under-characterized (docs conflict: searchBox/multiselect vs button+listbox),
  // so this handler is DISCOVER-AND-TRACE: it attempts the fill AND dumps the
  // opened structure (sourceTrace) with STABLE per-row identifiers (automation-id
  // / id / data-*), so the real handler can be finalized next round if needed.
  // `candidates` is the ordered list [...preferred, fallback]; first leaf match wins.
  const fillSource = async (wrapper, candidates, fieldName) => {
    const formFieldId = wrapper.getAttribute("data-automation-id");

    // Union opener — covers both documented shapes.
    const opener =
      wrapper.querySelector('button[aria-haspopup="listbox"]') ||
      wrapper.querySelector('[data-automation-id="multiselectInputContainer"]') ||
      wrapper.querySelector('[data-uxi-widget-type="selectinput"]') ||
      wrapper.querySelector("input") ||
      wrapper;
    const openerDesc = opener.tagName + (opener.getAttribute("data-automation-id") ? `[${opener.getAttribute("data-automation-id")}]` : "");
    await robustClick(opener);
    if (opener.focus) opener.focus();
    await new Promise((r) => setTimeout(r, 200));

    // A row is a CATEGORY (expandable) vs a LEAF (selectable).
    const isCategory = (el) =>
      el.hasAttribute("aria-expanded") ||
      el.hasAttribute("aria-haspopup") ||
      !!el.querySelector('svg, [data-automation-id*="chevron" i], [class*="chevron" i]') ||
      (el.getAttribute("role") === "treeitem" && el.hasAttribute("aria-level"));

    // Rows render portaled at the document root; include option + treeitem.
    const scrapeRows = () =>
      Array.from(document.querySelectorAll('[role="option"], [role="treeitem"]'))
        .filter((el) => el.getAttribute("aria-disabled") !== "true");

    // ── Source result leaves: [data-automation-id="promptOption"] ──────────
    // VERIFIED on US Bank (manual DOM inspection): the clickable result leaf is a
    //   <div data-automation-id="promptOption" data-automation-label="LinkedIn">.
    // It is NOT role="option" (that role sits on a sibling menuItem div), and the
    // searchBox's aria-controls points at a promptAriaInstruction node — which is why
    // every earlier selector missed. Workday also leaves HIDDEN promptOption nodes
    // from other widgets in the DOM, so we filter to VISIBLE (shared isVisible helper);
    // during the single-pass fill only THIS field's popup is open, so the visible
    // promptOptions are ours.
    // Match against the clean data-automation-label attribute, then textContent.
    const leafLabel = (el) =>
      el.getAttribute("data-automation-label") || (el.textContent || "").trim();
    const scrapeLeaves = () =>
      Array.from(document.querySelectorAll('[data-automation-id="promptOption"]'))
        .filter((el) => isVisible(el) && el.getAttribute("aria-disabled") !== "true");
    const leavesSig = (els) => els.map(leafLabel).join("|");

    // Commit signal: the leaf sits inside a multiselectlistitem wrapper whose
    // selected-state attribute flips on a successful click (more reliable here than a
    // chip). Re-query the leaf fresh after the click (the row may re-render), read its
    // wrapper's selected-state, then fall back to a selectedItem chip / companion input.
    const selectedWrapperOf = (el) =>
      el && el.closest('[data-uxi-multiselectlistitem-isselected],[data-automation-id*="multiselectlistitem" i],[data-automation-id*="promptLeafNode" i]');
    const didCommit = (label) => {
      const fresh = scrapeLeaves().find((el) => normalize(leafLabel(el)) === normalize(label));
      const row = selectedWrapperOf(fresh || null);
      if (row) {
        if (row.getAttribute("data-uxi-multiselectlistitem-isselected") === "true") return true;
        if (row.getAttribute("data-automation-selected") === "true") return true;
        if (row.getAttribute("aria-selected") === "true") return true;
      }
      if (wrapper.querySelector('[data-automation-id="selectedItem"]')) return true;
      const companion = wrapper.querySelector('input:not([data-automation-id="searchBox"])');
      return !!(companion && String(companion.value || "").trim());
    };

    const searchInput = await waitFor(
      '[data-automation-id="' + formFieldId + '"] input[data-automation-id="searchBox"]',
      800
    );
    await waitFor('[role="option"], [role="treeitem"], [data-automation-id="promptOption"]', 1500);

    // Lightweight trace (retained for diagnostics on new tenants).
    const sourceTrace = {
      opener: openerDesc,
      searchBox: !!searchInput,
      leafSelector: '[data-automation-id="promptOption"]',
      level1: scrapeLeaves().slice(0, 25).map((el) => ({
        automationId: el.getAttribute("data-automation-id") || null,
        label: el.getAttribute("data-automation-label") || null,
        text: (el.textContent || "").trim().slice(0, 40)
      }))
    };

    // Attempt selection, candidates in priority order; first match that COMMITS wins.
    let picked = null, matchTier = null;
    let committed = false, selectionDetail = null;
    const pathTaken = searchInput ? "search" : "expand-walk";

    if (searchInput) {
      // These embedded dropdowns filter on ENTER, not live. After typing, press Enter
      // (full key sequence), then WAIT — race-safely — for the promptOption results to
      // render: require the visible-leaf set to CHANGE from the pre-Enter baseline AND
      // then hold steady (so we never read the stale pre-filter list). A candidate
      // whose results render with NO label match terminates fast (no timeout burn).
      const pressEnter = () => {
        for (const t of ["keydown", "keypress", "keyup"]) {
          searchInput.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
      };
      // Robust against PARTIAL renders: a single row flashing in must NOT read as the
      // final set. Require the leaf set to (a) CHANGE from the pre-Enter baseline, then
      // (b) hold at a STABLE COUNT across several consecutive reads AND for a minimum
      // settle window. Adaptive (fast renders still settle quickly) — not a blind sleep.
      const waitForResults = async (baselineSig, timeoutMs = 3000, intervalMs = 100) => {
        const STABLE_READS = 4, MIN_SETTLE_MS = 500;
        let els = scrapeLeaves(), prevCount = -1, stable = 0, changed = false, changedAt = 0;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          await new Promise((r) => setTimeout(r, intervalMs));
          els = scrapeLeaves();
          const sig = leavesSig(els);
          if (!changed && sig !== baselineSig) { changed = true; changedAt = Date.now(); }
          if (changed && els.length === prevCount) {
            stable++;
            if (stable >= STABLE_READS && (Date.now() - changedAt) >= MIN_SETTLE_MS) break;
          } else {
            stable = 0;
          }
          prevCount = els.length;
        }
        return els;
      };

      for (const cand of candidates) {
        searchInput.focus();
        setSearchValue(searchInput, "");
        await new Promise((r) => setTimeout(r, 100));
        const baselineSig = leavesSig(scrapeLeaves()); // pre-Enter list (no live filtering)
        setSearchValue(searchInput, cand);
        pressEnter();
        const leaves = await waitForResults(baselineSig);

        // Match via the shared ladder against data-automation-label, then textContent. DIRECTED source
        // pick → NO containment (a substring pick is a guess); exact/typo only, else escalate → AI rescue.
        const labels = leaves.map(leafLabel);
        let m = matchCandidates([cand], labels, { containment: false });
        if (m.targetIndex === -1) {
          const texts = leaves.map((el) => (el.textContent || "").trim());
          m = matchCandidates([cand], texts, { containment: false });
        }
        if (m.targetIndex === -1) continue; // no results / no match → next (fast)

        // Two identical "LinkedIn" leaves appear interchangeable — matchCandidates
        // returns the first, which is what we click.
        const target = leaves[m.targetIndex];
        const label = leafLabel(target);
        await robustClick(target);
        await new Promise((r) => setTimeout(r, 300));

        if (didCommit(label)) {
          picked = label; matchTier = m.matchTier; committed = true; break;
        }
        // The option existed and matched, but the click did NOT commit. Do not fall
        // through to a less-preferred option (that would silently pick a worse value
        // because of OUR failure) — surface it for review instead.
        picked = label; matchTier = m.matchTier; committed = false;
        selectionDetail = `matched "${label}" but the click did not commit (selected-state did not flip)`;
        break;
      }
    } else {
      for (const cand of candidates) {
        // Level-1 leaf? DIRECTED pick → NO containment (exact/typo only, else escalate → AI rescue).
        const l1leaves = scrapeRows().filter((el) => !isCategory(el));
        const l1texts = l1leaves.map((el) => el.textContent.trim());
        const m = matchCandidates([cand], l1texts, { containment: false });
        if (m.targetIndex !== -1) {
          await robustClick(l1leaves[m.targetIndex]);
          picked = l1texts[m.targetIndex]; matchTier = m.matchTier; break;
        }
        // Else expand each category and scan revealed sub-options.
        let found = false;
        for (const catEl of scrapeRows().filter(isCategory)) {
          await robustClick(catEl);
          await waitFor('[role="option"], [role="treeitem"]', 1000);
          await new Promise((r) => setTimeout(r, 150));
          const sub = scrapeRows().filter((el) => !isCategory(el));
          const subTexts = sub.map((el) => el.textContent.trim());
          const sm = matchCandidates([cand], subTexts, { containment: false });
          if (sm.targetIndex !== -1) {
            await robustClick(sub[sm.targetIndex]);
            picked = subTexts[sm.targetIndex]; matchTier = sm.matchTier; found = true; break;
          }
        }
        if (found) break;
      }
    }

    await new Promise((r) => setTimeout(r, 200));

    // The visible level-1 leaves the picker exposed, for review.
    const sourceOptions = sourceTrace.level1.map((r) => r.label || r.text).filter(Boolean);
    const chip = wrapper.querySelector('[data-automation-id="selectedItem"]');
    const trigger = wrapper.querySelector('button[aria-haspopup="listbox"]');
    const shownText = (chip && chip.textContent.trim()) || (trigger && trigger.textContent.trim()) || null;

    if (pathTaken === "search") {
      // Commit-gated: only report "filled" when the click actually committed. A match
      // that didn't commit is surfaced for review, NOT reported as a false "filled".
      if (!picked) {
        return { status: "needs_review", detail: "no preferred option matched (results rendered, no label match)", matchTier: null, sourcePath: pathTaken, sourceTrace, options: sourceOptions };
      }
      if (!committed) {
        return { status: "needs_review", detail: selectionDetail || `matched "${picked}" but selection did not commit`, matchTier, after: shownText, sourcePath: pathTaken, sourceTrace, options: sourceOptions };
      }
      return { status: "filled", after: shownText || picked, verified: true, matchTier, sourcePath: pathTaken, sourceTrace, options: sourceOptions };
    }

    // Expand-walk path (Cambium) — behavior unchanged from M11.
    if (!picked) {
      return { status: "needs_review", detail: "no preferred option or Other found", matchTier: null, sourcePath: pathTaken, sourceTrace, options: sourceOptions };
    }
    const after = shownText || picked;
    return {
      status: "filled",
      after,
      verified: !!after && normalize(after).includes(normalize(picked)),
      matchTier,
      sourcePath: pathTaken,
      sourceTrace,
      options: sourceOptions
    };
  };

  // ============================================================
  // 4. Mapping + resolution (the per-field mapping→resolution→fill chain)
  // FIELD_MAP is structural only (Workday fieldName → canonical profile path),
  // never values — the values live in `profile` (from storage). resolve()
  // coerces the raw profile value into what each widget's handler expects.
  // ============================================================
  const FIELD_MAP = {
    "legalName--firstName": "personal_info.first_name",
    "legalName--lastName": "personal_info.last_name",
    "preferredCheck": "personal_info.has_preferred_name", // "I have a preferred name" checkbox — true CHECKS it (reveals the preferred first/last fields, a cascade)
    "preferredName--firstName": "personal_info.preferred_first_name", // revealed by preferredCheck; cascade re-scan fills it
    "preferredName--lastName": "personal_info.preferred_last_name",   // revealed by preferredCheck
    "addressLine1": "personal_info.address_line_1",
    "city": "personal_info.city",
    "postalCode": "personal_info.postal_code",
    "phoneNumber": "personal_info.phone_number",
    "extension": "personal_info.phone_extension",
    "country": "personal_info.country",
    "countryRegion": "personal_info.state_province",
    "phoneType": "personal_info.phone_device_type",
    "countryPhoneCode": "personal_info.country_phone_code"
    // "candidateIsPreviousWorker" — NOT mapped here; answered by the safety-first
    //   employer-match special case in the driver (jobContext.company vs
    //   profile.employment_history_companies). The old previously_worked_for_company
    //   boolean is now vestigial.
    // "source" — hierarchical, needs_review (no mapping)
    // "preferredCheck", "regionSubdivision1" — unmapped → skipped
  };

  const getByPath = (obj, path) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const isEmpty = (v) =>
    v === undefined || v === null || (typeof v === "string" && v.trim() === "");

  // Coerce the raw profile value to what the classified widget needs.
  // Returns { value } (text), { candidates } (choice/radio), or { skip:true }.
  const resolve = (raw, widgetType) => {
    if (widgetType === "text") {
      if (isEmpty(raw)) return { skip: true };
      return { value: String(raw) };
    }
    if (widgetType === "dropdown" || widgetType === "typeahead") {
      // The profile may supply a TIERED candidate list (most-specific first) so the
      // exact rendered option text matches at high confidence (e.g. country_phone_code
      // → ["United States of America (+1)", ...]); a single value is wrapped as before.
      // Array.isArray is checked first (isEmpty only understands null/undefined/"").
      if (Array.isArray(raw)) {
        const candidates = raw.map((v) => String(v)).filter((s) => s.trim() !== "");
        return candidates.length ? { candidates } : { skip: true };
      }
      if (isEmpty(raw)) return { skip: true };
      return { candidates: [String(raw)] };
    }
    if (widgetType === "radio") {
      if (raw === null || raw === undefined) return { skip: true };
      if (typeof raw === "boolean") return { candidates: [raw ? "Yes" : "No"] };
      if (isEmpty(raw)) return { skip: true };
      return { candidates: [String(raw)] };
    }
    return { skip: true, reason: `unsupported widget type "${widgetType}"` };
  };

  // ── "Previously employed here?" — company matcher (fill + review-queue) ─────
  // ALWAYS fills a value so the page can advance, and flags uncertain answers for a
  // mandatory end-of-form human review (the queue is load-bearing — a skipped review can
  // leave a wrong answer on a legal/certification field):
  //   named in question → fill "Yes", REVIEW  (the question text lists who counts —
  //                         affiliates/subsidiaries/predecessors the bare company name
  //                         misses — so a KNOWN employer appearing there means likely Yes)
  //   exact company     → fill "Yes", REVIEW
  //   partial overlap   → fill "No",  REVIEW   (name overlap may be the same employer)
  //   clean miss        → fill "No",  no review (confident non-membership)
  //   cannot evaluate   → BLANK,      REVIEW   (no company AND nothing of ours named)
  // "Yes" is never asserted without a review flag (it sits beside a truthfulness cert and
  // unfurls follow-up fields), and the detail names which employer matched + how, so the
  // reviewer knows exactly what to verify. The question scan searches for the USER's known
  // employers in the question text — it does NOT try to extract company names from prose.
  const COMPANY_STOP = new Set(["inc","incorporated","llc","ltd","limited","corp","corporation","co","company","plc","gmbh","sa","ag","group","holdings","the","and","of"]);
  const companyTight = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const companyTokens = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
      .filter((t) => t.length >= 2 && !COMPANY_STOP.has(t));
  // Common standalone business words that survive COMPANY_STOP but must NOT match the
  // question alone — a lone generic word in the employer list shouldn't suggest "Yes".
  const GENERIC_SINGLE = new Set(["bank","tech","global","systems","solutions","services","capital","financial","national","health","media","digital","consulting","ventures","labs","online","store","center"]);
  // Does the ordered token list `needle` appear as a CONTIGUOUS run inside `hay`?
  const containsSeq = (hay, needle) => {
    if (!needle.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  };
  // Distinctive enough to scan free-text prose for: a multi-word name (distinctive as a
  // sequence), or a lone word that is long AND non-generic. Guards against short/common
  // employer entries coincidentally matching question boilerplate.
  const distinctiveForQuestion = (eTokens) =>
    eTokens.length >= 2 || (eTokens.length === 1 && eTokens[0].length >= 5 && !GENERIC_SINGLE.has(eTokens[0]));

  // Returns { fill: "No"|"Yes"|null, review: bool, likelyYes?: bool, detail }.
  // fill === null → cannot evaluate → leave blank (needs_review, unfilled).
  const decidePreviousWorker = (company, questionText, employers) => {
    if (!Array.isArray(employers)) return { fill: null, review: true, detail: "employment_history_companies not configured — left blank" };
    // Explicit no-employers sentinel: exactly ["none"] → confident "No".
    if (employers.length === 1 && String(employers[0]).trim().toLowerCase() === "none") {
      return { fill: "No", review: false, detail: 'explicit no-employers sentinel (["none"]) → No' };
    }
    // [] is the example-profile default = UNFILLED, not "no employers" → blank/review.
    if (employers.length === 0) {
      return { fill: null, review: true, detail: 'no employers configured ([]) — left blank; add employers or set ["none"]' };
    }
    const co = (company || "").trim();
    const tightC = companyTight(co);
    const tokensC = new Set(companyTokens(co));
    const qTokens = companyTokens(questionText || "");

    const yesHits = [];     // exact company match OR known employer named in the question
    const overlapHits = []; // partial overlap with the application company → "No" + review
    for (const e of employers) {
      const es = String(e).trim();
      if (!es) continue;
      const tightE = companyTight(es);
      if (!tightE) continue;
      const eTokens = companyTokens(es);
      if (tightC && tightC === tightE) { yesHits.push(`"${es}" (matches the company you're applying to)`); continue; }
      if (distinctiveForQuestion(eTokens) && containsSeq(qTokens, eTokens)) { yesHits.push(`"${es}" (named in the question text)`); continue; }
      // Partial overlap with the application company only (NOT the question — too loose for prose).
      let why = null;
      if (tightC && (tightC.includes(tightE) || tightE.includes(tightC))) why = "substring";
      else if (tightC && eTokens.some((t) => tokensC.has(t))) why = "shared word";
      if (why) overlapHits.push(`${es} (${why})`);
    }

    // Exact company OR named-in-question → consistent answer is "Yes"; flag for review.
    if (yesHits.length) {
      const corroborate = tightC ? "" : " — no application company was set to corroborate; verify carefully";
      return { fill: "Yes", review: true, likelyYes: true, detail: `Filled "Yes" — matched known employer ${yesHits.join("; ")}. Confirm you actually worked there before submitting (a wrong "Yes" is a false statement on a certification)${corroborate}.` };
    }
    // Partial → lean "No" (partial name overlap is often coincidental) but flag review.
    if (overlapHits.length) {
      return { fill: "No", review: true, detail: `company "${co}" partially overlaps known employer(s): ${overlapHits.join(", ")} → filled "No"; REVIEW (could be the same employer)` };
    }
    // Company was set but nothing matched it or appeared in the question → confident "No".
    if (tightC) {
      return { fill: "No", review: false, detail: `no known employer matches the company "${co}" or appears in the question → No (clean miss vs ${employers.length} known employer(s))` };
    }
    // No company AND nothing of ours named in the question → cannot responsibly evaluate.
    return { fill: null, review: true, detail: "no company set for this application and no known employer named in the question — left blank" };
  };

  // ── Repeating sections (Work Experience M17/M18 · Education M19) ────────────
  // Entries are <div data-fkit-id="<section>-N--null"> mounted INLINE; their formField-*
  // ids are DUPLICATED across entries — so every field access MUST scope to the entry
  // container (a document-wide query only ever finds entry 1). `fillRepeatingSection`
  // (below) clicks Add to mount ≥N entries, then fills each via a section-specific
  // per-entry filler. The SW pre-prepares the arrays (meaningful-only + parsed). Idempotency
  // = add-only. Deferred: delete-extras (entries > N).
  const WORK_EXPERIENCE_CONTAINER_PREFIX = "workExperience-";
  const WORK_EXPERIENCE_MAP = { jobTitle: "job_title", companyName: "company", location: "location" };

  // Workday date composite: a dateInputWrapper with role="spinbutton" <input>s. WE From/To
  // are month+year (dateSectionMonth-input 1-12 + dateSectionYear-input); Education From/To
  // are YEAR-ONLY (dateSectionYear-input alone); Certifications' Issued/Expiration are full
  // M/D/Y (+ dateSectionDay-input). `month`/`year`/`day` arrive ALREADY PARSED from the SW
  // (parseYearMonth / parseYear / parseYearMonthDay), so this only sets the DOM. Pass
  // `month = null` for year-only and omit `day` for month+year. Each PRESENT segment is
  // driven the proven React way (native setter + input + change, via setSearchValue).
  const fillDateComposite = async (wrapper, month, year, day) => {
    const monthInput = month != null ? wrapper.querySelector('[data-automation-id="dateSectionMonth-input"]') : null;
    const dayInput = day != null ? wrapper.querySelector('[data-automation-id="dateSectionDay-input"]') : null;
    const yearInput = wrapper.querySelector('[data-automation-id="dateSectionYear-input"]');
    if (!yearInput || (month != null && !monthInput) || (day != null && !dayInput)) return { status: "error", detail: "date spinbutton input not found" };
    const setSeg = (input, val) => {
      if (input.focus) input.focus();
      setSearchValue(input, val); // native setter + input event (React-aware)
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if (monthInput) { setSeg(monthInput, month); await new Promise((r) => setTimeout(r, 80)); }
    if (dayInput) { setSeg(dayInput, day); await new Promise((r) => setTimeout(r, 80)); }
    setSeg(yearInput, year);
    await new Promise((r) => setTimeout(r, 120));
    const monthOk = !monthInput || parseInt(monthInput.value, 10) === parseInt(month, 10);
    const dayOk = !dayInput || parseInt(dayInput.value, 10) === parseInt(day, 10);
    const yearOk = parseInt(yearInput.value, 10) === parseInt(year, 10);
    const after = (monthInput ? (monthInput.value || "MM") + "/" : "") + (dayInput ? (dayInput.value || "DD") + "/" : "") + (yearInput.value || "YYYY");
    return { status: "filled", after, verified: monthOk && dayOk && yearOk };
  };

  // Fill ONE work-experience entry: the container `entryArg`, the SW-prepared profile
  // entry `we`, its index `idx`, and `entrySel` (this section's entry-container selector,
  // passed by fillRepeatingSection — used for the per-entry re-resolves). Order: reconcile
  // currentlyWorkHere → text → dates → role description. All field access is SCOPED to the
  // entry (duplicate formField-* ids across entries).
  const fillWorkExperienceEntry = async (entryArg, we, idx, entrySel) => {
    const recs = [];
    const prefix = "workExperience[" + idx + "].";
    let entry = entryArg;

    // Reconcile "I currently work here" FIRST — it controls whether the To box exists.
    // Toggle the styled <label for> (label-activation fires React's change), verify .checked.
    const desiredCWH = we.currently_work_here === true;
    {
      const cwhWrap = entry.querySelector('[data-automation-id="formField-currentlyWorkHere"]');
      const cb = cwhWrap && cwhWrap.querySelector('input[type="checkbox"]');
      const rec = { fieldName: prefix + "currentlyWorkHere", label: cwhWrap ? getLabel(cwhWrap) : null,
        widgetType: "checkbox", isRequired: cwhWrap ? isRequired(cwhWrap) : false,
        mappedPath: prefix + "currently_work_here", status: null, after: null, detail: null, verified: null };
      if (!cb) {
        rec.status = "skipped"; rec.detail = "no currentlyWorkHere checkbox in entry";
      } else if (cb.checked === desiredCWH) {
        rec.status = "filled"; rec.after = String(cb.checked); rec.verified = true;
        rec.detail = "already " + (desiredCWH ? "checked" : "unchecked");
      } else {
        const label = cb.id ? document.querySelector('label[for="' + CSS.escape(cb.id) + '"]') : null;
        await robustClick(label || cb);
        await new Promise((r) => setTimeout(r, 250));
        rec.verified = cb.checked === desiredCWH;
        rec.status = rec.verified ? "filled" : "needs_review";
        rec.after = String(cb.checked);
        rec.detail = rec.verified ? ("set to " + (desiredCWH ? "checked" : "unchecked")) : "toggle did not take";
      }
      recs.push(rec);
    }
    // After unchecking, THIS entry's To box remounts — wait for it (scoped to entry idx),
    // then re-resolve the entry (toggling may re-render the subtree).
    if (!desiredCWH) {
      const start = Date.now();
      while (Date.now() - start < 2000) {
        const e = Array.from(document.querySelectorAll(entrySel))[idx];
        if (e && e.querySelector('[data-automation-id="formField-endDate"]')) break;
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    entry = Array.from(document.querySelectorAll(entrySel))[idx] || entry;

    // Text subset, scoped to the entry container.
    for (const [fieldName, profKey] of Object.entries(WORK_EXPERIENCE_MAP)) {
      const wrapper = entry.querySelector('[data-automation-id="formField-' + fieldName + '"]');
      const rec = { fieldName: prefix + fieldName, label: wrapper ? getLabel(wrapper) : null,
        widgetType: "text", isRequired: wrapper ? isRequired(wrapper) : false,
        mappedPath: prefix + profKey, status: null, after: null, detail: null, verified: null };
      const value = we[profKey];
      if (!wrapper) { rec.status = "error"; rec.detail = "field wrapper not found in entry"; recs.push(rec); continue; }
      if (value === undefined || value === null || String(value).trim() === "") {
        rec.status = "skipped"; rec.detail = "empty value at " + prefix + profKey; recs.push(rec); continue;
      }
      const hr = await fillText(wrapper, String(value), fieldName);
      Object.assign(rec, hr);
      recs.push(rec);
      await new Promise((r) => setTimeout(r, 120));
    }

    // Dates (From/To): MM/YYYY composites; segments parsed SW-side (we.fromParsed/toParsed).
    const fillEntryDate = async (fieldName, parsed, profKey) => {
      const wrapper = entry.querySelector('[data-automation-id="formField-' + fieldName + '"]');
      const rec = { fieldName: prefix + fieldName, label: wrapper ? getLabel(wrapper) : null,
        widgetType: "date", isRequired: wrapper ? isRequired(wrapper) : false,
        mappedPath: prefix + profKey, status: null, after: null, detail: null, verified: null };
      if (!wrapper) { rec.status = "skipped"; rec.detail = "date field not present (e.g. To removed by 'I currently work here')"; recs.push(rec); return; }
      if (!parsed) { rec.status = "skipped"; rec.detail = "no valid YYYY-MM at " + prefix + profKey; recs.push(rec); return; }
      const r = await fillDateComposite(wrapper, parsed.month, parsed.year);
      Object.assign(rec, r);
      recs.push(rec);
      await new Promise((r2) => setTimeout(r2, 120));
    };
    await fillEntryDate("startDate", we.fromParsed, "from");
    if (desiredCWH) {
      recs.push({ fieldName: prefix + "endDate", label: "To", widgetType: "date",
        isRequired: false, mappedPath: prefix + "to", status: "skipped",
        detail: "currently_work_here = true → no end date (To box removed)" });
    } else {
      await fillEntryDate("endDate", we.toParsed, "to");
    }

    // Role Description — a plain <textarea> (no automation-id on it, so scope via the
    // formField-roleDescription wrapper). Value = bullets joined (we.bulletsText, from
    // the SW). A <textarea> needs the HTMLTextAreaElement native setter — setSearchValue
    // is input-only — to update React's value the same (native setter + input + change).
    {
      const wrapper = entry.querySelector('[data-automation-id="formField-roleDescription"]');
      const ta = wrapper && wrapper.querySelector("textarea");
      const rec = { fieldName: prefix + "roleDescription", label: wrapper ? getLabel(wrapper) : null,
        widgetType: "textarea", isRequired: wrapper ? isRequired(wrapper) : false,
        mappedPath: prefix + "bullets", status: null, after: null, detail: null, verified: null };
      const value = we.bulletsText || "";
      if (!ta) {
        rec.status = "skipped"; rec.detail = "no roleDescription textarea in entry";
      } else if (!value) {
        rec.status = "skipped"; rec.detail = "no bullets to fill";
      } else {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        if (ta.focus) ta.focus();
        setter.call(ta, value);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        rec.status = "filled"; rec.after = ta.value; rec.verified = ta.value === value;
      }
      recs.push(rec);
      await new Promise((r) => setTimeout(r, 120));
    }

    return recs;
  };

  // Locate a repeating section's add-button. The add-button id is SHARED across sections,
  // so anchor on the section heading: climb from a heading matching `headingRegex` to the
  // nearest ancestor that holds an add-button. (Text is "Add" to create the first entry,
  // "Add Another" once ≥1 exists — both share the id.)
  const findSectionAdd = (headingRegex) => {
    const headings = Array.from(document.querySelectorAll('h2,h3,h4,[role="heading"]'))
      .filter((h) => headingRegex.test(h.textContent || ""));
    for (const h of headings) {
      let p = h;
      for (let i = 0; i < 8 && p; i++) {
        p = p.parentElement;
        if (!p) break;
        const btn = p.querySelector('[data-automation-id="add-button"]');
        if (btn) return btn;
      }
    }
    return null;
  };

  // The per-entry Delete button is a <button>Delete</button> with NO automation-id, in the
  // entry's panel header OUTSIDE the --null container (recon 2026-06-08). Climb from the
  // entry container to the nearest ancestor holding a button whose text is "Delete". (The
  // in-container `selectedItem`/`DELETE_charm` are field-value chip-clears — not this.)
  const deleteEntryButton = (entryContainer) => {
    let p = entryContainer;
    for (let i = 0; i < 6 && p; i++) {
      p = p.parentElement;
      if (!p) break;
      const btn = Array.from(p.querySelectorAll("button")).find((b) => (b.textContent || "").trim().toLowerCase() === "delete");
      if (btn) return btn;
    }
    return null;
  };

  // Generic repeating-section filler (M18 WE machinery, generalized for M19 Education).
  // `items` is the SW-prepared list (meaningful-only) for this section; ensure the form has
  // ≥ items.length entry containers (clicking Add — create-first OR "Add Another"), then
  // fill each via `fillEntry(entry, item, idx, entrySel)`. Entry containers are the `--null`
  // ones (sub-field wrappers like the date composites share the prefix → the bare prefix
  // over-matches). Idempotency = add-only (re-run with ≥N entries adds none).
  const fillRepeatingSection = async ({ name, headingRegex, containerPrefix, items, fillEntry, deleteOnNoMatch }) => {
    const recs = [];
    const entrySel = '[data-fkit-id^="' + containerPrefix + '"][data-fkit-id$="--null"]';
    const N = items.length;
    let entries = Array.from(document.querySelectorAll(entrySel));

    // reconcile UP — add to reach N (create-first OR "Add Another")
    if (entries.length < N) {
      let adds = 0;
      while (entries.length < N && adds < N) {
        const btn = findSectionAdd(headingRegex);
        if (!btn) break;
        const before = entries.length;
        await robustClick(btn);
        const start = Date.now();
        while (Date.now() - start < 4000 && Array.from(document.querySelectorAll(entrySel)).length <= before) {
          await new Promise((r) => setTimeout(r, 150));
        }
        entries = Array.from(document.querySelectorAll(entrySel));
        if (entries.length <= before) break; // mount didn't register — stop, don't spin
        adds++;
        await new Promise((r) => setTimeout(r, 200)); // settle before the next add
      }
      recs.push({ fieldName: name + ".add", label: name + " — Add entries", widgetType: "section",
        isRequired: false, mappedPath: null,
        status: entries.length >= N ? "filled" : "needs_review",
        detail: "added " + adds + " entry(ies); " + entries.length + "/" + N + " present" });
    }

    // reconcile DOWN (M21) — delete trailing entries beyond N via the per-entry Delete
    // button, so the form matches the profile exactly (true idempotency). Works for N===0
    // too (clean up phantom/manual entries); stops cleanly if an entry can't be deleted
    // (e.g. WE entry 1 has no Delete) or the count doesn't drop (a confirm intercepts).
    if (entries.length > N) {
      let deleted = 0;
      const MAX_DELETES = 10;
      while (entries.length > N && deleted < MAX_DELETES) {
        const btn = deleteEntryButton(entries[entries.length - 1]);
        if (!btn) break;
        const before = entries.length;
        await robustClick(btn);
        const start = Date.now();
        while (Date.now() - start < 4000 && Array.from(document.querySelectorAll(entrySel)).length >= before) {
          await new Promise((r) => setTimeout(r, 150));
        }
        entries = Array.from(document.querySelectorAll(entrySel));
        if (entries.length >= before) break; // didn't drop — stop, don't spin
        deleted++;
        await new Promise((r) => setTimeout(r, 200));
      }
      recs.push({ fieldName: name + ".delete", label: name + " — delete extras", widgetType: "section",
        isRequired: false, mappedPath: null,
        status: entries.length <= N ? "filled" : "needs_review",
        detail: "deleted " + deleted + " extra(s); " + entries.length + "/" + N + " entries" });
    }

    if (N === 0) {
      recs.push({ fieldName: name, label: name, widgetType: "section", isRequired: false,
        mappedPath: name, status: "skipped", detail: "no meaningful " + name + " entries to fill" });
      return recs;
    }

    // Fill each entry; track whether all its REQUIRED fields filled (for delete-on-no-match).
    const fillCount = Math.min(N, Array.from(document.querySelectorAll(entrySel)).length);
    const perEntry = [];
    for (let i = 0; i < fillCount; i++) {
      const cur = Array.from(document.querySelectorAll(entrySel))[i];
      if (!cur) break;
      const entryRecs = await fillEntry(cur, items[i], i, entrySel);
      const ok = entryRecs.every((r) => !r.isRequired || r.status === "filled");
      perEntry.push({ idx: i, recs: entryRecs, ok });
    }

    // delete-on-no-match (M22) — optional pick-sections (Languages/Certs): an entry whose
    // REQUIRED pick(s) didn't match an option would leave a required field empty and block
    // Next, so delete it. Sweep high→low so lower indices stay valid; replace its recs with
    // a removed-note. (Default off → WE/Education/Websites flag for review, never delete.)
    if (deleteOnNoMatch) {
      for (let k = perEntry.length - 1; k >= 0; k--) {
        if (perEntry[k].ok) continue;
        const cur = Array.from(document.querySelectorAll(entrySel))[perEntry[k].idx];
        const btn = cur && deleteEntryButton(cur);
        if (!btn) continue; // can't delete — leave it (surfaces in review)
        const before = Array.from(document.querySelectorAll(entrySel)).length;
        await robustClick(btn);
        const start = Date.now();
        while (Date.now() - start < 4000 && Array.from(document.querySelectorAll(entrySel)).length >= before) {
          await new Promise((r) => setTimeout(r, 150));
        }
        if (Array.from(document.querySelectorAll(entrySel)).length < before) {
          perEntry[k].recs = [{ fieldName: name + "[" + perEntry[k].idx + "].removed", label: name + " entry removed",
            widgetType: "section", isRequired: false, mappedPath: null, status: "skipped",
            detail: "a required pick didn't match an option → entry deleted (optional section)" }];
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    for (const e of perEntry) recs.push(...e.recs);
    return recs;
  };

  // M18: Work Experience — all meaningful entries via the generic filler.
  const fillWorkExperience = (profile) => fillRepeatingSection({
    name: "workExperience", headingRegex: /work experience/i,
    containerPrefix: WORK_EXPERIENCE_CONTAINER_PREFIX,
    items: Array.isArray(profile.work_experience) ? profile.work_experience : [],
    fillEntry: fillWorkExperienceEntry
  });

  // ── Education (M19) — same machinery, its own per-entry field map ────────────
  // Fields (recon): schoolName (text), degree (dropdown), fieldOfStudy (typeahead),
  // firstYearAttended/lastYearAttended (YEAR-ONLY date composites — dateSectionYear-input
  // alone). Years arrive parsed from the SW (fromYearParsed/toYearParsed). Education starts
  // empty on this tenant → the Add path CREATES the first entry. Reuses the existing
  // fillText/fillDropdown/fillTypeahead handlers + the (now year-capable) fillDateComposite.
  const EDUCATION_MAP = [
    { field: "schoolName", widget: "text", key: "school_or_university", path: "school_or_university" },
    { field: "degree", widget: "dropdown", key: "degree", path: "degree" },
    { field: "fieldOfStudy", widget: "typeahead", key: "field_of_study", path: "field_of_study" },
    { field: "gradeAverage", widget: "text", key: "gpa", path: "gpa" },
    { field: "firstYearAttended", widget: "year", key: "fromYearParsed", path: "from_year" },
    { field: "lastYearAttended", widget: "year", key: "toYearParsed", path: "to_year" }
  ];
  const WEBSITE_MAP = [
    { field: "url", widget: "text", key: "url", path: "url" }
  ];
  // Languages (M22): language dropdown (by id) + 3 REQUIRED Proficiency dropdowns whose
  // formField-* ids are hashed → resolved BY LABEL. (The optional "I am fluent" checkbox
  // is left untouched — filling the 3 proficiencies fully expresses it.) Proficiency values
  // may be plain strings or profile-side tiered arrays (through resolve()).
  const LANGUAGE_MAP = [
    { field: "language", widget: "dropdown", key: "language", path: "language" },
    { labelRegex: /reading proficiency/i, name: "readingProficiency", widget: "dropdown", key: "reading", path: "reading" },
    { labelRegex: /speaking proficiency/i, name: "speakingProficiency", widget: "dropdown", key: "speaking", path: "speaking" },
    { labelRegex: /writing proficiency/i, name: "writingProficiency", widget: "dropdown", key: "writing", path: "writing" },
    // LAST for safety-in-principle: check "I am fluent" when all three are fluent (_allFluent,
    // computed SW-side) AFTER the proficiencies are filled+recorded. (Recon MutationObserver:
    // on Magna the proficiency dropdowns STAY visible + interactive when fluent is checked — no
    // hide — so the order is harmless either way; NOT because checking it hides them.)
    { field: "native", widget: "checkbox", key: "_allFluent", path: "_allFluent" }
  ];
  // Certifications (M23): certification typeahead (REQUIRED pick) + optional number + two
  // FULL M/D/Y date composites (Issued/Expiration — the `date` widget, fed a SW-parsed
  // { month, year, day }). The Attachments file field is intentionally omitted. Optional
  // section → deleteOnNoMatch (a cert name that can't match the tenant list is dropped).
  const CERTIFICATION_MAP = [
    { field: "certification", widget: "typeahead", key: "certification", path: "certification" },
    { field: "certificationNumber", widget: "text", key: "certification_number", path: "certification_number" },
    { field: "issuedDate", widget: "date", key: "issuedDateParsed", path: "issued_date" },
    { field: "expirationDate", widget: "date", key: "expirationDateParsed", path: "expiration_date" }
  ];

  // Config-driven per-entry filler (generalized from M19's fillEducationEntry). Fills one
  // entry from a `fieldMap` of { field, widget, key, path }: `year` → year-only
  // fillDateComposite; text/dropdown/typeahead → resolve() (so a PROFILE-side tiered array
  // passes through as an ordered candidate list — M13.2) → the matching handler. Records
  // are `sectionName[idx].field`. Field resolution is by automation-id (by-label, for
  // sections with hashed ids like Languages, is a later round).
  const fillMappedEntry = async (entryArg, item, idx, entrySel, fieldMap, sectionName) => {
    const recs = [];
    const prefix = sectionName + "[" + idx + "].";
    for (const f of fieldMap) {
      // Re-resolve the entry each field — a dropdown/typeahead selection can re-render the
      // entry subtree and detach later wrappers (duplicate ids → must scope to the entry).
      const entry = Array.from(document.querySelectorAll(entrySel))[idx] || entryArg;
      // Resolve the field wrapper by automation-id, OR by LABEL (`labelRegex`) when the id
      // is unstable — e.g. Languages' hashed proficiency-dropdown ids (formField-5aaaed…).
      const wrapper = f.labelRegex
        ? Array.from(entry.querySelectorAll('[data-automation-id^="formField-"]')).find((w) => f.labelRegex.test(getLabel(w) || ""))
        : entry.querySelector('[data-automation-id="formField-' + f.field + '"]');
      const recName = f.name || f.field;
      const rec = { fieldName: prefix + recName, label: wrapper ? getLabel(wrapper) : null,
        widgetType: f.widget === "year" ? "date" : f.widget, isRequired: wrapper ? isRequired(wrapper) : false,
        mappedPath: prefix + f.path, status: null, after: null, detail: null, verified: null };
      if (!wrapper) { rec.status = "error"; rec.detail = "field wrapper not found in entry"; recs.push(rec); continue; }
      const raw = item[f.key];
      if (f.widget === "year") {
        if (!raw) { rec.status = "skipped"; rec.detail = "no valid year at " + prefix + f.path; recs.push(rec); continue; }
        Object.assign(rec, await fillDateComposite(wrapper, null, raw));
      } else if (f.widget === "date") {
        // Full M/D/Y composite — `raw` is a SW-parsed { month, year, day } (parseYearMonthDay) or null.
        if (!raw) { rec.status = "skipped"; rec.detail = "no valid date at " + prefix + f.path; recs.push(rec); continue; }
        Object.assign(rec, await fillDateComposite(wrapper, raw.month, raw.year, raw.day));
      } else if (f.widget === "checkbox") {
        // Reconcile a checkbox to a boolean (label-activation, like WE's currentlyWorkHere).
        const cb = wrapper.querySelector('input[type="checkbox"]');
        const desired = raw === true;
        if (!cb) { rec.status = "skipped"; rec.detail = "no checkbox in field"; recs.push(rec); continue; }
        if (cb.checked === desired) {
          rec.status = "filled"; rec.after = String(cb.checked); rec.verified = true;
          rec.detail = "already " + (desired ? "checked" : "unchecked");
        } else {
          const label = cb.id ? document.querySelector('label[for="' + CSS.escape(cb.id) + '"]') : null;
          await robustClick(label || cb);
          await new Promise((r2) => setTimeout(r2, 250));
          rec.verified = cb.checked === desired;
          rec.status = rec.verified ? "filled" : "needs_review";
          rec.after = String(cb.checked);
          rec.detail = rec.verified ? ("set to " + (desired ? "checked" : "unchecked")) : "toggle did not take";
        }
      } else {
        const r = resolve(raw, f.widget);
        if (r.skip) { rec.status = "skipped"; rec.detail = r.reason || ("empty value at " + prefix + f.path); recs.push(rec); continue; }
        const arg = r.value !== undefined ? r.value : r.candidates;
        if (f.widget === "text") Object.assign(rec, await fillText(wrapper, arg, recName));
        else if (f.widget === "dropdown") Object.assign(rec, await fillDropdown(wrapper, arg, recName));
        else if (f.widget === "typeahead") Object.assign(rec, await fillTypeahead(wrapper, arg, recName));
      }
      recs.push(rec);
      await new Promise((r) => setTimeout(r, 150));
    }
    return recs;
  };

  const fillEducation = (profile) => fillRepeatingSection({
    name: "education", headingRegex: /education/i, containerPrefix: "education-",
    items: Array.isArray(profile.education) ? profile.education : [],
    fillEntry: (e, item, idx, sel) => fillMappedEntry(e, item, idx, sel, EDUCATION_MAP, "education")
  });

  // Websites (M20): each entry is webAddress-N--null with one formField-url (text). Fill
  // from profile.websites[].url (SW-filtered to URL-bearing entries). Heading is "Websites";
  // the container is "webAddress", so the regex covers both.
  const fillWebsites = (profile) => fillRepeatingSection({
    name: "website", headingRegex: /websites?|web ?address/i, containerPrefix: "webAddress-",
    items: Array.isArray(profile.websites) ? profile.websites : [],
    fillEntry: (e, item, idx, sel) => fillMappedEntry(e, item, idx, sel, WEBSITE_MAP, "website")
  });

  // Languages (M22) — optional section, so deleteOnNoMatch: a language/proficiency that
  // can't match an option would leave a REQUIRED field empty (Add makes them required) and
  // block Next → delete that entry instead.
  const fillLanguages = (profile) => fillRepeatingSection({
    name: "language", headingRegex: /languages?/i, containerPrefix: "language-",
    items: Array.isArray(profile.languages) ? profile.languages : [],
    fillEntry: (e, item, idx, sel) => fillMappedEntry(e, item, idx, sel, LANGUAGE_MAP, "language"),
    deleteOnNoMatch: true
  });

  // Certifications (M23) — optional section like Languages; certification is the required
  // pick, so a cert name that can't match the tenant list deletes that entry (deleteOnNoMatch).
  const fillCertifications = (profile) => fillRepeatingSection({
    name: "certification", headingRegex: /certifications?/i, containerPrefix: "certification-",
    items: Array.isArray(profile.certifications) ? profile.certifications : [],
    fillEntry: (e, item, idx, sel) => fillMappedEntry(e, item, idx, sel, CERTIFICATION_MAP, "certification"),
    deleteOnNoMatch: true
  });

  // ============================================================
  // 5. Driver — walk every formField-*, classify, map, resolve, fill.
  // ============================================================
  // M17: fill the Work Experience entry FIRST (it Adds a missing entry), then snapshot
  // wrappers — so a newly-mounted entry is included and then SKIPPED by the flat loop
  // below (fillWorkExperience owns those fields; without the skip they'd double-record
  // as "no mapping" against the duplicate formField-* ids).
  const weRecords = await fillWorkExperience(profile);
  const eduRecords = await fillEducation(profile);
  const webRecords = await fillWebsites(profile);
  const langRecords = await fillLanguages(profile);
  const certRecords = await fillCertifications(profile);

  const wrappers = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
  const results = [...weRecords, ...eduRecords, ...webRecords, ...langRecords, ...certRecords];
  for (const wrapper of wrappers) {
    // Owned by the repeating-section fillers — skip in the flat loop so they don't
    // double-record against the duplicate formField-* ids.
    if (wrapper.closest('[data-fkit-id^="workExperience-"]') || wrapper.closest('[data-fkit-id^="education-"]') || wrapper.closest('[data-fkit-id^="webAddress-"]') || wrapper.closest('[data-fkit-id^="language-"]') || wrapper.closest('[data-fkit-id^="certification-"]')) continue;
    const formFieldId = wrapper.getAttribute("data-automation-id");
    const fieldName = formFieldId.slice("formField-".length);
    const widgetType = classifyField(wrapper);
    const label = getLabel(wrapper);
    const mappedPath = FIELD_MAP[fieldName] || null;
    const rawValue = mappedPath ? getByPath(profile, mappedPath) : undefined;

    const record = {
      fieldName,
      label,
      widgetType,
      isRequired: isRequired(wrapper),
      mappedPath,
      rawValue: rawValue === undefined ? null : rawValue,
      resolved: null,
      status: null,
      matchTier: null,
      verified: null,
      after: null,
      detail: null
    };

    try {
      if (widgetType === "hierarchical") {
        // `source` is currently the only hierarchical field; its candidates come
        // from profile.how_did_you_hear (WINS) falling back to application_defaults
        // (profile-driven, lockstep with the CDP drivePageFill source block).
        const hdyh = (profile && profile.how_did_you_hear) || (defaults && defaults.how_did_you_hear);
        if (!hdyh || !Array.isArray(hdyh.preferred)) {
          record.status = "needs_review";
          record.detail = "no how_did_you_hear value (profile or defaults)";
        } else {
          const candidates = [...hdyh.preferred];
          if (hdyh.fallback) candidates.push(hdyh.fallback);
          record.resolved = candidates;
          const handlerResult = await fillSource(wrapper, candidates, fieldName);
          Object.assign(record, handlerResult);
        }
      } else if (fieldName === "candidateIsPreviousWorker") {
        // Fill + review-queue model (see decidePreviousWorker). Always fills a value
        // when it can evaluate; flags uncertain answers for end-of-form human review.
        const company = jobContext && jobContext.company;
        const employers = profile.employment_history_companies;
        record.mappedPath = "(employer-match)";
        record.rawValue = company || null;
        // `label` is the full question text (getLabel) — it often names the specific
        // entities that count (affiliates/subsidiaries/predecessors), so the matcher
        // scans it for the user's known employers in addition to jobContext.company.
        const decision = decidePreviousWorker(company, label, employers);
        if (decision.fill) {
          record.resolved = [decision.fill];
          const hr = await fillRadio(wrapper, [decision.fill], fieldName);
          Object.assign(record, hr);
          record.detail = hr.detail ? `${decision.detail}; ${hr.detail}` : decision.detail;
          if (decision.likelyYes) record.matchTier = "likely-yes";
          // Filled a best-guess that still needs a human look → distinct status.
          if (hr.status === "filled" && decision.review) record.status = "filled_review";
        } else {
          // Couldn't evaluate → leave blank, force attention.
          record.status = "needs_review";
          record.detail = decision.detail;
        }
      } else if (widgetType === "file_upload") {
        // The engine can't attach (no IndexedDB access across the boundary). It
        // reports the widget; the SW's maybeAttachResume does the attach after the
        // fill and patches this entry to "filled" on success (see background.js).
        record.status = "skipped";
        record.detail = "file upload — attached by the SW post-fill step";
      } else if (!mappedPath) {
        record.status = "skipped";
        record.detail = "no mapping";
      } else {
        const r = resolve(rawValue, widgetType);
        if (r.skip) {
          record.status = "skipped";
          record.detail = r.reason || `empty value at ${mappedPath}`;
        } else {
          const arg = r.value !== undefined ? r.value : r.candidates;
          record.resolved = arg;
          let handlerResult;
          if (widgetType === "text") handlerResult = await fillText(wrapper, arg, fieldName);
          else if (widgetType === "dropdown") handlerResult = await fillDropdown(wrapper, arg, fieldName);
          else if (widgetType === "radio") handlerResult = await fillRadio(wrapper, arg, fieldName);
          else if (widgetType === "typeahead") handlerResult = await fillTypeahead(wrapper, arg, fieldName);
          else { record.status = "skipped"; record.detail = `no handler for type ${widgetType}`; }
          if (handlerResult) Object.assign(record, handlerResult);
        }
      }
    } catch (e) {
      record.status = "error";
      record.detail = String(e);
    }
    results.push(record);

    // Let one field's transient UI settle before the next opens.
    await new Promise((r) => setTimeout(r, 150));
  }

  // ============================================================
  // 6. Bundle — serialize the per-field records into the persistent
  //    reviewSummary envelope (stage 1 of fill → review → submit). This is a
  //    PURE per-record transform; there is no join — each record already carries
  //    classification + resolved value + fill result from the single-pass fill.
  //    The engine computes the bundle and RETURNS it; the service worker writes it
  //    to chrome.storage. The injected function never touches storage itself.
  // ============================================================
  const SCHEMA_VERSION = "1.1"; // Plan 2 lockstep with fill-driver REVIEW_SCHEMA_VERSION (page-qualified field_id, page_label, is_approved)

  // Page-container automation-id (e.g. "applyFlowMyInfoPage"); URL-path fallback.
  const pageEl =
    document.querySelector('[data-automation-id^="applyFlow"][data-automation-id$="Page"]') ||
    document.querySelector('[data-automation-id$="Page"]');
  const pageId = pageEl
    ? pageEl.getAttribute("data-automation-id")
    : (location.pathname.split("/").filter(Boolean).pop() || location.pathname);
  // Plan 2: a STABLE page key for accumulation + a page-qualified field_id. The M31 lesson —
  // pageId (applyFlowPage) is SHARED across pages on some tenants (LiveRamp), so the formField
  // SET is the load-bearing distinguisher. Mirrors cdpPageKey (pathname | sorted field names).
  // This is why "My-Experience showed under page 1": the old page=pageId collapsed pages.
  const pageKey = (location.pathname || pageId) + "|" + wrappers
    .map((w) => (w.getAttribute("data-automation-id") || "").slice("formField-".length))
    .filter(Boolean).sort().join(",");

  // Mechanical outcome, decoupled from the review flag.
  //   filled/filled_review → filled · needs_review → not_filled · skipped → skipped · error → error
  const mapFillStatus = (status) => {
    if (status === "filled" || status === "filled_review") return "filled";
    if (status === "skipped") return "skipped";
    if (status === "error") return "error";
    return "not_filled"; // needs_review (no match / left blank) and any null status
  };

  // Coarse review-priority band + the precise tier it came from (see CLAUDE.md).
  const deriveConfidence = (rec) => {
    const flagged = rec.status === "needs_review" || rec.status === "filled_review" || rec.status === "error";
    let source;
    if (rec.fieldName === "candidateIsPreviousWorker") source = "employer_match";
    else if ((rec.widgetType === "text" || rec.widgetType === "date" || rec.widgetType === "textarea") && rec.status === "filled") source = "profile_direct";
    else if (rec.matchTier === "exact-normalized" || rec.matchTier === "label-exact") source = "exact";
    else if (rec.matchTier === "containment") source = "containment";
    else if (typeof rec.matchTier === "string" && rec.matchTier.startsWith("fuzzy")) source = "fuzzy";
    else source = "reason";
    let band;
    if (flagged || rec.status === "skipped") band = "none";
    else if (source === "profile_direct" || source === "exact" || source === "employer_match") band = "high";
    else band = "medium"; // containment / fuzzy / fallback
    return { confidence: band, confidence_source: source };
  };

  // needs_review flag (over the FULL list) + reason enum. A required field that
  // wasn't filled is escalated into the review list rather than hidden as a skip.
  const deriveReview = (rec) => {
    const required = !!rec.isRequired;
    const flaggedBase = rec.status === "needs_review" || rec.status === "filled_review" || rec.status === "error";
    const escalated = rec.status === "skipped" && required;
    if (!flaggedBase && !escalated) return { needs_review: false, needs_review_reason: null };

    const detail = (rec.detail || "").toLowerCase();
    let reason;
    if (rec.fieldName === "candidateIsPreviousWorker") reason = "employer_match_uncertain";
    else if (rec.status === "error") reason = "fill_error";
    else if (rec.status === "skipped" && required && !rec.mappedPath) reason = "unmapped_required_field";
    else if (rec.status === "skipped" && required) reason = "required_field_empty";
    else if (detail.includes("no options appeared")) reason = "typeahead_empty_listbox";
    else if (detail.includes("unsupported widget") || detail.includes("no handler")) reason = "unsupported_widget";
    else if (detail.includes("defaults")) reason = "config_missing";
    else reason = "low_confidence"; // "no candidate matched" / "no preferred option" / any other flagged
    return { needs_review: true, needs_review_reason: reason };
  };

  const buildEntry = (rec, index) => {
    const fill_status = mapFillStatus(rec.status);
    const { confidence, confidence_source } = deriveConfidence(rec);
    const { needs_review, needs_review_reason } = deriveReview(rec);
    // The value actually filled (selected option text for choice widgets), only when filled.
    // LOCKSTEP ↔ fill-driver.js buildReviewBundle: `after` is only ever a LIVE page value → shows
    // in the editor for ANY status (a needs_review kept-original renders in the field, not empty).
    const current_value = rec.after != null ? rec.after : null;
    return {
      field_id: pageKey + "::formField-" + rec.fieldName, // PAGE-QUALIFIED (Plan 2) — globally unique across the accumulated bundle
      page: pageKey,                    // the STABLE merge key (field-set), NOT pageId (shared across pages)
      page_number: null,                // stamped by runWalk (the SW knows the 1..N ordinal; the engine doesn't)
      page_label: pageId,               // friendly caption (e.g. "applyFlowMyInfoPage") until runWalk stamps "Page N"
      field_index: index,
      question_label: rec.label != null ? rec.label : null,
      widget_type: rec.widgetType,
      canonical_field: rec.mappedPath != null ? rec.mappedPath : null,
      is_required: !!rec.isRequired,
      current_value,
      original_ai_value: current_value, // the bot's pick at write time — never changed by edits
      is_edited: false,                 // human changed the effective value (set by the summary editor)
      edit_kind: null,                  // provenance for replay: override | filled_blank | cleared | null
      is_approved: !!rec.is_approved,   // Plan 2: explicit human sign-off; carried so a REFILL's replayed-approved fields stay approved (LOCKSTEP with fill-driver twin)
      approved_at: rec.approved_at != null ? rec.approved_at : null,
      confidence,
      confidence_source,
      needs_review,
      needs_review_reason,
      fill_status,
      fill_error: rec.status === "error" ? (rec.detail || null) : null,
      detail: rec.detail != null ? rec.detail : null,
      match_tier: rec.matchTier != null ? rec.matchTier : null,
      maps_to: rec.maps_to != null ? rec.maps_to : null,                                 // Profile Learning piggyback (LOCKSTEP ↔ fill-driver buildReviewBundle; page engine has no AI piggyback → usually null)
      suggested_category: rec.suggested_category != null ? rec.suggested_category : null,
      options: Array.isArray(rec.options) ? rec.options : null,
      captured_options: Array.isArray(rec.captured_options) ? rec.captured_options : null,
      character_count: null // reserved for textareas
    };
  };

  const entries = results.map((rec, i) => buildEntry(rec, i));
  const bundle = {
    schema_version: SCHEMA_VERSION,
    page: pageKey,           // the stable merge key (runWalk stamps page_number/page_label per page)
    page_number: null,
    page_label: pageId,      // friendly until runWalk stamps "Page N"
    url: location.href,
    tenant: location.hostname,
    captured_at: new Date().toISOString(),
    total: entries.length,
    counts: entries.reduce((acc, e) => { acc[e.fill_status] = (acc[e.fill_status] || 0) + 1; return acc; }, {}),
    by_type: entries.reduce((acc, e) => { acc[e.widget_type] = (acc[e.widget_type] || 0) + 1; return acc; }, {}),
    needs_review_count: entries.filter((e) => e.needs_review).length,
    entries
  };

  const summary = {
    total: results.length,
    byType: results.reduce((acc, r) => { acc[r.widgetType] = (acc[r.widgetType] || 0) + 1; return acc; }, {}),
    byStatus: results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
    needs_review_count: bundle.needs_review_count,
    // Accumulated review queue — every field that needs a human look before submit:
    // unfilled (needs_review) AND best-guess fills flagged for confirmation (filled_review).
    review: results
      .filter((r) => r.status === "needs_review" || r.status === "filled_review")
      .map((r) => ({ fieldName: r.fieldName, status: r.status, after: r.after, detail: r.detail }))
  };

  // ============================================================
  // 7. Nav metadata (M15) — read-only signals the SW uses to drive the
  //    multi-page walk. The engine NEVER clicks Next itself: it reports whether
  //    the footer Next button is present and whether this is the review page, plus
  //    a page SIGNATURE (url + pageId + formField set) the SW compares after the
  //    transition to confirm the new page loaded. Pure DOM reads — no mutation,
  //    so single-page RUN_FILL behavior is unchanged.
  // ============================================================
  const nav = {
    pageId,
    url: location.href,
    formFieldCount: wrappers.length,
    formFieldIds: wrappers.map((w) => (w.getAttribute("data-automation-id") || "").slice("formField-".length)),
    nextButtonPresent: !!document.querySelector('[data-automation-id="pageFooterNextButton"]'),
    reviewPagePresent: !!document.querySelector('[data-automation-id="applyFlowReviewPage"]'),
    // M16.3: does this page have the resume upload widget? The SW reads the stored
    // resume and attaches it as a post-fill step (the engine can't — no IndexedDB).
    uploadWidgetPresent: !!document.querySelector('[data-automation-id="file-upload-input-ref"]')
  };

  return { results, summary, bundle, nav };
}

// ============================================================================
// clickNext — injected into the active tab to click "Save and Continue"
// (data-automation-id="pageFooterNextButton"). Self-contained: closes over
// NOTHING (the SW stringifies it). The SW, not the engine, triggers navigation —
// so the just-filled page's review data is already captured before the page tears
// down. Returns { clicked, strategy, label } or { clicked:false, refused }.
// ============================================================================
function clickNext() {
  // Defensive double-guard (ported from the Python tool): NEVER click the footer
  // button on the review page — there it reuses the Submit data-automation-id, so a
  // click would SUBMIT the application. The orchestrator also refuses to advance
  // once it sees the review marker; this is belt-and-suspenders on the one click
  // that could submit.
  if (document.querySelector('[data-automation-id="applyFlowReviewPage"]')) {
    return { clicked: false, refused: "review-page" };
  }
  const btn = document.querySelector('[data-automation-id="pageFooterNextButton"]');
  if (!btn) return { clicked: false, refused: "no-button" };
  const label = (btn.textContent || "").trim();
  // Minimal pointer-event sequence — the first (and on Comcast, always-successful)
  // strategy of the engine's robustClick, inlined so this fn stays self-contained.
  try {
    const rect = btn.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    btn.dispatchEvent(new PointerEvent("pointerdown", opts));
    btn.dispatchEvent(new MouseEvent("mousedown", opts));
    btn.dispatchEvent(new PointerEvent("pointerup", opts));
    btn.dispatchEvent(new MouseEvent("mouseup", opts));
    btn.dispatchEvent(new MouseEvent("click", opts));
    return { clicked: true, strategy: "pointer-sequence", label };
  } catch (e) {
    try { btn.click(); return { clicked: true, strategy: "native-click", label }; }
    catch (e2) { return { clicked: false, refused: "click-threw", error: String(e2) }; }
  }
}

// ============================================================================
// probePage — injected to read the current page's SIGNATURE so the SW can detect
// when a transition has actually completed. Self-contained, pure DOM reads. The
// pageId derivation mirrors fillEngine's bundle (page container automation-id,
// URL-path fallback).
// ============================================================================
function probePage() {
  const pageEl =
    document.querySelector('[data-automation-id^="applyFlow"][data-automation-id$="Page"]') ||
    document.querySelector('[data-automation-id$="Page"]');
  const pageId = pageEl
    ? pageEl.getAttribute("data-automation-id")
    : (location.pathname.split("/").filter(Boolean).pop() || location.pathname);
  const wrappers = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'));
  return {
    url: location.href,
    pageId,
    formFieldCount: wrappers.length,
    formFieldIds: wrappers.map((w) => (w.getAttribute("data-automation-id") || "").slice("formField-".length)),
    readyState: document.readyState
  };
}

// ============================================================================
// attachResume — injected into the active tab to attach the stored resume to
// Workday's upload widget. Bytes arrive as STRING args (a File can't cross the
// injection boundary), so the File is rebuilt HERE in the page context. Driven by
// the SW's maybeAttachResume post-fill step (the engine can't — no IndexedDB).
// Self-contained: closes over NOTHING (the SW stringifies it). Sequence:
//   1. CLEAR any existing attachment (delete-file → poll rows to 0) — makes fill
//      idempotent (re-running doesn't stack duplicates; mirrors the Python wipe).
//   2. ATTACH via DataTransfer + input.files + synthetic change (proven M16.1/.2;
//      input.files RESETS to 0 after Workday's XHR upload, so it's not the signal).
//   3. GATE on file-upload-successful specifically — file-upload-item also renders
//      mid-upload / on error, so the row alone is not a confident success.
// ============================================================================
async function attachResume(base64, filename, mime, sectionSel) {
  if (!base64) return { attached: false, detail: "no resume bytes passed (empty base64)" };

  // Re-resolve EVERYTHING fresh from the document on each read. Workday REPLACES the
  // resume-section subtree on re-render during the rapid sequential deletes, so a node
  // captured once (section/scope/input) goes detached/stale mid-loop — its queries
  // then read a frozen count and clicks land on detached buttons (this is why 3
  // attachments only cleared 2). These closures re-query each call → immune to the
  // subtree being swapped out. (The section's wrapper automation-id is the empty
  // "formField-", so we anchor on the stable data-fkit-id.)
  // sectionSel scopes the attach to a specific attachment area (e.g. a cert's "…--attachments"); default
  // = the top-level résumé area. Passed as a plain string across the injection boundary (never a node).
  const findSection = () => document.querySelector(sectionSel || '[data-fkit-id="resumeAttachments--attachments"]') || document;
  const countItems = () => findSection().querySelectorAll('[data-automation-id="file-upload-item"]').length;
  const firstDelete = () => findSection().querySelector('[data-automation-id="delete-file"]');
  const findInput = () =>
    findSection().querySelector('[data-automation-id="file-upload-input-ref"]') ||
    document.querySelector('[data-automation-id="file-upload-input-ref"]');

  // Inline robust click (pointer-event sequence, native fallback) — delete-file is a
  // real <button>, but this removes click-strength as a variable. Self-contained.
  const clickEl = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
      el.dispatchEvent(new MouseEvent("mouseup", o));
      el.dispatchEvent(new MouseEvent("click", o));
    } catch (e) {
      try { el.click(); } catch (e2) { /* the poll decides success */ }
    }
  };

  if (!findInput()) return { attached: false, detail: "no file input (file-upload-input-ref) found" };

  // ── 1. Clear existing attachment(s), ONE AT A TIME, re-resolving each pass ──
  // Find the first LIVE delete-file, click it, wait for the row count to drop by one,
  // settle, then re-resolve — until no items remain. Bounded by MAX_DELETES (matches
  // the Python wipe) + per-click timeouts so a delete that never registers can't hang.
  // One re-click retry covers a click that landed on a node mid-replacement.
  const MAX_DELETES = 10;
  let deletedCount = 0;
  const waitDrop = async (before) => {
    const dl = Date.now() + 4000;
    while (countItems() >= before && Date.now() < dl) await new Promise((r) => setTimeout(r, 150));
    return countItems() < before;
  };
  for (let i = 0; i < MAX_DELETES; i++) {
    const before = countItems();
    if (before === 0) break;
    let del = firstDelete();
    if (!del || !del.isConnected) { await new Promise((r) => setTimeout(r, 250)); del = firstDelete(); } // settle + re-resolve
    if (!del) break; // items remain but no remover — fall through to the cleared check
    clickEl(del);
    let dropped = await waitDrop(before);
    if (!dropped) {
      const again = firstDelete(); // the click may have hit a node mid-replacement — retry once
      if (again && again.isConnected) { clickEl(again); dropped = await waitDrop(before); }
    }
    if (!dropped) break; // genuinely stuck — stop, don't hang
    deletedCount++;
    await new Promise((r) => setTimeout(r, 300)); // let the re-render settle before the next pass
  }
  const remaining = countItems();
  const cleared = remaining === 0;
  if (!cleared) {
    // Diagnostic: if the delete didn't take, capture any visible confirm dialog/modal markup so the
    // NEXT failure self-reports whether a dialog blocked it (the message's "confirm dialog" hypothesis)
    // — without another recon round. (The primary suspect is the input-lock swallowing the synthetic
    // delete-click; the SW bumps __apActing around this call to rule that out first.)
    let dialog = null;
    try {
      const d = document.querySelector('[role="dialog"], [aria-modal="true"], [data-automation-id*="onfirm" i], [data-automation-id*="odal" i]');
      if (d) dialog = { automationId: d.getAttribute("data-automation-id") || null, text: (d.textContent || "").trim().slice(0, 200) };
    } catch (e) { /* ignore */ }
    return { attached: false, cleared: false, deletedCount, remaining, dialog, detail: `could not clear existing attachment(s) — removed ${deletedCount}, ${remaining} remain` + (dialog ? ` (CONFIRM DIALOG present: "${dialog.text}")` : " (no dialog seen — likely the input-lock swallowed the delete-click; should be fixed by the __apActing bump)") };
  }

  // ── 2. Rebuild the File and attach via DataTransfer ──────────────────────
  let file;
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    file = new File([bytes], filename || "resume.pdf", { type: mime || "application/pdf" });
  } catch (e) {
    return { attached: false, cleared, deletedCount, detail: "failed to rebuild File from base64: " + String(e) };
  }

  // Re-resolve the input FRESH — clearing may have replaced the section/input node.
  const input = findInput();
  if (!input) return { attached: false, cleared, deletedCount, detail: "file input vanished after clearing" };

  let filesSetImmediately = null;
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    filesSetImmediately = input.files.length; // 1 if the browser accepted the programmatic set
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    return { attached: false, cleared, deletedCount, filesSetImmediately, detail: "DataTransfer/dispatch failed: " + String(e) };
  }

  // ── 3. Gate on file-upload-successful (the completion marker) ────────────
  const deadline = Date.now() + 10000;
  let confirmationVia = null;
  let sawItem = false;
  while (Date.now() < deadline) {
    if (findSection().querySelector('[data-automation-id="file-upload-successful"]')) { confirmationVia = "file-upload-successful"; break; }
    if (countItems() > 0) sawItem = true; // mid-upload; keep waiting for the success marker
    await new Promise((r) => setTimeout(r, 200));
  }

  const nameEl = findSection().querySelector('[data-automation-id="file-upload-item-name"]');
  const fileName = nameEl ? nameEl.textContent.trim() : null;
  const confirmationSeen = confirmationVia === "file-upload-successful";

  return {
    attached: confirmationSeen,           // confident only when the success marker rendered
    cleared,
    deletedCount,
    filesSetImmediately,
    confirmationSeen,
    confirmationVia,
    fileName,
    detail: confirmationSeen
      ? `attached + confirmed via file-upload-successful (cleared ${deletedCount} existing)`
      : (sawItem
          ? "file-upload-item appeared but file-upload-successful did not within 10s — upload may be in progress or failed"
          : `no confirmation row within 10s (input.files set immediately = ${filesSetImmediately})`)
  };
}

