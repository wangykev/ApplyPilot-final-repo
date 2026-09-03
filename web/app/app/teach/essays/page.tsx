import { PageHeader } from "@/components/app/PageHeader";
import { EssayLibrary } from "@/components/app/teach/EssayLibrary";
import { loadEssays } from "../actions";

export const dynamic = "force-dynamic";

export default async function TeachEssaysPage() {
  const doc = await loadEssays();
  return (
    <div className="space-y-8 pb-28">
      <PageHeader
        eyebrow="Get smarter"
        title="My essays"
        description="Long answers you wrote yourself. Every future essay is drafted to match this voice — and may reuse concrete facts from these, since they describe your projects in more detail than your résumé does. Rewrite a long answer on a review page and it lands here on its own."
      />
      <EssayLibrary initialDoc={doc} />
    </div>
  );
}
