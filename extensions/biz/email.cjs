const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { origin } = require('./auth.cjs')
const { token } = require('./biz.cjs')
const { deliverEmail } = require('./email-delivery.cjs')

async function remote(action, payload, env = process.env) {
  const base = origin(env.FYSO_BIZ_URL || 'https://fyso.biz')
  const credential = await token(env)
  if (!credential.oauth) throw Error('oauth_required')
  const response = await fetch(base + '/agent-mail/' + action, {
    method: payload ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: 'Bearer ' + credential.token,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  if (!response.ok) throw Error('agent_mail_unavailable')
  return response.json()
}

async function receive(env = process.env) {
  const mail = await remote('pending', undefined, env)
  if (!mail) return
  const attachments = []
  if (mail.attachments?.length) {
    if (
      !/^[a-f0-9-]{36}$/.test(mail.mailbox) ||
      !/^[a-f0-9]{64}$/.test(mail.deliveryId)
    )
      throw Error('invalid_mail_destination')
    const directory = path.resolve(
      env.FYSO_DATA,
      'ext',
      'biz',
      'mail',
      mail.mailbox,
      mail.deliveryId,
    )
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    for (const [index, attachment] of mail.attachments.entries()) {
      // Use a local numeric filename so inbound names cannot affect paths.
      const file = path.join(directory, String(index + 1))
      const bytes = Buffer.from(attachment.content, 'base64')
      const temporary = path.join(directory, randomUUID() + '.tmp')
      try {
        await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
        try {
          await fs.link(temporary, file)
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          if (!(await fs.readFile(file)).equals(bytes))
            throw Error('attachment_retry_mismatch')
        }
      } finally {
        await fs.rm(temporary, { force: true })
      }
      attachments.push({ name: attachment.name, path: file })
    }
  }
  const receipt = await deliverEmail({
    ...mail,
    attachments,
    port: env.FYSO_OMB_PORT,
  })
  await remote(
    'ack',
    {
      mailbox: mail.mailbox,
      deliveryId: mail.deliveryId,
      messageId: receipt.messageId,
    },
    env,
  )
}

function startReceiver(env = process.env) {
  const tick = async () => {
    try {
      await receive(env)
    } catch {
      /* A failed handoff remains pending on Biz. */
    }
    setTimeout(tick, 30000).unref()
  }
  void tick()
}

module.exports = { remote, receive, startReceiver }

// Use stdin to keep the email body out of process arguments.
if (require.main === module) {
  const { readFileSync } = require('node:fs')
  Promise.resolve()
    .then(() => remote('send', JSON.parse(readFileSync(0, 'utf8'))))
    .then(receipt => console.log(JSON.stringify(receipt)))
    .catch(() => {
      console.error('Email send was not confirmed. Verify before retrying.')
      process.exitCode = 1
    })
}
