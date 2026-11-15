import { useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import { useDaguAction, useStore } from "@fyso/panel";
import type { BizTeam, BizTeams, BizTeamPrepared, BotsPlan } from "../api/biz";

/**
 * Download a Biz team: Biz writes the souls and skills (committed on their own),
 * then the framework's bots preview and apply review and commit the team file.
 */
export function Teams() {
  const {t} = useTranslation();
  const s = useStore();
  const list = useDaguAction<BizTeams>(s.backend, "ext-biz-team", "result");
  const prepare = useDaguAction<BizTeamPrepared>(s.backend, "ext-biz-team", "result");
  const preview = useDaguAction<BotsPlan>(s.backend, "fyso-bots-plan", "plan");
  const apply = useDaguAction<{created:number;changed:number;deleted:number;commit:string}>(s.backend, "fyso-bots-apply", "apply");
  const [teams, setTeams] = useState<BizTeam[]>();
  const [selected, setSelected] = useState<BizTeamPrepared>();
  const [plan, setPlan] = useState<BotsPlan>();
  const [error, setError] = useState("");
  const [done, setDone] = useState<string>();

  const error_ = (code?:string, bot?:string) => setError(t(`biz.teamErrors.${code}`, {defaultValue:t("biz.teamErrors.connection_failed"), bot}));
  const load = async () => {
    setError(""); setDone(undefined); setSelected(undefined); setPlan(undefined);
    const result = await list.start({FYSO_BIZ_OP:"teams"});
    if (!result || result.error || !Array.isArray(result.teams)) { error_(result?.error); return; }
    setTeams(result.teams);
  };
  const download = async (team:BizTeam) => {
    setError(""); setDone(undefined); setSelected(undefined); setPlan(undefined);
    const prepared = await prepare.start({FYSO_BIZ_OP:"team-prepare", FYSO_BIZ_TEAM:team.id});
    if (!prepared || prepared.error || !prepared.teamB64) { error_(prepared?.error, prepared?.bot); return; }
    setSelected(prepared);
    const reviewed = await preview.start({TEAM_B64:prepared.teamB64, TEAM_BASE_B64:prepared.teamBaseB64});
    if (!reviewed || !Array.isArray(reviewed.plan)) { setError(t("biz.teamErrors.preview")); return; }
    setPlan(reviewed);
  };
  const confirm = async () => {
    if (!selected || !plan) return;
    setError("");
    const result = await apply.start({TEAM_B64:selected.teamB64, TEAM_BASE_B64:selected.teamBaseB64, REMOVAL_REVISION:plan.removalRevision ?? ""});
    if (!result || typeof result.commit !== "string") { setError(t("biz.teamErrors.apply")); return; }
    setDone(result.commit.slice(0, 7)); setPlan(undefined); setSelected(undefined);
    s.reload();
  };
  const busy = [list, prepare, preview, apply].some(a=>a.phase === "running");

  return <section className="observ-section">
    <div className="row"><h2 className="section-title grow">{t("biz.teams")}</h2>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void load()}>{t(teams ? "biz.teamsRefresh" : "biz.teamsLoad")}</button></div>
    <p className="mute">{t("biz.teamsDescription")}</p>
    {list.phase === "running" && <p role="status">{t("biz.teamsLoading")}</p>}
    {error && <div className="banner banner-down" role="alert">{error}</div>}
    {done && <p className="banner" role="status">{t("biz.teamApplied", {commit:done})}</p>}
    {teams && !teams.length && <p>{t("biz.teamsEmpty")}</p>}
    {teams && teams.length > 0 && <div className="card"><ul className="list">{teams.map(team=><li className="row" key={team.id}>
      <span className="grow"><strong>{team.name}</strong>{team.description && <span className="mute"> · {team.description}</span>}</span>
      <span className="mute">{t("biz.teamCounts", {agents:team.agents ?? 0, skills:team.skills ?? 0, version:team.version ?? 0})}</span>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void download(team)}>{t("biz.teamDownload")}</button>
    </li>)}</ul></div>}
    {(prepare.phase === "running" || preview.phase === "running") && <p role="status">{t("biz.teamPreparing")}</p>}
    {selected && plan && <article className="card biz-onboarding">
      <h3>{t("biz.teamPreview", {name:selected.team.nombre, version:selected.team.version})}</h3>
      <p>{t("biz.teamBots")}: {selected.bots.join(", ") || "—"}</p>
      <p>{t("biz.teamSkills")}: {selected.skills.join(", ") || "—"}</p>
      <p className="mute">{t("biz.teamPlanCounts", {created:plan.created, changed:plan.changed, deleted:plan.deleted})}</p>
      {plan.plan.length > 0 && <pre className="biz-plan">{plan.plan.join("\n")}</pre>}
      <p className="mute">{t("biz.teamLocal")}</p>
      <div className="row"><button type="button" className="btn btn-pri" disabled={busy} onClick={()=>void confirm()}>{t(apply.phase === "running" ? "biz.teamApplying" : "biz.teamApply")}</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{setSelected(undefined);setPlan(undefined);}}>{t("biz.teamCancel")}</button></div>
    </article>}
  </section>;
}
