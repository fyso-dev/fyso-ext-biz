// OAuth 2.1 client for Fyso Biz: dynamic registration, PKCE login and refresh.
// Tokens live only in this project's runtime data (.data/ext/biz/), never in git,
// browser storage, URLs or workflow parameters.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {writePrivate} = require('./atomic-write.cjs');

const AGENT_SCOPE = 'mcp';
const PROFILE_SCOPE = 'framework_access';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Biz origin: HTTPS, or HTTP only on a loopback host for local development. */
function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_origin'); }
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || !['/', ''].includes(url.pathname)) throw Error('invalid_origin');
  return url.origin;
}

function dataDir(env = process.env) {
  if (!env.FYSO_DATA) throw Error('project environment required');
  return path.join(env.FYSO_DATA, 'ext', 'biz');
}

/** Public addresses of this project's gateway (D62: the scheme comes from the provider). */
function addresses(env = process.env) {
  const scheme = env.FYSO_WEB_SCHEME || 'http';
  if (!env.FYSO_WEB_DOMAIN || !['http', 'https'].includes(scheme)) throw Error('project environment required');
  const port = scheme === 'https' ? '' : `:${env.FYSO_HTTP_PORT}`;
  const host = app => `${scheme}://${app}.${env.FYSO_WEB_DOMAIN}${port}`;
  return {callback: `${host('biz')}/callback`, login: `${host('biz')}/login`, page: `${host('panel')}/#/extensions/biz/overview`};
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
async function json(response) {
  let body = null;
  try { body = await response.json(); } catch { /* handled below */ }
  return body;
}

function store({env = process.env, transport = fetch, now = Date.now} = {}) {
  const dir = dataDir(env), tokensFile = path.join(dir, 'oauth.json'), profileFile = path.join(dir, 'profile-oauth.json');
  const bizOrigin = () => origin(env.FYSO_BIZ_URL || '');

  async function metadata() {
    const base = bizOrigin();
    let response;
    try { response = await transport(`${base}/.well-known/oauth-authorization-server`, {redirect: 'error', signal: AbortSignal.timeout(15000)}); }
    catch { throw Error('connection_failed'); }
    const meta = response.ok ? await json(response) : null;
    if (!meta?.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) throw Error('oauth_not_supported');
    // Every endpoint must belong to the configured origin.
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      if (new URL(meta[key]).origin !== base) throw Error('oauth_not_supported');
    }
    if (!(meta.code_challenge_methods_supported || []).includes('S256')) throw Error('oauth_not_supported');
    return meta;
  }

  /** A public client registered once per Biz origin and callback address. */
  async function client(meta, redirectUri, scope) {
    const clientFile = path.join(dir, scope === PROFILE_SCOPE ? 'profile-client.json' : 'client.json');
    const saved = readJson(clientFile);
    if (saved?.origin === bizOrigin() && saved.redirectUri === redirectUri && saved.clientId) return saved.clientId;
    let response;
    try {
      response = await transport(meta.registration_endpoint, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({client_name: `Fyso ${scope === PROFILE_SCOPE ? 'sign-in' : 'project'} ${env.FYSO_PROJECT || ''}`.trim(), redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'})});
    } catch { throw Error('connection_failed'); }
    const body = response.ok ? await json(response) : null;
    if (!body?.client_id) throw Error('registration_failed');
    writePrivate(clientFile, {origin: bizOrigin(), redirectUri, clientId: body.client_id});
    return body.client_id;
  }

  /** Authorization request for the browser; the verifier stays with the caller. */
  async function begin(redirectUri, scope = AGENT_SCOPE) {
    const meta = await metadata(), clientId = await client(meta, redirectUri, scope);
    const verifier = crypto.randomBytes(32).toString('base64url'), state = crypto.randomBytes(24).toString('base64url');
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope,
      state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'}).toString();
    return {url: url.toString(), state, verifier, clientId, redirectUri, scope, origin: bizOrigin()};
  }

  async function grant(meta, params) {
    let response;
    try {
      response = await transport(meta.token_endpoint, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(params).toString()});
    } catch { throw Error('connection_failed'); }
    const body = response.ok ? await json(response) : null;
    if (!body?.access_token || String(body.token_type).toLowerCase() !== 'bearer') throw Error(response.status >= 400 && response.status < 500 ? 'access_denied' : 'remote_unavailable');
    return body;
  }
  const save = (body, clientId, previous = {}, file = tokensFile) => writePrivate(file, {
    origin: bizOrigin(), clientId, accessToken: body.access_token,
    refreshToken: body.refresh_token || previous.refreshToken || null,
    expiresAt: now() + Math.max(60, Number(body.expires_in) || 3600) * 1000,
    connectedAt: previous.connectedAt || new Date(now()).toISOString(),
  });

  async function exchange(pending, code, scope) {
    if (pending.scope !== scope || pending.origin !== bizOrigin() ||
        !code || typeof code !== 'string' || code.length > 2000) throw Error('invalid_callback');
    return grant(await metadata(), {grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri,
      client_id: pending.clientId, code_verifier: pending.verifier});
  }

  async function finish(pending, code) {
    save(await exchange(pending, code, AGENT_SCOPE), pending.clientId);
  }

  async function finishProfile(pending, code) {
    const body = await exchange(pending, code, PROFILE_SCOPE);
    const seconds = Number(body.expires_in);
    if (!Number.isFinite(seconds) || seconds <= 0) throw Error('invalid_profile_token');
    const grant = {accessToken: body.access_token, expiresAt: now() + seconds * 1000};
    // What only an explicit connect keeps (saveProfile); invisible to everything that just reads the token.
    Object.defineProperties(grant, {refreshToken: {value: body.refresh_token || null}, clientId: {value: pending.clientId}});
    return grant;
  }

  /**
   * Keep a profile grant (`framework_access`) so headless runs (the sync workflow, the
   * distribution's token command) can renew it. Only the person's explicit connect does this.
   */
  function saveProfile(grant) {
    if (!grant?.accessToken || !grant.refreshToken) throw Error('not_renewable');
    writePrivate(profileFile, {origin: bizOrigin(), clientId: grant.clientId, accessToken: grant.accessToken,
      refreshToken: grant.refreshToken, expiresAt: grant.expiresAt, connectedAt: new Date(now()).toISOString()});
  }

  // One refresh at a time: Biz rotates refresh tokens.
  async function locked(fn) {
    const lock = path.join(dir, 'refresh.lock');
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    for (let i = 0; ; i++) {
      try { fs.mkdirSync(lock); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch { continue; }
        if (i > 100) throw Error('refresh_busy');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try { return await fn(); } finally { fs.rmdirSync(lock); }
  }

  /** A valid access token of the agent grant, or of the profile grant, refreshed when it expires within a minute. */
  const accessToken = () => renewed(tokensFile);
  const profileAccessToken = () => renewed(profileFile);
  async function renewed(file) {
    const current = () => {
      const saved = readJson(file);
      return saved?.origin === bizOrigin() && saved.accessToken ? saved : null;
    };
    let saved = current();
    if (!saved) throw Error('not_connected');
    if (saved.expiresAt - now() > 60000) return saved.accessToken;
    return locked(async () => {
      saved = current();
      if (!saved) throw Error('not_connected');
      if (saved.expiresAt - now() > 60000) return saved.accessToken;
      if (!saved.refreshToken) throw Error('not_connected');
      const body = await grant(await metadata(), {grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: saved.clientId});
      save(body, saved.clientId, saved, file);
      return body.access_token;
    });
  }

  function status() {
    const saved = readJson(tokensFile);
    return saved?.origin === bizOrigin() && saved.accessToken
      ? {connected: true, connectedAt: saved.connectedAt, renewable: !!saved.refreshToken} : {connected: false};
  }
  function logout() { fs.rmSync(tokensFile, {force: true}); }
  const profileStatus = () => {
    const saved = readJson(profileFile);
    return {connected: saved?.origin === bizOrigin() && Boolean(saved.accessToken && saved.refreshToken)};
  };
  const profileLogout = () => fs.rmSync(profileFile, {force: true});

  return {begin: redirectUri => begin(redirectUri), finish, accessToken, status, logout, metadata,
    beginProfile: redirectUri => begin(redirectUri, PROFILE_SCOPE), finishProfile,
    saveProfile, profileAccessToken, profileStatus, profileLogout};
}

module.exports = {origin, addresses, store, dataDir};
