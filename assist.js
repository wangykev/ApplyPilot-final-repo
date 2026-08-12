/**
 * assist.js — the popup's user-facing surface: a JD match card and two buttons.
 *
 * Deliberately separate from popup.js, which is the developer console this popup used to be. That file
 * binds ~25 element ids directly and would throw on the first missing one, so it is left untouched and
 * folded behind a disclosure; this file owns everything above it.
 *
 * It computes NOTHING. Every question — what page is this, may these buttons fire, what does this job
 * score — is answered by the service worker (ASSIST_STATE / ASSIST_MATCH / ASSIST_FILL_*), because the
 * SW is what holds the profile, the AI config and the debugger. The popup renders answers and sends
 * intent, which also means closing the popup mid-fill loses nothing: the fill is running over there.
 */

const $ = (id) => document.getElementById(id);
const el = { lamp: $("ai-lamp"), company: $("job-company"), title: $("job-title"), card: $("match-card"),
  fillForm: $("assist-fill-form"), fillPage: $("assist-fill-page"), why: $("assist-why"), result: $("assist-result") };

let STATE = null;
let BUSY = false;

// A fill can outlive the popup, so its outcome is stashed by the SW and shown on the next open. Older
// than this and it is history, not news — the operator has moved on.
const LAST_RESULT_TTL_MS = 10 * 60 * 1000;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: "sw-unreachable", detail: chrome.runtime.lastError.message }); return; }
      resolve(resp || { ok: false, error: "no-response" });
    });
  });
}

async function webOrigin() {
  const { webOrigin } = await new Promise((r) => chrome.storage.local.get("webOrigin", r));
  return webOrigin || "";
}

// ── Render ─────────────────────────────────────────────────────────────────────────────────────────

function renderHeader(state) {
  const on = state.ai && state.ai.on;
  el.lamp.className = "lamp" + (on ? " on" : "");
  el.lamp.textContent = on ? "AI on" : "AI off";
  el.lamp.title = on
    ? `AI is on (${(state.ai.provider || "?")} ${(state.ai.model || "")}). Change it on the website.`
    : "AI is off. Turn it on on the website's AI page.";
}

function renderJob(state) {
  const known = state.job || (state.score && state.score.job) || null;
  const company = (known && known.company) || state.jobCompany || "";
  const role = (known && known.title) || state.jobTitle || "";
  el.company.textContent = company || (state.host || "");
  if (role) { el.title.textContent = role; return; }
  el.title.textContent =
    state.kind === "form" ? "Application form"
      : state.kind === "review" ? "Review page"
        : state.kind === "job" ? (state.title || "Job posting")
          : "No job on this page";
}

function renderActions(state) {
  el.fillForm.disabled = !state.canFillForm || BUSY;
  el.fillPage.disabled = !state.canFillPage || BUSY;
  // Whichever button is the RIGHT one here gets the amber. On an application page that is "Fill page";
  // on a posting it is "Fill form". Only one thing is ever the obvious next move.
  const pagePrimary = state.kind === "form";
  el.fillPage.className = "act" + (pagePrimary ? " primary" : "");
  el.fillForm.className = "act" + (pagePrimary ? "" : " primary");
  // On a single-page ATS the two buttons differ in ONE way that matters to someone who has already
  // started typing: "Fill form" goes and FINDS the application (it navigates, so it reloads what's
  // open), "Fill page" fills what is in front of you and touches nothing else. Say so on the button.
  const atsHere = state.ats && state.ats !== "workday";
  el.fillPage.textContent = "Fill page";
  el.fillForm.textContent = atsHere ? "Fill form (reloads)" : "Fill form";
  el.fillForm.title = state.canFillForm
    ? (atsHere
      ? "Finds the application and fills it. Reloads the page, so anything you've typed is lost. Never submits."
      : "Fills every page through to the review page. Never submits.")
    : (state.why.fillForm || "");
  el.fillPage.title = state.canFillPage
    ? (atsHere
      ? "Fills this form where it stands — no reload, nothing you've typed is lost. You submit it."
      : "Fills this page only. You click Save & Continue.")
    : (state.why.fillPage || "");

  // ONE line of why, for whichever button is disabled — a greyed-out control with no explanation is
  // worse than no control at all.
  const why = (!state.canFillForm && state.why.fillForm) || (!state.canFillPage && state.why.fillPage) || "";
  el.why.textContent = why;
}

function meterHtml(score, verdict) {
  let s = "";
  for (let i = 1; i <= 10; i++) s += `<i class="${i <= score ? "lit" : ""}"></i>`;
  return `<div class="meter ${esc(verdict || "")}">${s}</div>`;
}

function renderCard(html) {
  el.card.hidden = false;
  el.card.innerHTML = html;
  const re = $("assist-rescore");
  if (re) re.addEventListener("click", () => runScore(true));
}

function renderScore(payload) {
  const r = payload.result || {};
  const missing = payload.missing || [];
  const verdictWord = r.verdict === "strong" ? "Strong match" : r.verdict === "moderate" ? "Moderate match" : "Weak match";
  const gapsHtml = missing.length
    ? `<div class="eyebrow section-label">Missing from your resume</div>
       <div class="chips">${missing.map((m) => `<span class="chip gap">${esc(m)}</span>`).join("")}</div>`
    : `<div class="eyebrow section-label">Missing from your resume</div>
       <div class="tiny muted">Nothing obvious — your profile covers what this posting lists.</div>`;
  renderCard(`
    <div class="score-row">
      <span class="score">${esc(r.score)}</span><span class="score-of">/10</span>
      <span class="verdict ${esc(r.verdict || "")}">${esc(verdictWord)}</span>
    </div>
    ${meterHtml(r.score, r.verdict)}
    ${gapsHtml}
    ${r.rationale ? `<p class="rationale">${esc(r.rationale)}</p>` : ""}
    <div class="tiny muted" style="margin-top:10px">
      ${payload.cached ? "Cached score" : "Scored just now"} ·
      <button class="linkish" id="assist-rescore">re-score</button>
    </div>
  `);
}

