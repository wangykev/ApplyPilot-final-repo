import { PageHeader } from "@/components/app/PageHeader";
import { MatchPanel } from "./MatchPanel";

export const dynamic = "force-dynamic";

export default function MatchPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Decide"
        title="Match score"
        description="Paste a posting and see how well your profile fits before you spend time applying. Graded only against your real background — a signal, not a gate."
      />
      <MatchPanel />
    </div>
  );
}
