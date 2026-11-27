import {useEffect, useRef, useState, useTranslation, useStore, useDaguAction} from '@fyso/panel';
import {read} from '../api/read';
import type {BizSnapshot, BizPlan} from '../api/biz';
import {Loading, Notice, Section} from '../components/ui';

type WorkStatus = {error?:string; identity?:string; enabled:boolean; target?:{kind:string;target:string}; available?:{id:string;title:string}[]; entries?:{id:string;state:string;at:string;target:{target:string}}[]};
export function Work() {
  const {t} = useTranslation(), store = useStore();
  const config = useDaguAction<{ok:boolean}>(store.backend, 'ext-biz-dispatch-config', 'result');
  const [data,setData] = useState<WorkStatus>(), [context,setContext] = useState<BizSnapshot>(), [plan,setPlan] = useState<BizPlan>();
  const [department,setDepartment] = useState(''), [objective,setObjective] = useState(''), [anchor,setAnchor] = useState(''), [title,setTitle] = useState(''), [instructions,setInstructions] = useState(''), [bot,setBot] = useState('');
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [created,setCreated] = useState(''), [contextReady,setContextReady] = useState(false);
  const objectiveEpoch = useRef(0), contextEpoch = useRef(0);
  const load = async () => { const value = await read<WorkStatus>('work', async()=>undefined); if (!value || value.error) setError('workError'); else {setData(value); setBot(value.target?.kind === 'bot' ? value.target.target : '');} };
  const loadContext = async (id:string) => { const current = ++contextEpoch.current; setContextReady(false); const value = await read<BizSnapshot>(`context?department=${encodeURIComponent(id)}`,async()=>undefined); if (current !== contextEpoch.current) return; if (!value || !Array.isArray(value.departments)) {setError('workError'); return;} setContext(value); setDepartment(value.department || id); setContextReady(true); };
  useEffect(()=>{void load(); void loadContext(''); return ()=>{objectiveEpoch.current++; contextEpoch.current++;};},[]);
  const chooseObjective = async (id:string) => {const current = ++objectiveEpoch.current; setObjective(id); setAnchor(''); setPlan(undefined); if (id) {const p = await read<BizPlan>(`objective?id=${encodeURIComponent(id)}`,async()=>undefined); if (current === objectiveEpoch.current && p?.objectiveId === id) setPlan(p);}};
  const save = async () => {setBusy(true); setError(''); const result = await config.start({FYSO_BIZ_TARGET:bot}); setBusy(false); if (!result?.ok) setError('workConfigError'); else await load();};
  const create = async (event:React.FormEvent) => {
    event.preventDefault(); if (!contextReady) return; setBusy(true); setError(''); setCreated('');
    const payload = {department, title, instructions, ...(anchor.startsWith('kr:') ? {kr:anchor.slice(3)} : anchor.startsWith('lever:') ? {lever:anchor.slice(6)} : {})};
    try {const response = await fetch('/api/ext/biz/work', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload)}); const result = await response.json(); if (!response.ok || result.error) setError(result.error === 'tool_denied' || result.error === 'invalid_input' ? 'workCreateDenied' : 'workCreateUncertain'); else {setCreated(result.id); setTitle(''); setInstructions(''); await load();}} catch {setError('workCreateUncertain');} finally {setBusy(false);}
  };
  if (!data || !context) return error ? <Notice tone="down">{t(`biz.${error}`)}</Notice> : <Loading text={t('biz.loading')} />;
  const selected = context.objectives.find(o=>o.id===objective);
  return <Section id="biz-work" title={t('biz.tabWork')}>
    {error && <Notice tone="down">{t(`biz.${error}`)}</Notice>}
    <Notice tone={data.enabled ? 'ok' : 'info'}>{data.enabled ? t('biz.workEnabled', {target:data.target?.target}) : t('biz.workDisabled')}</Notice>
    <label className="field">{t('biz.workBot')}<select className="input select" value={bot} onChange={e=>setBot(e.target.value)}><option value="">{t('biz.workNoBot')}</option>{store.runtimeBots.data?.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
    <div className="connector-actions"><button type="button" className="btn btn-soft" disabled={busy || store.runtimeBots.status !== 'ok'} onClick={()=>void save()}>{t('biz.workSaveBot')}</button></div>
    <p className="hint">{t('biz.workScope')}</p>
    <form className="biz-subsection" onSubmit={e=>void create(e)}><h3>{t('biz.workCreate')}</h3>
      <p className="hint">{t('biz.workDestination',{identity:data.identity})}</p>
      <label className="field">{t('biz.department')}<select required className="input select" value={department} onChange={e=>{objectiveEpoch.current++; setDepartment(e.target.value); setContextReady(false); setObjective(''); setPlan(undefined); setAnchor(''); void loadContext(e.target.value);}}><option value="">{t('biz.selectDepartment')}</option>{context.departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label className="field">{t('biz.workObjective')}<select disabled={!contextReady} className="input select" value={objective} onChange={e=>void chooseObjective(e.target.value)}><option value="">{t('biz.workOptional')}</option>{context.objectives.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      {objective && <label className="field">{t('biz.workAnchor')}<select required disabled={!contextReady} className="input select" value={anchor} onChange={e=>setAnchor(e.target.value)}><option value="">{t('biz.workOptional')}</option>{selected?.keyResults.map(k=><option key={k.id} value={`kr:${k.id}`}>{k.name}</option>)}{plan?.levers.filter(l=>l.status==='aprobada').map(l=><option key={l.id} value={`lever:${l.id}`}>{l.name}</option>)}</select></label>}
      <label className="field">{t('biz.workTitle')}<input required className="input" value={title} onChange={e=>setTitle(e.target.value)} /></label>
      <label className="field">{t('biz.workInstructions')}<textarea required className="input textarea" rows={4} value={instructions} onChange={e=>setInstructions(e.target.value)} /></label>
      <div className="connector-actions"><button type="submit" className="btn btn-pri" disabled={busy || !contextReady || !data.identity}>{t('biz.workCreate')}</button></div>{created && <Notice tone="ok">{t('biz.workCreated',{id:created})}</Notice>}
    </form>
    <div className="biz-subsection"><h3>{t('biz.workAvailable')}</h3>{data.available?.length ? <ul className="card list biz-work-list">{data.available.map(item=><li key={item.id} className="row">{item.title || item.id}</li>)}</ul> : <p className="mute">{t('biz.workEmpty')}</p>}</div>
    <div className="biz-subsection"><h3>{t('biz.workHistory')}</h3>{data.entries?.length ? <ul className="card list biz-work-list">{data.entries.map(item=><li key={item.id} className="row"><span className="grow ellipsis">{item.id} · {item.target.target}</span><span className={`pill ${item.state === 'sent' ? 'pill-ok' : 'pill-warn'}`}>{t(item.state === 'sent' ? 'biz.workSent' : 'biz.workUncertain')}</span></li>)}</ul> : <p className="mute">{t('biz.workHistoryEmpty')}</p>}</div>
  </Section>;
}
