import { useEffect, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import { useDaguAction, useStore } from "@fyso/panel";
import type { BizDepartmentSync, BizProposed, BizPublished, BizSyncStatus } from "../api/biz";

const TONE:Record<BizDepartmentSync["state"],string> = {synced:"pill-ok", pull:"pill-warn", propose:"pill-warn", proposed:"pill-surface", rejected:"pill-down",
  renamed:"pill-warn", conflict:"pill-down", pending_apply:"pill-warn", unpublished:"pill-surface", absent:"pill-unk"};
// While a proposal waits for Biz, its decision is read again this often.
const POLL_MS = 60_000;

/**
 * This project's departments and their sync with Biz (framework D82). Biz leads: a
 * department with no Biz team is published once; after that a local change is sent as a
 * proposal and decided on Biz, and an accepted one comes down through the team download
 * below (`onPull`). The Biz name always wins (`onRestoreName`).
 */
export function Departments({onPull, onPublished, onRestoreName, version}:{onPull:(equipoId:string, overwrite:boolean)=>void; onPublished:()=>Promise<void>; onRestoreName:(equipoId:string)=>void; version:number}) {
  const {t} = useTranslation();
  const s = useStore();
  const check = useDaguAction<BizSyncStatus>(s.backend, "ext-biz-team", "result");
  const publish = useDaguAction<BizPublished>(s.backend, "ext-biz-team", "result");
  const propose = useDaguAction<BizProposed>(s.backend, "ext-biz-team", "result");
  const [status, setStatus] = useState<BizSyncStatus>();
  const [active, setActive] = useState<string>();
  const [message, setMessage] = useState<{department:string; ok:boolean; text:string}>();
  // Biz-managed access (project-policy.cjs): the person's capabilities; `null` when the
  // project has no managed access (204) and every action stays as it is.
  const [granted, setGranted] = useState<Set<string>|null>();
  useEffect(()=>{
    const controller = new AbortController();
    fetch("/api/panel-access", {cache:"no-store", signal:controller.signal}).then(async response => {
      if (response.status === 204) return setGranted(null);
      const data = response.ok ? await response.json() : null;
      setGranted(new Set(Array.isArray(data?.capabilities) ? data.capabilities.filter((c:unknown)=>typeof c === "string") : []));
    }).catch(()=>{ if (!controller.signal.aborted) setGranted(new Set()); });
    return ()=>controller.abort();
  }, []);
  const can = (capability:string) => granted === null || !!granted?.has(capability);

  const load = async () => { const result = await check.start({FYSO_BIZ_OP:"team-sync"}); setStatus(result ?? {error:"connection_failed"}); };
  // Checked again after every download or apply below (`version`).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ void load(); }, [version]);
  const waiting = (status?.departments ?? []).some(d=>d.proposal?.state === "pending");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ if (!waiting) return; const timer = setInterval(()=>{ if (check.phase !== "running") void load(); }, POLL_MS); return ()=>clearInterval(timer); }, [waiting]);

  const error = (code?:string) => t(`biz.teamErrors.${code}`, {defaultValue:t("biz.teamErrors.connection_failed")});
  const sendPublish = async (department:string) => {
    setActive(department); setMessage(undefined);
    const result = await publish.start({FYSO_BIZ_OP:"team-publish", FYSO_BIZ_LOCAL_DEPARTMENT:department});
    setActive(undefined);
    setMessage(result && !result.error ? {department, ok:true, text:t("biz.syncPublished", {version:result.version})} : {department, ok:false, text:error(result?.error)});
    if (result && !result.error) await onPublished();
    void load();
  };
  const sendProposal = async (d:BizDepartmentSync, overwrite:boolean) => {
    setActive(d.department); setMessage(undefined);
    const result = await propose.start({FYSO_BIZ_OP:"team-propose", FYSO_BIZ_LOCAL_DEPARTMENT:d.localName ?? d.department, FYSO_BIZ_TEAM:d.equipoId ?? "", FYSO_BIZ_OVERWRITE:overwrite ? "1" : ""});
    setActive(undefined);
    setMessage(result && !result.error ? {department:d.department, ok:true, text:t("biz.syncProposed", {version:result.proposal.base})} : {department:d.department, ok:false, text:error(result?.error)});
    void load();
  };
  const busy = check.phase === "running" || publish.phase === "running" || propose.phase === "running";
  const rows = (status?.departments ?? []).filter(d=>d.state !== "absent");
  const canPropose = status?.proposalsSupported !== false;

  return <section className="card biz-stack" aria-labelledby="biz-sync">
    <div className="connector-heading">
      <h2 id="biz-sync" className="biz-h2">{t("biz.syncTitle")}</h2>
      <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>void load()}>{t("biz.syncRefresh")}</button>
    </div>
    <p className="mute">{t("biz.syncIntro")}</p>
    {!status && <p role="status" className="mute">{t("biz.syncLoading")}</p>}
    {status?.error && <p role="alert" className="biz-error">{error(status.error)}</p>}
    {status && !status.error && status.publishSupported === false && <p className="banner banner-warn" role="status">{t("biz.syncNotSupported")}</p>}
    {status && !status.error && !canPropose && <p className="banner banner-warn" role="status">{t("biz.syncProposalsNotSupported")}</p>}
    {status && !status.error && !rows.length && <p className="mute">{t("biz.syncEmpty")}</p>}
    {rows.length > 0 && <ul className="biz-sync">{rows.map(d=>{
      const working = active === d.department;
      // A department Biz manages: proposing needs the team workflow, pulling or renaming applies bots.
      const mayPropose = !d.managed || can("workflow:ext-biz-team:run");
      const mayApply = !d.managed || can("workflow:fyso-bots-apply:run");
      const canPublish = status?.publishSupported !== false && !d.managed;
      const proposal = d.proposal;
      return <li key={d.department} className="biz-sync-row">
        <div className="connector-heading">
          <strong>{d.department}</strong>
          <span className={`pill ${TONE[d.state]}`}>{t(`biz.syncStates.${d.state}`)}</span>
        </div>
        {d.remoteVersion !== null && <span className="hint">{t("biz.syncVersion", {version:d.remoteVersion})}</span>}
        {d.managed && <p className="hint">{t("biz.syncManaged")}</p>}
        {d.localName && <p className="hint">{t("biz.syncRenamed", {local:d.localName})}</p>}
        {d.state === "conflict" && <p className="hint">{t("biz.syncConflictHint")}</p>}
        {d.state === "proposed" && <p className="hint" role="status">{t("biz.syncWaiting")}</p>}
        {proposal?.state === "accepted" && d.state === "pull" && <p className="biz-success" role="status">✓ {t("biz.syncAccepted", {version:proposal.version})}</p>}
        {d.state === "rejected" && <>
          <p className="biz-error" role="alert">{proposal?.reason ? t("biz.syncRejectedReason", {reason:proposal.reason}) : t("biz.syncRejected")}</p>
          <p className="hint">{t("biz.syncRejectedHint")}</p>
        </>}
        {message?.department === d.department && <p className={message.ok ? "biz-success" : "biz-error"} role={message.ok ? "status" : "alert"}>{message.ok ? "✓ " : ""}{message.text}</p>}
        <div className="connector-actions">
          {working && <span role="status" className="mute">{t(propose.phase === "running" ? "biz.syncProposing" : "biz.syncPublishing")}</span>}
          {!working && d.state === "unpublished" && canPublish && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void sendPublish(d.department)}>{t("biz.syncPublish")}</button>}
          {!working && d.state === "propose" && canPropose && mayPropose && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void sendProposal(d, false)}>{t("biz.syncPropose")}</button>}
          {!working && d.state === "pull" && d.equipoId && mayApply && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>onPull(d.equipoId!, false)}>{t("biz.syncPull", {version:d.remoteVersion})}</button>}
          {!working && d.state === "pending_apply" && d.equipoId && mayApply && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>onPull(d.equipoId!, true)}>{t("biz.syncApplyPulled")}</button>}
          {!working && d.state === "rejected" && d.equipoId && mayApply && <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>onPull(d.equipoId!, true)}>{t("biz.syncKeepBiz")}</button>}
          {!working && d.localName && d.equipoId && mayApply && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>onRestoreName(d.equipoId!)}>{t("biz.syncRestoreName", {name:d.department})}</button>}
          {!working && d.state === "renamed" && canPropose && mayPropose && <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>void sendProposal(d, false)}>{t("biz.syncProposeName", {name:d.localName})}</button>}
          {!working && d.state === "conflict" && d.equipoId && <>
            {mayApply && <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>onPull(d.equipoId!, true)}>{t("biz.syncKeepBiz")}</button>}
            {canPropose && mayPropose && <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>void sendProposal(d, true)}>{t("biz.syncKeepMine")}</button>}
          </>}
        </div>
      </li>;
    })}</ul>}
  </section>;
}
