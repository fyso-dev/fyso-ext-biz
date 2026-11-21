import { useEffect, useState, useStore, useTranslation } from '@fyso/panel'

type Address = { bot: string; address: string }
type Action = 'activate' | 'deactivate' | 'reset'

/** One row per agent: its address (copy), a switch, and a new address on request. */
export function Mail() {
  const { t } = useTranslation(),
    store = useStore()
  const [addresses, setAddresses] = useState<Address[]>([])
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  async function refresh() {
    const response = await fetch('/api/ext/biz/mail/addresses', {
      cache: 'no-store',
    })
    const result = await response.json()
    if (!response.ok || !Array.isArray(result)) throw Error()
    setAddresses(result)
  }
  useEffect(() => {
    void refresh().catch(() => setError(true))
  }, [])
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(id)
  }, [copied])
  async function change(bot: string, action: Action) {
    setBusy(bot)
    setError(false)
    setConfirming(null)
    try {
      const response = await fetch('/api/ext/biz/mail/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot }),
      })
      if (!response.ok) throw Error()
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }
  function copy(bot: string, address: string) {
    navigator.clipboard
      .writeText(address)
      .then(() => setCopied(bot))
      .catch(() => {
        /* clipboard blocked: the address stays selectable */
      })
  }
  const bots = store.runtimeBots.data ?? []
  return (
    <section className="biz-stack">
      <div>
        <h2 className="biz-h2">{t('biz.mailTitle')}</h2>
        <p className="note">{t('biz.mailIntro')}</p>
      </div>
      {error && (
        <p role="alert" className="banner banner-down">
          {t('biz.mailError')}
        </p>
      )}
      <ul className="card list">
        {bots.map(bot => {
          const address = addresses.find(item => item.bot === bot.id)?.address
          const working = busy === bot.id
          return (
            <li key={bot.id} className="row biz-mail-row">
              <span className="avatar" aria-hidden="true">
                {bot.name.charAt(0).toUpperCase()}
              </span>
              <div className="biz-mail-main">
                <strong className="ellipsis">{bot.name}</strong>
                {address ? (
                  <div className="copyline">
                    <code>{address}</code>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => copy(bot.id, address)}
                      aria-live="polite">
                      {t(copied === bot.id ? 'biz.mailCopied' : 'biz.mailCopy')}
                    </button>
                  </div>
                ) : (
                  <span className="hint">{t('biz.mailNone')}</span>
                )}
                {confirming === bot.id && (
                  <div className="biz-mail-confirm" role="group">
                    <span className="hint">{t('biz.mailResetWarn')}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-pri"
                      onClick={() => void change(bot.id, 'reset')}>
                      {t('biz.mailResetConfirm')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirming(null)}>
                      {t('biz.mailCancel')}
                    </button>
                  </div>
                )}
              </div>
              <div className="biz-mail-actions">
                {address && confirming !== bot.id && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={working}
                    onClick={() => setConfirming(bot.id)}>
                    {t('biz.mailReset')}
                  </button>
                )}
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={!!address}
                  aria-label={t('biz.mailSwitch', { name: bot.name })}
                  disabled={working}
                  onClick={() =>
                    void change(bot.id, address ? 'deactivate' : 'activate')
                  }>
                  <span />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
