const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {origin, addresses, store} = require('../extensions/biz/auth.cjs');

const BIZ = 'https://biz.example.invalid';
function env() {
  return {FYSO_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'biz-auth-')), FYSO_BIZ_URL: BIZ, FYSO_WEB_DOMAIN: 'demo.localhost', FYSO_HTTP_PORT: '6100', FYSO_PROJECT: 'demo'};
}
function server({refresh = true} = {}) {
  const calls = [];
  let n = 0;
  const transport = async (url, options = {}) => {
    calls.push({url, options});
    const reply = body => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
    if (url.endsWith('/.well-known/oauth-authorization-server')) return reply({authorization_endpoint: `${BIZ}/oauth/authorize`, token_endpoint: `${BIZ}/oauth/token`, registration_endpoint: `${BIZ}/oauth/register`, code_challenge_methods_supported: ['S256']});
    if (url.endsWith('/oauth/register')) return reply({client_id: 'client-1'});
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(options.body);
      if (form.get('grant_type') === 'refresh_token' && !refresh) return new Response('{}', {status: 400});
      n++;
      return reply({access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: 'bearer', expires_in: 3600, form: Object.fromEntries(form)});
    }
    return new Response('', {status: 404});
  };
  return {transport, calls};
}

test('accepts HTTPS origins and HTTP only on loopback', () => {
  assert.equal(origin('https://biz.example'), 'https://biz.example');
  assert.equal(origin('http://localhost:8787'), 'http://localhost:8787');
  for (const bad of ['http://biz.example', 'https://u:p@biz.example', 'https://biz.example/api', 'ftp://localhost', 'nope']) assert.throws(() => origin(bad), {message: 'invalid_origin'});
});

test('callback and page addresses follow the project gateway', () => {
  assert.deepEqual(addresses(env()), {callback: 'http://biz.demo.localhost:6100/callback', login: 'http://biz.demo.localhost:6100/login', page: 'http://panel.demo.localhost:6100/#/extensions/biz/overview'});
  assert.equal(addresses({...env(), FYSO_WEB_SCHEME: 'https'}).callback, 'https://biz.demo.localhost/callback');
});

