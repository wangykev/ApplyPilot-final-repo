import { DesignSwitcher } from "@/components/landings/DesignSwitcher";
import { RadarLanding } from "@/components/landings/RadarLanding";

export const metadata = { title: "Radar — ApplyPilot design" };

export default function Page() {
  return (
    <>
      <DesignSwitcher current="radar" />
      <RadarLanding />
    </>
  );
}
