const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const delivery = require('../extensions/biz/email-delivery.cjs');

let deliver;
const load = test.mock.method(delivery, 'deliverEmail', mail => deliver(mail));
const {remote, receive, startReceiver} = require('../extensions/biz/email.cjs');
load.mock.restore();

const mailbox = '12345678-abcd-4321-9876-abcdef123456';
const deliveryId = 'a'.repeat(64);
const mail = {
  mailbox, deliveryId, bot: 'inbox', thread: 'thread-1',
  from: 'sender@example.test', subject: 'Question', body: 'Hello',
};
const attachment = {name: '../report.txt', content: Buffer.from('report').toString('base64')};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'biz-email-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const biz = path.join(root, 'ext', 'biz');
  await fs.mkdir(biz, {recursive: true});
  const env = {FYSO_DATA: root, FYSO_OMB_PORT: '7080', FYSO_BIZ_URL: 'https://biz.example.test'};
  await fs.writeFile(path.join(biz, 'oauth.json'), JSON.stringify({
    origin: env.FYSO_BIZ_URL, accessToken: 'agent-grant', expiresAt: Number.MAX_SAFE_INTEGER,
  }));
  return {env, directory: path.join(biz, 'mail', mailbox, deliveryId)};
}

function transport(t, pending, acknowledge = () => Response.json({ok: true})) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/pending')) return Response.json(pending);
    assert.ok(url.endsWith('/ack'), url);
    return acknowledge(options);
  });
}

test('uses OAuth and sends JSON to the configured agent-mail endpoint', async t => {
  const {env} = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({id: 'sent'}));
  const payload = {to: 'recipient@example.test', body: 'Hello'};
  assert.deepEqual(await remote('send', payload, env), {id: 'sent'});
  const [[url, options]] = fetch.mock.calls.map(call => call.arguments);
  assert.equal(url, env.FYSO_BIZ_URL + '/agent-mail/send');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(options.headers, {Authorization: 'Bearer agent-grant', 'Content-Type': 'application/json'});
  assert.deepEqual(JSON.parse(options.body), payload);
});

test('surfaces invalid origins, missing OAuth, HTTP errors, network errors and malformed JSON', async t => {
  const {env} = await fixture(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, {status: 503}));
  await assert.rejects(remote('pending', undefined, {...env, FYSO_BIZ_URL: 'invalid'}), /invalid_origin/);
  await assert.rejects(remote('pending', undefined, {...env, BOT_FYSO_BIZ_TOKEN: 'static'}), /oauth_required/);
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(remote('pending', undefined, env), /agent_mail_unavailable/);
  fetch.mock.mockImplementation(async () => { throw Error('offline'); });
  await assert.rejects(remote('pending', undefined, env), /offline/);
  fetch.mock.mockImplementation(async () => new Response('{'));
  await assert.rejects(remote('pending', undefined, env), SyntaxError);
});

test('does not deliver or acknowledge an empty inbox', async t => {
  const {env, directory} = await fixture(t);
  const fetch = transport(t, null);
  deliver = () => assert.fail('empty inbox');
  assert.equal(await receive(env), undefined);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, env.FYSO_BIZ_URL + '/agent-mail/pending');
  assert.equal(options.method, 'GET');
  assert.equal(options.body, undefined);
  await assert.rejects(fs.stat(directory), {code: 'ENOENT'});
});

test('stores private attachments under numeric names and retries after a lost acknowledgement', async t => {
  const {env, directory} = await fixture(t);
  const input = {...mail, attachments: [attachment, {...attachment, name: 'other.txt'}]};
  const events = [];
  transport(t, input, options => {
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {mailbox, deliveryId, messageId: 'receipt'});
    events.push('ack');
    return events.length === 2 ? new Response(null, {status: 503}) : Response.json({ok: true});
  });
  deliver = async message => {
    events.push('deliver');
    const files = [path.join(directory, '1'), path.join(directory, '2')];
    assert.deepEqual(message, {...mail, port: env.FYSO_OMB_PORT, attachments: [
      {name: attachment.name, path: files[0]}, {name: 'other.txt', path: files[1]},
    ]});
    for (const file of files) {
      assert.equal(await fs.readFile(file, 'utf8'), 'report');
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
    return {messageId: 'receipt'};
  };
  await assert.rejects(receive(env), /agent_mail_unavailable/);
  await receive(env);
  assert.deepEqual(events, ['deliver', 'ack', 'deliver', 'ack']);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['1', '2']);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});

