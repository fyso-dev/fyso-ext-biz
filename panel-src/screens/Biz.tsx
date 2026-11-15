import { useEffect, useRef, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import type { BizSnapshot, BizPlan, BizStatus } from "../api/biz";
import { Teams } from "./Teams";
import { ActionButton } from "@fyso/panel";
import { External, RelTime } from "@fyso/panel";
import { useDaguAction } from "@fyso/panel";
import { useStore } from "@fyso/panel";

export function Biz() {
  const {t, i18n} = useTranslation();
  const s = useStore();
  const installed = s.extensions.data?.some(e=>e.id === "biz") ?? false;
  const bizBot = s.runtimeBots.data?.find(b=>b.name === "Biz Partner");
  const extension = s.extensions.data?.find(e=>e.id === "biz");
  const statusAction = useDaguAction<BizStatus>(s.backend,"ext-biz-team","result");
  const logout = useDaguAction<BizStatus>(s.backend,"ext-biz-team","result");
  const [connection,setConnection] = useState<BizStatus>();
  const tokenSet = connection?.connected === true;
  const readStatus = async () => {
    const result = await statusAction.start({FYSO_BIZ_OP:"status"});
    setConnection(result && typeof result.connected === "boolean" ? result : {connected:false, error:result?.error ?? "connection_failed"});
  };
  const disconnect = async () => { await logout.start({FYSO_BIZ_OP:"logout"}); await readStatus(); };
  useEffect(()=>{ setConnection(undefined); if (installed) void readStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[installed, extension?.secrets.find(secret=>secret.name === "BOT_FYSO_BIZ_TOKEN")?.set]);
  const action = useDaguAction<BizSnapshot>(s.backend,"ext-biz-context","result");
  const vision = useDaguAction<BizPlan>(s.backend,"ext-biz-objective","result");
  const [plan,setPlan] = useState<BizPlan>();
  const [planError,setPlanError] = useState(false);
  const planEpoch = useRef(0);
  const readPlan = async (id:string) => {
    const current = ++planEpoch.current; setPlan(undefined); setPlanError(false);
    const result = await vision.start({FYSO_BIZ_OBJECTIVE:id});
    if (current !== planEpoch.current) return;
    if (!result || result.objectiveId !== id) {setPlanError(true);return;}
    setPlan(result);
  };

  const [data,setData] = useState<BizSnapshot>();
  const [department,setDepartment] = useState("");
  const [departments,setDepartments] = useState<BizSnapshot["departments"]>([]);
  const [failed,setFailed] = useState(false);
  const epoch = useRef(0);
  const refresh = async (id = department) => {
    const current = ++epoch.current;
    setData(undefined); setPlan(undefined); setPlanError(false); planEpoch.current++; setFailed(false);
    const result = await action.start({FYSO_BIZ_DEPARTMENT:id});
    if (current !== epoch.current) return;
    if (!result || !Array.isArray(result.departments)) {setFailed(true); return;}
    setData(result);
    if (!id) setDepartments(result.departments);
    setDepartment(result.department);
  };
  useEffect(()=>{
    setData(undefined); setDepartments([]); setDepartment(""); setFailed(false);
    if (installed && tokenSet) void refresh("");
    return ()=>{epoch.current++;planEpoch.current++;};
    // Installation/secret changes invalidate the context; no historical Dagu
    // result is loaded as it might belong to a previous token owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[installed,tokenSet]);
  const format = (v:number|null) => v === null ? t("biz.noValue") : new Intl.NumberFormat(i18n.language).format(v);
  const status = (value:string) => t(`biz.states.${value}`, {defaultValue:value || t("biz.unknown")});
  const kpiName = (id:string) => data?.kpis.find(k=>k.id === id)?.name ?? t("biz.unknown");
  const busy = action.phase === "running";
  return <main className="page page-wide">
    <div className="page-head"><div className="grow"><h1>{t("biz.title")}</h1><p>{t("biz.subtitle")}</p></div>
      {data?.url && <External href={data.url}>{t("biz.open")}</External>}
      {installed && tokenSet && <ActionButton action={action} label={t("biz.refresh")} busyLabel={t("common.verifying")} onRun={()=>void refresh()} />}
    </div>
    {s.extensions.status === "loading" && <p role="status">{t("common.loading")}</p>}
    {s.extensions.status === "error" && <div className="banner banner-down" role="alert">{t("biz.configError")} <button className="btn btn-ghost" onClick={s.reload}>{t("common.retry")}</button></div>}
    {installed && !connection && <p role="status">{t("biz.connecting")}</p>}
    {installed && connection && !tokenSet && <section className="card biz-onboarding"><h2>{t("biz.connectTitle")}</h2><p>{t("biz.connectDescription")}</p>
      {connection.error && <p className="banner banner-down" role="alert">{t("biz.connectionError")}</p>}
      {connection.login ? <a className="btn btn-pri" href={connection.login} target="_top">{t("biz.connect")}</a> : <p>{t("biz.restart")}</p>}
      <p className="mute">{t("biz.connectScope", {url:connection.url ?? ""})}</p>
      <details><summary>{t("biz.credentialsTitle")}</summary><p>{t("biz.credentialsDescription")}</p><code>mise run secrets</code></details>
    </section>}
    {installed && tokenSet && <>
      <div className="observ-source"><span className={`pill ${data ? "pill-ok" : "pill-unk"}`} role="status">{t(data ? "biz.connected" : busy ? "biz.connecting" : "biz.disconnected")}</span>
        {data && <>{data.organization && <strong>{data.organization}</strong>}<span className="mute">{t("biz.updated")} <RelTime at={data.collectedAt}/></span><span className="mute">{t("biz.tools",{count:data.toolCount})}</span></>}
      </div>
      <p className="mute">{t("biz.scope")}{connection?.method === "oauth" && <> <button type="button" className="btn btn-ghost" disabled={logout.phase === "running"} onClick={()=>void disconnect()}>{t("biz.disconnect")}</button></>}</p>
      <Teams />
      <div className="observ-filters"><label>{t("biz.department")} <select disabled={busy || !departments.length} value={department} onChange={e=>{setDepartment(e.target.value);void refresh(e.target.value);}}><option value="">{t("biz.selectDepartment")}</option>{departments.map(d=><option value={d.id} key={d.id}>{d.name}</option>)}</select></label></div>
      {failed && <div className="banner banner-down" role="alert">{t("biz.connectionError")}</div>}
      {busy && <p role="status">{t("biz.loading")}</p>}
      {data && <>
        {data.warnings.length > 0 && <p className="banner banner-down" role="alert">{t("biz.partial")}</p>}
        {data.truncated && <p role="status">{t("biz.truncated")}</p>}
        {!data.department && <p className="card biz-onboarding">{t("biz.chooseDepartment")}</p>}
        {data.department && <>
          <section className="observ-section"><h2 className="section-title">{t("biz.kpis")}</h2><div className="observ-grid">{data.kpis.map(k=><article className="card observ-stat" key={k.id}><span>{k.name}</span><strong>{format(k.value)} {k.value !== null && k.unit}</strong><span>{status(k.status)}</span><span className="mute">{t("biz.target")}: {t(`biz.operators.${k.operator}`,{defaultValue:k.operator})} {format(k.target)}{k.operator === "entre" && k.targetMax != null && ` – ${format(k.targetMax)}`}{k.window !== null && ` · ${t("biz.window",{count:k.window})}`}</span>{k.measuredAt && <RelTime at={k.measuredAt}/>}</article>)}</div>{!data.kpis.length && <p>{t("biz.empty")}</p>}</section>
          <section className="observ-section"><h2 className="section-title">{t("biz.objectives")}</h2>{!data.objectives.length && <p>{t("biz.empty")}</p>}{data.objectives.map(o=><article className="card biz-objective" key={o.id}><div className="row"><h3 className="grow">{o.name}</h3><span className="pill pill-unk">{status(o.status)}</span><button type="button" className="btn btn-ghost" disabled={vision.phase === "running"} onClick={()=>void readPlan(o.id)}>{t("biz.readPlan")}</button></div>{o.keyResults.map(kr=><div className="biz-kr" key={kr.id}><strong>{kr.name}</strong><span>{format(kr.value)} / {format(kr.target)}</span><span className="mute">{t("biz.kpi")}: {kpiName(kr.kpiId)} · {status(kr.status)}</span>{data.requests.filter(r=>r.krId === kr.id).map(r=><p className="mute" key={r.id}>{t("biz.request")}: {r.name} · {status(r.status)}</p>)}</div>)}</article>)}</section>
        </>}
        <section className="observ-section"><h2 className="section-title">{t("biz.levers")}</h2>
          {data.capabilities.levers !== "available" ? <p className="card biz-onboarding">{t("biz.leversUnavailable")}</p> : <>
            {!plan && vision.phase !== "running" && !planError && <p>{t("biz.selectObjective")}</p>}
            {vision.phase === "running" && <p role="status">{t("biz.loadingPlan")}</p>}
            {planError && <p role="alert">{t("biz.leversFailed")}</p>}
            {plan && <><h3>{plan.name}</h3><p>{t(plan.paused ? "biz.paused" : "biz.active")}{plan.pending && ` · ${t("biz.pendingPlan")}`}</p>
              {plan.checkin && <p>{t("biz.checkin")}: {plan.checkin.expectedAt} · {status(plan.checkin.status)}</p>}
              {plan.truncated && <p>{t("biz.truncated")}</p>}
              {!plan.levers.length && <p>{t("biz.empty")}</p>}
              {plan.levers.map(l=><article className="card biz-onboarding" key={l.id}><strong>{l.name}</strong><p>{status(l.status)} · {t(`biz.assignments.${l.assignment}`,{defaultValue:l.assignment})}</p><p>{l.description}</p>{l.hypothesis && <p className="mute">{l.hypothesis}</p>}{l.requests.map(r=><p key={r.id}>{t("biz.request")}: {r.name} · {status(r.status)}</p>)}</article>)}
              <h3>{t("biz.decisions")}</h3>{!plan.decisions.length ? <p>{t("biz.empty")}</p> : plan.decisions.map(d=><p key={d.id}>{d.name} · {status(d.status)}</p>)}
            </>}
          </>}
        </section>
        <section className="observ-section"><h2 className="section-title">{t("biz.requests")}</h2>{data.capabilities.requests !== "available" ? <p>{t("biz.requestsUnavailable")}</p> : !data.requests.length ? <p>{t("biz.empty")}</p> : <div className="card"><ul className="list">{data.requests.map(r=><li className="row" key={r.id}><span className="grow">{r.name}</span><span>{status(r.status)}</span><span className="mute">{t(`biz.executors.${r.executor}`,{defaultValue:r.executor})}</span></li>)}</ul></div>}</section>
        <section className="card biz-onboarding"><h2>{t("biz.agents")}</h2><p role="status">{t(bizBot ? "biz.botReady" : "biz.botPending")}</p><p>{t("biz.agentsDescription")}</p><External href={s.project.data?.urls.omb ?? "#/bots"}>{t("top.openOmb")}</External><p className="mute">{t("biz.drafts")}</p></section>
      </>}
    </>}
  </main>;
}
