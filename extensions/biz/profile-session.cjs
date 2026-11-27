const {feedback} = require('./feedback.cjs');
const {createHash, randomBytes} = require('node:crypto');
const {addresses, origin, store} = require('./auth.cjs');
const {projectAccess, reportOf} = require('./project-access.cjs');

const LOGIN_TTL = 10 * 60 * 1000;
const SESSION_TTL = 60 * 60 * 1000;
const AUTHORIZATION_PATH = '/oauth/authorize';
const random = () => randomBytes(32).toString('base64url');

const messages = {
  en: {title: 'Sign in with Fyso Biz', description: 'Use your Fyso Biz account to access this project.', button: 'Continue with Fyso Biz'},
  es: {title: 'Ingresá con Fyso Biz', description: 'Usá tu cuenta de Fyso Biz para acceder a este proyecto.', button: 'Continuar con Fyso Biz'},
};

function signInPage(req, res, bizOrigin) {
  const language = /^en\b/i.test(req.headers['accept-language'] || '') ? 'en' : 'es';
  const {title, description, button} = messages[language];
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; form-action 'self' ${bizOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  });
  res.end(`<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><main><h1>${title}</h1><p>${description}</p>
<form method="post" action="/api/ext/biz/profile/login"><button type="submit">${button}</button></form></main></html>`);
}


