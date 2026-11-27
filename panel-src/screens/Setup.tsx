import { RelTime, useEffect, useState, useTranslation } from "@fyso/panel";
import type { BizAccess } from "../api/biz";
import { ConnectBiz } from "./Access";
import { ChangeBadge, ChangeList, Loading, Notice, Section, StatRow, type ChangeKind } from "../components/ui";

type Removals = {extensions:{id:string}[]; mcp_servers:{id:string}[]; bots:{name:string}[]; teams:{department:string}[]};
type Preview = {setup:{version:string}|null; upToDate:boolean; removals:Removals; replaced:{path:string}[]; removalCount:number; digest:string; error?:string};
type Added = {added:string[]; removed:string[]};
type Changes = Added & {modified:string[]};
type PublishPreview = {version:string|null; base?:string|null; changed:boolean; blocked?:boolean; error?:string; files?:Changes; files_count?:number; bots?:Changes; extensions?:Added;
  mcp_servers?:Added; secrets?:string[]; recipients?:{count:number; changed:boolean}; framework?:string|null; checks:Record<string,string>; digest:string};
type SetupStatus = {connected:boolean; selfPublished?:string|null; frozen:boolean; secretsPending?:string[]; noAccess?:boolean; paused:{reason:string}|null; publishPaused?:{files?:string[]}|null; version:string|null; appliedAt:string|null; notices:{at:string; kind:string; text:string}[]; admin:boolean; offered:{version:string}|null};

const KINDS:ChangeKind[] = ["added", "modified", "removed"];
const NOTICE_TONE:Record<string, string> = {connected:"ok", applied:"ok", published:"ok", unfrozen:"ok", publish_failed:"down", failed:"down", frozen:"down",
  paused:"warn", merge_conflict:"warn", setup_not_installed:"warn"};
