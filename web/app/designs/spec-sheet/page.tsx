import { DesignSwitcher } from "@/components/landings/DesignSwitcher";
import { SpecSheetLanding } from "@/components/landings/SpecSheetLanding";

export const metadata = { title: "Spec sheet — ApplyPilot design" };

export default function Page() {
  return (
    <>
      <DesignSwitcher current="spec-sheet" />
      <SpecSheetLanding />
    </>
  );
}