test('rejects invalid paths and keeps conflicting attachment retries pending', async t => {
  const {env, directory} = await fixture(t);
  deliver = () => assert.fail('attachment validation failed');
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected mail request'));
  for (const patch of [{mailbox: '..'}, {deliveryId: 'invalid'}]) {
    fetch.mock.mockImplementation(async () => Response.json({...mail, ...patch, attachments: [attachment]}));
    await assert.rejects(receive(env), /invalid_mail_destination/);
  }
  await fs.mkdir(directory, {recursive: true});
  const file = path.join(directory, '1');
  await fs.writeFile(file, 'original');
  fetch.mock.mockImplementation(async () => Response.json({...mail, attachments: [attachment]}));
  await assert.rejects(receive(env), /attachment_retry_mismatch/);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  const link = t.mock.method(fs, 'link', async () => {
    throw Object.assign(Error('permission denied'), {code: 'EACCES'});
  });
  await assert.rejects(receive(env), {code: 'EACCES'});
  assert.equal(link.mock.callCount(), 1);
  assert.deepEqual(await fs.readdir(directory), ['1']);
  assert.ok(fetch.mock.calls.every(call => call.arguments[0].endsWith('/pending')));
});

test('polls again after a failed handoff and acknowledges only the successful receipt', async t => {
  const {env} = await fixture(t);
  const fetch = transport(t, mail);
  let attempts = 0;
  deliver = async message => {
    assert.deepEqual(message.attachments, []);
    if (++attempts === 1) throw Error('bot unavailable');
    return {messageId: 'receipt'};
  };
  let scheduled;
  let unrefs = 0;
  const {promise, resolve} = Promise.withResolvers();
  const timer = t.mock.method(globalThis, 'setTimeout', (tick, ms) => {
    assert.equal(ms, 30000);
    scheduled = tick;
    return {unref() { unrefs++; resolve(); }};
  });
  startReceiver(env);
  await promise;
  assert.equal(fetch.mock.callCount(), 1);
  await scheduled();
  assert.equal(attempts, 2);
  assert.equal(timer.mock.callCount(), 2);
  assert.equal(unrefs, 2);
  assert.equal(fetch.mock.callCount(), 3);
});

test('send CLI reads stdin and masks invalid input or an unconfirmed send', async t => {
  const syncFs = require('node:fs');
  const Module = require('node:module');
  const filename = require.resolve('../extensions/biz/email.cjs');
  const {env} = await fixture(t);
  const names = ['FYSO_DATA', 'FYSO_BIZ_URL', 'BOT_FYSO_BIZ_TOKEN'];
  const saved = names.map(name => process.env[name]);
  const previousCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousCode;
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  });
  process.env.FYSO_DATA = env.FYSO_DATA;
  process.env.FYSO_BIZ_URL = env.FYSO_BIZ_URL;
  delete process.env.BOT_FYSO_BIZ_TOKEN;

  const logs = [];
  const errors = [];
  let done;
  t.mock.method(console, 'log', line => { logs.push(line); done(); });
  t.mock.method(console, 'error', line => { errors.push(line); done(); });
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({id: 'sent'}));
  async function run(input) {
    const completion = Promise.withResolvers();
    done = completion.resolve;
    process.exitCode = undefined;
    const entry = new Module(filename);
    entry.filename = filename;
    const load = entry.require.bind(entry);
    entry.require = id => id === 'node:fs' ? {readFileSync(fd, encoding) {
      assert.equal(fd, 0);
      assert.equal(encoding, 'utf8');
      return input;
    }} : load(id);
    const previous = process.mainModule;
    process.mainModule = entry;
    try {
      entry._compile(syncFs.readFileSync(filename, 'utf8'), filename);
    } finally {
      process.mainModule = previous;
    }
    await completion.promise;
    return process.exitCode;
  }

  const input = '{"body":"private message"}';
  assert.equal(await run(input), undefined);
  assert.deepEqual(logs.map(line => JSON.parse(line)), [{id: 'sent'}]);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, env.FYSO_BIZ_URL + '/agent-mail/send');
  assert.equal(options.body, input);
  assert.equal(await run('{'), 1);
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => { throw Error('private message'); });
  assert.equal(await run(input), 1);
  delete process.env.FYSO_BIZ_URL;
  assert.equal(await run(input), 1);
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(errors, Array(3).fill('Email send was not confirmed. Verify before retrying.'));
});
