import { useEffect, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import type { BizAccess } from "../api/biz";

const SETTINGS = ["extensions", "mcp_servers", "bots", "read", "write", "shell", "publish", "ai"] as const;
const ROLES = ["lider", "miembro", "lectura"];

/**
 * What this person may do here, as Fyso Biz decides it (managed access): their departments with
 * the role in each, and their framework freedom. Display only; the gates are in project-policy.cjs.
 * Returns `undefined` while loading and `null` when the project has no managed access (204).
 */
export function useBizAccess():BizAccess|null|undefined {
  const [access, setAccess] = useState<BizAccess|null>();
  useEffect(()=>{
    const controller = new AbortController();
    fetch("/api/panel-access", {cache:"no-store", signal:controller.signal}).then(async response => {
      if (!response.ok || response.status === 204) return setAccess(null);
      const data = await response.json().catch(()=>null);
      setAccess({admin:data?.admin === true, departments:Array.isArray(data?.departments) ? data.departments : [], policy:data?.policy ?? null});
    }).catch(()=>{ if (!controller.signal.aborted) setAccess(null); });
    return ()=>controller.abort();
  }, []);
  return access;
}

export function Access({access}:{access:BizAccess}) {
  const {t} = useTranslation();
  const {departments, policy, admin} = access;
  return <>
    <section className="card" aria-labelledby="biz-access-departments">
      <h2 id="biz-access-departments">{t("access.departmentsTitle")}</h2>
      <p className="mute">{t("access.departmentsIntro")}</p>
      {admin && <p className="hint">{t("access.admin")}</p>}
      {departments.length === 0
        ? <p className="mute">{t(admin ? "access.noneAdmin" : "access.none")}</p>
        : <ul className="biz-access-list">{departments.map(d => {
          const role = d.role?.id && ROLES.includes(d.role.id) ? d.role.id : null;
          return <li key={d.id} className="biz-access-row">
            <span className="avatar" aria-hidden="true">{d.name.slice(0, 2).toUpperCase()}</span>
            <div className="grow">
              <div className="biz-access-head"><strong>{d.name}</strong>
                {d.role && <span className="pill pill-surface">{role ? t(`access.role.${role}`) : (d.role.name ?? t("access.role.custom"))}</span>}</div>
              {role ? <p className="hint">{t(`access.roleHint.${role}`)}</p> : d.role && <p className="hint">{t("access.roleHint.custom")}</p>}
              {d.teams.length > 0 && <div className="biz-chips">{d.teams.map(team => <span key={team.id} className="pill pill-surface">{team.name}</span>)}</div>}
            </div>
          </li>;
        })}</ul>}
    </section>
    {policy && <section className="card" aria-labelledby="biz-access-policy">
      <h2 id="biz-access-policy">{t("access.policyTitle")} <span className="pill pill-ok">{t(`access.preset.${policy.preset}`)}</span></h2>
      <p className="mute">{t(`access.presetHint.${policy.preset}`)}</p>
      <ul className="biz-access-policy">{SETTINGS.map(key => <li key={key}>{t(`access.policy.${key}.${Math.min(Math.max(policy[key], 0), 2)}`)}</li>)}</ul>
      <p className="hint">{t("access.policyNote")}</p>
    </section>}
  </>;
}
