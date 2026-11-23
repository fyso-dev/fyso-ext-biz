const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const {createHash, randomUUID} = require('node:crypto');
const path = require('node:path');
const {origin, addresses} = require('./auth.cjs');

const CAPABILITY = 'action:feedback:submit';
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const reportId = value => typeof value === 'string' && ID.test(value);

async function report(root, id) {
  if (!reportId(id)) return null;
  const folder = path.join(await fs.realpath(root), 'project', 'wiki', 'feedback');
  try {
    if (await fs.realpath(folder) !== folder) return null;
    const file = await fs.open(path.join(folder, id + '.md'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 70000) return null;
      const buffer = Buffer.alloc(70001);
      const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 70000) return null;
      const content = buffer.subarray(0, bytesRead).toString('utf8');
      const start = '# Feedback\n\n- ID: ' + id + '\n';
      if (!content.startsWith(start)) return null;
      const match = content.match(/\n## Title\n\n([\s\S]*?)\n\n## Component\n\n([\s\S]*?)\n\n## Description and evidence\n\n([\s\S]+)$/);
      return match ? {id, title: match[1], body: 'Component: ' + match[2] + '\n\n' + match[3].trim()} : null;
    } finally { await file.close(); }
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

function validReceipt(receipt) {
  return Number.isSafeInteger(receipt?.number) && receipt.number > 0 && typeof receipt.url === 'string' &&
    new RegExp('^https://github[.]com/fyso-dev/agentic-framework/issues/' + receipt.number + '(#issuecomment-[0-9]+)?$').test(receipt.url);
}

function receiptStore(env, id) {
  const folder = path.join(env.FYSO_DATA, 'ext', 'biz', 'feedback');
  const scope = createHash('sha256').update(JSON.stringify([
    env.FYSO_BIZ_URL, env.FYSO_BIZ_ACCESS_ORGANIZATION, env.FYSO_BIZ_ACCESS_PROJECT,
  ])).digest('hex');
  const file = path.join(folder, scope + '-' + id + '.json');
  return {
    async read() {
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        return validReceipt(saved) ? saved : undefined;
      } catch { return undefined; }
    },
    async save(value) {
      await fs.mkdir(folder, {recursive: true, mode: 0o700});
      const temporary = file + '.' + randomUUID();
      try {
        await fs.writeFile(temporary, JSON.stringify(value), {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, {force: true}); }
    },
  };
}

function feedback({env, access, transport = fetch}) {
  const pendingReceipts = new Map();
  const submissions = new Map();

  async function persistReceipt(id, store, receipt) {
    try {
      await store.save(receipt);
      pendingReceipts.delete(id);
      return receipt;
    } catch {
      return {...receipt, persistencePending: true};
    }
  }

  async function recoverReceipt(id, store) {
    const pending = pendingReceipts.get(id);
    return pending ? persistReceipt(id, store, pending) : store.read();
  }

  async function submit({id, title, body, related}, token) {
    const store = receiptStore(env, id);
    const existing = await recoverReceipt(id, store);
    if (existing) return [200, existing];
    if (!await report(env.FYSO_ROOT, id)) return [404, {error: 'report_not_found'}];

    const target = new URL('/oauth/framework-feedback', origin(env.FYSO_BIZ_URL || ''));
    target.search = new URLSearchParams({organization: env.FYSO_BIZ_ACCESS_ORGANIZATION, project: env.FYSO_BIZ_ACCESS_PROJECT});
    const response = await transport(target, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({id, title, body, related}),
    });
    if (!response.ok) return [response.status === 409 ? 409 : response.status === 403 ? 403 : 502, {error: 'feedback_unavailable'}];
    const receipt = await response.json();
    if (!validReceipt(receipt)) return [502, {error: 'invalid_receipt'}];
    pendingReceipts.set(id, receipt);
    return [200, await persistReceipt(id, store, receipt)];
  }

  return async (req, res, url, session) => {
    const send = (status, data) => {
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(data));
    };
    if (!session || !await access.can(session.accessToken, CAPABILITY)) return send(403, {error: 'access_denied'});
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!reportId(id)) return send(404, {error: 'report_not_found'});
      const receipt = await recoverReceipt(id, receiptStore(env, id));
      const local = await report(env.FYSO_ROOT, id);
      if (!local && !receipt) return send(404, {error: 'report_not_found'});
      return send(200, {id, ...local, receipt});
    }
    if (req.method !== 'POST') return send(405, {error: 'method_not_allowed'});
    if (req.headers.origin !== new URL(addresses(env).page).origin) return send(403, {error: 'access_denied'});
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, {error: 'invalid_feedback'});
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 70000) return send(413, {error: 'invalid_feedback'});
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(400, {error: 'invalid_feedback'}); }
    const {id, title, body, related} = input ?? {};
    if (!reportId(id) || typeof title !== 'string' || typeof body !== 'string' ||
        (related !== undefined && (!reportId(related) || id === related))) return send(400, {error: 'invalid_feedback'});
    let submission = submissions.get(id);
    if (!submission) {
      submission = submit({id, title, body, related}, session.accessToken)
        .finally(() => submissions.delete(id));
      submissions.set(id, submission);
    }
    send(...await submission);
  };
}

module.exports = {feedback};
