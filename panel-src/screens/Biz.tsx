import { useEffect, useState } from "@fyso/panel";
import { useTranslation } from "@fyso/panel";
import { External, useDaguAction, useStore } from "@fyso/panel";
import type { BizSnapshot, BizStatus } from "../api/biz";
import { Teams } from "./Teams";
import { Business } from "./Business";

type Tab = "teams" | "business";

export function Biz() {
  const {t} = useTranslation();
  const s = useStore();
  const extension = s.extensions.data?.find(e=>e.id === "biz");
  const installed = !!extension;
  const tokenSet = extension?.secrets.find(secret=>secret.name === "BOT_FYSO_BIZ_TOKEN")?.set;
  const statusAction = useDaguAction<BizStatus>(s.backend, "ext-biz-team", "result");
  const logout = useDaguAction<BizStatus>(s.backend, "ext-biz-team", "result");
  const [connection, setConnection] = useState<BizStatus>();
  const [context, setContext] = useState<BizSnapshot>();
  const [tab, setTab] = useState<Tab>(()=>{ try { return sessionStorage.getItem("biz.tab") === "business" ? "business" : "teams"; } catch { return "teams"; } });
  const bizBot = s.runtimeBots.data?.find(b=>b.name === "Biz Partner");

  const readStatus = async () => {
    const result = await statusAction.start({FYSO_BIZ_OP:"status"});
    setConnection(result && typeof result.connected === "boolean" ? result : {connected:false, error:result?.error ?? "connection_failed"});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{ setConnection(undefined); setContext(undefined); if (installed) void readStatus(); }, [installed, tokenSet]);
  const choose = (next:Tab) => { setTab(next); try { sessionStorage.setItem("biz.tab", next); } catch { /* optional */ } };
  const disconnect = async () => { await logout.start({FYSO_BIZ_OP:"logout"}); setContext(undefined); await readStatus(); };
  const host = connection?.url ? new URL(connection.url).host : "fyso.biz";

  return <main className="page page-wide biz-page">
    <div className="page-head">
      <div className="grow"><h1>{t("biz.title")}</h1><p>{t("biz.subtitle")}</p></div>
      {connection?.connected && <div className="biz-account">
        <span className="pill pill-ok" role="status">● {context?.organization ? t("biz.connectedTo", {org:context.organization}) : t("biz.connected")}</span>
        {connection.url && <External href={connection.url}>{t("biz.open")}</External>}
        {connection.method === "oauth" && <button type="button" className="btn btn-sm btn-ghost" disabled={logout.phase === "running"} onClick={()=>void disconnect()}>{t("biz.disconnect")}</button>}
      </div>}
    </div>

    {s.extensions.status === "error" && <div className="banner banner-down" role="alert">{t("biz.configError")} <button className="btn btn-sm btn-soft" onClick={s.reload}>{t("common.retry")}</button></div>}
    {installed && !connection && <div className="card empty"><p role="status" className="mute">{t("biz.connecting")}</p></div>}

    {installed && connection && !connection.connected && <section className="card biz-hero" aria-labelledby="biz-connect">
      <span className="empty-icon" aria-hidden="true">⇄</span>
      <h2 id="biz-connect">{t("biz.connectTitle")}</h2>
      <p className="mute">{t("biz.connectDescription")}</p>
      <ul className="biz-benefits">
        <li>{t("biz.benefitTeams")}</li>
        <li>{t("biz.benefitContext")}</li>
        <li>{t("biz.benefitSafe")}</li>
      </ul>
      {connection.error && <p className="biz-error" role="alert">{t("biz.connectionError")}</p>}
      {connection.login ? <a className="btn btn-pri biz-cta" href={connection.login} target="_top">{t("biz.connect")}</a> : <p className="biz-error">{t("biz.restart")}</p>}
      <p className="hint">{t("biz.connectScope", {host})}</p>
      <details className="biz-details"><summary>{t("biz.credentialsTitle")}</summary><p className="hint">{t("biz.credentialsDescription")}</p></details>
    </section>}

    {installed && connection?.connected && <>
      <div className="seg biz-tabs" role="tablist" aria-label={t("biz.title")}>
        <button type="button" role="tab" aria-selected={tab === "teams"} aria-pressed={tab === "teams"} onClick={()=>choose("teams")}>{t("biz.tabTeams")}</button>
        <button type="button" role="tab" aria-selected={tab === "business"} aria-pressed={tab === "business"} onClick={()=>choose("business")}>{t("biz.tabBusiness")}</button>
      </div>
      {tab === "teams" ? <Teams bizUrl={connection.url} /> : <Business onContext={setContext} />}
      {connection.method === "token" && <aside className="card biz-partner">
        <span className="avatar" aria-hidden="true">B</span>
        <div className="grow"><strong>{t("biz.partnerTitle")}</strong><p className="hint">{t(bizBot ? "biz.partnerReady" : "biz.partnerPending")}</p></div>
        {bizBot && <External href={s.project.data?.urls.omb ?? "#/bots"}>{t("biz.partnerOpen")}</External>}
      </aside>}
      <p className="note">{t("biz.scope")}</p>
    </>}
  </main>;
}
