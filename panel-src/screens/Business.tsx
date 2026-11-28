import { useEffect, useRef, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import { useDaguAction, useStore, RelTime } from "@fyso/panel";
import type { BizSnapshot, BizPlan } from "../api/biz";
import { Empty, Loading, Notice } from "../components/ui";
import { read, remember, remembered } from "../api/read";

const TONE:Record<string,string> = {saludable:"pill-ok", en_rango:"pill-ok", cumplido:"pill-ok", activo:"pill-accent", en_riesgo:"pill-warn", fuera_de_rango:"pill-down", dato_vencido:"pill-warn", sin_datos:"pill-unk", archivado:"pill-unk"};
// The department the person last looked at, or "" for Biz's own choice.
const LAST = "context.department";

/** Objectives, KPIs and palancas of one department, read-only. */
export function Business({onContext}:{onContext:(data:BizSnapshot|undefined)=>void}) {
  const {t, i18n} = useTranslation();
  const s = useStore();
  const action = useDaguAction<BizSnapshot>(s.backend, "ext-biz-context", "result");
  const vision = useDaguAction<BizPlan>(s.backend, "ext-biz-objective", "result");
  const initial = remembered<BizSnapshot>(`context:${remembered<string>(LAST) ?? ""}`);
  const [data, setData] = useState<BizSnapshot|undefined>(initial);
  const [departments, setDepartments] = useState<BizSnapshot["departments"]>(initial?.departments ?? []);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [plan, setPlan] = useState<BizPlan>();
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string>();
  const epoch = useRef(0), planEpoch = useRef(0);

  const refresh = async (id:string) => {
    const current = ++epoch.current;
    setFailed(undefined); setOpen(undefined); setPlan(undefined); planEpoch.current++;
    // Show what this department looked like last time while the fresh read runs.
    const cached = remembered<BizSnapshot>(`context:${id}`);
    if (cached) { setData(cached); onContext(cached); }
    setLoading(true);
    // Biz opens the only department itself, in the same read.
    const result = await read<BizSnapshot>(`context?department=${encodeURIComponent(id)}`, ()=>action.start({FYSO_BIZ_DEPARTMENT:id}));
    if (current !== epoch.current) return;
    setLoading(false);
    if (!result || !Array.isArray(result.departments)) { setFailed(result ? "biz.connectionError" : "biz.teamErrors.workflow_not_started"); return; }
    setDepartments(result.departments);
    setData(result); onContext(result);
    remember(`context:${id}`, result); remember(LAST, id);
    if (result.department && result.department !== id) remember(`context:${result.department}`, result);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ if (initial) onContext(initial); void refresh(remembered<string>(LAST) ?? ""); return ()=>{epoch.current++;planEpoch.current++;}; }, []);

  const readPlan = async (id:string) => {
    if (open === id) { setOpen(undefined); return; }
    const current = ++planEpoch.current; setOpen(id); setPlan(undefined); setPlanError(undefined); setPlanLoading(true);
    const result = await read<BizPlan>(`objective?id=${encodeURIComponent(id)}`, ()=>vision.start({FYSO_BIZ_OBJECTIVE:id}));
    if (current !== planEpoch.current) return;
    setPlanLoading(false);
    if (!result || result.objectiveId !== id) { setPlanError(result ? "biz.leversFailed" : "biz.teamErrors.workflow_not_started"); return; }
    setPlan(result);
  };

  const format = (v:number|null) => v === null ? "—" : new Intl.NumberFormat(i18n.language).format(v);
  const status = (value:string) => t(`biz.states.${value}`, {defaultValue:value || t("biz.unknown")});
  const progress = (value:number|null, target:number|null) => value === null || !target ? null : Math.max(0, Math.min(100, Math.round(value / target * 100)));
  const department = data?.department ?? "";

  return <div className="biz-stack">
    <div className="biz-toolbar">
      {departments.length > 1 && (departments.length <= 5
        ? <div className="seg" role="group" aria-label={t("biz.department")}>{departments.map(d=><button type="button" key={d.id} aria-pressed={department === d.id} onClick={()=>void refresh(d.id)}>{d.name}</button>)}</div>
        : <label className="field biz-inline">{t("biz.department")}<select className="input select" value={department} onChange={e=>void refresh(e.target.value)}><option value="">{t("biz.selectDepartment")}</option>{departments.map(d=><option value={d.id} key={d.id}>{d.name}</option>)}</select></label>)}
      {departments.length === 1 && <span className="pill pill-surface">{departments[0].name}</span>}
      <span className="grow" />
      {data && <span className="hint">{loading ? t("biz.refreshing") : <>{t("biz.updated")} <RelTime at={data.collectedAt}/></>}</span>}
      <button type="button" className="btn btn-sm btn-soft" disabled={loading} onClick={()=>void refresh(department)}>{t(loading ? "biz.loading" : "biz.refresh")}</button>
    </div>

    {failed && <Notice tone="down">{t(failed)}</Notice>}
    {!data && !failed && <Loading text={t("biz.loading")} />}
    {data && !data.department && <Empty icon="◎"><p>{t("biz.chooseDepartment")}</p></Empty>}
    {data?.department && <>
      {data.warnings.length > 0 && <Notice tone="warn">{t("biz.partial")}</Notice>}

      <section className="biz-stack" aria-labelledby="biz-kpis">
        <h2 id="biz-kpis" className="biz-h2">{t("biz.kpis")}</h2>
        {!data.kpis.length ? <p className="mute">{t("biz.kpisEmpty")}</p> :
          <div className="biz-kpi-grid">{data.kpis.map(k=><article className="card biz-kpi" key={k.id}>
            <div className="connector-heading"><span className="biz-kpi-name">{k.name}</span>{k.status && <span className={`pill ${TONE[k.status] ?? "pill-unk"}`}>{status(k.status)}</span>}</div>
            <span className="stat">{format(k.value)}{k.value !== null && k.unit && <small className="biz-unit"> {k.unit}</small>}</span>
            <span className="hint">{t("biz.target")} {t(`biz.operators.${k.operator}`, {defaultValue:k.operator})} {format(k.target)}{k.operator === "entre" && k.targetMax != null && ` – ${format(k.targetMax)}`}{k.window !== null && ` · ${t("biz.window", {count:k.window})}`}</span>
          </article>)}</div>}
      </section>

      <section className="biz-stack" aria-labelledby="biz-objectives">
        <h2 id="biz-objectives" className="biz-h2">{t("biz.objectives")}</h2>
        {!data.objectives.length && <p className="mute">{t("biz.objectivesEmpty")}</p>}
        {data.objectives.map(o=><article className="card connector-card" key={o.id}>
          <div className="connector-heading"><h3>{o.name}</h3>{o.status && <span className={`pill ${TONE[o.status] ?? "pill-unk"}`}>{status(o.status)}</span>}</div>
          {o.keyResults.map(kr=>{ const pct = progress(kr.value, kr.target); return <div className="biz-kr" key={kr.id}>
            <div className="connector-heading"><span>{kr.name}</span><span className="hint">{format(kr.value)} / {format(kr.target)}</span></div>
            <div className="biz-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label={kr.name}><span style={{width:`${pct ?? 0}%`}} /></div>
            {data.requests.filter(r=>r.krId === kr.id).map(r=><span className="hint" key={r.id}>↳ {r.name} · {status(r.status)}</span>)}
          </div>; })}
          {data.capabilities.levers === "available" && <div className="connector-actions"><button type="button" className="btn btn-sm btn-soft" aria-expanded={open === o.id} disabled={planLoading && open !== o.id} onClick={()=>void readPlan(o.id)}>{t(open === o.id ? "biz.hidePlan" : "biz.readPlan")}</button></div>}
          {open === o.id && <div className="biz-preview">
            {planLoading && <Loading card={false} text={t("biz.loadingPlan")} />}
            {planError && <Notice tone="down">{t(planError)}</Notice>}
            {plan && <>
              <p className="hint">{t(plan.paused ? "biz.paused" : "biz.active")}{plan.pending && ` · ${t("biz.pendingPlan")}`}{plan.checkin && ` · ${t("biz.checkin")}: ${plan.checkin.expectedAt}`}</p>
              {!plan.levers.length && <p className="mute">{t("biz.leversEmpty")}</p>}
              {plan.levers.map(l=><div className="biz-lever" key={l.id}>
                <div className="connector-heading"><strong>{l.name}</strong><span className="pill pill-surface">{t(`biz.assignments.${l.assignment}`, {defaultValue:l.assignment})}</span></div>
                {l.description && <p>{l.description}</p>}
                {l.hypothesis && <p className="hint">{l.hypothesis}</p>}
              </div>)}
              {plan.decisions.length > 0 && <><h4 className="biz-h2">{t("biz.decisions")}</h4>{plan.decisions.map(d=><p className="hint" key={d.id}>• {d.name}</p>)}</>}
            </>}
          </div>}
        </article>)}
      </section>
      {data.truncated && <p className="note">{t("biz.truncated")}</p>}
    </>}
  </div>;
}
