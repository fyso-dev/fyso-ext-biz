import { useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import { useDaguAction, useStore, External } from "@fyso/panel";
import type { BizTeam, BizTeamPrepared, BotsPlan } from "../api/biz";
import { Departments } from "./Departments";

type Applied = {created:number;changed:number;deleted:number;commit:string};

/**
 * Agent teams from Fyso Business. Downloading writes the team's instructions and
 * skills (their own commit); the framework's bots preview/apply adds the bots.
 */
export function Teams({bizUrl, teams, error:listError, loading, reload}:{bizUrl?:string; teams?:BizTeam[]; error?:string; loading:boolean; reload:()=>Promise<void>}) {
  const {t} = useTranslation();
  const s = useStore();
  const prepare = useDaguAction<BizTeamPrepared>(s.backend, "ext-biz-team", "result");
  const preview = useDaguAction<BotsPlan>(s.backend, "fyso-bots-plan", "plan");
  const apply = useDaguAction<Applied>(s.backend, "fyso-bots-apply", "apply");
  const [active, setActive] = useState<string>();
  const [prepared, setPrepared] = useState<BizTeamPrepared>();
  const [plan, setPlan] = useState<BotsPlan>();
  const [error, setError] = useState<{team?:string; text:string}>();
  const [done, setDone] = useState<{team:string; applied:Applied}>();
  // Bumped after a download or apply so the departments re-check their sync state.
  const [synced, setSynced] = useState(0);

  const fail = (team:string|undefined, code?:string, bot?:string) =>
    setError({team, text:t(`biz.teamErrors.${code}`, {defaultValue:t("biz.teamErrors.connection_failed"), bot})});

  const reset = () => { setActive(undefined); setPrepared(undefined); setPlan(undefined); };
  // `team-rename` prepares the team file that gives a locally renamed department its Biz
  // name back; it is reviewed and applied the same way as a download.
  const download = async (team:Pick<BizTeam,"id">, overwrite = false, op:"team-prepare"|"team-rename" = "team-prepare") => {
    reset(); setError(undefined); setDone(undefined); setActive(team.id);
    const result = await prepare.start({FYSO_BIZ_OP:op, FYSO_BIZ_TEAM:team.id, FYSO_BIZ_OVERWRITE:overwrite ? "1" : ""});
    setSynced(n=>n+1);
    if (!result || result.error || !result.teamB64) { setActive(undefined); fail(team.id, result?.error, result?.bot); return; }
    const reviewed = await preview.start({TEAM_B64:result.teamB64, TEAM_BASE_B64:result.teamBaseB64});
    if (!reviewed || !Array.isArray(reviewed.plan)) { setActive(undefined); fail(team.id, "preview"); return; }
    setPrepared(result); setPlan(reviewed);
  };
  const confirm = async () => {
    if (!prepared || !plan || !active) return;
    setError(undefined);
    const result = await apply.start({TEAM_B64:prepared.teamB64, TEAM_BASE_B64:prepared.teamBaseB64, REMOVAL_REVISION:plan.removalRevision ?? ""});
    if (!result || typeof result.commit !== "string") { fail(active, "apply"); return; }
    setDone({team:active, applied:result}); reset();
    s.reload(); void reload(); setSynced(n=>n+1);
  };
  const busy = [prepare, preview, apply].some(a=>a.phase === "running");
  const preparing = prepare.phase === "running" || preview.phase === "running";

  const listFailed = listError && t(`biz.teamErrors.${listError}`, {defaultValue:t("biz.teamErrors.connection_failed")});
  if (!teams) return <div className="card empty">
    {listFailed && !loading ? <><p role="alert">{listFailed}</p><button type="button" className="btn btn-soft" onClick={()=>void reload()}>{t("common.retry")}</button></>
      : <p role="status" className="mute">{t("biz.teamsLoading")}</p>}
  </div>;
  const departments = <Departments version={synced} onPull={(id, overwrite)=>void download({id}, overwrite)} onRestoreName={id=>void download({id}, false, "team-rename")} />;
  if (!teams.length) return <div className="biz-stack">{departments}<div className="card empty"><span className="empty-icon" aria-hidden="true">✦</span>
    <h3>{t("biz.teamsEmptyTitle")}</h3><p className="mute">{t("biz.teamsEmpty")}</p>
    {bizUrl && <External href={bizUrl}>{t("biz.teamsCreate")}</External>}
  </div></div>;

  return <div className="biz-stack">
    {departments}
    {listFailed && !loading && <div className="banner banner-down" role="alert">{listFailed} <button type="button" className="btn btn-sm btn-soft" onClick={()=>void reload()}>{t("common.retry")}</button></div>}
    {error && !error.team && <div className="banner banner-down" role="alert">{error.text}</div>}
    {loading && <p className="hint" role="status">{t("biz.refreshing")}</p>}
    <div className="connector-grid">{teams.map(team=>{
      const state = team.localVersion === null ? "new" : (team.version ?? 0) > team.localVersion ? "update" : "current";
      const open = active === team.id;
      return <article className={`card connector-card biz-team${open ? " biz-team-open" : ""}`} key={team.id}>
        <div className="connector-heading">
          <div className="connector-app-title"><span className="avatar biz-team-mark" aria-hidden="true">{team.name.trim().charAt(0).toUpperCase()}</span><h3>{team.name}</h3></div>
          {state !== "new" && <span className={`pill ${state === "update" ? "pill-warn" : "pill-ok"}`}>{t(state === "update" ? "biz.teamUpdate" : "biz.teamCurrent")}</span>}
        </div>
        {team.department && <p className="hint">{t("biz.teamLocalDepartment", {department:team.department})}</p>}
        {team.description && <p className="mute">{team.description}</p>}
        <div className="biz-chips"><span className="pill pill-surface">{t("biz.agentsCount", {count:team.agents ?? 0})}</span><span className="pill pill-surface">{t("biz.skillsCount", {count:team.skills ?? 0})}</span></div>
        {done?.team === team.id && <p className="biz-success" role="status">✓ {t("biz.teamApplied", {count:done.applied.created + done.applied.changed})}</p>}
        {error?.team === team.id && <p className="biz-error" role="alert">{error.text}</p>}
        {open && preparing && <p role="status" className="mute">{t("biz.teamPreparing")}</p>}
        {open && prepared && plan && <div className="biz-preview">
          <p><strong>{t(plan.created + plan.changed + plan.deleted === 0 ? "biz.previewTeam" : "biz.previewTitle")}</strong></p>
          <ul className="biz-bots">{prepared.bots.map(bot=><li key={bot.name}><span className="avatar" aria-hidden="true">{bot.name.charAt(0).toUpperCase()}</span><span><strong>{bot.name}</strong>{bot.title && <><br/><span className="mute">{bot.title}</span></>}</span></li>)}</ul>
          {prepared.skills.length > 0 && <p className="mute">{t("biz.previewSkills", {skills:prepared.skills.join(", ")})}</p>}
          {plan.created + plan.changed + plan.deleted === 0 ? <p className="mute">{t("biz.previewNoChanges")}</p>
            : <p className="mute">{t("biz.previewSummary", {created:plan.created, changed:plan.changed, deleted:plan.deleted})}</p>}
          <details className="biz-details"><summary>{t("biz.previewDetails")}</summary><pre>{plan.plan.join("\n")}</pre></details>
        </div>}
        <div className="connector-actions">
          {open && prepared && plan ? <>
            <button type="button" className="btn btn-pri" disabled={busy || plan.created + plan.changed + plan.deleted === 0} onClick={()=>void confirm()}>{t(apply.phase === "running" ? "biz.teamApplying" : "biz.teamApply")}</button>
            <button type="button" className="btn btn-soft" disabled={apply.phase === "running"} onClick={reset}>{t("biz.teamCancel")}</button>
          </> : <button type="button" className={`btn ${state === "current" ? "btn-soft" : "btn-pri"}`} disabled={busy} onClick={()=>void download(team)}>
            {t(open && preparing ? "biz.teamPreparingShort" : state === "new" ? "biz.teamDownload" : state === "update" ? "biz.teamUpdateAction" : "biz.teamReview")}</button>}
        </div>
      </article>;
    })}</div>
    <p className="note">{t("biz.teamsFootnote")}</p>
  </div>;
}
