// Shared IndexedDB storage helpers (saveResume/getResume/RESUME_KEY). Classic MV3
// service worker, so importScripts brings db.js's functions into the SW scope (the
// popup loads the same file via <script>). Used by the M16.2 attach path to read
// the stored resume's bytes here, then pass them as a string into the injection.
importScripts("db.js", "lib.js", "cdp.js", "fill-driver.js"); // db.js = IndexedDB storage; lib.js = pure helpers (parse*, match ladder); cdp.js = CDP substrate (off-loop actuation); fill-driver.js = the substrate-agnostic CDP fill brain (needs lib.js loaded first)

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

  // TYPEAHEAD RECON (M25 Step 1): empirically answer, on a live typeahead with
  // the tab HIDDEN, the can't-guess questions the CDP typeahead port is built
  // on — filter trigger (a), throttled settle timing (b), commit method (c),
  // chip commit signal (d), no-match banner (e), listbox self-close (f), plus
  // WHICH option scope resolves real options (aria-controls vs page-wide).
  // Probes only the first CHIPLESS typeahead; pre-filled ones are reported
  // read-only (the countryPhoneCode case). NO chip deletion — read-only dump.
  if (message.type === "RUN_CDP_TA_RECON") {
    // Profile is read so the probe query is FIELD-AWARE (the field's own
    // profile-resolved candidates) — a hardcoded query banners on fields whose
    // vocabulary doesn't contain it (the round-2 lesson). Missing profile →
    // the driver falls back to ["Other"] with a loud log.
    chrome.storage.local.get(["profile"], ({ profile }) => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpTypeaheadRecon(tab.id, profile);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // OVERWRITE RECON (M27 Step 0): probe the POPULATED-field model on a typeahead
  // that ALREADY holds a hand-seeded WRONG chip — searchBox-while-populated (a),
  // clearSearch preserves the chip (a2), commit REPLACES vs ADDS (b). Field-aware
  // (profile candidate must differ from the seeded chip). [OVR-RECON] in the SW
  // console. Profile read so the probe restores the field's correct value.
  if (message.type === "RUN_CDP_OVERWRITE_RECON") {
    chrome.storage.local.get(["profile"], ({ profile }) => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpOverwriteRecon(tab.id, profile);
        sendResponse(out);
      });
    });
    return true; // async sendResponse
  }

  // SOURCE OVERWRITE RECON (M27 Step 0, source half): prove clearSourceSearch
  // preserves a SEEDED source chip before Commit B's source no-match path relies
  // on it. Candidates from defaults.how_did_you_hear. [OVR-SRC-RECON] in the SW
  // console.
  if (message.type === "RUN_CDP_SOURCE_OVERWRITE_RECON") {
    chrome.storage.local.get(["defaults"], ({ defaults }) => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpSourceOverwriteRecon(tab.id, defaults);
        sendResponse(out);
      });
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

  // TARGETED TYPEAHEAD FILL (M25 verify harness): fill ONE typeahead located by
  // label regex — including a field inside a repeating entry (entry-1 scoped
  // via selector composition) — through the full fillTypeaheadCdp brain while
  // hidden. Page-2 entry fields (fieldOfStudy/certification) aren't in
  // FIELD_MAP (that map is flat-page only), so their candidates come from a
  // harness-side lookup. Results land as [CDP-TA] in the SW console.
  if (message.type === "RUN_CDP_FILL_TA") {
    chrome.storage.local.get(["profile"], ({ profile }) => {
      if (!profile) {
        console.log('[ApplyPilot][CDP-TA] No profile in storage — click "Load default profile" first.');
        sendResponse({ ok: false, error: "no-profile" });
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpFillTypeahead(tab.id, profile, String(message.labelRegex || ""));
        sendResponse(out);
      });
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

  // SOURCE RECON (tree/source picker, backlog C — Phase A, map-only): characterize
  // the live "How did you hear about us?" hierarchical picker HIDDEN — open, classify
  // path (search vs expand-walk), map the tree, locate LinkedIn, test the EXPAND
  // mechanism non-committingly, read the commit-signal attributes. NEVER selects a
  // leaf (Phase B, next round). Findings: [CDP-SRC-RECON] in the SW console.
  if (message.type === "RUN_CDP_SOURCE_RECON") {
    chrome.storage.local.get(["defaults"], ({ defaults }) => {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const out = await runCdpSourceRecon(tab.id, defaults);
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
// SOURCE RECON — tree/source picker, backlog C, Phase A (map-only, NO leaf-select).
// Characterizes the live "How did you hear about us?" hierarchical picker hidden:
// open → classify path (search vs expand-walk) → map the tree → locate LinkedIn →
// test the EXPAND mechanism non-committingly → read commit-signal attributes.
// Reference: in-tree page-substrate fillSource (search path = promptOption leaves
// filtered on Enter; expand-walk = role=option/treeitem rows, click a category to
// reveal sub-rows; aria-controls is a promptAriaInstruction DECOY; commit signal =
// multiselectlistitem selected-state). NEVER clicks a leaf (Phase B is next round).
// ⚠ Search path: filtering needs type+Enter; to dodge a single-exact auto-commit,
// Phase A types a BROAD prefix ("Link"), reads the chip after, and reports loudly
// if anything auto-committed (never a leaf-click). Detaches in finally.
// ============================================================================
async function runCdpSourceRecon(tabId, defaults) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-SRC-RECON]", ...a);
  const R = { q1_structure: {}, q2_open: {}, q3_ariaControls: {}, q4_drill: {}, q5_commitAttrs: {}, tree: {}, sideEffects: [], errors: [] };
  const WRAP = '[data-automation-id="formField-source"]';
  const TARGET = "LinkedIn"; // the value of interest (located, NOT selected this round)
  const guard = async (name, fn) => {
    try { await fn(); } catch (e) { const m = name + ": " + String((e && e.message) || e); R.errors.push(m); LOG("probe ERROR —", m); }
  };
  const read = () => cdpEval(cdpReadSourceState, WRAP);

  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    LOG("attached. MINIMIZE THE WINDOW NOW — recon starts on the first hidden read (60s window).");
    if (!(await cdpWaitHidden(60000, 500))) { LOG("tab never went hidden — INVALID run."); return { ok: false, error: "never-hidden" }; }
    LOG("tab is hidden — source recon starting (Phase A, map-only, NO leaf-select).");

    // Locate the field + its opener (union ladder, mirror fillSource).
    const found = await cdpEval((wrapperSel) => {
      const w = document.querySelector(wrapperSel);
      if (!w) return null;
      const opener =
        (w.querySelector('button[aria-haspopup="listbox"]') && "button") ||
        (w.querySelector('[data-automation-id="multiselectInputContainer"]') && "multiselectInputContainer") ||
        (w.querySelector('[data-uxi-widget-type="selectinput"]') && "selectinput") ||
        (w.querySelector("input") && "input") || "wrapper";
      const legend = w.querySelector("legend");
      let label = legend ? legend.textContent.trim() : null;
      if (!label) { for (const l of w.querySelectorAll("label")) { const t = (l.textContent || "").trim(); if (t) { label = t; break; } } }
      return { opener, label, preChips: Array.from(w.querySelectorAll('[data-automation-id="selectedItem"]')).map((c) => (c.textContent || "").trim()) };
    }, WRAP);
    if (!found) { LOG("no formField-source on this page — navigate to My Information and re-run."); return { ok: true, present: false }; }
    LOG("source field:", JSON.stringify(found));
    R.q2_open.opener = found.opener;
    R.q2_open.label = found.label;
    R.q2_open.preExistingChips = found.preChips;
    if (found.preChips.length) { LOG("⚠ source already has a chip:", JSON.stringify(found.preChips), "— remove it by hand if you want a clean map."); }

    // ── (Q2) open via the opener ladder ─────────────────────────────────────
    let st = null;
    await guard("open", async () => {
      const openerSel =
        found.opener === "button" ? WRAP + ' button[aria-haspopup="listbox"]'
        : found.opener === "multiselectInputContainer" ? WRAP + ' [data-automation-id="multiselectInputContainer"]'
        : found.opener === "selectinput" ? WRAP + ' [data-uxi-widget-type="selectinput"]'
        : found.opener === "input" ? WRAP + " input" : WRAP;
      const rect = await cdpEval(cdpRectOf, openerSel, true);
      if (!rect || rect.w <= 0) throw new Error("opener rect dead (" + found.opener + ")");
      await cdpClickAt(rect.cx, rect.cy);
      await cdpDelay(800);
      st = await read();
      R.q2_open.searchBoxPresent = !!(st && st.searchBox.present);
      R.q2_open.searchBoxVisible = !!(st && st.searchBox.present && st.searchBox.visible);
      R.q2_open.initialRowCount = st ? st.rowCount : null;
      R.q2_open.initialPromptOptionCount = st ? st.promptOptionCount : null;
      R.q2_open.initialRows = st ? st.rows : null;
      LOG("(Q2) opened:", JSON.stringify({ searchBox: R.q2_open.searchBoxVisible, rows: R.q2_open.initialRowCount, promptOptions: R.q2_open.initialPromptOptionCount }));
      LOG("(Q2) initial rows (top-level):", JSON.stringify(st ? st.rows : null, null, 2));
    });

    const path = st && st.searchBox.present ? "search" : "expand-walk";
    R.q1_structure.path = path;
    LOG("PATH:", path);

    // ── (Q3) aria-controls decoy ────────────────────────────────────────────
    R.q3_ariaControls = st && st.searchBox.present ? st.searchBox.ariaControls : { note: "no searchBox (expand-walk path) — no aria-controls" };
    LOG("(Q3) searchBox aria-controls:", JSON.stringify(R.q3_ariaControls));

    if (path === "search") {
      // ── (Q1/Q4 search): focus searchBox, type a BROAD prefix + Enter to FILTER
      //    (NOT exact "LinkedIn" — dodge a single-exact auto-commit), read leaves. ──
      await guard("search-filter", async () => {
        await cdpEval(cdpFocusBySel, WRAP + ' input[data-automation-id="searchBox"]');
        await cdpSelectAllDelete();
        await cdpDelay(150);
        await cdpTypeChars("Link", 40); // broad prefix
        await cdpDelay(300);
        await cdpKeyTap(CDP_KEYS.enter); // these filter on ENTER, not live
        // settle: wait for promptOption leaves to render (generous, throttled)
        let s = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
          await cdpDelay(400);
          s = await read();
          if (s && (s.promptOptionCount > 0 || s.banner || s.chips.length)) break;
        }
        st = s;
        R.q4_drill = { mechanism: "search/Enter-filter", typed: "Link", settleMs: Date.now() - t0, banner: !!(s && s.banner) };
        R.q1_structure.leafSelector = '[data-automation-id="promptOption"]';
        R.q1_structure.filteredLeaves = s ? s.promptOptions : null;
        R.q1_structure.filteredLeafCount = s ? s.promptOptionCount : null;
        const linkedinLeaf = s && s.promptOptions.find((o) => /linkedin/i.test(o.label || ""));
        R.q1_structure.linkedInIsDirectLeaf = !!linkedinLeaf;
        R.q1_structure.linkedInLeaf = linkedinLeaf || null;
        LOG("(Q1) 'Link'-filtered leaves:", JSON.stringify(s ? s.promptOptions : null, null, 2));
        LOG("(Q1) LinkedIn is a direct leaf:", R.q1_structure.linkedInIsDirectLeaf);
        // chip-check: did the Enter-filter accidentally auto-commit?
        if (s && s.chips.length) { R.sideEffects.push(`source auto-committed a chip during the filter: ${JSON.stringify(s.chips)} — NOT a leaf-click; review`); LOG("⚠ AUTO-COMMIT during filter:", JSON.stringify(s.chips)); }
      });

      // ── (Q5 read-only) what selected-state markers exist on the LinkedIn leaf ──
      await guard("commit-attrs", async () => {
        const probe = await cdpEval(cdpSourceLeafProbe, TARGET);
        R.q5_commitAttrs = probe;
        LOG("(Q5 read-only) LinkedIn leaf probe (rect + commit-wrapper attrs, NO click):", JSON.stringify(probe, null, 2));
      });
    } else {
      // ── (Q1) expand-walk: top-level already in st.rows; locate LinkedIn or its parent ──
      const topLeaves = (st ? st.rows : []).filter((r) => !r.isCategory);
      const topCats = (st ? st.rows : []).filter((r) => r.isCategory);
      R.q1_structure.topLevelLeaves = topLeaves.map((r) => r.label);
      R.q1_structure.topLevelCategories = topCats.map((r) => r.label);
      const liTop = topLeaves.find((r) => /linkedin/i.test(r.label || ""));
      R.q1_structure.linkedInIsTopLevel = !!liTop;
      LOG("(Q1) top-level leaves:", JSON.stringify(R.q1_structure.topLevelLeaves), "| categories:", JSON.stringify(R.q1_structure.topLevelCategories));

      if (!liTop && topCats.length) {
        // ── (Q4) drill: expand the FIRST category (trusted click) → did it expand? ──
        await guard("expand-probe", async () => {
          const cat = topCats[0];
          const catRect = await cdpEval(cdpSourceCategoryRect, cat.label);
          if (!catRect.found || !catRect.rect || catRect.rect.w <= 0) { R.q4_drill = { mechanism: "expand-click", category: cat.label, rectLive: false, note: "category rect dead" }; return; }
          await cdpClickAt(catRect.rect.cx, catRect.rect.cy);
          await cdpDelay(1000);
          const after = await read();
          R.q4_drill = {
            mechanism: "expand-click", category: cat.label,
            ariaExpandedBefore: catRect.ariaExpandedBefore,
            rowCountBefore: st ? st.rowCount : null,
            rowCountAfter: after ? after.rowCount : null,
            expandedOk: !!(after && after.rowCount > (st ? st.rowCount : 0)),
            rowsAfter: after ? after.rows : null
          };
          LOG("(Q4) expand '" + cat.label + "':", JSON.stringify({ before: R.q4_drill.rowCountBefore, after: R.q4_drill.rowCountAfter, expandedOk: R.q4_drill.expandedOk }));
          // locate LinkedIn among the revealed sub-rows
          const revealed = after ? after.rows.filter((r) => !r.isCategory) : [];
          const liSub = revealed.find((r) => /linkedin/i.test(r.label || ""));
          R.q1_structure.linkedInUnderCategory = liSub ? cat.label : null;
          R.q1_structure.linkedInSubLeaf = liSub || null;
          R.sideEffects.push(`expanded category "${cat.label}" (non-committing) — left expanded; benign`);
        });
      }
      // commit-attrs read for the located LinkedIn (top or sub), no click
      await guard("commit-attrs", async () => {
        const probe = await cdpEval(cdpSourceLeafProbe, TARGET);
        R.q5_commitAttrs = probe;
        LOG("(Q5 read-only) LinkedIn leaf probe:", JSON.stringify(probe, null, 2));
      });
    }

    R.tree = { path, finalState: st };
    LOG("SRC-RECON SUMMARY (paste this whole block back):");
    console.log("[ApplyPilot][CDP-SRC-RECON]", JSON.stringify(R, null, 2));
    if (R.sideEffects.length) LOG("side effects:", JSON.stringify(R.sideEffects));
    return { ok: true, present: true, path, errors: R.errors.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("recon aborted:", msg);
    console.log("[ApplyPilot][CDP-SRC-RECON] partial summary:", JSON.stringify(R, null, 2));
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// TYPEAHEAD RECON — M25 Step 1 (port of the proven Magna typeahead brain to the
// CDP substrate; spec: ~/.claude/plans/zany-shimmying-puzzle.md). SW-paced
// probes on ONE chipless typeahead; pre-filled typeaheads are reported
// read-only. The probe field ends holding "Other" — the profile's desired
// fallback value — so the side effect IS the restore. Keyboard commit is tested
// (the spec's primary); the trusted-click commit (c1) is reported UNTESTED:
// testing it would require deleting the committed chip, a destructive op on the
// live application (vetoed). Detaches in finally.
// ============================================================================
async function runCdpTypeaheadRecon(tabId, profile) {
  const LOG = (...a) => console.log("[ApplyPilot][TA-RECON]", ...a);
  const R = {
    scan: null, probe: {},
    c1: "untested — single virgin probe field; testing the trusted click would require deleting the committed chip (vetoed: destructive on the live application). Keyboard commit stands.",
    sideEffects: [], errors: []
  };
  const guard = async (name, fn) => {
    try { await fn(); } catch (e) {
      const m = name + ": " + String((e && e.message) || e);
      R.errors.push(m);
      LOG("probe ERROR —", m);
    }
  };
  const readState = (sel) => cdpEval(cdpReadTaState, sel);
  // Type into the FOCUSED searchBox: trusted select-all+Delete, then insertText.
  const typeQuery = async (text) => { await cdpSelectAllDelete(); await cdpDelay(150); await cdpInsertText(text); };

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
    LOG("tab is hidden — typeahead recon starting.");

    const scan = await cdpEval(cdpScanTypeaheads);
    R.scan = scan;
    LOG("typeaheads on this page (pre-state, incl. pre-filled chips):", JSON.stringify(scan, null, 2));
    const target = (scan || []).find((t) => t.chips.length === 0);
    if (!target) {
      LOG("no CHIPLESS typeahead here — the pre-state above is this page's deliverable (the pre-filled-chip case). For the active probes, run on a page with a virgin typeahead (My Experience → Field of Study); if it holds a chip from an earlier fill, remove it BY HAND and re-run.");
      console.log("[ApplyPilot][TA-RECON]", JSON.stringify(R, null, 2));
      return { ok: true, probed: false };
    }
    LOG("probe target:", target.fieldName, "—", JSON.stringify(target.label), target.entryFkitId ? "(inside entry " + target.entryFkitId + ")" : "(flat)");
    R.probe.field = { fieldName: target.fieldName, label: target.label, entryFkitId: target.entryFkitId };
    const sel = target.wrapperSel;

    // Field-aware probe candidates — the field's own profile-resolved tier list
    // (same FIELD_MAP/getByPath/resolve chain the fill uses; globals from
    // fill-driver.js). A committed probe thereby RESTORES the field to its
    // correct value. No mapping/value → fallback ["Other"], loudly.
    let candidates = ["Other"];
    const mappedPath = FIELD_MAP[target.fieldName];
    const raw = mappedPath && profile ? getByPath(profile, mappedPath) : undefined;
    if (raw !== undefined) {
      const rr = resolve(raw, "typeahead");
      if (!rr.skip && rr.candidates && rr.candidates.length) candidates = rr.candidates;
    }
    if (!mappedPath || raw === undefined) {
      LOG("⚠ no profile mapping/value for", target.fieldName, "— probing with the fallback query", JSON.stringify(candidates), "(load the profile in the popup for a field-aware probe)");
    }
    R.probe.candidates = candidates;
    LOG("probe candidates (tier order):", JSON.stringify(candidates));

    // ── (a) open: opener-ladder click → searchBox visible + focused ─────────
    await guard("(a) open", async () => {
      const openerSel =
        target.opener === "multiselectInputContainer" ? sel + ' [data-automation-id="multiselectInputContainer"]'
        : target.opener === "selectinput" ? sel + ' [data-uxi-widget-type="selectinput"]'
        : target.opener === "input" ? sel + " input"
        : sel;
      const rect = await cdpEval(cdpRectOf, openerSel, true);
      if (!rect || rect.w <= 0) throw new Error("opener rect dead (" + target.opener + ")");
      await cdpClickAt(rect.cx, rect.cy);
      let s = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        await cdpDelay(250);
        s = await readState(sel);
        if (s && s.searchBox.present && s.searchBox.visible) break;
      }
      let focusedBy = s && s.searchBox.focused ? "opener-click" : null;
      if (s && s.searchBox.visible && !s.searchBox.focused) {
        if (await cdpEval(cdpFocusBySel, sel + ' input[data-automation-id="searchBox"]')) focusedBy = "page-focus()";
        s = await readState(sel);
      }
      R.probe.open = {
        opener: target.opener, openMs: Date.now() - t0,
        searchBoxVisible: !!(s && s.searchBox.visible),
        focused: !!(s && s.searchBox.focused), focusedBy
      };
      LOG("(a) open:", JSON.stringify(R.probe.open));
      if (!s || !s.searchBox.visible || !s.searchBox.focused) throw new Error("searchBox not visible+focused after open — aborting active probes");
    });
    const opened = R.probe.open && R.probe.open.focused;

    // ── (e) banner FIRST: gibberish → Enter → banner + full-list co-occurrence ──
    await guard("(e) banner", async () => {
      if (!opened) { R.probe.banner = { skipped: "open failed" }; return; }
      const before = await readState(sel);
      await typeQuery("zzqqxvw");
      await cdpDelay(300);
      const echoed = await readState(sel);
      await cdpKeyTap(CDP_KEYS.enter);
      const series = [];
      let s = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        await cdpDelay(400);
        s = await readState(sel);
        series.push({ t: Date.now() - t0, banner: !!(s && s.banner), pageWideCount: s ? s.pageWide.count : -1, ariaCount: s && s.ariaScope.resolved ? s.ariaScope.count : null });
        if (s && s.banner) break;
      }
      R.probe.banner = {
        echoedValue: echoed && echoed.searchBox.value,
        appeared: !!(s && s.banner),
        bannerNode: s ? s.banner : null,
        appearedAtMs: s && s.banner && series.length ? series[series.length - 1].t : null,
        // PIN: the original false-fill condition — the banner AND the full list
        // still rendered underneath it, co-occurring.
        fullListStillRendered: !!(s && s.pageWide.count > 0),
        pageWideCountWithBanner: s ? s.pageWide.count : null,
        sampleWithBanner: s ? s.pageWide.sample : null,
        preTypeCount: before ? before.pageWide.count : null,
        series
      };
      LOG("(e) banner:", JSON.stringify(R.probe.banner));
      await cdpSelectAllDelete();
      await cdpDelay(800);
      const cleared = await readState(sel);
      R.probe.afterBannerClear = { value: cleared && cleared.searchBox.value, pageWideCount: cleared ? cleared.pageWide.count : null, bannerStill: !!(cleared && cleared.banner) };
      LOG("(e) after clear:", JSON.stringify(R.probe.afterBannerClear));
    });

    // ── (a/b/c/d) the candidate WALK — the Step 2 brain in miniature ─────────
    // Per candidate in tier order: clear → type → Enter → settle with the
    // STALE-BANNER rule (round-2 finding: clearing the input does NOT clear a
    // prior banner, so banner is terminal ONLY after a fresh change since THIS
    // candidate's Enter). Banner ⇒ next candidate. Filtered set ⇒ the spec-B.3
    // commit gate: the candidate's match must BE the FIRST filtered option
    // (targetIndex===0; aria-activedescendant is unreadable on this widget —
    // round-2 + the spec's round-3 both say so) → Enter → verify the CHIP.
    // Never an unverified commit; first verified commit wins.
    await guard("(a/b/c/d) candidate walk", async () => {
      if (!opened) { R.probe.walk = { skipped: "open failed" }; return; }
      const walk = [];
      R.probe.walk = walk;
      let committed = null;
      for (const cand of candidates) {
        const step = { candidate: cand };
        walk.push(step);
        await cdpSelectAllDelete();
        await cdpDelay(400);
        const snap = await readState(sel);
        step.staleBannerAtStart = !!(snap && snap.banner); // documents the round-2 stale-banner behavior
        const snapSig = snap ? snap.pageWide.sig : null;
        await cdpInsertText(cand);
        await cdpDelay(400);
        await cdpKeyTap(CDP_KEYS.enter);

        let s = null, sawChange = false, stable = 0, prevSig = null, outcome = "timeout";
        const series = [];
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
          await cdpDelay(400);
          s = await readState(sel);
          const sig2 = s ? s.pageWide.sig : null;
          if (sig2 !== snapSig) sawChange = true;
          series.push({ t: Date.now() - t0, count: s ? s.pageWide.count : -1, changed: sig2 !== snapSig, banner: !!(s && s.banner), chips: s ? s.chips.length : 0 });
          if (s && s.chips.length > 0) { outcome = "chip-auto-commit"; break; }
          if (s && s.banner && sawChange) { outcome = "banner"; break; }
          if (sawChange && sig2 !== snapSig && s && s.pageWide.count > 0 && !s.banner) {
            stable = sig2 === prevSig ? stable + 1 : 0;
            if (stable >= 1) { outcome = "filtered"; break; } // 2 consecutive equal post-transition reads
          }
          prevSig = sig2;
        }
        step.outcome = outcome;
        step.settleMs = series.length ? series[series.length - 1].t : null;
        step.series = series;
        step.ariaScope = s ? s.ariaScope : null; // scope verdict continuity (round-2: did not resolve)

        if (outcome === "chip-auto-commit") {
          // Single exact match auto-commits on the filter-Enter (spec) — verify the chip.
          step.chipTexts = s.chips;
          step.chipMatchesCandidate = s.chips.some((c) => normalize(c) === normalize(cand));
          if (step.chipMatchesCandidate) { committed = { candidate: cand, via: "enter-auto-commit", chips: s.chips }; }
          else step.note = "AUTO-COMMIT chip does NOT match the candidate — walk stopped (a chip now exists; further typing would contaminate)";
          break;
        }
        if (outcome === "banner") { step.note = "fresh no-match banner — hard block, next candidate"; continue; }
        if (outcome !== "filtered") { step.note = "settle timeout (no fresh transition) — next candidate"; continue; }

        step.filteredCount = s.pageWide.count;
        step.filteredSample = s.pageWide.sample;
        step.activeText = s.activeText; // data only — expected null on this widget
        const m = matchCandidates([cand], s.pageWide.texts);
        step.match = { targetIndex: m.targetIndex, matchTier: m.matchTier };
        if (m.targetIndex === -1) { step.note = "candidate not in its own filtered set — next candidate"; continue; }
        if (m.targetIndex !== 0) { step.note = `match is NOT the first option (targetIndex ${m.targetIndex}) — NOT pressing Enter (gate per spec B.3); next candidate`; continue; }

        const matchedOption = s.pageWide.texts[0];
        step.matchedOption = matchedOption;
        const tEnter = Date.now();
        await cdpKeyTap(CDP_KEYS.enter); // the commit-Enter on the auto-highlighted first option
        let cState = null;
        while (Date.now() - tEnter < 10000) {
          await cdpDelay(300);
          cState = await readState(sel);
          if (cState && cState.chips.length > 0) break;
        }
        const chips = cState ? cState.chips : [];
        step.chipTexts = chips;
        step.chipLatencyMs = Date.now() - tEnter;
        step.chipMatchesOption = chips.some((c) => normalize(c) === normalize(matchedOption));
        if (chips.length && step.chipMatchesOption) {
          committed = { candidate: cand, via: "targetIndex0-enter", matchedOption, chips, latencyMs: step.chipLatencyMs };
          break;
        }
        if (chips.length) { step.note = "chip text does NOT match the matched option — NOT a verified commit; walk stopped (chip present)"; break; }
        step.note = "no chip within budget — commit did not take; next candidate";
      }

      R.probe.committed = committed;
      LOG("(c2/d) walk result:", JSON.stringify({ committed, steps: walk.map((w) => ({ candidate: w.candidate, outcome: w.outcome, match: w.match, chipTexts: w.chipTexts, note: w.note })) }, null, 2));

      if (committed) {
        R.sideEffects.push(`typeahead "${target.label}" committed "${committed.chips.join('", "')}" — the profile's correct value (restores the hand-cleared field)`);
        await cdpDelay(1200);
        const post = await readState(sel);
        R.probe.listboxSelfClosed = !!(post && post.pageWide.count === 0); // (f)
        R.probe.searchBoxAfterCommit = post ? post.searchBox : null;
        LOG("(f) listbox self-closed after the trusted commit:", R.probe.listboxSelfClosed);
        R.probe.chipSubtree = await cdpEval(cdpDumpChipSubtree, sel); // READ-ONLY
        LOG("chip subtree (read-only — identifies the delete control for a future overwrite milestone; nothing clicked):", JSON.stringify(R.probe.chipSubtree));
      } else {
        await cdpKeyTap(CDP_KEYS.escape); // tidy: close the open list; nothing committed
        LOG("walk ended with NO verified commit — field left empty (no false fill).");
      }
    });

    LOG("TA-RECON SUMMARY (paste this whole block back):");
    console.log("[ApplyPilot][TA-RECON]", JSON.stringify(R, null, 2));
    if (R.sideEffects.length) LOG("side effects:", JSON.stringify(R.sideEffects));
    return { ok: true, probed: true, errors: R.errors.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("recon aborted:", msg);
    console.log("[ApplyPilot][TA-RECON] partial summary:", JSON.stringify(R, null, 2));
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// OVERWRITE RECON (M27 Step 0) — the populated-field model probe. The existing
// TA-RECON deliberately targets a CHIPLESS field and vetoes the populated-commit
// probe as destructive; M27's non-destructive design needs the OPPOSITE answers,
// on a field that ALREADY holds a (hand-seeded WRONG) chip:
//   (a)  with a chip present, does opening expose a usable (visible+focused)
//        searchBox? (the "search-while-populated" premise)
//   (a2) does clearSearch (Ctrl+A+Delete) on the EMPTY searchBox PRESERVE the
//        committed chip? (Commit B clears the filter before each candidate — it
//        must NOT delete the chip)
//   (b)  typing a DIFFERENT valid candidate + filter-Enter → does the commit
//        REPLACE the chip (1 chip = new value) or ADD a second (multiselect)?
//        REPLACE ⇒ Commit C (residual-chip cleanup) NOT needed; ADD ⇒ required.
// Field-aware: targets a populated field whose profile candidate DIFFERS from the
// seeded chip, so a REPLACE restores the field to its correct value. Detaches in
// finally. Output: [OVR-RECON] in the SW console.
// ============================================================================
async function runCdpOverwriteRecon(tabId, profile) {
  const LOG = (...a) => console.log("[ApplyPilot][OVR-RECON]", ...a);
  const R = {
    scan: null, target: null,
    a_searchBoxWhilePopulated: null, a2_clearEffect: null, b_commit: null,
    verdict: {}, sideEffects: [], errors: []
  };
  const guard = async (name, fn) => {
    try { await fn(); } catch (e) {
      const m = name + ": " + String((e && e.message) || e);
      R.errors.push(m); LOG("probe ERROR —", m);
    }
  };
  const readState = (sel) => cdpEval(cdpReadTaState, sel);
  const normEq = (a, b) => normalize(a) === normalize(b);
  // chip set unchanged from the seeded baseline (normalized, order-independent).
  const sameAsSeeded = (chips, seeded) =>
    chips.length === seeded.length && seeded.every((c) => chips.some((x) => normEq(x, c)));

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
    LOG("tab is hidden — overwrite recon starting.");

    const scan = await cdpEval(cdpScanTypeaheads);
    R.scan = scan;
    LOG("typeaheads on this page (pre-state, incl. chips):", JSON.stringify(scan, null, 2));

    const populated = (scan || []).filter((t) => t.chips && t.chips.length > 0);
    if (!populated.length) {
      LOG("no POPULATED typeahead here. HAND-SEED a WRONG value into a typeahead (e.g. countryPhoneCode on My Information) first, then re-run. The pre-state above is the only deliverable otherwise.");
      console.log("[ApplyPilot][OVR-RECON]", JSON.stringify(R, null, 2));
      return { ok: true, probed: false };
    }

    // Prefer a populated field whose profile candidate DIFFERS from the seeded
    // chip — a genuine mismatch, so a REPLACE restores the correct value.
    const candsFor = (t) => {
      const mappedPath = FIELD_MAP[t.fieldName];
      const raw = mappedPath && profile ? getByPath(profile, mappedPath) : undefined;
      if (raw === undefined) return null;
      const rr = resolve(raw, "typeahead");
      return (!rr.skip && rr.candidates && rr.candidates.length) ? rr.candidates : null;
    };
    let target = null, candidates = null;
    for (const t of populated) {
      const cands = candsFor(t);
      if (cands && !t.chips.some((c) => cands.some((cd) => normEq(c, cd)))) { target = t; candidates = cands; break; }
    }
    if (!target) {
      target = populated[0];
      candidates = candsFor(target) || ["Other"];
      LOG("⚠ no populated field whose profile candidate DIFFERS from its seeded chip — using", target.fieldName, "with candidate(s)", JSON.stringify(candidates), "(if the chip already matches a candidate this won't be a real overwrite — seed a genuinely WRONG value for a clean (b) verdict).");
    }
    const sel = target.wrapperSel;
    const seededChips = target.chips.slice();
    R.target = { fieldName: target.fieldName, label: target.label, entryFkitId: target.entryFkitId || null, seededChips, candidates };
    LOG("target:", target.fieldName, JSON.stringify(target.label), "— seeded chip(s):", JSON.stringify(seededChips), "candidate(s):", JSON.stringify(candidates));

    // ── (a) open populated field → searchBox usable WITH a chip present? ─────────
    await guard("(a) searchBox-while-populated", async () => {
      const openerSel =
        target.opener === "multiselectInputContainer" ? sel + ' [data-automation-id="multiselectInputContainer"]'
        : target.opener === "selectinput" ? sel + ' [data-uxi-widget-type="selectinput"]'
        : target.opener === "input" ? sel + " input" : sel;
      const rect = await cdpEval(cdpRectOf, openerSel, true);
      if (!rect || rect.w <= 0) throw new Error("opener rect dead (" + target.opener + ")");
      await cdpClickAt(rect.cx, rect.cy);
      let s = null; const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        await cdpDelay(250);
        s = await readState(sel);
        if (s && s.searchBox.present && s.searchBox.visible) break;
      }
      let focusedBy = s && s.searchBox.focused ? "opener-click" : null;
      if (s && s.searchBox.visible && !s.searchBox.focused) {
        if (await cdpEval(cdpFocusBySel, sel + ' input[data-automation-id="searchBox"]')) focusedBy = "page-focus()";
        s = await readState(sel);
      }
      R.a_searchBoxWhilePopulated = {
        chipsStillPresent: s ? s.chips : null,
        searchBoxPresent: !!(s && s.searchBox.present),
        searchBoxVisible: !!(s && s.searchBox.visible),
        searchBoxFocused: !!(s && s.searchBox.focused),
        focusedBy, openMs: Date.now() - t0
      };
      LOG("(a):", JSON.stringify(R.a_searchBoxWhilePopulated));
    });
    const usable = !!(R.a_searchBoxWhilePopulated && R.a_searchBoxWhilePopulated.searchBoxFocused);

    // ── (a2) does an empty-searchBox Ctrl+A+Delete PRESERVE the chip? ───────────
    await guard("(a2) clearSearch effect on chip", async () => {
      if (!usable) { R.a2_clearEffect = { skipped: "searchBox not usable" }; return; }
      const before = await readState(sel);
      await cdpSelectAllDelete();
      await cdpDelay(500);
      const after = await readState(sel);
      R.a2_clearEffect = {
        chipsBefore: before ? before.chips : null,
        chipsAfter: after ? after.chips : null,
        chipSurvived: !!(after && sameAsSeeded(after.chips, seededChips)),
        searchBoxValueAfter: after ? after.searchBox.value : null
      };
      LOG("(a2):", JSON.stringify(R.a2_clearEffect));
    });

    // ── (b) type a DIFFERENT valid candidate → commit → REPLACE vs ADD ──────────
    await guard("(b) commit replace-vs-add", async () => {
      if (!usable) { R.b_commit = { skipped: "searchBox not usable" }; return; }
      let s = await readState(sel);
      if (!s || !s.searchBox.focused) { await cdpEval(cdpFocusBySel, sel + ' input[data-automation-id="searchBox"]'); s = await readState(sel); }
      if (!s || !s.searchBox.focused) throw new Error("could not focus searchBox for the commit probe");
      const cand = candidates[0];
      await cdpSelectAllDelete(); await cdpDelay(300);
      await cdpTypeChars(cand, 40); await cdpDelay(400);  // per-char keystrokes — the real fill path
      await cdpKeyTap(CDP_KEYS.enter);                    // filter-Enter
      const series = []; const t0 = Date.now(); let done = false, sawBanner = false;
      while (Date.now() - t0 < 25000) {
        await cdpDelay(400);
        s = await readState(sel);
        const chipsNow = s ? s.chips : [];
        const differs = !sameAsSeeded(chipsNow, seededChips);
        series.push({ t: Date.now() - t0, chipCount: chipsNow.length, chips: chipsNow, banner: !!(s && s.banner), differs });
        if (s && s.banner) { sawBanner = true; done = true; break; }  // candidate not an option here
        if (differs && chipsNow.length > 0) { done = true; break; }   // a NEW chip committed
      }
      const finalChips = s ? s.chips : [];
      const containsSeeded = seededChips.every((c) => finalChips.some((x) => normEq(x, c)));
      const containsCand = finalChips.some((x) => normEq(x, cand));
      let verdict = "INCONCLUSIVE";
      if (finalChips.length === 1 && containsCand && !containsSeeded) verdict = "REPLACE";            // model holds → Commit C NOT needed
      else if (finalChips.length >= 2 && containsCand && containsSeeded) verdict = "ADD";             // multiselect → Commit C REQUIRED
      else if (sawBanner) verdict = "BANNER (candidate is not a selectable option here — re-seed a field whose profile candidate IS a valid option)";
      else if (containsSeeded && !containsCand) verdict = "NO-COMMIT (chip unchanged — search-while-populated may not commit a replacement)";
      R.b_commit = { candidate: cand, finalChips, finalChipCount: finalChips.length, containsSeeded, containsCand, sawBanner, verdict, settledInBudget: done, series };
      R.verdict.commitBehavior = verdict;
      LOG("(b):", JSON.stringify(R.b_commit, null, 2));
      if (verdict === "REPLACE") R.sideEffects.push(`overwrote ${JSON.stringify(seededChips)} → "${cand}" (REPLACE; field now holds the profile-correct value)`);
      else if (verdict === "ADD") R.sideEffects.push(`field now holds TWO chips ${JSON.stringify(finalChips)} — restore BY HAND (remove the wrong one)`);
    });

    R.verdict.searchBoxUsableWhilePopulated = usable;
    R.verdict.clearSearchPreservesChip = !!(R.a2_clearEffect && R.a2_clearEffect.chipSurvived);
    R.verdict.commitCNeeded = R.verdict.commitBehavior === "ADD";
    LOG("OVR-RECON VERDICT:", JSON.stringify(R.verdict));
    LOG("OVR-RECON SUMMARY (paste this whole block back):");
    console.log("[ApplyPilot][OVR-RECON]", JSON.stringify(R, null, 2));
    if (R.sideEffects.length) LOG("side effects:", JSON.stringify(R.sideEffects));
    return { ok: true, probed: true, verdict: R.verdict, errors: R.errors.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("recon aborted:", msg);
    console.log("[ApplyPilot][OVR-RECON] partial summary:", JSON.stringify(R, null, 2));
    return { ok: false, error: "exception:" + msg };
  } finally {
    await cdpDetach();
  }
}

// ============================================================================
// SOURCE OVERWRITE RECON (M27 Step 0, source half) — prove clearSourceSearch on
// the SOURCE widget before Commit B's source no-match resting-state relies on it.
// The typeahead recon proved clearSearch preserves the chip; clearSourceSearch is
// the byte-identical primitive but was never probed on the source widget. Seed a
// WRONG value into "How did you hear about us?" by hand, then run hidden. The
// load-bearing result is (a2): does clearSourceSearch keep the committed chip?
// [OVR-SRC-RECON] in the SW console. Detaches in finally.
// ============================================================================
async function runCdpSourceOverwriteRecon(tabId, defaults) {
  const LOG = (...a) => console.log("[ApplyPilot][OVR-SRC-RECON]", ...a);
  const R = { target: null, a_searchBoxWhilePopulated: null, a2_clearEffect: null, b_commit: null, verdict: {}, sideEffects: [], errors: [] };
  const guard = async (name, fn) => {
    try { await fn(); } catch (e) { const m = name + ": " + String((e && e.message) || e); R.errors.push(m); LOG("probe ERROR —", m); }
  };
  const sel = '[data-automation-id="formField-source"]';
  const readState = () => cdpEval(cdpReadSourcePick, sel);
  const normEq = (a, b) => normalize(a) === normalize(b);
  const sameAsSeeded = (chips, seeded) => chips.length === seeded.length && seeded.every((c) => chips.some((x) => normEq(x, c)));

  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    LOG("attached. MINIMIZE THE WINDOW NOW — recon starts on the first hidden read (60s window).");
    if (!(await cdpWaitHidden(60000, 500))) { LOG("tab never went hidden — INVALID run."); return { ok: false, error: "never-hidden" }; }
    LOG("tab is hidden — source overwrite recon starting.");

    const pre = await readState();
    if (!pre) { LOG("no source field here ([data-automation-id=formField-source]) — run on My Information."); return { ok: false, error: "no-source-field" }; }
    LOG("source pre-state:", JSON.stringify(pre));
    if (!pre.chips.length) {
      LOG("source has NO chip. HAND-SEED a value into 'How did you hear about us?' (any leaf) first, then re-run.");
      console.log("[ApplyPilot][OVR-SRC-RECON]", JSON.stringify(R, null, 2));
      return { ok: true, probed: false };
    }
    const hdyh = defaults && defaults.how_did_you_hear;
    const candidates = (hdyh && Array.isArray(hdyh.preferred)) ? [...hdyh.preferred] : [];
    if (hdyh && hdyh.fallback) candidates.push(hdyh.fallback);
    if (!candidates.length) { LOG('no how_did_you_hear defaults — click "Load default profile" first.'); return { ok: false, error: "no-candidates" }; }
    const seededChips = pre.chips.slice();
    const cand = candidates.find((c) => !seededChips.some((ch) => normEq(ch, c))) || candidates[0];
    R.target = { seededChips, candidates, candidateUsed: cand };
    LOG("source target — seeded chip(s):", JSON.stringify(seededChips), "candidate:", JSON.stringify(cand));

    // (a) open the populated source → is the searchBox usable with a chip present?
    await guard("(a) searchBox-while-populated", async () => {
      let opened = false;
      for (const part of [' button[aria-haspopup="listbox"]', ' [data-automation-id="multiselectInputContainer"]', ' [data-uxi-widget-type="selectinput"]', " input", ""]) {
        const rect = await cdpEval(cdpRectOf, sel + part, true);
        if (rect && rect.w > 0) { await cdpClickAt(rect.cx, rect.cy); opened = true; break; }
      }
      if (!opened) throw new Error("source opener rects all dead");
      let s = null; const t0 = Date.now();
      while (Date.now() - t0 < 5000) { await cdpDelay(250); s = await readState(); if (s && s.searchBox.present && s.searchBox.visible) break; }
      let focusedBy = s && s.searchBox.focused ? "opener-click" : null;
      if (s && s.searchBox.visible && !s.searchBox.focused) { if (await cdpEval(cdpFocusBySel, sel + ' input[data-automation-id="searchBox"]')) focusedBy = "page-focus()"; s = await readState(); }
      R.a_searchBoxWhilePopulated = { chipsStillPresent: s ? s.chips : null, searchBoxPresent: !!(s && s.searchBox.present), searchBoxVisible: !!(s && s.searchBox.visible), searchBoxFocused: !!(s && s.searchBox.focused), focusedBy, openMs: Date.now() - t0 };
      LOG("(a):", JSON.stringify(R.a_searchBoxWhilePopulated));
    });
    const usable = !!(R.a_searchBoxWhilePopulated && R.a_searchBoxWhilePopulated.searchBoxFocused);

    // (a2) THE load-bearing check: clearSourceSearch (= cdpSelectAllDelete) on the
    // empty searchBox must PRESERVE the committed chip.
    await guard("(a2) clearSourceSearch effect on chip", async () => {
      if (!usable) { R.a2_clearEffect = { skipped: "searchBox not usable" }; return; }
      const before = await readState();
      await cdpSelectAllDelete();
      await cdpDelay(500);
      const after = await readState();
      R.a2_clearEffect = { chipsBefore: before ? before.chips : null, chipsAfter: after ? after.chips : null, chipSurvived: !!(after && sameAsSeeded(after.chips, seededChips)), searchBoxValueAfter: after ? after.searchBox.value : null };
      LOG("(a2):", JSON.stringify(R.a2_clearEffect));
    });

    // (b) type a DIFFERENT candidate → commit → REPLACE vs ADD (bonus; source
    // normally commits via leaf-click, so a single-exact may auto-commit and a
    // multi-leaf may not change the chip here — (a)/(a2) are the load-bearing results).
    await guard("(b) commit replace-vs-add", async () => {
      if (!usable) { R.b_commit = { skipped: "searchBox not usable" }; return; }
      let s = await readState();
      if (!s || !s.searchBox.focused) { await cdpEval(cdpFocusBySel, sel + ' input[data-automation-id="searchBox"]'); s = await readState(); }
      if (!s || !s.searchBox.focused) throw new Error("could not focus source searchBox for the commit probe");
      await cdpSelectAllDelete(); await cdpDelay(300);
      await cdpTypeChars(cand, 40); await cdpDelay(400);
      await cdpKeyTap(CDP_KEYS.enter);
      const series = []; const t0 = Date.now(); let done = false, sawBanner = false;
      while (Date.now() - t0 < 25000) {
        await cdpDelay(400);
        s = await readState();
        const chipsNow = s ? s.chips : [];
        const differs = !sameAsSeeded(chipsNow, seededChips);
        series.push({ t: Date.now() - t0, chipCount: chipsNow.length, chips: chipsNow, banner: !!(s && s.banner), leafCount: s ? s.leafCount : -1, differs });
        if (s && s.banner) { sawBanner = true; done = true; break; }
        if (differs && chipsNow.length > 0) { done = true; break; }
      }
      const finalChips = s ? s.chips : [];
      const containsSeeded = seededChips.every((c) => finalChips.some((x) => normEq(x, c)));
      const containsCand = finalChips.some((x) => normEq(x, cand));
      let verdict = "INCONCLUSIVE (no auto-commit; source commits via leaf-click — (a)/(a2) are the load-bearing results)";
      if (finalChips.length === 1 && containsCand && !containsSeeded) verdict = "REPLACE";
      else if (finalChips.length >= 2 && containsCand && containsSeeded) verdict = "ADD";
      else if (sawBanner) verdict = "BANNER (candidate is not a selectable leaf — pick a how_did_you_hear value that filters to a leaf)";
      R.b_commit = { candidate: cand, finalChips, finalChipCount: finalChips.length, containsSeeded, containsCand, sawBanner, verdict, settledInBudget: done, series };
      R.verdict.commitBehavior = verdict;
      LOG("(b):", JSON.stringify(R.b_commit, null, 2));
      if (verdict === "ADD") R.sideEffects.push(`source now holds TWO chips ${JSON.stringify(finalChips)} — restore BY HAND`);
      else if (verdict === "REPLACE") R.sideEffects.push(`source overwrote ${JSON.stringify(seededChips)} → "${cand}" (REPLACE)`);
    });

    R.verdict.searchBoxUsableWhilePopulated = usable;
    R.verdict.clearSourceSearchPreservesChip = !!(R.a2_clearEffect && R.a2_clearEffect.chipSurvived);
    LOG("OVR-SRC-RECON VERDICT:", JSON.stringify(R.verdict));
    LOG("OVR-SRC-RECON SUMMARY (paste this whole block back):");
    console.log("[ApplyPilot][OVR-SRC-RECON]", JSON.stringify(R, null, 2));
    if (R.sideEffects.length) LOG("side effects:", JSON.stringify(R.sideEffects));
    return { ok: true, probed: true, verdict: R.verdict, errors: R.errors.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("recon aborted:", msg);
    console.log("[ApplyPilot][OVR-SRC-RECON] partial summary:", JSON.stringify(R, null, 2));
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
// TARGETED TYPEAHEAD FILL — the M25 verify harness. Locates ONE typeahead by
// label regex (entry fields get an entry-1-scoped COMPOSED selector — the
// duplicate formField-* ids make a bare wrapper selector hit entry 1 only by
// luck; composition makes it explicit), resolves its candidates, and runs the
// full fillTypeaheadCdp brain hidden. Detaches in finally.
// ============================================================================

// Candidates for repeating-entry typeaheads (deliberately NOT in FIELD_MAP —
// that map is the flat-page contract; these mirror EDUCATION_MAP /
// CERTIFICATION_MAP's profile paths for entry 0).
const TA_ENTRY_CANDIDATES = {
  fieldOfStudy: (p) => p && Array.isArray(p.education) && p.education[0] ? p.education[0].field_of_study : undefined,
  certification: (p) => p && Array.isArray(p.certifications) && p.certifications[0] ? p.certifications[0].certification : undefined
};

async function runCdpFillTypeahead(tabId, profile, labelRegexStr) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-TA]", ...a);
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

    let re;
    try { re = new RegExp(labelRegexStr || ".", "i"); } catch (e) {
      LOG("bad label regex:", JSON.stringify(labelRegexStr));
      return { ok: false, error: "bad-regex" };
    }
    const scan = await cdpEval(cdpScanTypeaheads);
    const target = (scan || []).find((t) => re.test(t.label || "") || re.test(t.fieldName));
    if (!target) {
      LOG("no typeahead matching", JSON.stringify(labelRegexStr), "— typeaheads on this page:", JSON.stringify((scan || []).map((t) => ({ field: t.fieldName, label: t.label }))));
      return { ok: false, error: "no-match" };
    }
    const wrapperSel = (target.entryFkitId ? '[data-fkit-id="' + target.entryFkitId + '"] ' : "") + target.wrapperSel;
    LOG("target:", target.fieldName, "—", JSON.stringify(target.label), "| sel:", wrapperSel);

    let raw;
    const mappedPath = FIELD_MAP[target.fieldName];
    if (mappedPath) raw = getByPath(profile, mappedPath);
    else if (TA_ENTRY_CANDIDATES[target.fieldName]) raw = TA_ENTRY_CANDIDATES[target.fieldName](profile);
    const rr = raw === undefined ? { skip: true } : resolve(raw, "typeahead");
    if (rr.skip) {
      LOG("no candidates for", target.fieldName, "— no mapping/value in the profile.");
      return { ok: false, error: "no-candidates" };
    }
    LOG("candidates (tier order):", JSON.stringify(rr.candidates));
    LOG("tab is hidden — typeahead fill starting. (Δperf ~1000ms on the page loop is EXPECTED, not failure.)");

    const act = makeCdpActuation();
    const rec = await fillTypeaheadCdp(act, { wrapperSel }, rr.candidates, DEFAULT_BUDGETS);
    LOG("result:", JSON.stringify({ field: target.fieldName, status: rec.status, after: rec.after, verified: rec.verified, tier: rec.matchTier, flag: rec.flag, confidence: rec.confidence, detail: rec.detail }, null, 2));
    if (rec.settle_trace) LOG("settle trace:", JSON.stringify(rec.settle_trace, null, 2));
    if (rec.captured_options) LOG("captured options:", JSON.stringify(rec.captured_options));
    return { ok: true, status: rec.status, after: rec.after || null, verified: rec.verified === true, flag: rec.flag || null };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("typeahead fill aborted:", msg);
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
// CDP WALK (M31) — fill page 1 → GUARDED Save & Continue → detect session-death
// (VPS/login) OR a clean transition. ONE transition; page-2 fill is deferred
// (repeating sections aren't on the CDP path). The CDP attach SURVIVES the
// navigation (only Runtime+DOM enabled, no Page domain) — so no re-injection; we
// just re-read the page via cdpEval on the same attach. Detaches in finally.
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

async function runCdpWalk(tabId, profile, defaults, jobContext) {
  const LOG = (...a) => console.log("[ApplyPilot][CDP-WALK]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    LOG("attached. MINIMIZE THE WINDOW NOW — the walk starts on the first hidden read (60s window).");
    if (!(await cdpWaitHidden(60000, 500))) { LOG("tab never went hidden — INVALID run, nothing done."); return { ok: false, error: "never-hidden" }; }
    LOG("tab hidden — walk starting. ONE transition; page-2 fill is deferred (repeating sections).");

    const prevSig = cdpPageSig(await cdpEval(cdpPageScan));

    // ── Fill page 1 ──
    const act = makeCdpActuation();
    const out = await drivePageFill(act, profile, defaults, jobContext);
    LOG("page 1:", out.url);
    if (out.sessionWarning) LOG(`⚠⚠ ${out.sessionWarning}`); // M30 early-warning (source-liveness)
    LOG(`page 1 filled — ${JSON.stringify(out.counts)}, ${out.needsReview.length} need review.`);
    for (const r of out.needsReview) LOG(`  ⚠ [${r.status}] ${r.fieldName} — ${r.detail}`);
    const base = { counts: out.counts, needs_review: out.needsReview.length, session_warning: out.sessionWarning || null };

    // M31.1: on a stop-with-errors, surface the EXACT page error text (future AI will
    // use these to debug/fix the page) + which fields the walk left EMPTY because the
    // profile/JSON has no value (the likely cause of a "required" validation error).
    // Reads the error state FRESH (errors render after Save & Continue).
    const reportPageErrors = async () => {
      let st = null;
      try { st = await cdpEval(cdpReadSessionState); } catch (e) { /* ignore */ }
      const samples = (st && st.errorMarkers && st.errorMarkers.samples) || [];
      if (samples.length) { LOG(`page errors (${samples.length}):`); samples.forEach((s) => LOG(`    • ${s}`)); }
      if (st && st.errorPageText) LOG(`error-page text: ${st.errorPageText}`);
      if (!samples.length && !(st && st.errorPageText)) LOG("(no error text captured on the page)");
      const empties = out.results.filter((r) => r.status === "skipped");
      if (empties.length) {
        LOG("fields left EMPTY (no value in the profile/JSON — the likely validation cause):");
        empties.forEach((r) => LOG(`    • ${r.fieldName} — ${r.detail}`));
      }
      return { page_errors: samples, error_page_text: st ? (st.errorPageText || null) : null, empty_fields: empties.map((r) => ({ field: r.fieldName, reason: r.detail })) };
    };

    // ── Nav decision (double Submit-guard + pre-click dead check) ──
    const nav = await cdpEval(cdpReadSessionState);
    if (nav && nav.applyFlowReviewPresent) { LOG("on the REVIEW page — NEVER advancing (would submit). Stop."); return { ok: true, advanced: false, stopped: "review-page", ...base }; }
    if (nav && sessionLooksDead(nav)) { LOG("⚠⚠ SESSION EXPIRED before advance (login/VPS/no-form) — refresh, log in, reopen the form, then retry."); const diag = await reportPageErrors(); return { ok: true, advanced: false, stopped: "session-expired", session_expired: true, ...diag, ...base }; }
    if (!nav || !nav.nextButtonPresent) { LOG("no Save & Continue button — terminal page. Stop (no advance)."); return { ok: true, advanced: false, stopped: "no-next-button", ...base }; }

    // ── Guarded advance ──
    const click = await act.clickPageNext();
    LOG("Save & Continue:", JSON.stringify(click));
    if (!click.clicked) { return { ok: true, advanced: false, stopped: "click-refused:" + (click.refused || "?"), ...base }; }

    // ── Wait for transition OR session-death ──
    const res = await cdpWaitNextPage(prevSig);
    if (res.sessionDead) {
      LOG("⚠⚠ SESSION EXPIRED / page errors after Save & Continue — refresh, log in, and reopen the form, then retry.");
      const diag = await reportPageErrors();
      return { ok: true, advanced: false, stopped: "session-expired", session_expired: true, ...diag, ...base };
    }
    if (res.advanced) {
      LOG("✓ advanced to page 2 — page-2 fill (repeating sections) is a future round. Stopping (1-transition cap).");
      return { ok: true, advanced: true, stopped: "advanced-page2-deferred", ...base };
    }
    LOG("⚠ nav-timeout — clicked Save & Continue but the page neither advanced nor showed a session error. PAGE 1 MAY NOW BE DIRTY — EYEBALL it before any re-run; do NOT re-run on this page as if fresh. Errors + empty fields below:");
    const diag = await reportPageErrors();
    return { ok: true, advanced: false, stopped: "nav-timeout-dirty", ...diag, ...base };
  } catch (e) {
    const msg = String((e && e.message) || e);
    LOG("walk aborted:", msg);
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
    return { attached: false, cleared: false, deletedCount, remaining, detail: `could not clear existing attachment(s) — removed ${deletedCount}, ${remaining} remain (confirm dialog or persistent stale node?)` };
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

