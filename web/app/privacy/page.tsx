import type { Metadata } from "next";
import Link from "next/link";

/**
 * PUBLIC privacy policy. Deliberately outside /app so the middleware matcher
 * ("/app/:path*") never gates it: BOTH review processes require a policy URL that
 * is reachable with no login and no redirect.
 *
 *   - Chrome Web Store → Privacy practices tab → "Privacy policy URL".
 *   - Google OAuth verification (gmail.readonly is a RESTRICTED scope) additionally
 *     requires the policy to be hosted on the same domain as the app, to be linked
 *     from the home page, and to carry the Limited Use disclosure below.
 *
 * ⚠ Every factual claim here was read off the code, not assumed. If you change what
 * the extension stores or transmits, change this page in the same commit — a policy
 * that describes an older build is worse than no policy, because both reviews treat
 * it as a binding representation.
 */

// The published contact for privacy and data requests. Both Chrome Web Store review and
// Google OAuth verification test that this is reachable, and a bounce restarts the queue —
// so it is a real monitored mailbox, not an alias that forwards somewhere unattended.
const CONTACT_EMAIL = "wangykev@gmail.com";

const EFFECTIVE = "August 19, 2026";

export const metadata: Metadata = {
  title: "Privacy Policy — ApplyPilot",
  description:
    "What ApplyPilot stores, where it goes, and what it never does. Written against the shipping code, not a template.",
};

