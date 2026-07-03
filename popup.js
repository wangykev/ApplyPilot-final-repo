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

// ── AI config (AI-0): multi-provider LLM adapter ────────────────────────────
// chrome.storage.local.llmConfig = { provider, model, apiKey, enabled }. Restore on open;
// "Save" persists; "Test connection" round-trips a trivial prompt (RUN_LLM_TEST → callLLM in
// the SW). The toggle (enabled) is the opt-in: OFF = the fill never calls the LLM (no spend).
const llmProviderEl = document.getElementById("llm-provider");
const llmModelEl = document.getElementById("llm-model");
const llmKeyEl = document.getElementById("llm-key");
const llmEnabledEl = document.getElementById("llm-enabled");
// Fill the model <select> from this provider's CURATED list (llm.js LLM_MODELS), marking the
// default. The list is exactly LLM_MODELS — a stale/retired SAVED model (e.g. gemini-2.0-flash
// from an older config) is NOT shown; selection falls back to the default, and a Save replaces it.
function populateModelOptions(provider, selected) {
  const def = LLM_DEFAULT_MODELS[provider] || "";
  const models = LLM_MODELS[provider] || [];
  llmModelEl.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m === def ? `${m} (default)` : m;
    llmModelEl.appendChild(opt);
  }
  llmModelEl.value = (selected && models.includes(selected)) ? selected : def;
}
chrome.storage.local.get("llmConfig", ({ llmConfig }) => {
  const c = llmConfig || {};
  if (c.provider) llmProviderEl.value = c.provider;
  populateModelOptions(llmProviderEl.value, c.model);
  if (c.apiKey) llmKeyEl.value = c.apiKey;
  llmEnabledEl.checked = !!c.enabled;
});
// Debug input-trace toggle — logs every CDP keystroke/click in the SW console. Saved IMMEDIATELY on
// change (no Save button — an easy on/off); cdp.js reads chrome.storage.local.debugInputTrace per run.
const debugInputTraceEl = document.getElementById("debug-input-trace");
chrome.storage.local.get("debugInputTrace", ({ debugInputTrace }) => { debugInputTraceEl.checked = !!debugInputTrace; });
debugInputTraceEl.addEventListener("change", () => chrome.storage.local.set({ debugInputTrace: debugInputTraceEl.checked }));
// On provider change, repopulate the model list + select that provider's default.
llmProviderEl.addEventListener("change", () => populateModelOptions(llmProviderEl.value));
const readLlmConfig = () => ({ provider: llmProviderEl.value, model: llmModelEl.value, apiKey: llmKeyEl.value.trim(), enabled: llmEnabledEl.checked });
document.getElementById("llm-save").addEventListener("click", async () => {
  const cfg = readLlmConfig();
  await chrome.storage.local.set({ llmConfig: cfg });
  setStatus(`AI config saved — ${cfg.provider}/${cfg.model || "(no model)"}, AI fill ${cfg.enabled ? "ON" : "OFF"}${cfg.apiKey ? "" : " (no key!)"}.`);
});
document.getElementById("llm-test").addEventListener("click", () => {
  const cfg = readLlmConfig();
  if (!cfg.apiKey) { setStatus("Enter an API key first."); return; }
  setStatus(`Testing ${cfg.provider}/${cfg.model}… see [LLM-TEST] in the service worker console.`);
  chrome.runtime.sendMessage({ type: "RUN_LLM_TEST", config: cfg }, (resp) => {
    if (chrome.runtime.lastError || !resp) { setStatus("Test failed (no response) — see the service worker console."); return; }
    setStatus(resp.ok ? `✓ AI connected — reply: "${resp.text}". Save the config to use it.` : `✗ AI test failed: ${resp.error}`);
  });
});
