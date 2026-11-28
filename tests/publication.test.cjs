const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {EventEmitter} = require('node:events');
const {readFileSync} = require('node:fs');
const Module = require('node:module');
const timers = require('node:timers/promises');
const filename = require.resolve('../extensions/biz/publication.cjs');
const {localRequest} = require(filename);

const config = {domain: 'project.example.org', port: 7080};
const message = {
  id: 'work-1', host: 'panel.' + config.domain, path: '/api?since=1', method: 'POST',
  headers: [['host', 'wrong'], ['connection', 'close'], ['transfer-encoding', 'chunked'], ['x-test', 'yes']],
  body: Buffer.from('payload').toString('base64'),
};
const signal = () => new AbortController().signal;

function origin(t, respond) {
  return t.mock.method(http, 'request', (options, callback) => {
    const req = new EventEmitter();
    req.end = body => respond({options, callback, req, body});
    return req;
  });
}

async function* chunks(...values) {
  yield* values;
}

test('forwards a bounded request to the project origin and preserves repeated response headers', async t => {
  const controller = new AbortController();
  const request = origin(t, ({options, callback, body}) => {
    assert.deepEqual({...options, signal: undefined}, {
      hostname: '127.0.0.1', port: 7080, path: message.path, method: 'POST',
      headers: {host: message.host, 'x-test': 'yes', 'content-length': 7}, signal: undefined,
    });
    controller.abort();
    assert.equal(options.signal.aborted, true);
    assert.equal(body.toString(), 'payload');
    callback(Object.assign(chunks(Buffer.from('hello '), Buffer.from('world')), {
      statusCode: 201, rawHeaders: ['Set-Cookie', 'a=1', 'Set-Cookie', 'b=2'],
    }));
  });
  assert.deepEqual(await localRequest(config, message, controller.signal), {
    status: 201, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']],
    body: Buffer.from('hello world').toString('base64'),
  });
  assert.equal(request.mock.callCount(), 1);
});

test('rejects unsafe targets and oversized request bodies before opening an origin request', t => {
  const request = origin(t, () => assert.fail('invalid origin request'));
  for (const patch of [
    {host: 'other.test'}, {path: null}, {path: 'relative'}, {path: '//other.test/'},
    {path: '/\\other.test'}, {path: '/\r\ninjected'}, {method: 'CONNECT'},
  ]) {
    assert.throws(() => localRequest(config, {...message, ...patch}, signal()), /Invalid origin request/);
  }
  assert.throws(() => localRequest(config, {
    ...message, body: Buffer.alloc(1024 * 1024 + 1).toString('base64'),
  }, signal()), /Origin request body too large/);
  assert.equal(request.mock.callCount(), 0);
});

test('surfaces connection and response stream errors and enforces the response limit', async t => {
  const request = origin(t, ({req}) => req.emit('error', Error('connection refused')));
  await assert.rejects(localRequest(config, message, signal()), /connection refused/);
  request.mock.mockImplementation((options, callback) => ({
    once() {},
    end() { callback(chunks(Buffer.alloc(5 * 1024 * 1024), Buffer.from('x'))); },
  }));
  await assert.rejects(localRequest(config, message, signal()), /Origin response body too large/);
  request.mock.mockImplementation((options, callback) => ({
    once() {},
    end() {
      callback((async function* () {
        yield Buffer.from('partial');
        throw Error('stream closed');
      })());
    },
  }));
  await assert.rejects(localRequest(config, message, signal()), /stream closed/);
});

const env = {
  FYSO_WEB_DOMAIN: config.domain, FYSO_HTTP_PORT: String(config.port),
  FYSO_PUBLICATION_SERVICE: 'https://publication.example.test',
  FYSO_PUBLICATION_TOKEN: 'project-credential',
};

function cli(t) {
  // Evaluate the real CommonJS entry point in-process so transport and backoff can be stubbed.
  const previous = {argv: process.argv, exitCode: process.exitCode, main: process.mainModule};
  const names = Object.keys(env);
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  const logs = [];
  const errors = [];
  let done;
  t.mock.method(console, 'log', line => { logs.push(line); done(); });
  t.mock.method(console, 'error', line => { errors.push(line); done(); });
  const remove = process.removeListener;
  t.mock.method(process, 'removeListener', function (name, listener) {
    const result = remove.call(this, name, listener);
    if (name === 'SIGTERM' && listener.name === 'stop') done();
    return result;
  });
  return {logs, errors, async run(action, patch) {
    const completion = Promise.withResolvers();
    done = completion.resolve;
    Object.assign(process.env, env, patch);
    process.exitCode = undefined;
    process.argv = [...previous.argv.slice(0, 2), action];
    const entry = new Module(filename);
    entry.filename = filename;
    process.mainModule = entry;
    try {
      entry._compile(readFileSync(filename, 'utf8'), filename);
    } finally {
      process.mainModule = previous.main;
    }
    await completion.promise;
    return process.exitCode;
  }};
}

