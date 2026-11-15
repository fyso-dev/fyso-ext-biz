import {useEffect, useState, useTranslation} from '@fyso/panel';
import {read} from '../api/read';

type WorkStatus = {error?:string; enabled:boolean; target?:{kind:string;target:string}; available?:{id:string;title:string}[]; entries?:{id:string;state:string;at:string;target:{target:string}}[]};
export function Work() {
  const {t} = useTranslation();
  const [data,setData] = useState<WorkStatus>();
  const [error,setError] = useState(false);
  useEffect(()=>{ let active = true; void read<WorkStatus>('work', async()=>undefined).then(result=>{if (active) {setData(result); setError(!result || !!result.error);}}); return ()=>{active=false;}; },[]);
  if (error) return <p role="alert">{t('biz.workError')}</p>;
  if (!data) return <p role="status">{t('biz.loading')}</p>;
  return <section className="biz-stack">
    <h2>{t('biz.tabWork')}</h2>
    <p>{data.enabled ? t('biz.workEnabled', {target:data.target?.target}) : t('biz.workDisabled')}</p>
    <p className="hint">{t('biz.workScope')}</p>
    <h3>{t('biz.workAvailable')}</h3>
    {data.available?.length ? <ul>{data.available.map(item=><li key={item.id}>{item.title || item.id}</li>)}</ul> : <p className="mute">{t('biz.workEmpty')}</p>}
    <h3>{t('biz.workHistory')}</h3>
    {data.entries?.length ? <ul>{data.entries.map(item=><li key={item.id}>{item.id} · {item.target.target} · {t(item.state === 'sent' ? 'biz.workSent' : 'biz.workUncertain')}</li>)}</ul> : <p className="mute">{t('biz.workHistoryEmpty')}</p>}
  </section>;
}
