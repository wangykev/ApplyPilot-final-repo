import { DesignSwitcher } from "@/components/landings/DesignSwitcher";
import { FlightDeckLanding } from "@/components/landings/FlightDeckLanding";

export const metadata = { title: "Flight deck — ApplyPilot design" };

export default function Page() {
  return (
    <>
      <DesignSwitcher current="flight-deck" />
      <FlightDeckLanding />
    </>
  );
}
