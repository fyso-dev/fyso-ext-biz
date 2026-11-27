import { useEffect, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import type { BizAccess } from "../api/biz";
import { ConnectBiz } from "./Access";

type Removals = {extensions:{id:string}[]; mcp_servers:{id:string}[]; bots:{name:string}[]; teams:{department:string}[]};
type Preview = {setup:{version:string}|null; upToDate:boolean; removals:Removals; replaced:{path:string}[]; removalCount:number; digest:string; error?:string};
type Added = {added:string[]; removed:string[]};
type Changes = Added & {modified:string[]};
type PublishPreview = {version:string|null; base?:string|null; changed:boolean; blocked?:boolean; error?:string; files?:Changes; files_count?:number; bots?:Changes; extensions?:Added;
  mcp_servers?:Added; secrets?:string[]; recipients?:{count:number; changed:boolean}; framework?:string|null; checks:Record<string,string>; digest:string};
type SetupStatus = {connected:boolean; selfPublished?:string|null; frozen:boolean; secretsPending?:string[]; noAccess?:boolean; paused:{reason:string}|null; publishPaused?:{files?:string[]}|null; version:string|null; appliedAt:string|null; notices:{at:string; kind:string; text:string}[]; admin:boolean; offered:{version:string}|null};

const post = async (op:string, body?:object) => {
  const response = await fetch(`/api/ext/biz/profile/setup/${op}`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body ?? {})});
  return response.json().catch(()=>({error:"setup_failed"}));
};

/**
 * The organization's setup published in Biz: connect (with a warning that lists everything that will
 * be replaced or removed), the current state, and publishing for administrators. Display and requests
 * only; Biz and the framework decide.
 */
