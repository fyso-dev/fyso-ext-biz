const {feedback} = require('./feedback.cjs');
const {createHash, randomBytes} = require('node:crypto');
const {addresses, store} = require('./auth.cjs');
const {projectAccess} = require('./project-access.cjs');

const LOGIN_TTL = 10 * 60 * 1000;
const SESSION_TTL = 60 * 60 * 1000;
const random = () => randomBytes(32).toString('base64url');

const messages = {
  en: {title: 'Sign in with Fyso Biz', description: 'Use your Fyso Biz account to access this project.', button: 'Continue with Fyso Biz'},
  es: {title: 'Ingresá con Fyso Biz', description: 'Usá tu cuenta de Fyso Biz para acceder a este proyecto.', button: 'Continuar con Fyso Biz'},
};

function signInPage(req, res) {
  const language = /^en\b/i.test(req.headers['accept-language'] || '') ? 'en' : 'es';
  const {title, description, button} = messages[language];
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(`<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><main><h1>${title}</h1><p>${description}</p>
<form method="post" action="/api/ext/biz/profile/login"><button type="submit">${button}</button></form></main></html>`);
}


function cookieValue(req, name) {
  return (req.headers.cookie || '').split(/;\s*/)
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function profileSessions({env = process.env, auth = store({env}), access = projectAccess({env}), now = Date.now} = {}) {
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
  const enabled = Boolean(env.FYSO_BIZ_ACCESS_ORGANIZATION && env.FYSO_BIZ_ACCESS_PROJECT);

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

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!['/profile/sign-in', '/profile/login', '/profile/callback', '/profile/logout', '/profile/status', '/profile/mcp-token', '/profile/feedback', '/profile/access'].includes(url.pathname)) return false;
    if (!enabled) {
      respond(res, url.pathname === '/profile/access' ? 204 : 404);
      return true;
    }

    const user = req.headers['remote-user'];
    if (typeof user !== 'string' || !user) { respond(res, 401); return true; }
    for (const entries of [pending, sessions, remoteTokens]) {
      for (const [id, item] of entries) if (item.expiresAt <= now()) entries.delete(id);
    }

    const page = addresses(env).page;
    try {
      if (url.pathname === '/profile/feedback') {
        await submitFeedback(req, res, url, current(req));
      } else if (req.method === 'GET' && url.pathname === '/profile/sign-in') {
        signInPage(req, res);
      } else if (req.method === 'POST' && url.pathname === '/profile/login') {
        const callback = new URL('/extensions/biz/oauth/callback', page).href;
        const request = await auth.beginProfile(callback);
        const binding = random();
        pending.set(request.state, {request, user, binding, expiresAt: now() + LOGIN_TTL});
        respond(res, 303, {Location: request.url, 'Set-Cookie': cookie(bindingCookie, binding, LOGIN_TTL)});
      } else if (req.method === 'GET' && url.pathname === '/profile/callback') {
        const state = url.searchParams.get('state');
        const entry = pending.get(state);
        if (!entry || entry.user !== user || entry.binding !== cookieValue(req, bindingCookie)) {
          respond(res, 400);
          return true;
        }
        pending.delete(state);
        if (url.searchParams.has('error')) { respond(res, 403); return true; }
        const token = await auth.finishProfile(entry.request, url.searchParams.get('code'));
        const identity = await access.identity(token.accessToken);
        const ttl = Math.min(SESSION_TTL, token.expiresAt - now());
        if (ttl < 1000) { respond(res, 403); return true; }

        revoke(req);
        const id = random();
        sessions.set(id, {...identity, user, accessToken: token.accessToken, expiresAt: now() + ttl});
        respond(res, 303, {Location: page, 'Set-Cookie': [
          cookie(bindingCookie, '', 0), cookie(sessionCookie, id, ttl),
        ]});
      } else if (req.method === 'POST' && url.pathname === '/profile/logout') {
        revoke(req);
        respond(res, 204, {'Set-Cookie': cookie(sessionCookie, '', 0)});
      } else if (req.method === 'POST' && url.pathname === '/profile/mcp-token') {
        const session = current(req);
        if (!secure || !session || !await access.can(session.accessToken, 'app:mcp')) {
          respond(res, 403);
          return true;
        }
        const id = cookieValue(req, sessionCookie);
        const secret = random();
        const digest = createHash('sha256').update(secret).digest('hex');
        if (session.remoteDigest) remoteTokens.delete(session.remoteDigest);
        session.remoteDigest = digest;
        remoteTokens.set(digest, {id, expiresAt: session.expiresAt});
        res.writeHead(200, {'Cache-Control': 'no-store', 'Content-Type': 'application/json'});
        res.end(JSON.stringify({token: `fyso-ext-biz.${secret}`, expiresAt: session.expiresAt}));
      } else if (req.method === 'GET' && url.pathname === '/profile/access') {
        const session = current(req);
        const capabilities = session ? await access.capabilities(session.accessToken) : [];
        res.writeHead(200, {'Cache-Control': 'no-store', 'Content-Type': 'application/json'});
        const remoteCredentialPath = secure && capabilities.includes('app:mcp')
          ? '/api/ext/biz/profile/mcp-token' : undefined;
        res.end(JSON.stringify({capabilities, remoteCredentialPath}));
      } else if (req.method === 'GET' && url.pathname === '/profile/status') {
        res.writeHead(200, {'Cache-Control': 'no-store', 'Content-Type': 'application/json'});
        res.end(JSON.stringify({connected: Boolean(current(req))}));
      } else {
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
