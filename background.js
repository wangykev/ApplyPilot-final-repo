// Shared IndexedDB storage helpers (saveResume/getResume/RESUME_KEY). Classic MV3
// service worker, so importScripts brings db.js's functions into the SW scope (the
// popup loads the same file via <script>). Used by the M16.2 attach path to read
// the stored resume's bytes here, then pass them as a string into the injection.
importScripts("db.js", "lib.js", "llm.js", "cdp.js", "fill-driver.js"); // db.js = IndexedDB storage; lib.js = pure helpers (parse*, match ladder); llm.js = multi-provider LLM adapter (callLLM); cdp.js = CDP substrate (off-loop actuation); fill-driver.js = the substrate-agnostic CDP fill brain (needs lib.js loaded first)

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

  // CDP CERT-SPECIALTY RECON (M36.2): read-mostly discovery of the NESTED Specialties
  // sub-section inside a Certification entry (mounts ONE specialty, dumps the diff,
  // restores). [CERT-SPECIALTY-RECON] in the SW console. No profile needed.
  if (message.type === "RUN_CDP_CERT_SPECIALTY_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpCertSpecialtyRecon(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // CDP TEXTAREA RECON (M37 Part 0 — the WE gate): does CDP actuation drive a Workday
  // <textarea>? Probes the WE roleDescription textarea with a multi-line value via
  // insertText vs the native-setter cdpEval. [TEXTAREA-RECON] in the SW console.
  if (message.type === "RUN_CDP_TEXTAREA_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpTextAreaRecon(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // CDP FILL WEBSITES (M32b): the FIRST repeating-section fill on the CDP path —
  // reconcile the Websites section to N + fill each entry's url (date-free) while
  // HIDDEN. Proves driveRepeatingSectionCdp; dates are deferred (Websites has none).
  // Run on My Experience (page 2). Results land as [CDP-WEB] in the SW console.
  if (message.type === "RUN_CDP_FILL_WEBSITES") {
    chrome.storage.local.get(["profile"], ({ profile }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-WEB] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFillWebsites(tab.id, profile);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // CDP FILL LANGUAGES (M35): reuse driveRepeatingSectionCdp for the date-free Languages
  // section (language + 3 by-label proficiency dropdowns + "I am fluent" checkbox; deleteOnNoMatch).
  // First live exercise of the labelRegex/hashed-id resolve. Run on My Experience (page 2). [CDP-LANG].
  if (message.type === "RUN_CDP_FILL_LANGUAGES") {
    chrome.storage.local.get(["profile"], ({ profile }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-LANG] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFillLanguages(tab.id, profile);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // CDP FILL WORK EXPERIENCE (M37): reuse driveRepeatingSectionCdp; WORK_EXPERIENCE_MAP
  // (text + currentlyWorkHere checkbox + M/Y dates + roleDescription textarea). Run on
  // My Experience (page 2). [CDP-WE] in the SW console.
  if (message.type === "RUN_CDP_FILL_WORK_EXPERIENCE") {
    chrome.storage.local.get(["profile"], ({ profile }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-WE] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFillWorkExperience(tab.id, profile);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // CDP FILL EDUCATION (M36): reuse driveRepeatingSectionCdp; un-deferred date branch fills the
  // from/to YEAR dates via the M34 composite. Run on My Experience (page 2). [CDP-EDU] in SW console.
  if (message.type === "RUN_CDP_FILL_EDUCATION") {
    chrome.storage.local.get(["profile"], ({ profile }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-EDU] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFillEducation(tab.id, profile);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // CDP FILL CERTIFICATIONS (M36): reuse driveRepeatingSectionCdp; un-deferred date branch fills the
  // issued/expiration M/D/Y dates. deleteOnNoMatch (a non-matching cert deletes its entry). Run on My
  // Experience (page 2). [CDP-CERT] in the SW console.
  if (message.type === "RUN_CDP_FILL_CERTIFICATIONS") {
    chrome.storage.local.get(["profile"], ({ profile }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-CERT] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFillCertifications(tab.id, profile);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // TARGETED DATE FILL (M34 verify harness): fill ONE date composite located by
  // label regex via fillDateCompositeCdp HIDDEN — proves the date handler on the
  // three shapes (WE M/Y, Education year-only, Certs M/D/Y). Run on My Experience
  // (page 2). Results land as [CDP-DATE] in the SW console.
  if (message.type === "RUN_CDP_FILL_DATE") {
    chrome.storage.local.get(["profile"], ({ profile }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-DATE] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFillDate(tab.id, profile, String(message.labelRegex || ""));
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // SOURCE FILL (backlog C — Phase B): fill the source picker via fillSourceCdp
  // (typeahead-style: type → filter → auto-commit/click leaf) HIDDEN, candidates
  // from defaults.how_did_you_hear (preferred LinkedIn). Selects LinkedIn + reads
  // the live commit signal. [CDP-SRC] in the SW console.
  if (message.type === "RUN_CDP_SOURCE_FILL") {
    chrome.storage.local.get(["defaults"], ({ defaults }) => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpSourceFill(tab.id, defaults);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // CDP FILL (Step 2 of the CDP actuation port): fill the active page's SIMPLE
  // widgets (text/dropdown/radio/checkbox) through chrome.debugger input while
  // the tab is HIDDEN — the M22 decision logic (fill-driver.js) over the CDP
  // actuation (cdp.js). Typeahead/source → needs_review untouched; repeating
  // sections excluded by the scan. Results land in the SW console (NEEDS REVIEW
  // block first, then the full table). Standalone — RUN_FILL is untouched.
  if (message.type === "RUN_CDP_FILL") {
    chrome.storage.local.get(["profile", "defaults", "jobContext"], ({ profile, defaults, jobContext }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-FILL] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFill(tab.id, profile, defaults, jobContext);
        sendResponse(out);
      });
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
        const out = await runCdpFillPage(tab.id, profile, defaults, jobContext, { skipLock: !!message.noLock });
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // AI-4 TEST HARNESS: fill the page, deliberately clear a required field, then watch AI-4 remediate.
  if (message.type === "RUN_CDP_TEST_REMEDIATION") {
    chrome.storage.local.get(["profile", "defaults", "jobContext"], ({ profile, defaults, jobContext }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-TEST-AI4] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpTestRemediation(tab.id, profile, defaults, jobContext, { unfixable: !!message.unfixable });
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // CDP RE-AUDIT (M40 standalone): re-read the live page vs the persisted reviewAudit
  // expectations + report mismatches. No profile needed (reads stored expectations).
  if (message.type === "RUN_CDP_AUDIT") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpAudit(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // CDP RESUME-ATTACH RECON (walk prereq 1): probe whether attachResume runs via cdpEval
  // on the debugger attach + how the confirmation gate behaves. Needs a stored resume,
  // not a profile. Run on the page WITH the upload widget (Magna page 2).
  if (message.type === "RUN_CDP_RESUME_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpResumeRecon(tab.id);
      sendResponse(out);
    });
    return true; // async sendResponse
  }

  // TYPEAHEAD STRAY-COMMIT RECON: pin when a stray commits in the overwrite/keptLowerTier
  // resting path (the fieldOfStudy "Other"→"Accounting" bug). No profile needed; label
  // regex from the ta-label input. Run on the page with the field (page 2 for FoS).
  if (message.type === "RUN_CDP_TA_STRAY_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpTaStrayRecon(tab.id, String(message.labelRegex || ""));
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

  // INPUT-LOCK RECON: probe overlay-vs-CDP-click, keydown-vs-insertText, and the __apActing
  // flag-gate cost + toggle-timing self-block. No profile needed. Run on any form page.
  if (message.type === "RUN_CDP_INPUTLOCK_RECON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
      const out = await runCdpInputlockRecon(tab.id);
      sendResponse(out);
    });
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
    out.work_experience = meaningfulEntries(profile.work_experience, ["job_title", "company"]).map((e) => ({
      ...e, fromParsed: parseYearMonth(e.from), toParsed: parseYearMonth(e.to), bulletsText: joinBullets(e.bullets)
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
    out.languages = meaningfulEntries(profile.languages, ["language"]).map((e) => ({
      ...e, _allFluent: isFluent(e.reading) && isFluent(e.speaking) && isFluent(e.writing) // → check the "I am fluent" box
    }));
  }
  if (Array.isArray(profile.certifications)) {
    out.certifications = meaningfulEntries(profile.certifications, ["certification"]).map((e) => ({
      ...e, issuedDateParsed: parseYearMonthDay(e.issued_date), expirationDateParsed: parseYearMonthDay(e.expiration_date)
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
    await persistBundle(frameResult.bundle); // overwrite-per-page (decided; see persistBundle)
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
// SOURCE FILL — backlog C, Phase B. Runs fillSourceCdp on formField-source HIDDEN
// with candidates from defaults.how_did_you_hear (preferred LinkedIn). Selects the
// match and logs the live commit signal (which verifier fired). Detaches in finally.
// ============================================================================
async function runCdpSourceFill(tabId, defaults) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-SRC]", ...a);
  const WRAP = '[data-automation-id="formField-source"]';
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    LOG("attached. MINIMIZE THE WINDOW NOW — the fill starts on the first hidden read (60s window).");
    if (!(await cdpWaitHidden(60000, 500))) { LOG("tab never went hidden — INVALID run."); return { ok: false, error: "never-hidden" }; }

    const hdyh = defaults && defaults.how_did_you_hear;
    if (!hdyh || !Array.isArray(hdyh.preferred)) { LOG("no defaults.how_did_you_hear.preferred — Load default profile (seeds defaults) first."); return { ok: false, error: "no-candidates" }; }
    const candidates = [...hdyh.preferred];
    if (hdyh.fallback) candidates.push(hdyh.fallback);
    LOG("candidates (tier order):", JSON.stringify(candidates));
    LOG("tab is hidden — source fill starting. (Δperf ~1000ms hidden is EXPECTED.)");

    const act = makeCdpActuation();
    const rec = await fillSourceCdp(act, { wrapperSel: WRAP }, candidates, DEFAULT_BUDGETS);
    LOG("result:", JSON.stringify({ status: rec.status, after: rec.after, verified: rec.verified, tier: rec.matchTier, flag: rec.flag, confidence: rec.confidence, detail: rec.detail }, null, 2));
    if (rec.settle_trace) LOG("settle trace:", JSON.stringify(rec.settle_trace, null, 2));
    if (rec.captured_options) LOG("captured leaves:", JSON.stringify(rec.captured_options));
    return { ok: true, status: rec.status, after: rec.after || null, verified: rec.verified === true, flag: rec.flag || null };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("source fill aborted:", msg);
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
// CDP CERT-SPECIALTY RECON (M36.2) — read-MOSTLY structure discovery of the
// NESTED Specialties sub-section inside a Certification entry (a repeating
// section nested inside a repeating entry — never recon'd). Attach → hidden-gate
// → dump the cert entry → OBSERVE its inside Add buttons → mount ONE specialty
// (bounded) → dump the before/after data-fkit-id + field DIFF (the specialty
// container prefix + its per-specialty typeahead/start-end-date fields + entry-
// scoping + Attachments presence) → RESTORE (delete the mounted specialty, and any
// cert entry we added) → detach. RECON ONLY — no fill, no profile schema (those are
// a later build milestone). Attachments are recorded, never filled (deferred — no
// per-cert files stored). [CERT-SPECIALTY-RECON] in the SW console.
// ============================================================================
async function runCdpCertSpecialtyRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][CERT-SPECIALTY-RECON]", ...a);
  const act = makeCdpActuation();
  // Poll the cert-entry scan until `pred` holds (or the ceiling) — the page mounts
  // on its throttled hidden loop, so all waits are generous SW wall-clock.
  const scanUntil = async (pred, ceilingMs) => {
    const t0 = Date.now();
    let last = await cdpEval(cdpCertSpecialtyScan);
    while (!pred(last) && Date.now() - t0 < ceilingMs) { await cdpDelay(250); last = await cdpEval(cdpCertSpecialtyScan); }
    return last;
  };
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
    LOG("tab is hidden — cert-specialty recon starting. (Δperf ~1000ms on the page loop is EXPECTED, not failure.)");

    // ── (1) ensure a cert entry exists (host for the specialty) ───────────────
    let scan = await cdpEval(cdpCertSpecialtyScan);
    if (!scan) return { ok: false, error: "scan-failed" };
    let addedCert = false;
    if (scan.certEntryCount === 0) {
      LOG("no Certification entry present — adding one to host the specialty…");
      const a = await act.clickSectionAdd("certifications?");
      if (!a.ok) { LOG("could not click the Certifications Add — abort (navigate to My Experience page 2)."); return { ok: false, error: "cert-add-failed" }; }
      scan = await scanUntil((s) => s && s.certEntryCount >= 1, 6000);
      addedCert = !!(scan && scan.certEntryCount >= 1);
      if (!addedCert) { LOG("Certification entry never mounted after Add — abort."); return { ok: false, error: "no-cert-entry" }; }
    }
    const before = scan.certEntries[0];
    LOG("cert entry:", before.fkit, "| own field count:", before.fieldCount, "| Attachments file inputs:", before.fileInputs);
    LOG("cert entry BEFORE — nested fkit ids:", JSON.stringify(before.nestedFkitIds));
    LOG("cert entry BEFORE — full structure:");
    console.log("[ApplyPilot][CERT-SPECIALTY-RECON]", JSON.stringify(before, null, 2));
    LOG("Add buttons INSIDE the cert entry (observe the specialty Add's heading BEFORE clicking):");
    console.log("[ApplyPilot][CERT-SPECIALTY-RECON]", JSON.stringify(before.addButtonsInside, null, 2));

    if (!before.addButtonsInside.length) {
      LOG("⚠ NO Add button inside the cert entry — the Specialties Add may require the cert typeahead filled first, or the structure differs. Recon stops at the BEFORE dump (read-only); fill the cert + re-run, or inspect the dump above.");
      if (addedCert) { LOG("removing the cert entry we added…"); await act.clickDeleteEntry("certification-", 0); }
      return { ok: true, mounted: false, note: "no-inside-add" };
    }

    // ── (2) mount ONE specialty (bounded) — by the observed heading regex ─────
    const baseline = new Set(before.nestedFkitIds);
    LOG('mounting one specialty via clickSectionAdd("specialt") …');
    const m = await act.clickSectionAdd("specialt");
    let after = before, newFkit = [];
    if (!m.ok) {
      LOG('⚠ clickSectionAdd("specialt") found no Add with a "Special…" heading. Check addButtonsInside above for the real heading, then re-run with that regex. (Recon read-only; nothing mounted.)');
    } else {
      const post = await scanUntil((s) => {
        const c0 = s && s.certEntries[0];
        return c0 && c0.nestedFkitIds.some((id) => !baseline.has(id));
      }, 6000);
      const c0 = post && post.certEntries[0];
      if (c0) { after = c0; newFkit = c0.nestedFkitIds.filter((id) => !baseline.has(id)); }
    }

    // ── (3) dump the DIFF — the specialty structure ───────────────────────────
    let specialtyIndex = null;
    if (!newFkit.length) {
      LOG("⚠ no NEW nested data-fkit-id appeared after the Add — the specialty may mount in a modal / different DOM, or the heading regex missed. AFTER dump for inspection:");
      console.log("[ApplyPilot][CERT-SPECIALTY-RECON]", JSON.stringify(after, null, 2));
    } else {
      LOG("✅ specialty mounted — NEW nested data-fkit-id(s):", JSON.stringify(newFkit));
      // Pattern (recon finding): certification-<N>--specialties-<M>--<field>. NO `--null`
      // container — the specialty ENTRY is the SET of --specialties-<M>--{specialtyParent,
      // startDate,endDate} field-fkit nodes (M = the entry index).
      const sm = newFkit[0].match(/--specialties-(\d+)--/);
      specialtyIndex = sm ? sm[1] : null;
      LOG("→ specialty entry fkit pattern: certification-<N>--specialties-<M>--<field> (this entry M=" + (specialtyIndex || "?") + "); NO --null container — the entry is the --specialties-" + (specialtyIndex || "M") + "--{specialtyParent,startDate,endDate} field-fkit set.");
      const beforeIds = new Set(before.fields.map((f) => f.automationId));
      const newFields = after.fields.filter((f) => !beforeIds.has(f.automationId));
      LOG("NEW specialty fields (the diff — expect a typeahead + start/end date composites):");
      console.log("[ApplyPilot][CERT-SPECIALTY-RECON]", JSON.stringify(newFields, null, 2));
      // entry-scoping: are the specialty formField ids duplicated vs the cert's own
      // (the WE/Languages duplicate-id trap → the future nested fill must scope)?
      const dupVsCert = newFields.filter((f) => beforeIds.has(f.automationId)).map((f) => f.automationId);
      const dateFields = newFields.filter((f) => f.dateSegments.length > 0);
      const typeaheads = newFields.filter((f) => f.widgetType === "typeahead");
      LOG("specialty shape summary:", JSON.stringify({
        newFieldCount: newFields.length,
        typeaheadFields: typeaheads.map((f) => f.fieldName),
        dateFields: dateFields.map((f) => ({ field: f.fieldName, segments: f.dateSegments })),
        hashedIds: newFields.filter((f) => f.hashedId).map((f) => f.fieldName),
        duplicateAutomationIdsVsCertOwn: dupVsCert,
        attachmentsFileInputsInCertEntry: after.fileInputs
      }, null, 2));
    }

    // ── (4) RESTORE — HONEST (auto-restore NOT wired for the nested shape) ─────
    // The specialty entry is NOT a `--null` container (it's the --specialties-<M>--
    // field-fkit set), so clickDeleteEntry (which keys on --null entries) can't remove
    // it — and a proper per-cert-entry nested Delete belongs to the DEFERRED fill
    // milestone, not a half-built one here. So we do NOT auto-delete the mounted
    // specialty; we log it loudly. ⚠ The operator removes the leftover manually before
    // the WE / full-page work (a stale empty specialty would confuse a full-page rescan).
    if (newFkit.length) {
      LOG("⚠ LEFTOVER — this recon MOUNTED an empty specialty (" + newFkit.join(", ") + ") and does NOT auto-remove it (the nested Delete is part of the deferred fill milestone). REMOVE IT MANUALLY: on the form, click Delete on the empty specialty under the cert's 'Specialties' — before running WE / a full-page fill.");
    }
    if (addedCert) {
      LOG("removing the cert entry we added for the recon (a --null entry, deletable)…");
      const d = await act.clickDeleteEntry("certification-", 0);
      LOG(d.ok ? "✅ cert entry removed." : "⚠ could not delete the added cert entry — remove it manually.");
    }
    LOG("recon complete — see the BEFORE/diff dumps above. Build (schema + nested fill) is a DEFERRED milestone; Attachments deferred.");
    return { ok: true, mounted: !!newFkit.length, specialtyIndex };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP TEXTAREA RECON (M37 Part 0 — the GATE before WE) — does CDP actuation drive
// a Workday <textarea> (roleDescription)? fillTextCdp is <input>-only (focusText
// targets " input", cdpReadTextState querySelector("input")), and CDP Input.insertText
// on a textarea is UNPROVEN. Probe the first WE entry's roleDescription textarea with
// a MULTI-LINE value (≥2 lines + \n — the real fill writes newline-joined bulletsText;
// insertText can mishandle newlines, so single-line success is weak evidence):
//   (a) coordinate-click focus + Input.insertText (trusted, consistent with the text path)
//   (b) native setter via cdpEval/Runtime.evaluate (the EXACT page-engine technique —
//       off-loop + proven page-side + handles \n trivially → the guaranteed fallback)
// Verify the FULL value lands WITH the newline intact AND survives React (re-read after
// a tick); restore (clear) after. Read-mostly. [TEXTAREA-RECON] in the SW console.
// ============================================================================
async function runCdpTextAreaRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][TEXTAREA-RECON]", ...a);
  const TA = '[data-fkit-id^="workExperience-"][data-fkit-id$="--null"] [data-automation-id="formField-roleDescription"] textarea';
  const MULTILINE = "Recon line one — alpha\nRecon line two — bravo"; // 2 lines, exactly one \n
  const readTA = () => cdpEval((sel) => {
    const t = document.querySelector(sel);
    return t ? { value: t.value, lines: t.value.split("\n").length, focused: document.activeElement === t } : null;
  }, TA);
  const nativeWrite = (val) => cdpEval((sel, v) => {
    const t = document.querySelector(sel); if (!t) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    if (t.focus) t.focus(); setter.call(t, v);
    t.dispatchEvent(new Event("input", { bubbles: true })); t.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, TA, val);
  const clearTA = () => nativeWrite("");
  // A path "passes" only if the FULL multi-line value lands (newline kept) AND survives
  // a React re-read — not just that some text appeared.
  const verify = async (label) => {
    const r1 = await readTA();
    await cdpDelay(600); // React-survival re-read (did onChange revert it?)
    const r2 = await readTA();
    const stuck = !!(r1 && r1.value === MULTILINE);
    const newlineKept = !!(r1 && r1.lines === 2);
    const survived = !!(r2 && r2.value === MULTILINE);
    LOG(label + ":", JSON.stringify({ stuck, newlineKept, survivedReact: survived, read1: r1 && r1.value, read1Lines: r1 && r1.lines, read2Lines: r2 && r2.lines }));
    return stuck && newlineKept && survived;
  };
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    LOG("attached. MINIMIZE THE WINDOW NOW — recon starts on the first hidden read (60s window). Run on My Experience (page 2) with ≥1 Work Experience entry.");
    if (!(await cdpWaitHidden(60000, 500))) { LOG("tab never went hidden — INVALID run, nothing probed."); return { ok: false, error: "never-hidden" }; }
    LOG("tab is hidden — textarea recon starting. (Δperf ~1000ms on the page loop is EXPECTED, not failure.)");

    const pre = await readTA();
    if (!pre) { LOG("⚠ no Work Experience roleDescription textarea found — add a WE entry on My Experience (page 2) and re-run."); return { ok: false, error: "no-textarea" }; }
    LOG("roleDescription textarea found (original value length " + (pre.value || "").length + "). Probing the MULTI-LINE value:", JSON.stringify(MULTILINE));

    // ── (a) Input.insertText after a coordinate-click focus ──────────────────
    await clearTA(); await cdpDelay(300);
    let aResult = "no-rect";
    const rect = await cdpRectReady(TA, true); // textarea is visible → real rect (unlike the masked date -input)
    if (rect) {
      await cdpClickAt(rect.cx, rect.cy); await cdpDelay(250);
      const f = await readTA();
      LOG("(a) coordinate-click focus →", (f && f.focused) ? "focused" : "NOT focused");
      await cdpInsertText(MULTILINE); await cdpDelay(500);
      aResult = (await verify("(a) Input.insertText (multi-line)")) ? "PASS" : "FAIL";
    } else { LOG("(a) textarea rect not live — skipping the trusted-input path."); }

    // ── (b) native setter via cdpEval (the proven page-engine technique) ──────
    await clearTA(); await cdpDelay(300);
    await nativeWrite(MULTILINE); await cdpDelay(500);
    const bResult = (await verify("(b) native-setter via cdpEval (multi-line)")) ? "PASS" : "FAIL";

    // ── restore + decision ───────────────────────────────────────────────────
    await clearTA();
    const decision = aResult === "PASS" ? "(a) Input.insertText — PREFERRED (trusted input, consistent with fillTextCdp)"
      : bResult === "PASS" ? "(b) native-setter via cdpEval — fallback (insertText didn't keep the full multi-line value)"
      : "NEITHER landed the full multi-line value — investigate before building WE";
    LOG("════ TEXTAREA RECON RESULT ════");
    LOG("(a) Input.insertText:", aResult, "| (b) native-setter via cdpEval:", bResult);
    LOG("→ DECISION for the WE build:", decision);
    LOG("textarea cleared (restored).");
    return { ok: true, insertText: aResult, nativeSetter: bResult, decision };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("textarea recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP FILL — Step 2 of the CDP actuation port. SW-side runner: attach →
// hidden-gate → drive the page through fill-driver.js over the CDP actuation →
// report → detach in finally. No reviewSummary bundle this milestone (the
// persisted review UI stays a hard requirement before any ship) — the report
// below is the deliverable, with NEEDS REVIEW impossible to miss.
// ============================================================================
async function runCdpFill(tabId, profile, defaults, jobContext) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-FILL]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — the fill starts on the first hidden read (60s window).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, nothing filled.");
      return { ok: false, error: "never-hidden" };
    }
    LOG("tab is hidden — CDP fill starting. (Δperf ~1000ms on the page loop is EXPECTED while hidden, not failure.)");

    const act = makeCdpActuation();
    const out = await drivePageFill(act, profile, defaults, jobContext);

    // ── Report: NEEDS REVIEW first (typeahead/source deferrals AND employer-
    // match outcomes), then the full per-field table, then counts. ──
    LOG("page:", out.url);
    if (out.sessionWarning) LOG(`⚠⚠ ${out.sessionWarning}`); // M30 early-warning, leads the report
    if (out.repeatingFieldCount) LOG(`${out.repeatingFieldCount} repeating-section field(s) on this page — untouched (out of scope this milestone).`);
    LOG(`════ NEEDS REVIEW (${out.needsReview.length}) ════`);
    for (const r of out.needsReview) {
      LOG(`  ⚠ [${r.status}] ${r.fieldName} (${r.widgetType}) — "${r.label}" → ${r.detail}${r.after ? ` | currently: "${r.after}"` : ""}`);
    }
    console.table(out.results.map((r) => ({
      field: r.fieldName, type: r.widgetType, status: r.status, after: r.after,
      verified: r.verified, tier: r.matchTier, flag: r.flag, confidence: r.confidence, detail: r.detail
    })));
    LOG("counts:", JSON.stringify(out.counts));
    return { ok: true, counts: out.counts, needs_review: out.needsReview.length, session_warning: out.sessionWarning || null };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("CDP fill aborted:", msg);
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
  // Operator input-lock: install BEFORE any actuation (idempotent — re-creates the overlay on a
  // fresh page after a nav, so the walk re-protects each page). The 4 CDP input primitives gate
  // on the counter it sets; the caller removes it in its finally (alongside cdpDetach).
  // opts.skipLock = the NO-LOCK baseline for the oracle-equal verification (lock-off vs lock-on).
  if (!(opts && opts.skipLock)) await installInputLock();
  const out = await drivePageFill(act, prepared, defaults, jobContext);

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

  // Walk prereq 1 (resume attach): the CDP fold records file_upload as `skipped` (it can't
  // attach). Here the SW reads the stored resume (IndexedDB) + runs the PROVEN attachResume
  // via cdpEval on the SAME debugger attach (recon 2026-06-21: works VISIBLE, idempotent —
  // clears existing then attaches; gate = file-upload-successful). Patch the file_upload
  // record BEFORE buildReviewBundle so the bundle reflects it. No resume / failed →
  // needs_review (self-explaining); the walk's pre-advance check HALTS on it (a required
  // upload empty blocks Save & Continue). NOTE: attachResume's attached:true is the engine's
  // claim; the FORM accepting it (Save & Continue advances) is the form's truth — the walk's
  // advance is the decisive proof, not this record.
  const uploadRec = out.results.find((r) => r.widgetType === "file_upload");
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
      // attachResume's events pass. Gated on the lock being active so non-lock runs pay nothing.
      const lockOn = !(opts && opts.skipLock);
      if (lockOn) { try { await cdpEval(() => { window.__apActing = (window.__apActing || 0) + 1; }); } catch (e) { /* no lock/page — ignore */ } }
      try { ar = await cdpEval(attachResume, resumeRec.base64, resumeRec.filename || "resume.pdf", resumeRec.mime || "application/pdf"); }
      catch (e) { arErr = String((e && e.message) || e); }
      finally { if (lockOn) { try { await cdpEval(() => { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }); } catch (e) { /* ignore */ } } }
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
  const bundle = buildReviewBundle(out.results, { page: pageKey, url: out.url, tenant, capturedAt: new Date().toISOString() });
  await persistAccumulated(bundle);
  return { out, bundle, auditFlags, pageKey };
}

// AI-4: rebuild + re-persist the page bundle from the CURRENT out.results (after remediation
// mutates them) — reuses the SAME pageKey so the accumulation merge replaces this page (no
// duplicate). Keeps the persisted review bundle an honest audit trail of what AI-4 changed.
async function repersistPageBundle(out, pageKey) {
  const tenant = (() => { try { return new URL(out.url).hostname; } catch (e) { return null; } })();
  const bundle = buildReviewBundle(out.results, { page: pageKey, url: out.url, tenant, capturedAt: new Date().toISOString() });
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

// AI-4 validation-error remediation loop (Tier 1 anchors → Tier 2 AI), bounded + halt-on-no-progress.
// Runs ONLY when the session is LIVE (the caller already excluded sessionDead) and Save & Continue
// stayed put. GLOBAL shared cap across both tiers (REMEDIATION_MAX — Hold 1, "not 2+2"); halts the
// instant the error set is UNCHANGED after an action (no point re-firing the same fix). Every action
// is recorded into out.results (flag ai-remediation) + the bundle re-persisted. NEVER submits — the
// re-Save&Continue is the GUARDED clickPageNext (refuses on the review marker).
const REMEDIATION_MAX = 3;
async function remediatePageErrors(act, profile, defaults, jobContext, out, pageKey, page, LOG) {
  const actions = [];
  let st = null; try { st = await cdpEval(cdpReadSessionState); } catch (e) { /* ignore */ }
  let prevErrors = (st && st.errorMarkers && st.errorMarkers.samples) || [];
  LOG(`AI-4 remediation: page ${page} blocked with ${prevErrors.length} error(s). Attempting (cap ${REMEDIATION_MAX}, halt on no-progress).`);

  for (let attempt = 1; attempt <= REMEDIATION_MAX; attempt++) {
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
          const r = await refillFieldWithValue(act, f, decision.value, DEFAULT_BUDGETS);
          mergeRemediationRecord(out, Object.assign({ fieldName: f.fieldName, label: f.label, widgetType: f.widgetType }, r, {
            flag: "ai-remediation", status: r.status === "filled" ? "filled_review" : r.status,
            detail: `AI-4 Tier-2 refill "${decision.value}" — ` + (r.detail || decision.reason || "")
          }));
          actions.push({ tier: 2, action: "refill", field: decision.field, value: decision.value });
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

    if (!didSomething) { await repersistPageBundle(out, pageKey); return { advanced: false, reason: "no-action", attempts: attempt, actions }; }

    // Record the remediation trail into the persisted bundle BEFORE the re-advance (so it's kept
    // whether or not this attempt advances).
    await repersistPageBundle(out, pageKey);

    // ── re-Save & Continue (GUARDED — refuses on the review marker) + wait. ──
    const prevSig = cdpPageSig(await cdpEval(cdpPageScan));
    const click = await act.clickPageNext();
    if (!click.clicked) return { advanced: false, reason: "click-refused:" + (click.refused || "?"), attempts: attempt, actions };
    const res = await cdpWaitNextPage(prevSig);
    if (res.sessionDead) return { sessionDead: true, attempts: attempt, actions };
    if (res.advanced) return { advanced: true, attempts: attempt, actions };

    // ── not advanced → HALT on NO-PROGRESS (error set unchanged); else continue. ──
    let st2 = null; try { st2 = await cdpEval(cdpReadSessionState); } catch (e) { /* ignore */ }
    const newErrors = (st2 && st2.errorMarkers && st2.errorMarkers.samples) || [];
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
// repeating sections) this is identical to runCdpFill + a summary; on page 2 it fills
// the whole page in one click. SINGLE page (no advance) — accumulates, reset via the
// "Clear summary" button. [CDP-PAGE] in the SW console.
// ============================================================================
// AI-0 seam: read the operator's LLM config for act.llm. act.llm enforces the opt-in
// (enabled===false ⇒ no provider call). Only the FILL paths (full-page + walk) thread it in;
// recon/section harnesses build a config-less act (act.llm short-circuits OFF). Returns {} if unset.
async function getLlmConfig() {
  return await new Promise((resolve) => chrome.storage.local.get("llmConfig", (r) => resolve((r && r.llmConfig) || {})));
}

async function runCdpFillPage(tabId, profile, defaults, jobContext, opts) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-PAGE]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    // Foreground fast-fill: NO hidden-gate. The fill runs whether the tab is VISIBLE
    // (fast — act.delay scales down; watch it) or HIDDEN (slow/background — full delays,
    // throttle-immune), adapting LIVE as the operator minimizes/restores.
    LOG(`attached. Filling NOW${opts && opts.skipLock ? " (NO input-lock — oracle baseline)" : " (input-lock ON)"} — keep the tab VISIBLE for a fast fill (watch it) or MINIMIZE for slow/background; it adapts live. Full-page (flat + every repeating section present).`);

    const prepared = prepareProfile(profile); // sections need the annotated arrays (fromParsed/bulletsText/meaningful)
    const act = makeCdpActuation(await getLlmConfig()); // AI-0 seam: act.llm bound to the operator's config (OFF unless the toggle is on)
    const { out, bundle, auditFlags } = await fillAndPersistPage(act, prepared, defaults, jobContext, LOG, opts);
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

// ============================================================================
// AI-4 TEST HARNESS — stage a fixable validation error so AI-4 remediation fires.
// The form fills correctly (no natural error) and the input-lock blocks the operator
// from manually breaking a field mid-run, so the SW does it: fill the page → DELIBERATELY
// clear a required, mapped text field (lock-immune, via the gated clear primitive) → Save &
// Continue ERRORS → run the remediation loop. FIXABLE (default): Tier-1 clicks the error
// anchor → focuses the field → re-fills from profile → ADVANCES. UNFIXABLE (opts.unfixable):
// wrap clickPageNext to RE-CLEAR the target before each click → the error never clears →
// the no-progress/cap halt fires CLEANLY (never loops, never submits). Run on a fully-
// fillable page WITHOUT a required upload (page 1 / My Information). [CDP-TEST-AI4] console.
// ============================================================================
async function runCdpTestRemediation(tabId, profile, defaults, jobContext, opts) {
  const unfixable = !!(opts && opts.unfixable);
  const LOG = (...a) => console.log("[ApplyPilot][CDP-TEST-AI4]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    LOG(`AI-4 TEST (${unfixable ? "UNFIXABLE — watch the no-progress/cap halt" : "FIXABLE — watch Tier-1 re-fill + advance"}). Filling, then DELIBERATELY clearing a required field to trigger a Save & Continue error. Run on a fully-fillable page WITHOUT a required upload (page 1 / My Information).`);

    const prepared = prepareProfile(profile);
    const act = makeCdpActuation(await getLlmConfig()); // AI-0 seam (Tier-2 needs the AI toggle ON; Tier-1 works either way)
    const { out, pageKey } = await fillAndPersistPage(act, prepared, defaults, jobContext, LOG);

    // PERTURB: pick the first REQUIRED, MAPPED text field (Tier-1 can re-fill it from the profile),
    // then blank it via the gated clear (lock-immune — bypasses the operator, passes the input-lock).
    const scan = await act.scanPage();
    const isMapped = (fn) => (typeof FIELD_MAP !== "undefined") && !!FIELD_MAP[fn];
    const target = scan.fields.find((f) => f.widgetType === "text" && f.isRequired && isMapped(f.fieldName))
      || scan.fields.find((f) => f.widgetType === "text" && f.isRequired)
      || scan.fields.find((f) => f.widgetType === "text" && isMapped(f.fieldName));
    if (!target) { LOG("no perturbable required/mapped text field on this page — run on My Information (page 1)."); return { ok: true, stopped: "no-target" }; }
    const targetLoc = { wrapperSel: target.wrapperSel };
    const clearTarget = async () => { await act.focusText(targetLoc, "input"); await act.clearText(); };
    await clearTarget();
    LOG(`PERTURBED: cleared "${target.label}" (${target.fieldName}) — Save & Continue should now error.`);

    // UNFIXABLE: a thin wrapper that re-clears the target before EVERY Save & Continue, so the
    // error never clears no matter what AI-4 re-fills → deterministic no-progress halt. Test-only.
    const driveAct = unfixable
      ? Object.assign({}, act, { clickPageNext: async () => { await clearTarget(); return act.clickPageNext(); } })
      : act;

    const prevSig = cdpPageSig(await cdpEval(cdpPageScan));
    const click = await driveAct.clickPageNext();
    LOG("initial Save & Continue:", JSON.stringify(click));
    if (!click.clicked) { LOG(`advance refused (${click.refused}) — cannot test here.`); return { ok: true, stopped: "click-refused:" + (click.refused || "?") }; }
    const res = await cdpWaitNextPage(prevSig);
    if (res.advanced) { LOG(`⚠ page ADVANCED without an error — clearing "${target.fieldName}" didn't block Save & Continue (not actually required?). Try another page (My Information has required First/Last/Phone).`); return { ok: true, stopped: "advanced-no-error", target: target.fieldName }; }
    if (res.sessionDead) { LOG("session dead — cannot test."); return { ok: true, stopped: "session-dead" }; }

    // res.timeout → the EXPECTED validation error. Fire AI-4.
    LOG(`Save & Continue blocked (expected${res.errorDetected ? ", detected fast via error markers" : ""}) → running AI-4 remediation.`);
    const rem = await remediatePageErrors(driveAct, prepared, defaults, jobContext, out, pageKey, 1, LOG);
    if (rem.sessionDead) { LOG("session dead during remediation."); return { ok: true, stopped: "session-dead" }; }
    if (rem.advanced) { LOG(`✓✓ AI-4 FIXED it — advanced after ${rem.attempts} attempt(s). Actions: ${JSON.stringify(rem.actions)}`); return { ok: true, stopped: "remediated-advanced", attempts: rem.attempts, actions: rem.actions }; }
    LOG(`AI-4 HALTED CLEANLY (${rem.reason}) after ${rem.attempts} attempt(s) — never looped, never submitted. Actions: ${JSON.stringify(rem.actions)}`);
    return { ok: true, stopped: "remediation-halted", reason: rem.reason, attempts: rem.attempts, actions: rem.actions };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("test aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await removeInputLock();
    await cdpDetach();
  }
}

// ============================================================================
// CDP RE-AUDIT (M40 standalone) — re-read the LIVE page against the persisted
// expectations (`reviewAudit`, written by the last full-page fill) + report any
// mismatch. The independent backstop, runnable any time: the operator can fill,
// then MANUALLY change a committed field, then re-audit → it MUST flag that field
// (the perturbation gate — proves the audit CATCHES, not just stays quiet). Read-
// only re-reads; never actuates. Attach → reconcileAudit → report → detach.
// ============================================================================
async function runCdpAudit(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-AUDIT]", ...a);
  try {
    const stored = await new Promise((resolve) => chrome.storage.local.get("reviewAudit", (r) => resolve(r && r.reviewAudit)));
    if (!stored || !Array.isArray(stored.entries) || !stored.entries.length) {
      LOG("no reviewAudit found — run a full-page CDP fill first (it records the expectations).");
      return { ok: false, error: "no-audit-data" };
    }
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG(`re-auditing ${stored.entries.length} field(s) against the live page (recorded ${stored.savedAt}).`);
    const act = makeCdpActuation();
    const verdicts = await reconcileAudit(act, stored.entries, DEFAULT_BUDGETS);
    const bad = verdicts.filter((v) => v.verdict !== "match");
    LOG(`════ AUDIT (${verdicts.length} checked, ${bad.length} flagged) ════`);
    for (const v of bad) {
      LOG(`  ⚠ [${v.verdict}] ${v.key} (${v.widgetType}) — page shows "${v.actual}" ; expected "${v.expected}"`);
    }
    if (!bad.length) LOG("  ✓ every field still shows its filled value — page matches the last fill.");
    return { ok: true, checked: verdicts.length, flagged: bad.length, mismatches: bad };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("re-audit aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP RESUME-ATTACH RECON (walk prereq 1, recon-first) — the KEY unknowns before
// wiring the resume into the CDP fill: (1) does the PROVEN page-injection attachResume
// (rebuild File from base64 → DataTransfer → input.files → change → gate on
// file-upload-successful) run via cdpEval/Runtime.evaluate on the SAME debugger attach
// (no chrome.scripting, no second client)? (2) attachResume's clear-loop + confirmation
// gate use PAGE-SIDE setTimeout — does the confirmation complete under the debugger
// channel, and how does the throttle bite HIDDEN vs VISIBLE (→ keep its internal poll, or
// SW-PACE the gate like every other CDP wait)? Run on a page WITH the upload widget
// (Magna page 2 "Application Documents"); a resume must be stored (popup). Reports the
// attach result + ELAPSED wall-clock. NOTE: this ATTACHES A REAL FILE to the live form —
// recon debris (leave it / clear it in the form per the orphan-specialties discipline).
// Run it VISIBLE and (separately) MINIMIZED and compare the elapsed times.
// ============================================================================
async function runCdpResumeRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-RESUME-RECON]", ...a);
  try {
    let rec = null;
    try { rec = await getResume(); } catch (e) { LOG("IndexedDB read failed:", String(e)); return { ok: false, error: "idb-read-failed" }; }
    if (!rec || !rec.base64) { LOG("no resume stored — upload a PDF in the popup first, then re-run."); return { ok: false, error: "no-resume" }; }

    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }

    // Is the upload widget on this page at all?
    const hasWidget = await cdpEval(() => !!document.querySelector('[data-automation-id="file-upload-input-ref"]'));
    const vis = await cdpEval(() => document.visibilityState);
    LOG(`upload widget present: ${hasWidget}; tab visibilityState: ${vis}. Resume: ${rec.filename} (${rec.size} bytes).`);
    if (!hasWidget) { LOG("no file-upload-input-ref on this page — run on the page that HAS the required upload (Magna page 2 'Application Documents')."); return { ok: true, widget_present: false }; }

    // PROBE: run the existing self-contained attachResume via cdpEval (awaitPromise) — the
    // candidate reuse path. Time the whole thing (its internal page-side confirmation poll
    // is what the throttle would bite). NOTE: cdpEval uses Date.now()-free SW timing here.
    const t0 = Date.now();
    let result = null, evalError = null;
    try { result = await cdpEval(attachResume, rec.base64, rec.filename || "resume.pdf", rec.mime || "application/pdf"); }
    catch (e) { evalError = String((e && e.message) || e); }
    const elapsedMs = Date.now() - t0;

    if (evalError) { LOG(`cdpEval(attachResume) THREW after ${elapsedMs}ms: ${evalError} (Runtime.evaluate may not run this fn — fall back to chrome.scripting, or SW-pace a custom probe).`); return { ok: true, widget_present: true, eval_error: evalError, elapsed_ms: elapsedMs }; }
    LOG(`cdpEval(attachResume) returned after ${elapsedMs}ms:`, JSON.stringify(result, null, 2));
    LOG(result && result.attached
      ? `✓ ATTACHED via the debugger channel (confirmation: ${result.confirmationVia}). ⇒ cdpEval-native attach WORKS${vis === "visible" ? " (visible)" : " (HIDDEN — the internal page poll survived the throttle)"}.`
      : `✗ NOT confirmed (${result && result.detail}). If the File set (filesSetImmediately) but no confirmation row ${vis === "visible" ? "even visible → page didn't process the change" : "while hidden → the throttle bit the page-side poll/XHR → SW-PACE the gate"}.`);
    LOG("NOTE: a real file is now attached on the live form — clear it in the form if you don't want it, before any walk.");
    return { ok: true, widget_present: true, attached: !!(result && result.attached), confirmation_via: result && result.confirmationVia, files_set: result && result.filesSetImmediately, elapsed_ms: elapsedMs, visibility: vis, detail: result && result.detail };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("resume recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// TYPEAHEAD STRAY-COMMIT RECON — pin WHEN a stray ("Accounting") commits in the
// overwrite/keptLowerTier RESTING path. Live bug: fieldOfStudy pre-filled "Other",
// the M36.1 keptLowerTier path reported KEPT "Other" but the M40 audit found
// "Accounting" → a stray landed AFTER the brain read the chip. HYPOTHESIS (M25 ghost):
// clearing the searchBox to EMPTY while the listbox is open ARMS the row-0 highlight
// (first option "Accounting"); Escape doesn't disarm it; the next field's BLUR commits
// it. This harness drives the discrete resting steps + reads chip / activeText
// (aria-activedescendant = the armed highlight) / firstOption between each, so the step
// where the chip flips "Other"→firstOption IS the trigger. Read-mostly (restore the
// field after if it strays). Locate the typeahead by label (default "field of study").
// Pre-set the field to a LOWER tier ("Other") first to match the live keptLowerTier case.
// ============================================================================
async function runCdpTaStrayRecon(tabId, labelRegexStr) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-TA-STRAY]", ...a);
  let re;
  try { re = new RegExp(labelRegexStr || "field of study", "i"); } catch (e) { LOG("bad label regex:", JSON.stringify(labelRegexStr)); return { ok: false, error: "bad-regex" }; }
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error); return { ok: false, error: "attach-failed:" + attached.error }; }
    const act = makeCdpActuation();

    // Locate the typeahead by label — across repeating-section entries, then flat.
    let loc = null, where = null;
    const rscan = await cdpEval(cdpRepeatingScan);
    for (const prefix of (rscan ? rscan.sectionsPresent : [])) {
      for (let i = 0; i < rscan.sections[prefix].entries.length; i++) {
        const f = rscan.sections[prefix].entries[i].fields.find((x) => x.widgetType === "typeahead" && (re.test(x.label || "") || re.test(x.fieldName)));
        if (f) { loc = { wrapperSel: f.wrapperSel }; where = `${prefix}[${i}] "${f.label}"`; break; }
      }
      if (loc) break;
    }
    if (!loc) {
      const ps = await cdpEval(cdpPageScan);
      const f = (ps && ps.fields || []).find((x) => x.widgetType === "typeahead" && (re.test(x.label || "") || re.test(x.fieldName)));
      if (f) { loc = { wrapperSel: f.wrapperSel }; where = `flat "${f.label}"`; }
    }
    if (!loc) { LOG(`no typeahead matching /${re.source}/ on this page — run on the page with the field (page 2 for Field of Study).`); return { ok: true, found: false }; }
    LOG(`probing ${where} (${loc.wrapperSel}). Pre-set this field to a LOWER tier (e.g. "Other") first for the keptLowerTier case.`);

    // Read after EACH action — distinguish ARMING (activeText→"Accounting", chip stays "Other")
    // from COMMIT (the CHIP flips). The fix targets the COMMIT step, not arming.
    const snap = async (tag) => {
      const s = await act.readTypeahead(loc);
      const chip = ((s && s.chips) || []).join("; ");
      const active = (s && s.activeText) || null;
      LOG(`  [${tag}] chip="${chip}" | armed(activeText)="${active}" | firstOption="${((s && s.pageWide.texts) || [])[0]}" | sbValue="${s && s.searchBox.value}" | sbVisible=${s && s.searchBox.visible} | banner=${!!(s && s.banner)}`);
      return { chip, active };
    };

    // Locate the NEXT field's input rect (a text field in the SAME entry — the faithful
    // "move to next field" production does) + a NEUTRAL empty coordinate (the operator's
    // safe manual click-outside).
    let nextRect = null;
    try {
      const rs2 = await cdpEval(cdpRepeatingScan);
      for (const prefix of (rs2 ? rs2.sectionsPresent : [])) {
        for (const e of rs2.sections[prefix].entries) {
          const nf = e.fields.find((x) => x.widgetType === "text" && x.wrapperSel !== loc.wrapperSel);
          if (nf) { const r = await cdpEval(cdpRectOf, nf.wrapperSel + ' input', true); if (r && r.w > 0) { nextRect = r; LOG(`next-field for the faithful blur: "${nf.label}" @ (${r.cx},${r.cy}).`); break; } }
        }
        if (nextRect) break;
      }
    } catch (e) { /* fall through — skip the next-field click */ }
    const neutral = await cdpEval((wrapperSel) => {
      const w = document.querySelector(wrapperSel);
      const bad = (el) => !el || el === document.documentElement || el === document.body
        || /^(input|button|a|select|textarea)$/i.test(el.tagName)
        || el.closest('[role="option"], button, a, input, [data-automation-id="searchBox"]') || (w && w.contains(el));
      const W = window.innerWidth, H = window.innerHeight;
      for (const [x, y] of [[W * 0.5, 8], [8, H * 0.5], [W - 8, H * 0.5], [W * 0.5, H - 8], [20, 20]]) {
        const el = document.elementFromPoint(Math.round(x), Math.round(y));
        if (!bad(el)) return { cx: Math.round(x), cy: Math.round(y) };
      }
      return null;
    }, loc.wrapperSel);

    const probeQuery = "Electrical and Computer Engineering"; // a known-ABSENT higher-tier value
    const ensureFocused = async () => { let st = await act.readTypeahead(loc); if (!st || !st.searchBox.visible) { await act.openTypeahead(loc); await act.delayFull(400); st = await act.readTypeahead(loc); } if (st && st.searchBox.visible && !st.searchBox.focused) { await act.focusSearchBox(loc); await act.delayFull(300); } };
    const reproduceArmed = async () => { await ensureFocused(); await act.clearSearch(); await act.delayFull(500); await act.typeInSearch(probeQuery); await act.delayFull(600); await act.pressEnter(); await act.delayFull(1800); };
    const recommitOther = async () => { // the LIKELY FIX: affirmative re-select, overwrites whatever's armed
      await ensureFocused(); await act.clearSearch(); await act.delayFull(500); await act.typeInSearch("Other"); await act.delayFull(600); await act.pressEnter(); await act.delayFull(1500);
      const r = await act.readTypeahead(loc); if (!(r && (r.chips || []).some((c) => /^other$/i.test(c)))) { try { await act.clickTaOption(loc, "Other"); await act.delayFull(900); } catch (e) { /* ignore */ } }
    };

    LOG("════ PHASE A — faithful production reproduction → CLICK NEXT FIELD ════");
    const a0 = await snap("A0 initial");
    await reproduceArmed();
    const a1 = await snap("A1 after no-match search   [ARMING expected here: armed→Accounting, chip stays Other]");
    await ensureFocused();
    const a2 = await snap("A2 after RESTING re-focus");
    await act.clearSearch(); await act.delayFull(900);
    const a3 = await snap("A3 after RESTING clearSearch→EMPTY   [candidate 2: does the CHIP flip here?]");
    await act.pressEscape(); await act.delayFull(700);
    const a4 = await snap("A4 after pressEscape");
    if (nextRect) { await cdpClickAt(nextRect.cx, nextRect.cy); await act.delayFull(1200); } else LOG("  (no next-field rect — skipped the faithful blur)");
    const a5 = await snap("A5 after CLICK NEXT FIELD   [candidate 1: does the CHIP flip here? — the faithful exit]");

    LOG("════ RESET — re-commit \"Other\" (also tests the re-commit FIX: recovers a strayed field?) ════");
    await recommitOther();
    const rr = await snap("R after re-commit Other   [fix check: chip back to Other?]");

    LOG("════ PHASE B — CONTROL: same reproduction, but CLICK NEUTRAL SPACE (the operator's safe manual blur) ════");
    await reproduceArmed();
    await snap("B1 after no-match search");
    await ensureFocused();
    await act.clearSearch(); await act.delayFull(900);
    await act.pressEscape(); await act.delayFull(700);
    await snap("B2 after resting dismiss");
    if (neutral) { await cdpClickAt(neutral.cx, neutral.cy); await act.delayFull(1200); LOG(`  (clicked NEUTRAL @ (${neutral.cx},${neutral.cy}))`); } else LOG("  (no neutral coordinate found — skipped the control)");
    const b3 = await snap("B3 after CLICK NEUTRAL SPACE   [operator says a neutral blur is SAFE — does it stray?]");

    // ── Conclusion: ARMING vs COMMIT; next-field vs neutral ──
    const flip = (prev, now) => !!(now.chip && prev.chip && now.chip !== prev.chip); // CHIP changed = COMMIT
    const aSeq = [["A1", a0, a1], ["A2", a1, a2], ["A3 (resting clear→empty)", a2, a3], ["A4 (escape)", a3, a4], ["A5 (click next field)", a4, a5]];
    let commitStep = null; for (const [tag, prev, now] of aSeq) { if (flip(prev, now)) { commitStep = tag; break; } }
    const strayedA = !!(a5.chip && a0.chip && a5.chip !== a0.chip);
    const strayedB = !!(b3.chip && rr.chip && b3.chip !== rr.chip);
    LOG("════ CONCLUSION ════");
    LOG(`ARMING: activeText became "${a1.active}" at the no-match search (A1) while chip stayed "${a1.chip}" — EXPECTED arming, not the bug.`);
    LOG(commitStep ? `COMMIT (the trigger): the CHIP flipped "${a0.chip}"→"${a5.chip}" at step ${commitStep}. The FIX targets THAT action.`
                   : `Phase A did NOT commit a stray this run (chip "${a5.chip}") — RACE; re-run. (Watch which step flips the CHIP, not activeText.)`);
    LOG(`CONTROL: next-field click ${strayedA ? "STRAYED" : "clean"} vs neutral-space click ${strayedB ? "STRAYED" : "clean"}. ` +
      (strayedA && !strayedB ? "⇒ focus-to-NEXT-FIELD is the trigger; a neutral blur is safe (candidate 1) → fix = re-commit Other, or do a safe neutral blur before exiting."
        : strayedA && strayedB ? "⇒ BOTH stray ⇒ the resting clear-to-empty/dismiss is the trigger (candidate 2), not the click target → fix = don't-clear / re-commit Other."
          : "⇒ inconclusive this run — re-run."));
    LOG(`FIX CHECK: re-commit "Other" left chip "${rr.chip}" ${/^other$/i.test(rr.chip) ? "✓ (re-commit recovers — strong fix candidate)" : "✗ (re-commit did NOT land Other — investigate)"}.`);
    LOG("NOTE: restore Field of Study manually if it isn't \"Other\" now.");
    return { ok: true, found: true, commit_step: commitStep, strayed_next_field: strayedA, strayed_neutral: strayedB, recommit_chip: rr.chip };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("typeahead-stray recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// INPUT-LOCK RECON — resolve the 3 unknowns before building the operator input-lock
// (block the operator's pointer/keyboard while the bot's CDP input proceeds). The bot's
// CDP input is isTrusted through the SAME pipeline as the operator's, so "block user,
// allow bot" is non-trivial. Probes (each restored after):
//   (1) does a pointer-events:auto overlay INTERCEPT the bot's cdpClickAt? (static
//       overlay viable, or must flag-gate?)
//   (2) does a capture keydown-blocker eat cdpInsertText vs cdpTypeChars/cdpKeyTap?
//   (3) the __apActing flag-gate: cost + the TOGGLE-TIMING self-block — clearing the
//       flag right after the dispatch CALL returns may self-block the bot's still-
//       propagating event (clear-after-dispatch vs clear-after-confirm). [INPUTLOCK-RECON]
// ============================================================================
async function runCdpInputlockRecon(tabId) {
  const LOG = (...a) => console.log("[ApplyPilot][INPUTLOCK-RECON]", ...a);
  const TSEL = '[data-ap-recon-target="1"]';
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error); return { ok: false, error: "attach-failed:" + attached.error }; }

    // Tag a text input as the probe target — PREFER one already in the viewport (RECON 1 picked an
    // off-screen field at y=-4807 → clicks hit nothing → artifacts). freshTargetRect() scrollIntoViews
    // + returns the POST-scroll center rect + an in-viewport check (mirrors the bot's cdpRectOf(sel,true));
    // re-fresh before EVERY click so coords are always valid.
    const tagged = await cdpEval(() => {
      const cands = Array.from(document.querySelectorAll("input")).filter((i) => {
        const t = (i.getAttribute("type") || "").toLowerCase();
        const ok = t === "" || t === "text" || t === "tel" || t === "email";
        const r = i.getBoundingClientRect();
        return ok && r.width > 0 && r.height > 0;
      });
      if (!cands.length) return null;
      const inView = cands.find((i) => { const r = i.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
      const el = inView || cands[0];
      el.setAttribute("data-ap-recon-target", "1");
      return { id: el.getAttribute("data-automation-id") || el.name || "(input)" };
    });
    if (!tagged) { LOG("no visible text input on this page to probe — run on a form page."); return { ok: true, no_target: true }; }
    const freshTargetRect = async () => cdpEval((sel) => {
      const el = document.querySelector(sel); if (!el) return null;
      if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      return { cx, cy, inViewport: cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight };
    }, TSEL);
    const tr0 = await freshTargetRect();
    LOG(`probe target: ${tagged.id} @ (${tr0 && tr0.cx},${tr0 && tr0.cy}) inViewport=${tr0 && tr0.inViewport}.`);

    // ── (1) Overlay vs CDP coordinate click ──
    const r1 = await freshTargetRect();
    if (r1 && r1.inViewport) {
      await cdpEval(() => {
        const o = document.createElement("div");
        o.id = "__ap_ovl"; o.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.02);pointer-events:auto;";
        window.__ap_ovl_hit = false;
        o.addEventListener("mousedown", () => { window.__ap_ovl_hit = true; }, true);
        o.addEventListener("click", () => { window.__ap_ovl_hit = true; }, true);
        document.body.appendChild(o);
        const t = document.querySelector('[data-ap-recon-target="1"]'); if (t) t.blur();
      });
      await cdpClickAt(r1.cx, r1.cy); await cdpDelay(200);
      const p1 = await cdpEval((sel) => ({ overlayHit: !!window.__ap_ovl_hit, targetFocused: document.activeElement === document.querySelector(sel) }), TSEL);
      await cdpEval(() => { const o = document.getElementById("__ap_ovl"); if (o) o.remove(); });
      var overlayBlocks = p1.overlayHit;
      LOG(`(1) pointer-events:auto overlay + cdpClickAt @ (${r1.cx},${r1.cy}) → overlayHit=${p1.overlayHit}, targetFocused=${p1.targetFocused} ⇒ ${p1.overlayHit ? "a STATIC overlay BLOCKS the bot's own click → must FLAG-GATE/toggle." : (p1.targetFocused ? "overlay did NOT intercept the CDP click (target focused THROUGH it) → a static overlay may suffice." : "neither hit — re-run (click may not have landed).")}`);
    } else { LOG(`(1) SKIPPED — target not in viewport after scroll (${r1 && r1.cx},${r1 && r1.cy}).`); }

    // ── (2) Capture keydown-blocker vs insertText / per-char keys (no coords — focus()+keys) ──
    await cdpEval(() => {
      window.__ap_kd = 0;
      window.__ap_kdh = (e) => { window.__ap_kd++; e.preventDefault(); e.stopPropagation(); };
      document.addEventListener("keydown", window.__ap_kdh, true);
      const t = document.querySelector('[data-ap-recon-target="1"]'); if (t) { t.focus(); t.value = ""; }
    });
    await cdpInsertText("AP"); await cdpDelay(120);
    await cdpTypeChars("XY", 40); await cdpDelay(120);
    const p2 = await cdpEval((sel) => { const t = document.querySelector(sel); const v = t ? t.value : null; document.removeEventListener("keydown", window.__ap_kdh, true); if (t) t.value = ""; return { value: v, kd: window.__ap_kd }; }, TSEL);
    LOG(`(2) capture keydown-blocker ON → cdpInsertText "AP" + cdpTypeChars "XY" → field="${p2.value}" (keydowns blocked: ${p2.kd}) ⇒ insertText ${(p2.value || "").includes("AP") ? "BYPASSES keydown (lands)" : "BLOCKED"}; per-char keys ${(p2.value || "").includes("X") ? "land" : "BLOCKED by the keydown handler"}.`);

    // ── (3) __apActing flag-gate: COST + TOGGLE-TIMING self-block, with a CONTROL ──
    const t0 = Date.now(); for (let i = 0; i < 10; i++) await cdpEval(() => 1);
    const perEval = (Date.now() - t0) / 10;
    LOG(`(3a) cdpEval round-trip ≈ ${perEval.toFixed(1)}ms each (a per-primitive toggle = ~2 of these).`);
    await cdpEval(() => {
      window.__apActing = false; window.__ap_gblk = 0;
      window.__ap_g = (e) => { if (!window.__apActing) { window.__ap_gblk++; e.preventDefault(); e.stopPropagation(); } };
      ["mousedown", "click", "keydown"].forEach((t) => document.addEventListener(t, window.__ap_g, true));
    });
    // gatedClick: re-fresh the rect (re-scroll) → flag true → click → clear per `mode` → read.
    // mode "control": NEVER clear (flag true throughout) → the click MUST land if the mechanism works
    // (so a "self-blocked" in A/B is REAL, not a click-that-never-landed artifact — the hold).
    const gatedClick = async (mode) => {
      const r = await freshTargetRect();
      if (!r || !r.inViewport) return { skipped: true };
      await cdpEval(() => { window.__apActing = true; window.__ap_gblk = 0; const t = document.querySelector('[data-ap-recon-target="1"]'); if (t) t.blur(); });
      await cdpClickAt(r.cx, r.cy);
      if (mode === "dispatch") { await cdpEval(() => { window.__apActing = false; }); await cdpDelay(250); }
      else if (mode === "settle") { await cdpDelay(250); await cdpEval(() => { window.__apActing = false; }); }
      else { await cdpDelay(250); } // control: leave the flag true
      const s = await cdpEval((sel) => ({ focused: document.activeElement === document.querySelector(sel), blocked: window.__ap_gblk }), TSEL);
      await cdpEval(() => { window.__apActing = false; }); // reset for the next sub-probe
      return s;
    };
    const ctl = await gatedClick("control");
    const vA = await gatedClick("dispatch");
    const vB = await gatedClick("settle");
    await cdpEval(() => { ["mousedown", "click", "keydown"].forEach((t) => document.removeEventListener(t, window.__ap_g, true)); });
    const controlLanded = !ctl.skipped && ctl.focused;
    if (!controlLanded) {
      LOG(`(3b) CONTROL (flag true throughout) → ${ctl.skipped ? "SKIPPED (target not in viewport)" : "click did NOT land (blocked=" + ctl.blocked + ")"} ⇒ the click mechanism isn't landing → probe 3 INCONCLUSIVE (artifact). Re-run on a page where the target stays in view.`);
    } else {
      LOG(`(3b) CONTROL landed (the blocker genuinely has a bot event to gate). TOGGLE-TIMING: clear-after-dispatch → ${vA.focused ? "LANDED" : "SELF-BLOCKED (blocked=" + vA.blocked + ")"}; clear-after-settle → ${vB.focused ? "LANDED" : "SELF-BLOCKED (blocked=" + vB.blocked + ")"}. ⇒ ` +
        ((!vA.focused && vB.focused) ? "MUST clear-after-CONFIRM — clear-after-dispatch SELF-BLOCKS (the inverse race is REAL)."
          : (vA.focused && vB.focused) ? "clear-after-dispatch is SAFE (dispatch resolves after propagation)."
            : (!vA.focused && !vB.focused) ? "BOTH self-block despite the control landing → the flag clears too early both ways; clear only on a read-back CONFIRMATION (focus/value changed)."
              : "A landed but B didn't — unexpected; re-run."));
    }

    await cdpEval(() => { const t = document.querySelector('[data-ap-recon-target="1"]'); if (t) t.removeAttribute("data-ap-recon-target"); });
    LOG("done. (No overlay/listener left; the probe typed into + cleared the target.)");
    return { ok: true, overlay_blocks_bot: typeof overlayBlocks === "undefined" ? null : overlayBlocks, insertText_value: p2.value, keydowns_blocked: p2.kd, ms_per_eval: perEval, control_landed: controlLanded, clear_after_dispatch_lands: vA.focused, clear_after_settle_lands: vB.focused };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("input-lock recon aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP FILL WEBSITES (M32b) — the FIRST repeating-section fill on the CDP path.
// Prove driveRepeatingSectionCdp on the date-free Websites section (one url text
// field per entry): attach → hidden-gate → reconcile to N + fill each entry's url →
// NEEDS-REVIEW-first report → detach in finally. Dates are deferred (recon: CDP
// can't actuate spinbuttons); Websites has none. Other sections follow in later
// rounds reusing the same driver. Standalone — RUN_FILL/RUN_CDP_FILL untouched.
// ============================================================================
async function runCdpFillWebsites(tabId, profile) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-WEB]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — the fill starts on the first hidden read (60s window). Run on My Experience (page 2).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, nothing filled.");
      return { ok: false, error: "never-hidden" };
    }
    const prepared = prepareProfile(profile);
    const items = Array.isArray(prepared.websites) ? prepared.websites : [];
    LOG(`tab is hidden — websites fill starting. ${items.length} meaningful website(s). (Δperf ~1000ms on the page loop is EXPECTED, not failure.)`);

    const act = makeCdpActuation();
    const out = await driveRepeatingSectionCdp(act, {
      name: "website", headingRegex: "websites?|web ?address", containerPrefix: "webAddress-",
      items, fieldMap: WEBSITE_MAP, deleteOnNoMatch: false
    }, DEFAULT_BUDGETS);

    LOG("page:", out.url);
    LOG(`════ NEEDS REVIEW (${out.needsReview.length}) ════`);
    for (const r of out.needsReview) {
      LOG(`  ⚠ [${r.status}] ${r.fieldName} (${r.widgetType}) — "${r.label}" → ${r.detail}${r.after ? ` | currently: "${r.after}"` : ""}`);
    }
    console.table(out.results.map((r) => ({
      field: r.fieldName, type: r.widgetType, status: r.status, after: r.after,
      verified: r.verified, flag: r.flag, detail: r.detail
    })));
    LOG("counts:", JSON.stringify(out.counts));
    return { ok: true, counts: out.counts, needs_review: out.needsReview.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("websites fill aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP FILL LANGUAGES (M35) — reuse driveRepeatingSectionCdp for the date-free Languages
// section: language dropdown + 3 proficiency dropdowns resolved BY LABEL (hashed ids,
// IDENTICAL across entries → resolution stays entry-scoped) + the "I am fluent" checkbox.
// deleteOnNoMatch:true (a required pick that can't match blocks Next → delete the entry).
// FIRST live exercise of the labelRegex/hashed-id resolve path. [CDP-LANG] in the SW console.
// ============================================================================
async function runCdpFillLanguages(tabId, profile) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-LANG]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — the fill starts on the first hidden read (60s window). Run on My Experience (page 2).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, nothing filled.");
      return { ok: false, error: "never-hidden" };
    }
    const prepared = prepareProfile(profile);
    const items = Array.isArray(prepared.languages) ? prepared.languages : [];
    LOG(`tab is hidden — languages fill starting. ${items.length} meaningful language(s). (Δperf ~1000ms on the page loop is EXPECTED, not failure.)`);

    const act = makeCdpActuation();
    const out = await driveRepeatingSectionCdp(act, {
      name: "language", headingRegex: "languages?", containerPrefix: "language-",
      items, fieldMap: LANGUAGE_MAP, deleteOnNoMatch: true
    }, DEFAULT_BUDGETS);

    LOG("page:", out.url);
    LOG(`════ NEEDS REVIEW (${out.needsReview.length}) ════`);
    for (const r of out.needsReview) {
      LOG(`  ⚠ [${r.status}] ${r.fieldName} (${r.widgetType}) — "${r.label}" → ${r.detail}${r.after ? ` | currently: "${r.after}"` : ""}`);
    }
    console.table(out.results.map((r) => ({
      field: r.fieldName, type: r.widgetType, status: r.status, after: r.after,
      verified: r.verified, flag: r.flag, detail: r.detail
    })));
    LOG("counts:", JSON.stringify(out.counts));
    return { ok: true, counts: out.counts, needs_review: out.needsReview.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("languages fill aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP FILL WORK EXPERIENCE (M37 Part 1) — the bespoke section via the SAME
// driveRepeatingSectionCdp. WORK_EXPERIENCE_MAP fills jobTitle/companyName/location
// (text), currentlyWorkHere FIRST (checkbox — controls the To box), from/to M/Y dates,
// and roleDescription (<textarea> ← bulletsText, recon 2026-06-18). endDate is skipWhen
// currently_work_here + waitForPresence (remount poll, never a fixed wait). deleteOnNoMatch
// OFF (WE flags, never deletes). Run on My Experience (page 2). [CDP-WE] in the SW console.
// ============================================================================
async function runCdpFillWorkExperience(tabId, profile) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-WE]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — the fill starts on the first hidden read (60s window). Run on My Experience (page 2).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, nothing filled.");
      return { ok: false, error: "never-hidden" };
    }
    const prepared = prepareProfile(profile);
    const items = Array.isArray(prepared.work_experience) ? prepared.work_experience : [];
    LOG(`tab is hidden — work-experience fill starting. ${items.length} meaningful entr(y/ies). (Δperf ~1000ms on the page loop is EXPECTED, not failure.)`);

    const act = makeCdpActuation();
    const out = await driveRepeatingSectionCdp(act, {
      name: "workExperience", headingRegex: "work experience", containerPrefix: "workExperience-",
      items, fieldMap: WORK_EXPERIENCE_MAP, deleteOnNoMatch: false
    }, DEFAULT_BUDGETS);

    LOG("page:", out.url);
    LOG(`════ NEEDS REVIEW (${out.needsReview.length}) ════`);
    for (const r of out.needsReview) {
      LOG(`  ⚠ [${r.status}] ${r.fieldName} (${r.widgetType}) — "${r.label}" → ${r.detail}${r.after ? ` | currently: "${r.after}"` : ""}`);
    }
    console.table(out.results.map((r) => ({
      field: r.fieldName, type: r.widgetType, status: r.status, after: r.after,
      verified: r.verified, flag: r.flag, detail: r.detail
    })));
    LOG("counts:", JSON.stringify(out.counts));
    return { ok: true, counts: out.counts, needs_review: out.needsReview.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("work-experience fill aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP FILL EDUCATION (M36) — reuse driveRepeatingSectionCdp for the Education section:
// schoolName text / degree dropdown (tiered) / fieldOfStudy typeahead / gradeAverage→gpa text /
// from+to YEAR dates (the M34 composite, now un-deferred via fillEntryCdp). NOT deleteOnNoMatch
// (flag for review, never delete). The clean dates-in-section proof (year dates, entry survives).
// [CDP-EDU] in the SW console. Detaches in finally.
// ============================================================================
async function runCdpFillEducation(tabId, profile) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-EDU]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — the fill starts on the first hidden read (60s window). Run on My Experience (page 2).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, nothing filled.");
      return { ok: false, error: "never-hidden" };
    }
    const prepared = prepareProfile(profile);
    const items = Array.isArray(prepared.education) ? prepared.education : [];
    LOG(`tab is hidden — education fill starting. ${items.length} meaningful entr(y/ies). (Δperf ~1000ms on the page loop is EXPECTED, not failure.)`);

    const act = makeCdpActuation();
    const out = await driveRepeatingSectionCdp(act, {
      name: "education", headingRegex: "education", containerPrefix: "education-",
      items, fieldMap: EDUCATION_MAP, deleteOnNoMatch: false
    }, DEFAULT_BUDGETS);

    LOG("page:", out.url);
    LOG(`════ NEEDS REVIEW (${out.needsReview.length}) ════`);
    for (const r of out.needsReview) {
      LOG(`  ⚠ [${r.status}] ${r.fieldName} (${r.widgetType}) — "${r.label}" → ${r.detail}${r.after ? ` | currently: "${r.after}"` : ""}`);
    }
    console.table(out.results.map((r) => ({
      field: r.fieldName, type: r.widgetType, status: r.status, after: r.after,
      verified: r.verified, flag: r.flag, detail: r.detail
    })));
    LOG("counts:", JSON.stringify(out.counts));
    return { ok: true, counts: out.counts, needs_review: out.needsReview.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("education fill aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// CDP FILL CERTIFICATIONS (M36) — reuse driveRepeatingSectionCdp for the Certifications
// section: certification typeahead (required) / certificationNumber text / issued+expiration
// M/D/Y dates (the M34 composite, un-deferred). deleteOnNoMatch:true (optional pick section).
// The M/D/Y-in-section proof (3-segment auto-advance) — needs a MATCHING cert name to render.
// [CDP-CERT] in the SW console. Detaches in finally.
// ============================================================================
async function runCdpFillCertifications(tabId, profile) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-CERT]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — the fill starts on the first hidden read (60s window). Run on My Experience (page 2).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, nothing filled.");
      return { ok: false, error: "never-hidden" };
    }
    const prepared = prepareProfile(profile);
    const items = Array.isArray(prepared.certifications) ? prepared.certifications : [];
    LOG(`tab is hidden — certifications fill starting. ${items.length} meaningful cert(s). (Δperf ~1000ms on the page loop is EXPECTED, not failure.)`);

    const act = makeCdpActuation();
    const out = await driveRepeatingSectionCdp(act, {
      name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
      items, fieldMap: CERTIFICATION_MAP, deleteOnNoMatch: true
    }, DEFAULT_BUDGETS);

    LOG("page:", out.url);
    LOG(`════ NEEDS REVIEW (${out.needsReview.length}) ════`);
    for (const r of out.needsReview) {
      LOG(`  ⚠ [${r.status}] ${r.fieldName} (${r.widgetType}) — "${r.label}" → ${r.detail}${r.after ? ` | currently: "${r.after}"` : ""}`);
    }
    console.table(out.results.map((r) => ({
      field: r.fieldName, type: r.widgetType, status: r.status, after: r.after,
      verified: r.verified, flag: r.flag, detail: r.detail
    })));
    LOG("counts:", JSON.stringify(out.counts));
    return { ok: true, counts: out.counts, needs_review: out.needsReview.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("certifications fill aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// TARGETED DATE FILL (M34 verify harness) — fill ONE date composite located by
// label regex (entry-scoped) via fillDateCompositeCdp HIDDEN, to prove the date
// handler on all three shapes (WE M/Y, Education year-only, Certs M/D/Y) BEFORE
// wiring dates into the section fill (M35). Values come from prepareProfile's
// parsed annotations (NOT FIELD_MAP — that's the flat-page contract). The result's
// `detail` shows the per-segment focusRung/inputMethod (esp. the standalone year).
// [CDP-DATE] in the SW console. Detaches in finally.
// ============================================================================
const DATE_ENTRY_VALUES = {
  startDate: (p) => p && p.work_experience && p.work_experience[0] ? p.work_experience[0].fromParsed : undefined,
  endDate: (p) => p && p.work_experience && p.work_experience[0] ? p.work_experience[0].toParsed : undefined,
  firstYearAttended: (p) => p && p.education && p.education[0] ? p.education[0].fromYearParsed : undefined,
  lastYearAttended: (p) => p && p.education && p.education[0] ? p.education[0].toYearParsed : undefined,
  issuedDate: (p) => p && p.certifications && p.certifications[0] ? p.certifications[0].issuedDateParsed : undefined,
  expirationDate: (p) => p && p.certifications && p.certifications[0] ? p.certifications[0].expirationDateParsed : undefined
};

async function runCdpFillDate(tabId, profile, labelRegexStr) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-DATE]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) {
      LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)");
      return { ok: false, error: "attach-failed:" + attached.error };
    }
    LOG("attached. MINIMIZE THE WINDOW NOW — the fill starts on the first hidden read (60s window). Run on My Experience (page 2).");
    if (!(await cdpWaitHidden(60000, 500))) {
      LOG("tab never went hidden — INVALID run, nothing filled.");
      return { ok: false, error: "never-hidden" };
    }
    let re;
    try { re = new RegExp(labelRegexStr || ".", "i"); } catch (e) { LOG("bad label regex:", JSON.stringify(labelRegexStr)); return { ok: false, error: "bad-regex" }; }

    const scan = await cdpEval(cdpRepeatingScan);
    let target = null;
    for (const prefix of (scan ? scan.sectionsPresent : [])) {
      for (const e of scan.sections[prefix].entries) {
        const f = e.fields.find((x) => x.dateSegments.length > 0 && (re.test(x.label || "") || re.test(x.fieldName)));
        if (f) { target = { prefix, field: f }; break; }
      }
      if (target) break;
    }
    if (!target) {
      LOG("no date field matching", JSON.stringify(labelRegexStr), "— date fields on this page:",
        JSON.stringify((scan ? scan.sectionsPresent : []).flatMap((p) => scan.sections[p].entries.flatMap((e) => e.fields.filter((f) => f.dateSegments.length > 0).map((f) => ({ field: f.fieldName, label: f.label }))))));
      return { ok: false, error: "no-match" };
    }
    LOG("target:", target.field.fieldName, "—", JSON.stringify(target.field.label), "| sel:", target.field.wrapperSel);

    const prepared = prepareProfile(profile);
    const getter = DATE_ENTRY_VALUES[target.field.fieldName];
    const parsed = getter ? getter(prepared) : undefined;
    if (!parsed) {
      LOG("no parsed date value for", target.field.fieldName, "— check the profile (work_experience/education/certifications entry 0).");
      return { ok: false, error: "no-value" };
    }
    LOG("value (parsed):", JSON.stringify(parsed));
    LOG("tab is hidden — date fill starting. (Δperf ~1000ms on the page loop is EXPECTED, not failure.)");

    const act = makeCdpActuation();
    const rec = await fillDateCompositeCdp(act, { wrapperSel: target.field.wrapperSel }, parsed, DEFAULT_BUDGETS);
    LOG("result:", JSON.stringify({ field: target.field.fieldName, status: rec.status, after: rec.after, verified: rec.verified, detail: rec.detail }, null, 2));
    return { ok: true, status: rec.status, after: rec.after || null, verified: rec.verified === true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("date fill aborted:", msg);
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
// MAX_PAGES cap. The CDP attach SURVIVES navigation (only Runtime+DOM enabled, no Page
// domain) — no re-injection; we re-read via cdpEval on the same attach. Detaches in
// finally. SUBMIT-NEVER (double guard, reused verbatim from M31): the review terminal
// is checked at the TOP of each iteration BEFORE any fill/click, AND clickPageNext
// refuses on the review marker. Review-page reached = SUCCESS (walked the whole app).
// ============================================================================

// Page signature for transition detection: url + the sorted formField name set
// (the field-set delta is the load-bearing signal — pageId alone is shared across
// pages on some tenants; dom-patterns).
function cdpPageSig(scan) {
  return (scan && scan.fields) ? scan.url + "|" + scan.fields.map((f) => f.fieldName).sort().join(",") : null;
}

// Poll SW-side after Save & Continue: a fresh dead-session read FIRST (a dead session
// shows VPS banners on the SAME page — no transition — so sessionLooksDead is what
// fires), else a hydrated page-signature change (steady across two reads). Mid-nav
// read errors are "not ready, keep polling".
async function cdpWaitNextPage(prevSig, timeoutMs = 15000, intervalMs = 500) {
  const start = Date.now();
  let steady = -1;
  while (Date.now() - start < timeoutMs) {
    await cdpDelay(intervalMs);
    let state = null;
    try { state = await cdpEval(cdpReadSessionState); } catch (e) { continue; }
    if (state && sessionLooksDead(state)) return { advanced: false, sessionDead: true, state };
    let scan = null;
    try { scan = await cdpEval(cdpPageScan); } catch (e) { continue; }
    if (!scan || !scan.fields || scan.fields.length === 0) { steady = -1; continue; } // not hydrated
    const sig = cdpPageSig(scan);
    if (sig === prevSig) { steady = -1; continue; } // still page 1
    if (scan.fields.length === steady) return { advanced: true, sig };
    steady = scan.fields.length;
  }
  return { advanced: false, timeout: true };
}

const WALK_MAX_PAGES = 8; // generous cap; the review/terminal/session checks are the REAL stops — this only bounds a detection bug from looping forever.

async function runCdpWalk(tabId, profile, defaults, jobContext) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-WALK]", ...a);

  // M31.1: surface the EXACT page error text + the fields left EMPTY (no profile value —
  // the likely "required" validation cause) on a stop-with-errors. Takes the CURRENT page's
  // results (per-page in the loop). Reads error state FRESH (errors render post Save & Continue).
  const reportPageErrors = async (pageOut) => {
    let st = null;
    try { st = await cdpEval(cdpReadSessionState); } catch (e) { /* ignore */ }
    const samples = (st && st.errorMarkers && st.errorMarkers.samples) || [];
    if (samples.length) { LOG(`page errors (${samples.length}):`); samples.forEach((s) => LOG(`    • ${s}`)); }
    if (st && st.errorPageText) LOG(`error-page text: ${st.errorPageText}`);
    if (!samples.length && !(st && st.errorPageText)) LOG("(no error text captured on the page)");
    const empties = (pageOut && pageOut.results || []).filter((r) => r.status === "skipped");
    if (empties.length) {
      LOG("fields left EMPTY (no value in the profile/JSON — the likely validation cause):");
      empties.forEach((r) => LOG(`    • ${r.fieldName} — ${r.detail}`));
    }
    return { page_errors: samples, error_page_text: st ? (st.errorPageText || null) : null, empty_fields: empties.map((r) => ({ field: r.fieldName, reason: r.detail })) };
  };

  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    // Foreground fast-fill (M39): NO hidden-gate — fills immediately, visible=fast (watch the
    // whole walk) or minimize=slow/background, adapting live.
    LOG("attached. Walk starting — keep the tab VISIBLE to watch (fast) or minimize (slow/background). Fills each page → guarded Save & Continue → repeats to the REVIEW page (NEVER submits).");
    LOG("PREREQ: clear any recon-mounted orphan cert Specialties first — an empty REQUIRED specialty blocks Save & Continue (a false nav-timeout halt at the cert page).");

    // CLEAR the accumulated summary ONCE at walk START, OUTSIDE the loop (its own guard):
    // a fresh application starts clean. The loop only calls the ACCUMULATING persist — a
    // mid-walk clear (from re-entry) would wipe the pages already filled.
    await new Promise((resolve) => chrome.storage.local.remove(["reviewSummary", "reviewAudit"], resolve));
    LOG("cleared the prior review summary + audit (fresh application).");

    const prepared = prepareProfile(profile); // once — each page fills what its own scan presents
    const act = makeCdpActuation(await getLlmConfig()); // AI-0 seam: act.llm bound to the operator's config (OFF unless the toggle is on)
    const pagesFilled = [];

    for (let page = 1; page <= WALK_MAX_PAGES; page++) {
      // ── (a/b) TOP-OF-ITERATION guards: session-death + the REVIEW terminal (SUBMIT-NEVER —
      // checked BEFORE any fill/click, so we never fill or advance the review page). ──
      let nav = null;
      try { nav = await cdpEval(cdpReadSessionState); } catch (e) { /* treat as not-ready below */ }
      if (nav && sessionLooksDead(nav)) {
        LOG(`⚠⚠ SESSION EXPIRED at page ${page} (login/VPS/no-form) — refresh, log in, reopen the form, retry.`);
        const diag = await reportPageErrors(null);
        return { ok: true, stopped: "session-expired", session_expired: true, pages_filled: pagesFilled.length, pages: pagesFilled, ...diag };
      }
      if (nav && nav.applyFlowReviewPresent) {
        LOG(`✓✓ reached the REVIEW page after ${pagesFilled.length} page(s) — the whole application is filled. NOT submitting (terminal). "View last summary" for the accumulated bundle.`);
        return { ok: true, stopped: "reached-review", reached_review: true, pages_filled: pagesFilled.length, pages: pagesFilled };
      }

      // ── (c) Fill this (non-review) page: fold + inline M40 audit + accumulate. ──
      LOG(`──── PAGE ${page} ────`);
      const prevSig = cdpPageSig(await cdpEval(cdpPageScan));
      const { out, pageKey } = await fillAndPersistPage(act, prepared, defaults, jobContext, LOG);
      pagesFilled.push({ page, url: out.url, counts: out.counts, needs_review: out.needsReview.length, audit_flagged: out.results.filter((r) => r.flag === "audit-mismatch" || r.flag === "audit-unverifiable").length });

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
      const click = await act.clickPageNext();
      LOG(`page ${page} Save & Continue:`, JSON.stringify(click));
      if (!click.clicked) {
        LOG(`advance refused on page ${page} (${click.refused}) — stop.`);
        return { ok: true, stopped: "click-refused:" + (click.refused || "?"), pages_filled: pagesFilled.length, pages: pagesFilled };
      }

      // ── (f) Wait for the transition OR session-death OR a nav-timeout (dirty halt). ──
      const res = await cdpWaitNextPage(prevSig);
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
        const rem = await remediatePageErrors(act, prepared, defaults, jobContext, out, pageKey, page, LOG);
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
        LOG(`⚠ nav-timeout on page ${page} — AI-4 remediation (${rem.attempts} attempt(s), ${rem.reason}) did NOT clear it. PAGE ${page} MAY NOW BE DIRTY — eyeball it; do NOT re-run as if fresh. Errors + empty fields:`);
        const diag = await reportPageErrors(out);
        return { ok: true, stopped: "nav-timeout-dirty", nav_timeout_page: page, remediation: { attempts: rem.attempts, reason: rem.reason, actions: rem.actions }, pages_filled: pagesFilled.length, pages: pagesFilled, ...diag };
      }
      LOG(`✓ page ${page} → advanced.`);
      // res.advanced → next iteration (top-of-loop re-checks review/session on the new page).
    }

    LOG(`⚠ hit the ${WALK_MAX_PAGES}-page cap without reaching review — stopping (a detection-bug backstop). Eyeball the application.`);
    return { ok: true, stopped: "max-pages-cap", pages_filled: pagesFilled.length, pages: pagesFilled };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("walk aborted:", msg);
    return { ok: false, error: "exception:" + msg };
  } finally {
    await removeInputLock(); // BEFORE detach (needs the attach) — never strand the operator behind the lock
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
  const matchCandidates = (candidates, optionTexts) => {
    // Tier 1: exact after normalize() (which strips a trailing "(+N)").
    for (const cand of candidates) {
      const nc = normalize(cand);
      const idx = optionTexts.findIndex((t) => normalize(t) === nc);
      if (idx !== -1) return { targetIndex: idx, matchTier: "exact-normalized", matchedCandidate: cand };
    }
    // Tier 2: containment — startsWith, then includes.
    for (const cand of candidates) {
      const nc = normalize(cand);
      let idx = optionTexts.findIndex((t) => normalize(t).startsWith(nc));
      if (idx === -1) idx = optionTexts.findIndex((t) => normalize(t).includes(nc));
      if (idx !== -1) return { targetIndex: idx, matchTier: "containment", matchedCandidate: cand };
    }
    // Tier 3: fuzzy >= 90 — typo tolerance only.
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

    const { targetIndex, matchTier } = matchCandidates(candidates, optionTexts);
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

    const { targetIndex, matchTier } = matchCandidates(candidates, optionTexts);
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

        // Match via the shared ladder against data-automation-label, then textContent.
        const labels = leaves.map(leafLabel);
        let m = matchCandidates([cand], labels);
        if (m.targetIndex === -1) {
          const texts = leaves.map((el) => (el.textContent || "").trim());
          m = matchCandidates([cand], texts);
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
        // Level-1 leaf?
        const l1leaves = scrapeRows().filter((el) => !isCategory(el));
        const l1texts = l1leaves.map((el) => el.textContent.trim());
        const m = matchCandidates([cand], l1texts);
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
          const sm = matchCandidates([cand], subTexts);
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
        // from application_defaults (how_did_you_hear), NOT the profile.
        const hdyh = defaults && defaults.how_did_you_hear;
        if (!hdyh || !Array.isArray(hdyh.preferred)) {
          record.status = "needs_review";
          record.detail = "no how_did_you_hear defaults loaded";
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
  const SCHEMA_VERSION = "1.0";

  // Page-container automation-id (e.g. "applyFlowMyInfoPage"); URL-path fallback.
  const pageEl =
    document.querySelector('[data-automation-id^="applyFlow"][data-automation-id$="Page"]') ||
    document.querySelector('[data-automation-id$="Page"]');
  const pageId = pageEl
    ? pageEl.getAttribute("data-automation-id")
    : (location.pathname.split("/").filter(Boolean).pop() || location.pathname);

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
    const current_value = fill_status === "filled" && rec.after != null ? rec.after : null;
    return {
      field_id: "formField-" + rec.fieldName,
      page: pageId,
      field_index: index,
      question_label: rec.label != null ? rec.label : null,
      widget_type: rec.widgetType,
      canonical_field: rec.mappedPath != null ? rec.mappedPath : null,
      is_required: !!rec.isRequired,
      current_value,
      original_ai_value: current_value, // the bot's pick at write time — never changed by edits
      is_edited: false,                 // human changed the effective value (set by the summary editor)
      edit_kind: null,                  // provenance for replay: override | filled_blank | cleared | null
      confidence,
      confidence_source,
      needs_review,
      needs_review_reason,
      fill_status,
      fill_error: rec.status === "error" ? (rec.detail || null) : null,
      detail: rec.detail != null ? rec.detail : null,
      match_tier: rec.matchTier != null ? rec.matchTier : null,
      options: Array.isArray(rec.options) ? rec.options : null,
      captured_options: Array.isArray(rec.captured_options) ? rec.captured_options : null,
      character_count: null // reserved for textareas
    };
  };

  const entries = results.map((rec, i) => buildEntry(rec, i));
  const bundle = {
    schema_version: SCHEMA_VERSION,
    page: pageId,
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
async function attachResume(base64, filename, mime) {
  if (!base64) return { attached: false, detail: "no resume bytes passed (empty base64)" };

  // Re-resolve EVERYTHING fresh from the document on each read. Workday REPLACES the
  // resume-section subtree on re-render during the rapid sequential deletes, so a node
  // captured once (section/scope/input) goes detached/stale mid-loop — its queries
  // then read a frozen count and clicks land on detached buttons (this is why 3
  // attachments only cleared 2). These closures re-query each call → immune to the
  // subtree being swapped out. (The section's wrapper automation-id is the empty
  // "formField-", so we anchor on the stable data-fkit-id.)
  const findSection = () => document.querySelector('[data-fkit-id="resumeAttachments--attachments"]') || document;
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

