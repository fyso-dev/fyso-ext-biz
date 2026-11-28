const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {server, listenPrivate} = require('../extensions/biz/gateway.cjs');

const env = {FYSO_WEB_DOMAIN: 'project.test', FYSO_WEB_SCHEME: 'https'};
const callback = 'https://biz.project.test/callback';
const page = 'https://panel.project.test/#/extensions/biz/overview';

function request(handler, url, {method = 'GET', cookie} = {}) {
  const result = {};
  const response = {
    writeHead(status, headers) {
      Object.assign(result, {status, headers});
      return this;
    },
    end(body) { result.body = body; },
  };
  return Promise.resolve(handler({method, url, headers: {cookie}}, response)).then(() => result);
}

function fixture(t) {
  let clock = 1000;
  let state = 0;
  const auth = {
    begin: t.mock.fn(async redirect => {
      assert.equal(redirect, callback);
      return {state: String(++state), verifier: 'pkce', url: 'https://provider.test/authorize'};
    }),
    finish: t.mock.fn(async () => {}),
  };
  const handler = server({env, auth, now: () => clock}).listeners('request')[0];
  return {
    auth, handler,
    advance(ms) { clock += ms; },
    async login() {
      const response = await request(handler, '/login');
      assert.equal(response.status, 302);
      assert.equal(response.headers.Location, 'https://provider.test/authorize');
      assert.equal(response.headers['Cache-Control'], 'no-store');
      const header = response.headers['Set-Cookie'];
      assert.match(header, /^fyso_biz_login=[\w-]+; Path=\/callback; HttpOnly; SameSite=Lax; Max-Age=600$/);
      return {url: '/callback?state=' + state, cookie: header.split(';')[0]};
    },
  };
}

test('routes health and login, then consumes the bound callback exactly once', async t => {
  const f = fixture(t);
  assert.equal((await request(f.handler, '/health')).status, 204);
  assert.equal((await request(f.handler, '/health', {method: 'POST'})).status, 404);
  assert.equal((await request(f.handler, '/missing')).status, 404);
  const {url, cookie} = await f.login();
  const result = await request(f.handler, url + '&code=grant', {cookie: 'other=1; ' + cookie});
  assert.equal(result.status, 302);
  assert.deepEqual(result.headers, {
    Location: page, 'Cache-Control': 'no-store',
    'Set-Cookie': 'fyso_biz_login=; Path=/callback; HttpOnly; SameSite=Lax; Max-Age=0',
  });
  const [[entry, code]] = f.auth.finish.mock.calls.map(call => call.arguments);
  assert.equal(entry.verifier, 'pkce');
  assert.equal(code, 'grant');
  assert.match((await request(f.handler, url, {cookie})).body, /invalid_callback/);
  assert.equal(f.auth.finish.mock.callCount(), 1);
});

test('rejects missing, mismatched, expired, swept and denied callbacks', async t => {
  const f = fixture(t);
  const invalid = async (url, cookie, key = 'invalid_callback') => {
    const result = await request(f.handler, url, {cookie});
    assert.equal(result.status, 400);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.match(result.body, new RegExp(key));
    assert.ok(result.body.includes(page));
  };
  await invalid('/callback');
  let login = await f.login();
  await invalid(login.url);
  await invalid(login.url, login.cookie);
  login = await f.login();
  await invalid(login.url, 'fyso_biz_login=wrong');
  login = await f.login();
  f.advance(600001);
  await invalid(login.url, login.cookie);
  login = await f.login();
  f.advance(600001);
  await f.login();
  await invalid(login.url, login.cookie);
  login = await f.login();
  await invalid(login.url + '&error=denied', login.cookie, 'access_denied');
  assert.equal(f.auth.finish.mock.callCount(), 0);
});

test('reports recognized OAuth errors and masks unexpected errors', async t => {
  const f = fixture(t);
  const {url, cookie} = await f.login();
  f.auth.finish.mock.mockImplementation(async () => { throw Error('remote_unavailable'); });
  const denied = await request(f.handler, url, {cookie});
  assert.equal(denied.status, 502);
  assert.match(denied.body, /remote_unavailable/);
  f.auth.begin.mock.mockImplementation(async () => { throw Error('provider secret'); });
  const failed = await request(f.handler, '/login');
  assert.equal(failed.status, 502);
  assert.match(failed.body, /connection_failed/);
  assert.doesNotMatch(failed.body, /provider secret/);
});

test('private listener replaces an old socket, restricts its mode and dispatches requests', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-gateway-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const socket = path.join(directory, 'api.sock');
  fs.writeFileSync(socket, 'stale');
  const previous = process.umask();
  const fake = new (require('node:events').EventEmitter)();
  fake.listen = (target, ready) => {
    assert.equal(target, socket);
    assert.equal(process.umask(), 0o177);
    assert.equal(fs.existsSync(target), false);
    fs.writeFileSync(target, '');
    ready();
  };
  const create = t.mock.method(http, 'createServer', () => fake);
  const handler = t.mock.fn((req, res) => res.writeHead(201).end(req.url));
  assert.equal(await listenPrivate(handler, socket), fake);
  assert.equal(process.umask(), previous);
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  const dispatch = create.mock.calls[0].arguments[0];
  assert.equal((await request(dispatch, '/health')).status, 204);
  assert.deepEqual(await request(dispatch, '/action', {method: 'POST'}), {
    status: 201, headers: undefined, body: '/action',
  });
  assert.equal(handler.mock.callCount(), 1);
});