test('CLI status, doctor, publish and revoke use authenticated control requests', async t => {
  const command = cli(t);
  const response = {enabled: true, connected: true};
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  for (const action of ['status', 'doctor', 'publish', 'revoke']) {
    assert.equal(await command.run(action), undefined);
  }
  assert.deepEqual(command.logs.map(line => JSON.parse(line)), Array(4).fill(response));
  assert.deepEqual(command.errors, []);
  assert.deepEqual(fetch.mock.calls.map(({arguments: [url, options]}) => {
    assert.equal(url.origin, env.FYSO_PUBLICATION_SERVICE);
    assert.equal(options.headers.Authorization, 'Bearer project-credential');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return [url.pathname, options.method];
  }), ['status', 'status', 'publish', 'revoke'].map(action =>
    ['/v1/' + config.domain + '/' + action, action === 'status' ? 'GET' : 'POST']));
});

test('CLI rejects bad configuration and masks control, parse and health failures', async t => {
  const command = cli(t);
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('invalid config must not fetch'));
  assert.equal(await command.run('unknown'), 1);
  for (const patch of [
    {FYSO_WEB_DOMAIN: ''}, {FYSO_WEB_DOMAIN: 'internal.test'},
    {FYSO_WEB_DOMAIN: 'abc.'.repeat(63) + 'org'},
    ...['1.5', '0', '65536'].map(FYSO_HTTP_PORT => ({FYSO_HTTP_PORT})),
    ...['', 'http://pub.test', 'https://user@pub.test', 'https://:pass@pub.test',
      'https://pub.test/?q=x', 'https://pub.test/#x', 'https://pub.test/path']
      .map(FYSO_PUBLICATION_SERVICE => ({FYSO_PUBLICATION_SERVICE})),
    {FYSO_PUBLICATION_TOKEN: ''},
  ]) {
    assert.equal(await command.run('status', patch), 1);
  }
  assert.equal(fetch.mock.callCount(), 0);
  for (const result of [
    new Response(null, {status: 403}), new Response('provider secret'),
    Response.json({enabled: false, connected: true}), Response.json({enabled: true, connected: false}),
    Error('provider secret'),
  ]) {
    fetch.mock.mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    assert.equal(await command.run('doctor'), 1);
  }
  assert.deepEqual(command.logs, []);
  assert.ok(command.errors.every(line => line ===
    'Fyso Biz publication check failed. Verify the assigned domain, credential and service status.'));
});

test('connector polls, completes origin work and backs off after failed polls', async t => {
  const command = cli(t);
  const before = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
  const sent = [];
  let poll = 0;
  let cancelled = 0;
  const backoff = t.mock.method(timers, 'setTimeout', async (ms, value, {signal}) => {
    assert.equal(ms, 3000);
    assert.equal(signal.aborted, false);
    if (poll === 6) throw Error('timer interrupted');
  });
  origin(t, ({callback}) => callback(Object.assign(chunks(Buffer.from('reply')), {
    statusCode: 200, rawHeaders: ['Content-Type', 'text/plain'],
  })));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'POST');
    if (url.pathname.endsWith('/complete')) {
      assert.equal(options.headers['Content-Type'], 'application/json');
      sent.push([url.searchParams.get('id'), JSON.parse(options.body)]);
      if (sent.length === 2) throw Error('completion lost');
      return {body: {async cancel() { cancelled++; }}};
    }
    assert.equal(url.pathname, '/v1/' + config.domain + '/next');
    switch (++poll) {
      case 1: return {status: 204};
      case 2: return Response.json(message);
      case 3: return Response.json({...message, id: 'work-2', host: 'wrong'});
      case 4: return {ok: false, body: {async cancel() { cancelled++; }}};
      case 5: return {ok: false};
      case 6: return new Response('{');
      default:
        process.emit('SIGINT');
        assert.equal(options.signal.aborted, true);
        throw Error('poll aborted');
    }
  });
  assert.equal(await command.run('connect'), undefined);
  assert.deepEqual(sent.sort(([first], [second]) => first.localeCompare(second)), [
    ['work-1', {status: 200, headers: [['content-type', 'text/plain']], body: Buffer.from('reply').toString('base64')}],
    ['work-2', {status: 502, headers: [], body: Buffer.from('Panel origin unavailable').toString('base64')}],
  ]);
  assert.equal(backoff.mock.callCount(), 3);
  assert.equal(cancelled, 2);
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), before);
});

test('connector waits at four active jobs and drains them on shutdown', {timeout: 1000}, async t => {
  const command = cli(t);
  const firstFour = Promise.withResolvers();
  const fifthPoll = Promise.withResolvers();
  const completions = [];
  const request = origin(t, ({callback}) => {
    callback(Object.assign(chunks(), {statusCode: 204, rawHeaders: []}));
  });
  let poll = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.pathname.endsWith('/complete')) {
      const gate = Promise.withResolvers();
      completions.push(gate);
      if (completions.length === 4) firstFour.resolve();
      return gate.promise;
    }
    if (++poll <= 4) return Response.json({...message, id: String(poll)});
    process.emit('SIGTERM');
    fifthPoll.resolve(options.signal.aborted);
    return {status: 204};
  });
  let stopped = false;
  const connected = command.run('connect').then(() => { stopped = true; });
  await firstFour.promise;
  assert.equal(poll, 4);
  assert.equal(request.mock.callCount(), 4);
  let cancelled = 0;
  completions[0].resolve({body: {async cancel() { cancelled++; }}});
  assert.equal(await fifthPoll.promise, true);
  assert.equal(stopped, false);
  for (const completion of completions.slice(1)) completion.resolve({body: null});
  await connected;
  assert.equal(poll, 5);
  assert.equal(cancelled, 1);
});
