import { useEffect, useState, useStore, useTranslation } from '@fyso/panel'

type Address = { bot: string; address: string }
export function Mail() {
  const { t } = useTranslation(),
    store = useStore()
  const [addresses, setAddresses] = useState<Address[]>([])
  const [error, setError] = useState(false),
    [busy, setBusy] = useState(false)
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
  async function change(bot: string, active: boolean) {
    setBusy(true)
    setError(false)
    try {
      const response = await fetch(
        '/api/ext/biz/mail/' + (active ? 'deactivate' : 'activate'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot }),
        },
      )
      if (!response.ok) throw Error()
      await refresh()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card">
      <h3>{t('biz.mailTitle')}</h3>
      {error && <p role="alert">{t('biz.mailError')}</p>}
      <ul className="biz-bots">
        {store.runtimeBots.data?.map(bot => {
          const address = addresses.find(item => item.bot === bot.id)?.address
          return (
            <li key={bot.id}>
              <strong>{bot.name}</strong>
              {address && (
                <>
                  <code>{address}</code>
                  <button
                    className="btn btn-soft"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(address)
                        .catch(() => setError(true))
                    }>
                    {t('biz.mailCopy')}
                  </button>
                </>
              )}
              <button
                className="btn btn-soft"
                disabled={busy}
                onClick={() => void change(bot.id, !!address)}>
                {t(address ? 'biz.mailOff' : 'biz.mailOn')}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
