import { PageHeader } from "@/components/app/PageHeader";

export default function JobPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Per application"
        title="Job context"
        description="The company you're applying to and how you heard about it — used by the extension's employer-match and source picker."
      />
      <div className="bezel p-10 text-center text-sm text-ink-dim">
        Job context — built in M6.
      </div>
    </div>
  );
}
