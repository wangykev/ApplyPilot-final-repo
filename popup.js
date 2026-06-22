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
      setStatus(`${resp.session_warning ? "⚠ " + resp.session_warning + "\n" : ""}CDP fill done — ${JSON.stringify(resp.counts)}, ${resp.needs_review} need review. See the service worker console.`);
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

document.getElementById("cdp-fill-page-nolock").addEventListener("click", () => {
  setStatus("CDP full-page fill (NO input-lock — oracle baseline)… compare its result table to a lock run. See [CDP-PAGE].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_PAGE", noLock: true }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false) {
      setStatus("Baseline fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Baseline (no-lock) fill done — ${JSON.stringify(resp.counts)}, ${resp.needs_review} need review${resp.audit_flagged ? `, ${resp.audit_flagged} AUDIT-flagged` : ""}. Now run WITH the lock + compare. See [CDP-PAGE].`);
    }
  });
});

document.getElementById("cdp-audit").addEventListener("click", () => {
  setStatus("CDP re-audit… re-reading the live page vs the last fill. See [CDP-AUDIT] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_AUDIT" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.ok === false && resp.error === "no-audit-data") {
      setStatus("No audit data — run a full-page CDP fill first (it records the expectations).");
    } else if (resp.ok === false) {
      setStatus("Re-audit failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Re-audit done — ${resp.checked} checked, ${resp.flagged} flagged${resp.flagged ? " (MISMATCH — see [CDP-AUDIT])" : " (page matches the last fill)"}.`);
    }
  });
});

document.getElementById("cdp-resume-recon").addEventListener("click", () => {
  setStatus("CDP resume-attach recon… probing attachResume via cdpEval. Run on the page WITH the upload (page 2). See [CDP-RESUME-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_RESUME_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.ok === false && resp.error === "no-resume") {
      setStatus("No resume stored — upload a PDF above first, then re-run.");
    } else if (resp.ok === false) {
      setStatus("Resume recon failed: " + resp.error + " — see the service worker console.");
    } else if (resp.widget_present === false) {
      setStatus("No upload widget on this page — run on the page that HAS the required upload (page 2).");
    } else {
      setStatus(`Resume recon: ${resp.attached ? "✓ attached" : "✗ not confirmed"} in ${resp.elapsed_ms}ms (${resp.visibility}). See [CDP-RESUME-RECON]. ⚠ a real file is now on the form.`);
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

// CERT-SPECIALTY RECON (M36.2): read-mostly discovery of the nested Specialties
// sub-section inside a Certification entry. Run on My Experience (page 2); minimize
// within 60s. Findings land as [CERT-SPECIALTY-RECON] in the SW console.
document.getElementById("cdp-cert-specialty-recon").addEventListener("click", () => {
  setStatus("Cert-specialty recon… open My Experience (page 2), then MINIMIZE now (60s). Findings land in the SW console as [CERT-SPECIALTY-RECON].");
  chrome.runtime.sendMessage({ type: "RUN_CDP_CERT_SPECIALTY_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Cert-specialty recon failed: " + resp.error + " — see the service worker console.");
    } else if (!resp.mounted) {
      setStatus("Recon ran but no specialty mounted — see [CERT-SPECIALTY-RECON]: check the cert entry's inside Add heading, fill the cert / re-run.");
    } else {
      setStatus(`Cert-specialty recon done (specialty entry M=${resp.specialtyIndex || "?"}). ⚠ Remove the leftover empty specialty manually on the form. Paste the [CERT-SPECIALTY-RECON] dump from the SW console.`);
    }
  });
});

// TEXTAREA RECON (M37 Part 0 — WE gate): does CDP actuation drive a Workday <textarea>?
// Run on My Experience (page 2) with ≥1 WE entry; minimize within 60s. [TEXTAREA-RECON].
document.getElementById("cdp-textarea-recon").addEventListener("click", () => {
  setStatus("WE textarea recon… open My Experience (page 2) with ≥1 Work Experience entry, then MINIMIZE now (60s). Findings land as [TEXTAREA-RECON] in the SW console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_TEXTAREA_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false && resp.error === "no-textarea") {
      setStatus("No WE roleDescription textarea found — add a Work Experience entry (page 2) and re-run.");
    } else if (resp.ok === false) {
      setStatus("Textarea recon failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Textarea recon done — insertText: ${resp.insertText}, native-setter: ${resp.nativeSetter}. Decision: ${resp.decision}. See [TEXTAREA-RECON].`);
    }
  });
});

// WEBSITES FILL (M32b): the first repeating-section fill on the CDP path —
// reconcile to N + fill each entry's url (date-free Websites). Run on My
// Experience (page 2); minimize within 60s. Results land as [CDP-WEB] in the SW console.
document.getElementById("cdp-fill-websites").addEventListener("click", () => {
  setStatus("CDP websites fill… open My Experience (page 2), then MINIMIZE now (60s). See [CDP-WEB] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_WEBSITES" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Websites fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Websites fill done — counts: ${JSON.stringify(resp.counts)}, needs review: ${resp.needs_review}. See [CDP-WEB].`);
    }
  });
});

// LANGUAGES FILL (M35): reuse the repeating-section driver for the date-free Languages section.
// Run on My Experience (page 2); minimize within 60s. Results land as [CDP-LANG] in the SW console.
document.getElementById("cdp-fill-languages").addEventListener("click", () => {
  setStatus("CDP languages fill… open My Experience (page 2), then MINIMIZE now (60s). See [CDP-LANG] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_LANGUAGES" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Languages fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Languages fill done — counts: ${JSON.stringify(resp.counts)}, needs review: ${resp.needs_review}. See [CDP-LANG].`);
    }
  });
});