function Section({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-hairline pt-10">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="font-mono text-xs tracking-label text-amber-dim">{n}</span>
        <h2 className="font-display text-xl font-semibold text-ink sm:text-2xl">
          {title}
        </h2>
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-ink-dim">
        {children}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-hairline/60 py-3 last:border-0 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-6">
      <div className="font-mono text-xs uppercase tracking-label text-ink-faint">
        {label}
      </div>
      <div className="text-[15px] leading-relaxed text-ink-dim">{children}</div>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
      <Link
        href="/"
        className="font-mono text-xs uppercase tracking-label text-ink-faint transition-colors hover:text-amber"
      >
        ← ApplyPilot
      </Link>

      <header className="mb-14 mt-8">
        <p className="font-mono text-xs uppercase tracking-label text-amber">
          Privacy Policy
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold text-ink sm:text-4xl">
          What ApplyPilot stores, and where it goes
        </h1>
        <p className="mt-5 text-[15px] leading-relaxed text-ink-dim">
          ApplyPilot is a job-application assistant: a Chrome extension that fills
          application forms from a profile you write, plus a companion website where you
          keep that profile and review what the extension filled in. This page describes
          every category of data it touches. It is written against the shipping code
          rather than from a template, so it is specific — including in the places where
          the honest answer is a caveat.
        </p>
        <p className="mt-4 font-mono text-xs text-ink-faint">
          Effective {EFFECTIVE} · Applies to the ApplyPilot Chrome extension and
          applypilot.vercel.app
        </p>
      </header>

      <div className="space-y-12">
        <Section id="short" n="00" title="The short version">
          <ul className="space-y-3">
            <li className="flex gap-3">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-verified" />
              <span>
                Your data exists to fill <em>your</em> job applications. It is never
                sold, rented, brokered, or used for advertising, and it is never used to
                train anyone&apos;s models.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-verified" />
              <span>
                There is no analytics, no telemetry, no tracking pixel, and no
                third-party ad or measurement SDK in either the extension or the site.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-verified" />
              <span>
                Your account data is private to your account at the database level
                (Postgres row-level security keyed to your user id).
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
              <span>
                Two things leave our systems, and only because you asked them to: the
                application data that goes to the employer&apos;s hiring site, and — only
                if you turn the AI feature on — the prompts that go to the AI provider
                you configured with your own API key.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
              <span>
                The extension never submits an application on its own. A human approves
                every flagged value first.
              </span>
            </li>
          </ul>
        </Section>

        <Section id="collect" n="01" title="What we collect, and why">
          <p>
            All of it is data you enter or upload yourself. None of it is inferred from
            your browsing, and none of it is bought from anyone.
          </p>
          <div className="mt-6 rounded-lg border border-hairline bg-panel/60 px-5 py-2">
            <Row label="Identity &amp; contact">
              Name, preferred name, email address, phone number, and postal address.
              Used to fill the corresponding application fields.
            </Row>
            <Row label="Career history">
              Work experience, education, projects, skills, languages, certifications,
              and websites such as LinkedIn or GitHub. Used to fill those sections and to
              render your résumé.
            </Row>
            <Row label="Application answers">
              Work authorization, visa status, security clearance, and screening answers
              such as relocation willingness, earliest start date, and salary
              expectation. Used to answer the equivalent questions on a form.
            </Row>
            <Row label="Demographic self-identification">
              Gender, race and ethnicity, veteran status, and disability status, if you
              choose to enter them. These are the voluntary EEO and self-identification
              questions that US employers are required to ask. Used only to answer those
              questions. Every field is optional; leaving one blank means the extension
              declines to answer rather than guessing.
            </Row>
            <Row label="Résumé file">
              The PDF you upload. Stored so the extension can attach it to an application
              without you picking a file each time.
            </Row>
            <Row label="Hiring-site account login">
              The email and password for the employer-side account the extension signs
              into or creates on your behalf. See{" "}
              <a href="#credentials" className="text-amber hover:underline">
                section 05
              </a>{" "}
              — this one has a caveat you should read.
            </Row>
            <Row label="AI provider API keys">
              If you enable the optional AI feature, the key for the provider you choose.
              Calls are billed to your own account, not ours.
            </Row>
            <Row label="Application records">
              For each application: the company, role, posting URL, the scraped job
              description, and the per-field record of what was filled, so you can review
              it and track your applications.
            </Row>
          </div>
          <p>
            <strong className="text-ink">What we do not collect:</strong> browsing or
            search history, keystroke logs, mouse or scroll activity, geolocation, device
            fingerprints, contact lists, payment card or bank details, or government
            identifiers such as a Social Security number. The extension has no analytics
            of any kind.
          </p>
        </Section>

        <Section id="storage" n="02" title="Where it is stored">
          <p>
            <strong className="text-ink">On your own computer.</strong> The extension
            keeps your working profile, defaults, answer preferences, hiring-site login,
            and AI settings in Chrome&apos;s local extension storage, and your résumé
            bytes in the browser&apos;s IndexedDB. This data stays on your machine and is
            not synced by us across your devices. Uninstalling the extension removes it.
          </p>
          <p>
            <strong className="text-ink">In your account on our site.</strong> The
            companion site stores the same profile, plus your application records and
            résumé, in a hosted Postgres database (Supabase) with the résumé bytes in a
            private storage bucket. Every table has row-level security keyed to your
            authenticated user id, so one account cannot read another&apos;s rows. The
            database and storage are encrypted at rest by the provider, and all traffic
            to the site is over HTTPS.
          </p>
          <p>
            <strong className="text-ink">Where the site runs.</strong> The site is hosted
            on Vercel and the database on Supabase, both in the United States. If you are
            outside the US, using the service means your data is processed there.
          </p>
        </Section>

        <Section id="sharing" n="03" title="What leaves our systems">
          <p>
            Four destinations, each tied to a thing you asked for. Nothing else receives
            your data.
          </p>
          <div className="mt-6 space-y-5">
            <div className="rounded-lg border border-hairline bg-panel/60 p-5">
              <h3 className="font-display text-base font-semibold text-ink">
                1 · The employer&apos;s hiring site
              </h3>
              <p className="mt-2">
                Workday, Greenhouse, Lever, Ashby, iCIMS, and similar systems receive the
                application data you approve — because that is what applying for a job
                is. The extension acts on the page you are on; it does not send your
                profile anywhere else on the web. What the employer does with your
                application afterwards is governed by their own privacy policy, not ours.
              </p>
            </div>
            <div className="rounded-lg border border-hairline bg-panel/60 p-5">
              <h3 className="font-display text-base font-semibold text-ink">
                2 · Your AI provider —{" "}
                <span className="text-amber">optional, off by default</span>
              </h3>
              <p className="mt-2">
                The AI feature answers questions your profile does not cover. It is off
                until you enable it and supply your own API key. With it off, no request
                is made to any AI provider and no data is sent.
              </p>
              <p className="mt-3">
                With it on, a request goes directly from your browser to the provider you
                chose — Anthropic, OpenAI, or Google — containing the question text, the
                answer options offered by the form, the relevant part of the job
                description, and your profile as context.{" "}
                <strong className="text-ink">
                  Be aware that this profile context can include the demographic
                  self-identification fields in section 01 if you filled them in.
                </strong>{" "}
                If you would rather no demographic data ever reach a third-party model,
                either leave those fields blank or leave the AI feature off; the extension
                fills stated answers deterministically without any AI call. Your prompts
                are subject to the provider&apos;s own terms and retention policy.
              </p>
              <p className="mt-3">
                We store no prompt or answer text ourselves. Our usage log records only
                metadata — provider, model, token counts, cost, and whether the call
                succeeded — so you can see what your key is spending.
              </p>
            </div>
            <div className="rounded-lg border border-hairline bg-panel/60 p-5">
              <h3 className="font-display text-base font-semibold text-ink">
                3 · Google Gmail —{" "}
                <span className="text-amber">optional, off by default</span>
              </h3>
              <p className="mt-2">
                Hiring sites often email a verification code during account creation.
                With your permission, ApplyPilot can read that code so you do not have to
                switch to your inbox and copy it by hand. See{" "}
                <a href="#gmail" className="text-amber hover:underline">
                  section 04
                </a>
                .
              </p>
            </div>
            <div className="rounded-lg border border-hairline bg-panel/60 p-5">
              <h3 className="font-display text-base font-semibold text-ink">
                4 · Infrastructure providers
              </h3>
              <p className="mt-2">
                Vercel (hosting) and Supabase (database, authentication, file storage)
                process your data solely to run the service on our behalf. The optional
                job-discovery feature also fetches a public list of job postings from
                GitHub; that request carries no data about you.
              </p>
            </div>
          </div>
          <p className="rounded-lg border border-verified-dim bg-verified/5 p-5 text-ink-dim">
            <strong className="text-ink">
              We do not sell or share your personal data
            </strong>{" "}
            as those terms are defined under the CCPA and similar laws. We do not disclose
            it for advertising, cross-context behavioural advertising, profiling, credit
            or lending decisions, or to data brokers. We do not use it to train AI models,
            and we have no arrangement letting any provider train on it. We would disclose
            data only if legally compelled, and only the minimum required.
          </p>
        </Section>

        <Section id="gmail" n="04" title="Google user data and the Gmail scope">
          <p>
            This section governs the optional Gmail integration. It is off unless you
            turn it on, and you can revoke it at any time at{" "}
            <a
              href="https://myaccount.google.com/permissions"
              className="text-amber hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              myaccount.google.com/permissions
            </a>
            .
          </p>
          <div className="rounded-lg border border-hairline bg-panel/60 px-5 py-2">
            <Row label="Scope requested">
              <code className="font-mono text-[13px] text-amber">
                https://www.googleapis.com/auth/gmail.readonly
              </code>
            </Row>
            <Row label="Why this scope">
              Gmail offers no narrower read scope. Finding a verification code requires
              reading the body of the message that contains it, and there is no
              &quot;verification emails only&quot; permission to request instead.
            </Row>
            <Row label="How it is used">
              When a hiring site asks for an emailed code, ApplyPilot searches your recent
              mail for that message, extracts the code, and types it into the form. That
              is the only use.
            </Row>
            <Row label="Access is read-only">
              The permission cannot send, delete, modify, label, or archive mail, and
              ApplyPilot does not attempt to.
            </Row>
            <Row label="What is retained">
              Nothing. The code is used in the moment and discarded. Message bodies,
              subjects, senders, and attachments are never written to our database, never
              logged, and never sent to any AI provider or other third party.
            </Row>
          </div>
          <p className="rounded-lg border border-amber-dim bg-amber/5 p-5">
            <strong className="text-ink">Limited Use disclosure.</strong>{" "}
            ApplyPilot&apos;s use and transfer of information received from Google APIs
            adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              className="text-amber hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including its Limited Use requirements. Specifically, we do not transfer or
            use Google user data for serving advertising, we do not use it to train,
            improve, or develop generalised AI or machine-learning models, we allow no
            human to read it except with your explicit consent, for security purposes, to
            comply with applicable law, or in aggregated and anonymised form for internal
            operations, and we do not transfer it to third parties except as necessary to
            provide or improve this feature, for security, or to comply with law.
          </p>
        </Section>

        <Section
          id="credentials"
          n="05"
          title="Your hiring-site password — read this one"
        >
          <p>
            To sign into or create an account on an employer&apos;s hiring site,
            ApplyPilot needs that site&apos;s login. You enter it once on the Credentials
            page and the extension uses it only there.
          </p>
          <p>
            <strong className="text-ink">
              We want to be direct about how it is stored: this password is currently held
              in a recoverable form
            </strong>{" "}
            — in your browser&apos;s extension storage, and in your private row in our
            database, protected by row-level security, HTTPS in transit, and the
            provider&apos;s encryption at rest, but not additionally encrypted with a key
            only you hold. It has to be recoverable rather than hashed, because unlike a
            password you log in with, this one must be replayed into a third-party form to
            work at all. A password you can only compare against is useless for that.
          </p>
          <p>What we do to limit the blast radius:</p>
          <ul className="ml-5 list-disc space-y-2">
            <li>
              The password is never written into an application record, a review summary,
              a log line, or an error report. Those carry a placeholder instead, so the
              value cannot leak through the review or tracking features.
            </li>
            <li>
              It is never sent to any AI provider. The code paths that build AI prompts
              cannot reach it.
            </li>
            <li>
              It is typed only into the hiring site it belongs to, and the extension
              verifies afterwards that the field still holds what it wrote rather than
              reporting success blindly.
            </li>
            <li>
              It is never shown in the review interface as editable text; changing it is
              done deliberately on the Credentials page.
            </li>
          </ul>
          <p className="rounded-lg border border-signal-dim bg-signal/5 p-5">
            <strong className="text-ink">Our recommendation:</strong> use a password
            unique to your hiring-site accounts — never one you use for email, banking, or
            anything else — and treat it as you would a password stored in any browser
            password manager. You can clear it at any time from the Credentials page, and
            you can use ApplyPilot without storing one at all if you sign in yourself.
          </p>
        </Section>

        <Section id="retention" n="06" title="Retention and deletion">
          <p>
            We keep your data until you delete it — there is no benefit to us in holding
            it longer, and no archival copy kept for analytics.
          </p>
          <ul className="ml-5 list-disc space-y-2">
            <li>
              <strong className="text-ink">Local data:</strong> uninstall the extension,
              or use Chrome&apos;s &quot;Clear data&quot; for it, and the local profile,
              résumé bytes, and stored login are gone.
            </li>
            <li>
              <strong className="text-ink">Individual records:</strong> profile fields,
              applications, résumés, and the stored hiring-site login can each be edited
              or cleared from the site at any time.
            </li>
            <li>
              <strong className="text-ink">Your whole account:</strong> email{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-amber hover:underline">
                {CONTACT_EMAIL}
              </a>{" "}
              from your account address and we will delete the account and all associated
              rows, files, and usage records within 30 days. Deletion cascades by foreign
              key, so nothing is orphaned behind it.
            </li>
          </ul>
          <p>
            Deleting your ApplyPilot data does not withdraw an application you already
            submitted — that copy lives with the employer, and only they can remove it.
          </p>
        </Section>

        <Section id="rights" n="07" title="Your rights">
          <p>
            Depending on where you live, you may have the right to access, correct,
            export, or delete your personal data, to object to or restrict its processing,
            and not to be discriminated against for exercising those rights. The profile
            editor already gives you direct access and correction for everything we hold;
            for a copy or a full deletion, email{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-amber hover:underline">
              {CONTACT_EMAIL}
            </a>
            . We will respond within 30 days and will not charge you for it.
          </p>
          <p>
            Because the demographic fields in section 01 can constitute sensitive data
            (including, in the case of disability status, health-related data) under laws
            such as the GDPR, we process them only on the basis of your explicit,
            voluntary choice to enter them, for the single purpose of answering the
            employer questions they correspond to. Withdraw that consent by clearing the
            fields.
          </p>
        </Section>

        <Section id="children" n="08" title="Children">
          <p>
            ApplyPilot is for people seeking employment and is not directed at children
            under 13, and we do not knowingly collect their data. If you believe a child
            has provided us data, email us and we will delete it.
          </p>
        </Section>

        <Section id="changes" n="09" title="Changes to this policy">
          <p>
            If we change what we collect or where it goes, we will update this page and
            move the effective date. A change that materially expands how we use data
            already collected will be announced in the app before it takes effect, so you
            can leave if you disagree. The extension&apos;s permissions cannot be widened
            silently either: Chrome requires your explicit re-approval when an extension
            requests new access.
          </p>
        </Section>

        <Section id="contact" n="10" title="Contact">
          <p>
            Questions about this policy, or a request about your data:{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-amber hover:underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>
      </div>

      <footer className="mt-16 border-t border-hairline pt-8">
        <p className="font-mono text-xs text-ink-faint">
          ApplyPilot · Privacy Policy · Effective {EFFECTIVE}
        </p>
      </footer>
    </main>
  );
}
