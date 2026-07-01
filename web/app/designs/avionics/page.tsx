import { DesignSwitcher } from "@/components/landings/DesignSwitcher";
import { AvionicsLanding } from "@/components/landings/AvionicsLanding";

export const metadata = { title: "Avionics — ApplyPilot design" };

export default function Page() {
  return (
    <>
      <DesignSwitcher current="avionics" />
      <AvionicsLanding />
    </>
  );
}