// WORK EXPERIENCE FILL (M37): reuse the repeating-section driver for WE — text + currentlyWorkHere
// checkbox + M/Y dates + the roleDescription <textarea>. Run on My Experience (page 2); minimize within
// 60s. Results land as [CDP-WE] in the SW console.
document.getElementById("cdp-fill-work-experience").addEventListener("click", () => {
  setStatus("CDP work-experience fill… open My Experience (page 2), then MINIMIZE now (60s). See [CDP-WE] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_WORK_EXPERIENCE" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Work-experience fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Work-experience fill done — counts: ${JSON.stringify(resp.counts)}, needs review: ${resp.needs_review}. See [CDP-WE].`);
    }
  });
});

// EDUCATION FILL (M36): reuse the repeating-section driver for Education (incl. from/to YEAR dates).
// Run on My Experience (page 2); minimize within 60s. Results land as [CDP-EDU] in the SW console.
document.getElementById("cdp-fill-education").addEventListener("click", () => {
  setStatus("CDP education fill… open My Experience (page 2), then MINIMIZE now (60s). See [CDP-EDU] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_EDUCATION" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Education fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Education fill done — counts: ${JSON.stringify(resp.counts)}, needs review: ${resp.needs_review}. See [CDP-EDU].`);
    }
  });
});

// CERTIFICATIONS FILL (M36): reuse the repeating-section driver for Certifications (incl. issued/
// expiration M/D/Y dates). Run on My Experience (page 2); minimize within 60s. [CDP-CERT] in SW console.
document.getElementById("cdp-fill-certifications").addEventListener("click", () => {
  setStatus("CDP certifications fill… open My Experience (page 2), then MINIMIZE now (60s). See [CDP-CERT] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_CERTIFICATIONS" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Certifications fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Certifications fill done — counts: ${JSON.stringify(resp.counts)}, needs review: ${resp.needs_review}. See [CDP-CERT].`);
    }
  });
});

// DATE FILL (M34 verify): fill ONE date composite matched by the label regex (reuses
// the ta-label input) via fillDateCompositeCdp. Run on My Experience (page 2); minimize
// within 60s. Result + per-segment focus/input trace land as [CDP-DATE] in the SW console.
document.getElementById("cdp-fill-date").addEventListener("click", () => {
  const labelRegex = document.getElementById("ta-label").value.trim();
  if (!labelRegex) { setStatus("Enter a label regex first (e.g. From, To, Issued Date)."); return; }
  setStatus(`CDP date fill ("${labelRegex}")… open My Experience (page 2), then MINIMIZE now (60s). See [CDP-DATE] in the service worker console.`);
  chrome.runtime.sendMessage({ type: "RUN_CDP_FILL_DATE", labelRegex }, (resp) => {
    if (chrome.runtime.lastError || !resp) return; // popup likely closed on minimize — SW console has it all
    if (resp.ok === false && resp.error === "no-profile") {
      setStatus('No profile in storage — click "Load default profile" first.');
    } else if (resp.ok === false && resp.error === "never-hidden") {
      setStatus("INVALID run — tab never went hidden. Rerun and minimize within 60s.");
    } else if (resp.ok === false) {
      setStatus("Date fill failed: " + resp.error + " — see the service worker console.");
    } else {
      setStatus(`Date fill: ${resp.status}${resp.after ? ` — "${resp.after}"` : ""} (verified: ${resp.verified}). See [CDP-DATE].`);
    }
  });
});

document.getElementById("cdp-inputlock-recon").addEventListener("click", () => {
  setStatus("Input-lock recon… probing overlay/keydown/flag-gate. Run on a form page. See [INPUTLOCK-RECON] in the service worker console.");
  chrome.runtime.sendMessage({ type: "RUN_CDP_INPUTLOCK_RECON" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.ok === false) {
      setStatus("Input-lock recon failed: " + resp.error + " — see the service worker console.");
    } else if (resp.no_target) {
      setStatus("No text input on this page to probe — run on a form page.");
    } else {
      setStatus(`Input-lock recon done — overlay-blocks-bot: ${resp.overlay_blocks_bot}; probe3 ${resp.control_landed ? `conclusive (clear-after-dispatch lands: ${resp.clear_after_dispatch_lands})` : "INCONCLUSIVE (control didn't land — re-run)"}. See [INPUTLOCK-RECON].`);
    }
  });
});

document.getElementById("cdp-ta-stray-recon").addEventListener("click", () => {
  const labelRegex = document.getElementById("ta-label").value.trim() || "field of study";
  setStatus(`Typeahead-stray recon ("${labelRegex}")… pre-set the field to a LOWER tier ("Other") first. See [CDP-TA-STRAY] in the service worker console.`);
  chrome.runtime.sendMessage({ type: "RUN_CDP_TA_STRAY_RECON", labelRegex }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.ok === false) {
      setStatus("Stray recon failed: " + resp.error + " — see the service worker console.");
    } else if (resp.found === false) {
      setStatus("No matching typeahead on this page — run on the page with the field (page 2 for Field of Study).");
    } else {
      setStatus(`Stray recon done — ${resp.strayed ? `⚠ STRAYED "${resp.chip_initial}"→"${resp.chip_after_blur}"` : "no stray this run (race — re-run)"}. See [CDP-TA-STRAY].`);
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