test('gateway entry point starts the login listener, receiver and private API routing', async t => {
  const Module = require('node:module');
  const {EventEmitter} = require('node:events');
  const filename = require.resolve('../extensions/biz/gateway.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-gateway-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const socket = path.join(directory, 'api.sock');
  const names = ['FYSO_EXT_BIZ_PORT', 'FYSO_EXT_SOCKET', 'FYSO_DATA'];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (saved[i] === undefined) delete process.env[name];
    else process.env[name] = saved[i];
  }));
  Object.assign(process.env, {FYSO_DATA: directory, FYSO_EXT_BIZ_PORT: '7080'});

  const listeners = [];
  let bindError;
  const listen = t.mock.fn(function (target, host, ready) {
    if (typeof host === 'function') {
      if (bindError) return this.emit('error', bindError);
      assert.equal(target, socket);
      fs.writeFileSync(target, '');
      host();
    } else {
      assert.equal(host, '127.0.0.1');
      assert.equal(target, 7080);
      ready();
    }
  });
  t.mock.method(http, 'createServer', handler => {
    listeners.push(handler);
    return Object.assign(new EventEmitter(), {listen});
  });
  const receiver = t.mock.fn();
  const handled = t.mock.fn((req, res) => res.writeHead(203).end());
  const profiles = {handle: async (req, res) => {
    if (req.url !== '/profile') return false;
    res.writeHead(202).end();
    return true;
  }};
  const policy = t.mock.fn((req, res) => res.writeHead(200).end());
  const mcp = t.mock.fn((req, res) => res.writeHead(201).end());
  const dependencies = {
    './email.cjs': {startReceiver: receiver},
    './api.cjs': {api: () => handled},
    './profile-session.cjs': {profileSessions: () => profiles},
    './project-policy.cjs': {projectPolicy: options => { assert.equal(options.profiles, profiles); return policy; }},
    './mcp-policy.cjs': {mcpPolicy: options => { assert.equal(options.profiles, profiles); return mcp; }},
  };
  const logs = t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  const exit = t.mock.method(process, 'exit', code => { throw Error('exit ' + code); });
  function run() {
    // Supply the external services while evaluating the actual entry point.
    const entry = new Module(filename);
    entry.filename = filename;
    const load = entry.require.bind(entry);
    entry.require = id => dependencies[id] ?? load(id);
    const previous = process.mainModule;
    process.mainModule = entry;
    try {
      entry._compile(fs.readFileSync(filename, 'utf8'), filename);
    } finally {
      process.mainModule = previous;
    }
  }

  delete process.env.FYSO_EXT_SOCKET;
  run();
  assert.equal(listeners.length, 1);
  assert.equal(receiver.mock.callCount(), 1);

  process.env.FYSO_EXT_SOCKET = socket;
  run();
  assert.equal(listeners.length, 3);
  const handler = listeners[2];
  assert.equal((await request(handler, '/mcp-access/check', {method: 'POST'})).status, 201);
  assert.equal((await request(handler, '/project-access/check?cap=panel')).status, 200);
  assert.equal((await request(handler, '/profile')).status, 202);
  assert.equal((await request(handler, '/api')).status, 203);
  assert.equal(mcp.mock.callCount(), 1);
  assert.equal(policy.mock.callCount(), 1);
  assert.equal(handled.mock.callCount(), 1);
  assert.equal(listen.mock.callCount(), 3);
  assert.equal(receiver.mock.callCount(), 2);
  assert.ok(logs.mock.calls.some(call => call.arguments[0] === 'Fyso Biz panel API on ' + socket));

  delete process.env.FYSO_EXT_BIZ_PORT;
  assert.throws(run, /exit 1/);
  assert.deepEqual(errors.mock.calls[0].arguments, ['FYSO_EXT_BIZ_PORT is required']);
  assert.equal(exit.mock.callCount(), 1);
  assert.equal(receiver.mock.callCount(), 2);

  process.env.FYSO_EXT_BIZ_PORT = '7080';
  bindError = Error('bind refused');
  t.mock.method(process, 'umask', () => 0o022);
  const completion = Promise.withResolvers();
  exit.mock.mockImplementation(completion.resolve);
  run();
  assert.equal(await completion.promise, 1);
  assert.deepEqual(errors.mock.calls[1].arguments, ['Fyso Biz panel API: bind refused']);
});

test('private listener rejects a socket bind error', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-gateway-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const error = Object.assign(Error('bind refused'), {code: 'EACCES'});
  const listener = new (require('node:events').EventEmitter)();
  listener.listen = () => listener.emit('error', error);
  t.mock.method(http, 'createServer', () => listener);
  t.mock.method(process, 'umask', () => 0o022);
  await assert.rejects(listenPrivate(() => {}, path.join(directory, 'api.sock')), error);
});