export function Setup({access}:{access:BizAccess|null}) {
  const {t} = useTranslation();
  const [status, setStatus] = useState<SetupStatus>();
  const [preview, setPreview] = useState<Preview>();
  const [pub, setPub] = useState<PublishPreview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ok:boolean; text:string}>();
  const [stale, setStale] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [choice, setChoice] = useState<Record<string, "ours"|"theirs">>({});
  const [notInstalled, setNotInstalled] = useState(false);
  const [noSession, setNoSession] = useState(false);
  const load = async () => {
    const response = await fetch("/api/ext/biz/profile/setup/status", {cache:"no-store"}).catch(()=>null);
    // 403: no profile session (never connected, or it expired): offer the Connect action.
    setNoSession(response?.status === 403);
    setStatus(response?.ok ? await response.json().catch(()=>undefined) : undefined);
  };
  useEffect(()=>{ void load(); }, []);
  const fail = (code?:string, detail?:string) => setMessage({ok:false, text:t(`setup.errors.${code}`, {defaultValue:t("setup.errors.setup_failed")}) + (detail ? ` (${detail})` : "")});
  const run = async (op:string, body?:object, done?:(r:any)=>void) => {
    setBusy(true); setMessage(undefined); setStale(false); setConflicts([]); setNotInstalled(false);
    const result = await post(op, body);
    setBusy(false);
    if (result.error) { fail(result.error, result.detail); setStale(result.error === "stale_base"); setNotInstalled(result.error === "setup_not_installed"); setConflicts(Array.isArray(result.files) ? result.files : []);
      if (result.error === "stale_base" || result.error === "setup_not_installed") setPub(undefined);
      // The project moved after the preview: show the new one, never publish what was not shown.
      if (result.error === "preview_stale") { const again = await post("publish-preview"); if (again.error) { setPub(undefined); fail(again.error, again.detail); } else { setPub(again); fail("preview_stale"); } }
    } else done?.(result);
    await load();
  };
  const list = (r:Removals) => [...r.extensions.map(e=>t("setup.removeExtension", {name:e.id})), ...r.mcp_servers.map(e=>t("setup.removeMcp", {name:e.id})),
    ...r.bots.map(e=>t("setup.removeBot", {name:e.name})), ...r.teams.map(e=>t("setup.removeTeam", {name:e.department}))];

  const lines = (title:string, items:string[]|undefined) => items && items.length > 0 ? <details><summary>{title}</summary><ul>{items.map(x=><li key={x}><code>{x}</code></li>)}</ul></details> : null;
  const changes = (c:Changes|undefined, label?:string) => c ? <>{label && <p><strong>{label}</strong></p>}{lines(t("setup.pub.added", {count:c.added.length}), c.added)}{lines(t("setup.pub.modified", {count:c.modified.length}), c.modified)}{lines(t("setup.pub.removed", {count:c.removed.length}), c.removed)}</> : null;
  const additions = (c:Added|undefined, label:string) => c && (c.added.length > 0 || c.removed.length > 0) ? <><p><strong>{label}</strong></p>{lines(t("setup.pub.added", {count:c.added.length}), c.added)}{lines(t("setup.pub.removed", {count:c.removed.length}), c.removed)}</> : null;

  if (!access || noSession) return <ConnectBiz />;
  if (access.reauthorizeRequired) return <ConnectBiz reauthorize />;
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
      ? <p className="hint">{status.admin && status.selfPublished && status.selfPublished === status.version ? t("setup.connectedPublisher", {version:status.version}) : t("setup.connected", {version:status.version ?? "-"})}</p>
      : !status.noAccess && !preview && <>
        <p className="hint">{status.offered ? t("setup.offered", {version:status.offered.version}) : t("setup.noneOffered")}</p>
        <button type="button" className="btn btn-pri" disabled={busy} onClick={()=>void run("preview", undefined, setPreview)}>{t("setup.connect")}</button>
      </>}
    {preview && <div role="group" aria-label={t("setup.previewTitle")}>
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
    {pub && <div role="group" aria-label={t("setup.pub.title")}>
      <h3>{t("setup.pub.title")}</h3>
      {pub.blocked
        ? <p className="banner banner-warn" role="alert">{t("setup.pub.blocked", {error:pub.error || Object.entries(pub.checks).filter(([, v])=>v === "failed").map(([k])=>k).join(", ")})}</p>
        : !pub.changed
          ? <p className="mute">{t("setup.pub.noChanges")}</p>
          : <>
            <p>{pub.base ? t("setup.pub.versions", {base:pub.base, version:pub.version}) : t("setup.pub.versionsFirst", {version:pub.version})}</p>
            {pub.files && <><p><strong>{t("setup.pub.files", {count:pub.files_count ?? 0})}</strong></p>{changes(pub.files)}</>}
            {pub.bots && (pub.bots.added.length > 0 || pub.bots.modified.length > 0 || pub.bots.removed.length > 0) && changes(pub.bots, t("setup.pub.bots"))}
            {additions(pub.extensions, t("setup.pub.extensions"))}
            {additions(pub.mcp_servers, t("setup.pub.mcp"))}
            {pub.secrets && pub.secrets.length > 0 && <><p><strong>{t("setup.pub.secrets")}</strong></p><p><code>{pub.secrets.join(", ")}</code></p></>}
            {pub.recipients && <p>{t(pub.recipients.changed ? "setup.pub.recipientsChanged" : "setup.pub.recipients", {count:pub.recipients.count})}</p>}
          </>}
      {Object.keys(pub.checks ?? {}).length > 0 && <p className="hint">{t("setup.pub.checks")}: {Object.entries(pub.checks).map(([k, v])=>`${k}: ${v}`).join(", ")}{pub.framework ? ` · ${t("setup.pub.framework", {version:pub.framework})}` : ""}</p>}
      <div className="connector-actions">
        {pub.changed && !pub.blocked && <button type="button" className="btn btn-pri" disabled={busy} onClick={()=>void run("publish", {version:pub.version, digest:pub.digest}, r=>{ setPub(undefined); setMessage({ok:true, text:r.version ? t("setup.publishedVersion", {version:r.version}) : t("setup.published")}); })}>{t("setup.pub.confirm")}</button>}
        <button type="button" className="btn btn-soft" disabled={busy} onClick={()=>setPub(undefined)}>{pub.changed && !pub.blocked ? t("setup.pub.cancel") : t("setup.pub.close")}</button>
      </div>
    </div>}
    {stale && <div className="connector-actions"><button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void run("merge", {}, ()=>setMessage({ok:true, text:t("setup.published")}))}>{t("setup.mergeAndPublish")}</button></div>}
    {notInstalled && <div className="connector-actions"><button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void run("preview", undefined, setPreview)}>{t("setup.installFirst")}</button></div>}
    {conflicts.length > 0 && <fieldset><legend>{t("setup.conflicts")}</legend><ul>{conflicts.map(f=><li key={f}><code>{f}</code>{" "}
      <label><input type="radio" name={f} checked={choice[f] === "ours"} onChange={()=>setChoice({...choice, [f]:"ours"})} /> {t("setup.keepMine")}</label>{" "}
      <label><input type="radio" name={f} checked={choice[f] === "theirs"} onChange={()=>setChoice({...choice, [f]:"theirs"})} /> {t("setup.takePublished")}</label></li>)}</ul>
      <button type="button" className="btn btn-sm btn-pri" disabled={busy || conflicts.some(f=>!choice[f])}
        onClick={()=>void run("merge", {ours:conflicts.filter(f=>choice[f] === "ours"), theirs:conflicts.filter(f=>choice[f] === "theirs")}, ()=>setMessage({ok:true, text:t("setup.published")}))}>{t("setup.resolveMerge")}</button></fieldset>}
    {status.publishPaused && <p className="banner banner-warn" role="status">{t("setup.publishPaused", {files:(status.publishPaused.files ?? []).join(", ")})}</p>}
    {status.connected && <div className="connector-actions">
      {status.admin && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void run("publish-preview", undefined, setPub)}>{t("setup.publish")}</button>}
      <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>void run("disconnect")}>{t("setup.disconnect")}</button>
    </div>}
    {status.notices.length > 0 && <><h3>{t("setup.notices")}</h3><ul>{[...status.notices].reverse().slice(0, 5).map(n=><li key={n.at+n.kind}><span className="hint">{n.at.slice(0, 16).replace("T", " ")}</span> {n.text}</li>)}</ul></>}
  </section>;
}
