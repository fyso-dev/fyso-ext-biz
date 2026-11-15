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
  assert.equal(origin('https://fyso.biz'), 'https://fyso.biz');
  assert.equal(origin('http://localhost:8787'), 'http://localhost:8787');
  for (const bad of ['http://fyso.biz', 'https://u:p@fyso.biz', 'https://fyso.biz/api', 'ftp://localhost', 'nope']) assert.throws(() => origin(bad), {message: 'invalid_origin'});
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
