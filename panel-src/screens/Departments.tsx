import { useEffect, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import { useDaguAction, useStore } from "@fyso/panel";
import type { BizDepartmentSync, BizPublished, BizSyncStatus } from "../api/biz";

const TONE:Record<BizDepartmentSync["state"],string> = {synced:"pill-ok", pull:"pill-warn", publish:"pill-warn", conflict:"pill-down", pending_apply:"pill-warn", unpublished:"pill-surface", absent:"pill-unk"};

/**
 * This project's departments and their sync with Biz (framework D82). Publishing sends the
 * native package; pulling goes through the team download below (`onPull`), which shows the
 * plan and applies it. When both sides changed, the person chooses which one stays.
 */
export function Departments({onPull, onPublished, version}:{onPull:(equipoId:string, overwrite:boolean)=>void; onPublished:()=>Promise<void>; version:number}) {
  const {t} = useTranslation();
  const s = useStore();
  const check = useDaguAction<BizSyncStatus>(s.backend, "ext-biz-team", "result");
  const publish = useDaguAction<BizPublished>(s.backend, "ext-biz-team", "result");
  const [status, setStatus] = useState<BizSyncStatus>();
  const [active, setActive] = useState<string>();
  const [message, setMessage] = useState<{department:string; ok:boolean; text:string}>();

  const load = async () => { const result = await check.start({FYSO_BIZ_OP:"team-sync"}); setStatus(result ?? {error:"connection_failed"}); };
  // Checked again after every download or apply below (`version`).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ void load(); }, [version]);

  const error = (code?:string) => t(`biz.teamErrors.${code}`, {defaultValue:t("biz.teamErrors.connection_failed")});
  const send = async (department:string, overwrite:boolean) => {
    setActive(department); setMessage(undefined);
    const result = await publish.start({FYSO_BIZ_OP:"team-publish", FYSO_BIZ_LOCAL_DEPARTMENT:department, FYSO_BIZ_OVERWRITE:overwrite ? "1" : ""});
    setActive(undefined);
    setMessage(result && !result.error ? {department, ok:true, text:t("biz.syncPublished", {version:result.version})} : {department, ok:false, text:error(result?.error)});
    if (result && !result.error) await onPublished();
    void load();
  };
  const busy = check.phase === "running" || publish.phase === "running";
  const rows = (status?.departments ?? []).filter(d=>d.state !== "absent");

  return <section className="card biz-stack" aria-labelledby="biz-sync">
    <div className="connector-heading">
      <h2 id="biz-sync" className="biz-h2">{t("biz.syncTitle")}</h2>
      <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>void load()}>{t("biz.syncRefresh")}</button>
    </div>
    <p className="mute">{t("biz.syncIntro")}</p>
    {!status && <p role="status" className="mute">{t("biz.syncLoading")}</p>}
    {status?.error && <p role="alert" className="biz-error">{error(status.error)}</p>}
    {status && !status.error && status.publishSupported === false && <p className="banner banner-warn" role="status">{t("biz.syncNotSupported")}</p>}
    {status && !status.error && !rows.length && <p className="mute">{t("biz.syncEmpty")}</p>}
    {rows.length > 0 && <ul className="biz-sync">{rows.map(d=>{
      const working = active === d.department;
      const canPublish = status?.publishSupported !== false;
      return <li key={d.department} className="biz-sync-row">
        <div className="connector-heading">
          <strong>{d.department}</strong>
          <span className={`pill ${TONE[d.state]}`}>{t(`biz.syncStates.${d.state}`)}</span>
        </div>
        {d.remoteVersion !== null && <span className="hint">{t("biz.syncVersion", {version:d.remoteVersion})}</span>}
        {d.state === "conflict" && <p className="hint">{t("biz.syncConflictHint")}</p>}
        {message?.department === d.department && <p className={message.ok ? "biz-success" : "biz-error"} role={message.ok ? "status" : "alert"}>{message.ok ? "✓ " : ""}{message.text}</p>}
        <div className="connector-actions">
          {working && <span role="status" className="mute">{t("biz.syncPublishing")}</span>}
          {!working && d.state === "unpublished" && canPublish && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void send(d.department, false)}>{t("biz.syncPublish")}</button>}
          {!working && d.state === "publish" && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>void send(d.department, false)}>{t("biz.syncPublishChanges")}</button>}
          {!working && d.state === "pull" && d.equipoId && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>onPull(d.equipoId!, false)}>{t("biz.syncPull", {version:d.remoteVersion})}</button>}
          {!working && d.state === "pending_apply" && d.equipoId && <button type="button" className="btn btn-sm btn-pri" disabled={busy} onClick={()=>onPull(d.equipoId!, true)}>{t("biz.syncApplyPulled")}</button>}
          {!working && d.state === "conflict" && d.equipoId && <>
            <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>onPull(d.equipoId!, true)}>{t("biz.syncKeepBiz")}</button>
            <button type="button" className="btn btn-sm btn-soft" disabled={busy} onClick={()=>void send(d.department, true)}>{t("biz.syncKeepMine")}</button>
          </>}
        </div>
      </li>;
    })}</ul>}
  </section>;
}
