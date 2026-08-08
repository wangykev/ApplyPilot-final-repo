// ============================================================================
// DEV LOG MIRROR — make the service-worker console readable from outside DevTools.
//
// Every [ApplyPilot] line lands in the SW console. That console belongs to a worker target, not a
// tab, so no page and no automation can read it — which leaves an agent driving this extension blind
// to the single channel that explains what a run did (why a field escalated, why a walk halted). This
// mirrors console output into a bounded ring buffer that the local dev site pulls over AP_DEV_LOGS,
// the same localhost-only external channel as AP_RELOAD.
//
// It PATCHES console instead of editing ~130 call sites, so cdp.js / fill-driver.js / discover.js are
// captured for free, and it runs BEFORE importScripts so a load-time throw in any of them is captured
// too. The original console method is called FIRST and the buffering is wrapped in try/catch: this is a
// debugging aid, and it must never be able to break a run. Pure buffer mechanics live in lib.js
// (devLogFormat / devLogAppend / devLogSelect) so they're unit-testable.
// ============================================================================
const AP_DEV_LOG_MAX = 1200;      // lines retained (~1 MB with the line cap — well inside storage.local)
const AP_DEV_LOG_LINE_MAX = 1200; // chars per line
const AP_DEV_WORKER_START = Date.now();
let apDevLog = [];
let apDevLogSeq = 0;
let apDevLogDropped = 0;
let apDevLogFlushTimer = null;

function apDevLogPush(lvl, args) {
  try {
    // lib.js may not be evaluated yet (this block runs before importScripts), so degrade rather than throw.
    const fmt = typeof devLogFormat === "function"
      ? devLogFormat(args, AP_DEV_LOG_LINE_MAX)
      : args.map((a) => String(a)).join(" ");
    const entry = { n: ++apDevLogSeq, t: Date.now(), lvl, msg: fmt };
    if (typeof devLogAppend === "function") apDevLogDropped += devLogAppend(apDevLog, entry, AP_DEV_LOG_MAX);
    else apDevLog.push(entry);
    // Debounced: an MV3 worker can be torn down between runs, so the buffer is persisted rather than
    // living only in memory — otherwise the logs explaining a halt die with the worker that wrote them.
    if (!apDevLogFlushTimer) apDevLogFlushTimer = setTimeout(apDevLogFlush, 1500);
  } catch (e) { /* a logging aid must never break a run */ }
}

function apDevLogFlush() {
  apDevLogFlushTimer = null;
  try {
    chrome.storage.local.set({ devLog: { seq: apDevLogSeq, dropped: apDevLogDropped, lines: apDevLog } });
  } catch (e) { /* ignore */ }
}

for (const apDevLvl of ["log", "warn", "error", "info", "debug"]) {
  const apDevOrig = console[apDevLvl] ? console[apDevLvl].bind(console) : null;
  if (!apDevOrig) continue;
  console[apDevLvl] = (...args) => { apDevOrig(...args); apDevLogPush(apDevLvl, args); };
}

// Carry the previous worker's tail back in. Lines this worker buffered before the restore landed are
// renumbered past it, so a poller's `since` cursor never runs backwards across a worker restart.
try {
  chrome.storage.local.get("devLog", (res) => {
    const prev = res && res.devLog;
    if (!prev || !Array.isArray(prev.lines) || !prev.lines.length) return;
    const base = Number(prev.seq) || Number(prev.lines[prev.lines.length - 1].n) || 0;
    for (const e of apDevLog) e.n += base;
    apDevLogSeq += base;
    apDevLogDropped += Number(prev.dropped) || 0;
    apDevLog = prev.lines.concat(apDevLog);
    const over = apDevLog.length - AP_DEV_LOG_MAX;
    if (over > 0) { apDevLog.splice(0, over); apDevLogDropped += over; }
  });
} catch (e) { /* ignore */ }

console.log(`[ApplyPilot][DEV] service worker started (${new Date(AP_DEV_WORKER_START).toISOString()})`);

// Shared IndexedDB storage helpers (saveResume/getResume/RESUME_KEY). Classic MV3
// service worker, so importScripts brings db.js's functions into the SW scope (the
// popup loads the same file via <script>). Used by the M16.2 attach path to read
// the stored resume's bytes here, then pass them as a string into the injection.
// llm-keys.js loads BEFORE llm.js on purpose: callLLM's rotation layer resolves its
// helpers (orderLlmKeys / classifyLlmFailure / applyLlmKeyOutcome) as globals, and
// degrades to the original single-key path if they aren't there.
importScripts("db.js", "lib.js", "llm-keys.js", "llm.js", "gmail.js", "cdp.js", "fill-driver.js", "ats.js", "discover.js"); // db.js = IndexedDB storage; lib.js = pure helpers (parse*, match ladder, onboarding classifiers); llm.js = multi-provider LLM adapter (callLLM); gmail.js = Gmail auto-verify adapter (getAuthToken + readonly REST); cdp.js = CDP substrate (off-loop actuation + onboarding navigation); fill-driver.js = the substrate-agnostic CDP fill brain (needs lib.js loaded first); discover.js = the job-discovery sweep (LinkedIn/Handshake/Simplify → the website queue; needs lib.js for canonicalJobUrl)

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

// ── Live run progress → the website Run page, over a long-lived external Port. ──
// The website opens a `chrome.runtime.connect(extId, { name: "ap-run-progress" })` port; the
// AP_RUN_APPLICATION pipeline (this handler → runCdpOnboard → runCdpWalk, all in THIS file) calls the
// module-level emitRunProgress() at each phase — NO parameter threading, since they're all module-scope.
// No port connected (a popup-triggered run) ⇒ emitRunProgress just logs to the SW console. The port
// also counts as activity, keeping the MV3 SW warm for the duration of the run (a free bonus).
let runProgressPort = null;
let lastRunProgress = null;
let runInFlight = false;
// A discovery sweep is in flight (the website's Discover button). MUTUALLY EXCLUSIVE with a
// fill run — NOT for politeness: cdp.js tracks its attachment in a module-level `cdpTabId`, so a
// discovery CDP read (the JD scrape on an arbitrary ATS host) would CLOBBER the walk's tracked tab
// and detach it mid-fill. The two handlers refuse each other while either is set.
let discoverInFlight = false;
chrome.runtime.onConnectExternal.addListener((port) => {
  if (!port || port.name !== "ap-run-progress") return;
  runProgressPort = port;
  // Replay the latest phase so a port that connects a beat after the run started isn't blank
  // (gated on an active run so a fresh port never sees a stale prior-run phase).
  if (runInFlight && lastRunProgress) { try { port.postMessage(lastRunProgress); } catch (e) { /* closed */ } }
  port.onDisconnect.addListener(() => { if (runProgressPort === port) runProgressPort = null; });
});
function emitRunProgress(phase, detail) {
  lastRunProgress = { type: "AP_RUN_PROGRESS", phase: String(phase || ""), detail: String(detail || ""), at: Date.now() };
  try { console.log(`[ApplyPilot][RUN] » ${phase}${detail ? " — " + detail : ""}`); } catch (e) { /* ignore */ }
  try { if (runProgressPort) runProgressPort.postMessage(lastRunProgress); } catch (e) { /* port closed */ }
}

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

  // AI config. The WEBSITE'S AI PAGE OWNS THIS OBJECT — it is stored wholesale, not
  // merged, because the whole config (default pair, key lists, per-action routes,
  // fallback chains) is edited there as one unit and a partial merge could leave the
  // extension holding a route that names a provider whose keys were just removed. The
  // popup shows it read-only for the same reason.
  // Also remembers WHERE the config came from, so the popup can offer a link straight to
  // the AI page without the extension hardcoding a site URL (dev is localhost, and
  // externally_connectable already restricts who may send this).
  if (type === "AP_SET_LLM") {
    if (!message.llmConfig || typeof message.llmConfig !== "object") {
      sendResponse({ ok: false, error: "no llmConfig" }); return true;
    }
    const data = { llmConfig: message.llmConfig };
    const origin = sender && sender.origin ? sender.origin : (sender && sender.url ? new URL(sender.url).origin : "");
    if (origin) data.webOrigin = origin;
    chrome.storage.local.set(data, () => {
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

  // Resume removal: the website deleted the stored resume, so clear it here too
  // (keeps the extension's IndexedDB in step with the website — the inverse of
  // AP_SYNC_RESUME). Idempotent: no stored resume still resolves ok.
  if (type === "AP_CLEAR_RESUME") {
    (async () => {
      try {
        await deleteResume();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // FULL-FLOW RUN (the website "Run" button). This is the ONE external message that
  // ACTUATES — every other AP_* handler above only PERSISTS the handoff. It drives the
  // whole pipeline hands-off: open the job link in a FRESH tab → grab the job description
  // → Apply → sign-in / create-account → email verification (if the tenant needs it) →
  // fill every page → STOP on the review page. It NEVER submits (runCdpWalk's double
  // guard is untouched). Reachable only from an externally_connectable origin (localhost),
  // so a random web page cannot trigger it. Mirrors the popup's RUN_CDP_ONBOARD chaining,
  // but for a website-initiated run in its own tab, and always continues into the fill walk
  // (the website Run button IS the explicit opt-in the popup's continueToWalk toggle gates).
  if (type === "AP_RUN_APPLICATION") {
    (async () => {
      try {
        const startUrl = typeof message.startUrl === "string" ? message.startUrl.trim() : "";
        if (!/^https?:\/\/\S+$/i.test(startUrl)) {
          sendResponse({ ok: false, error: "bad-url", detail: "Pass a full https:// job link." });
          return;
        }
        // A discovery sweep may be holding the CDP attachment (see discoverInFlight) — refuse
        // rather than let the two fight over cdp.js's single tracked tab mid-fill.
        if (discoverInFlight) {
          sendResponse({ ok: false, error: "discover-in-flight", detail: "A job-discovery sweep is running. Wait for it to finish, then run again." });
          return;
        }
        const store = await new Promise((r) =>
          chrome.storage.local.get(["profile", "defaults", "jobContext", "credentials", "onboardConfig", "buckets"], r)
        );
        if (!store.profile) {
          sendResponse({ ok: false, error: "no-profile", detail: "Sync your profile to the extension first (the Connect page)." });
          return;
        }

        // MULTI-ATS routing (2026-07-31): Greenhouse / Lever / Ashby postings run the ats.js
        // pipeline — single page, no login, no onboarding stage. Workday (and anything
        // unrecognized, which is treated as Workday for backward compat) keeps the existing
        // onboard→walk path below, byte-identical.
        const atsKind = detectAts(startUrl);
        if (atsKind && atsKind !== "workday") {
          runInFlight = true;
          try {
            const background = message.background === true;
            emitRunProgress("Opening the job posting", (background ? "in a background tab — " : "") + atsKind);
            const tab = await new Promise((res) => chrome.tabs.create({ url: startUrl, active: !background }, res));
            if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
            await waitTabComplete(tab.id, 20000);
            const res = await runAtsApplicationRun(tab.id, atsKind, store, startUrl);
            sendResponse({ ...res, tabId: tab.id, startUrl });
          } catch (e) {
            sendResponse({ ok: false, error: "exception:" + String((e && e.message) || e) });
          } finally {
            runInFlight = false;
          }
          return;
        }
        const cfg = store.onboardConfig || {};
        // Gmail auto-verify defaults ON for a website run (an email-verify tenant would otherwise
        // halt); the message may override, and the stored toggle wins if explicitly OFF.
        const gmailEnabled = message.gmailEnabled !== undefined ? !!message.gmailEnabled : (cfg.gmailEnabled !== false);
        // Background fill (the website "Run in background" button): open the job tab UNFOCUSED
        // (active:false) so the operator stays on the Run page while the pipeline works — TRULY
        // hidden (operator requirement 2026-07-25; the visible mini-window variant was built and
        // REVERTED same day — see progress-log). Hidden-tab speed comes from the SYNTHETIC-INPUT
        // mode (cdp.js): page-side event dispatch via Runtime.evaluate replaces the frame-gated
        // Input.* pipeline (~1.2–1.5s/event hidden), with worker-timers + CSP bypass keeping the
        // page's own reactions fast. A genuinely-unrenderable step still halts self-explaining
        // (e.g. hidden-render-stalled) rather than guessing.
        const background = message.background === true;

        runInFlight = true;
        emitRunProgress("Opening the job posting", background ? "in a background tab" : "");
        // Open the job link in a new tab and wait for the first load to settle.
        const tab = await new Promise((res) => chrome.tabs.create({ url: startUrl, active: !background }, res));
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const tabId = tab.id;
        console.log(`[ApplyPilot][RUN] opened job tab ${tabId} (${background ? "BACKGROUND — hidden; synthetic-input fast path" : "foreground"})`);
        await waitTabComplete(tabId, 20000);
        // Wait for the posting to actually FINISH rendering before reading or clicking it (replaces a
        // flat 1500ms beat — see waitJobPageSettled). Under-waiting here truncated the saved job
        // description AND reflowed the Apply button out from under the cover-check.
        const settle = await waitJobPageSettled(tabId);
        console.log(
          `[ApplyPilot][RUN] job page ${settle.settled ? "SETTLED" : "did NOT settle (" + settle.reason + ")"} after ${settle.waitedMs}ms — ${settle.chars} chars` +
          `${settle.hasPosting ? ", posting content present" : ", posting content NOT found (the scrape may be partial)"}`
        );

        // Grab the job description BEFORE onboarding clicks Apply (which navigates away). Best-effort:
        // a failed/empty scrape never blocks the run. Plain scripting read — no debugger needed yet.
        let jd = null;
        emitRunProgress("Reading the job description");
        try {
          const results = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeJobDescription });
          jd = (results && results[0] && results[0].result) || null;
          console.log("[ApplyPilot][RUN] job description scraped:", jd ? `"${(jd.title || "").slice(0, 60)}" (${(jd.text || "").length} chars)` : "none");
        } catch (e) {
          console.log("[ApplyPilot][RUN] JD scrape skipped:", String((e && e.message) || e));
        }

        // The company for THIS application (scraped from the posting we opened) is authoritative for the
        // run — it's what the "are you a former/current «company» employee?" screening questions name, and
        // it feeds the deterministic employment-status recognizer (fill-driver) + the tracker row. Prefer
        // the freshly-scraped company over any stale stored jobContext.company.
        const jobContext = { ...(store.jobContext || {}) };
        if (jd && jd.company) jobContext.company = jd.company;
        if (jobContext.company) console.log("[ApplyPilot][RUN] job context company:", jobContext.company);

        // BEFORE the Workday path: does this page EMBED a non-Workday application? An employer
        // careers page matches no ATS host pattern, so it lands here — but it may be serving a
        // Greenhouse/Lever/Ashby form from an iframe. Probing once HERE covers every way the
        // Workday onboarding could otherwise fail on it (live 2026-08-02: one such page reported
        // unknown-page, another auth-form-not-rendered — same cause, two symptoms). Skipped
        // entirely for URLs that DO name an ATS, so Workday runs pay nothing for this.
        if (!detectAts(startUrl)) {
          try {
            const att = await cdpAttach(tabId);
            if (att.ok) {
              const emb = await cdpEval(atsInjFindEmbeddedForms).catch(() => null);
              const embUrl = emb && atsPickEmbeddedForm(emb.srcs, detectAts);
              const embAts = embUrl && detectAts(embUrl);
              await cdpDetach();
              if (embAts && embAts !== "workday") {
                console.log(`[ApplyPilot][RUN] this page embeds a ${embAts} application — driving it with that pipeline: ${embUrl}`);
                const res = await runAtsApplicationRun(tabId, embAts, store, embUrl, { applyHops: 1, originUrl: startUrl });
                sendResponse({ ...res, jd, tabId, startUrl });
                return;
              }
            }
          } catch (e) { console.log("[ApplyPilot][RUN] embedded-form probe skipped:", String((e && e.message) || e)); }
        }

        // Pre-form stage. The tab is ALREADY on the JD page (we created it there), so pass
        // startUrl:null — runCdpOnboard scans the current page and proceeds to Apply, no re-nav.
        // preferResumeAutofill: a FILL run takes "Autofill with Resume" so Workday parses the résumé and
        // seeds the Skills section with its suggestions; the fill then refills the form as if blank. The
        // SUBMIT/rehearse run below deliberately does NOT, so saved skills survive un-reparsed.
        const onb = await runCdpOnboard(tabId, { credentials: store.credentials || null, gmailEnabled, startUrl: null, preferResumeAutofill: true });
        await removeInputLock(); // onboarding locked the page across the login flow; the walk re-installs per page. NEVER leave it on a halt.
        // The page turned out to host a non-Workday ATS in an iframe — drive it with that
        // pipeline instead of reporting a page we could not read.
        if (onb && onb.embeddedAts && onb.embeddedUrl) {
          await cdpDetach();
          const res = await runAtsApplicationRun(tabId, onb.embeddedAts, store, onb.embeddedUrl, { applyHops: 1 });
          sendResponse({ ...res, tabId, startUrl });
          return;
        }
        if (!onb.ok || !onb.reached_form) {
          sendResponse({ ...onb, walked: false, jd, tabId, startUrl });
          return;
        }

        console.log("[ApplyPilot][RUN] reached the form — filling the application through to the review page (never submits).");
        // Record WHICH account got us in, so this run's report can put it on the tracker row. Also
        // RETURNED below, so the website's own saveRunJob records the account the extension actually
        // used (not the website's separately-stored copy, which could be un-synced).
        const runLogin = await recordRunLogin({
          email: (store.credentials && store.credentials.email) || "",
          url: startUrl,
          tenant: jobContext.company || null,
          created: !!onb.account_created,
          verified: !!onb.verified,
        });
        emitRunProgress("Filling the application", "working through the form to the review page");
        const walk = await runCdpWalk(tabId, store.profile, store.defaults || {}, jobContext);
        // reportApplication (in the walk's finally) upserts the tracker row keyed by the BUNDLE url —
        // the form page, which differs from the pasted startUrl once Apply/login navigates. Return that
        // url so the web side saves the JD onto the SAME row instead of creating a second, empty one.
        const { reviewSummary } = await new Promise((r) => chrome.storage.local.get("reviewSummary", r));
        const reportedUrl = (reviewSummary && reviewSummary.url) || null;
        sendResponse({ ...onb, walked: true, walk, jd, tabId, startUrl, reportedUrl, login: runLogin });
      } catch (e) {
        sendResponse({ ok: false, error: "exception:" + String((e && e.message) || e) });
      } finally {
        runInFlight = false; // stop replaying stale progress to a port that connects after this run
      }
    })();
    return true; // async sendResponse — the full run keeps the port open (the debugger session keeps the SW alive)
  }

  // JOB DISCOVERY (the website "Discover" button on /app/run). Sweeps the operator's
  // signed-in LinkedIn + Handshake job searches and the SimplifyJobs 2026 internship board
  // for recently-posted jobs they have NOT already applied to / queued, opens each posting
  // just long enough to scrape its description, closes it, and RETURNS the list. The website
  // persists the result into `queue_items` — discovery itself writes NOTHING (same
  // "engine computes / the caller does I/O" split the fill engine follows) and NEVER applies.
  //
  // The website passes `knownKeys` (discoveryJobKey of every application + queued job it
  // already has) so the sweep can skip them BEFORE spending a tab open on their JD; the
  // website de-dupes again on insert, which is the authoritative pass.
  if (type === "AP_DISCOVER_JOBS") {
    (async () => {
      // discoverInFlight FIRST: this handler sets runInFlight too (to keep the progress port
      // replaying), so checking runInFlight first would mislabel a second sweep as "a run".
      if (discoverInFlight) {
        sendResponse({ ok: false, error: "discover-in-flight", detail: "A discovery sweep is already running." });
        return;
      }
      if (runInFlight) {
        sendResponse({ ok: false, error: "run-in-flight", detail: "An application run is in progress. Wait for it to finish, then discover again." });
        return;
      }
      discoverInFlight = true;
      runInFlight = true; // keeps the progress port replaying this sweep's phases (see onConnectExternal)
      try {
        const out = await runJobDiscovery({
          sources: message.sources || undefined,
          knownKeys: Array.isArray(message.knownKeys) ? message.knownKeys : [],
          query: typeof message.query === "string" ? message.query : undefined,
          // Search targeting (2026-07-29). `field` is the operator's field of study,
          // the fallback the keywords are DERIVED from when the box is blank — a
          // blank LinkedIn search returns its recommended feed, not their jobs.
          field: typeof message.field === "string" ? message.field : undefined,
          intern: message.intern,
          cycle: typeof message.cycle === "string" ? message.cycle : undefined,
          year: typeof message.year === "string" || typeof message.year === "number" ? String(message.year) : undefined,
          location: typeof message.location === "string" ? message.location : undefined,
          sinceDays: message.sinceDays,
          maxPerSource: message.maxPerSource,
          // ⚠ Pass these through ONLY when the caller actually sent them. Object
          // spread copies a key whose value is `undefined`, so forwarding an absent
          // field OVERWRITES the DISCOVER_DEFAULTS entry with undefined — which is
          // how `maxTotal` came to be silently inert (`slice(0, undefined)` returns
          // everything, so the 60-job cap never applied on the website path).
          ...(message.maxTotal != null ? { maxTotal: message.maxTotal } : {}),
          ...(message.maxJdOpens != null ? { maxJdOpens: message.maxJdOpens } : {}),
          ...(message.maxRecords != null ? { maxRecords: message.maxRecords } : {}),
          // Scrape wide, queue narrow (2026-07-30): how many result pages to sweep,
          // and how many of the best-matching to actually return for queueing.
          ...(message.maxPages != null ? { maxPages: message.maxPages } : {}),
          ...(message.minMatchPercent != null ? { minMatchPercent: message.minMatchPercent } : {}),
          ...(Array.isArray(message.jobTitles) ? { jobTitles: message.jobTitles } : {}),
          ...(Array.isArray(message.skills) ? { skills: message.skills } : {}),
          ...(message.maxQueries != null ? { maxQueries: message.maxQueries } : {}),
          ...(message.skipEasyApply != null ? { skipEasyApply: message.skipEasyApply } : {}),
          background: message.background !== false, // sweep tabs open UNFOCUSED by default
        });
        sendResponse(out);
      } catch (e) {
        // runJobDiscovery is never-throws by contract; this is the belt for a load-order /
        // programming error, so the website gets a real message instead of a dead port.
        sendResponse({ ok: false, error: "exception:" + String((e && e.message) || e) });
      } finally {
        discoverInFlight = false;
        runInFlight = false;
      }
    })();
    return true; // async sendResponse — a sweep takes as long as its tab opens
  }

  // RELOAD THE SERVICE WORKER — a DEVELOPMENT convenience (operator-approved 2026-07-30).
  //
  // WHY: editing an unpacked extension's files does NOT reload it; that needs a click on
  // chrome://extensions, which no page and no automation can reach. During a build/verify
  // loop that click is the slowest step in the cycle, so this lets the local dev site ask
  // the worker to restart itself.
  //
  // SAFETY: `externally_connectable` already restricts every external message to
  // `http://localhost/*` and `http://127.0.0.1/*`, so only a page served from this
  // machine can send it. It takes no arguments, touches no data, and reads nothing —
  // `chrome.runtime.reload()` restarts the worker and that is all. It is REFUSED while a
  // run or a sweep is in flight, because tearing the worker down mid-walk would strand a
  // CDP attach and abandon a half-filled application.
  if (type === "AP_RELOAD") {
    if (runInFlight || discoverInFlight) {
      sendResponse({ ok: false, error: "busy", detail: "A run or sweep is in progress — not reloading mid-flight." });
      return true;
    }
    console.log("[ApplyPilot] AP_RELOAD — restarting the service worker at the local site's request");
    sendResponse({ ok: true, reloading: true });
    apDevLogFlush(); // persist the tail NOW — the reload discards whatever is only in memory
    // Let the response flush before the worker goes away.
    setTimeout(() => { try { chrome.runtime.reload(); } catch (e) { /* nothing left to do */ } }, 150);
    return true;
  }

  // DEV: read the service-worker console from the local dev site (see the DEV LOG MIRROR block at the
  // top of this file for why this exists). Read-only — it returns buffered log lines and nothing else.
  //
  // `since` is a cursor: pass back the `cursor` from the previous reply to get only what's new, which is
  // how a run is tailed without re-reading the whole buffer. `pattern` is a case-insensitive regex over
  // the line text (e.g. "CDP-TIME|HALT"), `limit` caps the reply (newest kept, `truncated` says so), and
  // `clear` empties the buffer after replying. Allowed DURING a run — watching a live walk is the point.
  if (type === "AP_DEV_LOGS") {
    const sel = devLogSelect(apDevLog, { since: message.since, pattern: message.pattern, limit: message.limit });
    sendResponse({
      ok: true,
      lines: sel.lines,
      // The cursor advances only to what was actually returned, so a truncated reply can't skip lines.
      cursor: sel.lines.length ? sel.lines[sel.lines.length - 1].n : (Number(message.since) || 0),
      seq: apDevLogSeq,
      buffered: apDevLog.length,
      matched: sel.matched,
      truncated: sel.truncated,
      dropped: apDevLogDropped, // >0 ⇒ the ring evicted lines; the window is incomplete, not empty
      patternError: sel.patternError || undefined,
      workerStartedAt: AP_DEV_WORKER_START, // a change here means the worker restarted mid-poll
      runInFlight,
      discoverInFlight,
    });
    if (message.clear) { apDevLog = []; apDevLogDropped = 0; apDevLogFlush(); }
    return true;
  }

  // DEV: read/write the debug KILL-SWITCHES. They live in chrome.storage.local and, until now, could
  // only be set from the service-worker console — so from the localhost bridge they were effectively
  // unreachable. WHITELISTED keys only: this must never become an arbitrary-storage write (the profile,
  // the review bundle and the session all live in the same store). Omit `value` to read them all.
  if (type === "AP_DEV_FLAG") {
    const ALLOWED = ["skipPreSaveReverify", "forceTrustedInput", "forceWorkerTimersOff", "debugInputTrace", "debugGroupWatch", "disableAiBatch", "debugAiPrompts", "debugClobber", "debugPageTrace"];
    (async () => {
      if (message.key === undefined) {
        const all = await new Promise((r) => chrome.storage.local.get(ALLOWED, r));
        sendResponse({ ok: true, flags: all, allowed: ALLOWED });
        return;
      }
      const key = String(message.key);
      if (!ALLOWED.includes(key)) { sendResponse({ ok: false, error: "not a debug flag: " + key, allowed: ALLOWED }); return; }
      if (message.value === undefined) {
        const got = await new Promise((r) => chrome.storage.local.get(key, r));
        sendResponse({ ok: true, key, value: got[key] ?? null });
        return;
      }
      const value = !!message.value;
      await new Promise((r) => chrome.storage.local.set({ [key]: value }, r));
      console.log(`[ApplyPilot][DEV] flag ${key} = ${value}`);
      sendResponse({ ok: true, key, value });
    })();
    return true;
  }

  // DEV: read-only ATS form scan of a NAMED tab (the fill run returns its tabId) — the
  // "go to the tab and see what actually happened" verification, machine-readable. CDP
  // attach → atsInjScan (fixed function, no arbitrary code) → detach. Refused mid-run
  // (one debugger client per tab — an attach here would clobber a running walk's).
  // DEV-ONLY (localhost): experiment on a live Workday checkbox group to learn whether it is
  // pick-one or multi. Reads the groups, then optionally checks two boxes in turn and reports the
  // state after each — "trace the real DOM before writing a handler" applied to an INTERACTION rule
  // rather than a shape. Never submits, never clicks anything but the boxes it is told to.
  if (type === "AP_DEV_WD_PROBE") {
    (async () => {
      if (runInFlight || discoverInFlight) { sendResponse({ ok: false, error: "busy" }); return; }
      let tabId = Number(message.tabId) || 0;
      if (!tabId && message.urlContains) {
        const tabs = await new Promise((r) => chrome.tabs.query({}, r));
        const hit = (tabs || []).find((t) => t.url && t.url.includes(String(message.urlContains)));
        if (hit) tabId = hit.id;
      }
      if (!tabId) { sendResponse({ ok: false, error: "no tab matched" }); return; }
      try {
        const attached = await cdpAttach(tabId);
        if (!attached.ok) { sendResponse({ ok: false, error: "attach-failed:" + attached.error }); return; }
        const steps = [];
        // `reload` re-enters the page fresh, which is how you observe what Workday renders BEFORE any
        // fill touches it — the pre-state a settled scan sees. Every step reports the FULL wrapper
        // inventory so "is this field mounted at all?" is answerable, not just "what is checked".
        if (message.reload) {
          await cdpSend("Page.reload", { ignoreCache: false });
          await cdpDelay(Number(message.reloadWaitMs) || 12000);
          steps.push({ step: "after reload", wrappers: await cdpEval(cdpDevWrappers) });
        }
        let groups = await cdpEval(cdpDevGroups);
        steps.push({ step: "initial", groups, wrappers: await cdpEval(cdpDevWrappers) });
        const target = (groups || []).find((g) => !message.fieldName || g.fieldName === message.fieldName);
        // Geometry: what actually sits under the point the FILLER clicks (see cdpDevBoxGeom).
        if (target && message.geom) steps.push({ step: "geometry", geom: await cdpEval(cdpDevBoxGeom, target.wrapperSel) });
        if (target && Array.isArray(message.checkIds)) {
          for (const id of message.checkIds) {
            const r = await cdpEval(cdpDevClickBox, { wrapperSel: target.wrapperSel, id });
            await cdpDelay(900);
            groups = await cdpEval(cdpDevGroups);
            const g = (groups || []).find((x) => x.fieldName === target.fieldName);
            steps.push({ step: "clicked " + id, click: r, checked: g ? g.boxes.filter((b) => b.checked).map((b) => b.label) : null });
          }
        }
        // COORDINATE click — byte-identical to what the filler does (clickRadioLabel: resolve the
        // label's rect, then cdpClickAt its centre). Compared against the page-side `label.click()`
        // above, this isolates the actuation as the variable: same box, same page, different primitive.
        if (target && Array.isArray(message.coordClickIds)) {
          for (const id of message.coordClickIds) {
            const rect = await cdpRectReady('label[for="' + id + '"]', true);
            if (!rect) { steps.push({ step: "coordClick " + id, error: "no label rect" }); continue; }
            await cdpClickAt(rect.cx, rect.cy);
            await cdpDelay(900);
            groups = await cdpEval(cdpDevGroups);
            const g = (groups || []).find((x) => x.fieldName === target.fieldName);
            steps.push({ step: "coordClick " + id, at: [Math.round(rect.cx), Math.round(rect.cy)],
              checked: g ? g.boxes.filter((b) => b.checked).map((b) => b.label) : null });
          }
        }
        sendResponse({ ok: true, url: (await new Promise((r) => chrome.tabs.get(tabId, r))).url, steps });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      } finally { await cdpDetach(); }
    })();
    return true;
  }
  if (type === "AP_DEV_ATS_SCAN") {
    (async () => {
      if (runInFlight || discoverInFlight) { sendResponse({ ok: false, error: "busy" }); return; }
      const ats = String(message.ats || "");
      let tabId = Number(message.tabId) || 0;
      if (!tabId && message.urlContains) {
        // find the run's tab by URL fragment (the caller usually lost the tabId to a page nav)
        const tabs = await new Promise((r) => chrome.tabs.query({}, r));
        const hit = (tabs || []).find((t) => t.url && t.url.includes(String(message.urlContains)));
        if (hit) tabId = hit.id;
      }
      if (!tabId || !ats) { sendResponse({ ok: false, error: "need tabId (or urlContains) + ats" }); return; }
      try {
        const attached = await cdpAttach(tabId);
        if (!attached.ok) { sendResponse({ ok: false, error: "attach-failed:" + attached.error }); return; }
        const scan = await cdpEval(atsInjScan, ats);
        const state = await cdpEval(atsInjSubmitState, ats).catch(() => null);
        sendResponse({ ok: true, scan, submitState: state });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      } finally {
        await cdpDetach();
      }
    })();
    return true;
  }

  // DEV: close the tabs a test sweep opened. Each run opens a job tab and deliberately LEAVES
  // it (so the operator can look at what happened), which piles up over a testing session.
  // Matches on a url substring and never touches the tab that asked (the dev site).
  if (type === "AP_DEV_CLOSE_TABS") {
    (async () => {
      const needle = String(message.urlContains || "");
      if (!needle) { sendResponse({ ok: false, error: "need urlContains" }); return; }
      const tabs = await new Promise((r) => chrome.tabs.query({}, r));
      const senderTabId = sender && sender.tab && sender.tab.id;
      const ids = (tabs || [])
        .filter((t) => t.url && t.url.includes(needle) && t.id !== senderTabId)
        .map((t) => t.id);
      if (ids.length) await new Promise((r) => chrome.tabs.remove(ids, r));
      console.log(`[ApplyPilot][DEV] closed ${ids.length} tab(s) matching ${JSON.stringify(needle)}`);
      sendResponse({ ok: true, closed: ids.length });
    })();
    return true;
  }

  // DISCOVERY RECON (read-only). Opens each board's search page in the operator's real
  // signed-in session and dumps what the DOM actually looks like — selector hit-counts plus
  // one representative card's markup — so the list scrapers' selector ladders can be
  // tightened from OBSERVATION instead of the structure-first guesses they ship with.
  // Same role the CDP recon harnesses play for a new Workday tenant. Queues nothing.
  if (type === "AP_DISCOVER_RECON") {
    (async () => {
      if (runInFlight || discoverInFlight) {
        sendResponse({ ok: false, error: "busy", detail: "A run or sweep is in progress." });
        return;
      }
      discoverInFlight = true;
      try {
        sendResponse(await runDiscoverRecon({ sources: message.sources || undefined, query: message.query, field: message.field, intern: message.intern, location: message.location, sinceDays: message.sinceDays, background: message.background !== false }));
      } catch (e) {
        sendResponse({ ok: false, error: "exception:" + String((e && e.message) || e) });
      } finally {
        discoverInFlight = false;
      }
    })();
    return true;
  }

  // FULL SUBMIT RUN (the website "Submit" button) — the third stage, driven from the site. The
  // SECOND external message that actuates, and the ONLY one that can submit. It replays the
  // APPROVED bundle for ONE named job and, at the review page, runs the M4 precondition gate:
  //   open the posting in a fresh tab → sign in (runCdpOnboard) → runCdpReplayWalk(authorize:true)
  //   → strict per-field verify per page → review-page equality → the gate → submit ONCE.
  //
  // SAFETY, in layers (none of them removed by this handler — it only ADDS a caller):
  //   • `arm:true` is the per-run authorization token. WITHOUT it the run is a full DRY rehearsal:
  //     simulateSubmit stays ON, so it does everything and logs "▶▶ WOULD CLICK SUBMIT ◀◀" instead
  //     of clicking. The website only sends arm:true from the second click of a two-step confirm.
  //   • the bundle is pulled BY JOB KEY and the run REFUSES when nothing matches — it must never
  //     replay some other application's approved values into this form (the review endpoint's
  //     no-match fallback is "the most recently updated bundle", which is exactly that hazard).
  //   • a PRE-FLIGHT bundleSubmitBlockers check refuses before opening a tab, so "3 fields still
  //     need approval" costs milliseconds instead of a full sign-in + replay.
  //   • submitPrecondition still runs at the review page and is still the authority: every flagged
  //     field approved, no AI placeholder, the review page DISPLAYING exactly the approved values.
  if (type === "AP_SUBMIT_APPLICATION") {
    (async () => {
      const LOG = (...a) => console.log("[ApplyPilot][SUBMIT-RUN]", ...a);
      try {
        const startUrl = typeof message.startUrl === "string" ? message.startUrl.trim() : "";
        if (!/^https?:\/\/\S+$/i.test(startUrl)) {
          sendResponse({ ok: false, error: "bad-url", detail: "Pass a full https:// job link." });
          return;
        }
        // A discovery sweep may be holding the CDP attachment (cdp.js tracks ONE cdpTabId), and
        // this run is the one that can SUBMIT — never let a background sweep steal its attach
        // mid-replay. Same guard AP_RUN_APPLICATION carries.
        if (discoverInFlight) {
          sendResponse({ ok: false, error: "discover-in-flight", detail: "A job-discovery sweep is running. Wait for it to finish, then submit again." });
          return;
        }
        const arm = message.arm === true; // the per-run submit token — absent ⇒ dry rehearsal
        const background = message.background === true;
        const jobKey = canonicalJobUrl(startUrl);
        const store = await new Promise((r) => chrome.storage.local.get(["credentials", "onboardConfig", "jobContext"], r));
        const cfg = store.onboardConfig || {};
        const gmailEnabled = message.gmailEnabled !== undefined ? !!message.gmailEnabled : cfg.gmailEnabled !== false;

        runInFlight = true;
        emitRunProgress(arm ? "Preparing the submit run" : "Preparing the submit rehearsal", "loading your approved review");

        // ── 1. The approved bundle for THIS job (exact key, no "most recent" fallback). ──
        const pull = await pullApprovedBundle(LOG, { jobKey });
        if (!pull.pulled) {
          const why = {
            "not-connected": "This browser isn't linked to your account yet — connect the extension, then submit from here.",
            "no-review-url": "The extension has no review endpoint — re-sync from the Connect page.",
            "no-remote-bundle": "No approved review was found for this job. Run the fill first, then review and approve it on the Tracker.",
          };
          LOG(`REFUSING: no approved bundle for job_key "${jobKey}" (${pull.reason}) — never replaying a different application's values.`);
          sendResponse({ ok: false, error: "no-approved-bundle", reason: pull.reason, job_key: jobKey, detail: why[pull.reason] || `Couldn't load the approved review (${pull.reason}).` });
          return;
        }

        // ── 2. PRE-FLIGHT: is the bundle approved enough to submit at all? (Same predicate the live
        //      gate uses — bundleSubmitBlockers — so this can only agree with it, never relax it.) ──
        const preBlockers = bundleSubmitBlockers(pull.bundle);
        if (preBlockers.length) {
          LOG(`NOT submitting — ${preBlockers.length} blocker(s) before we even open the tab:`);
          preBlockers.forEach((b) => LOG(`    ✗ ${b}`));
          // NAME the offending fields and the FLAGS that make each one block. The review page and
          // this gate compute 'still needs approval' separately (web requiresApproval vs
          // bundleSubmitBlockers), and when they disagree the operator sees 'all approved' while the
          // submit refuses — a dead end with nothing to click (live 2026-08-02). Whatever the cause,
          // the run must never just say no: print the evidence needed to settle it.
          try {
            const ents = (pull.bundle && pull.bundle.entries) || [];
            const stuck = ents.filter((e) => e && !e.is_deleted && (e.needs_review || e.cascade_revealed) && !e.is_approved);
            if (stuck.length) {
              LOG(`    the ${stuck.length} field(s) this gate is waiting on:`);
              stuck.slice(0, 10).forEach((e) => LOG(
                `      · ${JSON.stringify(String(e.question_label || e.field_id || "").slice(0, 60))}` +
                ` needs_review=${!!e.needs_review} cascade_revealed=${!!e.cascade_revealed} approved=${!!e.is_approved}` +
                ` flag=${JSON.stringify(e.flag || null)} status=${JSON.stringify(e.fill_status || null)}` +
                ` value=${JSON.stringify(String(e.current_value == null ? "" : e.current_value).slice(0, 28))}`
              ));
            }
          } catch (e) { LOG("    (could not detail the blockers:", String((e && e.message) || e) + ")"); }
          sendResponse({ ok: false, error: "not-approved", blockers: preBlockers, job_key: jobKey, application_id: pull.application_id || null, detail: "Finish approving this application's review, then submit." });
          return;
        }
        LOG(`approved bundle loaded for job_key "${jobKey}" (${pull.count} field(s)) — ${arm ? "⚠ ARMED: this run WILL submit if every gate passes." : "DRY rehearsal: runs the whole gate and stops at 'would submit'."}`);

        // MULTI-ATS routing (2026-07-31): a Greenhouse/Lever/Ashby submit is a re-fill of a
        // BLANK form from the approved bundle — no sign-in, no walk. The gates keep the same
        // shape: bundle blockers (already checked above) + strict live verify + no visible
        // captcha + arm. Workday keeps the existing onboard→replay path below.
        {
          // URL first (cheap + covers the board-hosted case), then what the FILL recorded — an
          // employer-hosted form is invisible to detectAts but was filled by this pipeline.
          const atsKind = detectAts(startUrl) || (pull.bundle && pull.bundle.ats) || null;
          if (!detectAts(startUrl) && atsKind) LOG(`the URL names no ATS, but this application was filled by the ${atsKind} pipeline — using it`);
          if (atsKind && atsKind !== "workday") {
            emitRunProgress(arm ? "Submitting" : "Rehearsing", atsKind + " — " + (background ? "background tab" : "foreground tab"));
            const tab = await new Promise((res) => chrome.tabs.create({ url: startUrl, active: !background }, res));
            if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
            await waitTabComplete(tab.id, 20000);
            const res = await runAtsSubmitRun(tab.id, atsKind, pull.bundle, { arm, startUrl });
            sendResponse({ ...res, job_key: jobKey, application_id: pull.application_id || null, tabId: tab.id, startUrl });
            return;
          }
        }

        // ── 3. Open the posting + sign in (the form is per-session; a submit run always re-onboards). ──
        // BACKGROUND is supported (2026-07-28): the replay enables synthetic input for its field
        // actuation, so a hidden run isn't paying ~1.2-1.5s per input event. Sign-in still runs trusted
        // on its own attach, and the final submit click is forced trusted — see runCdpReplayWalk.
        emitRunProgress("Opening the job posting", background ? "in a background tab" : "");
        const tab = await new Promise((res) => chrome.tabs.create({ url: startUrl, active: !background }, res));
        if (!tab || tab.id === undefined) { sendResponse({ ok: false, error: "no-tab" }); return; }
        const tabId = tab.id;
        await waitTabComplete(tabId, 20000);
        // Same settle as the fill run: a half-rendered posting reflows under onboarding's Stage-1 cover
        // check. A submit run doesn't scrape the JD, but it clicks the very same Apply button.
        const settle = await waitJobPageSettled(tabId);
        LOG(`job page ${settle.settled ? "SETTLED" : "did NOT settle (" + settle.reason + ")"} after ${settle.waitedMs}ms — ${settle.chars} chars.`);

        emitRunProgress("Signing in", "reaching the application form");
        const onb = await runCdpOnboard(tabId, { credentials: store.credentials || null, gmailEnabled, startUrl: null });
        await removeInputLock(); // onboarding locked the page across the login flow; the walk re-installs per page. NEVER leave it on a halt.
        if (!onb.ok || !onb.reached_form) {
          sendResponse({ ...onb, submitted: false, replayed: false, job_key: jobKey, tabId, startUrl });
          return;
        }
        const runLogin = await recordRunLogin({
          email: (store.credentials && store.credentials.email) || "",
          url: startUrl,
          tenant: (store.jobContext && store.jobContext.company) || null,
          created: !!onb.account_created,
          verified: !!onb.verified,
        });

        // ── 4. Replay the approved values page-by-page → review → gate → submit (or "would submit"). ──
        emitRunProgress(arm ? "Replaying your approved answers" : "Rehearsing your approved answers", "verifying every field on the way to review");
        const submit = await runCdpReplayWalk(tabId, { authorize: true, simulateSubmit: !arm, jobKey });
        emitRunProgress(
          submit.submitted ? "Submitted" : submit.would_submit ? "Rehearsal complete — every gate passed" : "Stopped before submitting",
          submit.stopped || ""
        );
        sendResponse({ ...onb, replayed: true, submit, armed: arm, job_key: jobKey, application_id: pull.application_id || null, login: runLogin, tabId, startUrl });
      } catch (e) {
        sendResponse({ ok: false, error: "exception:" + String((e && e.message) || e) });
      } finally {
        runInFlight = false;
      }
    })();
    return true; // async sendResponse — the whole submit run keeps the port open
  }

  // Account sign-in credentials (email + password) → chrome.storage.local.credentials, the
  // SAME slot the popup's "Load credentials" writes and runCdpOnboard reads for sign-in /
  // create-account. Website-managed now (the Credentials page), autosynced like the profile.
  // Both blank ⇒ CLEAR (so removing them on the site removes them here too). Persist only —
  // no sign-in happens here.
  if (type === "AP_SET_CREDENTIALS") {
    const email = typeof message.email === "string" ? message.email.trim() : "";
    const password = typeof message.password === "string" ? message.password : "";
    if (!email && !password) {
      chrome.storage.local.remove("credentials", () => {
        const err = chrome.runtime.lastError;
        sendResponse(err ? { ok: false, error: err.message } : { ok: true, cleared: true });
      });
      return true;
    }
    chrome.storage.local.set({ credentials: { email, password } }, () => {
      const err = chrome.runtime.lastError;
      sendResponse(err ? { ok: false, error: err.message } : { ok: true });
    });
    return true;
  }

  // Onboarding config patch (e.g. { gmailEnabled }) → merged into chrome.storage.local.onboardConfig,
  // read-modify-write exactly like the popup's onboarding toggles. The website surfaces the Gmail
  // auto-verify toggle; continueToWalk/startUrl stay popup-only (the website Run passes the URL
  // directly and always walks).
  if (type === "AP_SET_ONBOARD_CONFIG") {
    const patch = message.onboardConfig && typeof message.onboardConfig === "object" ? message.onboardConfig : null;
    if (!patch) { sendResponse({ ok: false, error: "no onboardConfig" }); return true; }
    chrome.storage.local.get("onboardConfig", ({ onboardConfig }) => {
      chrome.storage.local.set({ onboardConfig: { ...(onboardConfig || {}), ...patch } }, () => {
        const err = chrome.runtime.lastError;
        sendResponse(err ? { ok: false, error: err.message } : { ok: true });
      });
    });
    return true;
  }

  // Gmail connect / status from the website. The OAuth itself is Chrome-owned (chrome.identity
  // getAuthToken) and can only run in the extension — this lets the website TRIGGER it:
  // interactive:true shows Chrome's account picker/consent (the "Connect" button); interactive:false
  // is a silent check that reports whether a cached token already works (the status line on load).
  // Reuses the same runGmailSmokeTest the popup's "Connect Gmail" uses → { ok, email, messagesTotal }.
  if (type === "AP_GMAIL_CONNECT") {
    (async () => {
      const out = await runGmailSmokeTest(message.interactive !== false);
      sendResponse(out);
    })();
    return true;
  }

  sendResponse({ ok: false, error: "unknown message type: " + type });
  return true;
});

// Resolve once a tab finishes loading (status "complete"), bounded by timeoutMs. Resolves
// either way — the caller's next step (JD scrape / onboarding scan) is itself guarded, so a
// too-early return only costs a retry, never a wrong action. Used by AP_RUN_APPLICATION to
// wait for the freshly-created job-link tab before scraping + onboarding.
// The JD page is an SPA render: the tab reports "complete" when the DOCUMENT loads, but Workday keeps
// filling the posting in afterwards. The old approach was a FLAT 1500ms beat, which under-waits on a
// hidden tab — live (Caterpillar wd5, background run) a scrape got 461 chars of a posting that healthy
// runs read as 2913, with Workday's raw `XMLNAME …` slug as the title because the real header hadn't
// rendered. The same half-rendered page then REFLOWED under the onboarding cover-check, producing the
// phantom 'covered by "locationsSan Diego, California"' refusal.
//
// So: settle-poll instead, the same discipline the fill's settle-polls use — accept only TWO CONSECUTIVE
// EQUAL, non-empty reads, and prefer a state where the posting's own content is actually present; never
// a fixed sleep. Bounded by a real wall-clock ceiling, and it EXITS EARLY on a warm load (~2 polls), so
// the common case is FASTER than the flat beat it replaces. Best-effort by design: a read failure or a
// timeout stops waiting and lets the run proceed — the scrape and the onboarding scan are each
// independently guarded, so a too-early return costs a retry, never a wrong action.
async function waitJobPageSettled(tabId, ceilingMs = 12000, intervalMs = 300) {
  const t0 = Date.now();
  const deadline = t0 + ceilingMs;
  let state = null, last = null; // the accept RULE is pure + unit-pinned: jobPageSettleStep (lib.js)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    let s = null;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          len: ((document.body && document.body.innerText) || "").length,
          // The posting's own content — the thing the scrape actually reads. Its presence is what makes
          // a stable byte count trustworthy rather than a pause mid-hydration.
          hasPosting: !!document.querySelector('[data-automation-id="jobPostingDescription"], [data-automation-id="jobPostingHeader"]'),
          ready: document.readyState,
        }),
      });
      s = (res && res[0] && res[0].result) || null;
    } catch (e) {
      return { settled: false, reason: "read-failed:" + String((e && e.message) || e), chars: last ? last.len : 0, waitedMs: Date.now() - t0 };
    }
    if (!s) continue;
    last = s;
    state = jobPageSettleStep(s, state);
    if (state.accept) {
      return { settled: true, chars: s.len, hasPosting: !!s.hasPosting, ready: s.ready, waitedMs: Date.now() - t0 };
    }
  }
  return { settled: false, reason: "ceiling", chars: last ? last.len : 0, hasPosting: !!(last && last.hasPosting), waitedMs: Date.now() - t0 };
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) { /* ignore */ }
      resolve();
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId, (t) => { if (!chrome.runtime.lastError && t && t.status === "complete") finish(); });
    setTimeout(finish, timeoutMs || 20000);
  });
}

