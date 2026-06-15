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

// CDP FILL (Step 2 of the CDP actuation port): fill THIS page's simple widgets
// (text/dropdown/radio/checkbox) via chrome.debugger input while hidden, using
// the M22 decision logic. Minimize within 60s of clicking; the NEEDS REVIEW
// block + per-field table land in the SW console.
document.getElementById("cdp-fill").addEventListener("click", () => {
  setStatus("CDP fill… MINIMIZE the window now (60s window). Results land in the service worker console as [CDP-FILL].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("CDP fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`CDP fill done — ${JSON.stringify(resp.counts)}, ${resp.needs_review} need review. See the service worker console.`);
    }
  });
});

// TYPEAHEAD RECON (M25 Step 1): probe one chipless typeahead on THIS page while
// hidden (filter/settle/commit/chip/banner + option-scope). Pre-filled typeaheads
// are reported read-only. Minimize within 60s; output is [TA-RECON] in the SW console.
document.getElementById("cdp-ta-recon").addEventListener("click", () => {
  setStatus("Typeahead recon… MINIMIZE the window now (60s window). Findings land in the service worker console as [TA-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_TA_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Typeahead recon failed: " + resp.error + " — see the service worker console.");
    } else if (resp.probed === false) {
      setStatus("No chipless typeahead on this page — pre-state captured. See [TA-RECON] in the SW console.");
    } else {
      setStatus(`Typeahead recon done — ${resp.errors} probe error(s). Paste the [TA-RECON] summary from the SW console.`);
    }
  });
});

// TARGETED TYPEAHEAD FILL (M25 verify harness): fill ONE typeahead matched by
// label regex through the CDP brain while hidden. Minimize within 60s; the
// result + settle trace land as [CDP-TA] in the SW console.
document.getElementById("cdp-fill-ta").addEventListener("click", () => {
  const labelRegex = document.getElementById("ta-label").value.trim();
  if (!labelRegex) { setStatus("Enter a label regex first (e.g. Field of Study)."); return; }
  setStatus(`CDP typeahead fill ("${labelRegex}")… MINIMIZE now (60s). See [CDP-TA] in the service worker console.`);
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_TA", labelRegex }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Typeahead fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Typeahead fill: ${resp.status}${resp.flag ? ` [${resp.flag}]` : ""}${resp.after ? ` — "${resp.after}"` : ""} (verified: ${resp.verified}). See [CDP-TA].`);
    }
  });
});

// OVERWRITE RECON (M27 Step 0): probe the populated-field model on a hand-seeded
// WRONG chip — searchBox-while-populated, clearSearch preserves the chip, commit
// REPLACE vs ADD. Minimize within 60s; output is [OVR-RECON] in the SW console.
document.getElementById("cdp-overwrite-recon").addEventListener("click", () => {
  setStatus("Overwrite recon… HAND-SEED a WRONG typeahead value first, then MINIMIZE now (60s). Findings land in the service worker console as [OVR-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_OVERWRITE_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Overwrite recon failed: " + resp.error + " — see the service worker console.");
    } else if (resp.probed === false) {
      setStatus("No POPULATED typeahead — hand-seed a WRONG value first, then re-run. See [OVR-RECON] in the SW console.");
    } else {
      setStatus(`Overwrite recon: commit=${resp.verdict ? resp.verdict.commitBehavior : "?"}, Commit C needed=${resp.verdict ? resp.verdict.commitCNeeded : "?"}. Paste the [OVR-RECON] summary from the SW console.`);
    }
  });
});

// SOURCE OVERWRITE RECON (M27 Step 0, source half): prove clearSourceSearch keeps
// a seeded source chip. Minimize within 60s; output is [OVR-SRC-RECON] in the SW console.
document.getElementById("cdp-source-overwrite-recon").addEventListener("click", () => {
  setStatus("Source overwrite recon… HAND-SEED a 'How did you hear' value first, then MINIMIZE now (60s). Findings land in the service worker console as [OVR-SRC-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_SOURCE_OVERWRITE_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false && resp.error === "no-candidates") {
      setStatus('No how_did_you_hear defaults — click "Load default profile" first.');
    } else if (resp.ok === false) {
      setStatus("Source overwrite recon failed: " + resp.error + " — see the service worker console.");
    } else if (resp.probed === false) {
      setStatus("No source chip — hand-seed a 'How did you hear' value first, then re-run. See [OVR-SRC-RECON].");
    } else {
      setStatus(`Source overwrite recon: clearSourceSearch keeps chip=${resp.verdict ? resp.verdict.clearSourceSearchPreservesChip : "?"}. Paste the [OVR-SRC-RECON] summary from the SW console.`);
    }
  });
});

// SOURCE RECON (tree picker, backlog C — Phase A, map-only): characterize the
// "How did you hear about us?" hierarchical picker hidden (path / tree / where
// LinkedIn lives / expand mechanism / commit-signal attrs). Never selects a leaf.
// Minimize within 60s; output is [CDP-SRC-RECON] in the SW console.
document.getElementById("cdp-source-recon").addEventListener("click", () => {
  setStatus("Source recon (map only)… MINIMIZE the window now (60s window). Findings land in the service worker console as [CDP-SRC-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_SOURCE_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Source recon failed: " + resp.error + " — see the service worker console.");
    } else if (resp.present === false) {
      setStatus("No source field on this page — navigate to My Information and re-run.");
    } else {
      setStatus(`Source recon done (${resp.path} path, ${resp.errors} probe error(s)). Paste the [CDP-SRC-RECON] summary from the SW console.`);
    }
  });
});

// SOURCE FILL (backlog C — Phase B): fill the source picker via fillSourceCdp
// hidden (candidates from defaults.how_did_you_hear, preferred LinkedIn). Minimize
// within 60s; result + commit signal land as [CDP-SRC] in the SW console.
document.getElementById("cdp-source-fill").addEventListener("click", () => {
  setStatus("Source fill (LinkedIn)… MINIMIZE now (60s). See [CDP-SRC] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_SOURCE_FILL" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false && resp.error === "no-candidates") {
      setStatus('No how_did_you_hear defaults — click "Load default profile" first.');
    } else if (resp.ok === false) {
      setStatus("Source fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Source fill: ${resp.status}${resp.after ? ` — "${resp.after}"` : ""} (verified: ${resp.verified}). See [CDP-SRC].`);
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
