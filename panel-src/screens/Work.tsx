import {useEffect, useRef, useState, useTranslation, useStore, useDaguAction} from '@fyso/panel';
import {read} from '../api/read';
import type {BizSnapshot, BizPlan} from '../api/biz';

type WorkStatus = {error?:string; identity?:string; enabled:boolean; target?:{kind:string;target:string}; available?:{id:string;title:string}[]; entries?:{id:string;state:string;at:string;target:{target:string}}[]};
export function Work() {
  const {t} = useTranslation(), store = useStore();
  const config = useDaguAction<{ok:boolean}>(store.backend, 'ext-biz-dispatch-config', 'result');
  const [data,setData] = useState<WorkStatus>(), [context,setContext] = useState<BizSnapshot>(), [plan,setPlan] = useState<BizPlan>();
  const [department,setDepartment] = useState(''), [objective,setObjective] = useState(''), [anchor,setAnchor] = useState(''), [title,setTitle] = useState(''), [instructions,setInstructions] = useState(''), [bot,setBot] = useState('');
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [created,setCreated] = useState('');
  const objectiveEpoch = useRef(0), contextEpoch = useRef(0);
  const load = async () => { const value = await read<WorkStatus>('work', async()=>undefined); if (!value || value.error) setError('workError'); else {setData(value); setBot(value.target?.kind === 'bot' ? value.target.target : '');} };
  const loadContext = async (id:string) => { const current = ++contextEpoch.current; const value = await read<BizSnapshot>(`context?department=${encodeURIComponent(id)}`,async()=>undefined); if (current !== contextEpoch.current) return; if (!value || !Array.isArray(value.departments)) {setError('workError'); return;} setContext(value); setDepartment(value.department || id); };
  useEffect(()=>{void load(); void loadContext(''); return ()=>{objectiveEpoch.current++; contextEpoch.current++;};},[]);
  const chooseObjective = async (id:string) => {const current = ++objectiveEpoch.current; setObjective(id); setAnchor(''); setPlan(undefined); if (id) {const p = await read<BizPlan>(`objective?id=${encodeURIComponent(id)}`,async()=>undefined); if (current === objectiveEpoch.current && p?.objectiveId === id) setPlan(p);}};
  const save = async () => {setBusy(true); setError(''); const result = await config.start({FYSO_BIZ_TARGET:bot}); setBusy(false); if (!result?.ok) setError('workConfigError'); else await load();};
  const create = async (event:React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setCreated('');
    const payload = {department, title, instructions, ...(anchor.startsWith('kr:') ? {kr:anchor.slice(3)} : anchor.startsWith('lever:') ? {lever:anchor.slice(6)} : {})};
    try {const response = await fetch('/api/ext/biz/work', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload)}); const result = await response.json(); if (!response.ok || result.error) setError(result.error === 'tool_denied' || result.error === 'invalid_input' ? 'workCreateDenied' : 'workCreateUncertain'); else {setCreated(result.id); setTitle(''); setInstructions(''); await load();}} catch {setError('workCreateUncertain');} finally {setBusy(false);}
  };
  if (!data || !context) return <p role={error ? 'alert' : 'status'}>{t(error ? `biz.${error}` : 'biz.loading')}</p>;
  const selected = context.objectives.find(o=>o.id===objective);
  return <section className="biz-stack">
    <h2>{t('biz.tabWork')}</h2>{error && <p role="alert">{t(`biz.${error}`)}</p>}
    <p>{data.enabled ? t('biz.workEnabled', {target:data.target?.target}) : t('biz.workDisabled')}</p>
    <label className="field">{t('biz.workBot')}<select className="input select" value={bot} onChange={e=>setBot(e.target.value)}><option value="">{t('biz.workNoBot')}</option>{store.runtimeBots.data?.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
    <button type="button" className="btn btn-soft" disabled={busy || store.runtimeBots.status !== 'ok'} onClick={()=>void save()}>{t('biz.workSaveBot')}</button>
    <p className="hint">{t('biz.workScope')}</p>
    <form className="biz-stack" onSubmit={e=>void create(e)}><h3>{t('biz.workCreate')}</h3>
      <p className="hint">{t('biz.workDestination',{identity:data.identity})}</p>
      <label className="field">{t('biz.department')}<select required className="input select" value={department} onChange={e=>{objectiveEpoch.current++; setObjective(''); setPlan(undefined); setAnchor(''); void loadContext(e.target.value);}}><option value="">{t('biz.selectDepartment')}</option>{context.departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label className="field">{t('biz.workObjective')}<select className="input select" value={objective} onChange={e=>void chooseObjective(e.target.value)}><option value="">{t('biz.workOptional')}</option>{context.objectives.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      {objective && <label className="field">{t('biz.workAnchor')}<select required className="input select" value={anchor} onChange={e=>setAnchor(e.target.value)}><option value="">{t('biz.workOptional')}</option>{selected?.keyResults.map(k=><option key={k.id} value={`kr:${k.id}`}>{k.name}</option>)}{plan?.levers.filter(l=>l.status==='aprobada').map(l=><option key={l.id} value={`lever:${l.id}`}>{l.name}</option>)}</select></label>}
      <label className="field">{t('biz.workTitle')}<input required className="input" value={title} onChange={e=>setTitle(e.target.value)} /></label>
      <label className="field">{t('biz.workInstructions')}<textarea required className="input" value={instructions} onChange={e=>setInstructions(e.target.value)} /></label>
      <button className="btn btn-pri" disabled={busy || !data.identity}>{t('biz.workCreate')}</button>{created && <p role="status">{t('biz.workCreated',{id:created})}</p>}
    </form>
    <h3>{t('biz.workAvailable')}</h3>{data.available?.length ? <ul>{data.available.map(item=><li key={item.id}>{item.title || item.id}</li>)}</ul> : <p className="mute">{t('biz.workEmpty')}</p>}
    <h3>{t('biz.workHistory')}</h3>{data.entries?.length ? <ul>{data.entries.map(item=><li key={item.id}>{item.id} · {item.target.target} · {t(item.state === 'sent' ? 'biz.workSent' : 'biz.workUncertain')}</li>)}</ul> : <p className="mute">{t('biz.workHistoryEmpty')}</p>}
  </section>;
}
