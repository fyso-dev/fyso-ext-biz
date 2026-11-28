const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {profileSessions} = require('../extensions/biz/profile-session.cjs');
const {fakeBiz, harness, WINDOWS} = require('./helpers/index.cjs');

const env = {
  FYSO_BIZ_URL: 'https://biz.test',
  FYSO_WEB_SCHEME: 'https',
  FYSO_WEB_DOMAIN: 'demo.test',
  FYSO_BIZ_ACCESS_ORGANIZATION: 'org',
  FYSO_BIZ_ACCESS_PROJECT: 'project',
};

function request(path, user, {method = 'GET', cookie} = {}) {
  return {url: path, method, headers: {'remote-user': user, cookie}};
}

async function invoke(profiles, req) {
  const output = {};
  const res = {
    writeHead(status, headers) {
      Object.assign(output, {status, headers});
      return this;
    },
    end(body) { output.body = body; },
  };
  output.handled = await profiles.handle(req, res);
  return output;
}

test('binds the one-time OAuth callback and session to the authenticated browser user', async () => {
  let now = 1000;
  let capabilities = ['app:panel', 'app:mcp'];
  const invalidated = [];
  const profiles = profileSessions({
    env, now: () => now,
    auth: {
      async beginProfile(callback) {
        assert.equal(callback, 'https://panel.demo.test/extensions/biz/oauth/callback');
        return {state: 'test-state', url: 'https://biz.test/oauth/authorize?state=test-state&code_challenge=challenge'};
      },
      async finishProfile(_, code) {
        assert.equal(code, 'oauth-code');
        return {accessToken: 'private-token', expiresAt: 7000};
      },
    },
    access: {invalidate: token => invalidated.push(token), async capabilities(token) {
      assert.equal(token, 'private-token');
      return capabilities;
    }, async can(token, capability) {
      return token === 'private-token' && capability === 'app:mcp';
    }, async identity(token) {
      assert.equal(token, 'private-token');
      return {subject: 'person-1'};
    }},
  });
  const login = await invoke(profiles, request('/profile/login', 'ana', {method: 'POST'}));
  assert.equal(login.status, 303);
  assert.equal(login.headers.Location, 'https://biz.test/oauth/authorize?state=test-state&code_challenge=challenge');
  const binding = login.headers['Set-Cookie'];
  assert.match(binding, /^__Host-.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  const callback = '/profile/callback?state=test-state&code=oauth-code';
  assert.equal((await invoke(profiles, request(callback, 'ana'))).status, 400);
  const cookie = binding.split(';')[0];
  assert.equal((await invoke(profiles, request(callback, 'luis', {cookie}))).status, 400);
  const connected = await invoke(profiles, request(callback, 'ana', {cookie}));
  assert.equal(connected.status, 303);
  assert.equal(connected.headers.Location, '/#/extensions/biz/overview');
  assert.equal((await invoke(profiles, request(callback, 'ana', {cookie}))).status, 400);

  const sessionCookie = connected.headers['Set-Cookie'][1];
  assert.doesNotMatch(sessionCookie, /private-token|Domain=/);
  const session = sessionCookie.split(';')[0];
  assert.equal(profiles.current(request('/', 'ana', {cookie: session})).subject, 'person-1');
  assert.equal(profiles.current(request('/', 'luis', {cookie: session})), null);
  const report = await invoke(profiles, request('/profile/access', 'ana', {cookie: session}));
  assert.deepEqual(JSON.parse(report.body), {
    capabilities: ['app:panel', 'app:mcp'], remoteCredentialPath: '/api/ext/biz/profile/mcp-token',
    admin: false, departments: [], policy: null,
  });
  const panelGrants = async () => JSON.parse((await invoke(profiles, request('/profile/access', 'ana', {cookie: session}))).body).capabilities;
  capabilities = ['app:panel', 'workflow:*:run'];
  assert.deepEqual(await panelGrants(), ['app:panel', 'workflow:ext-biz-team:run', 'workflow:fyso-bots-plan:run', 'workflow:fyso-bots-apply:run']);
  capabilities = ['app:panel', '*'];
  assert.deepEqual(await panelGrants(), ['app:panel']);
  const issue = () => invoke(profiles, request('/profile/mcp-token', 'ana', {method: 'POST', cookie: session}));
  const minted = await issue();
  const secret = JSON.parse(minted.body).token.split('.')[1];
  const digest = createHash('sha256').update(secret).digest('hex');
  assert.equal(profiles.remote(digest).subject, 'person-1');
  const replacement = JSON.parse((await issue()).body).token.split('.')[1];
  assert.equal(profiles.remote(digest), null);
  const replacementDigest = createHash('sha256').update(replacement).digest('hex');
  assert.equal(profiles.remote(replacementDigest).subject, 'person-1');
  profiles.revoke(request('/', 'luis', {cookie: session}));
  assert.equal(profiles.remote(replacementDigest).subject, 'person-1');
  assert.deepEqual(invalidated, ['private-token']); // login
  profiles.revoke(request('/', 'ana', {cookie: session}));
  assert.deepEqual(invalidated, ['private-token', 'private-token']); // logout/revoke
  assert.equal(profiles.current(request('/', 'ana', {cookie: session})), null);
  assert.equal(profiles.remote(replacementDigest), null);
  now = 7000;
  assert.equal(profiles.current(request('/', 'ana', {cookie: session})), null);
});

for (const url of ['https://other.test/oauth/authorize', 'https://biz.test/other']) {
  test(`rejects the authorization URL ${url}`, async () => {
    const profiles = profileSessions({
      env, access: {},
      auth: {async beginProfile() {
        return {state: 'test-state', url};
      }},
    });
    const login = await invoke(profiles, request('/profile/login', 'ana', {method: 'POST'}));
    assert.equal(login.status, 502);
    assert.equal(login.headers.Location, undefined);
    assert.equal(login.headers['Set-Cookie'], undefined);
  });
}

test('requires a gateway identity on profile routes', async () => {
  const profiles = profileSessions({env, auth: {}, access: {}});
  const result = await invoke(profiles, request('/profile/login', undefined, {method: 'POST'}));
  assert.equal(result.status, 401);
});

test('renders a same-origin sign-in form in the browser language', async () => {
  const profiles = profileSessions({env, auth: {}, access: {}});
  const req = request('/profile/sign-in', 'ana');
  req.headers['accept-language'] = 'en-US,en;q=0.9';
  const response = await invoke(profiles, req);
  assert.equal(response.status, 200);
  assert.match(response.body, /Sign in with Fyso Biz/);
  assert.match(response.body, /method="post" action="\/api\/ext\/biz\/profile\/login"/);
  assert.match(response.headers['Content-Security-Policy'], /form-action 'self' https:\/\/biz\.test;/);
  assert.doesNotMatch(response.headers['Content-Security-Policy'], /\*/);
});

test('the sign-in CSP form-action covers the origin the login redirects to', async () => {
  const url = 'https://biz.test/oauth/authorize?state=s&code_challenge=c';
  const profiles = profileSessions({env, access: {}, auth: {async beginProfile() { return {state: 's', url}; }}});
  const page = await invoke(profiles, request('/profile/sign-in', 'ana'));
  const login = await invoke(profiles, request('/profile/login', 'ana', {method: 'POST'}));
  assert.equal(login.status, 303);
  const sources = page.headers['Content-Security-Policy'].match(/form-action ([^;]+)/)[1].split(' ');
  assert.ok(sources.includes(new URL(login.headers.Location).origin));
});

test('the access report flags an old grant that must reconnect, so the panel does not show it as having no departments', async () => {
  const profiles = profileSessions({
    env, now: () => 1000,
    auth: {
      async beginProfile() { return {state: 's', url: 'https://biz.test/oauth/authorize?state=s&code_challenge=c'}; },
      async finishProfile() { return {accessToken: 'old-grant', expiresAt: 7000}; },
    },
    access: {
      async identity() { return {subject: 'person-1'}; },
      async can() { return false; },
      async report() { return {capabilities: [], admin: false, departments: [], policy: null, reauthorizeRequired: true}; },
    },
  });
  const login = await invoke(profiles, request('/profile/login', 'ana', {method: 'POST'}));
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  const connected = await invoke(profiles, request('/profile/callback?state=s&code=x', 'ana', {cookie}));
  const session = connected.headers['Set-Cookie'][1].split(';')[0];
  const report = await invoke(profiles, request('/profile/access', 'ana', {cookie: session}));
  assert.deepEqual(JSON.parse(report.body), {capabilities: [], admin: false, departments: [], policy: null, reauthorizeRequired: true});
});

test('the panel can tell managed access is configured and that no profile session exists yet', async () => {
  const profiles = profileSessions({env, auth: {}, access: {}});
  const status = await invoke(profiles, request('/profile/status', 'ana'));
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), {connected: false});
  // Setup needs a session: without one the panel shows the Connect action instead.
  assert.equal((await invoke(profiles, request('/profile/setup/status', 'ana'))).status, 403);
  // Not configured: the status route is 404, so the panel shows no Setup tab.
  const plain = profileSessions({env: {...env, FYSO_BIZ_ACCESS_ORGANIZATION: ''}, auth: {}, access: {}});
  assert.equal((await invoke(plain, request('/profile/status', 'ana'))).status, 404);
});