// Injected into the job-description page (chrome.scripting, page context) to grab a best-effort
// job description before Apply navigates away. Self-contained (closes over nothing). Workday JD
// pages carry a jobPostingHeader/jobPostingDescription; company falls back to the tenant subdomain
// (comcast.wd5.myworkdayjobs.com → "comcast"). All caps are generous but bounded.
function scrapeJobDescription() {
  const pick = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = el && ((el.innerText || el.textContent || "").trim());
      if (t) return t;
    }
    return "";
  };
  const clean = (s) => (s || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const titleCase = (s) => clean(s).split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  // TITLE (deterministic, no AI): the posting header first; else the URL slug ".../<slug>_R<reqid>/…"
  // (the most reliable source — e.g. "Junior-Full-Stack-Developer-Coop_R00244793" → "Junior Full Stack
  // Developer Coop"); else the document title with any " | Company" suffix stripped.
  const slugM = (location.pathname || "").match(/\/([^/]+)_R\d+(?:\/|$)/i);
  // Workday prefixes the slug with "XMLNAME" when the real title starts with a digit
  // ("XMLNAME_2027-Gas-Turbine-…" → "2027 Gas Turbine …"). Strip it, or that artifact becomes the role
  // name on the tracker row. Belt-and-braces: the settle-poll now usually lets the real
  // jobPostingHeader win before this fallback is ever reached.
  const urlTitle = slugM ? clean(decodeURIComponent(slugM[1])).replace(/^XMLNAME\s+/i, "") : "";
  const docTitle = (document.title || "").split(/\s[|–—-]\s/)[0].trim();
  const title = pick(['[data-automation-id="jobPostingHeader"]', '[data-automation-id="jobTitle"]', "h1"]) || urlTitle || docTitle;
  // COMPANY: a company element if present; else the tenant subdomain (posting host), title-cased
  // (magna → Magna); else the career-site/tenant display segment right before "/job/" in the path —
  // needed on the myworkdaysite host, where the tenant is in the PATH, not the subdomain
  // (…/recruiting/magna/Magna/job/… → "Magna").
  let company = pick(['[data-automation-id="company"]', '[data-automation-id="jobPostingCompany"]']);
  if (!company) {
    const m = (location.hostname || "").match(/^([a-z0-9-]+)\.wd\d+\.myworkday(?:jobs|site)\.com$/i);
    if (m) company = titleCase(m[1]);
  }
  if (!company) {
    const pm = (location.pathname || "").match(/\/([^/]+)\/job\//i);
    if (pm) company = titleCase(decodeURIComponent(pm[1]));
  }
  const body = pick(['[data-automation-id="jobPostingDescription"]', '[data-automation-id="richTextArea"]', "main", "body"]);
  return {
    title: title.slice(0, 300),
    company: (company || "").slice(0, 120),
    text: (body || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000),
    url: location.href,
    scrapedAt: new Date().toISOString(),
  };
}

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

  // JOB DISCOVERY from the POPUP — the same sweep the website's Discover button runs, minus
  // the backend. Without the website there are no knownKeys, so nothing is filtered as
  // already-applied and NOTHING is queued: this is the dry-run / debugging entry point.
  // Results land in the SW console. Use the website's Discover button for the real flow.
  if (message.type === "RUN_DISCOVER") {
    (async () => {
      if (runInFlight || discoverInFlight) { sendResponse({ ok: false, error: "busy" }); return; }
      discoverInFlight = true;
      try {
        const out = await runJobDiscovery({
          sources: message.sources || undefined,
          query: message.query,
          field: message.field,
          intern: message.intern,
          cycle: message.cycle,
          year: message.year,
          location: message.location,
          sinceDays: message.sinceDays,
          // Only when actually supplied — an `undefined` here would clobber the
          // default it is meant to override (see the AP_DISCOVER_JOBS note).
          ...(message.maxJdOpens != null ? { maxJdOpens: message.maxJdOpens } : {}),
          ...(message.maxRecords != null ? { maxRecords: message.maxRecords } : {}),
          ...(message.maxPages != null ? { maxPages: message.maxPages } : {}),
          ...(message.minMatchPercent != null ? { minMatchPercent: message.minMatchPercent } : {}),
          ...(Array.isArray(message.jobTitles) ? { jobTitles: message.jobTitles } : {}),
          ...(Array.isArray(message.skills) ? { skills: message.skills } : {}),
          ...(message.maxQueries != null ? { maxQueries: message.maxQueries } : {}),
          ...(message.skipEasyApply != null ? { skipEasyApply: message.skipEasyApply } : {}),
          // The popup is the DRY-RUN path: no website ⇒ no knownKeys ⇒ nothing is
          // filtered as already-applied, and nothing is queued.
          knownKeys: [],
          background: message.background !== false,
        });
        console.log("[ApplyPilot][DISCOVER] popup sweep result (nothing was queued — no website connected):", JSON.stringify(out.stats), out.notes);
        for (const j of out.jobs) console.log(`  · [${j.source}] score ${j.score} · ${j.company || "?"} — ${j.title || "?"} (${j.description ? j.description.length + " char JD" : "no JD"}) ${j.url}  ← ${(j.scoreReasons || []).join("; ")}`);
        sendResponse(out);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      } finally { discoverInFlight = false; }
    })();
    return true; // async sendResponse
  }

  // DISCOVERY RECON from the popup — read-only DOM dump of the LinkedIn/Handshake search
  // pages in the operator's signed-in session. Run this FIRST on a fresh install (or after a
  // board redesign) and paste the [DISCOVER-RECON] output back, so the list scrapers'
  // selectors come from observation. Trace before trusting — the standing working principle.
  if (message.type === "RUN_DISCOVER_RECON") {
    (async () => {
      if (runInFlight || discoverInFlight) { sendResponse({ ok: false, error: "busy" }); return; }
      discoverInFlight = true;
      // `background` is honoured here too: recon must be verifiable in a BACKGROUND
      // tab as well as the foreground (operator 2026-07-30), since that is how a
      // real sweep runs. Defaults to unfocused, like the sweep.
      try { sendResponse(await runDiscoverRecon({ sources: message.sources || undefined, query: message.query, field: message.field, intern: message.intern, location: message.location, sinceDays: message.sinceDays, background: message.background !== false })); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      finally { discoverInFlight = false; }
    })();
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
        await removeInputLock(); // onboarding locked the page across the login flow; the walk re-installs per page. NEVER leave it on a halt.
      // Same login record as the website Run — a popup-driven onboarding gets its account tracked too.
      if (onb.ok && onb.reached_form) {
        let liveUrl = cfg.startUrl || null;
        if (!liveUrl) { try { liveUrl = (await new Promise((r) => chrome.tabs.get(tab.id, r))).url || null; } catch (e) { /* ignore */ } }
        await recordRunLogin({
          email: (store.credentials && store.credentials.email) || "",
          url: liveUrl || "",
          tenant: (store.jobContext && store.jobContext.company) || null,
          created: !!onb.account_created,
          verified: !!onb.verified,
        });
      }
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
      // No config supplied → read the stored one, which the website owns. The popup is a
      // read-only mirror now, so it asks for a test of what is actually saved.
      const cfg = message.config || (await getLlmConfig());
      const keys = typeof llmKeysFor === "function" ? llmKeysFor(cfg, cfg.provider) : [];
      console.log("[ApplyPilot][LLM-TEST] testing", cfg.provider, "/", cfg.model, "with", keys.length || 1, "key(s) …");
      const res = await callLLM({
        provider: cfg.provider, model: cfg.model,
        keys, apiKey: keys.length ? "" : cfg.apiKey,
        preferFreeFirst: cfg.preferFreeFirst !== false,
        system: "You are a connectivity probe. Reply with exactly: OK", user: "Reply with exactly: OK", maxTokens: 16
      });
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

    // Settle before reading (same reason as the replay's check — a half-drawn summary reads as
    // missing/mis-paired values). No `act` here; awaitReviewPageSettled falls back to cdpDelay.
    const settledRC = await awaitReviewPageSettled(null);
    LOG(`review page settled in ${settledRC.ms}ms — ${settledRC.records} displayed value(s).`);
    const dump = settledRC.dump;
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
// Wait for a Workday form page's FLAT FIELD SET to finish mounting, then return how long it took.
// EXTRACTED from fillAndPersistPage (2026-07-28) so the REPLAY walk gets it too — it never calls
// fillAndPersistPage, so it had no settle at all and scanned pages mid-render. Live consequence: replay
// "page 1" scanned 6 of 14 wrappers (name/address/city/region/postal genuinely not in the DOM yet),
// reported 9 approved values as having nowhere to go, clicked Save & Continue — and because MORE FIELDS
// MOUNTING changes the page signature, cdpWaitNextPage read that as an advance, so the walk processed the
// same physical page twice ("page 2" then scanned all 14). The operator's read was exactly right: "each
// time we go to the next page, it doesn't poll for the page to completely settle … the fill path works
// every time."
//
// MUST poll on delayFull (REAL wall-clock), NOT delayRender: delayRender is adaptive and on a VISIBLE tab
// collapses to ~40ms, so a read-count stability check would span ~120ms — far faster than the page
// renders — and the count would look "stable" while only the first field exists, which is the very bug
// this prevents. The guarantee is WALL-CLOCK: break only after a NON-ZERO count has held UNCHANGED for
// ≥1.2s of real time. Bounded at 12s; a page with no flat fields (repeating-only, e.g. My Experience)
// bails after ~1s of all-zero reads. Genuine value-triggered cascades appear only AFTER a commit and
// remain the cascade re-scan's job — this settles the INITIAL load only.
// Wait for the REVIEW page's displayed values to finish rendering, then return the final scrape.
//
// Same discipline as awaitFieldSetSettled, for the same reason (2026-07-28): the review-page check had NO
// settle, so on a HIDDEN tab it read the page half-drawn. Live comparison on one job — FOREGROUND runs
// scraped it as AGREE 53 · DISAGREE 0 · MISSING 1, the first HIDDEN run as AGREE 26 · DISAGREE 3 ·
// MISSING 24. The 3 "disagrees" were rows shuffled inside a repeating entry (a label whose own value span
// hadn't mounted picks up the next row's), and the 24 "missing" values were, per the operator's copy of
// the page, right there on it. Nothing was wrong with the application — we simply looked too early.
//
// WALL-CLOCK (`delayFull`, never `delayRender`): we are waiting on the PAGE's render, which takes real
// time regardless of our pacing, and delayRender collapses to ~40ms on a visible tab — a count would look
// "stable" while half the summary was still missing, which is exactly the bug. Break once a NON-ZERO
// record count has held UNCHANGED for ≥1.2s. Returns the last successful dump so the caller doesn't
// re-read (one fewer round-trip, and the verdict is computed on the very snapshot we settled on).
async function awaitReviewPageSettled(act, hints) {
  const t0 = Date.now();
  const NO_GROWTH_MS = 1200, POLL_MS = 200, CEILING_MS = 15000;
  let last = -1, lastChangeAt = Date.now(), dump = null;
  while (Date.now() - t0 < CEILING_MS) {
    let d = null;
    try { d = await cdpEval(cdpReadReviewPage, hints); } catch (e) { /* mid-render eval → keep polling */ }
    if (d && d.ok) dump = d;
    const n = d && d.ok && d.counts ? d.counts.records : 0;
    const now = Date.now();
    if (n > 0 && n === last) { if (now - lastChangeAt >= NO_GROWTH_MS) break; }
    else { last = n; lastChangeAt = now; }
    // delayFull when we have an actuation; cdpDelay is the same real wall-clock for callers without one.
    if (act && act.delayFull) await act.delayFull(POLL_MS); else await cdpDelay(POLL_MS);
  }
  return { dump, records: last > 0 ? last : 0, ms: Date.now() - t0 };
}

async function awaitFieldSetSettled(act) {
  const t0 = Date.now();
  const NO_GROWTH_MS = 1200, ZERO_BAIL_MS = 1000, POLL_MS = 150, CEILING_MS = 12000;
  let last = -1, lastChangeAt = 0, zeroSince = null;
  while (Date.now() - t0 < CEILING_MS) {
    let n = 0;
    try { n = (((await cdpEval(cdpPageScan)).fields) || []).length; } catch (e) { /* mid-render eval → counts as a zero read (keep polling) */ }
    const now = Date.now();
    if (n === 0) { if (zeroSince == null) zeroSince = now; if (now - zeroSince >= ZERO_BAIL_MS) break; last = -1; await act.delayFull(POLL_MS); continue; }
    zeroSince = null;
    if (n !== last) { last = n; lastChangeAt = now; }
    else if (now - lastChangeAt >= NO_GROWTH_MS) break;
    await act.delayFull(POLL_MS);
  }
  return Date.now() - t0;
}

// ── THE PAGE'S AI MEMORY (2026-08-06, operator) ─────────────────────────────────────────────────────
// "If this page needs to be refilled, it should remember the previous answers and not recall AI."
// Keyed by QUESTION (see aiLabelKey), reset at the top of every page, and handed to EVERY drivePageFill
// for that page — the initial fill, its cascade recursion, and AI-4's re-fills. Without it each re-fill
// was a fresh invocation with an empty cache, so it asked the model again and was free to get a
// DIFFERENT answer: live on waystar page 3 the relocation question went "Yes, I am open to relocating"
// -> "No, but I live near one of these locations" -> "Yes", and every CHANGE remounted the dependent
// basecamp question under a new automation-id, blank and required, so the page could never be saved.
// A refill that remembers changes no values, and nothing remounts.
let _pageAiAnswers = new Map();

async function fillAndPersistPage(act, prepared, defaults, jobContext, LOG, opts) {
  // Accumulation merge key — the PRE-fill cdpPageKey (url PATHNAME [drops the volatile
  // query] + sorted field-set: STABLE per page across re-runs, DISTINCT across pages even
  // on a same-pathname SPA). Computed BEFORE the fill (a field-revealing fill could change
  // the field-set). NOT cdpPageSig (full url incl. query).
  const preScan = await cdpEval(cdpPageScan);
  const pageKey = cdpPageKey(preScan);
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
  // Let the flat field set finish rendering BEFORE the first fill pass. Workday form pages mount
  // their fields progressively; on page 1 the walk enters straight from onboarding (no
  // cdpWaitNextPage stabilization), so a premature scan makes drivePageFill's initial pass miss the
  // slow-to-mount fields — they then get caught by the cascade re-scan and mis-tagged "REVEALED by
  // an earlier field's value", which is misleading in review AND makes the submit gate force a second
  // review of each.
  //
  // MUST poll on delayFull (REAL wall-clock), NOT delayRender: delayRender is adaptive and on a
  // VISIBLE tab collapses to ~40ms, so a read-count-based stability check would span ~120ms — far
  // faster than the page renders — and the count looks "stable" while only the first field (e.g.
  // Country) exists, exactly the bug this is meant to fix. We are waiting on the PAGE's own render,
  // which takes real time regardless of our pacing. The guarantee is therefore WALL-CLOCK: break only
  // after a NON-ZERO count has held UNCHANGED for ≥1.2s of real time (2026-07-25 speed round — was "3
  // consecutive reads at 500ms" ≈ the same ~1.5s window but paying its full discretization every page;
  // polling at 150ms keeps the guarantee measured in wall-clock while shaving the slop). Bounded at
  // 12s; a page with no flat fields (repeating-only, e.g. My Experience) bails after ~1s of all-zero
  // reads. Genuine value-triggered cascades still appear only AFTER a commit → they remain the cascade
  // re-scan's job; this settles the INITIAL load only.
  const settleMs = await awaitFieldSetSettled(act);
  // (The cross-run option-list cache was REMOVED 2026-08-06 — see captureChoiceOptions. In the real flow
  // a form is filled ONCE, reviewed, then submitted, so a cross-run cache is always cold in production:
  // it bought nothing real and it quietly made repeat test runs faster than a genuine first fill, which
  // distorted every timing measured against it.)
  // ── TEMPORARY DIAGNOSTIC: 10ms watch on a checkbox GROUP (chrome.storage.local.debugGroupWatch) ──
  // Settles the one question three rounds of reasoning could not: when the group loses its check, was the
  // DOM REBUILT or was `checked` toggled in place? `checked` is a property, so a toggle leaves the
  // MutationObserver count unmoved while a re-render shows childList mutations. Records transitions +
  // scoped events (with isTrusted) only. Read-only, opt-in, and drained straight into the log below.
  let _gwSel = null;
  try {
    const { debugGroupWatch } = await new Promise((r) => chrome.storage.local.get("debugGroupWatch", r));
    if (debugGroupWatch) {
      const gf = ((preScan && preScan.fields) || []).find((f) => f.widgetType === "checkbox_group");
      if (gf && gf.wrapperSel) {
        _gwSel = gf.wrapperSel;
        LOG(`[GROUP-WATCH] installing 10ms watch on ${gf.fieldName} (${gf.wrapperSel}):`,
          JSON.stringify(await cdpEval(cdpInstallGroupWatch, gf.wrapperSel)));
      } else {
        LOG("[GROUP-WATCH] armed but this page has no checkbox_group in the settled scan — nothing to watch.");
      }
    }
  } catch (e) { LOG("[GROUP-WATCH] install skipped:", String((e && e.message) || e)); }

  // ── A SELF-ID PAGE: TRUSTED for TEXT/DATE, SYNTHETIC for CLICKS (2026-08-05) ────────────────────
  // Workday ignores synthetic native-setter WRITES on this surface — hidden runs failed with Name and
  // Date reported required-and-empty on a page whose DOM plainly held both, and forceTrustedInput fixed
  // exactly that. But it ACCEPTS synthetic clicks, and prefers them: the disability checkbox committed
  // and held 2/2 under synthetic, whereas trusted clicks on it produce the intermittent "did not commit"
  // (quiet page, click dispatched, hit-test confirming the right label, no toggle). Forcing the WHOLE
  // page trusted therefore fixed the text fields and re-exposed the checkbox.
  //
  // So the split is per-KIND, not per-page: value writes go trusted, the label click stays synthetic.
  const _selfId = isSelfIdPage((preScan && preScan.fields) || []);
  if (_selfId) {
    LOG("this is a SELF-ID page — TRUSTED input for text/date (Workday ignores synthetic writes here), SYNTHETIC for the checkbox click (trusted clicks flake on it).");
    cdpSetTrustedText(true);
  }
  const _fillT0 = Date.now();
  let out;
  try {
    // enableAiBatch: opt-in until the batched-AI pre-pass is confirmed inert on a live page (see
    // buildBatchAiPrompt). Read per run, so no reload is needed to flip it.
    // ON BY DEFAULT (2026-08-06). It has run clean across many fills, visible AND hidden, and the failure
    // it was gated behind — a read-only pre-pass close straying a value — never materialised: the
    // [AI-BATCH-RECON] "open problems" field has stayed empty every run. `disableAiBatch` is the
    // kill-switch if a tenant ever needs the old per-field path.
    const _aiBatch = !(await new Promise((r) => chrome.storage.local.get("disableAiBatch", (v) => r(!!(v && v.disableAiBatch)))));
    const _dbgClobber = await new Promise((r) => chrome.storage.local.get("debugClobber", (v) => r(!!(v && v.debugClobber))));
    const _dbgTrace = await new Promise((r) => chrome.storage.local.get("debugPageTrace", (v) => r(!!(v && v.debugPageTrace))));
    if (_dbgTrace) LOG(`debugPageTrace ON — streaming a [TRACE] line for every field decision and every wait on page ${(opts && opts.pageNumber) || "?"}.`);
    if (_dbgClobber) LOG("debugClobber ON — re-scanning after EVERY field to attribute any value another field wipes.");
    if (_aiBatch) LOG("AI-batch ENABLED — this page's AI questions go out as ONE call, fired before the deterministic fill.");
    _pageAiAnswers = new Map(); // NEW page ⇒ new questions; never carry answers across pages
    out = await drivePageFill(act, prepared, defaults, jobContext, { enableAiBatch: _aiBatch, debugClobber: _dbgClobber, debugPageTrace: _dbgTrace }, { cachedShapes, headingToBase, buckets, aiAnswers: _pageAiAnswers });
  } finally {
    if (_selfId) cdpSetTrustedText(false); // never leave the next page paying for this one
  }
  const fillMs = Date.now() - _fillT0;
  if (_gwSel) {
    try {
      const gw = await cdpEval(cdpDrainGroupWatch);
      if (gw && gw.ok) {
        LOG(`[GROUP-WATCH] ${gw.samples} samples over ${gw.spanMs}ms · ${gw.muts} mutation(s) on the wrapper's parent subtree`);
        LOG(`[GROUP-WATCH] STATE TRANSITIONS (t=ms since install · mutsSoFar tells you whether the DOM moved):`);
        (gw.transitions || []).forEach((x) => LOG(`    t+${x.t}ms  muts=${x.mutsSoFar}  ${x.s}`));
        LOG(`[GROUP-WATCH] EVENTS on this group (trusted=true ⇒ a real browser-level click):`);
        (gw.events || []).forEach((e) => LOG(`    t+${e.t}ms  ${e.type}${e.trusted ? " TRUSTED" : " untrusted"}  ${e.target}${e.checkedNow === undefined ? "" : "  checked=" + e.checkedNow}`));
        if ((gw.mutLog || []).length) {
          LOG(`[GROUP-WATCH] first ${gw.mutLog.length} mutation(s) — childList with added/removed ⇒ the subtree was REPLACED:`);
          // Only the ones INSIDE the group matter for "did our value get reset by a DOM change?"
          const inG = gw.mutLog.filter((m) => m.inGroup);
          LOG(`    (${inG.length} of them landed INSIDE the group's own subtree)`);
          inG.slice(0, 60).forEach((m) => LOG(`    IN-GROUP t+${m.t}ms  ${m.type} +${m.added}/-${m.removed} ${m.attr ? "attr=" + m.attr + " " : ""}${m.target}`));
          gw.mutLog.filter((m) => !m.inGroup).slice(0, 25).forEach((m) => LOG(`    outside  t+${m.t}ms  ${m.type} +${m.added}/-${m.removed} ${m.attr ? "attr=" + m.attr + " " : ""}${m.target}`));
        }
      } else LOG("[GROUP-WATCH] drain failed:", JSON.stringify(gw));
    } catch (e) { LOG("[GROUP-WATCH] drain error:", String((e && e.message) || e)); }
  }
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
      // scrape/type are broken out because "this field was slow" is useless without WHICH PHASE was slow
      // — the field-of-study lag was attributed to the option scrape until the phases were split.
      const phases = [s.scrapeMs != null ? `scrape ${s.scrapeMs}ms` : null, s.typeMs != null ? `type ${s.typeMs}ms` : null].filter(Boolean).join(", ");
      LOG(`    cand "${s.candidate}" → ${s.outcome || "?"} (${s.settleMs != null ? "settle " + s.settleMs + "ms" : "?"}${phases ? ", " + phases : ""}, ${s.count != null ? s.count + " options" : "? options"}, banner:${!!s.banner}, open:${!!s.open}, chip:${s.chips ? `"${s.chips}"` : "none"})${s.note ? " — " + s.note : ""}`);
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
  const _attachT0 = Date.now();
  const uploadRec = out.results.find((r) => r.widgetType === "file_upload" && r.flag !== "nested-attachment");
  if (uploadRec) {
    let resumeRec = null;
    try { resumeRec = await getResume(); } catch (e) { /* treat as none */ }
    if (!resumeRec || !resumeRec.base64) {
      uploadRec.status = "needs_review"; uploadRec.verified = false;
      uploadRec.detail = "no resume stored — upload a PDF in the popup first (the required upload blocks Save & Continue)";
      LOG("resume: NOT attached — no resume stored (upload one in the popup).");
    } else {
      // The input-lock's capture-phase blocker SWALLOWS attachResume's SYNTHETIC delete/attach clicks
      // (they're dispatchEvent, not the gated cdpClickAt) whenever window.__apActing is 0 — that's why
      // clearing an EXISTING attachment intermittently failed under the walk's lock ("removed 0, N
      // remain"; a clean 0-attachment page worked because the attach's `change` event isn't blocked).
      // cdpAttachResumeConfirmed bumps __apActing around the attach and owns the confirmation budget.
      const ar = await cdpAttachResumeConfirmed(resumeRec, LOG);
      if (ar && ar.attached) {
        uploadRec.status = "filled"; uploadRec.verified = true; uploadRec.after = ar.fileName || resumeRec.filename || null;
        uploadRec.detail = `resume attached (file-upload-successful, cleared ${ar.deletedCount || 0} existing)`;
        LOG(`resume: attached "${uploadRec.after}".`);
      } else {
        uploadRec.status = "needs_review"; uploadRec.verified = false;
        uploadRec.detail = "resume attach failed — " + ((ar && ar.detail) || "no confirmation");
        LOG("resume: NOT attached —", uploadRec.detail);
      }
    }
  }

  // [CDP-TIME] per-page wall-clock breakdown (2026-07-25 speed round): where the page's time actually
  // went — the pre-fill settle, the fill phases (from drivePageFill's timings), the resume attach —
  // plus the slowest individual fields (rec.elapsedMs). Log-only; this is the evidence future pacing
  // rounds retune from (the fast/slow regime, cold option lists, server-bound typeahead filters…).
  {
    const attachMs = Date.now() - _attachT0;
    // What the batched-AI pass actually DID, in one line. "Still calling AI per field" and "the batch
    // collected nothing" look identical without this.
    const ab = out.aiBatchInfo;
    if (ab) {
      LOG(`[AI-BATCH] ${ab.candidates} candidate(s)${ab.candidates ? " [" + ab.kinds.join(", ") + "]" : ""} · ${ab.fired ? "fired" : "NOT fired (needs 2+)"} · ${ab.answers} answer(s) back · served ${ab.served}, fell back to per-field ${ab.fellBack} · scan ${ab.scanMs || 0}ms${ab.error ? " · ERROR " + ab.error : ""}`);
      // ── TEMPORARY RECON (2026-08-06) — remove once the batch pre-pass is trusted. ────────────────
      // It answers, per page and without guessing: how many candidates were decided WITHOUT touching the
      // page, how many of those actually cost an open, and whether any read-only close left a value
      // behind (the one hazard that keeps this feature opt-in). "needOpen 3 · opened 3" on an AI page and
      // "opened 0" everywhere else is the shape to expect.
      const rc = ab.recon;
      if (rc) LOG(`  [AI-BATCH-RECON] planned ${rc.planned} [${(rc.plannedKeys || []).join(", ")}] · needed an open: ${rc.needOpen} · OPENED: ${rc.opened} · plan+open ${rc.ms}ms`
        + ((rc.openFailed || []).length ? ` · open problems: ${rc.openFailed.join(", ")}` : "")
        + ((rc.dropped || []).length ? ` · ${rc.dropped.join("; ")}` : ""));
    }
    // ── TEMPORARY RECON (2026-08-06): cascade reveals/vanishes/REMOUNTS, see fill-driver cascadeRecon. ──
    // A "REMOUNT" line means a dependent question came back under a NEW automation-id: its earlier record
    // now points at a dead wrapper while the LIVE widget is blank — and if it is required, that is a Save
    // & Continue that can never succeed no matter how many times the page is re-filled.
    for (const line of (out.cascadeRecon || [])) LOG(`  [CASCADE-RECON] ${line}`);
    for (const line of (out.clobberLog || [])) LOG(`  [CLOBBER] ${line}`);
    const ph = out.timings || {};
    const s = (ms) => (typeof ms === "number" ? (Math.round(ms / 100) / 10) + "s" : "–");
    const slow = (out.results || [])
      .filter((r) => (r.elapsedMs || 0) >= 1500)
      .sort((a, b) => (b.elapsedMs || 0) - (a.elapsedMs || 0)).slice(0, 5)
      .map((r) => `${r.fieldName} ${s(r.elapsedMs)}`).join(", ");
    let pacing = "?"; try { pacing = await cdpPacingLabel(); } catch (e) { /* label only */ }
    // The measured PAINT state, not just Chrome's visibility flag: "visible but NOT painting" is the
    // state that made page 2 take 39s instead of 11s, and it used to leave no trace in the log at all.
    let paint = "?"; try { paint = await cdpPaintLabel(); } catch (e) { /* label only */ }
    pacing = pacing + " | " + paint;
    LOG(`[CDP-TIME] pacing ${pacing} | settle ${s(settleMs)} | fill ${s(fillMs)} (flat ${s(ph.flat)} · sections ${s(ph.sections)} · stubs ${s(ph.stubs)} · cascade ${s(ph.cascade)}+${s(ph["cascade-late"])} · capture ${s(ph.capture)} · audit ${s(ph.audit)} · sweep ${s(ph.sweep)}) | resume ${s(attachMs)}${slow ? ` | slowest: ${slow}` : ""}`);
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

// Delete rows of a repeating section by INDEX, highest-first (so the lower indices stay valid while we
// work down), polling the live count after each click and STOPPING on no-progress — never spin the
// bound. Returns how many rows actually disappeared. ONE implementation, shared by the fill walk's AI-4
// Tier 0 and the replay walk's phantom-duplicate fix, so the two can't drift.
// Poll the live row count until it moves off `before` (or the ceiling) — the SAME helper shape the fill
// walk's reconcile uses (driveRepeatingSectionCdp's pollCount), on the same budgets.
async function pollEntryCount(act, prefix, before) {
  const deadline = Date.now() + DEFAULT_BUDGETS.entryReconcileCeilingMs;
  let count = await act.entryCount(prefix);
  while (count >= before && Date.now() < deadline) {
    await act.delay(DEFAULT_BUDGETS.entryReconcileIntervalMs);
    count = await act.entryCount(prefix);
  }
  return count;
}

// Delete repeating rows using the mechanism the REAL fill walk uses (operator 2026-07-27: "you can see
// how the real walk deletes, use the same mechanism") — driveRepeatingSectionCdp's reconcile-DOWN loop
// and remediation's Tier-1.5 targeted delete, not a bespoke one.
//
//   • CLEAR-TO-N (the phantom case, target 0): delete the LAST row (`count - 1`) and RE-POLL the count
//     each pass — never a precomputed index list. This is what makes it robust: it can't be thrown off
//     by a stale count or by rows re-indexing as they go.
//   • TARGETED (a real duplicate): the given indices, highest-first so the lower ones stay valid.
//
// Every exit REPORTS ITSELF. Previously all three failure paths were indistinguishable from outside —
// "deleted 0/2" with no reason — which is exactly how the live failure became undiagnosable.
async function deleteRepeatingRows(act, prefix, opts, LOG) {
  const log = LOG || (() => {});
  const o = opts || {};
  const cap = 10; // mirrors the fill walk's reconcile cap — a runaway delete is never right
  let deleted = 0;

  if (Array.isArray(o.indices)) {
    for (const idx of o.indices.slice().sort((a, b) => b - a)) {
      const before = await act.entryCount(prefix);
      if (before <= 0) { log(`stopped: no rows for prefix "${prefix}" (entryCount 0).`); return { deleted, reason: "no-rows:" + prefix }; }
      const del = await act.clickDeleteEntry(prefix, idx);
      if (!del || !del.ok) { log(`stopped at row ${idx}: no clickable "Delete" control (no Delete button within 6 ancestors of the row, or its rect never laid out).`); return { deleted, reason: "no-delete-button@" + idx }; }
      const now = await pollEntryCount(act, prefix, before);
      if (now >= before) { log(`stopped at row ${idx}: clicked Delete but the count stayed at ${before} — the click didn't take.`); return { deleted, reason: "count-did-not-drop@" + idx }; }
      deleted++;
      await act.delay(DEFAULT_BUDGETS.interFieldMs);
    }
    return { deleted, reason: null };
  }

  // clear-to-N — the reconcile-down loop, verbatim in shape.
  const target = o.target || 0;
  let count = await act.entryCount(prefix);
  if (count <= 0) { log(`stopped: no rows for prefix "${prefix}" (entryCount 0).`); return { deleted, reason: "no-rows:" + prefix }; }
  while (count > target && deleted < cap) {
    const before = count;
    const del = await act.clickDeleteEntry(prefix, count - 1); // ALWAYS the last row, re-resolved
    if (!del || !del.ok) { log(`stopped with ${count} row(s) left: no clickable "Delete" control on the last row.`); return { deleted, reason: "no-delete-button@" + (count - 1) }; }
    count = await pollEntryCount(act, prefix, before);
    if (count >= before) { log(`stopped with ${count} row(s) left: clicked Delete but the count stayed at ${before} — the click didn't take.`); return { deleted, reason: "count-did-not-drop" }; }
    deleted++;
    await act.delay(DEFAULT_BUDGETS.interFieldMs);
  }
  return { deleted, reason: null };
}

// ── Workday's PHANTOM duplicate-entry error (DETERMINISTIC, no AI) ──────────────────────────────────
// Workday's backend sometimes APPENDS a repeating section instead of REPLACING it, so its stored copy
// holds duplicates the FORM does not show. The page is visibly clean, every row distinct — and Save &
// Continue is still rejected with "You can't add duplicate website URLs." (operator, live on
// solarturbines during a REPLAY: "on the actual page, there is no duplicates, but workday gives us an
// error saying there are").
//
// What Workday accepts is deleting the VISIBLE rows: its own retained copy is what then satisfies the
// section — which is exactly why the values still show up on the REVIEW page afterwards, "as if we did
// not delete it". That is not assumed: the review-page equality check re-reads the page and a value
// that does NOT come back is a hard submit blocker (see the review verification in runCdpReplayWalk).
//
// The plan is the same PURE one the fill walk's Tier 0 uses: a REAL duplicate (two rows sharing a
// value) deletes only the later occurrence(s); all-distinct rows are the PHANTOM case, where the
// duplicate exists ONLY server-side, so the whole visible section is cleared.
// EVERY repeating section is covered (operator 2026-07-27: "make the duplicate fix for all repeating
// sections"). The live page is the source of truth for BOTH the rows and their container prefix — see
// findLiveSection: a hardcoded prefix is exactly what made the first live attempt delete 0/2 rows.
// website + language keep their tuned, value-aware KEY (their dup errors are about that one value);
// every other section keys a row on the composite signature of all its fields.
const PHANTOM_DUP_SECTIONS = {
  website:        { keyField: "url" },
  language:       { keyField: "language" },
  education:      {},
  workExperience: {},
  certification:  {},
};

async function clearPhantomDuplicates(act, results, errorSamples, LOG) {
  const kind = duplicateErrorSection(errorSamples);
  const cfg = kind ? PHANTOM_DUP_SECTIONS[kind] : null;
  if (!cfg) return { ran: false };

  // LIVE FIRST. The container prefix is tenant-variable (website rows live under `webAddress-` on the
  // observed tenants, but nothing guarantees that), and the rows on screen — including any Workday
  // added behind our back — are the ones that must go. cdpRepeatingScan discovers both.
  let rscan = null;
  try { rscan = await act.repeatingScan(); } catch (e) { rscan = null; }
  const secCfg = (typeof PAGE_SECTIONS !== "undefined" ? PAGE_SECTIONS : []).find((x) => x.name === kind) || null;
  const loc = findLiveSection(rscan, kind, secCfg);
  if (!loc) {
    const seen = rscan && rscan.sections ? Object.keys(rscan.sections).join(", ") : "(scan failed)";
    LOG(`⚠ Workday reports a duplicate-${kind} error, but no ${kind} section is on the live page. Sections present: [${seen}]. Not deleting anything.`);
    return { ran: false, reason: "section-not-on-page" };
  }
  const liveRows = (loc.live && loc.live.entries) || [];
  const entries = liveRows.length ? liveDupEntries(liveRows, cfg.keyField) : sectionEntriesFromResults(results || [], kind);
  const plan = sectionDeletionPlan(entries);
  if (!entries.length) { LOG(`⚠ duplicate-${kind} error, but the live ${kind} section has 0 rows — nothing to delete.`); return { ran: false, reason: "no-rows" }; }

  const noDelete = entries.filter((e) => e.deletePresent === false).length;
  LOG(`⟳ Workday rejected Save & Continue with a duplicate-${kind} error, but the page shows no duplicates (${plan.mode}) — this is its stale server-side copy. Live section "${loc.prefix}" has ${entries.length} row(s)${noDelete ? `, ${noDelete} WITHOUT a Delete control` : ""}: [${plan.summary}]`);

  // PHANTOM ⇒ the duplicate is only in Workday's copy, so clear the whole visible section (reconcile to
  // 0, the fill walk's own mechanism). REAL ⇒ delete just the later duplicate rows, by index.
  const res = plan.mode === "phantom"
    ? await deleteRepeatingRows(act, loc.prefix, { target: 0 }, (m) => LOG("   " + m))
    : await deleteRepeatingRows(act, loc.prefix, { indices: plan.deleteIndices }, (m) => LOG("   " + m));

  if (!res.deleted) {
    LOG(`   ✗ deleted 0 ${kind} row(s) — ${res.reason || "unknown reason"}. NOT claiming a fix; the walk will halt so this is visible rather than silently ineffective.`);
    return { ran: false, reason: res.reason || "delete-failed" };
  }
  LOG(`   deleted ${res.deleted}/${entries.length} ${kind} row(s)${res.reason ? ` (stopped early: ${res.reason})` : ""}. Workday keeps its own copy, so these stay on the application — they remain FILLED in the review summary, and must reappear on Workday's own review page (verified before any submit).`);
  // Keep the deleted rows in the REVIEW SUMMARY as filled. They are still part of the submitted
  // application (Workday retained them), so dropping them would hide a whole section from the operator.
  // reconPageTruth honours `phantomKept` and skips its "row no longer on the page → removed" sweep.
  const kept = markPhantomKept(results, kind, res.deleted);
  return { ran: true, kind, mode: plan.mode, deleted: res.deleted, kept, values: entries.map((e) => e.summary).filter((v) => v && v !== "?") };
}

// ── CASCADE-REVEALED REQUIRED FIELDS: send them back to review instead of halting blind ─────────────
// (operator 2026-07-27: "if I want to fill in an optional field name, the optional fields date and
// please check one of the boxes below become mandatory … is it to go to review page again but this time
// that field is mandatory".)
//
// Live on solarturbines page 5: filling an OPTIONAL name promoted "Date" and "Please check one of the
// boxes below" to REQUIRED. Neither had a value in the approved bundle — and nothing was wrong with the
// fill: they were optional AND blank when the page was reviewed, so there was genuinely nothing to
// record. The replay then had nothing to put there and Workday refused the page, leaving a halt that
// blamed "a cascade-revealed field not in the approved bundle" without doing anything about it.
//
// This finds them and puts them BACK IN FRONT OF THE HUMAN: any field the LIVE page now marks required
// and holds no value for, whose approved entry is missing OR BLANK (both matter — the blank case is the
// one that actually happened), becomes a `cascade_revealed` + `needs_review` entry in the bundle, which
// is pushed to the website. The operator answers it there and re-runs. Options come from the live DOM
// where the scan has them (a checkbox group carries its labels), so the field is answerable on the
// review page rather than a bare text box.
//
// It NEVER invents an answer — every entry it adds is empty and unapproved, so `bundleSubmitBlockers`
// (required-blank + unapproved-flagged) keeps refusing until the human fills them in.
// (Both helpers are PURE and live in lib.js: newlyRequiredGaps + cascadeEntryFor.)

// Flag a section's records as deliberately-absent-but-still-submitted (see clearPhantomDuplicates).
// Status is left FILLED on purpose — the operator asked for these to read "as if we did not delete it".
function markPhantomKept(results, section, deleted) {
  if (!deleted) return 0;
  const rx = new RegExp("^" + section + "\\[\\d+\\]\\.");
  let n = 0;
  for (const r of (results || [])) {
    if (!r || !rx.test(r.fieldName || "")) continue;
    r.phantomKept = true;
    r.detail = (r.detail ? r.detail + " | " : "") +
      "row deleted from the form to clear Workday's phantom duplicate-entry error; Workday kept its own copy, so this value is still on the application";
    n++;
  }
  return n;
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

    // ── Tier 0 (DETERMINISTIC, no AI) — Workday's PHANTOM duplicate-entry error, for EVERY repeating
    //    section (generalized 2026-07-27 from the original language-only + website-only tiers). Its
    //    backend sometimes APPENDS a section instead of REPLACING it, so its stored copy holds
    //    duplicates the FORM does not show and Save & Continue is rejected on a visibly-clean page.
    //    clearPhantomDuplicates picks the section from the error text, applies the real-vs-phantom plan
    //    (identical rows ⇒ delete the later occurrence(s); all-distinct ⇒ clear the visible section),
    //    and FLAGS the records `phantomKept` so they stay FILLED in the review summary — Workday
    //    retained them, so they are still on the application and must not vanish from the operator's
    //    review (operator rule: "make it show as filled … as if we did not delete it"). ──
    const dup = await clearPhantomDuplicates(act, out.results, prevErrors, (...a) => LOG("  attempt " + attempt + " (Tier 0)", ...a));
    if (dup.ran && dup.deleted > 0) {
      mergeRemediationRecord(out, {
        fieldName: dup.kind + ".duplicate-fix", label: `Duplicate-${dup.kind} workaround`, widgetType: "remediation",
        status: "needs_review", flag: "ai-remediation", after: null,
        detail: `Workday phantom duplicate-${dup.kind} fix (${dup.mode}): deleted ${dup.deleted} row(s) from the form to get past Save & Continue. Workday kept its own copy, so these stay on the application and remain FILLED in this summary: ${dup.values.join(", ")}`
      });
      actions.push({ tier: 0, action: "delete-" + dup.kind + "-" + dup.mode, deleted: dup.deleted, entries: dup.values.join(", ") });
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
        // ⚠ TRUSTED INPUT FOR THE RE-FILL (2026-08-02). Re-filling with the SAME synthetic input
        // that Workday just ignored is a no-op by construction — live on three Caterpillar
        // postings this tier ran and reported "remediation made NO PROGRESS (error set unchanged)"
        // every time, on First Name / Last Name / Phone Number that the page was visibly holding.
        //
        // That is the PHANTOM-REQUIRED failure already solved on the REPLAY walk: a native-setter
        // write reaches the DOM and even React, but never Workday's own form model, so Workday
        // believes the field is empty. The proven remedy there was to re-write the error-named
        // fields with TRUSTED Input.* — the fill walk simply never got that tier. It only ever
        // happens on HIDDEN runs, the only ones using synthetic input.
        //
        // Restored in a finally: the rest of the page keeps the hidden-tab speed win, and this
        // costs trusted input for a handful of named fields on a page that is already blocked.
        const wasSynthetic = typeof cdpSyntheticInputEnabled === "function" ? cdpSyntheticInputEnabled() : true;
        LOG(`  attempt ${attempt} (Tier 1, deterministic): error names → re-fill mapped field(s) [${[...refill].join(", ")}] from the profile with TRUSTED input (no AI).`);
        let rOut;
        try {
          cdpSetSyntheticInput(false);
          // Same page ⇒ same answers. A remediation re-fill must never re-ask and never contradict the
          // first pass; contradicting it is what remounts dependent questions.
          rOut = await drivePageFill(act, profile, defaults, jobContext, {}, { onlyFieldNames: refill, aiAnswers: _pageAiAnswers });
        } finally {
          cdpSetSyntheticInput(wasSynthetic);
        }
        for (const r of (rOut.results || [])) {
          r.flag = "ai-remediation"; r.status = r.status === "filled" ? "filled_review" : r.status;
          r.detail = "AI-4 Tier-1 deterministic re-fill — " + (r.detail || "");
          mergeRemediationRecord(out, r);
        }
        actions.push({ tier: 1, refilled: [...refill] });
        didSomething = true;
      }
    }

    // ── Tier 1.2 (DETERMINISTIC, no AI) — the phantom-required NUDGE, a focus→blur commit that changes
    //    no value. DEMOTED below the trusted re-write above (2026-08-02), matching the demotion the
    //    REPLAY walk already made. It used to run FIRST, and because it always "ran" it set
    //    didSomething and CONSUMED the single attempt — so the trusted re-write never executed and the
    //    ladder halted on no-progress. Live on three Caterpillar postings: Workday claimed First Name /
    //    Last Name / Phone Number were empty on a page holding all three, the nudge fired every time,
    //    and the error set never changed. The nudge is kept because it is free and occasionally right,
    //    but it is no longer allowed to stand in front of the remedy that is actually proven.
    if (!didSomething) {
      const nudge = await nudgePhantomRequired(act, prevErrors, (...a) => LOG("  attempt " + attempt + " (Tier 0.5)", ...a));
      if (nudge.ran) {
        mergeRemediationRecord(out, {
          fieldName: "phantom-required.commit", label: "Phantom required-field workaround", widgetType: "remediation",
          status: "needs_review", flag: "ai-remediation", after: null,
          detail: `Workday reported ${nudge.fields.join(", ")} as required-and-empty while the page held the value. Re-entered the SAME value with trusted input${(nudge.retyped && nudge.retyped.length) ? " (" + nudge.retyped.join(", ") + ")" : ""} and nudged focus→blur — no value was changed.`
        });
        actions.push({ tier: 0.5, action: "commit-phantom-required", fields: nudge.fields.join(", "), nudged: nudge.nudged });
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
      // Pass this page's FLAT records so a flat field's own name cannot route the error to a section
      // (records keyed `section[i].field` are the repeating ones — excluded by the bracket).
      const flatHere = ((out && out.results) || []).filter((r) => r && r.fieldName && !r.fieldName.includes("["))
        .map((r) => ({ fieldName: r.fieldName, label: r.label }));
      const secNames = sectionsFromErrorNames(named, flatHere);
      if (secNames.length) {
        LOG(`  attempt ${attempt} (Tier 1.6, deterministic): error names section field(s) [${named.join(", ")}] → re-run section(s) [${secNames.join(", ")}] (no AI, manual entries preserved).`);
        const rOut = await drivePageFill(act, profile, defaults, jobContext, {}, { onlySections: new Set(secNames), preserveExtras: true, aiAnswers: _pageAiAnswers });
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
            r = await fillSourceCdp(act, { wrapperSel: f.wrapperSel }, cands, DEFAULT_BUDGETS, { ai: aiForSource, sourceTree: true });
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

// ── AI usage ingest (the /app/usage tracker) ────────────────────────────────
// The fill is the highest-volume model caller — one application asks dozens of screening
// questions — and the SW has no database. So each call is buffered here and POSTed in
// BATCHES to the website, which owns the llm_calls ledger. One request per field would add
// a network round trip to every single one.
//
// Auth reuses the per-user ingest key from AP_SET_SESSION, and the URL is derived from
// ingestUrl (…/api/extension/report → …/api/extension/usage) so an older session that never
// carried a usage URL still works.
//
// Fire-and-forget by design: a dropped usage row is a gap in a chart, while a fill that
// stalls or fails because the ledger was unreachable would be a real cost. Nothing here can
// throw into the fill.
const LLM_USAGE_FLUSH_AT = 25;      // batch size that triggers an immediate flush
const LLM_USAGE_DEBOUNCE_MS = 4000; // …otherwise flush shortly after the last call
const LLM_USAGE_MAX_BUFFER = 200;   // hard cap so a long offline run can't grow without bound
let llmUsageBuffer = [];
let llmUsageTimer = null;

function recordLlmUsage(entry) {
  try {
    if (!entry) return;
    llmUsageBuffer.push(entry);
    // Drop the OLDEST beyond the cap: recent calls are the ones the operator is looking at.
    if (llmUsageBuffer.length > LLM_USAGE_MAX_BUFFER) llmUsageBuffer = llmUsageBuffer.slice(-LLM_USAGE_MAX_BUFFER);
    if (llmUsageBuffer.length >= LLM_USAGE_FLUSH_AT) { flushLlmUsage(); return; }
    if (llmUsageTimer) clearTimeout(llmUsageTimer);
    llmUsageTimer = setTimeout(flushLlmUsage, LLM_USAGE_DEBOUNCE_MS);
  } catch (e) { /* never let accounting touch the fill */ }
}

async function flushLlmUsage() {
  if (llmUsageTimer) { clearTimeout(llmUsageTimer); llmUsageTimer = null; }
  if (!llmUsageBuffer.length) return;
  // Take the batch BEFORE awaiting, so calls arriving mid-flush aren't lost or double-sent.
  const batch = llmUsageBuffer;
  llmUsageBuffer = [];
  try {
    const apSession = await new Promise((r) => chrome.storage.local.get("apSession", (x) => r((x && x.apSession) || null)));
    if (!apSession || !apSession.ingestUrl || !apSession.ingestKey) return; // not connected — nothing to report to
    const url = String(apSession.usageUrl || apSession.ingestUrl.replace(/\/report\/?$/, "/usage"));
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + apSession.ingestKey },
      body: JSON.stringify({ calls: batch })
    });
    if (!res || !res.ok) console.log("[ApplyPilot][USAGE] ingest rejected:", res && res.status);
    else console.log("[ApplyPilot][USAGE] reported", batch.length, "call(s)");
  } catch (e) {
    console.log("[ApplyPilot][USAGE] ingest failed:", (e && e.message) || e);
  }
}

// Build a ledger row from a callLLM result. Kept here (not in cdp.js) so the cost rule lives
// with the other storage/I-O concerns, and so act.llm stays a one-line call.
function llmUsageEntry(action, res) {
  const ok = !!(res && res.ok);
  const usage = (ok && res.usage) || { input: 0, output: 0 };
  const model = (ok && res.model) || "";
  return {
    provider: (ok && res.provider) || "",
    model,
    action: action || "fill",
    key_id: (ok && res.keyId) || "",
    key_tier: (ok && res.keyTier) || null,
    tokens_in: usage.input || 0,
    tokens_out: usage.output || 0,
    // null = rate unknown, NEVER 0-as-free (see migration 0013). llmCostUsd enforces that.
    cost_usd: ok && typeof llmCostUsd === "function" ? llmCostUsd(model, usage, res.keyTier) : null,
    ok,
    error_code: ok ? "" : llmUsageErrorCode(res),
    created_at: new Date().toISOString()
  };
}

// A failed callLLM returns a human error string; the tracker wants the classified code.
function llmUsageErrorCode(res) {
  try {
    if (typeof classifyLlmFailure !== "function") return "unknown";
    return classifyLlmFailure({ status: res && res.status, body: res && res.body, networkError: res && res.networkError }).code;
  } catch (e) { return "unknown"; }
}

// AI-0 seam: read the operator's LLM config for act.llm. act.llm enforces the opt-in
// (enabled===false ⇒ no provider call). Only the FILL paths (full-page + walk) thread it in;
// recon/section harnesses build a config-less act (act.llm short-circuits OFF). Returns {} if unset.
async function getLlmConfig() {
  return await new Promise((resolve) => chrome.storage.local.get("llmConfig", (r) => resolve((r && r.llmConfig) || {})));
}

// ── Per-application LOGIN record (operator ask 2026-07-26) ──────────────────────────────────────
// WHICH Workday account an application was filed with. Workday accounts are per-tenant, so months
// later "what did I sign in as on this one?" is a real question — and after a create-account run it's
// the only record that the account EXISTS. The extension is the accurate source: it's the thing that
// actually signed in, so it records what it USED (not what the website merely has stored).
//
// Written by the onboarding call sites the moment a run reaches the form (both the website Run and the
// popup's onboarding), then attached to the next report by getRunLoginFor. One slot, overwritten per
// run — it's a hand-off to that run's own report, not a history (the HISTORY is the backend rows).
async function recordRunLogin(info) {
  try {
    const url = (info && info.url) || "";
    const login = {
      email: (info && info.email) || "",
      tenant: (info && info.tenant) || tenantCompanyFromUrl(url) || null,
      host: (() => { try { return new URL(url).hostname; } catch (e) { return null; } })(),
      job_key: url ? canonicalJobUrl(url) : null,
      created: !!(info && info.created),
      verified: !!(info && info.verified),
      at: new Date().toISOString(),
    };
    await new Promise((r) => chrome.storage.local.set({ lastRunLogin: login }, r));
    console.log(`[ApplyPilot] login recorded for this run — ${login.email || "(no stored credentials — signed in by hand)"}${login.tenant ? " @ " + login.tenant : ""}${login.created ? " (account CREATED this run)" : ""}${login.verified ? " (email verified)" : ""}`);
    return login;
  } catch (e) {
    console.log("[ApplyPilot] login record skipped:", String((e && e.message) || e));
    return null;
  }
}

// The login to attach to a report for `bundleUrl`. MATCH-GATED, deliberately: a stale record from a
// previous run against a DIFFERENT tenant must never be reported as this application's account. Accepts
// it on an exact job_key match (the run-stable key both writers dedup by), else on a same-tenant match
// (same account either way — the fill's url is the logged-in form host, whose job_key is derived the
// same way but whose hostname differs from the posting's). No match ⇒ null: no login beats a wrong one.
// An empty email also returns null — that's a hand-signed-in run, and there's nothing truthful to record.
async function getRunLoginFor(bundleUrl) {
  try {
    const { lastRunLogin } = await new Promise((res) => chrome.storage.local.get("lastRunLogin", res));
    if (!lastRunLogin || !lastRunLogin.email) return null;
    if (!bundleUrl) return lastRunLogin; // no url to disambiguate — the in-flight run's own login is the best (and only) answer
    const sameJob = lastRunLogin.job_key && lastRunLogin.job_key === canonicalJobUrl(bundleUrl);
    const t = tenantCompanyFromUrl(bundleUrl);
    const sameTenant = !!(lastRunLogin.tenant && t && String(lastRunLogin.tenant).toLowerCase() === String(t).toLowerCase());
    return sameJob || sameTenant ? lastRunLogin : null;
  } catch (e) {
    return null;
  }
}

// P3b (website tracker): after a completed page fill, push the review bundle +
// status to the website backend so the operator's Tracker + hosted review summary
// populate. Uses the per-user ingest credential the website synced via AP_SET_SESSION.
// FIRE-AND-FORGET — wrapped so it NEVER throws and NEVER affects the fill; if the
// website isn't connected (no apSession) it's a silent no-op. status is NEVER
// "submitted" (the human submits — the engine only ever fills to review; the WEBSITE
// writes that status when the operator authorizes a submit from its Run page).
async function reportApplication(bundle, jobContext) {
  try {
    if (!bundle) return;
    const { apSession } = await new Promise((res) => chrome.storage.local.get("apSession", res));
    if (!apSession || !apSession.ingestUrl || !apSession.ingestKey) return;
    const needs = bundle.needs_review_count || 0;
    const payload = {
      company: (jobContext && jobContext.company) || bundle.tenant || null,
      role: null,
      // The link the run STARTED from — what the operator recognises, and what a later submit
      // re-derives its job_key from. Storing the FORM url here (an embed url with a validity token)
      // made the submit look up a key that matched a DIFFERENT application entirely.
      url: bundle.jobKeyUrl || bundle.url || null,
      // WHICH account this application was filed with (null when unknown / a hand-signed-in run).
      login: await getRunLoginFor(bundle.url || null),
      // Stable per-job dedup key (tenant + requisition id) — the raw url varies every run, so the
      // backend upserts by (user_id, job_key) instead. See canonicalJobUrl (lib.js, lockstep with
      // web/lib/job-key.ts). null when there's no url (report still works, falls back to url dedup).
      // Key on the link the run STARTED from when we have it, so a re-fill updates the SAME row
      // even though a landing hop moved the form URL. Older bundles fall back to the form URL.
      job_key: (bundle.jobKeyUrl || bundle.url) ? canonicalJobUrl(bundle.jobKeyUrl || bundle.url) : null,
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
//
// TARGETING (opts, 2026-07-26): by DEFAULT the pull is keyed on the LOCAL bundle's url — right for a
// replay of the application you just filled in this browser. A website-driven SUBMIT run
// (AP_SUBMIT_APPLICATION) instead names the job EXPLICITLY via `opts.jobKey` (canonicalJobUrl of the
// posting link) because the local bundle may belong to a DIFFERENT application entirely — and the
// review endpoint's no-match fallback is "the most recently updated app that has a bundle", which
// would silently hand back the wrong application's approved values. `jobKey` makes the match exact;
// its caller REFUSES to replay anything when nothing matches, rather than submitting the wrong job.
async function pullApprovedBundle(LOG, opts) {
  const log = LOG || ((...a) => console.log("[ApplyPilot][REVIEW-PULL]", ...a));
  const o = opts || {};
  try {
    const { apSession, reviewSummary: localBundle } = await new Promise((res) =>
      chrome.storage.local.get(["apSession", "reviewSummary"], res)
    );
    if (!apSession || !apSession.ingestKey) return { pulled: false, reason: "not-connected" };
    const reviewUrl =
      apSession.reviewUrl ||
      (apSession.ingestUrl ? apSession.ingestUrl.replace(/\/report(\?.*)?$/, "/review") : "");
    if (!reviewUrl) return { pulled: false, reason: "no-review-url" };
    const url = o.url || (localBundle && localBundle.url ? localBundle.url : "");
    // job_key wins when given (exact, run-stable); url is the legacy/default key.
    const qs = o.jobKey
      ? "?job_key=" + encodeURIComponent(o.jobKey)
      : url
        ? "?url=" + encodeURIComponent(url)
        : "";
    const endpoint = reviewUrl + qs;
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
    return { pulled: true, count: bundle.entries.length, submit_ready: !!ap.submit_ready, bundle, application_id: (data && data.application_id) || null };
  } catch (e) {
    log(`review pull skipped: ${String((e && e.message) || e)} — keeping the local bundle.`);
    return { pulled: false, reason: "exception" };
  }
}

// ============================================================================
// MULTI-ATS runners (Greenhouse / Lever / Ashby — ats.js is the substrate+driver).
// These forms are single-page, login-free and draft-free, so the two stages are
// two visits to a blank form: FILL (profile → form → review bundle → website) and
// SUBMIT (approved bundle → form → verify → the gated click). Everything runs
// through the CDP attach (chrome.debugger is not host-gated — the same invariant
// discovery relies on), so NO host permissions are needed for these sites.
// ============================================================================

// Poll the form until its field count is stable non-zero twice (the standing
// "never scan a progressively-rendered page without settling it" rule — 5th site).
async function waitAtsFormReady(ats, LOG, ceilingMs) {
  const start = Date.now();
  const deadline = start + (ceilingMs || 25000);
  let prev = -1, stable = 0;
  while (Date.now() < deadline) {
    await cdpWakePage();
    let n = 0;
    try { const s = await cdpEval(atsInjScan, ats); n = (s && s.fields && s.fields.length) || 0; } catch (e) { n = 0; }
    // THREE consecutive equal non-zero reads AND ≥2.5s elapsed — two reads 450ms apart
    // accepted Ashby's form at 9 fields while its survey/consent entries (4 more) were
    // still mounting (live 2026-07-31). Sections mount in bursts; a stable count between
    // bursts is not a settled form.
    stable = n > 0 && n === prev ? stable + 1 : 0;
    if (stable >= 2 && Date.now() - start >= 2500) {
      // Settled — but settled on WHAT? Identify the page positively before calling it a form.
      const scan = await cdpEval(atsInjScan, ats).catch(() => null);
      const sub = await cdpEval(atsInjSubmitState, ats).catch(() => null);
      const id = atsLooksLikeApplicationForm(scan && scan.fields, sub);
      if (!id.ok) {
        LOG(`${n} field(s) settled here, but this is NOT an application form — ${id.why}. Not filling it.`);
        return { ready: false, fields: n, notAForm: true, why: id.why };
      }
      return { ready: true, fields: n };
    }
    prev = n;
    await cdpDelay(450);
  }
  LOG(`form did not settle within ${ceilingMs || 25000}ms (last field count ${prev})`);
  // Same rule on the timeout path: fields we never identified as a form are not a form.
  if (prev > 0) {
    const scan = await cdpEval(atsInjScan, ats).catch(() => null);
    const sub = await cdpEval(atsInjSubmitState, ats).catch(() => null);
    const id = atsLooksLikeApplicationForm(scan && scan.fields, sub);
    if (!id.ok) { LOG(`the ${prev} field(s) here are not an application form — ${id.why}`); return { ready: false, fields: prev, notAForm: true, why: id.why }; }
  }
  return { ready: prev > 0, fields: Math.max(prev, 0) };
}

// The actuation for the ATS driver: page-side eval + SW wall-clock pacing + the same
// LLM seam the Workday act uses (act.llm honors the popup toggle), + the resume attach
// (SW owns the IndexedDB read — strings only across the eval boundary).
function makeAtsActuation(llmConfig) {
  const workday = makeCdpActuation(llmConfig); // borrow llm + aiEnabled so gating is identical
  return {
    aiEnabled: workday.aiEnabled,
    llm: workday.llm,
    delay: cdpAdaptiveDelay,
    delayFull: cdpDelay,
    eval: (fn, ...args) => cdpEval(fn, ...args),
    wakePage: () => cdpWakePage(), // hidden-tab unfreeze between polls (the discover rule)
    attachResume: async (ref) => {
      const stored = await getResume().catch(() => null);
      if (!stored || !stored.base64) return { ok: false, error: "no resume stored (upload one in the popup / website)" };
      const r = await cdpEval(atsInjAttachFile, ref.inputSel, stored.base64, stored.filename || "resume.pdf", stored.mime || "application/pdf");
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || "attach failed" };
      // async-upload confirmation (GH uploads on change): poll for the filename to render
      // ANYWHERE near the input OR input.files to still hold it — bounded, wall-clock.
      const deadline = Date.now() + 15000;
      let last = null;
      while (Date.now() < deadline) {
        last = await cdpEval(atsInjReadValue, ref.ats || "greenhouse", ref.inputSel, "file_upload");
        if (last && last.ok && last.value) return { ok: true, name: last.value, verified: true };
        await cdpDelay(700);
      }
      return { ok: true, name: r.name, verified: false, detail: "attached (confirmation not read — verify on the form)" };
    },
  };
}

// FILL run: posting → form → fill → review bundle → website. NEVER submits — there is no
// page-advance click on these single-page forms at all; the only submit-capable click
// lives in runAtsSubmitRun behind authorize+arm.
async function runAtsApplicationRun(tabId, ats, store, startUrl, opts0 = {}) {
  // THE JOB IDENTITY IS THE LINK WE WERE GIVEN, not wherever the form turned out to live. A
  // landing hop (employer redirect, embedded frame, apply link) changes the URL, and keying the
  // application on THAT made a re-fill land on a DIFFERENT tracker row — so the original row kept
  // a stale bundle forever and its submit kept failing against fields that no longer exist (live
  // 2026-08-02, after a bad fill had been corrected). Every hop carries the origin forward.
  const originUrl = opts0.originUrl || startUrl;
  const LOG = (...a) => console.log("[ApplyPilot][ATS-RUN]", ...a);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) return { ok: false, error: "attach-failed:" + attached.error };
    await cdpInstallPageOverrides();  // hidden tab: worker timers + rAF unblock (Ashby is an SPA)
    await cdpSetFocusEmulation(true).catch(() => {}); // hidden tab keeps repainting (the discover lever)

    // JD scrape on the POSTING page (we may still be on it) before navigating away.
    emitRunProgress("Reading the job description");
    let jd = null;
    try { jd = await cdpEval(scrapeJobPosting); } catch (e) { LOG("JD scrape skipped:", String((e && e.message) || e)); }
    if (jd && jd.title) LOG(`posting: "${String(jd.title).slice(0, 70)}" @ ${jd.company || "?"} (${(jd.description || jd.text || "").length} chars)`);

    // APPLY-ELSEWHERE redirect (the Anthropic/Constellation pattern, operator 2026-07-31):
    // the hosted form is a DECOY ("you do not need to submit this Greenhouse application")
    // and the REAL application is the partner link. Filling the decoy is worthless — detect,
    // extract the link, and CHASE it once when it resolves to a supported ATS; otherwise
    // halt self-explaining with the link so the operator applies there.
    try {
      const redir = await cdpEval(atsInjDetectRedirect);
      if (redir && redir.redirect) {
        const link = atsPickRedirectAnchor(redir.anchors);
        LOG(`⚠ APPLY-ELSEWHERE posting: "${redir.phrase}" — extracted link: ${link || "NONE (ambiguous/missing)"}`);
        if (!link) {
          return { ok: true, needs_operator: true, stopped: "apply-elsewhere", jd,
            detail: "This posting says its own form doesn't count (" + redir.phrase + ") but the real application link couldn't be extracted unambiguously — open the posting and apply via its link." };
        }
        emitRunProgress("Posting redirects elsewhere", "following the real application link");
        await cdpNavigate(link);
        await cdpDelay(2500); // resolve shorteners/redirect chains before reading the landing
        const landed = await cdpEval(function () { return location.href; }).catch(() => link);
        const landedAts = detectAts(landed);
        LOG(`redirect landed on ${landed} (${landedAts || "unsupported host"})`);
        if ((opts0.chase || 0) >= 1 || !landedAts) {
          return { ok: true, needs_operator: true, stopped: "apply-elsewhere", jd, redirectUrl: landed,
            detail: "The real application is at " + landed + (landedAts ? "" : " — a host this pipeline can't drive yet; apply there yourself.") };
        }
        if (landedAts === "workday") {
          // the Workday pipeline owns its own onboarding — hand the resolved link back up.
          return { ok: true, stopped: "redirect-to-workday", jd, redirectUrl: landed,
            detail: "The real application is a Workday posting: " + landed + " — Run that link (the Workday pipeline will drive it)." };
        }
        await cdpDetach(); // the recursive call re-attaches; ONE tracked client per tab
        return await runAtsApplicationRun(tabId, landedAts, store, landed, { chase: (opts0.chase || 0) + 1, originUrl });
      }
    } catch (e) { LOG("redirect detection skipped:", String((e && e.message) || e)); }

    const formUrl = atsFormUrl(ats, startUrl);
    const here = await cdpEval(function () { return location.href; }).catch(() => null);
    if (here && formUrl && here.split("#")[0] !== formUrl) {
      LOG(`navigating to the application form: ${formUrl}`);
      await cdpNavigate(formUrl);
      await cdpDelay(1200);
    }
    emitRunProgress("Waiting for the form", ats);
    let ready = await waitAtsFormReady(ats, LOG);

    // THE LANDING MAY NOT BE THE FORM (generic, 2026-07-31): a posting URL can serve the
    // employer's OWN careers page — live, a Greenhouse posting 302'd to the company's branded
    // site with zero fields and only an "Apply" link. Never conclude "the form never rendered"
    // without first checking WHERE we are and whether an apply affordance leads onward. Same
    // rule as Workday's "detect the landing"; bounded to one hop so it can't wander.
    if (!ready.ready && !(opts0.applyHops >= 1)) {
      const here2 = await cdpEval(function () { return location.href; }).catch(() => null);
      const landedAts = detectAts(here2);
      // FIRST: the form may be EMBEDDED here rather than linked (Greenhouse's #grnhse_app
      // widget — live 2026-08-01 on two employer sites). The iframe src is the employer's own
      // form URL, so this is evidence, not a constructed guess.
      const emb = await cdpEval(atsInjFindEmbeddedForms).catch(() => null);
      const embUrl = emb && atsPickEmbeddedForm(emb.srcs, detectAts);
      if (embUrl) {
        const embAts = detectAts(embUrl);
        LOG(`the form is EMBEDDED on this page — opening the frame directly (${embAts}): ${embUrl}`);
        await cdpDetach();
        return await runAtsApplicationRun(tabId, embAts, store, embUrl, { chase: opts0.chase || 0, applyHops: (opts0.applyHops || 0) + 1, originUrl });
      }
      const found = await cdpEval(atsInjFindApplyLinks).catch(() => null);
      const link = found && atsPickApplyLink(found.links, detectAts);
      LOG(`no form here (${here2}${landedAts ? ", " + landedAts : ", not a supported ATS host"}) — ${(found && found.links.length) || 0} apply link(s); following: ${link || "NONE (ambiguous/absent)"}`);
      if (link) {
        const linkAts = detectAts(link);
        if (linkAts === "workday") {
          return { ok: true, stopped: "redirect-to-workday", jd, redirectUrl: link,
            detail: "This posting's application is a Workday requisition: " + link + " — run that link (the Workday pipeline drives it)." };
        }
        emitRunProgress("Following the apply link", linkAts || "off-ATS host");
        await cdpNavigate(link);
        await cdpDelay(2500);
        const after = await cdpEval(function () { return location.href; }).catch(() => link);
        const afterAts = detectAts(after);
        LOG(`apply link landed on ${after} (${afterAts || "unsupported host"})`);
        if (!afterAts || afterAts === "workday") {
          return { ok: true, needs_operator: true, stopped: "apply-off-pipeline", jd, redirectUrl: after,
            detail: "The application lives at " + after + (afterAts === "workday" ? " — a Workday requisition; run that link instead." : " — a host this pipeline can't drive yet; apply there yourself.") };
        }
        await cdpDetach(); // the recursive call re-attaches; ONE tracked client per tab
        return await runAtsApplicationRun(tabId, afterAts, store, after, { chase: opts0.chase || 0, applyHops: (opts0.applyHops || 0) + 1, originUrl });
      }
    }
    // No followable LINK, but the page may route Apply through a BUTTON (live 2026-07-31).
    if (!ready.ready && !(opts0.applyHops >= 1)) {
      const clicked = await cdpEval(atsInjClickApplyButton).catch(() => null);
      if (clicked && clicked.ok) {
        LOG(`clicked the apply button (${clicked.clicked}) — waiting for the landing`);
        // The click may NAVIGATE, or it may reveal the form IN PLACE by injecting the ATS's
        // iframe into this very page — live 2026-08-02, an employer careers page did exactly
        // that and the URL never changed, so a url-only re-check called it off-pipeline and
        // abandoned a fillable application. Poll for EITHER outcome, then classify the same way
        // the first landing is classified (url, then embedded frame).
        let after2 = null, afterAts2 = null, embAfter = null;
        for (let i = 0; i < 8; i++) {
          await cdpDelay(1000);
          after2 = await cdpEval(function () { return location.href; }).catch(() => null);
          afterAts2 = detectAts(after2);
          if (afterAts2 && afterAts2 !== "workday") break;
          const e = await cdpEval(atsInjFindEmbeddedForms).catch(() => null);
          embAfter = e && atsPickEmbeddedForm(e.srcs, detectAts);
          if (embAfter) break;
        }
        LOG(`apply button landed on ${after2} (${afterAts2 || (embAfter ? "embedded form revealed in place" : "unsupported host")})`);
        if (afterAts2 && afterAts2 !== "workday") {
          await cdpDetach();
          return await runAtsApplicationRun(tabId, afterAts2, store, after2, { chase: opts0.chase || 0, applyHops: (opts0.applyHops || 0) + 1, originUrl });
        }
        if (embAfter && detectAts(embAfter) && detectAts(embAfter) !== "workday") {
          LOG(`the apply button revealed an embedded ${detectAts(embAfter)} form — opening it: ${embAfter}`);
          await cdpDetach();
          return await runAtsApplicationRun(tabId, detectAts(embAfter), store, embAfter, { chase: opts0.chase || 0, applyHops: (opts0.applyHops || 0) + 1, originUrl });
        }
        return { ok: true, needs_operator: true, stopped: "apply-off-pipeline", jd, redirectUrl: after2,
          detail: "The application lives at " + after2 + " — a host this pipeline can't drive yet; apply there yourself." };
      }
      if (clicked && clicked.reason) LOG(`no apply button to follow (${clicked.reason}${clicked.offered ? ": " + clicked.offered.join(" | ") : ""})`);
    }
    if (!ready.ready) {
      const hereX = await cdpEval(function () { return location.href; }).catch(() => null);
      return { ok: true, needs_operator: true, stopped: "form-not-rendered",
        detail: "No " + ats + " application form rendered at " + (hereX || startUrl) + " and no apply link could be followed — open the tab and check, then re-run.", jd };
    }
    LOG(`form settled — ${ready.fields} field(s).`);

    const jobContext = { ...(store.jobContext || {}) };
    if (jd && jd.company) jobContext.company = jd.company;
    if (!jobContext.company) jobContext.company = atsCompanyFromUrl(startUrl);
    if (jd && jd.title) jobContext.title = jd.title;
    // The JD text grounds the AI answers (an essay written blind to the posting invents a
    // company theme — live: "Kraken's work in the robotics space" for an ENERGY company).
    const jdText = jd && (jd.description || jd.text);
    if (jdText) jobContext.description = String(jdText).slice(0, 4000);

    emitRunProgress("Filling the application", "single-page " + ats + " form (never submits)");
    const fillT0 = Date.now();
    const act = makeAtsActuation(await getLlmConfig());
    const prepared = prepareProfile(store.profile);
    const out = await driveAtsPageFill(act, ats, prepared, store.defaults || {}, jobContext, { buckets: store.buckets || [] });

    // ONE page ⇒ one bundle write (the walk's clear-once + accumulate collapses to a set).
    const pageKey = (() => { try { return new URL(out.url).pathname; } catch (e) { return "application"; } })();
    const bundle = buildReviewBundle(out.results, {
      page: pageKey, pageNumber: 1, pageLabel: "Application",
      url: out.url, tenant: jobContext.company || null, capturedAt: new Date().toISOString(),
    });
    // WHICH PIPELINE filled this, recorded on the bundle. A submit run detects the ATS from the
    // URL, but an employer-HOSTED form (careers.<company>.com — Greenhouse/Lever/Ashby all serve
    // under the employer's own domain) detects as nothing and used to fall through to the Workday
    // onboard path, which halted "unknown-page" on a form we had just filled successfully
    // (live 2026-08-01). The fill already KNOWS the answer, so it writes it down.
    bundle.ats = ats;
    bundle.jobKeyUrl = originUrl; // stable identity across landing hops (see the top of this fn)
    await new Promise((r) => chrome.storage.local.set({ reviewSummary: bundle, reviewAudit: null }, r));
    await reportApplication(bundle, jobContext);
    // [ATS-TIME] the evidence future pacing rounds retune from (the Workday [CDP-TIME] habit):
    // per-field wall clock + the tab's visibility, so a slow HIDDEN run is diagnosable as such.
    const fillMs = Date.now() - fillT0;
    const perField = out.results.length ? Math.round(fillMs / out.results.length) : 0;
    let visNow = null; try { visNow = await cdpVisible(); } catch (e) {}
    LOG(`[ATS-TIME] fill ${(fillMs / 1000).toFixed(1)}s for ${out.results.length} field(s) — ${perField}ms/field (tab ${visNow ? "VISIBLE" : "HIDDEN"})`);
    LOG(`fill complete — ${bundle.total} field(s), ${bundle.needs_review_count} need review. Reported to the website.`);
    emitRunProgress("Fill complete", `${bundle.total} fields, ${bundle.needs_review_count} to review`);
    return { ok: true, reached_form: true, walked: true, ats, jd, counts: out.counts, needs_review: bundle.needs_review_count, reportedUrl: bundle.url, walk: { ok: true, pages: 1, stopped: "ats-single-page" } };
  } catch (e) {
    return { ok: false, error: "exception:" + String((e && e.message) || e) };
  } finally {
    await cdpDetach();
  }
}

// SUBMIT run: approved bundle → blank form → re-fill → verify → gate → (armed) submit.
// The submit click is TRUSTED input (the one irreversible action; captcha vendors also
// score event trust) and happens ONLY when: no bundle blockers, no live verify failures,
// no visible captcha challenge, arm===true. A visible captcha challenge is a
// needs_operator halt — NEVER solved or bypassed by the bot.
async function runAtsSubmitRun(tabId, ats, bundle, opts) {
  const LOG = (...a) => console.log("[ApplyPilot][ATS-SUBMIT]", ...a);
  const arm = !!(opts && opts.arm);
  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) return { ok: false, error: "attach-failed:" + attached.error };
    await cdpInstallPageOverrides();
    await cdpSetFocusEmulation(true).catch(() => {});

    // GO WHERE THE FILL WENT. bundle.url is the URL the fill ACTUALLY filled, which is not
    // always the posting link the caller holds: an employer careers page can serve the real
    // form from an embedded frame, and the fill followed it there. Starting from the caller's
    // URL instead put the replay back on the employer page, where the form-identity gate
    // (correctly) refused to treat a 1-field marketing page as an application form and the
    // submit died at form-not-rendered — for a job that fills perfectly (live 2026-08-02).
    // The caller's URL stays the fallback for bundles written before this was recorded.
    const formUrl = atsFormUrl(ats, bundle.url || (opts && opts.startUrl));
    const here = await cdpEval(function () { return location.href; }).catch(() => null);
    if (here && formUrl && here.split("#")[0] !== formUrl) { await cdpNavigate(formUrl); await cdpDelay(1200); }
    let ready = await waitAtsFormReady(ats, LOG);
    // Same landing recovery the FILL run has: the form may be EMBEDDED on this page.
    if (!ready.ready) {
      const emb = await cdpEval(atsInjFindEmbeddedForms).catch(() => null);
      const embUrl = emb && atsPickEmbeddedForm(emb.srcs, detectAts);
      if (embUrl && detectAts(embUrl) === ats) {
        LOG(`the form is EMBEDDED here — opening the frame directly: ${embUrl}`);
        await cdpNavigate(embUrl); await cdpDelay(1200);
        ready = await waitAtsFormReady(ats, LOG);
      }
    }
    if (!ready.ready) return { ok: true, needs_operator: true, stopped: "form-not-rendered", submitted: false, detail: ready.why || "the application form did not render here" };

    // A DECOY form must never be replayed or submitted — even one with an approved bundle
    // from before the detector existed (the Anthropic/Constellation pattern).
    try {
      const redir = await cdpEval(atsInjDetectRedirect);
      if (redir && redir.redirect) {
        const link = atsPickRedirectAnchor(redir.anchors);
        LOG(`⚠ REFUSING to ${arm ? "submit" : "rehearse"} — the posting says this form doesn't count ("${redir.phrase}"). Real link: ${link || "not extracted"}`);
        return { ok: true, needs_operator: true, submitted: false, replayed: false, stopped: "apply-elsewhere", redirectUrl: link || null,
          detail: "This form is a decoy — the posting says applications go through " + (link || "its partner link") + ". Nothing was replayed or submitted." };
      }
    } catch (e) { /* detection is best-effort; the gates below still hold */ }

    // Approved values by fieldName (the bundle is the SOURCE OF TRUTH — never the profile).
    // field_id is "<page>::formField-<fieldName>"; is_deleted rows and empty values are
    // "leave blank" (a cleared optional), a checkbox carries "true"/"false".
    //
    // DURABLE KEY (2026-07-31, live): Ashby's EEOC radio names carry a PER-SESSION uuid
    // prefix ("c4787042-…__systemfield_eeoc_gender" one load, "aa058f67-…" the next), so a
    // full-name match can never survive the fresh form a submit run opens. The
    // __systemfield_* suffix is the stable identity — strip the uuid prefix on BOTH sides.
    const durable = atsDurableFieldName; // shared + unit-pinned in ats.js (per-session uuid prefixes)
    const approved = new Map();
    for (const e of bundle.entries || []) {
      if (!e || e.is_deleted) continue;
      const m = /::formField-(.+)$/.exec(String(e.field_id || ""));
      const name = m ? m[1] : String(e.field_id || "");
      approved.set(durable(name), e);
    }
    const valueFor = (f) => {
      const e = approved.get(durable(f.fieldName));
      if (!e) return undefined;                       // never in the bundle → leave alone
      if (f.widgetType === "file_upload") return "resume"; // presence = re-attach
      const v = e.current_value;
      if (v == null || String(v).trim() === "") return undefined; // approved-blank → leave blank
      return String(v);
    };

    emitRunProgress(arm ? "Replaying approved values (ARMED)" : "Rehearsing the submit", ats);
    const act = makeAtsActuation(await getLlmConfig());
    // AI stays out of a submit run entirely: valueFor covers every field the human approved;
    // anything else is deliberately blank. aiEnabled=false regardless of the popup toggle.
    act.aiEnabled = false;
    let out = await driveAtsPageFill(act, ats, {}, {}, { company: bundle.tenant }, { valueFor });

    // CASCADE RE-REPLAY (2026-08-01). A value committed during the replay can REVEAL more
    // questions — live on an Ashby form, two work-authorization questions mount only after an
    // earlier answer, so the first pass could not see them and the strict verify reported the
    // approved values as "no matching field on the live form" and refused the submit. The field
    // set captured before the replay is therefore not final. Same fix the Workday replay walk
    // already carries; bounded to one extra round so it can never loop, and only paid when an
    // approved value is actually missing. Re-filling is idempotent (same approved values, and
    // a field already holding its value is left alone), so the second pass can only add.
    const missingAfter = (res) => {
      const live = new Set(res.map((r) => durable(r.fieldName)));
      return [...approved].filter(([n, e]) => !live.has(n) && e.current_value != null && String(e.current_value).trim() !== "");
    };
    if (missingAfter(out.results).length) {
      const before = out.results.length;
      LOG(`${missingAfter(out.results).length} approved value(s) had no field yet — re-scanning for questions the replay revealed`);
      const again = await driveAtsPageFill(act, ats, {}, {}, { company: bundle.tenant }, { valueFor });
      // Keep the LATER record for any field seen twice: it reflects the form as it stands now.
      const merged = new Map(out.results.map((r) => [durable(r.fieldName), r]));
      for (const r of again.results) merged.set(durable(r.fieldName), r);
      out = { ...again, results: [...merged.values()] };
      LOG(`re-scan: ${before} → ${out.results.length} field(s); ${missingAfter(out.results).length} still absent`);
    }

    // STRICT verify: every approved non-blank value must be ON the form now.
    const failures = [];
    for (const r of out.results) {
      const e = approved.get(durable(r.fieldName));
      if (!e) continue;
      const want = e.current_value;
      if (want == null || String(want).trim() === "") continue;
      if (r.status === "filled" || r.status === "filled_review") continue;
      failures.push(`${r.fieldName} ("${(e.question_label || "").slice(0, 60)}"): ${r.status} — ${r.detail || "no detail"}`);
    }
    // Approved entries the live form no longer shows (form changed since the fill).
    const liveNames = new Set(out.results.map((r) => durable(r.fieldName)));
    for (const [name, e] of approved) {
      if (liveNames.has(name)) continue;
      if (e.current_value == null || String(e.current_value).trim() === "") continue;
      failures.push(`${name} ("${(e.question_label || "").slice(0, 60)}"): approved value has NO matching field on the live form`);
    }

    const state = await cdpEval(atsInjSubmitState, ats);
    const blockers = bundleSubmitBlockers(bundle);
    LOG(`verify: ${out.results.length} field(s) replayed, ${failures.length} failure(s); bundle blockers: ${blockers.length}; submit button: ${state && state.hasSubmit} (disabled=${state && state.disabled}); captcha challenge visible: ${state && state.captchaChallenge}`);
    failures.forEach((f) => LOG("  ✗ " + f));
    blockers.forEach((b) => LOG("  ✗ bundle: " + b));

    if (blockers.length || failures.length) {
      return { ok: true, submitted: false, replayed: true, stopped: "verify-failed", failures: failures.concat(blockers), ats };
    }
    if (!state || !state.hasSubmit) return { ok: true, submitted: false, replayed: true, stopped: "no-submit-button", ats };
    if (state.captchaChallenge) return { ok: true, needs_operator: true, submitted: false, replayed: true, stopped: "captcha-challenge", detail: "A captcha challenge is visible — solve it yourself in the tab, then submit manually or re-run.", ats };

    if (!arm) {
      LOG("▶▶ WOULD CLICK SUBMIT ◀◀ (dry rehearsal — every gate passed; arm the run to actually submit)");
      return { ok: true, submitted: false, replayed: true, would_submit: true, stopped: "simulate", ats };
    }

    // ── the ONE irreversible click — trusted input, forced. ──
    LOG("⚠ ARMED — clicking Submit (trusted input).");
    cdpSetSyntheticInput(false);
    await cdpClickAt(state.rect.cx, state.rect.cy);
    // Outcome: confirmation, validation errors, or a captcha challenge that popped on submit.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await cdpDelay(1000);
      const s2 = await cdpEval(atsInjSubmitState, ats).catch(() => null);
      if (s2 && s2.confirmed) { LOG("✅ SUBMITTED — confirmation detected:", s2.url); return { ok: true, submitted: true, replayed: true, confirmed: true, ats, confirmUrl: s2.url }; }
      if (s2 && s2.captchaChallenge) { LOG("captcha challenge appeared on submit — operator must solve it in the tab."); return { ok: true, needs_operator: true, submitted: false, replayed: true, stopped: "captcha-challenge", ats }; }
      const errs = await cdpEval(atsInjErrors, ats).catch(() => null);
      if (errs && errs.errors && errs.errors.length) { LOG("submit refused — validation errors:"); errs.errors.forEach((x) => LOG("  · " + x)); return { ok: true, submitted: false, replayed: true, stopped: "validation-errors", errors: errs.errors, ats }; }
    }
    LOG("no confirmation within 30s — VERIFY IN THE TAB before assuming either outcome.");
    return { ok: true, submitted: false, replayed: true, stopped: "no-confirmation", detail: "Submit was clicked but no confirmation rendered within 30s — check the tab.", ats };
  } catch (e) {
    return { ok: false, error: "exception:" + String((e && e.message) || e) };
  } finally {
    await cdpDetach();
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
    cdpSetSyntheticInput(true); // FILL entry point — hidden actuation dispatches page-side (the proven form-page repertoire); auth/onboarding/recon stay trusted
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

// ── The résumé attach, with a THROTTLE-IMMUNE confirmation (2026-07-28) ─────────────────────────────
// The one shared attach path for both walks. `attachResume` runs page-side and its confirmation poll is
// therefore subject to everything a hidden tab does to a page: a slower XHR, a throttled React render,
// and (when the CSP blocks the worker-timer override) a ~1Hz timer. Live on a BACKGROUND run it reported
// "file-upload-item appeared but file-upload-successful did not within 10s" and the replay walk HALTED —
// yet re-running the same job worked, which is the signature of a race, not a broken upload.
//
// Two changes, in the order that matters:
//   1. the page-side ceiling SCALES with visibility (the same renderBudget reasoning as the auth waits);
//   2. an unconfirmed-but-STARTED upload is then re-polled FROM THE SERVICE WORKER on wall-clock, waking
//      the page each tick — the project's standing rule that a wait must never depend on a page timer.
// An explicit Workday error, or no upload row at all, skips the re-poll: those are not races, and
// pretending otherwise would just delay an honest failure.
const RESUME_CONFIRM_VISIBLE_MS = 10000;   // live-verified value — unchanged for the visible path
const RESUME_CONFIRM_HIDDEN_MS = 25000;    // a hidden tab uploads AND repaints slower
const RESUME_REPOLL_MS = 20000;            // SW-side second chance, wall-clock
const RESUME_REPOLL_UPLOADING_MS = 45000;  // Workday itself says "<file> loading" ⇒ positive evidence it is still in flight; give it real room

// Self-contained page read for the SW-side poll (deliberately tiny — it runs many times). Reports the
// aria-live STATUS verbatim so the poll can say "still loading" instead of guessing, and can notice a
// genuine error that only renders late.
function cdpReadUploadState(sectionSel) {
  const sec = document.querySelector(sectionSel || '[data-fkit-id="resumeAttachments--attachments"]') || document;
  const nameEl = sec.querySelector('[data-automation-id="file-upload-item-name"]');
  let status = "";
  try {
    status = Array.prototype.slice.call(sec.querySelectorAll('[role="alert"], [aria-live], [data-automation-id="file-upload-error"]'))
      .map((n) => (n.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ").slice(0, 200);
  } catch (e) { /* status is a nice-to-have */ }
  return {
    successful: !!sec.querySelector('[data-automation-id="file-upload-successful"]'),
    items: sec.querySelectorAll('[data-automation-id="file-upload-item"]').length,
    fileName: nameEl ? (nameEl.textContent || "").trim() : null,
    status,
    uploading: /\b(loading|uploading|in progress|processing)\b|\d+\s*%/i.test(status),
    errored: /\b(error|failed|failure|unsuccessful|not supported|unsupported|too large|exceeds|invalid|not allowed)\b/i.test(status) && !/success/i.test(status)
  };
}

async function cdpAttachResumeConfirmed(resumeRec, LOG, sectionSel) {
  let visible = false;
  try { visible = await cdpVisible(); } catch (e) { /* assume hidden — the generous budget is the safe default */ }
  const ceiling = visible ? RESUME_CONFIRM_VISIBLE_MS : RESUME_CONFIRM_HIDDEN_MS;

  let ar = null, arErr = null;
  // The input-lock's capture-phase blocker SWALLOWS attachResume's SYNTHETIC delete/attach clicks
  // whenever window.__apActing is 0 — bump it exactly as the gated CDP primitives do.
  try { await cdpEval(() => { window.__apActing = (window.__apActing || 0) + 1; }); } catch (e) { /* no lock/page — ignore */ }
  try { ar = await cdpEval(attachResume, resumeRec.base64, resumeRec.filename || "resume.pdf", resumeRec.mime || "application/pdf", sectionSel || null, ceiling); }
  catch (e) { arErr = String((e && e.message) || e); }
  finally { try { await cdpEval(() => { window.__apActing = Math.max(0, (window.__apActing || 1) - 1); }); } catch (e) { /* ignore */ } }

  if (ar && ar.attached) return ar;
  if (arErr || !ar) return ar || { attached: false, detail: "attach eval failed — " + arErr };
  // Always report what the attach actually did, on the failure path too — a clear that had to remove an
  // existing attachment first is slower, and that difference is the leading suspect for why the REPLAY run
  // sees this and the FILL run doesn't (the fill lands on a virgin Documents section; a re-apply can find
  // Workday's carried-over copy already there).
  LOG && LOG(`resume: attach not yet confirmed — cleared=${ar.cleared} deleted=${ar.deletedCount || 0} filesSet=${ar.filesSetImmediately} sawItem=${!!ar.sawItem} uploading=${!!ar.uploading}${ar.statusText ? ` status="${ar.statusText}"` : ""}${ar.errorText ? ` ERROR="${ar.errorText}"` : ""}`);
  if (ar.errorText) return ar;            // Workday REJECTED the file — a real failure, don't wait on it
  // NOTE `uploading` is checked BEFORE sawItem (2026-07-29): Workday's aria-live "<file> loading" is
  // positive evidence the upload is in flight even if the poll never caught a file-upload-item row. The
  // first cut of this code mis-read that very text as an ERROR and returned here, skipping the re-poll
  // entirely — which is exactly the wait it exists to perform.
  if (!ar.sawItem && !ar.uploading) return ar; // nothing ever started uploading — re-polling would just stall

  // Started but unconfirmed ⇒ the race. Keep watching from out here, where the clock is real. When Workday
  // itself says "loading", we have positive evidence it is still going, so allow a longer window.
  const budget = ar.uploading ? RESUME_REPOLL_UPLOADING_MS : RESUME_REPOLL_MS;
  LOG && LOG(`resume: upload started but not yet confirmed after ${Math.round(ceiling / 1000)}s (tab ${visible ? "VISIBLE" : "HIDDEN"})`
    + `${ar.uploading ? ` — Workday says "${ar.statusText}", so it is STILL IN FLIGHT` : ""} — re-polling from the service worker for up to ${Math.round(budget / 1000)}s.`);
  const t0 = Date.now();
  const deadline = t0 + budget;
  let last = null;
  while (Date.now() < deadline) {
    await cdpDelay(500);
    try { await cdpWakePage(); } catch (e) { /* best effort */ }
    let s = null;
    try { s = await cdpEval(cdpReadUploadState, sectionSel || null); } catch (e) { continue; } // mid-render read → keep polling
    if (!s) continue;
    last = s;
    if (s.successful) {
      const waited = Math.round((Date.now() - t0) / 1000);
      LOG && LOG(`resume: ✓ confirmed ${waited}s later — the page-side ceiling was simply short of a slow upload.`);
      return { ...ar, attached: true, confirmationSeen: true, confirmationVia: "file-upload-successful (SW re-poll)", fileName: s.fileName || ar.fileName,
        detail: `attached + confirmed via file-upload-successful after a ${waited}s SW re-poll (cleared ${ar.deletedCount || 0} existing)` };
    }
    // A genuine error can render LATE — stop waiting on something Workday has already rejected.
    if (s.errored) {
      LOG && LOG(`resume: Workday reported an upload ERROR during the re-poll — "${s.status}". Not waiting further.`);
      return { ...ar, errorText: s.status, detail: `Workday reported an upload error: "${s.status}"` };
    }
  }
  const total = Math.round((ceiling + budget) / 1000);
  return { ...ar, statusText: (last && last.status) || ar.statusText,
    detail: `resume upload never confirmed within ${total}s (tab was ${visible ? "VISIBLE" : "HIDDEN"}`
      + `${last ? `; last status "${last.status || "(none)"}", ${last.items} row(s)` : ""}) — cleared ${ar.deletedCount || 0} existing first` };
}

// Re-attach the stored résumé on the CURRENT page (replay path — replayField defers file_upload to
// this SW step). Reads the bytes from IndexedDB and runs the shared confirmed-attach above.
async function replayAttachResume(LOG) {
  let resumeRec = null;
  try { resumeRec = await getResume(); } catch (e) { /* treat as none */ }
  if (!resumeRec || !resumeRec.base64) {
    LOG("resume: NOT attached — no resume stored (upload one in the popup).");
    return { attached: false, detail: "no resume stored — upload a PDF in the popup first" };
  }
  const ar = await cdpAttachResumeConfirmed(resumeRec, LOG);
  if (ar && ar.attached) {
    LOG(`resume: attached "${ar.fileName || resumeRec.filename}".`);
    return { attached: true, detail: `attached (cleared ${ar.deletedCount || 0} existing)`, fileName: ar.fileName || resumeRec.filename };
  }
  const detail = "resume attach failed — " + ((ar && ar.detail) || "no confirmation");
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
const MAX_REPLAY_SOFT_RELOADS = 3; // Workday soft-error reloads per REPLAY run — mirrors the fill walk's MAX_SOFT_RELOADS (a soft error is transient; 3 strikes ⇒ hand it to the operator).

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

// ── Workday's PHANTOM "required" error — a filled field it says is empty (2026-07-28) ───────────────
// Live on a HIDDEN solarturbines replay, page 5: every value physically correct and read-back verified
// ("5 field(s) — 3 changed, 1 already-correct, 0 FAILED"), and Save & Continue came back with
//   • Error-Name  The field Name is required and must have a value.
//   • Error-Date  The field Date is required and must have a value.
// Operator: *"The fields are physically filled correctly … manually I just click into the field text box,
// and then press next and the error goes away."* That workaround IS the diagnosis: Workday validates on
// BLUR, and in synthetic-input mode nothing blurs the field (see cdpCommitPendingEdits). The value is in
// the DOM; Workday's form model never got told the edit finished.
//
// This is the CURATIVE half (the preventive blur lives in clickPageNext). It is EVIDENCE-GATED, which is
// what makes it safe to run automatically: it fires ONLY when every field the error names is present on
// the page AND visibly HOLDS a value. A genuinely empty required field returns ran:false and the caller
// halts exactly as before — this can never paper over a real gap, and it never invents or changes a value
// (focus → change → blur only). Deterministic; no AI, which is why it's allowed on the replay path at all.
async function nudgePhantomRequired(act, errorTexts, LOG) {
  const titles = (errorTexts || []).map((t) => parseErrorFieldName(t)).filter(Boolean);
  if (!titles.length) return { ran: false, reason: "the error text names no field" };

  let scan = null;
  try { scan = await cdpEval(cdpPageScan); } catch (e) { return { ran: false, reason: "could not scan the page: " + String((e && e.message) || e) }; }

  // The DECISION (is this the phantom, and which wrappers?) is the pure, unit-pinned
  // phantomRequiredTargets — this function only does the I/O around it.
  const verdict = phantomRequiredTargets(titles, (scan && scan.fields) || []);
  if (!verdict.phantom) return { ran: false, reason: verdict.reason };
  // phantomRequiredTargets is pure and reports identity + value; the widget type comes from the scan.
  const byName = new Map((((scan && scan.fields) || [])).map((f) => [f.fieldName, f]));
  const matched = verdict.targets.map((m) => Object.assign({}, m, { widgetType: (byName.get(m.fieldName) || {}).widgetType || null }));

  LOG(`  phantom-required: Workday says ${matched.map((m) => JSON.stringify(m.title)).join(" + ")} ${matched.length === 1 ? "is" : "are"} empty, but the page HOLDS ${matched.map((m) => JSON.stringify(String(m.value))).join(" + ")}. Committing ${matched.length === 1 ? "it" : "them"} with a focus→blur nudge (the manual fix) and re-saving.`);
  // ── RE-TYPE WITH TRUSTED INPUT (2026-08-04) ──────────────────────────────────────────────────────
  // The focus→blur nudge below is dispatched page-side, and on a HIDDEN run that is the very kind of
  // interaction this surface ignores — which is why it has never cleared this error. Measured on
  // waystar's Self Identify page: hidden+synthetic failed 2/2 with Workday calling Name and Date empty
  // on a page that plainly held both, and the SAME run passed with forceTrustedInput. Same finding the
  // auth form produced, which is why onboarding stays trusted.
  //
  // So re-enter the value the page ALREADY shows, through the trusted path. It changes no value, needs
  // no FIELD_MAP entry (these fields are AI/recognizer-filled, which is exactly why Tier 1 skipped
  // them), and trusted input is the one thing measured to work here. Synthetic is restored in a finally
  // so the rest of the page keeps the hidden-tab speed win, as Tier 1 already does.
  const wasSynthetic = typeof cdpSyntheticInputEnabled === "function" ? cdpSyntheticInputEnabled() : true;
  const retyped = [];
  if (act) {
    try {
      cdpSetSyntheticInput(false);
      for (const m of matched) {
        const loc = { wrapperSel: m.wrapperSel };
        let res = null;
        try {
          if (m.widgetType === "text" || m.widgetType === "textarea") {
            res = await fillTextCdp(act, loc, String(m.value), DEFAULT_BUDGETS, m.widgetType === "textarea" ? "textarea" : undefined);
          } else if (m.widgetType === "date") {
            // read the segments rather than parsing the rendered string, whose order is tenant-variable
            const segs = await cdpEval(cdpReadDateSegValues, m.wrapperSel);
            // forceSegmentTransition: EMPTY each segment before re-typing it. Without this the re-type
            // is a byte-identical write over a triple-click selection — no value transition at all —
            // which is why this remedy failed live on a field whose DOM *and* React state already held
            // the value Workday was calling empty. fillTextCdp already clears (Ctrl+A) and so already
            // transitions; the date path is forbidden Ctrl+A, so it needs this explicitly.
            if (segs) res = await fillDateCompositeCdp(act, loc, segs, Object.assign({}, DEFAULT_BUDGETS, { forceSegmentTransition: true, skipIfCorrect: false }));
          }
        } catch (e) { res = { status: "error", detail: String((e && e.message) || e) }; }
        retyped.push(`${m.fieldName}=${res ? res.status : "unsupported(" + m.widgetType + ")"}`);
      }
    } finally { cdpSetSyntheticInput(wasSynthetic); }
    if (retyped.length) LOG(`  phantom-required: re-typed with TRUSTED input — ${retyped.join(", ")}`);
  }

  let nudged = null;
  try { nudged = await cdpEval(cdpNudgeFieldCommit, matched.map((m) => m.wrapperSel)); }
  catch (e) { return { ran: false, reason: "the nudge eval failed: " + String((e && e.message) || e) }; }
  const total = (nudged || []).reduce((n, r) => n + (r.nudged || 0), 0);
  if (!total) return { ran: false, reason: `no input could be focused inside ${matched.map((m) => m.fieldName).join(", ")} — nothing to commit` };
  LOG(`  phantom-required: nudged ${total} input(s) across ${matched.length} field(s) — ${JSON.stringify(nudged)}`);
  await cdpDelay(700); // let Workday's blur validator run before the re-save (wall-clock; it is page-side work)
  return { ran: true, fields: matched.map((m) => m.fieldName), nudged: total, retyped };
}

// Dump the decisive state for a "required" error on a field that looks filled (2026-07-28, round 2).
// The blur-commit fix did not clear it, so rather than guess a third time this prints — READ-ONLY, at the
// moment of the failure — the DOM value, REACT's internal value, the date spinbuttons' aria-valuenow, and
// whether each error is rendered inside the field's own wrapper. See cdpDiagnoseFieldCommit for which
// hypothesis each combination points at. Always safe to call: it reads, it never actuates.
// After a blocked Save, correct any record whose value the FORM REJECTED (see rejectedValueEntries).
// The bundle is the human's view of the page, so it must not claim a value the page threw away.
async function syncRejectedValues(errorTexts, LOG) {
  try {
    const scan = await cdpEval(cdpPageScan);
    const live = (scan && scan.fields) || [];
    const bundle = await new Promise((res) => chrome.storage.local.get("reviewSummary", (r) => res(r && r.reviewSummary)));
    // ALWAYS account for the run. The notes list covers the cases the reconciler can explain, but the
    // guards ABOVE it (no scan, no bundle) returned silently — and live that was indistinguishable from
    // "the bundle was already right", so a check that never ran looked like a check that found nothing.
    // Twice now this session, a no-op that said nothing cost a whole run to diagnose.
    if (!bundle || !Array.isArray(bundle.entries)) {
      LOG(`  (rejected-value check: no stored bundle to reconcile — skipped)`);
      return;
    }
    const r = rejectedValueEntries(bundle.entries, live, errorTexts);
    if (!r.changed.length) {
      const notes = r.notes || [];
      if (notes.length) for (const n of notes) LOG(`  (rejected-value check: ${n})`);
      else LOG(`  (rejected-value check: nothing to correct — ${live.length} live field(s), ${bundle.entries.length} bundle entr(ies), errors named ${JSON.stringify((errorTexts || []).length)})`);
      return;
    }
    bundle.entries = r.entries;
    bundle.needs_review_count = bundle.entries.filter((e) => e && e.needs_review && !e.is_deleted).length;
    await new Promise((res) => chrome.storage.local.set({ reviewSummary: bundle }, res));
    for (const c of r.changed) LOG(`  ⚠ the form REJECTED ${JSON.stringify(c.was)} for "${c.label}" — the review now shows it EMPTY and asks you for an answer it will accept.`);
  } catch (e) { LOG(`  (could not reconcile rejected values: ${String((e && e.message) || e)})`); }
}
async function diagnoseRequiredErrorFields(errorTexts, LOG) {
  try {
    const titles = (errorTexts || []).map((t) => parseErrorFieldName(t)).filter(Boolean);
    if (!titles.length) { LOG("  [FIELD-DIAG] the error text names no field — nothing to diagnose."); return; }
    const scan = await cdpEval(cdpPageScan);
    const fields = (scan && scan.fields) || [];
    const sels = [], unmatched = [];
    for (const title of titles) {
      const want = normalizeLabel(title);
      const hit = fields.find((f) => normalizeLabel((f && f.label) || "") === want)
        || fields.find((f) => normalizeLabel((f && f.fieldName) || "") === want);
      if (hit) sels.push(hit.wrapperSel); else unmatched.push(title);
    }
    LOG(`  [FIELD-DIAG] errors name [${titles.join(", ")}]; matched ${sels.length} wrapper(s)${unmatched.length ? `; UNMATCHED (not in the flat scan — inside a repeating section? not rendered?): ${unmatched.join(", ")}` : ""}`);
    LOG(`  [FIELD-DIAG] the page's ${fields.length} flat field(s): ${fields.map((f) => `${f.fieldName}=${JSON.stringify(String(f.value == null ? "" : f.value)).slice(0, 40)}${f.isRequired ? "*" : ""}`).join(" · ")}`);
    if (!sels.length) return;
    const d = await cdpEval(cdpDiagnoseFieldCommit, sels);
    if (!d) { LOG("  [FIELD-DIAG] the diagnostic read returned nothing."); return; }
    LOG(`  [FIELD-DIAG] activeElement=${d.activeElement}`);
    for (const f of d.fields || []) {
      if (!f.present) { LOG(`  [FIELD-DIAG] ${f.sel} — WRAPPER NOT ON THE PAGE`); continue; }
      LOG(`  [FIELD-DIAG] ${f.sel}`);
      for (const i of f.inputs || []) {
        LOG(`      ↳ ${i.tag}${i.automationId ? `[${i.automationId}]` : ""} type=${i.type || i.role || "?"}`
          + ` domValue=${JSON.stringify(i.domValue)} reactProps=${JSON.stringify(i.reactPropsValue)} reactFiber=${JSON.stringify(i.reactFiberValue)}`
          + ` ariaValueNow=${JSON.stringify(i.ariaValueNow)} ariaInvalid=${JSON.stringify(i.ariaInvalid)}`
          + (i.checked === null ? "" : ` checked=${i.checked}`) + (i.isActiveElement ? " ← FOCUSED" : ""));
      }
      // Node scan first, then the wrapper's own TEXT — Workday's inline error element has no error-ish
      // automation-id and no role=alert, so the node scan alone reported "NONE" on a wrapper that was
      // visibly rendering the error (live 2026-07-28). Only "no node AND no text" means page-level/stale.
      LOG(`      this field's OWN error: ${f.errorsInsideWrapper && f.errorsInsideWrapper.length ? JSON.stringify(f.errorsInsideWrapper)
        : (f.inlineErrorInWrapperText ? `(inline, no error-ish node) ${JSON.stringify(f.inlineErrorInWrapperText)}` : "NONE — the error is page-level only, so it may be STALE")}`);
      LOG(`      wrapper text: ${JSON.stringify(f.wrapperText)}`);
    }
    LOG(`  [FIELD-DIAG] all error nodes on the page: ${JSON.stringify(d.allErrorNodes)}`);
    LOG("  [FIELD-DIAG] read this as: domValue set + reactProps/(fiber) EMPTY ⇒ React never got the value (the native setter didn't notify it);"
      + " domValue EMPTY ⇒ the value reverted after we verified it; both set ⇒ Workday's model disagrees with its own DOM;"
      + " no error inside any wrapper ⇒ the error is page-level/stale and the Save click may have been swallowed.");
  } catch (e) {
    LOG("  [FIELD-DIAG] failed: " + String((e && e.message) || e));
  }
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
    // opts.jobKey (a website-driven submit run) pins the pull to ONE job: without it the pull keys on
    // the LOCAL bundle's url, whose no-match fallback is "the most recently updated bundle" — which
    // could hand this walk a DIFFERENT application's approved values to replay into this form.
    await pullApprovedBundle(LOG, opts && opts.jobKey ? { jobKey: opts.jobKey } : undefined);
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
    // SYNTHETIC INPUT ON for the replay's field actuation (2026-07-28) — so a BACKGROUND submit run is
    // not ~1.2-1.5s per input event. It was held off "until the fill walk's synthetic mode is
    // live-verified", and that condition is now met by the background fills. The original objection was
    // specific to the AUTH form (its Sign In submit never fired under synthetic — the auth app doesn't
    // register native-setter values), and that surface is NOT here: runCdpOnboard signs in on its OWN
    // attach, which stays trusted, and cdpAttach resets this flag, so enabling it here covers ONLY
    // application FORM pages — exactly the surface the synthetic repertoire was proven on.
    //
    // Safe because nothing about VERIFICATION changes: synthetic only engages when the tab is HIDDEN
    // (cdpSynthInput), every read-back / persistence re-read / M40 audit is untouched, and the replay
    // adds strict per-field verify + review-page equality + the submit gate on top. A synthetic no-op
    // therefore ends as needs_review and halts — it can never become a wrong value. `forceTrustedInput`
    // in chrome.storage.local still overrides everything.
    cdpSetSyntheticInput(true);
    const _vis = await cdpVisible().catch(() => true);
    const _mode = _vis ? "VISIBLE (trusted input)" : "HIDDEN (synthetic input for fields; the submit click stays trusted)";
    LOG(authorize
      ? `⚠ ARMED REPLAY WALK (authorize=true) — replaying the ${bundle.entries.length} approved field(s) page-by-page; at the REVIEW page it runs the precondition gate and, if EVERY check passes, clicks SUBMIT ONCE. Tab is ${_mode}.${simulateSubmit ? " SIMULATE: it will stop at 'would submit'." : " This run CAN submit — disposable application."}`
      : `DRY REPLAY WALK — replaying the ${bundle.entries.length} approved field(s) page-by-page to the REVIEW page. NEVER submits (not authorized). Tab is ${_mode}. A value the form no longer offers, or a required field left empty, HALTS — never a guess.`);
    const act = makeCdpActuation(await getLlmConfig()); // AI OFF for replay regardless (replayRepeatingSections passes aiContext:null; flat replayField never calls AI)
    let pagesReplayed = [];
    // Workday's PHANTOM duplicate-entry bug (see clearPhantomDuplicates): what we deleted to get past
    // Save & Continue, so the review page can be checked for those exact values coming back.
    let phantomDeleted = [];
    let dupFixes = 0; // per-RUN budget — a duplicate error that survives the fix is a real problem, not a retry loop
    let phantomNudges = 0; // per-RUN budget for the blur-race fix (nudgePhantomRequired) — same reasoning: if a focus→blur commit doesn't clear it, it isn't the blur race
    let forcedRefills = 0; // per-RUN budget for the mechanism-agnostic force-re-actuate remedy (skip-if-correct OFF) — if re-WRITING the approved value doesn't clear it, re-writing it again won't either
    let dateStamps = 0;    // per-RUN budget for the REACTIVE signature-date stamp — the only value the replay may write that the review page did not approve, and only because Workday asked for it by name

    let findings = { mismatches: [], cascadeRevealed: [] }; // fed to the submit gate; the walk HALTS on any mismatch/cascade before review, so these stay empty on a clean run (the gate re-checks defensively)
    let submitFired = false; // single-fire sentinel
    let softReloads = 0; // RUN-level budget for Workday's transient "Something went wrong / please refresh" page (mirrors the fill walk)
    let reloadsUsed = 0; // RUN-level reload-retry budget: a reload returns Workday to page 1, so a transient render-flake RESTARTS the whole walk (bounded by MAX_RELOAD_RETRIES)

    restartWalk: while (true) { // a transient-flake reload restarts here from page 1; a clean finish / halt / review-terminal returns out of the function
    pagesReplayed = []; findings = { mismatches: [], cascadeRevealed: [] }; submitFired = false; phantomDeleted = []; // reset per attempt
    let prevPageIdentity = null; // flat-fields+sections identity of the page just replayed — to catch a false "advanced" (see the same-page guard)
    for (let page = 1; page <= REPLAY_MAX_PAGES; page++) {
      walkPage = page;
      let pageResults = []; // this page's replay records — read by the phantom-duplicate fix on a nav-timeout
      // ── TOP-OF-ITERATION guards (SUBMIT-NEVER: review terminal checked BEFORE any replay/click). ──
      let nav = null;
      try { nav = await cdpEval(cdpReadSessionState); } catch (e) { /* not-ready → handled below */ }
      // ── Workday's transient "Something went wrong / please refresh" page (2026-07-27). The FILL walk
      //    has handled this since 2026-07-22; the REPLAY walk never got it, and the failure was ugly:
      //    the error page carries NO form, so selectPageBundleEntries matched nothing and the walk
      //    halted "replay-page-not-in-bundle — The bundle never captured this page", blaming the
      //    approved bundle for a transient Workday hiccup (live, on a Rehearse run). Checked FIRST,
      //    before the no-form/no-match paths can misread it. A reload returns Workday to page 1, so —
      //    exactly like the fill walk — the whole walk restarts; skip-if-correct makes the pages that
      //    are already right fast on the way back through. Bounded per RUN. ──
      if (nav && nav.softErrorPresent) {
        if (softReloads >= MAX_REPLAY_SOFT_RELOADS) {
          LOG(`⚠ Workday soft-error ("Something went wrong / please refresh") persisted after ${softReloads} reload(s) — halting for the operator (refresh the page + re-run).`);
          return { ok: true, stopped: "workday-soft-error", needs_operator: true, detail: "Workday kept showing 'Something went wrong — please refresh' after reloads.", pages_replayed: pagesReplayed.length, pages: pagesReplayed };
        }
        softReloads++;
        LOG(`⚠ Workday soft-error at replay page ${page} ("Something went wrong / please refresh") — reloading + restarting the replay from page 1 (soft-reload ${softReloads}/${MAX_REPLAY_SOFT_RELOADS}).`);
        await reloadAndSettle(LOG);
        continue restartWalk;
      }
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
          // SETTLE FIRST — the scrape used to run the instant we arrived, which on a HIDDEN tab read the
          // summary half-drawn (see awaitReviewPageSettled). The settle returns the snapshot it settled on.
          const settled = await awaitReviewPageSettled(act, hints);
          LOG(`review page settled in ${settled.ms}ms — ${settled.records} displayed value(s).`);
          const dump = settled.dump;
          if (dump && dump.ok && Array.isArray(dump.items)) {
            const rec = reconcileReviewPage(dump.items, bundle.entries, { accountEmails: await getAccountEmails() });
            const c = rec.counts;
            reviewDiff.disagree = rec.disagree || [];
            reviewDiff.missing = rec.missing_on_review || [];
            LOG(`review page vs approved: AGREE ${c.agree} · DISAGREE ${c.disagree} · MISSING ${c.missing_on_review} · EXTRA ${c.extra_on_review} · AMBIGUOUS ${c.ambiguous} (of ${c.claimed} value-bearing entries).`);
            rec.disagree.forEach((d) => LOG(`    ≠ "${d.label || d.canonical_field || d.field_id}": approved "${d.value_bundle}" but the page shows "${d.value_review}"`));
            if ((rec.missing_on_review || []).length) LOG(`    (${rec.missing_on_review.length} approved value(s) are not SHOWN on the review page — informational, NOT blocking: Workday's summary doesn't render every field, and value-presence matching is heuristic. A value the page CONTRADICTS is what blocks.)`);
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

        // ── PHANTOM-DUPLICATE VERIFICATION (operator requirement: "when it eventually gets to the
        //    review page, make sure the websites are still there as if we did not delete it").
        //    We deleted visible rows to clear Workday's stale server-side duplicate; the premise is
        //    that Workday KEPT its own copy. That premise is now CHECKED against the page, not assumed.
        //    The values live in the approved bundle, so reconcileReviewPage above already compared them
        //    — a value that did not come back is in `missing`, which is a HARD gate blocker below. This
        //    block attributes it, so a blocked submit says WHY instead of citing an anonymous mismatch. ──
        const phantomLost = [];
        if (phantomDeleted.length) {
          const missingText = (reviewDiff.missing || []).map((m) => String(m.value_bundle || "").toLowerCase());
          for (const fix of phantomDeleted) {
            const gone = (fix.values || []).filter((v) => missingText.some((mv) => mv === String(v).toLowerCase()));
            if (gone.length) {
              phantomLost.push(...gone); // → a HARD gate blocker (a plain MISSING is not; see submitPrecondition)
              LOG(`⛔ the ${fix.kind} value(s) we deleted to clear Workday's phantom duplicate did NOT come back on the review page: ${gone.join(", ")}`);
              LOG(`   Workday did not retain its own copy, so submitting would file this application WITHOUT them. The gate blocks below — re-run the fill for this job, re-approve, and submit again.`);
            } else {
              LOG(`✓ phantom-duplicate check: all ${(fix.values || []).length} deleted ${fix.kind} value(s) are present on the review page (Workday kept its copy, as expected).`);
            }
          }
        }

        // ── M4 SUBMIT GATE — the ordered precondition check. Run it ALWAYS (even DRY) so the operator
        //    sees a blocker list; clickSubmit fires ONLY when authorize===true AND every check passes. ──
        let livePlaceholder = false;
        try { livePlaceholder = await cdpEval(() => ((document.body && document.body.innerText) || "").indexOf("[NEEDS YOUR ANSWER") !== -1); } catch (e) { /* ignore — bundle check still applies */ }
        const gate = submitPrecondition(bundle, nav, {
          mismatches: findings.mismatches, cascadeRevealed: findings.cascadeRevealed, livePlaceholder,
          reviewDisagree: reviewDiff.disagree, reviewMissing: reviewDiff.missing, phantomLost, reviewScrapeFailed: reviewDiff.scrapeFailed
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
        // FORCE TRUSTED for it, even hidden: this is the single action that cannot be undone, so it uses
        // the most proven mechanism rather than the fast one. Costs ~1.5s on a hidden tab for ONE click —
        // nothing, against the value of not wondering whether a synthetic click half-fired.
        cdpSetSyntheticInput(false);
        LOG(`✓ submit gate PASSED — clicking SUBMIT ONCE (authorized; trusted input, even if hidden).`);
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
      // SETTLE FIRST (2026-07-28) — the same wall-clock field-set wait the fill walk has always had.
      // Without it the replay scanned half-rendered pages, declared the unmounted fields absent, and
      // saved anyway; the extra fields then mounted and changed the page signature, which read as an
      // "advance", so the same physical page got processed twice.
      cdpSetTrustedText(false); // scope the self-ID override below to the ONE page that asks for it
      cdpSetSyntheticInput(true); // ditto for the CLICK override — restore the run-level mode each page
      const rSettleMs = await awaitFieldSetSettled(act);
      const scan = await cdpEval(cdpPageScan);
      LOG(`page ${page}: field set settled in ${rSettleMs}ms — ${((scan && scan.fields) || []).length} flat field(s) on the page.`);
      // ── SELF-ID INPUT POLICY, ON THE REPLAY TOO (2026-08-06) ──────────────────────────────────────
      // The per-KIND split (TRUSTED text/date, SYNTHETIC clicks) lived ONLY in fillAndPersistPage, which
      // the replay calls just for the REFILL case — so a normal replay of the Self Identify page wrote
      // text/date with the run-level mode, which for a submit run is SYNTHETIC: exactly the write this
      // surface is documented to ignore. That is the same "it lived inside fillAndPersistPage and the
      // replay never calls it" gap awaitFieldSetSettled had, and it fits the live symptom precisely —
      // Workday reporting Date required on a composite whose DOM AND React both hold the value, which is
      // the signature of a write that reached the page but not Workday's model.
      // Scoped by the unconditional reset at the TOP of every iteration (see above the settle), rather
      // than a try/finally around this ~700-line body — same guarantee, nothing restructured.
      if (isSelfIdPage((scan && scan.fields) || [])) {
        // ── TRUSTED for the WHOLE self-ID page on the replay, CLICKS INCLUDED (2026-08-07) ──────────
        // Text/date went trusted here on 2026-08-06; clicks were deliberately left synthetic on the
        // strength of a 2026-08-05 fill-path note ("the disability checkbox committed and held 2/2
        // under synthetic, whereas trusted clicks on it produce the intermittent did-not-commit").
        // The REPLAY evidence contradicts that, and it is the newer and more direct evidence:
        //
        //   analogdevices.wd1, page 5, every run — `page 5 replay: 5 field(s) — 3 changed,
        //   1 already-correct, 1 not-actuated, 0 FAILED` (our read-back says the box IS checked),
        //   then Save & Continue comes back `error text present — a real validation block`
        //   naming that very field as required. The synthetic click updated the DOM and React and
        //   NOT Workday's own form model — the exact mechanism the force-re-fill below already
        //   asserts in its success log, and which its FOLLOW-UP note proposed fixing right here.
        //
        // The force-re-fill then re-writes the SAME field with TRUSTED input and the page advances,
        // which is a direct, repeated demonstration that trusted clicks DO commit on this widget —
        // so the 2026-08-05 concern does not hold on this surface. Doing it up front costs one Save
        // cycle less per run and, on waystar.wd1, is the difference between replaying and halting:
        // there the synthetic click does not even update the DOM (`asked for [...] and it holds []`),
        // which fails the strict verify BEFORE any error text exists, so the force-re-fill — which is
        // driven off Workday's error text — can never be reached.
        //
        // Verification is unchanged: fillCheckboxGroupCdp still re-reads and requires exactly one box
        // on, and the force-re-fill remains as the net if a trusted click ever does flake.
        LOG(`page ${page}: SELF-ID page — forcing TRUSTED input for the replay, CLICKS INCLUDED (Workday's model ignores synthetic writes AND synthetic clicks on this surface).`);
        cdpSetTrustedText(true);
        cdpSetSyntheticInput(false);
      }
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
        // An EMPTY page is not a bundle-coverage problem (2026-07-27). No flat fields AND no repeating
        // sections means there is nothing on screen to match — a Workday hiccup, a page still
        // rendering, or an error shell — so blaming the approved bundle ("never captured this page")
        // sends the operator to re-review a bundle that is perfectly fine. Reload + restart while the
        // budget lasts; only then halt, and say honestly that the PAGE was empty.
        if (!liveNames.length && !liveSecs.length) {
          // NAME the page before deciding it's a hiccup (operator 2026-07-28: "each redirect, detect
          // which page you are on"). "No fields" is a SHAPE, and several very different pages share it —
          // already-applied, the My Applications list, a maintenance window. Reloading those is useless
          // and the halt would blame the wrong thing, so classify first and report it either way.
          let landed = null, kind = "unknown";
          try { landed = await cdpEval(cdpOnboardScan); kind = classifyWorkdayPage(landed); } catch (e) { /* fall through to the reload path */ }
          if (kind === "already-applied" || kind === "my-applications" || kind === "maintenance") {
            LOG(`⚠ replay page ${page} has no fields because the tab is on a "${kind}" page (${landed && landed.url}) — reloading would not change that. HALT.`);
            return { ok: true, stopped: "replay-landed-" + kind, page, landed_url: (landed && landed.url) || null, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
          }
          if (softReloads < MAX_REPLAY_SOFT_RELOADS) {
            softReloads++;
            LOG(`⚠ replay page ${page} is EMPTY (no fields, no repeating sections; page reads as "${kind}") — that's a Workday page problem, not a gap in the approved bundle. Reloading + restarting the replay from page 1 (reload ${softReloads}/${MAX_REPLAY_SOFT_RELOADS}).`);
            await reloadAndSettle(LOG);
            continue restartWalk;
          }
          LOG(`⚠ replay page ${page} is still EMPTY after ${softReloads} reload(s) — HALT. The approved bundle is fine; the PAGE never rendered (it reads as "${kind}"${landed && landed.url ? `, url=${landed.url}` : ""}). Open the tab and look.`);
          return { ok: true, stopped: "replay-page-empty", page, landed_kind: kind, pages_replayed: pagesReplayed.length, pages: pagesReplayed };
        }
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
        let flat = await replayFlatFields(act, sel.entries, present, DEFAULT_BUDGETS);

        // ── CASCADE RE-REPLAY (2026-07-27) — the fill walk's M1 cascade, on the replay side. ──
        // Committing a value can REVEAL the rest of the page: on Workday page 1 the address / region /
        // postal / phone fields mount only AFTER Country commits. So the field set captured before the
        // replay is not the final one, and entries that looked absent a moment ago may exist now. Live
        // evidence: after a soft-error reload, page 1 scanned as ONE field (`country`) and all 14 other
        // approved entries reported "no field named … on this page" — a false halt on a page that was
        // simply mid-cascade. Re-scan and replay whatever has since mounted, bounded.
        for (let round = 0; round < 2; round++) {
          const stillAbsent = flat.filter((r) => r.flag === "replay-field-absent").map((r) => r.field);
          if (!stillAbsent.length) break;
          await act.delayRender(DEFAULT_BUDGETS.taActionSettleMs); // let the reveal paint (adaptive; the rescan below is the real gate)
          let rescan = null;
          try { rescan = await cdpEval(cdpPageScan); } catch (e) { break; }
          const nowPresent = new Set(((rescan && rescan.fields) || []).map((f) => f.fieldName));
          const mounted = stillAbsent.filter((n) => nowPresent.has(n));
          if (!mounted.length) break;
          LOG(`page ${page}: ${mounted.length} field(s) appeared after the values already replayed (a cascade reveal) — replaying them now: ${mounted.join(", ")}`);
          const retry = sel.entries.filter((e) => mounted.includes(replayEntryFieldName(e)));
          const more = await replayFlatFields(act, retry, nowPresent, DEFAULT_BUDGETS);
          flat = flat.filter((r) => !mounted.includes(r.field)).concat(more); // real verdicts replace the absent ones
        }
        const rep = await replayRepeatingSections(act, sel.entries, DEFAULT_BUDGETS);
        const results = flat.concat(rep);
        pageResults = results; // visible to the nav-timeout branch below (the phantom-duplicate fix reads this page's rows)

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
        // SKIPPED was invisible: it counts as neither changed, kept, nor failed, so a page could report
        // "4 field(s) — 1 changed, 1 already-correct, 0 FAILED" while 2 approved entries were quietly
        // left blank (live 2026-07-27 — the `cleared` branch, an approved value that is empty). Name them.
        const skipped = results.filter((r) => r.status === "skipped");
        if (skipped.length) {
          // `r.field || r.fieldName` — repeating-section records key the name differently, so the bare
          // r.field printed a literal "undefined" for them (live 2026-07-28). The whole value of this
          // line is NAMING what was left blank; falling back to the flag/detail beats printing nothing.
          const nameOf = (r) => r.field || r.fieldName || r.canonical_field || r.mappedPath || r.flag || "(unnamed record)";
          LOG(`page ${page}: ${skipped.length} approved entr${skipped.length === 1 ? "y was" : "ies were"} NOT actuated (left as-is): ${skipped.map((r) => `${nameOf(r)}${r.replay ? " (" + r.replay + ")" : ""}`).join(", ")}`);
        }
        // Absent fields get their own line: they are the ones whose approved value did NOT reach the
        // form, so they are exactly what the review-page equality check must vouch for before a submit.
        const absent = results.filter((r) => r.flag === "replay-field-absent");
        if (absent.length) {
          LOG(`page ${page}: ${absent.length} approved value(s) had no field to fill on this page (${absent.map((r) => r.field).join(", ")}) — the review-page check verifies each one before any submit.`);
          // WHY they weren't there is NOT settled — candidates seen so far: the field mounted later, the
          // page renders prior answers as read-only text, or the wrapper carries a different
          // automation-id. So dump the page's ACTUAL formField ids, UNFILTERED (cdpPageScan.fields hides
          // fields inside repeating containers, which is why it can't answer this) plus whether each
          // missing wrapper is in the DOM at all. One eval, only when something is already wrong — this
          // is the recon, at the moment of failure, instead of a separate run on a page that has moved on.
          try {
            const dump = await cdpEval(function (names) {
              const all = Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'))
                .map((w) => (w.getAttribute("data-automation-id") || "").slice("formField-".length));
              const probe = {};
              for (const n of names) probe[n] = !!document.querySelector('[data-automation-id="formField-' + n + '"]');
              return { count: all.length, ids: all.slice(0, 40), probe,
                       bodyChars: ((document.body && document.body.innerText) || "").length, ready: document.readyState };
            }, absent.map((r) => r.field));
            if (dump) {
              LOG(`    page-4-style diagnostic — the page carries ${dump.count} formField wrapper(s) in total (readyState=${dump.ready}, ${dump.bodyChars} chars of text): [${(dump.ids || []).join(", ")}]`);
              LOG(`    wrapper present in the DOM? ${Object.keys(dump.probe || {}).map((k) => `${k}=${dump.probe[k] ? "YES" : "no"}`).join(" · ")}`);
            }
          } catch (e) { LOG(`    (absent-field diagnostic failed: ${String((e && e.message) || e)})`); }
        }
        pagesReplayed.push({ page, matched_key: sel.pageKey, total: results.length, changed, kept, failed: failed.length });
        LOG(`page ${page} replay: ${results.length} field(s) — ${changed} changed, ${kept} already-correct, ${skipped.length} not-actuated, ${failed.length} FAILED.`);

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

      // ── PRE-SAVE RE-VERIFY (2026-07-28): did every approved value STICK? ──
      // The fill walk has the M40 post-settle audit for the "filled, verified, then lost it" class; the
      // replay had none, so it clicked Save & Continue on a page it believed was complete. Live: the
      // disability checkbox group was replayed AND verified checked, then came up empty at Save
      // ("the checkbox at the end first clicked, but then something happened and it got unclicked").
      // ONE fresh scan, then re-replay only what actually went blank — cheap, and it turns a
      // confusing validation error into a self-healing retry.
      try {
        const preScan = await cdpEval(cdpPageScan);
        const lost = requiredBlankOnPage((preScan && preScan.fields) || [], sel.entries);
        if (lost.length) {
          LOG(`page ${page}: ${lost.length} REQUIRED field(s) were filled+verified but read BLANK now — re-filling before Save & Continue: ${lost.map((l) => `"${l.field.label || l.field.fieldName}" (approved "${l.approved}")`).join(", ")}`);
          const again = await replayFlatFields(act, lost.map((l) => l.entry), new Set(lost.map((l) => l.field.fieldName)), DEFAULT_BUDGETS);
          const stillBad = again.filter((r) => r.status === "needs_review" || r.status === "error");
          if (stillBad.length) LOG(`   ⚠ ${stillBad.length} did not take on the retry (${stillBad.map((r) => r.field).join(", ")}) — Save & Continue will surface it as a validation error.`);
          else LOG(`   ✓ re-filled; the page holds the approved values again.`);
        }
      } catch (e) {
        LOG(`(pre-save re-verify skipped: ${String((e && e.message) || e)})`);
      }

      // ── Guarded advance (clickPageNext independently refuses on the review marker — 2nd guard). ──
      const navAfter = await cdpEval(cdpReadSessionState);
      // A soft-error surfacing DURING the replay (no form → no next button) must reload+restart, not be
      // misread as a terminal page — same guard, same reason, as the fill walk's post-fill spot.
      if (navAfter && navAfter.softErrorPresent && softReloads < MAX_REPLAY_SOFT_RELOADS) {
        softReloads++;
        LOG(`⚠ Workday soft-error after replaying page ${page} ("Something went wrong / please refresh") — reloading + restarting the replay from page 1 (soft-reload ${softReloads}/${MAX_REPLAY_SOFT_RELOADS}).`);
        await reloadAndSettle(LOG);
        continue restartWalk;
      }
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
        let samples = [];
        try {
          const st = await cdpEval(cdpReadSessionState);
          samples = expandErrorSamples((st && st.errorMarkers && st.errorMarkers.samples) || []);
          if (samples.length) { LOG(`page errors (${samples.length}):`); samples.forEach((s) => LOG("    • " + s)); }
          // Dump the decisive per-field state BEFORE any remediation tier touches the page, so the log
          // shows the failure as it actually was (2026-07-28 round 2 — the blur fix didn't clear it and a
          // third guess isn't worth making). Read-only.
          if (samples.length) await diagnoseRequiredErrorFields(samples, LOG);
          diag = { page_errors: samples, error_page_text: st ? (st.errorPageText || null) : null };
          lastDiag = diag; // refill stamps this onto walk_status → the website review page shows WHY it stopped
        } catch (e) { /* ignore */ }

        // ── Workday PHANTOM duplicate-entry error (DETERMINISTIC, no AI — the ONE remediation the
        //    replay does). Its backend appended instead of replacing, so it rejects a page whose rows
        //    are visibly unique. Clear the visible rows and re-advance; Workday's own retained copy
        //    keeps the values, and the review page is checked for them before any submit. Bounded per
        //    RUN — a duplicate error that survives the fix is a real problem, not something to retry. ──
        // ── SIGNATURE DATE: stamp TODAY only because Workday ASKED (operator, 2026-08-08) ────────────
        // The replay follows the review page, so it never writes a date the human did not approve. The
        // one exception is this error, and it is REACTIVE by design:
        //
        //   Error-Date  "Enter today's date"
        //
        // The proactive version of this (re-deriving a signature date to today on every replay) is what
        // this replaces: it wrote onto a date the human had left BLANK, and on the Self Identify page
        // that write CASCADES — Name and the disability group become required — so the rehearse halted
        // on two questions the human never saw, entirely because of our own unapproved write.
        // Here the value is only ever written after Workday demands it, it can only ever be today, and
        // the page is re-Saved once. Bounded per RUN.
        if (dateStamps < 2 && samples.some((t) => /enter\s+today'?s\s+date/i.test(String(t)))) {
          const today = (() => { const t = new Date(); return { month: String(t.getMonth() + 1), day: String(t.getDate()), year: String(t.getFullYear()) }; })();
          let stamped = null;
          try {
            const fscan = await cdpEval(cdpPageScan);
            const df = ((fscan && fscan.fields) || []).find((f) => (f.widgetType === "date" || f.widgetType === "text")
              && apMatch.isSignatureDateQuestion(f.label));
            if (df) {
              const loc = { wrapperSel: df.wrapperSel };
              const r = df.widgetType === "date"
                ? await fillDateCompositeCdp(act, loc, today, DEFAULT_BUDGETS)
                : await fillTextCdp(act, loc, `${today.month}/${today.day}/${today.year}`, DEFAULT_BUDGETS, "input");
              if (r && (r.status === "filled")) stamped = { field: df.fieldName, label: df.label, value: r.after };
            }
          } catch (e) { LOG(`  (signature-date stamp failed to run: ${String((e && e.message) || e).slice(0, 90)})`); }
          if (stamped) {
            dateStamps++;
            LOG(`page ${page}: Workday asked for TODAY'S DATE — stamped "${stamped.label}" = ${stamped.value} (the ONLY value the replay may write that the review page did not approve) and re-saving.`);
            const sigD = cdpPageSig(await cdpEval(cdpPageScan));
            await cdpWakePage();
            const clickD = await act.clickPageNext();
            LOG(`page ${page} Save & Continue (after stamping today's date):`, JSON.stringify(clickD));
            if (clickD.clicked) {
              const resD = await cdpWaitNextPage(sigD);
              if (resD.maintenance) { LOG(`⛔ WORKDAY MAINTENANCE after the date stamp on page ${page}.`); return { ok: true, stopped: "workday-maintenance", workday_maintenance: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
              if (resD.sessionDead) { LOG(`⚠⚠ SESSION EXPIRED after the date stamp on page ${page}.`); return { ok: true, stopped: "session-expired", session_expired: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
              if (!resD.timeout) { LOG(`✓ page ${page} → advanced after stamping today's date.`); continue; }
            }
            LOG(`⚠ page ${page}: still blocked after stamping today's date — the date was not the only problem.`);
          } else {
            LOG(`  (Workday asked for today's date but no signature-date field was found on this page — not guessing which field it meant.)`);
          }
        }
        if (dupFixes < 2 && duplicateErrorSection(samples)) {
          const fix = await clearPhantomDuplicates(act, pageResults, samples, LOG);
          if (fix.ran && fix.deleted > 0) {
            dupFixes++;
            phantomDeleted.push(fix);
            const sig2 = cdpPageSig(await cdpEval(cdpPageScan));
            await cdpWakePage();
            const click2 = await act.clickPageNext();
            LOG(`page ${page} Save & Continue (after clearing the phantom duplicate):`, JSON.stringify(click2));
            if (click2.clicked) {
              const res2 = await cdpWaitNextPage(sig2);
              if (res2.maintenance) { LOG(`⛔ WORKDAY MAINTENANCE after the duplicate fix on page ${page}.`); return { ok: true, stopped: "workday-maintenance", workday_maintenance: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
              if (res2.sessionDead) { LOG(`⚠⚠ SESSION EXPIRED after the duplicate fix on page ${page}.`); return { ok: true, stopped: "session-expired", session_expired: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
              if (!res2.timeout) { LOG(`✓ page ${page} → advanced after clearing Workday's phantom duplicate ${fix.kind} rows.`); continue; }
            }
            LOG(`⚠ page ${page}: still blocked after clearing the phantom duplicate ${fix.kind} rows — falling through to the halt below.`);
          }
        }
        // ── THE FIX: re-write the error-named fields with TRUSTED INPUT (2026-07-28, LIVE-VERIFIED) ────
        // Workday reports a required field as empty on a page where everything is visibly filled. The
        // [FIELD-DIAG] dump nailed it down: the DOM holds the values, REACT's own props/fiber hold them for
        // every date segment, Workday's OWN widget renders "current value is 7/29/2026" — and it still
        // reports the field empty, with aria-invalid="true" and an inline per-field error. So the value is
        // present in every layer we can read, and missing only from WORKDAY'S OWN FORM MODEL, the layer
        // above React that we cannot inspect.
        //
        // That failure mode was ALREADY DOCUMENTED in this codebase — for the auth form, at
        // cdpSetSyntheticInput: *"the auth app likely doesn't register native-setter values in its own
        // state, leaving the submit inert."* Synthetic input writes via the native setter; React's input
        // state updates (visibly), but an app tracking its own model off real key/input events never hears
        // about it. The operator's evidence lines up exactly: this only happens on HIDDEN runs, and hidden
        // runs are the ONLY ones using synthetic input — a VISIBLE run of this page has never shown it.
        //
        // LIVE-VERIFIED FIX (solarturbines page 5): re-writing `name` + `dateSignedOn` with TRUSTED input
        // advanced the page immediately, and the run went on to reach review AGREE 53 · DISAGREE 0 and pass
        // the submit gate. The log line below states the confirmed mechanism so a future reader doesn't
        // have to re-derive it. Two things had to be true for this to work, and both are load-bearing:
        // trusted input (the native-setter write is what Workday misses) and skipIfCorrect:false (the box
        // already reads correct, so the default minimal-diff replay skips it — that skip made the first
        // attempt at this a silent no-op).
        //
        // FOLLOW-UP worth considering: force trusted input for these field types (or this whole page) so
        // the retry isn't needed at all. Left as a retry deliberately — it costs one extra Save cycle and
        // keeps the hidden-tab speed win everywhere else.
        //
        // So the retry does what a visible run does: FORCE TRUSTED INPUT for the re-write, with
        // skipIfCorrect:false so it actually re-types instead of skipping an already-correct box (that
        // skip is why round 2's attempt was a silent no-op). Deterministic, approved values only, per-field
        // verify unchanged, bounded per RUN — worst case it changes nothing and we halt as before.
        // It is also DECISIVE: if the page advances here, the synthetic path is confirmed as the cause.
        if (forcedRefills < 2) {
          const titles = samples.map((t) => parseErrorFieldName(t)).filter(Boolean);
          let named = new Set();
          try {
            const fscan = await cdpEval(cdpPageScan);
            for (const title of titles) {
              const want = errorLabelKey(title);   // colon-tolerant — see errorLabelKey (lib.js)
              const hit = ((fscan && fscan.fields) || []).find((f) => errorLabelKey((f && f.label) || "") === want)
                || ((fscan && fscan.fields) || []).find((f) => errorLabelKey((f && f.fieldName) || "") === want);
              if (hit) named.add(hit.fieldName);
            }
          } catch (e) { /* no scan → nothing to force */ }
          const toForce = (sel.entries || []).filter((e) => named.has(replayEntryFieldName(e)));
          if (toForce.length) {
            forcedRefills++;
            const wasSynth = cdpSyntheticInputEnabled();
            const vis = await cdpVisible();
            LOG(`page ${page}: FORCE-re-filling ${toForce.length} error-named field(s) [${[...named].join(", ")}] with skip-if-correct OFF and TRUSTED input`
              + ` (tab ${vis ? "VISIBLE" : "HIDDEN"}; synthetic was ${wasSynth ? "ON" : "OFF"}) — a real clear+type through the same path a visible run uses.`);
            let forced = [];
            try {
              cdpSetSyntheticInput(false); // trusted Input.* for this re-write — see the block comment
              forced = await replayFlatFields(act, toForce, named, Object.assign({}, DEFAULT_BUDGETS, { skipIfCorrect: false }));
            } finally {
              cdpSetSyntheticInput(wasSynth); // restore, so the rest of the walk keeps its hidden-tab speed
            }
            const bad = forced.filter((r) => r.status === "needs_review" || r.status === "error");
            forced.forEach((r) => LOG(`    • ${r.field || r.fieldName}: ${r.status}${r.after != null ? ` → ${JSON.stringify(String(r.after))}` : ""}${r.detail ? ` — ${r.detail}` : ""}`));
            if (forced.some((r) => r.flag === "replay-already-correct")) {
              LOG("   ⚠ a field still reported 'already correct — no actuation' despite skipIfCorrect:false — the forced re-write did NOT happen (check replayField's skip gate).");
            }
            if (bad.length) LOG(`   ⚠ ${bad.length} did not take on the forced re-fill — Save & Continue will surface it again.`);
            const sig4 = cdpPageSig(await cdpEval(cdpPageScan));
            await cdpWakePage();
            const click4 = await act.clickPageNext();
            LOG(`page ${page} Save & Continue (after the forced re-fill):`, JSON.stringify(click4));
            if (click4.clicked) {
              const res4 = await cdpWaitNextPage(sig4);
              if (res4.maintenance) { LOG(`⛔ WORKDAY MAINTENANCE after the forced re-fill on page ${page}.`); return { ok: true, stopped: "workday-maintenance", workday_maintenance: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
              if (res4.sessionDead) { LOG(`⚠⚠ SESSION EXPIRED after the forced re-fill on page ${page}.`); return { ok: true, stopped: "session-expired", session_expired: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
              if (!res4.timeout) {
                LOG(`✓ page ${page} → advanced after re-writing ${[...named].join(", ")} with TRUSTED input.`);
                LOG(`   ⇒ MECHANISM CONFIRMED: the synthetic (native-setter) write updated the DOM and React but NOT Workday's own form model — the same thing that leaves the auth form's Sign In inert. Consider forcing trusted input for these field types (or this page) instead of paying for the retry.`);
                continue;
              }
            }
            LOG(`⚠ page ${page}: still blocked even after a TRUSTED re-write of ${[...named].join(", ")} — unexpected (this is the LIVE-VERIFIED remedy for this symptom). Read the [FIELD-DIAG] dump above.`);
          } else if (titles.length) {
            LOG(`  (force-re-fill: the approved bundle has no entry for [${titles.join(", ")}] on this page — nothing to re-write.)`);
          }
        }
        // ── FALLBACK: the focus→blur commit nudge (2026-07-28 round 1) ────────────────────────────────
        // DEMOTED to run only after the trusted re-write above (round 3). It was the original fix for this
        // symptom and it has now failed LIVE TWICE — real focus + change + blur on every input of both
        // fields, then Save, still blocked — so it is kept only for the case the re-write above could not
        // run at all (no approved bundle entry for the named field), and because it is nearly free. It runs
        // AFTER, not before, because every failed Save costs a full nav-timeout and there is no longer any
        // reason to spend one on this first. Evidence-gated as before: it fires only when every error-named
        // field is on the page AND holds a value, so a genuinely empty required field still falls through
        // to the halt below.
        if (phantomNudges < 2) {
          const nudge = await nudgePhantomRequired(act, samples, LOG);
          if (nudge.ran) {
            phantomNudges++;
            const sig3 = cdpPageSig(await cdpEval(cdpPageScan));
            await cdpWakePage();
            const click3 = await act.clickPageNext();
            LOG(`page ${page} Save & Continue (after committing ${nudge.fields.join(", ")}):`, JSON.stringify(click3));
            if (click3.clicked) {
              const res3 = await cdpWaitNextPage(sig3);
              if (res3.maintenance) { LOG(`⛔ WORKDAY MAINTENANCE after the phantom-required fix on page ${page}.`); return { ok: true, stopped: "workday-maintenance", workday_maintenance: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
              if (res3.sessionDead) { LOG(`⚠⚠ SESSION EXPIRED after the phantom-required fix on page ${page}.`); return { ok: true, stopped: "session-expired", session_expired: true, pages_replayed: pagesReplayed.length, pages: pagesReplayed }; }
              if (!res3.timeout) { LOG(`✓ page ${page} → advanced after committing ${nudge.fields.join(", ")} — Workday had the values all along; it just never saw the edit finish.`); continue; }
            }
            LOG(`⚠ page ${page}: still blocked after the focus→blur commit — as expected (this has failed live twice); the trusted re-write above is the load-bearing remedy.`);
          } else {
            LOG(`  (phantom-required check: not applicable — ${nudge.reason})`);
          }
        }
        // ── ⛔ DO NOT re-add a RELOAD-based re-entry here — LIVE-REFUTED 2026-08-05 ───────────────────
        // The reasoning was sound and the result was negative, so it is recorded rather than retried.
        // Every in-page fix above tries to make Workday notice a value that is ALREADY there, which the
        // trace says is unwinnable: on waystar's Self Identify page the DOM value, React props AND React
        // fiber all read 8/5/2026 with ariaInvalid null while Workday insisted "The field Date is required
        // and must have a value". Its form MODEL — not the DOM, not React — lost the answer.
        //
        // So a reload + replay-from-page-1 was tried, on the theory that re-entry rebuilds the model. It
        // does not. Measured: page 5 reached 3x in one run, the phantom fired 2x, and BOTH re-entries came
        // back to the identical error. What the attempt did prove is that the return trip is cheap —
        // page 1 replayed "15 field(s) — 0 changed, 13 already-correct" — so skip-if-correct does behave
        // as the operator described; it is the REMEDY that is wrong, not the cost.
        //
        // So the remedy is NOT a reload: step BACK one page, confirm Workday's leave-page dialog, then
        // Save & Continue FORWARD — Workday re-POSTs the previous page and re-DERIVES this page's model
        // rather than restoring the same broken one. That is the operator's own manual fix, and it is the
        // only one not yet refuted. See docs/dom-patterns.md 2026-08-05.
        //
        // On the way back the page is re-replayed by the normal loop, and skip-if-correct means only the
        // field(s) that did not latch get re-written (measured: 13 of 15 already-correct on a re-entry).
        // If this ALSO fails, the conclusion is forced and worth stating: the navigation is then proven
        // not to be the variable, so the fault is in HOW WE TYPE THE DATE — the digits never reach
        // Workday's backend — and the next investigation belongs in the date actuation, not here.
        // (The back-a-page RETREAT remedy was removed 2026-08-06. It was built for the self-ID date
        // phantom -- Workday calling a field required while the page plainly held it -- and never fired
        // once. That symptom had a different cause, found later: the REPLAY walk wrote text/date
        // SYNTHETICALLY because the self-ID input policy lived in fillAndPersistPage, which the replay
        // never calls. Fixing that got waystar to SUBMIT GATE PASSED, so the retreat was a remedy for an
        // already-solved problem. If a genuine model-lost-the-value case reappears, note the operator's
        // rule: Workday can rarely REMOVE a committed value but never rewrites one into a different
        // option -- so a CHANGED value is ours; only a MISSING one warrants this class of remedy.)
        // ── CASCADE-REVEALED REQUIRED FIELDS → back to REVIEW, not a blind halt (2026-07-27). ──
        // A field the form has since made REQUIRED, which the approved bundle can't answer (absent, or
        // present-but-BLANK because it was optional at fill time), is a question for the human — so
        // capture it into the bundle, push it to the website, and say exactly what needs approving.
        try {
          const freshScan = await cdpEval(cdpPageScan);
          const liveFields = (freshScan && freshScan.fields) || [];
          const titles = samples.map((t) => parseErrorFieldName(t)).filter(Boolean);
          const gaps = newlyRequiredGaps(liveFields, bundle.entries, sel.pageKey, titles);
          if (gaps.length) {
            const pageKey = sel.pageKey || (freshScan ? cdpPageKey(freshScan) : null);
            const added = [];
            for (let gi = 0; gi < gaps.length; gi++) {
              const fresh = cascadeEntryFor(gaps[gi], pageKey, page, bundle.entries.length + gi);
              const at = bundle.entries.findIndex((e) => e.field_id === fresh.field_id);
              if (at >= 0) bundle.entries[at] = Object.assign({}, bundle.entries[at], fresh); // upgrade the blank entry in place
              else bundle.entries.push(fresh);
              added.push(fresh);
            }
            bundle.needs_review_count = bundle.entries.filter((e) => e.needs_review && !e.is_deleted).length;
            if (bundle.approval) bundle.approval.submit_ready = false; // stale roll-up must not read ready
            await new Promise((r) => chrome.storage.local.set({ reviewSummary: bundle }, r));
            // Do NOT pass chrome.storage.local.jobContext here. It is a per-USER slot, not per-job: nothing
            // in this file writes it back (a Run builds its own local jobContext from the JD scrape and
            // passes it down), so storage only ever holds what the WEBSITE synced from
            // profiles.job_context_json — a value with no relationship to the job being submitted. Writing
            // it onto this row would stamp some unrelated company on the application, and a plausible
            // WRONG value is worse than a blank one: a gap is visible and self-correcting, a wrong company
            // reads as fact. Pass null so reportApplication falls back to `bundle.tenant`, captured from
            // THIS application's own fill.
            await reportApplication(bundle, null); // → the website review page, so the operator can answer them
            LOG(`⚠ page ${page}: ${added.length} field(s) the form now REQUIRES have no approved answer — sent back to REVIEW (they are on the website now; answer them and re-run):`);
            added.forEach((e) => LOG(`    • "${e.question_label}" [${e.widget_type}]${e.options && e.options.length ? ` — options: ${e.options.map((o) => o.text).slice(0, 6).join(" | ")}` : ""} — ${e.detail}`));
            return {
              ok: true, stopped: "replay-needs-approval", nav_timeout_page: page,
              newly_required: added.map((e) => e.question_label),
              pages_replayed: pagesReplayed.length, pages: pagesReplayed, ...diag,
            };
          }
        } catch (e) {
          LOG(`(could not capture newly-required fields: ${String((e && e.message) || e)} — falling through to the plain halt.)`);
        }
        // QUOTE the page, don't diagnose it. This line used to assert "a required field is empty" for
        // EVERY non-advancing page, and live that was simply untrue: the page said "32312 is not a valid
        // postal code for Georgia" — a consistency check between two FILLED fields, nothing empty
        // anywhere. Sending the operator to hunt for a blank field when the page already named the real
        // problem wastes their time, and the same over-confident phrasing is what made the sign-in stall
        // read as a Chrome breach dialog (2026-08-02). Workday's own error text is the better answer.
        const errSay = reclick.errorsPresent && Array.isArray(reclick.errorSamples) && reclick.errorSamples.length
          ? ` Workday says: ${reclick.errorSamples.slice(0, 3).map((t) => JSON.stringify(String(t).slice(0, 160))).join("; ")}`
          : " Workday showed no error text, so the block is not stated on the page — a required field left empty is the usual cause.";
        LOG(`⚠ page ${page} did NOT advance (nav-timeout${reclick.errorsPresent ? ", real error present" : ", re-click fallback exhausted"}).${errSay} HALT — eyeball the page, re-review/approve, then re-run. (No blind AI remediation on replay.)`);
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
    // Carry the error TEXT out, not just the boolean — the caller's halt message quotes it rather than
    // guessing at a cause (2026-08-02: it used to say "a required field is empty" for a postal-code
    // mismatch between two filled fields).
    if (samples.length || (st && st.errorPageText)) { LOG(`  re-click fallback: error text present — NOT re-clicking (a real validation block, not a swallowed click).`); return { advanced: false, errorsPresent: true, errorSamples: samples.length ? samples : [st && st.errorPageText].filter(Boolean) }; }
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
// ADAPTIVE poll interval (2026-07-25 speed round): the old fixed 500ms cdpDelay paid up to ~1s of
// discretization per page transition (detection + the two-read steady confirm). Every exit condition
// here is a STATE check (session-dead / maintenance / sig-changed / hydrated-steady), so a shorter
// beat only re-polls sooner — and fillAndPersistPage's own pre-fill settle (the wall-clock no-growth
// window) still guards progressive field mounting after we return. Hidden+throttled (no worker
// timers) keeps the full 500ms beat, byte-identical to the proven slow path.
async function cdpWaitNextPage(prevSig, timeoutMs = 15000, intervalMs = 500) {
  const start = Date.now();
  let steady = -1, errSince = 0;
  while (Date.now() - start < timeoutMs) {
    await cdpAdaptiveDelay(intervalMs);
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
      // advanced path below fires instead). The transient-flicker guard is WALL-CLOCK (errors must
      // persist ≥600ms before we conclude) — was "two consecutive reads", which at the old fixed
      // 500ms beat meant ~1s; the adaptive beat would have collapsed it to ~100ms, too weak against
      // a flicker during a real transition. sessionLooksDead is checked first.
      // Count EXPANDED errors, not raw markers: the raw count includes [role=alert] SUCCESS toasts
      // ("resume successfully uploaded"), which persist through a slow clean transition — a toast-only
      // page must never fast-exit as a validation error (2026-07-02).
      const errCount = state ? expandErrorSamples((state.errorMarkers && state.errorMarkers.samples) || []).length : 0;
      if (errCount > 0) {
        if (!errSince) errSince = Date.now();
        if (Date.now() - errSince >= 600) return { advanced: false, timeout: true, errorDetected: true, errors: (state.errorMarkers.samples || []) };
      } else errSince = 0;
      continue;
    }
    errSince = 0;
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
    // Same per-field diagnostic the replay walk dumps (2026-07-28 round 2) — the fill walk runs the same
    // synthetic path on a hidden tab, so it is exposed to whatever this turns out to be. Read-only.
    if (samples.length) await diagnoseRequiredErrorFields(samples, LOG);
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
    // An EXTERNAL GATE (e.g. "you must complete the assessment test") is not a fill problem, so the
    // empty-field list must NOT be offered as its cause — live on copart the halt blamed
    // `employeeId — no mapping` for an assessment requirement. Still list them (a real gap is worth
    // knowing) but drop the causal claim.
    const gate = externalGateHalt(samples, st ? st.errorPageText : null);
    const empties = (pageOut && pageOut.results || []).filter((r) => r.status === "skipped");
    if (empties.length) {
      LOG(gate
        ? "fields left EMPTY (listed for completeness — NOT the cause here; the page is gated externally):"
        : "fields left EMPTY (no value in the profile/JSON — the likely validation cause):");
      empties.forEach((r) => LOG(`    • ${r.fieldName} — ${r.detail}`));
    }
    lastDiag = { page_errors: samples, error_page_text: st ? (st.errorPageText || null) : null, empty_fields: empties.map((r) => ({ field: r.fieldName, reason: r.detail })), external_gate: gate || null };
    return lastDiag;
  };

  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab?)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    await cdpInstallPageOverrides(); // hidden-tab SPA-transition unblock (rAF→setTimeout): so page-to-page advancement runs while backgrounded
    cdpSetSyntheticInput(true); // FILL entry point — hidden actuation dispatches page-side (the proven form-page repertoire); onboarding/auth ran trusted on its own attach
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
    let softReloads = 0; const MAX_SOFT_RELOADS = 3; // RUN-level budget for Workday's "Something went wrong / please refresh" soft-error

    restartWalk: while (true) { // a transient-flake reload restarts here from page 1 (the bundle clear stays ABOVE, once per run)
    pagesFilled = []; // reset per attempt
    for (let page = 1; page <= WALK_MAX_PAGES; page++) {
      walkPage = page;
      // ── (a/b) TOP-OF-ITERATION guards: session-death + the REVIEW terminal (SUBMIT-NEVER —
      // checked BEFORE any fill/click, so we never fill or advance the review page). ──
      let nav = null;
      try { nav = await cdpEval(cdpReadSessionState); } catch (e) { /* treat as not-ready below */ }
      // ── (a0) TRANSIENT SOFT-ERROR: Workday's "Something went wrong / please refresh" can appear on
      //    ANY page (right after login, or mid-walk). A refresh RESTARTS the application at page 1, so
      //    reload + restart the walk from page 1 (bounded per run); the already-filled sweep makes the
      //    good pages fast. Checked FIRST so the error page (no form) isn't misread as session-death or
      //    a terminal page. If the reload drops to the LOGIN page instead, the sessionLooksDead guard
      //    below catches it on the restart and halts session-expired. ──
      if (nav && nav.softErrorPresent) {
        if (softReloads >= MAX_SOFT_RELOADS) {
          LOG(`⚠ Workday soft-error ("Something went wrong / please refresh") persisted after ${softReloads} reload(s) — halting for the operator (refresh the page + re-run).`);
          return { ok: true, stopped: "workday-soft-error", needs_operator: true, detail: "Workday kept showing 'Something went wrong — please refresh' after reloads.", pages_filled: pagesFilled.length, pages: pagesFilled };
        }
        softReloads++;
        LOG(`⚠ Workday soft-error on page ${page} ("Something went wrong / please refresh") — reloading + restarting the walk from page 1 (soft-reload ${softReloads}/${MAX_SOFT_RELOADS}).`);
        await reloadAndSettle(LOG);
        continue restartWalk;
      }
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
        emitRunProgress("Reached the review page", "the application is filled — nothing submitted");
        return { ok: true, stopped: "reached-review", reached_review: true, pages_filled: pagesFilled.length, pages: pagesFilled };
      }

      // ── (c) Fill this (non-review) page: fold + inline M40 audit + accumulate. ──
      LOG(`──── PAGE ${page} ────`);
      emitRunProgress(`Filling page ${page}`);
      const { out, pageKey, bundle } = await fillAndPersistPage(act, prepared, defaults, jobContext, LOG, { pageNumber: page });
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
      // A soft-error surfacing during/after the fill (no form → no next button) must reload+restart,
      // not be misread as a terminal page — this is exactly the spot the reported bug stopped at.
      if (navAfter && navAfter.softErrorPresent && softReloads < MAX_SOFT_RELOADS) {
        softReloads++;
        LOG(`⚠ Workday soft-error after filling page ${page} ("Something went wrong / please refresh") — reloading + restarting the walk from page 1 (soft-reload ${softReloads}/${MAX_SOFT_RELOADS}).`);
        await reloadAndSettle(LOG);
        continue restartWalk;
      }
      if (!navAfter || !navAfter.nextButtonPresent) {
        LOG(`no Save & Continue on page ${page} — terminal page (not the review marker). Stop.`);
        return { ok: true, stopped: "no-next-button", pages_filled: pagesFilled.length, pages: pagesFilled };
      }

      // ── (d.1) PRE-SAVE RE-VERIFY: did every value we filled STICK? (2026-08-04) ──────────────────
      // Symmetry with the replay walk, which got exactly this in 2026-07-28 for the same class and the
      // same widget. The M40 audit is NOT a substitute: it runs inside the fill and REPORTS, but a field
      // it could not re-read (`audit-unverifiable`) still goes to Save & Continue unretried — reporting
      // a doubt is not the same as resolving it.
      //
      // Live on waystar.wd1 AND radiancetech.wd12, the same page 5, the same field: the disability
      // self-ID checkbox group was committed ("No, I do not have a disability…"), the audit could not
      // re-read the group (audit-unverifiable), and by Save time it held nothing — Workday refused with
      // "The field Please check one of the boxes below: is required and must have a value", AI-4 rightly
      // declined (no error text to anchor a safe action on), and the walk halted on a page it believed
      // complete. One fresh scan turns that into a self-healing retry.
      //
      // Same helper, same blank/carve-out rules as the replay walk, so the two agree. Re-fills ONLY what
      // actually reads blank, so a page where everything stuck costs one read-only scan.
      //
      // Kill-switch: `chrome.storage.local.skipPreSaveReverify` (same pattern as forceTrustedInput /
      // forceWorkerTimersOff). Set it to REPRODUCE the raw failure on demand — with the re-verify off,
      // the walk halts on the self-ID page instead of healing it, which parks a tab there for a DOM
      // trace. Without a knob the fix hides the very bug you want to look at.
      try {
        const { skipPreSaveReverify } = await new Promise((r) => chrome.storage.local.get("skipPreSaveReverify", r));
        if (skipPreSaveReverify) throw new Error("skipPreSaveReverify — DELIBERATELY OFF (reproduction mode)");
        const preSaveScan = await cdpEval(cdpPageScan);
        const lost = requiredBlankOnPage((preSaveScan && preSaveScan.fields) || [], (bundle && bundle.entries) || []);
        if (lost.length) {
          LOG(`page ${page}: ${lost.length} REQUIRED field(s) were filled but read BLANK now — re-filling before Save & Continue: ${lost.map((l) => `"${l.field.label || l.field.fieldName}" (filled "${l.approved}")`).join(", ")}`);
          const again = await replayFlatFields(act, lost.map((l) => l.entry), new Set(lost.map((l) => l.field.fieldName)), DEFAULT_BUDGETS);
          const stillBad = again.filter((r) => r.status === "needs_review" || r.status === "error");
          if (stillBad.length) LOG(`   ⚠ ${stillBad.length} did not take on the retry (${stillBad.map((r) => r.field || r.fieldName).join(", ")}) — Save & Continue will surface it as a validation error.`);
          else LOG(`   ✓ re-filled; the page holds the filled values again.`);
        }
        // The HOLE: requiredBlankOnPage only sees fields the scan reported, and a field the M40 audit
        // could not verify is very often one the scan could not see — which is how the disability self-ID
        // group walked straight past this guard. Probe the DOM for those directly (the scan filters
        // repeating containers, so its silence is not proof of absence) and re-fill what really is there.
        // A REMOUNTED question: the page shows it BLANK and REQUIRED under a NEW automation-id, while the
        // bundle holds the answer under the old one. Neither check above can see it — they key on the
        // bundle's id — so this was a guaranteed Save rejection (live on waystar page 3, repeatedly).
        // Match on the QUESTION and fill the id the page is using NOW.
        const remounted = requiredBlankByLabel((preSaveScan && preSaveScan.fields) || [], (bundle && bundle.entries) || []);
        if (remounted.length) {
          LOG(`page ${page}: ${remounted.length} REQUIRED field(s) came back under a NEW automation-id, blank — re-filling at the LIVE id before Save & Continue: ${remounted.map((m) => `"${m.field.label || m.field.fieldName}" (${m.fromName} → ${m.field.fieldName}, "${m.approved}")`).join(", ")}`);
          // Point the entry at the id that EXISTS, so the fill lands on the live widget, not the dead one.
          const retarget = remounted.map((m) => Object.assign({}, m.entry, { field_id: "formField-" + m.field.fieldName }));
          const rr = await replayFlatFields(act, retarget, new Set(remounted.map((m) => m.field.fieldName)), DEFAULT_BUDGETS);
          const bad = rr.filter((r) => r.status === "needs_review" || r.status === "error");
          if (bad.length) LOG(`   ⚠ ${bad.length} did not take (${bad.map((r) => r.field || r.fieldName).join(", ")}) — Save & Continue will surface it.`);
          else LOG(`   ✓ re-filled at the live id(s).`);
        }
        const absent = requiredEntriesAbsentFromScan((preSaveScan && preSaveScan.fields) || [], (bundle && bundle.entries) || []);
        if (absent.length) {
          const onPage = [];
          for (const a of absent) {
            const sel = deriveFlatWrapperSel(a.entry);
            let exists = false;
            try { exists = !!(sel && await act.selExists(sel)); } catch (e) { /* probe failed → treat as absent */ }
            (exists ? onPage : null) && onPage.push(a);
            if (!exists) LOG(`page ${page}: required "${a.name}" is in the bundle but NOT on the page (scan and DOM probe agree) — left alone, not fatal.`);
          }
          if (onPage.length) {
            LOG(`page ${page}: ${onPage.length} REQUIRED field(s) the scan never reported but the DOM HAS — re-filling: ${onPage.map((a) => `"${a.name}" (filled "${a.approved}")`).join(", ")}`);
            await replayFlatFields(act, onPage.map((a) => a.entry), new Set(onPage.map((a) => a.name)), DEFAULT_BUDGETS);
          }
        }
      } catch (e) {
        LOG(`(pre-save re-verify skipped: ${String((e && e.message) || e)})`);
      }

      // ── (d.2) A REQUIRED field we could not verify is NOT gambled on (2026-08-04) ──────────────────
      // The M40 audit already caught this class every time — both live disability failures were flagged
      // `audit-unverifiable`. The audit was never the gap: NOTHING acted on it. The only pre-Save guards
      // were the résumé upload, the soft-error check and "is there a next button", so a required field we
      // knew we could not verify still got a Save click, and Workday's rejection was what told us —
      // arriving as a nav-timeout that blamed an unrelated unmapped field on a now-dirty page.
      //
      // This cannot cost a passing run: the ONLY halt condition is required + present on the page + empty
      // + we hold an answer, which is exactly what Workday refuses anyway. It fails earlier, deliberately,
      // and says which field. A field that is genuinely ABSENT is reported and NOT fatal (the replay walk's
      // 2026-07-28 rule), and a field holding some other value is left to review + the submit gate.
      try {
        const finalScan = await cdpEval(cdpPageScan);
        // (i) we HAD an answer and the page lost it — requiredBlankOnPage's case.
        const stillLost = requiredBlankOnPage((finalScan && finalScan.fields) || [], (bundle && bundle.entries) || []);
        // (ii) we TRIED and produced nothing at all. Live run 8 of the armed loop: the disability group's
        // commit failed outright, so there was no value to put back, so (i) correctly skipped it ("nothing
        // approved to restore") — and the walk clicked Save and halted as a nav-timeout blaming an
        // unrelated unmapped field. Required-ness comes from the LIVE scan (authoritative) and "we tried
        // and got nothing" from our own record, so this cannot fire on a field we never attempted.
        const liveByName = new Map((((finalScan && finalScan.fields) || [])).map((f) => [f.fieldName, f]));
        const blank = (v) => v == null || String(v).trim() === "";
        const triedAndEmpty = ((out && out.results) || []).filter((r) => {
          if (!r || r.widgetType === "file_upload" || r.widgetType === "checkbox") return false; // own paths / stores "false"
          if (r.status !== "needs_review" && r.status !== "error") return false;
          if (!blank(r.after)) return false;                                    // it holds something → review owns it
          const live = liveByName.get(r.fieldName);
          return !!(live && live.isRequired === true && blank(live.value));
        }).filter((r) => !stillLost.some((l) => l.field.fieldName === r.fieldName)); // don't double-report
        if (triedAndEmpty.length && !stillLost.length) {
          LOG(`⚠ page ${page}: NOT clicking Save & Continue — ${triedAndEmpty.length} REQUIRED field(s) we TRIED to fill produced no value at all. Workday would refuse this page; halting here names the field instead of a nav-timeout that blames an unrelated one:`);
          triedAndEmpty.forEach((r) => LOG(`    • "${r.label || r.fieldName}" [${r.flag || r.status}] — ${r.detail || "no detail"}`));
          return { ok: true, stopped: "required-unfilled", nav_timeout_page: page,
            fields: triedAndEmpty.map((r) => ({ field: r.fieldName, label: r.label || null, flag: r.flag || null, detail: r.detail || null })),
            pages_filled: pagesFilled.length, pages: pagesFilled };
        }
        if (stillLost.length) {
          const flaggedBy = (n) => {
            const r = (out.results || []).find((x) => x.fieldName === n);
            return r && r.flag ? ` [${r.flag}]` : "";
          };
          LOG(`⚠ page ${page}: NOT clicking Save & Continue — ${stillLost.length} REQUIRED field(s) are on the page, hold NO value, and we do have an answer for them. Workday would refuse this page anyway; halting here says which field instead of leaving a dirty page and a nav-timeout:`);
          stillLost.forEach((l) => LOG(`    • "${l.field.label || l.field.fieldName}"${flaggedBy(l.field.fieldName)} — we filled "${l.approved}", the page shows nothing`));
          return { ok: true, stopped: "required-unverified", nav_timeout_page: page,
            fields: stillLost.map((l) => ({ field: l.field.fieldName, label: l.field.label || null, intended: l.approved, flag: (((out.results || []).find((x) => x.fieldName === l.field.fieldName) || {}).flag) || null })),
            pages_filled: pagesFilled.length, pages: pagesFilled };
        }
      } catch (e) {
        LOG(`(required-unverified check skipped: ${String((e && e.message) || e)})`);
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
        // The page kept our value out; say so in the bundle before halting, so review asks the human
        // for an answer the form accepts instead of showing one it already threw away.
        if (reclick.errorsPresent && Array.isArray(reclick.errorSamples)) await syncRejectedValues(reclick.errorSamples, LOG);
        // Read the diagnostics FIRST so an EXTERNAL GATE can be named before we accuse the fill.
        const diag = await reportPageErrors(out);
        if (diag && diag.external_gate) {
          // Not a fill failure and not a dirty page: our values were accepted, Workday wants a step
          // that happens outside the form. Halt self-explaining (needs_operator), per the standing
          // rule that every human-needed stop says so.
          LOG(`⚠ page ${page} is gated EXTERNALLY (${diag.external_gate.reason}) — the fill is not at fault and the page is NOT dirty. ${diag.external_gate.detail} Workday said: "${diag.external_gate.evidence}"`);
          return { ok: true, needs_operator: true, stopped: diag.external_gate.reason, nav_timeout_page: page,
            detail: diag.external_gate.detail, pages_filled: pagesFilled.length, pages: pagesFilled, ...diag };
        }
        LOG(`⚠ nav-timeout on page ${page} — ${act.aiEnabled ? `AI-4 remediation (${rem.attempts} attempt(s), ${rem.reason})` : "AI fill OFF (no re-fill — operator halt-on-error rule)"} ${reclick.errorsPresent ? "+ a real error blocks re-click" : "+ re-click fallback (" + (reclick.attempts || 0) + "x)"} did NOT clear it. PAGE ${page} MAY NOW BE DIRTY — eyeball it; do NOT re-run as if fresh. Errors + empty fields:`);
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
  // Prefer "Autofill with Resume" on the apply chooser (a FILL run). A REHEARSE/SUBMIT run leaves this
  // OFF so it applies manually / continues — that keeps the already-saved skills and stops Workday
  // re-parsing the résumé over them (operator, 2026-08-07).
  const preferResumeAutofill = !!o.preferResumeAutofill;
  let resumeAutofilled = false;
  // OPERATOR INPUT-LOCK ACROSS THE WHOLE LOGIN FLOW (operator, 2026-08-08). The fill walk has installed
  // the lock per page since M-input-lock, but onboarding — Apply → chooser → sign-in / create-account →
  // email verify → the résumé page — ran UNPROTECTED, which is the stretch where a stray keystroke does
  // the most damage: it lands in an email or password box, or dismisses the chooser. Every navigation
  // tears the overlay down, so it is re-installed after each settled transition (see relock). Removal is
  // guaranteed by the CALLERS, immediately after runCdpOnboard returns — the walk then re-installs per
  // page, and a stranded lock is the worst possible operator failure.
  const relock = async () => { try { await installInputLock(); } catch (e) { /* best-effort */ } };
  await relock();
  let accountCreated = false, verified = false, softReloads = 0;
  // Workday sometimes returns an EMPTY shell after the sign-in submit — recoverable by a reload
  // (see isBlankAuthPage). RUN-level budget: if refreshing twice doesn't restore a real page, it's
  // not a hiccup any more and the operator gets a self-explaining halt.
  let blankReloads = 0; const MAX_BLANK_RELOADS = 2;
  // "You've already applied" is sometimes a LIE (operator 2026-07-28) — see handleAlreadyApplied. The
  // recovery navigates the candidate's own applications list to find out. BOUNDED per run: it ends on the
  // application form, on a proven-submitted halt, or on an operator halt — never in a retry loop. The
  // budget is 2 because one attempt can legitimately be consumed by the list demanding a sign-in first
  // (that attempt hands back to the auth stage, which then re-lands here already signed in).
  let appliedRecoveries = 0; const MAX_APPLIED_RECOVERIES = 2;
  // Apply→auth is a bounded LOOP: a page that turns out to be the job-description page (rendered late, or
  // its header "Sign In" link mistaken for auth) sends us back to Stage 1 instead of halting. 2 is enough
  // for "the page finally rendered, click Apply" without letting a genuinely stuck page spin.
  let applyRounds = 0; const MAX_APPLY_ROUNDS = 2;

  // Adaptive pacing — mirrors the fill's act.delay: ~10× faster when the tab is VISIBLE (or its
  // worker-timers measure fast), FULL (throttle-safe) when hidden/backgrounded. Used for ALL
  // click/type/transition pacing here, so an onboarding run is snappy in the foreground yet safe
  // hidden (a throttled tab never gets raced). The ONE genuine server-commit wait — the 5s
  // post-activation settle — stays a fixed cdpDelay (it must be real wall-clock regardless of
  // visibility). Every pace() site is gated by a subsequent state check (read-back / poll / scan),
  // so a too-short fast wait can only cost a retry, never a silent wrong action.
  const pace = (ms) => cdpAdaptiveDelay(ms);

  // ── Page reads + their DIAGNOSTICS (operator ask 2026-07-27) ────────────────────────────────────
  // A read that FAILED (execution context destroyed mid-navigation, a detach, a page exception) is NOT
  // the same thing as "the element isn't there yet" — but both used to vanish into `null` and end as a
  // bare "waitFor(x) timed out", which is unactionable when the operator then looks at the tab and sees
  // a perfectly rendered page. Count both outcomes and keep the last error so a timeout can say WHICH
  // happened, and what the page actually looked like.
  let scanOk = 0, scanFail = 0, lastScanError = null;
  const scan = async () => {
    try {
      const s = await cdpEval(cdpOnboardScan);
      if (s) scanOk++; else scanFail++;
      return s;
    } catch (e) {
      scanFail++;
      lastScanError = String((e && e.message) || e);
      return null;
    }
  };

  // One-line dump of what the page ACTUALLY looked like at a decision point — the evidence needed to
  // diagnose an intermittent halt after the fact, without a reproduction.
  const describeState = (s) => {
    if (!s) return "NO readable page state (every scan failed — see the read counts above)";
    const on = Object.keys(s.markers || {}).filter((k) => s.markers[k]);
    return [
      `url=${s.url}`,
      `title=${JSON.stringify(s.title || "")}`,
      `readyState=${s.readyState || "?"}`,
      `formFields=${s.formFieldCount}`,
      `email=${!!s.emailInput}`,
      `password=${!!s.passwordInput}`,
      `signInWithEmail=${!!s.signInWithEmail}`,
      `signInButtonText=${!!s.signInButtonPresent}`,
      `hasAuthEl=${!!s.hasAuthEl}`,
      `markers=[${on.join(",") || "none"}]`,
      // The page's OWN stated reason, when it has one — turns "the form is still up" from a dead end
      // into something actionable (2026-08-07).
      ...((s.authErrors && s.authErrors.length) ? [`pageErrors=${JSON.stringify(s.authErrors)}`] : []),
    ].join(" · ");
  };

  // Every human-needed stop LOGS before it returns. These used to be silent returns, so the SW console
  // ended at "detached" and the reason existed only in the popup/website response.
  const haltNeedsOperator = (stopped, detail, s) => {
    LOG(`⛔ HALT (needs operator) — ${stopped}: ${detail}`);
    if (s !== undefined) LOG(`    page state at the halt: ${describeState(s)}`);
    return { ok: true, reached_form: false, needs_operator: true, stopped, detail };
  };

  // Render budgets scale with VISIBILITY. A hidden/backgrounded tab paints far slower — live on
  // Caterpillar wd5 the auth widget needed >20s after "Apply Manually" (that wait timed out at its full
  // 20s, then the very next scan saw the auth screen). A too-short budget here didn't just cost time: it
  // made the flow conclude the fields would never arrive and halt on a WRONG reason. Visible keeps the
  // tuned, live-verified fast values; hidden gets room to actually finish rendering.
  const renderBudget = async (visibleMs, hiddenMs) => ((await cdpVisible()) ? visibleMs : hiddenMs);
  const isPastAuth = (s) => !!s && (s.formFieldCount || 0) > 0 && !s.hasAuthEl && !onResumeUploadPage(s);

  // ── The résumé-upload page (Autofill with Resume) ────────────────────────────────────────────────
  // Traced 2026-08-07 on cat.wd5: "Autofill with Resume" lands on `/apply/autofillWithResume`, which
  // carries the upload input and only reaches My Information after the upload — so Workday parses the
  // résumé and pre-populates the application, INCLUDING the Skills section with its own suggestions.
  // It reports ONE bare `formField-` wrapper, which is why isPastAuth excludes it above: otherwise
  // onboarding would announce "reached the form" and hand the walk a page with no real fields.
  // The automation-ids are the ones attachResume already drives, so the upload itself is reused as-is.
  function onResumeUploadPage(s) {
    return !!(s && s.markers && s.markers.resumeUploadInput) && (s.formFieldCount || 0) <= 1;
  }
  // Upload the stored résumé (if it isn't already up) and click Continue. Returns {scan} on success or
  // {halt} with a self-explaining stop — never a bare false, since every failure here is operator-actionable.
  const consumeResumeUploadPage = async (s) => {
    let rec = null;
    try { rec = await getResume(); } catch (e) { /* treated as none */ }
    if (!rec || !rec.base64) {
      LOG("⛔ on Workday's résumé-upload page but NO résumé is stored — upload one on the website first.");
      return { halt: { ok: true, reached_form: false, needs_operator: true, stopped: "resume-missing-for-autofill",
        detail: "Autofill with Resume needs the stored résumé and none is saved in the extension." } };
    }
    if (s.markers && s.markers.resumeUploadSuccess) LOG("the résumé is already uploaded on this page — continuing.");
    else {
      LOG(`uploading the résumé for Workday's autofill parse (${rec.filename || "resume.pdf"})…`);
      const ar = await cdpAttachResumeConfirmed(rec, LOG);
      if (!ar || !ar.attached) {
        return { halt: { ok: true, reached_form: false, needs_operator: true, stopped: "resume-upload-failed",
          detail: "the résumé upload never confirmed on the Autofill page — " + ((ar && ar.detail) || "no detail") } };
      }
    }
    const c = await clickTarget(['[data-automation-id="pageFooterNextButton"]'], "Continue (after the résumé upload)");
    if (!c.clicked) {
      return { halt: { ok: true, reached_form: false, needs_operator: true, stopped: "resume-continue-blocked",
        detail: c.blockedBy || "Continue was not clickable on the résumé-upload page" } };
    }
    // Workday PARSES the résumé on this transition, so it is slower than an ordinary page advance.
    const w = await waitFor((sc) => (sc.formFieldCount || 0) > 1 || sc.hasAuthEl, await renderBudget(25000, 50000), "post-resume-upload(parse)");
    LOG(`résumé page done — Workday parsed it; the next page has ${(w.scan && w.scan.formFieldCount) || 0} field(s).`);
    return { scan: w.scan || s };
  };
  // "We are on the JOB-DESCRIPTION page, not an auth screen" (2026-07-29). `signInButtonPresent` is a TEXT
  // match over every clickable, and a Workday posting carries "Sign In" in its own HEADER — so a JD page
  // satisfied the Stage-3 auth condition, and doAuth then waited its full budget for credential fields that
  // were never coming (live: halted `auth-form-not-rendered` while the state showed `markers=[continueButton]`,
  // i.e. the very button Stage 1 wanted). An apply-chain marker is POSITIVE evidence and beats the
  // absence-based text match. Requires no credential field at all, so a real auth screen can never match.
  const onJobDescription = (s) =>
    !!s && !s.hasAuthEl && !s.passwordInput && !s.emailInput && !s.signInWithEmail
    && (s.formFieldCount || 0) === 0 && classifyWorkdayPage(s) === "job-description";
  // "You've already applied for this job." — a CLEAN terminal state (the operator already applied), not an
  // error. Halt gracefully so the Run reports "already applied" instead of stalling on a form that never
  // appears then halting `unknown-page`/`auth-unknown`. Checked at each stage the page can reveal it.
  const alreadyAppliedResult = () => {
    LOG("⛔ ALREADY APPLIED — Workday shows the \"You've already applied for this job\" page; nothing to fill. Halting cleanly.");
    return { ok: true, reached_form: false, already_applied: true, stopped: "already-applied", detail: "You've already applied for this job — Workday won't reopen the application, so there's nothing to fill." };
  };
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
      if (ready === "complete") { await pace(700); await relock(); return true; } // a fresh document has no overlay
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
  // `opts.allowAlreadyApplied` — suppress the already-applied TERMINAL exit below. Needed by exactly one
  // caller: the already-applied RECOVERY, which is navigating AWAY from that page. Without it the first
  // poll still sees the old page mid-navigation and the wait bails ~500ms in, before the click can land.
  const waitFor = async (pred, timeoutMs, label, opts) => {
    const allowAlreadyApplied = !!(opts && opts.allowAlreadyApplied);
    const start = Date.now();
    const ok0 = scanOk, fail0 = scanFail;
    let st = null, last = null; // `last` = the last SUCCESSFUL read (st can be null if the final read failed)
    while (Date.now() - start < timeoutMs) {
      await pace(500);
      await cdpWakePage();
      st = await scan();
      if (st) last = st;
      if (!st) continue;
      if (await maybeRefresh(st)) { st = await scan(); if (st) last = st; if (!st) continue; }
      if (pred(st)) { await relock(); return { matched: true, scan: st }; } // a matched wait = the page moved → the overlay was torn down with it
      // ── TERMINAL STATES: stop waiting for something that can NEVER arrive (audit, 2026-07-27). ──
      // Every predicate here waits for a page to BECOME something. On an already-applied page or a
      // maintenance page it never will, so each wait used to burn its full budget in turn — an
      // already-applied posting cost 20s (post-apply) + 45s (post-apply-manually) + 12s (auth-or-form)
      // before the flow noticed a state it detects instantly. Exit now; every caller's next step routes
      // these to their proper clean halts.
      if (isAlreadyApplied(st) && !allowAlreadyApplied) { LOG(`waitFor(${label}) stopping early — this posting is ALREADY APPLIED, so "${label}" can never render.`); return { matched: false, scan: st, terminal: "already-applied" }; }
      if (isWorkdayMaintenance(st)) { LOG(`waitFor(${label}) stopping early — Workday is in MAINTENANCE, so "${label}" can never render.`); return { matched: false, scan: st, terminal: "workday-maintenance" }; }
    }
    // SELF-DIAGNOSING TIMEOUT (operator ask 2026-07-27: "put a log so if it happens again we can be sure
    // what the issue is"). Three different failures used to print the same line: the page never rendered
    // the thing, every page READ failed, or the predicate is wrong for this tenant. Print the read
    // counts, the tab's real visibility (hidden ⇒ slow paint is the usual cause), and the last state.
    const reads = `${scanOk - ok0} read(s) OK / ${scanFail - fail0} failed${lastScanError ? ` — last read error: ${lastScanError}` : ""}`;
    let vis = "unknown";
    try { vis = (await cdpVisible()) ? "VISIBLE" : "HIDDEN"; } catch (e) { /* visibility is a nice-to-have */ }
    LOG(`waitFor(${label}) timed out after ${timeoutMs}ms — ${reads}; tab ${vis}.`);
    LOG(`    last page state: ${describeState(last)}`);
    return { matched: false, scan: last };
  };

  // Click the first present selector, auto-dismissing a covering popup ONCE (consent-safe,
  // shadow-DOM aware — reuses the clickPageNext machinery). { clicked, sel } / { clicked:false, blockedBy }.
  const clickTarget = async (selectors, label) => {
    for (const sel of selectors) {
      // RE-MEASURE ON EVERY COVER ROUND (2026-07-27) — the same fix clickPageNext got on 2026-07-25,
      // which was never ported here. A rect measured once goes STALE the moment the page reflows, and
      // elementFromPoint then reports whatever now sits at the old point — so the click is refused,
      // blaming an "overlay" that was never on the button. Live on Caterpillar wd5 in a BACKGROUND tab:
      // Apply was "covered by div.css-cygeeu 'locationsSan Diego, California'" — the job-details
      // location block, ordinary page content that could never overlay the button. The JD page was still
      // hydrating (that run scraped 461 chars vs 2913 on a good run), content above Apply grew, the
      // button moved, and the stale point landed in the details panel. Re-probing also lets a genuinely
      // animating overlay settle before we believe it.
      const probe = async () => {
        const r = await cdpRectReady(sel, true);
        if (!r) return { rect: null, cover: null };
        return { rect: r, cover: await cdpEval(cdpCoverCheck, sel, r.cx, r.cy) };
      };
      let { rect, cover } = await probe();
      if (!rect) continue;
      for (let i = 0; i < 3 && cover && cover.blocked; i++) { // reflow/animation settle before believing it
        await pace(250);
        const p = await probe();
        if (!p.rect) break;
        rect = p.rect; cover = p.cover;
      }
      if (cover && cover.blocked) {
        const d = await cdpEval(cdpFindDismissControl, rect.cx, rect.cy);
        if (d && d.found) {
          LOG(`"${label}" covered by ${cover.by} — clicking its dismiss control ${JSON.stringify(d.label)}.`);
          await cdpClickAt(d.cx, d.cy);
          await pace(800);
          const p = await probe(); // FRESH rect: dismissing the popup reflows the page too
          if (p.rect) { rect = p.rect; cover = p.cover; }
        }
      }
      if (cover && cover.blocked) {
        LOG(`"${label}" is covered by ${cover.by} — refusing a blind click. The rect was RE-MEASURED on each round, so this is a real overlay, not a stale coordinate after a reflow.`);
        return { clicked: false, blockedBy: cover.by, sel };
      }
      await cdpClickAt(rect.cx, rect.cy);
      LOG(`clicked "${label}".`);
      return { clicked: true, sel };
    }
    return { clicked: false };
  };

  // Focus → clear → insertText → read-back a text/email/password input by the first
  // matching selector. Trusted CDP path (survives blur), same technique as the fill's focusText.
  // The CLEAR is verified before we type, and a bad write is RETRIED (2026-08-02).
  //
  // Live: the email box already held a different address (Chrome autofill / a previous run), Ctrl+A
  // Delete did not take, and cdpInsertText APPENDED — giving Workday
  // "wangykev+1@gmail.comtester+10@gmail.com". The read-back caught it and said so in the log, but the
  // caller ignored the return value and clicked Sign In anyway (fixed below), so the run failed on
  // credentials that were never ours.
  //
  // Two strategies because they fail differently: the keyboard clear needs the field to hold both
  // focus and a selection (either can be lost to a re-render or a click that landed a pixel off),
  // while the page-side setter clear needs neither. Neither is trusted blind — the field is READ
  // after clearing, and only an actually-empty box gets typed into.
  const clearFieldVerified = async (sel) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt === 1) await cdpSelectAllDelete();
      else { try { await cdpEval(cdpSynthSetValue, "", false); } catch (e) { await cdpSelectAllDelete(); } }
      await pace(120);
      const r = await cdpEval(cdpReadInputBySel, sel);
      if (!r || String(r.value || "") === "") return true;
      LOG(`clear attempt ${attempt} left ${JSON.stringify(r.value)} in the box — retrying with a different clear.`);
    }
    return false;
  };
  const fillField = async (selectors, value, label) => {
    for (const sel of selectors) {
      const rect = await cdpRectReady(sel, true);
      if (!rect) continue;
      let s = null, ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        await cdpClickAt(rect.cx, rect.cy);
        await pace(200);
        s = await cdpEval(cdpReadInputBySel, sel);
        if (!s || !s.focused) { try { await cdpDomFocus(sel); } catch (e) { /* fall through */ } }
        const cleared = await clearFieldVerified(sel);
        if (!cleared) LOG(`could not empty "${label}" — typing anyway would APPEND, so this attempt is abandoned.`);
        else {
          await cdpInsertText(String(value));
          await pace(300);
          s = await cdpEval(cdpReadInputBySel, sel);
          ok = !!s && String(s.value) === String(value);
        }
        if (!ok && attempt === 1) LOG(`"${label}" did not take (got ${JSON.stringify(s && s.value)}) — re-clicking and writing it again.`);
      }
      LOG(`filled "${label}" — ${ok ? "read-back ok" : "read-back MISMATCH (got " + JSON.stringify(s && s.value) + ") — NOT usable"}.`);
      return { ok, sel, actual: s ? s.value : null };
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

  // ── AUTH VIEW (2026-07-25, Caterpillar) ── Sign In and Create Account are two views of the SAME
  // widget and BOTH carry email+password inputs, so "an email field is present" does NOT mean we are on
  // the sign-in form. Live failure: the tenant opened on Create Account, the "Sign In" link click was
  // refused (covered by the widget's own h3#authViewTitle), the flow filled the CREATE-ACCOUNT fields,
  // and the generic `button[type="submit"]` fallback then clicked CREATE ACCOUNT while logging "Sign In
  // submit". These predicates key on the SUBMIT markers — the only view-distinguishing signal.
  const onSignInView = (s) => !!(s && s.markers && s.markers.signInSubmit);
  const onCreateView = (s) => !!(s && s.markers && s.markers.createAccountSubmit && !s.markers.signInSubmit);

  // Switch the auth widget to `want` ("signin" | "create") and VERIFY the switch actually happened
  // (never assume a click landed). Ladder: the trusted coordinate click on the canonical link →, if that
  // is refused/not-found, a page-side element click (cdpClickAuthSwitch — safe: a view-switch link is
  // not a submit and not a consent control; submit buttons are excluded there) → then POLL for the
  // target view's submit marker. Returns { ok, scan }. ok:false ⇒ the caller must NOT fill this view.
  const switchAuthView = async (want, st) => {
    const there = want === "signin" ? onSignInView : onCreateView;
    if (there(st)) return { ok: true, scan: st };
    const sel = want === "signin" ? '[data-automation-id="signInLink"]' : '[data-automation-id="createAccountLink"]';
    const label = want === "signin" ? "Sign In tab" : "Create Account tab";
    const r = await clickTarget([sel], label);
    if (!r.clicked) {
      const d = await cdpEval(cdpClickAuthSwitch, want === "signin" ? "signin" : "createaccount");
      LOG(`"${label}" coordinate click ${r.blockedBy ? `refused (covered by ${r.blockedBy})` : "not found"} — ${d && d.ok ? `clicked it directly in-page (${JSON.stringify(d.text)}, via ${d.how})` : "no view-switch control found"}.`);
      if (!d || !d.ok) return { ok: false, scan: st };
    }
    // isPastAuth in the predicate (audit, 2026-07-27): if the sign-in already landed, no view will ever
    // appear — waiting the full 8s and then reporting "did not switch" describes a page we're past.
    const w = await waitFor((sc) => there(sc) || isPastAuth(sc), 8000, `${want === "signin" ? "sign-in" : "create-account"} view`);
    const scan2 = w.scan || st;
    if (w.matched && isPastAuth(scan2) && !there(scan2)) { LOG(`already past the auth widget (the application form is up) — no view switch needed.`); return { ok: false, scan: scan2, pastAuth: true }; }
    if (!w.matched) LOG(`the auth widget did not switch to the ${want === "signin" ? "SIGN IN" : "CREATE ACCOUNT"} view${w.terminal ? ` (${w.terminal})` : ""}.`);
    return { ok: !!w.matched, scan: scan2 };
  };

  // The account-creation consent. RE-MEASURE, VERIFY, ESCALATE — never a single blind coordinate click
  // (2026-08-07). The old version measured once, clicked once, logged whatever it found and carried on;
  // when the click missed, Create Account simply could not submit, and the auth loop then burned ~12
  // MINUTES re-clicking a submit that was never going to fire. Live on itron.wd5 AND radiancetech.wd12.
  //
  // Two things were wrong, both already-learned lessons applied elsewhere in this file:
  //   • STALE RECT — the rect was read one CDP round-trip before the click was dispatched (~1.2-1.5s on
  //     a hidden tab), and the just-filled password fields' requirement list reflows the label out from
  //     under it. clickPageNext re-measures on every cover round for exactly this reason.
  //   • NO ESCALATION — re-issuing the identical coordinate click cannot recover a click that did not
  //     register; the retry has to change the MECHANISM (the Stage-1 Apply lesson, 2026-08-06).
  // So: re-measure before every attempt, re-read `checked` after every attempt, and escalate to in-page
  // native label activation. Never halts — the caller proceeds either way, and the log states the truth.
  const checkConsent = async () => {
    let c = await cdpEval(cdpConsentRect);
    if (!c) { LOG("no consent checkbox detected — proceeding (some tenants have none)."); return; }
    if (c.checked) { LOG("consent already checked."); return; }
    // 1-2: trusted coordinate click, re-measured each time so a reflow can't send it to a dead point.
    for (let attempt = 1; attempt <= 2 && c && !c.checked; attempt++) {
      await cdpClickAt(c.cx, c.cy);
      await pace(300);
      c = await cdpEval(cdpConsentRect);
      if (c && c.checked) { LOG(`consent checkbox — checked (coordinate click, attempt ${attempt}).`); return; }
    }
    // 3: the coordinate click is not landing — change the mechanism.
    const a = await cdpEval(cdpConsentRect, "activate");
    if (a && a.checked) { LOG(`consent checkbox — checked via in-page label activation (the coordinate click was not registering).`); return; }
    LOG(`consent checkbox — STILL UNCHECKED after a re-measured coordinate click and in-page activation${a && a.inputId ? ` (input ${a.inputId})` : ""}. Create Account will likely refuse; proceeding so the failure is reported by the submit, not guessed at here.`);
  };

  // Click a submit button and wait for the auth outcome — with a re-click FALLBACK. If the wait
  // times out AND the form is still up (`formStillUp` → the submit control is still present, so we
  // did NOT navigate → the click raced a not-yet-enabled button, or a throttled/hidden page never
  // reacted), RE-CLICK and wait again, bounded by `tries`. The re-click is gated on the form still
  // being up so a retry can never click into a page that already advanced. `done(s)` = the page
  // moved on. Returns { scan } (final scan) or { notFound, blockedBy } if the button was never clickable.
  // tries = 3 → the initial click + up to TWO re-clicks, so a Sign In / Create Account that "does
  // nothing" keeps getting retried (operator ask 2026-07-10). Both submits go through this.
  // `timeouts`: optional per-attempt wait LADDER, e.g. [500, 20000] — a FAST re-click if the first
  // click no-ops (500ms), then the full wait for a genuinely slow submit (20s). Escalating so the
  // common case is fast and a missed first click recovers quickly instead of stalling the whole 20s.
  // Falls back to `timeoutMs` for every attempt when no ladder is given; `tries` derives from the
  // ladder length when a ladder is passed.
  // Chrome's password-manager autofill dropdown renders OVER the focused credential field. It's BROWSER
  // chrome (painted above the page), so cdpCoverCheck/elementFromPoint can't see it and a coordinate click
  // on the Sign In / Create Account button below it silently MISSES (operator hit this live, 2026-07-23).
  // The dropdown only shows while a credential field is FOCUSED — there's no DOM node to query — so the
  // reliable proxy for "it's gone" is "no credential field is focused". Escape CLOSES the visible dropdown
  // but KEEPS focus (so it can reappear); pressing TAB actually moves focus OFF the field (operator, 2026-
  // 07-23), which is what truly dismisses it. We do both, then CONFIRM (poll) no email/password input is
  // focused before clicking. Bounded; best-effort.
  const credentialFieldFocused = () => cdpEval(() => {
    const a = document.activeElement;
    if (!a || a.tagName !== "INPUT") return false;
    const t = (a.getAttribute("type") || "").toLowerCase();
    const aid = (a.getAttribute("data-automation-id") || "").toLowerCase();
    return t === "password" || t === "email" || /password|email/.test(aid);
  });
  const dismissPasswordManager = async () => {
    const deadline = Date.now() + 1500;
    do {
      try { await cdpKeyTap(CDP_KEYS.escape); } catch (e) {} // close the visible dropdown
      try { await cdpKeyTap(CDP_KEYS.tab); } catch (e) {}    // Escape keeps focus; Tab moves focus OFF the field to truly dismiss it
      let focused = true;
      try { focused = await credentialFieldFocused(); } catch (e) { focused = false; }
      if (!focused) return true; // no credential field focused → the autofill dropdown is dismissed
      await cdpDelay(150);
    } while (Date.now() < deadline);
    LOG("⚠ could not confirm Chrome's password-manager overlay is gone before clicking — proceeding anyway.");
    return false;
  };

  // `beforeRetry` (2026-07-25, Caterpillar): an optional best-effort hook run before each RE-click.
  // Create Account passes checkConsent — a missed/unchecked consent box makes the submit no-op with
  // the form still up ("Error: Please check the box to continue"), so re-checking it before the
  // retry self-heals a tenant the consent detector missed (checkConsent is idempotent — an
  // already-checked box is a no-op read, never an uncheck).
  const submitAndWait = async ({ selectors, label, done, formStillUp, tries = 3, timeoutMs = 20000, timeouts = null, beforeRetry = null }) => {
    // Clear Chrome's password-manager autofill dropdown (it can cover the submit button and swallow the
    // coordinate click) and CONFIRM it's gone before clicking. Both onboarding submits follow credential
    // fields, so this is a no-op cost when nothing is focused.
    await dismissPasswordManager();
    const ladder = (timeouts && timeouts.length) ? timeouts : null;
    const n = ladder ? ladder.length : tries;
    let st = null;
    for (let t = 1; t <= n; t++) {
      const submitted = await clickTarget(selectors, t > 1 ? `${label} (retry ${t - 1})` : label);
      if (!submitted.clicked) return (t > 1) ? { scan: st } : { notFound: true, blockedBy: submitted.blockedBy };
      const wait = ladder ? ladder[t - 1] : timeoutMs;
      const w = await waitFor((s) => done(s) || isWorkdaySoftError(s.bodyText), wait, `${label} outcome`);
      st = w.scan || st;
      if (st && await maybeRefresh(st)) st = await scan() || st;
      if (st && done(st)) return { scan: st };
      // Timed out. Re-click ONLY if still on this submit form; else the page advanced (done just
      // doesn't match yet) → return and let the caller re-evaluate on the next loop iteration.
      if (t < n && st && formStillUp(st)) {
        LOG(`${label}: no outcome after ${wait >= 1000 ? Math.round(wait / 1000) + "s" : wait + "ms"} and the form is still up — re-clicking (raced/not-ready button or a throttled page).`);
        if (beforeRetry) { try { await beforeRetry(st); } catch (e) { /* best-effort — the re-click proceeds regardless */ } }
        continue;
      }
      return { scan: st };
    }
    return { scan: st };
  };

  // Gmail email-verification: find the workday.com link containing the tenant host and
  // navigate the tab to it. Returns { ok } or a needs_operator halt object.
  const doVerify = async (st) => {
    if (!gmailEnabled) return { ok: false, reached_form: false, needs_operator: true, stopped: "verification-required-gmail-off", detail: "Workday requires email verification but Gmail auto-verify is OFF. Enable it (and Connect Gmail) in the popup, or click the link in the email yourself and re-run." };
    emitRunProgress("Verifying your email", "checking Gmail for the verification link");
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
    emitRunProgress("Creating your account");
    // Switch to the CREATE ACCOUNT view + verify (same discipline as the sign-in switch: never fill a
    // form we haven't confirmed we're on). Already there ⇒ no-op.
    if (!onCreateView(st)) { const sw = await switchAuthView("create", st); st = sw.scan || st; }
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
      formStillUp: (s) => !!s.markers.createAccountSubmit,
      beforeRetry: () => checkConsent() // a no-op submit with the form still up can mean a missed consent box ("Please check the box to continue" — Caterpillar) — re-detect + check it before re-clicking (idempotent)
    });
    if (r.notFound) return { ok: false, reached_form: false, needs_operator: true, stopped: "create-account-submit-not-found", detail: r.blockedBy || "no Create Account button" };
    let post = r.scan || st;
    if (post && /already (exists|in use)|an account (already )?exists|email is already (in use|registered)/i.test(post.bodyText || "")) {
      LOG("Workday says the account already exists — will sign in instead.");
      return { ok: true, alreadyExists: true };
    }
    return { ok: true };
  };

  // A page-supplied string used as a regex must be escaped — a section label like "Application(s)" is
  // otherwise a live pattern (or a syntax error) in cdpTagClickableByText.
  const escapeForRx = (s) => String(s == null ? "" : s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").trim();

  // ── ALREADY-APPLIED RECOVERY (operator 2026-07-28) ────────────────────────────────────────────────
  // "Sometimes it says you have applied to this application when you have not." Workday shows the
  // already-applied page for an application that was STARTED but never SUBMITTED, and the old code took
  // that page at its word and halted — abandoning a perfectly fillable application.
  //
  // The AUTHORITY is the candidate's own applications list, exactly as the operator does it by hand:
  //   already-applied → "View My Applications" → (expand the collapsed dropdown) → find THIS job →
  //   read Submitted / Not Submitted → click it → the job-description page → "Continue Application" →
  //   page 1 of the application.
  //
  // Two rules run through every step, both operator-stated:
  //   • NEVER assume a click landed where it aimed — classifyWorkdayPage each redirect and report what we
  //     ACTUALLY got. Every halt below names the page it found.
  //   • Let everything render. Each hop settles + polls; the expand loop settles on the row COUNT rather
  //     than a fixed beat (the same lesson as the JD page, the field set, and the review page).
  // Safety: it only ever REACHES a form — it never fills, advances, or submits. On any ambiguity
  // (no matching row, two matching rows, the wrong posting) it halts for the operator instead of opening
  // an application that might not be ours.
  // Returns { done:true, result } (halt/terminal) | { done:false, scan } (recovered — caller continues).
  const handleAlreadyApplied = async (st0) => {
    if (appliedRecoveries >= MAX_APPLIED_RECOVERIES) {
      LOG(`already-applied recovery has run ${appliedRecoveries}× this session and the page still says already-applied — taking it at its word.`);
      return { done: true, result: alreadyAppliedResult() };
    }
    appliedRecoveries++;

    const bail = (stopped, detail, s) => ({ done: true, result: haltNeedsOperator(stopped, detail, s) });
    // A landing we didn't expect. Says what we wanted, what we got, and where — never a bare timeout.
    const wrongPage = (step, want, s) =>
      bail("applied-recovery-wrong-page",
        `after ${step} the tab landed on a "${classifyWorkdayPage(s)}" page (expected ${want}) — url=${s && s.url}. Open the job, click "View My Applications" by hand and continue from there.`, s);

    LOG('⚠ Workday says "already applied" — VERIFYING against My Applications before believing it (it reports this for started-but-unsubmitted applications too).');
    emitRunProgress("Checking your applications", "Workday says already applied — verifying");

    // WHICH job are we looking for? The already-applied page IS the job's page, so its URL carries the
    // requisition id; startUrl is the caller's copy of the same posting. The title comes off the page.
    let ident = null;
    try { ident = await cdpEval(cdpReadJobIdentity); } catch (e) { /* the pick can run on the req id alone */ }
    const target = {
      url: (st0 && st0.url) || startUrl || "",
      reqId: reqIdFromUrl((st0 && st0.url) || "") || reqIdFromUrl(startUrl || "") || reqIdFromUrl((ident && ident.requisitionText) || ""),
      title: (ident && ident.postingTitle) || null
    };
    LOG(`   looking for: requisition=${target.reqId || "(none found in the URL)"} · title=${target.title ? JSON.stringify(target.title) : "(unread)"}`);

    // ── 1. "View My Applications" ───────────────────────────────────────────────────────────────────
    const TOKEN = "ap-recover";
    let tag = null;
    try { tag = await cdpEval(cdpTagClickableByText, TOKEN, "view\\s+my\\s+applications|my\\s+applications|view\\s+applications", null, null); }
    catch (e) { return bail("applied-recovery-read-failed", "could not read the already-applied page: " + String((e && e.message) || e), st0); }
    if (!tag || !tag.tagged) {
      return bail("applied-recovery-no-link",
        `the already-applied page has no "View My Applications" link to follow, so the real status can't be checked. Body: ${JSON.stringify(String((st0 && st0.bodyText) || "").replace(/\s+/g, " ").trim().slice(0, 300))}`, st0);
    }
    LOG(`   clicking "${tag.text}".`);
    const c1 = await clickTarget([`[data-ap-click="${TOKEN}"]`], "View My Applications");
    if (!c1.clicked) return bail("applied-recovery-link-blocked", c1.blockedBy || 'could not click "View My Applications"', st0);

    // allowAlreadyApplied: we are LEAVING the already-applied page, so waitFor's usual terminal exit on it
    // would fire on the first poll (the old page is still up mid-navigation) and abort the recovery.
    const w1 = await waitFor((s) => isMyApplicationsPage(s) || (!isAlreadyApplied(s) && (s.formFieldCount > 0 || s.hasAuthEl)), await renderBudget(15000, 35000), "my-applications-page", { allowAlreadyApplied: true });
    let st = w1.scan || st0;
    await settlePage(4000);
    st = (await scan()) || st;
    // CLASSIFY, don't assume. Signing in can be demanded here; the form can even appear directly.
    const kind1 = classifyWorkdayPage(st);
    if (kind1 === "auth") { LOG("   the applications list requires signing in first — handing back to the auth stage, which will land here again once signed in."); return { done: false, scan: st }; }
    if (kind1 === "form") { LOG("   landed straight on the application form — recovered."); return { done: false, scan: st }; }
    if (kind1 !== "my-applications") return wrongPage('clicking "View My Applications"', "the My Applications list", st);

    // ── 2. Expand collapsed sections until the row count SETTLES ────────────────────────────────────
    // "Sometimes the application dropdown is closed so you will have to open it to see submitted or not
    // submitted." Expanding can reveal more rows, so this loops on the count instead of clicking once.
    let page = null;
    try { page = await cdpEval(cdpReadApplicationsPage); } catch (e) { return bail("applied-recovery-read-failed", "could not read the applications list: " + String((e && e.message) || e), st); }
    for (let round = 0; round < 4; round++) {
      if (!page || !page.collapsed || !page.collapsed.length) break;
      const before = (page.rows || []).length;
      LOG(`   expanding ${page.collapsed.length} collapsed section(s) (round ${round + 1}; ${before} row(s) visible).`);
      let expandedAny = false;
      for (const cRow of page.collapsed.slice(0, 8)) {
        const rx = escapeForRx(cRow.label);
        if (!rx) continue; // an unlabelled toggle can't be text-targeted — a catch-all pattern would click something arbitrary
        const t = await cdpEval(cdpTagClickableByText, TOKEN, rx, null, null).catch(() => null);
        if (!t || !t.tagged) continue;
        const r = await clickTarget([`[data-ap-click="${TOKEN}"]`], `expand "${cRow.label}"`);
        if (r.clicked) { expandedAny = true; await pace(500); }
      }
      if (!expandedAny) break;
      await pace(800);
      try { page = await cdpEval(cdpReadApplicationsPage); } catch (e) { break; }
      if ((page.rows || []).length === before && !(page.collapsed || []).length) break; // settled
    }

    const rows = (page && page.rows) || [];
    LOG(`   applications list: ${rows.length} row(s).`);
    for (const r of rows.slice(0, 12)) LOG(`     • ${JSON.stringify(r.title)} — status=${r.statusText || "(none shown)"} · ${r.href || "(no href)"}`);

    // ── 3. Find OUR application ─────────────────────────────────────────────────────────────────────
    const picked = pickApplicationRow(rows, target);
    if (!picked.row) {
      return bail("applied-recovery-row-not-found",
        `${picked.reason}. The list showed ${rows.length} row(s)${rows.length ? ": " + rows.map((r) => JSON.stringify(r.title)).slice(0, 8).join(", ") : ""}${(page && page.headings || []).length ? ` (page headings: ${page.headings.slice(0, 4).join(" / ")})` : ""}.`, st);
    }
    const row = picked.row;
    const status = applicationStatusOf(row.text);
    LOG(`   matched by ${picked.tier}: ${JSON.stringify(row.title)} — status reads "${row.statusText || "(none shown)"}" → ${status}.`);

    // SUBMITTED for real → the original halt was right after all, now with EVIDENCE behind it.
    if (status === "submitted") {
      LOG("   ✓ confirmed SUBMITTED on your applications list — the already-applied page was telling the truth. Halting.");
      return { done: true, result: { ok: true, reached_form: false, already_applied: true, stopped: "already-applied",
        detail: `You've already applied — your My Applications list shows "${row.title}" as ${row.statusText || "submitted"}.` } };
    }
    if (status === "unknown") {
      // No status word on the row. Don't guess either way: open it and let the posting decide — a
      // "Continue Application" affordance is positive proof the application is still open.
      LOG('   ⚠ the row shows no status word — opening it; a "Continue Application" button will settle whether it is still open.');
    }

    // ── 4. Open the row → the job-description page ──────────────────────────────────────────────────
    let rowTag = null;
    try { rowTag = await cdpEval(cdpTagRowByHref, TOKEN, row.href); } catch (e) { /* fall through to the check */ }
    if (!rowTag || !rowTag.tagged) return bail("applied-recovery-row-not-clickable", `the matched row (${JSON.stringify(row.title)}) has no clickable link on the page.`, st);
    const c2 = await clickTarget([`[data-ap-click="${TOKEN}"]`], `application "${row.title}"`);
    if (!c2.clicked) return bail("applied-recovery-row-blocked", c2.blockedBy || `could not click the application row ${JSON.stringify(row.title)}`, st);

    await waitFor((s) => !!(s.markers.continueButton || s.markers.adventureButton || s.markers.applyManually) || s.formFieldCount > 0 || s.hasAuthEl, await renderBudget(15000, 35000), "application-job-page");
    await settlePage(4000);
    st = (await scan()) || st;
    const kind2 = classifyWorkdayPage(st);
    if (kind2 === "form") { LOG("   the row opened the application form directly — recovered."); return { done: false, scan: st }; }
    if (kind2 === "auth") { LOG("   the row led to a sign-in screen — handing back to the auth stage."); return { done: false, scan: st }; }
    if (kind2 === "already-applied") {
      // The row itself leads back to already-applied. Whatever the list said, Workday will not reopen it.
      LOG("   the row leads back to the already-applied page — Workday will not reopen this application. Halting.");
      return { done: true, result: { ok: true, reached_form: false, already_applied: true, stopped: "already-applied",
        detail: `Your applications list showed "${row.title}" as ${row.statusText || "no status"}, but opening it returns the already-applied page — Workday will not reopen it.` } };
    }
    if (kind2 !== "job-description") return wrongPage("opening the application row", "the job-description page", st);

    // ── 5. PROVE it's the right posting before continuing ───────────────────────────────────────────
    let ident2 = null;
    try { ident2 = await cdpEval(cdpReadJobIdentity); } catch (e) { /* url check below still applies */ }
    const landedReq = reqIdFromUrl((st && st.url) || "") || reqIdFromUrl((ident2 && ident2.requisitionText) || "") || reqIdFromUrl((ident2 && ident2.postingTitle) || "");
    if (target.reqId && landedReq && landedReq !== target.reqId) {
      return bail("applied-recovery-wrong-job",
        `the row opened requisition ${landedReq} but we are applying to ${target.reqId} — refusing to continue someone else's application. Landed on ${JSON.stringify((ident2 && ident2.postingTitle) || st.title)}.`, st);
    }
    LOG(`   ✓ on the right posting (${landedReq || "requisition unread"}${ident2 && ident2.postingTitle ? ` — ${JSON.stringify(ident2.postingTitle)}` : ""}).`);
    if (status === "unknown" && !(ident2 && ident2.hasContinue) && !st.markers.continueButton) {
      return { done: true, result: { ok: true, reached_form: false, already_applied: true, stopped: "already-applied",
        detail: `Your applications list shows "${row.title}" with no status, and the posting offers no "Continue Application" — treating it as already submitted.` } };
    }

    // ── 6. Continue Application → page 1 ────────────────────────────────────────────────────────────
    emitRunProgress("Resuming your application", "continuing an unsubmitted application");
    let cont = ['[data-automation-id="continueButton"]'];
    if (!st.markers.continueButton) {
      // No canonical id — fall back to the button's words, but NEVER a "submit"/"withdraw" control.
      const t3 = await cdpEval(cdpTagClickableByText, TOKEN, "continue\\s+application|resume\\s+application|\\bcontinue\\b", "submit|withdraw|delete|cancel", null).catch(() => null);
      if (!t3 || !t3.tagged) return wrongPage("looking for Continue Application", 'a "Continue Application" button', st);
      LOG(`   no continueButton id — clicking by text: "${t3.text}".`);
      cont = [`[data-ap-click="${TOKEN}"]`];
    }
    const c3 = await clickTarget(cont, "Continue Application");
    if (!c3.clicked) return bail("applied-recovery-continue-blocked", c3.blockedBy || 'could not click "Continue Application"', st);

    await waitFor((s) => s.formFieldCount > 0 || s.hasAuthEl || s.markers.applyManually, await renderBudget(20000, 45000), "post-continue-application");
    await settlePage(5000);
    st = (await scan()) || st;
    const kind3 = classifyWorkdayPage(st);
    if (kind3 === "form") { LOG("   ✓ RECOVERED — the application reopened on its form. Continuing the normal flow."); return { done: false, scan: st }; }
    if (kind3 === "auth" || kind3 === "job-description") { LOG(`   after Continue Application the page is "${kind3}" — handing back to the normal flow, which handles it.`); return { done: false, scan: st }; }
    if (kind3 === "already-applied") return { done: true, result: alreadyAppliedResult() }; // it really is closed
    return wrongPage('clicking "Continue Application"', "the application form", st);
  };

  // Auth loop: try sign-in first; verify→re-sign-in; wrong→create-account→loop.
  const doAuth = async () => {
    // Headroom: on a chooser tenant every real step (chooser reveal, sign-in, create-account, verify,
    // re-sign-in) consumes an iteration, and a stray SECOND verify cycle doubles that — PANW hit
    // exactly 8 with a double-cycle (2026-07-09), i.e. no margin. 12 comfortably survives a
    // chooser→create→verify→(re-verify)→re-sign-in chain while still backstopping a genuinely stuck page.
    emitRunProgress("Signing in");
    const maxAttempts = 12;
    let revealStalls = 0; // consecutive "Sign in with email" reveals where the form never rendered (hidden-tab repaint stall)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let st = await scan();
      if (!st) { await settlePage(6000); st = await scan(); }
      if (!st) return { ok: false, error: "no-page-state-in-auth" };
      if (await maybeRefresh(st)) st = await scan() || st;

      const oc = classifyAuthOutcome(st);
      if (oc === "success" || isPastAuth(st) || onResumeUploadPage(st)) {
        // Signing in can land on the RÉSUMÉ page rather than the form, when Autofill with Resume was
        // chosen before the auth screen appeared. Consume it here too, or onboarding would report
        // "reached the form" while sitting on a page that has no fields to fill.
        if (onResumeUploadPage(st)) {
          const r = await consumeResumeUploadPage(st);
          if (r.halt) return r.halt;
          st = r.scan || st;
          resumeAutofilled = true;
        }
        LOG("reached the application form.");
        return { ok: true, reached_form: true, stopped: "reached-form", account_created: accountCreated, verified, resume_autofilled: resumeAutofilled };
      }
      // ALREADY APPLIED inside the auth loop (audit, 2026-07-27). It was checked at the initial scan, at
      // the start of Stage 3, and after a successful sign-in — but NOT here, so an already-applied page
      // reached during the loop fell through to the race-guard and halted `auth-form-not-rendered`: a
      // flat-wrong reason for a clean terminal state (its shape — no form, no auth chrome, no fields —
      // is exactly what that halt tests for).
      if (isAlreadyApplied(st)) { const h = await handleAlreadyApplied(st); if (h.done) return h.result; continue; }
      // NOT AN AUTH SCREEN AT ALL — we're on the job-description page (2026-07-29). Its header "Sign In"
      // link is what satisfied `signInButtonPresent` and routed us here; there is no credential field and
      // never will be. Hand back so the apply stage can click Continue/Apply, instead of burning this
      // loop's budget and then halting `auth-form-not-rendered` on a page that shows an Apply button.
      if (onJobDescription(st)) {
        LOG(`this is the JOB-DESCRIPTION page, not an auth screen — apply-chain marker(s) present: [${presentApply(st).join(", ") || "none"}]. Handing back to the apply stage.`);
        return { ok: true, backToApply: true };
      }
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
        if (!c.clicked) return haltNeedsOperator("signin-with-email-blocked", c.blockedBy || "could not click Sign in with email", st);
        await cdpWakePage();
        const w = await waitFor((s) => s.passwordInput || s.emailInput || s.markers.createAccountLink || s.markers.signInSubmit || isPastAuth(s), 15000, "email-sign-in-form");
        st = w.scan || st;
        // Hidden-render stall: the chooser→form reveal defers on rAF, which is paused when the tab is
        // backgrounded (and this page's CSP evidently blocks the worker-timer workaround). Rather than
        // re-reveal forever (PANW hidden looped to the cap, 2026-07-09), halt after 2 misses with an
        // ACTIONABLE message. The account is already created/activated by now, so a foreground re-run
        // signs straight in. focus-emulation (cdpSetFocusEmulation) is the attempted fix; this is the net.
        if (w.matched) { revealStalls = 0; }
        else if (++revealStalls >= 2) {
          return haltNeedsOperator("hidden-render-stalled", 'the sign-in form did not render after "Sign in with email" — this Workday page does not repaint while the tab is hidden/backgrounded. Bring the tab to the FOREGROUND (visible) and re-run; the account is already created, so it will sign straight in.', st);
        }
        continue;
      }

      // RACE GUARD before the SSO decision: the sign-in email/password fields can still be PAINTING
      // right after "Apply Manually", or sit behind a "Sign In" tab that must be clicked to reveal them.
      // looksLikeSso's field-absence signal (a "Sign In" button but no email/password field) then
      // false-fires on the not-yet-rendered form → a spurious "SSO / step in" halt that clears on a
      // re-run (operator-observed, 2026-07-23). So REVEAL the form first: click the Sign In tab if
      // present, then poll for the fields (or the chooser) to appear. A genuine SSO screen never shows
      // them → the poll times out and looksLikeSso still halts below. (Additive; when the fields are
      // already present this whole block is skipped, so the live-verified happy paths are unchanged.)
      if (!st.passwordInput && !st.emailInput && !st.signInWithEmail) {
        if (st.markers.signInLink) { await clickTarget(['[data-automation-id="signInLink"]'], "Sign In tab"); await pace(800); st = await scan() || st; }
        if (!st.passwordInput && !st.emailInput && !st.signInWithEmail) {
          // HIDDEN-SCALED (2026-07-27): the flat 8s was the proximate cause of the false-SSO halt below —
          // a backgrounded Caterpillar wd5 auth widget hadn't painted its fields yet, and giving up here
          // sent an ordinary create-account page down the SSO path.
          // isPastAuth is in the predicate DELIBERATELY (2026-07-27): the sign-in may have SUCCEEDED and
          // the page become the APPLICATION FORM while we sat here polling for sign-in fields. Live, that
          // is exactly what happened — the wait timed out with `formFields=14 · hasAuthEl=false` (the form
          // we wanted) and the flow halted `auth-form-not-rendered` on its own success.
          // onJobDescription is in the predicate for the same reason isPastAuth is (2026-07-29): this wait
          // must also notice that we are in the WRONG PLACE, not just that the goal hasn't arrived. Live,
          // the page finished rendering into the job-description page (Apply/Continue button and all) while
          // this sat polling for credential fields, and burned its full 30s before halting. An apply-chain
          // marker is positive evidence there is no auth screen here at all — exit immediately.
          const w = await waitFor((s) => s.passwordInput || s.emailInput || s.signInWithEmail || isPastAuth(s) || onJobDescription(s), await renderBudget(8000, 30000), "sign-in-form-render");
          st = w.scan || st;
        }
        // WRONG PLACE, not a slow render — hand back to the apply stage (see onJobDescription).
        if (onJobDescription(st)) {
          LOG(`the "auth screen" turned out to be the JOB-DESCRIPTION page — apply-chain marker(s): [${presentApply(st).join(", ") || "none"}]. Handing back to the apply stage.`);
          return { ok: true, backToApply: true };
        }
        if (isPastAuth(st)) continue;     // already on the form → the loop top returns reached_form
        if (st.signInWithEmail) continue; // a chooser appeared during the wait → re-loop so the chooser handler runs
        // Auth chrome is up but NO credential field rendered, and there's no create-account affordance to
        // fall through to. Say that plainly — looksLikeSso no longer claims this state on a Workday host
        // (field-absence isn't SSO evidence), so without this it would end as a vague "auth-unrecognized".
        if (isPastAuth(st)) continue;            // the form arrived while we waited — success, not a failure
        if (isAlreadyApplied(st)) { const h = await handleAlreadyApplied(st); if (h.done) return h.result; continue; } // may be a started-but-unsubmitted application — verify before giving up
        if (!st.passwordInput && !st.emailInput && !st.markers.createAccountSubmit && !st.markers.createAccountLink && !st.markers.verifyPassword) {
          return haltNeedsOperator(
            "auth-form-not-rendered",
            "the sign-in fields never appeared on the auth screen. If the tab was in the background this is usually a slow repaint — bring it to the FOREGROUND and re-run.",
            st
          );
        }
      }

      if (looksLikeSso(st)) return haltNeedsOperator("sso", "this tenant uses SSO/federated login — sign in manually, then re-run (it detects the form and continues).", st);
      if (!creds || !creds.email || !creds.password) return haltNeedsOperator("no-credentials", "load credentials (data/credentials.json) in the popup, or sign in manually then re-run.");

      // Prefer the sign-in path — but SWITCH to the sign-in view and VERIFY the switch before touching
      // any field. Both views carry email+password, so the old "a field is present ⇒ we're signing in"
      // assumption typed the sign-in credentials into the CREATE-ACCOUNT form and pressed CREATE ACCOUNT
      // while logging "Sign In submit" (Caterpillar, live) — it only recovered by accident afterwards.
      // If the sign-in view can't be reached we fall through to the create-account branch DELIBERATELY,
      // never by mislabelling one form as the other.
      if (st.markers.signInLink || onCreateView(st)) { const sw = await switchAuthView("signin", st); st = sw.scan || st; }
      if (onCreateView(st)) LOG("auth widget is on the CREATE ACCOUNT view and would not switch to Sign In — going to account creation (not filling sign-in credentials into this form).");

      if ((st.passwordInput || st.emailInput) && !onCreateView(st)) {
        LOG(`sign-in attempt ${attempt} as ${creds.email}.`);
        // data-automation-id FIRST (Workday-canonical + present on observed tenants); the generic
        // input[type=email] is the fallback. Ordering matters only for speed — a missing first
        // selector burns the ~2.5s cdpRectReady ceiling before falling through (live: Comcast has
        // no input[type=email], so the old order stalled 2.6s on the sign-in email field).
        // Submitting a field we could not write is worse than stopping: Workday answers "wrong
        // credentials", the flow reads that as a real rejection and can go on to CREATE AN ACCOUNT
        // for an address that is not ours. So a failed write halts here, naming the box (2026-08-02).
        const fe = await fillField(['[data-automation-id="email"]', 'input[type="email"]'], creds.email, "email");
        const fp = await fillField(['[data-automation-id="password"]', 'input[type="password"]'], creds.password, "password");
        if (!fe.ok || !fp.ok) {
          const which = !fe.ok && !fp.ok ? "email and password fields" : !fe.ok ? "email field" : "password field";
          return haltNeedsOperator("credentials-not-entered",
            `Couldn't put the sign-in credentials into the ${which} — the box kept content we didn't type (browser autofill is the usual cause), so signing in would have used the wrong value. Clear the saved entry for this site (or turn off autofill for it) and re-run.`,
            await scan());
        }
        // FIXED (not paced) — a real page-reaction wait: Workday enables/wires the Sign In submit a
        // beat AFTER the fields fill, and a submit click has no self-correcting gate. Keep it SHORT
        // (200ms) so the common case is fast; if the first click still no-ops, submitAndWait's
        // ESCALATING re-click ladder recovers it — a fast re-click at 500ms, then the full 20s for a
        // genuinely slow sign-in (the `timeouts` below). Tuned from a flat 500ms after the operator
        // found that too slow on the happy path (2026-07-22).
        await cdpDelay(200);
        // Canonical id first (present on observed tenants → no rectReady stall); the click_filter
        // handle + generic submit are fallbacks. A coordinate click on the button hits Workday's
        // click_filter overlay if present — cdpCoverCheck now allows that (it's the click surface).
        // ESCALATE THE MECHANISM, don't just repeat the click (2026-08-06). Live: the coordinate click
        // silently did not take, the form stayed up, and the old ladder re-clicked exactly the same way —
        // which can only reproduce the failure. Operator confirmed no browser dialog was involved; the
        // press simply did not happen. Each retry now activates the button a DIFFERENT way, cheapest and
        // most-human first. All trusted: the keystroke comes from the SW, the page only moves focus.
        let signInEsc = 0;
        const signInEscalate = async () => {
          const step = signInEsc++;
          try {
            if (step === 0) { // focus the button, activate with a real Enter
              const f = await cdpEval(cdpFocusSignInTarget, "button");
              if (f && f.ok) { LOG(`  sign-in fallback 1: focused the ${f.what} and pressing Enter (the coordinate click did not take).`); await cdpKeyTap(CDP_KEYS.enter); return; }
              LOG(`  sign-in fallback 1 unavailable — ${(f && f.reason) || "focus failed"}.`);
            } else if (step === 1) { // Enter in the password field — how a person actually submits this form
              const f = await cdpEval(cdpFocusSignInTarget, "password");
              if (f && f.ok) { LOG("  sign-in fallback 2: pressing Enter in the password field (native form submit)."); await cdpKeyTap(CDP_KEYS.enter); return; }
              LOG(`  sign-in fallback 2 unavailable — ${(f && f.reason) || "focus failed"}.`);
            }
          } catch (e) { LOG(`  sign-in fallback ${step + 1} errored: ${String((e && e.message) || e)}`); }
        };
        const r = await submitAndWait({
          selectors: ['[data-automation-id="signInSubmitButton"]', '[data-automation-id="click_filter"][aria-label="Sign In"]', 'button[type="submit"]'],
          label: "Sign In submit",
          done: (s) => classifyAuthOutcome(s) !== "unknown",
          formStillUp: (s) => !!s.markers.signInSubmit,
          // 3 attempts so BOTH escalations get a turn: click → (focus+Enter) → click → (password Enter) →
          // click. The short first rung keeps the happy path fast; the last is the real ceiling.
          timeouts: [500, 3000, 6000],
          beforeRetry: signInEscalate
        });
        if (r.notFound) return haltNeedsOperator("signin-submit-not-found", r.blockedBy || "no Sign In button", st);
        st = r.scan || st;
        let out = classifyAuthOutcome(st);
        // ── Chrome's "password found in a data breach" dialog (detect-then-Enter, NEVER blind). ──
        // That native browser dialog overlays the sign-in form after submit and blocks completion. It's
        // browser chrome, invisible to the DOM — but THIS is its signature: we submitted Sign In, ~6s
        // passed (the short ceiling above), and the sign-in form is STILL present (signInSubmit) with no
        // recognized outcome. Enter is that dialog's default dismiss (operator-confirmed). SAFE + not
        // blind: signInSubmit still present ⇒ we're on the SIGN-IN form (never the application form), so a
        // stray Enter can at most re-submit sign-in (submitAndWait already re-clicks it every attempt) —
        // never advance a page or submit an application. Fire ONCE the moment the stall is detected (~6s,
        // not the old ~20s), THEN wait the full time for the real outcome; the routing below handles it.
        if (out === "unknown" && st.markers.signInSubmit) {
          // Two DIFFERENT things can produce this state and the log used to assert the rarer one. Chrome's
          // data-breach dialog does block the form (it is browser chrome, invisible to the DOM, and Enter
          // dismisses it) — but the operator has now confirmed a case where there was NO dialog and the
          // click simply never registered. Enter covers both, so send it; just don't claim to know which.
          LOG("sign-in stalled with the form still up and no outcome — pressing Enter. That both dismisses Chrome's data-breach dialog (if that is what is blocking) and submits the form (if the click never registered). Safe either way: we are still on the SIGN-IN form, so at worst it re-submits sign-in.");
          emitRunProgress("Retrying sign-in");
          try { await cdpKeyTap(CDP_KEYS.enter); } catch (e) { /* best-effort */ }
          const wb = await waitFor((s) => classifyAuthOutcome(s) !== "unknown", 15000, "post-Enter outcome");
          st = wb.scan || st;
          out = classifyAuthOutcome(st);
          // LAST RESORT before handing it to a human: activate the button from inside the page. Every
          // trusted mechanism has now failed, so a synthetic activation is strictly better than halting —
          // and it is scoped to the sign-in button by automation-id, so it cannot fire anything else.
          if (out === "unknown" && st.markers.signInSubmit) {
            let dom = null;
            try { dom = await cdpEval(cdpDomActivateSignIn); } catch (e) { /* best-effort */ }
            LOG(dom && dom.ok
              ? `sign-in still not through — last resort: activated the button in-page via ${dom.via}.`
              : `sign-in still not through and the in-page activation could not run (${(dom && dom.reason) || "eval failed"}).`);
            if (dom && dom.ok) {
              const wd = await waitFor((s) => classifyAuthOutcome(s) !== "unknown", 15000, "post-DOM-activate outcome");
              st = wd.scan || st;
              out = classifyAuthOutcome(st);
            }
          }
        }
        LOG(`sign-in outcome: ${out}.`);
        // ── EMPTY SHELL after the submit → RELOAD and retry (operator 2026-07-27: "the solution is to
        //    just refresh the page"). Live on cat.wd5/solarturbines: the submit left a page with
        //    readyState=complete but NOTHING on it — no form, no auth chrome, no markers, just the
        //    cookie boilerplate under a stale "Create Account" title. Nothing to classify and nothing
        //    to act on, so it used to halt `auth-unknown` and hand a recoverable hiccup to the operator.
        //    A reload brings the real page back. Bounded, and strictly gated: isBlankAuthPage requires a
        //    FULLY LOADED document with every actionable marker absent, so this can never fire on a page
        //    we could otherwise drive. Runs BEFORE the breach-dialog branch (which needs signInSubmit
        //    present — mutually exclusive with a blank page) and before the auth-unknown halt. ──
        if (out === "unknown" && isBlankAuthPage(st)) {
          if (blankReloads < MAX_BLANK_RELOADS) {
            blankReloads++;
            LOG(`the page came back EMPTY after the sign-in submit (loaded, but no form / no auth controls / no markers — just boilerplate). Reloading (${blankReloads}/${MAX_BLANK_RELOADS}) and retrying — a known Workday hiccup, not an operator problem.`);
            await cdpReload();
            await settlePage(12000);
            // Wait for something ACTIONABLE rather than a single early scan — after this reload the page
            // often comes back as the FORM (the sign-in did land), and a bare scan a beat too soon reads
            // an empty document and sends the loop hunting for sign-in fields that will never appear.
            const back = await waitFor((s) => isPastAuth(s) || s.passwordInput || s.emailInput || s.hasAuthEl, await renderBudget(10000, 25000), "post-blank-reload");
            st = back.scan || (await scan()) || st;
            continue; // re-enter the auth loop against the restored page
          }
          return haltNeedsOperator(
            "blank-page-after-signin",
            `Workday kept returning an EMPTY page after the sign-in submit, through ${blankReloads} reload(s). Open the tab, refresh it, and re-run.`,
            st
          );
        }
        if (out === "success") return { ok: true, reached_form: true, stopped: "reached-form", account_created: accountCreated, verified };
        if (out === "verify") { const v = await doVerify(st); if (!v.ok) return { ...v, ok: true }; verified = true; continue; }
        if (out === "wrong_credentials") { const cr = await doCreateAccount(st); if (!cr.ok) return { ...cr, ok: true }; accountCreated = true; continue; }
        if (isAlreadyApplied(st)) return alreadyAppliedResult(); // signed in successfully → Workday shows already-applied instead of the form
        // Sign-in never resolved and the form is STILL up → a block (most likely the breach dialog) is up
        // and Enter didn't clear it. Halt SPECIFICALLY (not a vague auth-unknown) so the operator can act.
        // Do NOT name a cause we have not observed. This branch used to assert Chrome's data-breach
        // dialog, and live it was wrong — the real cause was a contaminated email box (fixed above),
        // and the confident wrong explanation is what sent the debugging the wrong way (operator
        // 2026-08-02: "this was not a password breach"). Report the fact, offer the dialog as ONE
        // possibility among the ordinary ones.
        if (st.markers.signInSubmit) return haltNeedsOperator("signin-no-outcome", "Sign-in didn't complete — the form is still up and Workday showed neither an error nor the next page. Look at the tab: something may be blocking the button (Chrome's data-breach password warning does this), or the credentials may have been rejected without a message.", st);
        return haltNeedsOperator("auth-unknown", `${st.title} — ${(st.bodyText || "").replace(/\s+/g, " ").slice(0, 160)}`, st);
      }

      // No sign-in form but a create-account affordance → create directly.
      if (st.markers.createAccountLink || st.markers.createAccountSubmit || st.markers.verifyPassword) {
        const cr = await doCreateAccount(st); if (!cr.ok) return { ...cr, ok: true }; accountCreated = true; continue;
      }

      return haltNeedsOperator("auth-unrecognized", st.title, st);
    }
    return haltNeedsOperator("auth-max-attempts", `exceeded ${maxAttempts} auth attempts`);
  };

  try {
    const attached = await cdpAttach(tabId);
    if (!attached.ok) { LOG("attach FAILED —", attached.error, "(page DevTools open on the tab? It is a second client.)"); return { ok: false, error: "attach-failed:" + attached.error }; }
    await cdpInstallPageOverrides();
    // NOTE: synthetic input stays OFF for ONBOARDING (default) — the auth screens are the one surface
    // the synthetic repertoire failed live (2026-07-25: fields read back OK but the Sign In submit
    // never fired — the auth app doesn't register native-setter values / untrusted clicks the way the
    // application form does). Trusted input costs only ~15-25s here (a few fields + clicks).
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

    if (isAlreadyApplied(st)) { const h = await handleAlreadyApplied(st); if (h.done) return h.result; st = h.scan || st; } // already signed in + applied (the common Run case) — but VERIFY: Workday says this for unsubmitted applications too
    if (isPastAuth(st)) { LOG("already on the application form — nothing to onboard."); return { ok: true, reached_form: true, stopped: "already-on-form" }; }
    if (isWorkdayMaintenance({ title: st.title, bodyText: st.bodyText, formFieldCount: st.formFieldCount, passwordInputPresent: st.passwordInput, signInButtonPresent: st.signInButtonPresent })) {
      LOG("⛔ Workday planned-maintenance page — retry after the maintenance window.");
      return { ok: true, reached_form: false, needs_operator: true, stopped: "workday-maintenance" };
    }

    // Stages 1-3 are a bounded LOOP, not a straight line (2026-07-29). A page can turn out to be the
    // job-description page after we've already moved past Stage 1 — because it rendered late, or because
    // its header "Sign In" link was mistaken for an auth screen — and the old straight-line flow had no way
    // back, so it halted on a page it knew perfectly well how to act on. Each round re-scans and re-picks.
    applyStage: for (let applyRound = 0; ; applyRound++) {
    st = (await scan()) || st;
    // ── STAGE 1: Apply ──
    const applyChain = presentApply(st);
    const target = pickApplyTarget(applyChain);
    if (target) {
      LOG(`Stage 1 — clicking "${target.label}".`);
      emitRunProgress("Starting the application", `clicking "${target.label}"`);
      const c = await clickTarget([target.sel], target.label);
      if (!c.clicked) return { ok: true, reached_form: false, needs_operator: true, stopped: "apply-click-blocked", detail: c.blockedBy || "Apply button not clickable" };
      // ESCALATE THE MECHANISM, like the Sign In press (2026-08-06). The coordinate click can report
      // success and still not register — nothing moves, and the old flow then burned the FULL 20s before
      // the applyStage loop re-issued the IDENTICAL click. So: wait SHORT first, and if nothing happened,
      // activate the button a different way. Only the wait is split; the happy path still returns the
      // instant the page advances, so this costs nothing when the first click works.
      const applyLanded = (s) => s.markers.applyManually || s.hasAuthEl || s.formFieldCount > 0;
      let w = await waitFor(applyLanded, 4000, "post-apply");
      st = w.scan || st;
      if (!applyLanded(st)) {
        const f = await cdpEval(cdpActivateBySelector, target.sel, "focus");
        if (f && f.ok) {
          LOG(`  apply fallback 1: the click did not register — focused "${f.label}" and pressing Enter.`);
          try { await cdpKeyTap(CDP_KEYS.enter); } catch (e) { /* best-effort */ }
          w = await waitFor(applyLanded, 6000, "post-apply(Enter)");
          st = w.scan || st;
        } else LOG(`  apply fallback 1 unavailable — ${(f && f.reason) || "focus failed"}.`);
      }
      if (!applyLanded(st)) {
        const d = await cdpEval(cdpActivateBySelector, target.sel, "click");
        if (d && d.ok) {
          LOG(`  apply fallback 2: activating "${d.label}" in-page via ${d.via}.`);
          w = await waitFor(applyLanded, 10000, "post-apply(in-page click)");
          st = w.scan || st;
        } else LOG(`  apply fallback 2 unavailable — ${(d && d.reason) || "eval failed"}.`);
      }
    } else if (st.markers.useMyLastApplication && !st.markers.applyManually) {
      LOG('only "Use My Last Application" is offered on this page — refusing to reuse a prior application; waiting for a manual-apply/auth path…');
    }

    // ── STAGE 2: the chooser — Autofill with Resume (a FILL run) or Apply Manually ──
    st = await scan() || st;
    // AUTOFILL WITH RESUME is preferred for a FILL run (operator, 2026-08-07): Workday parses the résumé
    // and pre-populates the application, which is what puts its own SUGGESTED skills in the Skills
    // section. The fill still treats the result as a blank form and refills it (the parse is unreliable —
    // live it left the whole address blank and answered nothing for the previously-worked question), so
    // this only ADDS Workday's parse on top; it never replaces our own fill.
    // A REHEARSE/SUBMIT run deliberately does NOT come here — it applies manually / continues, so the
    // saved skills survive and the résumé is not re-parsed.
    if (preferResumeAutofill && st.markers.autofillWithResume) {
      LOG('Stage 2 — clicking "Autofill with Resume" (first application: let Workday parse the résumé).');
      emitRunProgress("Starting the application", "Autofill with Resume");
      const AR_SEL = '[data-automation-id="autofillWithResume"]';
      const c = await clickTarget([AR_SEL], "Autofill with Resume");
      if (!c.clicked) return { ok: true, reached_form: false, needs_operator: true, stopped: "autofill-resume-blocked", detail: c.blockedBy || "Autofill with Resume not clickable" };
      // Either the résumé page appears (already signed in) or the auth screen does (Stage 3 then runs and
      // consumes the résumé page after signing in) — the same escalation shape Stage 1 and 2 both use.
      const autofillLanded = (s) => onResumeUploadPage(s) || s.hasAuthEl || (s.formFieldCount || 0) > 1;
      // A GENEROUS first wait, unlike Stage 1/2's 4s fast-first. Live (cat.wd5, hidden): the résumé page
      // had not mounted its upload input by 6s, so this timed out, the in-page fallback then reported
      // "selector not found" (the chooser was already gone — we HAD navigated), and onboarding handed the
      // page to the WALK, which attached the résumé itself and wrote a junk 1-field bundle page. Nothing
      // failed, but the résumé page belongs to onboarding: it is pre-form.
      let w = await waitFor(autofillLanded, await renderBudget(15000, 30000), "post-autofill-with-resume");
      st = w.scan || st;
      if (!autofillLanded(st)) {
        const d = await cdpEval(cdpActivateBySelector, AR_SEL, "click");
        if (d && d.ok) {
          LOG(`  autofill fallback: activating "${d.label}" in-page via ${d.via}.`);
          w = await waitFor(autofillLanded, 12000, "post-autofill-with-resume(in-page)");
          st = w.scan || st;
        } else LOG(`  autofill fallback unavailable — ${(d && d.reason) || "eval failed"}.`);
      }
      if (onResumeUploadPage(st)) {
        const r = await consumeResumeUploadPage(st);
        if (r.halt) return r.halt;
        st = r.scan || st;
        resumeAutofilled = true;
      }
    } else if (st.markers.applyManually) {
      LOG('Stage 2 — clicking "Apply Manually".');
      const AM_SEL = '[data-automation-id="applyManually"]';
      const c = await clickTarget([AM_SEL], "Apply Manually");
      if (!c.clicked) return { ok: true, reached_form: false, needs_operator: true, stopped: "apply-manually-blocked", detail: c.blockedBy || "Apply Manually not clickable" };
      // ESCALATE THE MECHANISM, exactly as Stage 1 does (2026-08-07). Stage 1 got this ladder on
      // 2026-08-06 because "the coordinate click can report success and still not register"; Stage 2
      // never did, and that gap is the ENTIRE difference on the tenants where onboarding dead-ends.
      // Live on radiancetech.wd12 AND magna.wd3 (fresh account, both hidden and "visible"): the click
      // reported success, the chooser never moved for the FULL 45s budget, and the applyStage loop then
      // re-issued the IDENTICAL click twice more before halting `backToApply` — ~135s to fail, on a
      // page whose Apply Manually is a plain <a href> that navigates fine when activated in-page.
      // The stuck state is diagnostic: the scan showed adventureButton AND applyManually AND
      // useMyLastApplication mounted together, which a cleanly-loaded chooser never shows — a
      // half-torn-down SPA transition in which the coordinate click lands on nothing live.
      // Wait SHORT first, so the happy path (waystar/cat, which land in well under 4s) is unchanged.
      const manuallyLanded = (s) => s.hasAuthEl || s.formFieldCount > 0;
      let w = await waitFor(manuallyLanded, 4000, "post-apply-manually(fast)");
      st = w.scan || st;
      // A half-torn-down chain (Apply and Apply Manually mounted together) says the coordinate click
      // landed on a dead layer, so waiting longer and re-pressing Enter cannot help — go straight to
      // activating the anchor from inside the page.
      if (!manuallyLanded(st) && applyChainStuckMixed(st)) {
        LOG("  the apply chain is in a half-torn-down state (Apply and Apply Manually are mounted together, which a healthy chooser never shows) — the click landed on a dead layer; activating in-page.");
        const d0 = await cdpEval(cdpActivateBySelector, AM_SEL, "click");
        if (d0 && d0.ok) {
          LOG(`  apply-manually recovery: activated "${d0.label}" in-page via ${d0.via}.`);
          w = await waitFor(manuallyLanded, 10000, "post-apply-manually(stuck-recovery)");
          st = w.scan || st;
        } else LOG(`  apply-manually recovery unavailable — ${(d0 && d0.reason) || "eval failed"}.`);
      }
      if (!manuallyLanded(st)) {
        const f = await cdpEval(cdpActivateBySelector, AM_SEL, "focus");
        if (f && f.ok) {
          LOG(`  apply-manually fallback 1: the click did not register — focused "${f.label}" and pressing Enter.`);
          try { await cdpKeyTap(CDP_KEYS.enter); } catch (e) { /* best-effort */ }
          w = await waitFor(manuallyLanded, 6000, "post-apply-manually(Enter)");
          st = w.scan || st;
        } else LOG(`  apply-manually fallback 1 unavailable — ${(f && f.reason) || "focus failed"}.`);
      }
      if (!manuallyLanded(st)) {
        const d = await cdpEval(cdpActivateBySelector, AM_SEL, "click");
        if (d && d.ok) {
          LOG(`  apply-manually fallback 2: activating "${d.label}" in-page via ${d.via}.`);
          w = await waitFor(manuallyLanded, 10000, "post-apply-manually(in-page click)");
          st = w.scan || st;
        } else LOG(`  apply-manually fallback 2 unavailable — ${(d && d.reason) || "eval failed"}.`);
      }
      // Nothing has landed yet — give the RENDER the budget it always had. A slow hidden-tab
      // create-account page is a different failure from a click that never registered, and only this
      // wait covers it; the ladder above just stops us spending it on a dead click three times over.
      if (!manuallyLanded(st)) {
        w = await waitFor(manuallyLanded, await renderBudget(20000, 45000), "post-apply-manually");
        st = w.scan || st;
      }
    }

    // ── STAGE 3: Auth (+ create-account + verify) ──
    st = await scan() || st;
    if (isAlreadyApplied(st)) { const h = await handleAlreadyApplied(st); if (h.done) return h.result; st = h.scan || st; } // revealed after Apply / Apply Manually — verify before halting
    if (isPastAuth(st)) { LOG("reached the form (no auth needed)."); return { ok: true, reached_form: true, stopped: "reached-form" }; }
    if (!st.hasAuthEl && !st.signInButtonPresent && st.formFieldCount === 0) {
      const w = await waitFor((s) => s.hasAuthEl || s.signInButtonPresent || s.formFieldCount > 0, 12000, "auth-or-form");
      st = w.scan || st;
      if (isPastAuth(st)) return { ok: true, reached_form: true, stopped: "reached-form" };
    }
    // A JOB-DESCRIPTION page is NOT an auth screen — even though it has a "Sign In" link (2026-07-29).
    // `signInButtonPresent` is a TEXT match over every clickable, and a Workday posting carries "Sign In"
    // in its own HEADER. So a JD page satisfied the auth condition below and sent the flow into doAuth,
    // which then waited its full budget for credential fields that were never coming. Live on a background
    // submit run: the posting came back EMPTY (`0 chars`), Stage 1 therefore found no Apply button and
    // skipped, Stage 3 fired on that header link, and the run halted `auth-form-not-rendered` 30s later —
    // while the final state showed `markers=[continueButton]`, i.e. the page had since rendered the very
    // button Stage 1 wanted. Positive evidence (an apply-chain marker) beats the absence-based text match,
    // so re-run the apply stage instead. Bounded by applyRounds; a JD page that never yields an apply
    // target falls through to the halts below exactly as before.
    if (applyRounds < MAX_APPLY_ROUNDS && onJobDescription(st)) {
      applyRounds++;
      LOG(`this is the JOB-DESCRIPTION page, not an auth screen (its header "Sign In" link is not auth chrome) — apply-chain marker(s) present: [${presentApply(st).join(", ") || "none"}]. Re-running the apply stage (round ${applyRounds}/${MAX_APPLY_ROUNDS}).`);
      continue applyStage;
    }
    if (st.hasAuthEl || st.signInButtonPresent) {
      LOG("Stage 3 — auth screen detected.");
      const a = await doAuth();
      // doAuth can discover mid-loop that we were never on an auth screen (same JD-header cause) — take
      // the hand-back and re-run the apply stage rather than reporting an auth failure.
      if (a && a.backToApply && applyRounds < MAX_APPLY_ROUNDS) {
        applyRounds++;
        LOG(`handed back from the auth stage — re-running the apply stage (round ${applyRounds}/${MAX_APPLY_ROUNDS}).`);
        continue applyStage;
      }
      return a;
    }
    if (st.formFieldCount > 0) return { ok: true, reached_form: true, stopped: "reached-form" };
    // Before giving up: this may be an employer careers page that EMBEDS a non-Workday ATS.
    // Live 2026-08-02 a Pinterest careers URL (matching no ATS host pattern, so the run arrived
    // here) carried a Greenhouse application in an iframe. A Workday page never contains a
    // Greenhouse/Lever/Ashby frame, so this can only fire off-Workday. Onboarding just REPORTS
    // what it found; the caller owns the hand-off.
    try {
      const emb = await cdpEval(atsInjFindEmbeddedForms).catch(() => null);
      const embUrl = emb && atsPickEmbeddedForm(emb.srcs, detectAts);
      const embAts = embUrl && detectAts(embUrl);
      if (embAts && embAts !== "workday") {
        LOG(`this page embeds a ${embAts} application — handing it to that pipeline: ${embUrl}`);
        return { ok: true, embeddedAts: embAts, embeddedUrl: embUrl, stopped: "embedded-ats" };
      }
    } catch (e) { LOG("embedded-form probe skipped:", String((e && e.message) || e)); }
    return haltNeedsOperator("unknown-page", `title="${st.title}" — could not find Apply/auth/form. Navigate to the job posting and re-run.`, st);
    } // end applyStage
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
    // 5b. Checkbox GROUP — several checkboxes in ONE wrapper acting as a pick-one (the OFCCP
    // disability self-ID). LOCKSTEP with cdp.js cdpPageScan.classify. The page engine has no filler
    // for it (the CDP path does), so it records as an unhandled type — same as today's "unknown",
    // but honestly typed so the review editor renders a picker instead of a textbox.
    if (wrapper.querySelectorAll('input[type="checkbox"]').length > 1) return "checkbox_group";
    // 5c. DATE composite — `dateSection*-input` spinbuttons (no type attr, so they'd count as
    // text-like and fall to "unknown"). LOCKSTEP with cdp.js cdpPageScan.classify.
    if (wrapper.querySelector('[data-automation-id^="dateSection"][data-automation-id$="-input"]')) return "date";
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
      // A Yes/No triBool (over-18, authorized_to_work_in_us, …) can render as a DROPDOWN on some tenants —
      // coerce boolean → "Yes"/"No" like the radio branch, else String(true) → "true" never matches the
      // "Yes" option and the field falls to the AI (the over-18 legally-loaded every-fill bug). LOCKSTEP
      // with fill-driver.js resolve().
      if (typeof raw === "boolean") return { candidates: raw ? ["Yes", "True"] : ["No", "False"] };
      if (isEmpty(raw)) return { skip: true };
      return { candidates: [String(raw)] };
    }
    if (widgetType === "radio") {
      // A tiered candidate list (e.g. a degree rendered as radio) passes through as the ladder — same
      // as dropdown/typeahead — else String(array) never matches (the triBool-dropdown bug's radio twin).
      if (Array.isArray(raw)) {
        const candidates = raw.map((v) => String(v)).filter((s) => s.trim() !== "");
        return candidates.length ? { candidates } : { skip: true };
      }
      if (raw === null || raw === undefined) return { skip: true };
      if (typeof raw === "boolean") return { candidates: raw ? ["Yes", "True"] : ["No", "False"] };
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
    // Clean miss → confident "No". A COMPLETE (non-empty) employer list makes non-membership safe (operator
    // 2026-07-24: "trust your list"), so the "No" no longer REQUIRES the application company — the anchor
    // only corroborates the "Yes"/overlap paths above. Without it we STILL fill "No" (your complete list
    // names no company the question asks about); the missing corroboration is noted, not a review flag. (An
    // EMPTY/unconfigured list already returned null above → stays blank+review. LOCKSTEP with fill-driver.js.)
    return { fill: "No", review: false, detail: tightC
      ? `no known employer matches the company "${co}" or appears in the question → No (clean miss vs ${employers.length} known employer(s))`
      : `no known employer appears in the question → No (clean miss vs ${employers.length} known employer(s); no application company set to corroborate)` };
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
async function attachResume(base64, filename, mime, sectionSel, confirmCeilingMs) {
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
  // The ceiling is a PARAMETER (2026-07-28): the flat 10s was tuned on a VISIBLE tab, and a hidden one
  // both uploads and repaints far slower — live on a background run this returned "file-upload-item
  // appeared but file-upload-successful did not within 10s" and HALTED the replay walk, while the same
  // job attached fine on later runs. It was never a failure, just an unfinished upload. The SW passes a
  // visibility-scaled ceiling AND re-polls afterwards (awaitResumeConfirmed), so this is the fast path,
  // not the last word. `sawItem` is what makes the distinction reportable: a row on the page means the
  // upload STARTED, which is "still going", not "broken".
  const ceiling = (typeof confirmCeilingMs === "number" && confirmCeilingMs > 0) ? confirmCeilingMs : 10000;
  const deadline = Date.now() + ceiling;
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
  // STATUS vs ERROR — and `role="alert"` is the STATUS channel, not the error channel (2026-07-29).
  // The first cut of this read treated any `[role="alert"]` text as a failure, and live it matched
  // Workday's own aria-live PROGRESS announcement — *"Kevin's Hardware Resume.pdf loading"* — so a
  // perfectly healthy in-flight upload was reported as "Workday reported an upload error", which then made
  // the SW skip the very re-poll that exists for a slow upload. dom-patterns already recorded this channel
  // announcing "…successfully uploaded", and `expandErrorSamples` already drops role=alert toasts for the
  // same reason. So: read it as a STATUS, and only call it an error when the WORDING is unambiguously one.
  // Progress wording ("loading", "uploading", "%") is POSITIVE evidence the upload is still going — it
  // upgrades sawItem, which is what tells the SW to keep waiting.
  let statusText = null, errorText = null, uploading = false;
  try {
    const nodes = Array.prototype.slice.call(findSection().querySelectorAll(
      '[data-automation-id="file-upload-error"], [data-automation-id="errorMessage"], [role="alert"], [aria-live]'));
    const texts = nodes.map((n) => (n.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    statusText = texts.length ? texts.join(" | ").slice(0, 200) : null;
    for (const t of texts) {
      if (/\b(loading|uploading|in progress|processing)\b|\d+\s*%/i.test(t)) uploading = true;
      // An ERROR needs error wording. Anything else — including a bare filename or a progress line — is not.
      if (/\b(error|failed|failure|unsuccessful|not supported|unsupported|too large|exceeds|invalid|not allowed|try again)\b/i.test(t)
          && !/success/i.test(t)) errorText = t.slice(0, 200);
    }
    // A dedicated error element is authoritative even without the wording above.
    const hardErr = findSection().querySelector('[data-automation-id="file-upload-error"]');
    if (!errorText && hardErr) {
      const t = (hardErr.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !/success/i.test(t)) errorText = t.slice(0, 200);
    }
  } catch (e) { /* diagnostics only */ }
  if (uploading) sawItem = true; // "loading" proves it started, even if no row was caught in the poll
  const secs = Math.round(ceiling / 1000);

  return {
    attached: confirmationSeen,           // confident only when the success marker rendered
    cleared,
    deletedCount,
    filesSetImmediately,
    confirmationSeen,
    confirmationVia,
    fileName,
    sawItem,                              // the SW's signal that an unconfirmed attach is worth re-polling
    errorText,
    statusText,                           // Workday's aria-live text VERBATIM — status, not a verdict
    uploading,                            // positive evidence it is still in flight ("… loading")
    detail: confirmationSeen
      ? `attached + confirmed via file-upload-successful (cleared ${deletedCount} existing)`
      : (errorText
          ? `Workday reported an upload error: "${errorText}"`
          : (uploading
              ? `upload still IN FLIGHT after ${secs}s (Workday says "${statusText}") — not confirmed yet`
              : (sawItem
                  ? `file-upload-item appeared but file-upload-successful did not within ${secs}s — upload may still be in progress${statusText ? ` (status: "${statusText}")` : ""}`
                  : `no confirmation row within ${secs}s (input.files set immediately = ${filesSetImmediately}${statusText ? `; status: "${statusText}"` : ""})`)))
  };
}