async function renderScoreError(res) {
  if (res.error === "ai-off") {
    const origin = await webOrigin();
    renderCard(`<div class="tiny muted">Turn AI on${origin ? ` from the <a href="${esc(origin)}/app/ai" target="_blank">AI page</a>` : " on the website"} to score this job against your profile.</div>`);
    return;
  }
  if (res.error === "no-jd") { el.card.hidden = true; return; } // no posting here — say nothing rather than something wrong
  renderCard(`<div class="tiny muted">Couldn't score this job — ${esc(res.detail || res.error || "unknown error")}. <button class="linkish" id="assist-rescore">try again</button></div>`);
}

// ── Actions ────────────────────────────────────────────────────────────────────────────────────────

async function runScore(force) {
  if (!STATE || !STATE.scorable) { el.card.hidden = true; return; }
  renderCard(`<div class="tiny muted"><span class="spinner"></span>Scoring this job against your profile…</div>`);
  const res = await send({ type: "ASSIST_MATCH", tabId: STATE.tabId, force: !!force });
  if (res && res.ok) {
    if (res.job) { STATE.jobCompany = res.job.company; STATE.jobTitle = res.job.title; renderJob(STATE); }
    renderScore(res);
  } else {
    await renderScoreError(res || {});
  }
}

function resultLine(cls, html) {
  el.result.innerHTML = `<div class="${cls}">${html}</div>`;
}

function renderFillResult(kind, res) {
  if (!res || res.ok === false) {
    resultLine("result-bad tiny", `<strong>Didn't fill.</strong> ${esc((res && (res.detail || res.error)) || "unknown error")}`);
    return;
  }
  if (kind === "page") {
    const left = res.left_for_you || [];
    // A Workday page is one of several and you advance it; an ATS form is the whole application and you
    // send it. Same fill, different next step — so say the right one rather than a generic "check it".
    const next = res.mode === "ats" ? "Check it, then submit it yourself." : "Check it, then click Save &amp; Continue yourself.";
    const head = `<strong>Filled ${esc(res.filled || 0)} field${res.filled === 1 ? "" : "s"}.</strong> ${next}`;
    const tail = left.length
      ? `<div class="tiny muted" style="margin-top:4px">${esc(left.length)} left for you${res.ai_on ? "" : " (AI is off, so anything needing it stayed blank)"}:</div>
         <ul class="list">${left.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`
      : "";
    resultLine(left.length ? "result-warn tiny" : "result-ok tiny", head + tail);
    return;
  }
  // Fill form — the walk's own outcome, said plainly.
  const w = res.walk || {};
  if (w.stopped === "reached-review" || w.reached_review) {
    resultLine("result-ok tiny", `<strong>Filled through to the review page.</strong> Nothing was submitted — read it and submit when you're happy. I'll add it to your tracker as filled manually.`);
    return;
  }
  if (res.walked === false) {
    resultLine("result-warn tiny", `<strong>Stopped before the form.</strong> ${esc(res.detail || res.stopped || "See the service-worker console.")}`);
    return;
  }
  resultLine("result-warn tiny",
    `<strong>Stopped on page ${esc(w.nav_timeout_page || w.pages_filled || "?")}.</strong> ${esc(w.stopped || "")} — open the tab and see what it's asking for.`);
}

async function doFill(kind) {
  if (BUSY) return;
  BUSY = true;
  renderActions(STATE);
  const what = kind === "page" ? "Filling this page" : "Filling the form";
  resultLine("result-warn tiny", `<span class="spinner"></span>${what}… you can close this popup — it keeps going.`);
  const res = await send({ type: kind === "page" ? "ASSIST_FILL_PAGE" : "ASSIST_FILL_FORM", tabId: STATE.tabId });
  BUSY = false;
  renderFillResult(kind, res);
  // The page has changed under us (fields filled, maybe a new page) — re-read so the buttons match it.
  const fresh = await send({ type: "ASSIST_STATE", tabId: STATE.tabId });
  if (fresh && fresh.ok) { STATE = Object.assign(fresh, { jobCompany: STATE.jobCompany, jobTitle: STATE.jobTitle }); renderJob(STATE); }
  renderActions(STATE);
}

// ── Boot ───────────────────────────────────────────────────────────────────────────────────────────

(async function boot() {
  const state = await send({ type: "ASSIST_STATE" });
  if (!state || !state.ok) {
    el.title.textContent = "Can't read this tab";
    el.why.textContent = (state && state.detail) || "Open a job posting or an application page.";
    return;
  }
  STATE = state;
  renderHeader(state);
  renderJob(state);
  renderActions(state);

  // A fill that finished after the popup closed still gets reported — once.
  const { assistLast } = await new Promise((r) => chrome.storage.local.get("assistLast", r));
  if (assistLast && Date.now() - assistLast.at < LAST_RESULT_TTL_MS && assistLast.tabId === state.tabId) {
    renderFillResult(assistLast.kind, assistLast.result);
  }

  if (state.score) renderScore(state.score);
  else if (state.scorable) runScore(false);
  else el.card.hidden = true;
})();

el.fillPage.addEventListener("click", () => doFill("page"));
el.fillForm.addEventListener("click", () => doFill("form"));
