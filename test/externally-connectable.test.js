"use strict";
// `externally_connectable` — who is allowed to drive the extension.
//
// Chrome injects `chrome.runtime` into a page ONLY if its origin matches one of these patterns. That
// makes this field two things at once, and the tests below pin both:
//
//   1. A DEPLOY TRIPWIRE. The list is localhost-only today, so the moment the site is deployed anywhere
//      else every extension feature goes quiet — no sync, no Run, and no self-healing of a rejected
//      report, which is the one that silently loses a completed run. Nothing throws; the page just
//      behaves as though no extension exists. web/lib/extension.ts now NAMES that cause instead of
//      telling the user to reinstall, but the real fix is adding the production origin here.
//
//   2. A SECURITY BOUNDARY. Every listed origin can send the extension messages that write the profile,
//      read the review bundle, and START A RUN. So the obvious "fix" for (1) — a host wildcard like
//      `https://*.vercel.app/*` — would hand that to every site on a shared hosting domain. Pin it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const matches = (manifest.externally_connectable && manifest.externally_connectable.matches) || [];

test("localhost stays connectable — the dev loop depends on it", () => {
  assert.ok(matches.some((m) => /localhost/.test(m)), `no localhost pattern in ${JSON.stringify(matches)}`);
});

test("no pattern grants message access to a whole shared host or the entire web", () => {
  for (const m of matches) {
    assert.ok(!/^\*:\/\/\*\/\*$/.test(m) && !/^https?:\/\/\*\/\*$/.test(m),
      `${m} matches EVERY site — externally_connectable senders can start runs and write the profile`);
    // A wildcard directly under a public suffix-ish host (…//*.something.tld) is the dangerous shape:
    // every tenant of that hosting provider becomes a trusted sender.
    const host = (m.match(/^https?:\/\/([^/]+)/) || [])[1] || "";
    if (host.startsWith("*.")) {
      const labels = host.slice(2).split(".");
      assert.ok(labels.length > 2,
        `${m} wildcards an entire hosting domain — every site on ${host.slice(2)} could drive the extension. `
        + "List the exact production origin instead.");
    }
  }
});

test("every listed origin is explicit enough to audit", () => {
  assert.ok(matches.length > 0, "an empty list disables the website→extension bridge entirely");
  for (const m of matches) {
    assert.match(m, /^https?:\/\//, `${m} should pin a scheme — an unscoped pattern is wider than it looks`);
  }
});