test('login uses PKCE S256, stores tokens privately and reuses the registration', async () => {
  const e = env(), {transport, calls} = server(), auth = store({env: e, transport});
  const request = await auth.begin(addresses(e).callback);
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://biz.demo.localhost:6100/callback');
  assert.ok(!request.url.includes(request.verifier));
  await auth.finish(request, 'code-1');
  const token = calls.find(c => c.url.endsWith('/oauth/token'));
  assert.equal(new URLSearchParams(token.options.body).get('code_verifier'), request.verifier);
  const file = path.join(e.FYSO_DATA, 'ext/biz/oauth.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(await auth.accessToken(), 'access-1');
  assert.deepEqual(Object.keys(auth.status()).sort(), ['connected', 'connectedAt', 'renewable']);
  await auth.begin(addresses(e).callback);
  assert.equal(calls.filter(c => c.url.endsWith('/oauth/register')).length, 1);
});

test('refreshes an expiring token and keeps the rotated refresh token', async () => {
  const e = env(), {transport} = server();
  let clock = Date.now();
  const auth = store({env: e, transport, now: () => clock});
  const request = await auth.begin(addresses(e).callback);
  await auth.finish(request, 'code-1');
  clock += 3600 * 1000;
  assert.equal(await auth.accessToken(), 'access-2');
  const saved = JSON.parse(fs.readFileSync(path.join(e.FYSO_DATA, 'ext/biz/oauth.json'), 'utf8'));
  assert.equal(saved.refreshToken, 'refresh-2');
});

test('a revoked grant fails closed; logout forgets it', async () => {
  const e = env(), {transport} = server({refresh: false});
  let clock = Date.now();
  const auth = store({env: e, transport, now: () => clock});
  await auth.finish(await auth.begin(addresses(e).callback), 'code-1');
  clock += 3600 * 1000;
  await assert.rejects(auth.accessToken(), {message: 'access_denied'});
  auth.logout();
  assert.deepEqual(auth.status(), {connected: false});
  await assert.rejects(auth.accessToken(), {message: 'not_connected'});
});

test('refuses authorization servers on another origin', async () => {
  const e = env();
  const transport = async () => new Response(JSON.stringify({authorization_endpoint: 'https://evil.invalid/a', token_endpoint: `${BIZ}/t`, registration_endpoint: `${BIZ}/r`, code_challenge_methods_supported: ['S256']}));
  await assert.rejects(store({env: e, transport}).begin('http://x/callback'), {message: 'oauth_not_supported'});
});

test('OAuth grants use the provider MCP route; personal tokens keep /api/mcp', () => {
  const {endpoint} = require('../extensions/biz/biz.cjs');
  assert.equal(endpoint('https://biz.example'), 'https://biz.example/api/mcp');
  assert.equal(endpoint('https://biz.example', true), 'https://biz.example/mcp');
});

test('profile sign-in has its own registration and does not replace the agent grant', async (t) => {
  const e = env(), {transport, calls} = server();
  t.after(() => fs.rmSync(e.FYSO_DATA, {recursive: true, force: true}));
  const auth = store({env: e, transport, now: () => 1000});
  const agent = await auth.begin(addresses(e).callback);
  assert.equal(new URL(agent.url).searchParams.get('scope'), 'mcp');
  await auth.finish(agent, 'agent-code');

  const profile = await auth.beginProfile('https://panel.demo.localhost/api/ext/biz/profile/callback');
  assert.equal(new URL(profile.url).searchParams.get('scope'), 'framework_access');
  await assert.rejects(auth.finish(profile, 'profile-code'), /invalid_callback/);
  await assert.rejects(auth.finishProfile(agent, 'agent-code'), /invalid_callback/);
  assert.deepEqual(await auth.finishProfile(profile, 'profile-code'), {accessToken: 'access-2', expiresAt: 3601000});
  assert.equal(await auth.accessToken(), 'access-1');
  assert.equal(calls.filter(c => c.url.endsWith('/oauth/register')).length, 2);
  assert.ok(fs.existsSync(path.join(e.FYSO_DATA, 'ext/biz/profile-client.json')));
});

test('profile OAuth failures report the failing step without saving a grant', async t => {
  const {fakeBiz, harness} = require('./helpers/index.cjs');
  const h = harness(t, {grant: false});
  const callback = 'https://panel.example.test/callback';

  h.biz.queue('oauth.metadata', fakeBiz.networkError(), fakeBiz.http(503));
  await assert.rejects(h.store.beginProfile(callback), {message: 'connection_failed'});
  await assert.rejects(h.store.beginProfile(callback), {message: 'oauth_not_supported'});
  h.biz.queue('oauth.register', fakeBiz.networkError(), fakeBiz.http(403));
  await assert.rejects(h.store.beginProfile(callback), {message: 'connection_failed'});
  await assert.rejects(h.store.beginProfile(callback), {message: 'registration_failed'});

  const pending = await h.store.beginProfile(callback);
  for (const code of [null, 123, 'x'.repeat(2001)]) {
    await assert.rejects(h.store.finishProfile(pending, code), {message: 'invalid_callback'});
  }
  assert.equal(h.biz.count('oauth.token'), 0);
  h.biz.queue('oauth.token', fakeBiz.networkError(), fakeBiz.http(503), fakeBiz.ok({access_token: 'token', token_type: 'Bearer', expires_in: 0}));
  await assert.rejects(h.store.finishProfile(pending, 'code'), {message: 'connection_failed'});
  await assert.rejects(h.store.finishProfile(pending, 'code'), {message: 'remote_unavailable'});
  await assert.rejects(h.store.finishProfile(pending, 'code'), {message: 'invalid_profile_token'});
  assert.deepEqual(h.store.profileStatus(), {connected: false});
});