test('the panel shows Setup with a Connect action when managed access has no profile session', () => {
  const fs = require('node:fs');
  const read = file => fs.readFileSync(`${__dirname}/../panel-src/screens/${file}`, 'utf8');
  assert.match(read('Biz.tsx'), /showSetup = managed\?\.managed === true/);
  assert.match(read('Access.tsx'), /action="\/api\/ext\/biz\/profile\/login"/);
  assert.match(read('Setup.tsx'), /response\?\.status === 403/);
});

// The panel's first Connect saves the profile grant before the preview. A failed preview drops it only when
// the grant is the problem.
async function failedPreview(t, error) {
  let logouts = 0;
  const {setup} = require('../extensions/biz/managed-setup.cjs');
  const {tempProject} = require('./helpers/index.cjs');
  const project = tempProject(t);
  const authLogin = {saveProfile() {}, profileStatus: () => ({connected: false}), profileLogout: () => { logouts++; },
    profileAccessToken: async () => 't',
    async beginProfile() { return {state: 's', url: 'https://biz.test/oauth/authorize?state=s'}; },
    async finishProfile() { return {accessToken: 't', expiresAt: Date.now() + 3600000}; }};
  const managedSetup = setup({env: project.env, store: authLogin, access: {async report() { throw error; }}});
  const p = profileSessions({env, auth: authLogin, managedSetup, access: {async identity() { return {subject: 'x'}; }}});
  const login = await invoke(p, request('/profile/login', 'ana', {method: 'POST'}));
  const binding = login.headers['Set-Cookie'].split(';')[0];
  const cb = await invoke(p, request('/profile/callback?state=s&code=c', 'ana', {cookie: binding}));
  const session = cb.headers['Set-Cookie'][1].split(';')[0];
  const out = await invoke(p, request('/profile/setup/preview', 'ana', {method: 'POST', cookie: session}));
  return {logouts, status: out.status};
}

