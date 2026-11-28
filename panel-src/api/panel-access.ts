import { useEffect, useState } from "@fyso/panel";

export const TEAM_RUN = "workflow:ext-biz-team:run";
export const PLAN_RUN = "workflow:fyso-bots-plan:run";
export const APPLY_RUN = "workflow:fyso-bots-apply:run";

type Grants = Set<string> | "unmanaged" | "failed";

export function usePanelAccess(shared?:PanelAccess) {
  const [grants, setGrants] = useState<Grants>();
  const lookup = !shared;
  useEffect(()=>{
    if (!lookup) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/panel-access", {cache:"no-store", signal:controller.signal});
        if (response.status === 204) {
          if (!controller.signal.aborted) setGrants("unmanaged");
          return;
        }
        if (!response.ok) throw Error("permissions");
        const data = await response.json();
        if (!Array.isArray(data?.capabilities)) throw Error("permissions");
        if (!controller.signal.aborted) setGrants(new Set(data.capabilities));
      } catch {
        if (!controller.signal.aborted) setGrants("failed");
      }
    };
    void load();
    return ()=>controller.abort();
  }, [lookup]);
  return shared ?? {
    loading: grants === undefined,
    failed: grants === "failed",
    can: (capability:string) => grants === "unmanaged" || (grants instanceof Set && grants.has(capability)),
  };
}

export type PanelAccess = {loading:boolean; failed:boolean; can:(capability:string)=>boolean};