function cookieValue(req, name) {
  return (req.headers.cookie || '').split(/;\s*/)
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

const GRANT_FAILURES = new Set(['not_connected', 'reauthorize_required', 'frozen', 'no_access', 'access_required']);
const SETUP_OPS = new Map([['status', 'GET'], ['preview', 'POST'], ['confirm', 'POST'], ['cancel', 'POST'], ['publish', 'POST'], ['merge', 'POST'], ['disconnect', 'POST']]);
// Statuses of the codes the setup answers with; anything else is an unexpected failure.
const SETUP_STATUS = {setup_not_installed: 409, stale_base: 409, merge_conflict: 409, no_access: 403, not_connected: 409, reauthorize_required: 409, frozen: 403, access_required: 403, admin_required: 403, preview_changed: 409,
  busy: 409, not_renewable: 409, dist_failed: 502, key_unavailable: 502};

function profileSessions({env = process.env, auth = store({env}), access = projectAccess({env}), now = Date.now, managedSetup} = {}) {
  const submitFeedback = feedback({env, access});
  const pending = new Map();
  const sessions = new Map();
  const remoteTokens = new Map();
  const secure = env.FYSO_WEB_SCHEME === 'https';
  const bindingCookie = secure ? '__Host-fyso_biz_profile_state' : 'fyso_biz_profile_state';
  const sessionCookie = secure ? '__Host-fyso_biz_profile' : 'fyso_biz_profile';
  const cookie = (name, value, ms) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ms / 1000)}${secure ? '; Secure' : ''}`;
  const respond = (res, status, headers = {}) => res.writeHead(status, {'Cache-Control': 'no-store', ...headers}).end();
  const enabled = Boolean(env.FYSO_BIZ_ACCESS_ORGANIZATION);

  function current(req) {
    const id = cookieValue(req, sessionCookie);
    const session = sessions.get(id);
    return session && session.expiresAt > now() && session.user === req.headers['remote-user'] ? session : null;
  }

  function revoke(req) {
    const session = current(req);
    if (session) {
      sessions.delete(cookieValue(req, sessionCookie));
      if (session.remoteDigest) remoteTokens.delete(session.remoteDigest);
    }
    const binding = cookieValue(req, bindingCookie);
    if (binding) {
      for (const [state, entry] of pending) {
        if (entry.binding === binding && entry.user === req.headers['remote-user']) pending.delete(state);
      }
    }
  }

  async function finishLogin(req, res, url, user) {
    const state = url.searchParams.get('state');
    const entry = pending.get(state);
    if (!entry || entry.user !== user || entry.binding !== cookieValue(req, bindingCookie)) {
      respond(res, 400);
      return;
    }
    pending.delete(state);
    if (url.searchParams.has('error')) { respond(res, 403); return; }
    const token = await auth.finishProfile(entry.request, url.searchParams.get('code'));
    const identity = await access.identity(token.accessToken);
    const ttl = Math.min(SESSION_TTL, token.expiresAt - now());
    if (ttl < 1000) { respond(res, 403); return; }

    revoke(req);
    const id = random();
    sessions.set(id, {...identity, user, accessToken: token.accessToken, grant: token, expiresAt: now() + ttl});
    respond(res, 303, {Location: '/#/extensions/biz/overview', 'Set-Cookie': [
      cookie(bindingCookie, '', 0), cookie(sessionCookie, id, ttl),
    ]});
  }

  async function issueRemoteToken(req, res) {
    const session = current(req);
    if (!secure || !session || !await access.can(session.accessToken, 'app:mcp')) {
      respond(res, 403);
      return;
    }
    const id = cookieValue(req, sessionCookie);
    const secret = random();
    const digest = createHash('sha256').update(secret).digest('hex');
    if (session.remoteDigest) remoteTokens.delete(session.remoteDigest);
    session.remoteDigest = digest;
    remoteTokens.set(digest, {id, expiresAt: session.expiresAt});
    res.writeHead(200, {'Cache-Control': 'no-store', 'Content-Type': 'application/json'});
    res.end(JSON.stringify({token: `fyso-ext-biz.${secret}`, expiresAt: session.expiresAt}));
  }

  function expireSessions() {
    for (const entries of [pending, sessions, remoteTokens]) {
      for (const [id, item] of entries) if (item.expiresAt <= now()) entries.delete(id);
    }
  }

  /**
   * Managed setup (managed-setup.cjs). The person's own session is the credential: connecting keeps
   * its profile grant for the distribution commands and the sync; cancel and disconnect remove it.
   */
  async function setupRoute(req, res, op) {
    const session = current(req);
    const json = (status, body) => {
      res.writeHead(status, {'Cache-Control': 'no-store', 'Content-Type': 'application/json'});
      res.end(JSON.stringify(body));
    };
    if (!session) return respond(res, 403);
    managedSetup ??= require('./managed-setup.cjs').setup({env, access});
    try {
      if (op === 'status') {
        const report = await reportOf(access, session.accessToken).catch(() => null);
        return json(200, {...managedSetup.status(), admin: report?.admin === true, offered: report?.setup ?? null, remoteFrozen: report?.frozen === true, noAccess: report?.frozen === true && !managedSetup.status().version});
      }
      if (op === 'preview') {
        // The distribution commands read the grant from disk, so it is kept before the plan is made.
        auth.saveProfile(session.grant);
        return json(200, await managedSetup.preview());
      }
      if (op === 'confirm') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 2048) return json(400, {error: 'invalid_input'}); }
        const {digest} = JSON.parse(raw || '{}');
        return json(200, await managedSetup.apply({digest: typeof digest === 'string' ? digest : ''}));
      }
      if (op === 'publish') return json(200, await managedSetup.publish());
      if (op === 'merge') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return json(400, {error: 'invalid_input'}); }
        const {ours, theirs} = JSON.parse(raw || '{}');
        return json(200, await managedSetup.mergeAndPublish({ours, theirs}));
      }
      return json(200, managedSetup.disconnect());
    } catch (error) {
      // A cancelled first connect drops the grant it just saved, but only when the grant itself is the problem
      // (rejected by Biz, or no access). Biz being down or erroring must not make the person sign in again.
      if (op === 'preview' && !managedSetup.status().connected && (GRANT_FAILURES.has(error.message) || [401, 403].includes(error.status))) auth.profileLogout();
      json(SETUP_STATUS[error.message] || 502, {error: SETUP_STATUS[error.message] ? error.message : 'setup_failed', ...(error.files ? {files: error.files} : {})});
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const setupOp = /^\/profile\/setup\/([a-z]+)$/.exec(url.pathname)?.[1];
    if (setupOp && SETUP_OPS.get(setupOp) === req.method) {
      if (!enabled) { respond(res, 404); return true; }
      if (typeof req.headers['remote-user'] !== 'string' || !req.headers['remote-user']) { respond(res, 401); return true; }
      expireSessions();
      await setupRoute(req, res, setupOp);
      return true;
    }
    if (!['/profile/sign-in', '/profile/login', '/profile/callback', '/profile/logout', '/profile/status', '/profile/mcp-token', '/profile/feedback', '/profile/access'].includes(url.pathname)) return false;
    if (!enabled) {
      respond(res, url.pathname === '/profile/access' ? 204 : 404);
      return true;
    }

    const user = req.headers['remote-user'];
    if (typeof user !== 'string' || !user) { respond(res, 401); return true; }
    expireSessions();

    try {
      if (url.pathname === '/profile/feedback') {
        await submitFeedback(req, res, url, current(req));
        return true;
      }
      switch (req.method + ' ' + url.pathname) {
      case 'GET /profile/sign-in':
        // The login answers 303 to Biz; Chrome applies form-action to that redirect, so the Biz origin must be allowed (never a wildcard).
        signInPage(req, res, origin(env.FYSO_BIZ_URL || ''));
        break;
      case 'POST /profile/login': {
        const callback = new URL('/extensions/biz/oauth/callback', addresses(env).page).href;
        const request = await auth.beginProfile(callback);
        const destination = new URL(request.url);
        const bizOrigin = origin(env.FYSO_BIZ_URL || '');
        if (destination.origin !== bizOrigin ||
            destination.protocol !== new URL(bizOrigin).protocol ||
            destination.pathname !== AUTHORIZATION_PATH) {
          throw new Error('invalid_authorization_url');
        }
        const query = destination.searchParams.toString();
        const binding = random();
        pending.set(request.state, {request, user, binding, expiresAt: now() + LOGIN_TTL});
        res.writeHead(303, {
          'Cache-Control': 'no-store',
          Location: `${bizOrigin}${AUTHORIZATION_PATH}?${query}`,
          'Set-Cookie': cookie(bindingCookie, binding, LOGIN_TTL),
        }).end();
        break;
      }
      case 'GET /profile/callback':
        await finishLogin(req, res, url, user);
        break;
      case 'POST /profile/logout':
        revoke(req);
        respond(res, 204, {'Set-Cookie': cookie(sessionCookie, '', 0)});
        break;
      case 'POST /profile/mcp-token':
        await issueRemoteToken(req, res);
        break;
      case 'GET /profile/access': {
        const session = current(req);
        const report = session ? await reportOf(access, session.accessToken)
          : {capabilities: [], admin: false, departments: [], policy: null, reauthorizeRequired: false};
        const {capabilities} = report;
        res.writeHead(200, {'Cache-Control': 'no-store', 'Content-Type': 'application/json'});
        const remoteCredentialPath = secure && capabilities.includes('app:mcp')
          ? '/api/ext/biz/profile/mcp-token' : undefined;
        // `departments`, `admin` and `policy` feed the panel's "Your departments" tab; they are display data only.
        res.end(JSON.stringify({capabilities, remoteCredentialPath, admin: report.admin,
          departments: report.departments, policy: report.policy,
          ...(report.reauthorizeRequired ? {reauthorizeRequired: true} : {})}));
        break;
      }
      case 'GET /profile/status':
        res.writeHead(200, {'Cache-Control': 'no-store', 'Content-Type': 'application/json'});
        res.end(JSON.stringify({connected: Boolean(current(req))}));
        break;
      default:
        respond(res, 405);
      }
    } catch {
      respond(res, 502);
    }
    return true;
  }

  function remote(digest) {
    const token = remoteTokens.get(digest);
    const session = token && sessions.get(token.id);
    return session && session.expiresAt > now() ? session : null;
  }

  return {handle, current, remote, revoke};
}

module.exports = {profileSessions};