const CHECK_TONE = (value:string) => /^(ok|passed|pass|success)$/i.test(value) ? "pill-ok" : /^(failed|error)$/i.test(value) ? "pill-down" : "pill-unk";
const CHECK_GLYPH = (value:string) => /^(ok|passed|pass|success)$/i.test(value) ? "✓" : /^(failed|error)$/i.test(value) ? "×" : "·";

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

  const count = (c:Partial<Changes>|undefined, kind:ChangeKind) => c?.[kind]?.length ?? 0;
  const total = (c:Partial<Changes>|undefined) => KINDS.reduce((sum, kind)=>sum + count(c, kind), 0);
  const badges = (c:Partial<Changes>) => KINDS.map(kind=>count(c, kind) > 0 ? <ChangeBadge key={kind} kind={kind} count={count(c, kind)} /> : null);
  const changeRow = (key:string, label:string, c:Partial<Changes>|undefined, always = false) => c && (always || total(c) > 0)
    ? <StatRow key={key} label={label} badges={badges(c)}>{total(c) > 0 ? KINDS.map(kind=><ChangeList key={kind} kind={kind} items={c[kind] ?? []} />) : undefined}</StatRow> : null;
  const pathList = (items:string[]) => <ul className="biz-files">{items.map(x=><li key={x}><code>{x}</code></li>)}</ul>;

  if (!access || noSession) return <ConnectBiz />;
  if (access.reauthorizeRequired) return <ConnectBiz reauthorize />;
  if (!status) return <Loading text={t("setup.loading")} />;

  const actions = status.connected ? <>
    {status.admin && !pub && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void run("publish-preview", undefined, setPub)}>{t("setup.publish")}</button>}
    <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>void run("disconnect")}>{t("setup.disconnect")}</button>
  </> : undefined;
  const sums = KINDS.map(kind=>pub ? [pub.files, pub.bots, pub.extensions, pub.mcp_servers].reduce((sum, c)=>sum + count(c, kind), 0) : 0);

  return <Section id="biz-setup" title={t("setup.title")} intro={t("setup.intro")} actions={actions}>
    {status.noAccess && <Notice tone="warn">{t("setup.noAccess")}</Notice>}
    {status.frozen && <Notice tone="down">{t("setup.frozen")}</Notice>}
    {(status.secretsPending?.length ?? 0) > 0 && <Notice tone="warn">{t("setup.secretsPending", {names:status.secretsPending!.join(", ")})}</Notice>}
    {status.paused && <Notice tone="warn">{t("setup.paused", {reason:status.paused.reason})}</Notice>}
    {status.publishPaused && <Notice tone="warn">{t("setup.publishPaused", {files:(status.publishPaused.files ?? []).join(", ")})}</Notice>}
    {message && <Notice tone={message.ok ? "ok" : "down"}>{message.text}</Notice>}
    {status.connected
      ? <Notice tone="ok">{status.admin && status.selfPublished && status.selfPublished === status.version ? t("setup.connectedPublisher", {version:status.version}) : t("setup.connected", {version:status.version ?? "-"})}</Notice>
      : !status.noAccess && !preview && <>
        <Notice tone="info">{status.offered ? t("setup.offered", {version:status.offered.version}) : t("setup.noneOffered")}</Notice>
        <div className="connector-actions"><button type="button" className="btn btn-pri" disabled={busy} onClick={()=>void run("preview", undefined, setPreview)}>{t("setup.connect")}</button></div>
      </>}
    {preview && <div className="biz-preview-panel" role="group" aria-labelledby="biz-setup-preview">
      <h3 id="biz-setup-preview">{t("setup.previewTitle")}</h3>
      {preview.removalCount === 0 && preview.replaced.length === 0 ? <Notice tone="ok">{t("setup.nothingLost")}</Notice> : <Notice tone="warn" role="alert">{t("setup.warning")}</Notice>}
      {(preview.replaced.length > 0 || preview.removalCount > 0) && <ul className="biz-stats">
        {preview.replaced.length > 0 && <StatRow label={t("setup.replaced", {count:preview.replaced.length})}>{pathList(preview.replaced.map(f=>f.path))}</StatRow>}
        {preview.removalCount > 0 && <StatRow label={t("setup.removed", {count:preview.removalCount})}>{pathList(list(preview.removals))}</StatRow>}
      </ul>}
      <p className="hint">{t("setup.snapshotNote")}</p>
      <div className="connector-actions">
        <button type="button" className="btn btn-pri" disabled={busy} onClick={()=>void run("confirm", {digest:preview.digest}, ()=>{ setPreview(undefined); setMessage({ok:true, text:t("setup.applied")}); })}>{t("setup.confirm")}</button>
        <button type="button" className="btn btn-soft" disabled={busy} onClick={()=>void run("cancel", undefined, ()=>setPreview(undefined))}>{t("setup.cancel")}</button>
      </div>
    </div>}
    {pub && <div className="biz-preview-panel" role="group" aria-labelledby="biz-setup-publish">
      <h3 id="biz-setup-publish">{t("setup.pub.title")}</h3>
      {pub.blocked
        ? <Notice tone="warn" role="alert">{t("setup.pub.blocked", {error:pub.error || Object.entries(pub.checks).filter(([, v])=>v === "failed").map(([k])=>k).join(", ")})}</Notice>
        : !pub.changed
          ? <Notice tone="info">{t("setup.pub.noChanges")}</Notice>
          : <>
            <p className="biz-versions">{pub.base ? t("setup.pub.versions", {base:pub.base, version:pub.version}) : t("setup.pub.versionsFirst", {version:pub.version})}</p>
            <div className="plan-sum">{KINDS.map((kind, i)=>sums[i]! > 0 ? <ChangeBadge key={kind} kind={kind} count={sums[i]!} /> : null)}</div>
            <ul className="biz-stats">
              {changeRow("files", t("setup.pub.files", {count:pub.files_count ?? 0}), pub.files, true)}
              {changeRow("bots", t("setup.pub.bots"), pub.bots)}
              {changeRow("extensions", t("setup.pub.extensions"), pub.extensions)}
              {changeRow("mcp", t("setup.pub.mcp"), pub.mcp_servers)}
              {pub.secrets && pub.secrets.length > 0 && <StatRow label={t("setup.pub.secrets")} badges={<span className="biz-stat-value">{pub.secrets.length}</span>}>{pathList(pub.secrets)}</StatRow>}
              {pub.recipients && <StatRow label={t(pub.recipients.changed ? "setup.pub.recipientsChanged" : "setup.pub.recipients", {count:pub.recipients.count})} badges={pub.recipients.changed ? <span className="pill pill-warn">{pub.recipients.count}</span> : undefined} />}
            </ul>
          </>}
      {(Object.keys(pub.checks ?? {}).length > 0 || pub.framework) && <div className="biz-checks" role="group" aria-label={t("setup.pub.checks")}>
        <span className="label">{t("setup.pub.checks")}</span>
        {Object.entries(pub.checks ?? {}).map(([k, v])=><span key={k} className={`pill ${CHECK_TONE(v)}`}><span className="glyph" aria-hidden="true">{CHECK_GLYPH(v)}</span>{k}: {v}</span>)}
        {pub.framework && <span className="pill pill-outline">{t("setup.pub.framework", {version:pub.framework})}</span>}
      </div>}
      <div className="connector-actions">
        {pub.changed && !pub.blocked && <button type="button" className="btn btn-pri" disabled={busy} onClick={()=>void run("publish", {version:pub.version, digest:pub.digest}, r=>{ setPub(undefined); setMessage({ok:true, text:r.version ? t("setup.publishedVersion", {version:r.version}) : t("setup.published")}); })}>{t("setup.pub.confirm")}</button>}
        <button type="button" className="btn btn-soft" disabled={busy} onClick={()=>setPub(undefined)}>{pub.changed && !pub.blocked ? t("setup.pub.cancel") : t("setup.pub.close")}</button>
      </div>
    </div>}
    {stale && <div className="connector-actions"><button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void run("merge", {}, ()=>setMessage({ok:true, text:t("setup.published")}))}>{t("setup.mergeAndPublish")}</button></div>}
    {notInstalled && <div className="connector-actions"><button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void run("preview", undefined, setPreview)}>{t("setup.installFirst")}</button></div>}
    {conflicts.length > 0 && <fieldset className="biz-conflicts"><legend>{t("setup.conflicts")}</legend>
      {conflicts.map(f=><div className="biz-conflict" key={f}><code>{f}</code>
        <label><input type="radio" name={f} checked={choice[f] === "ours"} onChange={()=>setChoice({...choice, [f]:"ours"})} /> {t("setup.keepMine")}</label>
        <label><input type="radio" name={f} checked={choice[f] === "theirs"} onChange={()=>setChoice({...choice, [f]:"theirs"})} /> {t("setup.takePublished")}</label></div>)}
      <div className="connector-actions"><button type="button" className="btn btn-sm btn-pri" disabled={busy || conflicts.some(f=>!choice[f])}
        onClick={()=>void run("merge", {ours:conflicts.filter(f=>choice[f] === "ours"), theirs:conflicts.filter(f=>choice[f] === "theirs")}, ()=>setMessage({ok:true, text:t("setup.published")}))}>{t("setup.resolveMerge")}</button></div></fieldset>}
    {status.notices.length > 0 && <div className="biz-subsection">
      <h3>{t("setup.notices")}</h3>
      <ul className="card list biz-events">{[...status.notices].reverse().slice(0, 5).map(n=><li key={n.at+n.kind} className={`row biz-event-${NOTICE_TONE[n.kind] ?? "unk"}`}>
        <span className="biz-event-dot" aria-hidden="true" />
        <span className="biz-event-text">{n.text}</span>
        <span className="biz-event-time"><RelTime at={n.at} /></span>
      </li>)}</ul>
    </div>}
  </Section>;
}
