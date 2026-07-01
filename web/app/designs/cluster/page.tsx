import { DesignSwitcher } from "@/components/landings/DesignSwitcher";
import { ClusterLanding } from "@/components/landings/ClusterLanding";

export const metadata = { title: "Cluster — ApplyPilot design" };

export default function Page() {
  return (
    <>
      <DesignSwitcher current="cluster" />
      <ClusterLanding />
    </>
  );
}
