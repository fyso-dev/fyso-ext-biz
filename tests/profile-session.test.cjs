const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {profileSessions} = require('../extensions/biz/profile-session.cjs');

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
      return ['app:panel', 'app:mcp'];
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
async function failedPreview(error) {
  let logouts = 0;
  const auth = {saveProfile() {}};
  const managedSetup = {status: () => ({connected: false}), async preview() { throw error; }};
  // Seed a session through the real login/callback path.
  const authLogin = {...auth, async beginProfile() { return {state: 's', url: 'https://biz.test/oauth/authorize?state=s'}; },
    async finishProfile() { return {accessToken: 't', expiresAt: Date.now() + 3600000}; }};
  const p = profileSessions({env, auth: authLogin, managedSetup, access: {async identity() { return {subject: 'x'}; }}});
  const login = await invoke(p, request('/profile/login', 'ana', {method: 'POST'}));
  const binding = login.headers['Set-Cookie'].split(';')[0];
  const cb = await invoke(p, request('/profile/callback?state=s&code=c', 'ana', {cookie: binding}));
  const session = cb.headers['Set-Cookie'][1].split(';')[0];
  authLogin.profileLogout = () => { logouts++; };
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
async function withSession(managedSetup) {
  const authLogin = {saveProfile() {}, async beginProfile() { return {state: 's', url: 'https://biz.test/oauth/authorize?state=s'}; },
    async finishProfile() { return {accessToken: 't', expiresAt: Date.now() + 3600000}; }};
  const p = profileSessions({env, auth: authLogin, managedSetup, access: {async identity() { return {subject: 'x'}; }}});
  const login = await invoke(p, request('/profile/login', 'ana', {method: 'POST'}));
  const cb = await invoke(p, request('/profile/callback?state=s&code=c', 'ana', {cookie: login.headers['Set-Cookie'].split(';')[0]}));
  const cookie = cb.headers['Set-Cookie'][1].split(';')[0];
  const post = (op, body) => {
    const req = request(`/profile/setup/${op}`, 'ana', {method: 'POST', cookie});
    const raw = JSON.stringify(body ?? {});
    req[Symbol.asyncIterator] = async function* () { yield raw; };
    return invoke(p, req).then(out => ({...out, json: JSON.parse(out.body)}));
  };
  return {p, post};
}

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

test('a failed preview keeps the grant when Biz is unavailable or errors, and drops it when the grant is rejected', async () => {
  assert.equal((await failedPreview(Object.assign(Error('biz_access_unavailable'), {status: 503}))).logouts, 0);
  assert.equal((await failedPreview(Error('dist_failed'))).logouts, 0);
  assert.equal((await failedPreview(Object.assign(Error('biz_access_unavailable'), {status: 401}))).logouts, 1);
  assert.equal((await failedPreview(Error('reauthorize_required'))).logouts, 1);
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
