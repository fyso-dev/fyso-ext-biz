import { useEffect, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import { useDaguAction, useStore } from "@fyso/panel";
import { Loading, Notice, Section } from "../components/ui";
import type { BizDepartmentSync, BizProposed, BizPublished, BizSyncStatus } from "../api/biz";

import { PLAN_RUN, TEAM_RUN, usePanelAccess, type PanelAccess } from "../api/panel-access";

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
export function Departments({onPull, onPublished, onRestoreName, version, access}:{onPull:(equipoId:string, overwrite:boolean)=>void; onPublished:()=>Promise<void>; onRestoreName:(equipoId:string)=>void; version:number; access?:PanelAccess}) {
  const {t} = useTranslation();
  const s = useStore();
  const check = useDaguAction<BizSyncStatus>(s.backend, "ext-biz-team", "result");
  const publish = useDaguAction<BizPublished>(s.backend, "ext-biz-team", "result");
  const propose = useDaguAction<BizProposed>(s.backend, "ext-biz-team", "result");
  const [status, setStatus] = useState<BizSyncStatus>();
  const [active, setActive] = useState<string>();
  const [message, setMessage] = useState<{department:string; ok:boolean; text:string}>();
  const {loading, failed, can} = usePanelAccess(access);
  // Sync can settle a pending delivery in git, so even the check needs the run grant.
  const mayCheck = can(TEAM_RUN);
  const mayPrepare = mayCheck && can(PLAN_RUN);
  const load = async () => {
    if (!mayCheck) return;
    const result = await check.start({FYSO_BIZ_OP:"team-sync"});
    setStatus(result ?? {error:"workflow_not_started"});
  };
  // Checked again after every download or apply below (`version`), once the capabilities are known.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ void load(); }, [version, mayCheck]);
  const waiting = (status?.departments ?? []).some(d=>d.proposal?.state === "pending");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ if (!waiting) return; const timer = setInterval(()=>{ if (check.phase !== "running") void load(); }, POLL_MS); return ()=>clearInterval(timer); }, [waiting]);

  const error = (code?:string) => t(`biz.teamErrors.${code}`, {defaultValue:t("biz.teamErrors.connection_failed")});
  const sendPublish = async (department:string) => {
    setActive(department); setMessage(undefined);
    const result = await publish.start({FYSO_BIZ_OP:"team-publish", FYSO_BIZ_LOCAL_DEPARTMENT:department});
    setActive(undefined);
    setMessage(result && !result.error ? {department, ok:true, text:t("biz.syncPublished", {version:result.version})} : {department, ok:false, text:error(result ? result.error : "workflow_not_started")});
    if (result && !result.error) await onPublished();
    void load();
  };
  const sendProposal = async (d:BizDepartmentSync, overwrite:boolean) => {
    setActive(d.department); setMessage(undefined);
    const result = await propose.start({FYSO_BIZ_OP:"team-propose", FYSO_BIZ_LOCAL_DEPARTMENT:d.localName ?? d.department, FYSO_BIZ_TEAM:d.equipoId ?? "", FYSO_BIZ_OVERWRITE:overwrite ? "1" : ""});
    setActive(undefined);
    setMessage(result && !result.error ? {department:d.department, ok:true, text:t("biz.syncProposed", {version:result.proposal.base})} : {department:d.department, ok:false, text:error(result ? result.error : "workflow_not_started")});
    void load();
  };
  const busy = check.phase === "running" || publish.phase === "running" || propose.phase === "running";
  const rows = (status?.departments ?? []).filter(d=>d.state !== "absent");
  const canPropose = status?.proposalsSupported !== false;

  return <Section id="biz-sync" title={t("biz.syncTitle")} intro={t("biz.syncIntro")}
    actions={<button type="button" className="btn btn-sm btn-soft" disabled={busy || !mayCheck} onClick={()=>void load()}>{t("biz.syncRefresh")}</button>}>
    {failed && <p className="mute" role="status">{t("biz.permissionsUnavailable")}</p>}
    {!loading && !failed && !mayCheck && <p className="mute" role="status">{t("biz.syncReadOnly")}</p>}
    {!status && (loading || mayCheck) && <Loading card={false} text={t("biz.syncLoading")} />}
    {status?.error && <Notice tone="down">{error(status.error)}</Notice>}
    {status && !status.error && status.publishSupported === false && <Notice tone="warn">{t("biz.syncNotSupported")}</Notice>}
    {status && !status.error && !canPropose && <Notice tone="warn">{t("biz.syncProposalsNotSupported")}</Notice>}
    {status && !status.error && !rows.length && <p className="mute">{t("biz.syncEmpty")}</p>}
    {rows.length > 0 && <ul className="biz-sync">{rows.map(d=>{
      const working = active === d.department;
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
        {proposal?.state === "accepted" && d.state === "pull" && <Notice tone="ok">{t("biz.syncAccepted", {version:proposal.version})}</Notice>}
        {d.state === "rejected" && <>
          <Notice tone="down">{proposal?.reason ? t("biz.syncRejectedReason", {reason:proposal.reason}) : t("biz.syncRejected")}</Notice>
          <p className="hint">{t("biz.syncRejectedHint")}</p>
        </>}
        {message?.department === d.department && <Notice tone={message.ok ? "ok" : "down"}>{message.text}</Notice>}
        <div className="connector-actions">
          {working && <span role="status" className="hint">{t(propose.phase === "running" ? "biz.syncProposing" : "biz.syncPublishing")}</span>}
          {!working && d.state === "unpublished" && canPublish && <button type="button" className="btn btn-sm btn-pri" disabled={busy || !mayCheck} onClick={()=>void sendPublish(d.department)}>{t("biz.syncPublish")}</button>}
          {!working && d.state === "propose" && canPropose && <button type="button" className="btn btn-sm btn-pri" disabled={busy || !mayCheck} onClick={()=>void sendProposal(d, false)}>{t("biz.syncPropose")}</button>}
          {!working && d.state === "pull" && d.equipoId && <button type="button" className="btn btn-sm btn-pri" disabled={busy || !mayPrepare} onClick={()=>onPull(d.equipoId!, false)}>{t("biz.syncPull", {version:d.remoteVersion})}</button>}
          {!working && d.state === "pending_apply" && d.equipoId && <button type="button" className="btn btn-sm btn-pri" disabled={busy || !mayPrepare} onClick={()=>onPull(d.equipoId!, true)}>{t("biz.syncApplyPulled")}</button>}
          {!working && d.state === "rejected" && d.equipoId && <button type="button" className="btn btn-sm btn-soft" disabled={busy || !mayPrepare} onClick={()=>onPull(d.equipoId!, true)}>{t("biz.syncKeepBiz")}</button>}
          {!working && d.localName && d.equipoId && <button type="button" className="btn btn-sm btn-pri" disabled={busy || !mayPrepare} onClick={()=>onRestoreName(d.equipoId!)}>{t("biz.syncRestoreName", {name:d.department})}</button>}
          {!working && d.state === "renamed" && canPropose && <button type="button" className="btn btn-sm btn-soft" disabled={busy || !mayCheck} onClick={()=>void sendProposal(d, false)}>{t("biz.syncProposeName", {name:d.localName})}</button>}
          {!working && d.state === "conflict" && d.equipoId && <>
            <button type="button" className="btn btn-sm btn-soft" disabled={busy || !mayPrepare} onClick={()=>onPull(d.equipoId!, true)}>{t("biz.syncKeepBiz")}</button>
            {canPropose && <button type="button" className="btn btn-sm btn-soft" disabled={busy || !mayCheck} onClick={()=>void sendProposal(d, true)}>{t("biz.syncKeepMine")}</button>}
          </>}
        </div>
      </li>;
    })}</ul>}
  </Section>;
}
