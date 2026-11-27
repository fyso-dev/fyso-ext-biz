import { useTranslation } from "@fyso/panel";

/**
 * Small presentational pieces built on the panel's own classes (banner, pill, card, list, row).
 * They only compose the host's tokens and carry no business logic.
 */

export type Tone = "ok" | "warn" | "down" | "info";
const GLYPH:Record<Tone, string> = {ok:"✓", warn:"!", down:"×", info:"i"};

/** A status line: soft tinted banner with a glyph. Errors announce as alerts, the rest as status. */
export function Notice({tone, role, children}:{tone:Tone; role?:"status"|"alert"; children:React.ReactNode}) {
  return <div className={`banner banner-${tone} biz-notice`} role={role ?? (tone === "down" ? "alert" : "status")}>
    <span className="biz-notice-icon" aria-hidden="true">{GLYPH[tone]}</span>
    <div className="biz-notice-body">{children}</div>
  </div>;
}

/** A card section: display-font title, optional intro and a slot for actions beside the title. */
export function Section({id, title, intro, actions, children}:{id:string; title:React.ReactNode; intro?:React.ReactNode; actions?:React.ReactNode; children:React.ReactNode}) {
  return <section className="card biz-section" aria-labelledby={id}>
    <div className="biz-section-head">
      <div className="biz-section-title"><h2 id={id} className="biz-title">{title}</h2>{intro && <p className="mute">{intro}</p>}</div>
      {actions && <div className="biz-section-actions">{actions}</div>}
    </div>
    {children}
  </section>;
}

export type ChangeKind = "added" | "modified" | "removed";
const KIND:Record<ChangeKind, {pill:string; glyph:string}> = {
  added:{pill:"pill-ok", glyph:"+"},
  modified:{pill:"pill-warn", glyph:"~"},
  removed:{pill:"pill-down", glyph:"−"},
};

/** Added, modified or removed, with its count. The label comes from the existing i18n keys. */
export function ChangeBadge({kind, count}:{kind:ChangeKind; count:number}) {
  const {t} = useTranslation();
  return <span className={`pill ${KIND[kind].pill}`}><span className="glyph" aria-hidden="true">{KIND[kind].glyph}</span>{t(`setup.pub.${kind}`, {count})}</span>;
}

/** An expandable list of paths, with the change badge as its heading. */
export function ChangeList({kind, items}:{kind:ChangeKind; items:string[]}) {
  if (!items.length) return null;
  return <div className="biz-change-group">
    <ChangeBadge kind={kind} count={items.length} />
    <ul className="biz-files">{items.map(item => <li key={item}><code>{item}</code></li>)}</ul>
  </div>;
}

/** One summary row of the preview: label plus compact badges; opens to the lists when it has any. */
export function StatRow({label, badges, children}:{label:React.ReactNode; badges?:React.ReactNode; children?:React.ReactNode}) {
  const head = <>
    <span className="biz-stat-label">{label}</span>
    {badges && <span className="biz-stat-badges">{badges}</span>}
  </>;
  return <li className="biz-stat">{children
    ? <details><summary className="biz-stat-row">{head}<span className="biz-chev" aria-hidden="true">›</span></summary><div className="biz-stat-body">{children}</div></details>
    : <div className="biz-stat-row">{head}</div>}
  </li>;
}

/** A loading state with the panel's skeleton blocks; the text is what assistive technology announces. */
export function Loading({text, card = true}:{text:string; card?:boolean}) {
  return <div className={card ? "card biz-section" : "biz-stack"} role="status" aria-busy="true">
    <p className="mute">{text}</p>
    <span className="skel fy-sk biz-skel" aria-hidden="true" />
    <span className="skel fy-sk biz-skel biz-skel-short" aria-hidden="true" />
  </div>;
}

/** An empty or failed state: icon, display-font title, text and an optional action. */
export function Empty({icon, title, children}:{icon?:string; title?:React.ReactNode; children?:React.ReactNode}) {
  return <div className="card empty">
    {icon && <span className="empty-icon" aria-hidden="true">{icon}</span>}
    {title && <h3 className="empty-title">{title}</h3>}
    {children}
  </div>;
}
