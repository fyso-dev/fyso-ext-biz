const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const {createHash, randomUUID} = require('node:crypto');
const path = require('node:path');
const {origin, addresses} = require('./auth.cjs');

const CAPABILITY = 'action:feedback:submit';
const RECEIPT_UNAVAILABLE = {error: 'receipt_unavailable'};
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
  if (!Number.isSafeInteger(receipt?.number) || receipt.number <= 0 || typeof receipt.url !== 'string') return false;
  const match = /^https:\/\/github\.com\/fyso-dev\/agentic-framework\/issues\/(\d+)(?:#issuecomment-\d+)?$/.exec(receipt.url);
  return match?.[1] === String(receipt.number);
}

function receiptStore(env, id) {
  const folder = path.join(env.FYSO_DATA, 'ext', 'biz', 'feedback');
  const scope = createHash('sha256').update(JSON.stringify([
    origin(env.FYSO_BIZ_URL || ''), env.FYSO_BIZ_ACCESS_ORGANIZATION, env.FYSO_BIZ_ACCESS_PROJECT,
  ])).digest('hex');
  const file = path.join(folder, scope + '-' + id + '.json');
  return {
    async read() {
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        return validReceipt(saved) ? {receipt: saved} : {unavailable: true};
      } catch (error) {
        return error.code === 'ENOENT' ? {} : {unavailable: true};
      }
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

  function requestBiz(method, token, id, payload) {
    const target = new URL('/oauth/framework-feedback', origin(env.FYSO_BIZ_URL || ''));
    target.search = new URLSearchParams({organization: env.FYSO_BIZ_ACCESS_ORGANIZATION});
    if (env.FYSO_BIZ_ACCESS_PROJECT) target.searchParams.set('project', env.FYSO_BIZ_ACCESS_PROJECT);
    const headers = {Authorization: `Bearer ${token}`};
    if (method === 'GET') target.searchParams.set('id', id);
    else headers['Content-Type'] = 'application/json';
    return transport(target, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000), headers,
      body: payload,
    });
  }

  function recordReceipt(id, store, receipt) {
    pendingReceipts.set(id, receipt);
    return persistReceipt(id, store, receipt);
  }

  async function recoverReceipt(id, store, token) {
    const pending = pendingReceipts.get(id);
    if (pending) return {receipt: await persistReceipt(id, store, pending)};
    const local = await store.read();
    if (local.receipt) return local;
    try {
      const response = await requestBiz('GET', token, id);
      if (response.status === 404) return local;
      if (response.status === 409) return {failure: [409, {error: 'submission_pending'}]};
      if (response.status === 403 || response.status === 401) return {failure: [403, {error: 'access_denied'}]};
      if (response.ok) {
        const receipt = await response.json();
        if (validReceipt(receipt)) return {receipt: await recordReceipt(id, store, receipt)};
      }
    } catch {
      return {unavailable: true};
    }
    return {unavailable: true};
  }

  async function submit({id, title, body, related}, token) {
    const store = receiptStore(env, id);
    const {receipt: existing, unavailable, failure} = await recoverReceipt(id, store, token);
    if (failure) return failure;
    if (unavailable) return [503, RECEIPT_UNAVAILABLE];
    if (existing) return [409, {error: 'already_published', receipt: existing}];
    if (!await report(env.FYSO_ROOT, id)) return [404, {error: 'report_not_found'}];

    const response = await requestBiz('POST', token, id, JSON.stringify({id, title, body, related}));
    if (!response.ok) {
      const status = [409, 403].includes(response.status) ? response.status : 502;
      return [status, {error: 'feedback_unavailable'}];
    }
    const receipt = await response.json();
    if (!validReceipt(receipt)) return [502, {error: 'invalid_receipt'}];
    return [200, await recordReceipt(id, store, receipt)];
  }

  async function preview(url, token, send) {
    const id = url.searchParams.get('id');
    if (!reportId(id)) return send(404, {error: 'report_not_found'});
    if (submissions.has(id)) return send(409, {error: 'submission_pending'});
    const {receipt, unavailable, failure} = await recoverReceipt(id, receiptStore(env, id), token);
    if (failure) return send(...failure);
    if (unavailable) return send(503, RECEIPT_UNAVAILABLE);
    if (receipt) return send(200, {id, receipt});
    const local = await report(env.FYSO_ROOT, id);
    if (!local) return send(404, {error: 'report_not_found'});
    return send(200, local);
  }

  async function confirm(req, token, send) {
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
    const confirmation = JSON.stringify([token, title, body, related]);
    const active = submissions.get(id);
    if (active) {
      if (active.confirmation !== confirmation) return send(409, {error: 'confirmation_in_progress'});
      return send(...await active.result);
    }
    const result = submit({id, title, body, related}, token)
      .finally(() => submissions.delete(id));
    submissions.set(id, {confirmation, result});
    send(...await result);
  }

  return async (req, res, url, session) => {
    const send = (status, data) => {
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(data));
    };
    if (!session || !await access.can(session.accessToken, CAPABILITY)) return send(403, {error: 'access_denied'});
    if (req.method === 'GET') return preview(url, session.accessToken, send);
    if (req.method === 'POST') return confirm(req, session.accessToken, send);
    return send(405, {error: 'method_not_allowed'});
  };
}

module.exports = {feedback};
