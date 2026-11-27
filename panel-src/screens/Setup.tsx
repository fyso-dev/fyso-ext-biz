import { useEffect, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import type { BizAccess } from "../api/biz";

type Removals = {extensions:{id:string}[]; mcp_servers:{id:string}[]; bots:{name:string}[]; teams:{department:string}[]};
type Preview = {setup:{version:string}|null; upToDate:boolean; removals:Removals; replaced:{path:string}[]; removalCount:number; digest:string; error?:string};
type SetupStatus = {connected:boolean; frozen:boolean; secretsPending?:string[]; noAccess?:boolean; paused:{reason:string}|null; version:string|null; appliedAt:string|null; notices:{at:string; kind:string; text:string}[]; admin:boolean; offered:{version:string}|null};

const post = async (op:string, body?:object) => {
  const response = await fetch(`/api/ext/biz/profile/setup/${op}`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body ?? {})});
  return response.json().catch(()=>({error:"setup_failed"}));
};

/**
 * The organization's setup published in Biz: connect (with a warning that lists everything that will
 * be replaced or removed), the current state, and publishing for administrators. Display and requests
 * only; Biz and the framework decide.
 */
export function Setup({access}:{access:BizAccess}) {
  const {t} = useTranslation();
  const [status, setStatus] = useState<SetupStatus>();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ok:boolean; text:string}>();
  const load = async () => { const r = await fetch("/api/ext/biz/profile/setup/status", {cache:"no-store"}).then(x=>x.ok ? x.json() : null).catch(()=>null); setStatus(r ?? undefined); };
  useEffect(()=>{ void load(); }, []);
  const fail = (code?:string) => setMessage({ok:false, text:t(`setup.errors.${code}`, {defaultValue:t("setup.errors.setup_failed")})});
  const run = async (op:string, body?:object, done?:(r:any)=>void) => {
    setBusy(true); setMessage(undefined);
    const result = await post(op, body);
    setBusy(false);
    if (result.error) fail(result.error); else done?.(result);
    await load();
  };
  const list = (r:Removals) => [...r.extensions.map(e=>t("setup.removeExtension", {name:e.id})), ...r.mcp_servers.map(e=>t("setup.removeMcp", {name:e.id})),
    ...r.bots.map(e=>t("setup.removeBot", {name:e.name})), ...r.teams.map(e=>t("setup.removeTeam", {name:e.department}))];

  if (access.reauthorizeRequired) return <section className="card"><p className="banner banner-down" role="alert">{t("access.reauthorize")}</p></section>;
  if (!status) return <section className="card"><p role="status" className="mute">{t("setup.loading")}</p></section>;
  return <section className="card biz-stack" aria-labelledby="biz-setup">
    <h2 id="biz-setup" className="biz-h2">{t("setup.title")}</h2>
    <p className="mute">{t("setup.intro")}</p>
    {status.noAccess && <p className="banner banner-warn" role="status">{t("setup.noAccess")}</p>}
    {status.frozen && <p className="banner banner-down" role="alert">{t("setup.frozen")}</p>}
    {(status.secretsPending?.length ?? 0) > 0 && <p className="banner banner-warn" role="status">{t("setup.secretsPending", {names:status.secretsPending!.join(", ")})}</p>}
    {status.paused && <p className="banner banner-warn" role="status">{t("setup.paused", {reason:status.paused.reason})}</p>}
    {message && <p role={message.ok ? "status" : "alert"} className={message.ok ? "biz-success" : "biz-error"}>{message.text}</p>}
    {status.connected
      ? <p className="hint">{t("setup.connected", {version:status.version ?? "-"})}</p>
      : !status.noAccess && !preview && <>
        <p className="hint">{status.offered ? t("setup.offered", {version:status.offered.version}) : t("setup.noneOffered")}</p>
        <button type="button" className="btn btn-pri" disabled={busy} onClick={()=>void run("preview", undefined, setPreview)}>{t("setup.connect")}</button>
      </>}
    {preview && !status.connected && <div role="group" aria-label={t("setup.previewTitle")}>
      <h3>{t("setup.previewTitle")}</h3>
      {preview.removalCount === 0 && preview.replaced.length === 0 ? <p className="mute">{t("setup.nothingLost")}</p> : <p className="banner banner-warn" role="alert">{t("setup.warning")}</p>}
      {preview.replaced.length > 0 && <><p><strong>{t("setup.replaced", {count:preview.replaced.length})}</strong></p><ul>{preview.replaced.map(f=><li key={f.path}><code>{f.path}</code></li>)}</ul></>}
      {preview.removalCount > 0 && <><p><strong>{t("setup.removed", {count:preview.removalCount})}</strong></p><ul>{list(preview.removals).map(x=><li key={x}>{x}</li>)}</ul></>}
      <p className="hint">{t("setup.snapshotNote")}</p>
      <div className="connector-actions">
        <button type="button" className="btn btn-pri" disabled={busy} onClick={()=>void run("confirm", {digest:preview.digest}, ()=>{ setPreview(undefined); setMessage({ok:true, text:t("setup.applied")}); })}>{t("setup.confirm")}</button>
        <button type="button" className="btn btn-soft" disabled={busy} onClick={()=>void run("cancel", undefined, ()=>setPreview(undefined))}>{t("setup.cancel")}</button>
      </div>
    </div>}
    {status.connected && <div className="connector-actions">
      {status.admin && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void run("publish", undefined, ()=>setMessage({ok:true, text:t("setup.published")}))}>{t("setup.publish")}</button>}
      <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>void run("disconnect")}>{t("setup.disconnect")}</button>
    </div>}
    {status.notices.length > 0 && <><h3>{t("setup.notices")}</h3><ul>{[...status.notices].reverse().slice(0, 5).map(n=><li key={n.at+n.kind}><span className="hint">{n.at.slice(0, 16).replace("T", " ")}</span> {n.text}</li>)}</ul></>}
  </section>;
}
