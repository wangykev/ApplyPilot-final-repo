import Link from "next/link";
import {
  FileText,
  IdCard,
  Sparkles,
  Cable,
  ListChecks,
  Activity,
  BarChart3,
  ArrowRight,
} from "lucide-react";
import { PageHeader } from "@/components/app/PageHeader";

const SETUP = [
  {
    href: "/app/resume",
    icon: FileText,
    step: "01",
    title: "Upload your resume",
    body: "Drop in a PDF. We store it for the extension to attach, and parse it into your profile.",
  },
  {
    href: "/app/profile",
    icon: IdCard,
    step: "02",
    title: "Build your profile",
    body: "Review and edit the details ApplyPilot fills from — work, education, links, and more.",
  },
  {
    href: "/app/ai",
    icon: Sparkles,
    step: "03",
    title: "Configure AI",
    body: "Pick a model and add a key so the extension can answer screening questions for you.",
  },
  {
    href: "/app/connect",
    icon: Cable,
    step: "04",
    title: "Connect the extension",
    body: "Link your installed extension and sync your resume + profile straight into it.",
  },
];

export default function OverviewPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Flight deck"
        title="Get set up"
        description="Four steps to apply on autopilot. Work through them in order — each one feeds the extension."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {SETUP.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group bezel flex flex-col p-6 transition-colors hover:border-amber/40"
          >
            <div className="flex items-center justify-between">
              <s.icon className="h-5 w-5 text-amber" strokeWidth={1.75} />
              <span className="font-mono text-xs tracking-label text-ink-faint">{s.step}</span>
            </div>
            <h2 className="mt-4 font-display text-lg font-medium">{s.title}</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-dim">{s.body}</p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-dim transition-colors group-hover:text-amber">
              Open
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Link>
        ))}
      </div>

      <div>
        <p className="eyebrow">Run &amp; track</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Link href="/app/queue" className="group bezel flex flex-col p-6 transition-colors hover:border-amber/40">
            <ListChecks className="h-5 w-5 text-amber" strokeWidth={1.75} />
            <h2 className="mt-4 font-display text-lg font-medium">Job queue</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-dim">
              Line up Workday links and let the extension work through them, one fill → review at a time.
            </p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-dim transition-colors group-hover:text-amber">
              Open <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Link>
          <Link href="/app/tracker" className="group bezel flex flex-col p-6 transition-colors hover:border-amber/40">
            <Activity className="h-5 w-5 text-amber" strokeWidth={1.75} />
            <h2 className="mt-4 font-display text-lg font-medium">Tracker</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-dim">
              Every application in one place — status, needs-review count, and your pipeline stage.
            </p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-dim transition-colors group-hover:text-amber">
              Open <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Link>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-dashed border-hairline px-6 py-4">
          <BarChart3 className="h-4 w-4 text-ink-faint" strokeWidth={1.75} />
          <span className="text-sm text-ink-dim">
            Analytics — response rates and pipeline charts — is coming next.
          </span>
        </div>
      </div>
    </div>
  );
}
