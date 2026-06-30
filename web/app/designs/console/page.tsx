import { DesignSwitcher } from "@/components/landings/DesignSwitcher";
import { ConsoleLanding } from "@/components/landings/ConsoleLanding";

export const metadata = { title: "Console — ApplyPilot design" };

export default function Page() {
  return (
    <>
      <DesignSwitcher current="console" />
      <ConsoleLanding />
    </>
  );
}