test('the Setup panel previews before publishing and both languages have the preview strings', () => {
  const fs = require('node:fs');
  const read = file => fs.readFileSync(`${__dirname}/../${file}`, 'utf8');
  const setupScreen = read('panel-src/screens/Setup.tsx');
  assert.match(setupScreen, /run\("publish-preview"/);
  assert.match(setupScreen, /run\("publish", \{version:pub\.version, digest:pub\.digest\}/);
  assert.doesNotMatch(setupScreen, /run\("publish", undefined/);
  assert.match(read('extensions/biz/panel/main.js'), /publish-preview/);
  const [en, es] = ['en', 'es'].map(l => JSON.parse(read(`panel-src/locales/${l}.json`)).setup);
  assert.deepEqual(Object.keys(en.pub).sort(), Object.keys(es.pub).sort());
  for (const key of ['framework_update_required', 'preview_stale', 'publish_failed']) assert.ok(en.errors[key] && es.errors[key], key);
  for (const key of ['connectedPublisher', 'publishedVersion']) assert.ok(en[key] && es[key], key);
});

// A signed-in browser user and the setup routes with a fake managed setup.
async function withSession(managedSetup, access = {async identity() { return {subject: 'x'}; }}) {
  const authLogin = {saveProfile() {}, async beginProfile() { return {state: 's', url: 'https://biz.test/oauth/authorize?state=s'}; },
    async finishProfile() { return {accessToken: 't', expiresAt: Date.now() + 3600000}; }};
  const p = profileSessions({env, auth: authLogin, managedSetup, access});
  const login = await invoke(p, request('/profile/login', 'ana', {method: 'POST'}));
  const cb = await invoke(p, request('/profile/callback?state=s&code=c', 'ana', {cookie: login.headers['Set-Cookie'].split(';')[0]}));
  const cookie = cb.headers['Set-Cookie'][1].split(';')[0];
  const post = (op, body) => {
    const req = request(`/profile/setup/${op}`, 'ana', {method: 'POST', cookie});
    const raw = JSON.stringify(body ?? {});
    req[Symbol.asyncIterator] = async function* () { yield raw; };
    return invoke(p, req).then(out => ({...out, json: JSON.parse(out.body)}));
  };
  return {p, post, status: async () => JSON.parse((await invoke(p, request('/profile/setup/status', 'ana', {cookie}))).body)};
}

test('regression: the shown version is fresh after a publish through the gateway', async t => {
  const h = harness(t, {scenario: 'admin'});
  h.biz.publish('v2');
  const {post, status} = await withSession({
    status: () => ({connected: true}),
    async publish() { h.biz.publish('v3'); return {version: 'v3'}; },
  }, h.access);
  assert.equal((await status()).bizVersion, 'v2');
  const reports = h.biz.count('report');
  assert.equal((await post('publish', {version: 'v3', digest: 'd'})).status, 200);
  assert.equal((await status()).bizVersion, 'v3');
  assert.equal(h.biz.count('report'), reports + 1);
});

test('publish-preview and publish: only through a profile session; publish passes the preview version and digest back', async () => {
  const seen = [];
  const {p, post} = await withSession({status: () => ({connected: true}),
    async publishPreview() { seen.push('preview'); return {version: 'v4', digest: 'd'}; },
    async publish(body) { seen.push(body); return {version: 'v4'}; }});
  // Without a session: refused, and nothing runs.
  assert.equal((await invoke(p, request('/profile/setup/publish-preview', 'ana', {method: 'POST'}))).status, 403);
  assert.equal((await invoke(p, request('/profile/setup/publish', 'ana', {method: 'POST'}))).status, 403);
  assert.equal((await invoke(p, request('/profile/setup/publish-preview', 'ana'))).handled, false, 'POST only');
  assert.deepEqual(seen, []);
  const preview = await post('publish-preview');
  assert.deepEqual([preview.status, preview.json], [200, {version: 'v4', digest: 'd'}]);
  const published = await post('publish', {version: 'v4', digest: 'd', extra: 1});
  assert.equal(published.status, 200);
  assert.deepEqual(seen, ['preview', {version: 'v4', digest: 'd'}]);
});

test('publish-preview and publish answer with the codes the panel acts on', async () => {
  const failing = code => async () => { throw Object.assign(Error(code), {detail: 'tail'}); };
  for (const [code, status] of [['framework_update_required', 409], ['stale_base', 409], ['preview_stale', 409], ['preview_required', 400], ['publish_failed', 502]]) {
    const {post} = await withSession({status: () => ({connected: true}), publishPreview: failing(code), publish: failing(code)});
    for (const op of ['publish-preview', 'publish']) {
      const out = await post(op, {version: 'v4', digest: 'd'});
      assert.deepEqual([out.status, out.json.error], [status, code], `${op} ${code}`);
    }
  }
  const {post} = await withSession({status: () => ({connected: true}), publish: failing('publish_failed')});
  assert.equal((await post('publish', {})).json.detail, 'tail');
});

test('a failed preview keeps the grant when Biz is unavailable or errors, and drops it when the grant is rejected', async t => {
  assert.equal((await failedPreview(t, Object.assign(Error('biz_access_unavailable'), {status: 503}))).logouts, 0);
  assert.equal((await failedPreview(t, Error('dist_failed'))).logouts, 0);
  assert.equal((await failedPreview(t, Object.assign(Error('biz_access_unavailable'), {status: 401}))).logouts, 1);
  assert.equal((await failedPreview(t, Error('reauthorize_required'))).logouts, 1);
});

test('forUser finds the latest live session of a web user, for hosts that never receive the cookie', async () => {
  let now = 1000;
  const profiles = profileSessions({
    env, now: () => now,
    auth: {
      async beginProfile() { return {state: `s${now}`, url: 'https://biz.test/oauth/authorize?state=x'}; },
      async finishProfile() { return {accessToken: `token-${now}`, expiresAt: now + 60_000}; },
    },
    access: {identity: async () => ({}), invalidate() {}},
  });
  const login = async user => {
    const begun = await invoke(profiles, request('/profile/login', user, {method: 'POST'}));
    const binding = /fyso_biz_profile_state=([^;]+)/.exec(begun.headers['Set-Cookie'])[1];
    const done = await invoke(profiles, request(`/profile/callback?state=s${now}&code=c`, user, {cookie: `__Host-fyso_biz_profile_state=${binding}`}));
    assert.equal(done.status, 303);
  };
  assert.equal(profiles.forUser('ana'), null);
  await login('ana');
  assert.equal(profiles.forUser('ana').accessToken, 'token-1000');
  now = 2000;
  await login('ana');
  assert.equal(profiles.forUser('ana').accessToken, 'token-2000');
  assert.equal(profiles.forUser('bob'), null);
  assert.equal(profiles.forUser(''), null);
  now = 2000 + 61_000;
  assert.equal(profiles.forUser('ana'), null);
});

test('signing in again after a paused sync clears the pause and starts a sync; a normal sign-in does neither', async () => {
  for (const resumed of [true, false]) {
    const calls = [];
    const managedSetup = {status: () => ({connected: true}), reauthorized: grant => { calls.push(['reauthorized', grant.accessToken]); return resumed; },
      sync: async () => { calls.push(['sync']); return {status: 'noop'}; }};
    const auth = {async beginProfile() { return {state: 's', url: 'https://biz.test/oauth/authorize?state=s'}; },
      async finishProfile() { return {accessToken: 'renewed', expiresAt: Date.now() + 3600000}; }};
    const p = profileSessions({env, auth, managedSetup, access: {async identity() { return {subject: 'x'}; }}});
    const login = await invoke(p, request('/profile/login', 'ana', {method: 'POST'}));
    const cb = await invoke(p, request('/profile/callback?state=s&code=c', 'ana', {cookie: login.headers['Set-Cookie'].split(';')[0]}));
    assert.equal(cb.status, 303);
    assert.deepEqual(calls, [['reauthorized', 'renewed']], 'the pause is cleared before the redirect; the sync waits for the response');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, resumed ? [['reauthorized', 'renewed'], ['sync']] : [['reauthorized', 'renewed']]);
  }
});

test('the setup status carries the version Biz shows, and records a self-published one', async () => {
  const seen = [];
  const managedSetup = {status: () => ({connected: true, version: 'v2', selfPublished: null, paused: null, notices: []}), noteReport: report => seen.push(report.setup.version)};
  const authLogin = {saveProfile() {}, async beginProfile() { return {state: 's', url: 'https://biz.test/oauth/authorize?state=s'}; },
    async finishProfile() { return {accessToken: 't', expiresAt: Date.now() + 3600000}; }};
  const access = {async identity() { return {subject: 'x'}; }, async report() { return {capabilities: [], admin: true, departments: [], policy: null, reauthorizeRequired: false, setup: {version: 'v3'}}; }};
  const p = profileSessions({env, auth: authLogin, managedSetup, access});
  const login = await invoke(p, request('/profile/login', 'ana', {method: 'POST'}));
  const cb = await invoke(p, request('/profile/callback?state=s&code=c', 'ana', {cookie: login.headers['Set-Cookie'].split(';')[0]}));
  const out = await invoke(p, request('/profile/setup/status', 'ana', {cookie: cb.headers['Set-Cookie'][1].split(';')[0]}));
  assert.equal(JSON.parse(out.body).bizVersion, 'v3');
  assert.deepEqual(seen, ['v3']);
});

test('the Setup panel offers a sign-in when paused for reauthorization, keeps one Disconnect, and has the strings in both languages', () => {
  const fs = require('node:fs');
  const read = file => fs.readFileSync(`${__dirname}/../${file}`, 'utf8');
  const screen = read('panel-src/screens/Setup.tsx');
  assert.match(screen, /action="\/api\/ext\/biz\/profile\/login"/);
  assert.match(screen, /reason === "reauthorize_required"/);
  assert.doesNotMatch(screen, /run\("disconnect"/, 'Disconnect lives in the page header only');
  assert.match(screen, /NOTICES_SHOWN/);
  const [en, es] = ['en', 'es'].map(l => JSON.parse(read(`panel-src/locales/${l}.json`)).setup);
  for (const key of ['reauthorize', 'reauthorizeButton', 'showAll', 'showMore', 'noticePaused']) assert.ok(en[key] && es[key], key);
  assert.deepEqual(Object.keys(en.codes).sort(), Object.keys(es.codes).sort());
  assert.equal(es.reauthorize, 'Tu conexión con Fyso Biz venció. Volvé a autorizar para seguir sincronizando.');
  for (const text of [en.errors.reauthorize_required, es.errors.reauthorize_required, ...Object.values(en.codes), ...Object.values(es.codes)]) assert.doesNotMatch(text, /reauthorize_required/);
});

function browserLogin(h, user = 'ana', managedSetup = h.managed) {
  const profiles = profileSessions({env: h.env, auth: h.store, access: h.access, now: h.clock.now, managedSetup});
  const begin = async () => {
    const login = await invoke(profiles, request('/profile/login', user, {method: 'POST'}));
    assert.equal(login.status, 303);
    const state = new URL(login.headers.Location).searchParams.get('state');
    const cookie = login.headers['Set-Cookie'].split(';')[0];
    return ({includeState = true, ...params} = {code: 'oauth-code'}) => {
      const query = new URLSearchParams(params);
      if (includeState) query.set('state', state);
      return invoke(profiles, request(`/profile/callback?${query}`, user, {cookie}));
    };
  };
  return {profiles, begin};
}

test('a busy gateway preview leaves the running setup credential in place', async t => {
  const fs = require('node:fs');
  const h = harness(t);
  const {begin, profiles} = browserLogin(h, 'ana', null);
  const callback = await begin();
  const signedIn = await callback();
  const cookie = signedIn.headers['Set-Cookie'][1].split(';')[0];
  const lock = h.project.path('.data/ext/biz/setup.lock');
  fs.mkdirSync(lock);
  const previous = h.project.readProfileGrant();
  const out = await invoke(profiles, request('/profile/setup/preview', 'ana', {method: 'POST', cookie}));
  assert.deepEqual([out.status, JSON.parse(out.body).error], [409, 'busy']);
  assert.deepEqual(h.project.readProfileGrant(), previous);
});

test('OAuth callback rejects missing and expired state before exchanging the code', async t => {
  const h = harness(t, {grant: false});
  const {begin, profiles} = browserLogin(h);
  const callback = await begin();
  const missing = await callback({includeState: false, code: 'oauth-code'});
  assert.equal(missing.status, 400);
  assert.equal(missing.headers['Set-Cookie'], undefined);
  h.clock.advance(WINDOWS.LOGIN_TTL_MS);
  assert.equal((await callback()).status, 400);
  assert.equal(h.biz.count('oauth.token'), 0);
  assert.equal(h.biz.count('identity'), 0);
  assert.equal(profiles.forUser('ana'), null);
});

test('profile cookies are host-only on HTTPS and local HTTP', async t => {
  for (const scheme of ['https', 'http']) {
    await t.test(scheme, async st => {
      const h = harness(st, {project: {env: {FYSO_WEB_SCHEME: scheme, FYSO_HTTP_PORT: '8080'}}});
      const {begin, profiles} = browserLogin(h);
      const callback = await begin();
      const result = await callback();
      assert.equal(result.status, 303);
      const [clear, session] = result.headers['Set-Cookie'];
      const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=3600'];
      if (scheme === 'https') flags.push('Secure');
      const [pair, ...attributes] = session.split('; ');
      const prefix = scheme === 'https' ? '__Host-' : '';
      assert.equal(pair.split('=')[0], `${prefix}fyso_biz_profile`);
      assert.deepEqual(attributes, flags);
      assert.doesNotMatch(session, /;\s*Domain=/i);
      assert.match(clear, /Max-Age=0(?:;|$)/);
      const profile = await invoke(profiles, request('/profile/status', 'ana', {cookie: pair}));
      assert.deepEqual(JSON.parse(profile.body), {connected: true});
      const mcp = await invoke(profiles, request('/profile/mcp-token', 'ana', {method: 'POST', cookie: pair}));
      if (scheme === 'http') assert.equal(mcp.status, 403);
    });
  }
});

test('forUser skips a newer short-lived session and returns the older live session', async t => {
  const h = harness(t);
  const {begin, profiles} = browserLogin(h);
  const older = await begin();
  assert.equal((await older()).status, 303);
  const newer = await begin();
  h.biz.queue('oauth.token', fakeBiz.ok({access_token: 'short-lived', token_type: 'Bearer', expires_in: 2}));
  assert.equal((await newer()).status, 303);
  assert.equal(profiles.forUser('ana').accessToken, 'short-lived');
  h.clock.advance(2_000);
  assert.equal(profiles.forUser('ana').accessToken, 'access-1');
  h.clock.advance(WINDOWS.SESSION_TTL_MS - 2_000);
  assert.equal(profiles.forUser('ana'), null);
});

test('sign-in saves the replacement credential and resumes the paused setup sync', async t => {
  const h = harness(t);
  h.connect({version: 'v2', etag: h.biz.etag});
  h.biz.revoke('profile-token');
  assert.deepEqual(await h.managed.sync(), {status: 'paused', reason: 'reauthorize_required'});
  h.biz.publish('v3');

  // Observe completion of the real sync triggered by the callback.
  let sync;
  const managedSetup = {...h.managed, sync() { return sync = h.managed.sync(); }};
  const {begin} = browserLogin(h, 'ana', managedSetup);
  const callback = await begin();
  assert.equal((await callback()).status, 303);
  assert.equal(h.managed.status().paused, null);
  assert.equal(h.project.readProfileGrant().accessToken, 'access-1');
  assert.equal(sync, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(sync, 'the callback scheduled a sync');
  assert.equal((await sync).status, 'applied');
  assert.equal(h.biz.last('report').token, 'access-1');
  assert.equal(h.project.readState().version, 'v3');
});

test('OAuth denial and credentials with less than a second of life cannot start a session', async t => {
  const h = harness(t, {grant: false});
  const {begin, profiles} = browserLogin(h);
  const denied = await begin();
  assert.equal((await denied({error: 'access_denied'})).status, 403);
  assert.equal(h.biz.count('oauth.token'), 0);

  const short = await begin();
  h.biz.queue('oauth.token', fakeBiz.ok({access_token: 'short-lived', token_type: 'Bearer', expires_in: 0.5}));
  assert.equal((await short()).status, 403);
  assert.equal(profiles.forUser('ana'), null);
});
