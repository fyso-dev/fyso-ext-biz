const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {offload, shutdown, LONG, failure} = require('../extensions/biz/setup-offload.cjs');
const {tempProject} = require('./helpers/temp-project.cjs');
const {Worker} = require('node:worker_threads');
const {setup} = require('../extensions/biz/managed-setup.cjs');
const {dataDir} = require('../extensions/biz/auth.cjs');

// A stand-in for managed-setup.cjs: `setup()` whose operations block the thread like execFileSync does.
function stub(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-offload-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'fake-setup.cjs');
  fs.writeFileSync(file, `
    const block = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    exports.setup = () => (${body});`);
  return file;
}

const DEFAULT_BODY = `{
  apply: async ({digest}) => { block(300); return {applied: digest, who: process.env.WHO}; },
  preview: async () => { throw Object.assign(Error('conflict'), {status: 409, files: ['a.md'], detail: 'x', secret: 'not forwarded', cause: new Error('inner')}); },
  sync: async () => { throw Error('plain'); },
  publish: async () => { process.exit(3); },
}`;

test('a long operation runs off the calling thread, with the env it was given', async t => {
  const managed = {status: () => ({connected: true}), apply: async () => 'never: it runs in the worker'};
  const wrapped = offload(managed, {env: {WHO: 'member'}, module: stub(t, DEFAULT_BODY)});
  assert.deepEqual(wrapped.status(), {connected: true}, 'short operations stay in process');
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  const result = await wrapped.apply({digest: 'd1'});
  clearInterval(timer);
  assert.deepEqual(result, {applied: 'd1', who: 'member'});
  assert.ok(ticks >= 5, `the event loop kept turning while the worker blocked for 300 ms (${ticks} ticks)`);
});

test('a failure keeps what the routes answer with and nothing else', async t => {
  const wrapped = offload({preview() {}, sync() {}}, {env: {}, module: stub(t, DEFAULT_BODY)});
  await assert.rejects(wrapped.preview(), error => {
    assert.deepEqual([error.message, error.status, error.files, error.detail], ['conflict', 409, ['a.md'], 'x']);
    assert.equal(error.secret, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(wrapped.sync(), {message: 'plain'});
});

test('what crosses the boundary is redacted again: tokens, age keys and machine paths never reach a route', () => {
  const home = ['', 'Users', 'someone'].join('/'); // built, so this file spells out no machine path
  const dirty = {
    message: 'publish_failed', status: 502, code: 'E_X',
    detail: `Authorization: Bearer abc.def.ghi token=hunter2 AGE-SECRET-KEY-1QQQQ in ${home}/project/.data/key`,
    files: ['project/wiki/a.md', 42, 'secret.txt'],
  };
  const out = failure(dirty);
  const text = JSON.stringify(out);
  for (const leak of ['abc.def.ghi', 'hunter2', 'AGE-SECRET-KEY-1QQQQ', home]) assert.ok(!text.includes(leak), `${leak} leaked: ${text}`);
  assert.deepEqual([out.message, out.status, out.code, out.files], ['publish_failed', 502, 'E_X', ['project/wiki/a.md', 'secret.txt']]);
  assert.match(out.detail, /\[redacted\]/);
  assert.equal(failure({message: 'm', status: 'nope', other: 1}).status, undefined);
  assert.deepEqual(failure(null), {message: 'setup_failed'});
  assert.ok(failure({message: 'x'.repeat(1000)}).message.length <= 203);
  assert.ok(failure({message: 'm', detail: 'y '.repeat(2000)}).detail.length <= 503);
});

test('the environment is the worker process.env, never a message: nothing secret is posted', async t => {
  const wrapped = offload({apply() {}}, {env: {WHO: 'w', FYSO_TOKEN_CANARY: 'canary-secret-value'}, module: stub(t, `{
    apply: async (...args) => ({args, env: process.env.FYSO_TOKEN_CANARY, workerData: JSON.stringify(require('node:worker_threads').workerData)}),
  }`)});
  const result = await wrapped.apply({digest: 'd'});
  assert.deepEqual(result.args, [{digest: 'd'}]);
  assert.equal(result.env, 'canary-secret-value', 'the setup in the worker reads it from its own environment');
  assert.ok(!result.workerData.includes('canary-secret-value'), 'workerData (what is posted to the thread) holds the operation and its arguments only');
});

test('crashes are failures, never hangs: process.exit, an uncaught exception, an exit with no answer', async t => {
  const wrapped = offload({publish() {}, sync() {}, apply() {}}, {env: {}, module: stub(t, `{
    publish: async () => { process.exit(3); },
    sync: async () => { setTimeout(() => { throw Error('Authorization: Bearer leaked-in-a-crash'); }, 0); return new Promise(() => {}); },
    apply: async () => new Promise(() => { setTimeout(() => process.exit(0), 10); }),
  }`)});
  await assert.rejects(wrapped.publish(), {message: 'setup_worker_exit_3'});
  await assert.rejects(wrapped.sync(), error => { assert.equal(error.message, 'setup_worker_failed', 'the crash text is not forwarded'); return true; });
  await assert.rejects(wrapped.apply(), {message: 'setup_worker_exit_0'});
  assert.equal(wrapped.status, undefined);
  assert.deepEqual(LONG.filter(name => !(name in wrapped)), ['preview', 'publishPreview', 'mergeAndPublish'], 'only what the setup offers is wrapped');
});

test('a worker that cannot start is a failure', async t => {
  const wrapped = offload({apply() {}}, {env: {BAD: Symbol('not cloneable')}, module: stub(t, DEFAULT_BODY)});
  await assert.rejects(wrapped.apply({}), {message: 'setup_worker_failed'});
});

test('shutdown stops the running workers and their callers hear a failure, not silence', async t => {
  const wrapped = offload({apply() {}}, {env: {}, module: stub(t, `{ apply: async () => new Promise(() => { setInterval(() => {}, 1000); }) }`)});
  const pending = wrapped.apply({});
  const rejected = assert.rejects(pending, {message: /^setup_worker_exit_\d+$/});
  await new Promise(resolve => setTimeout(resolve, 100));
  await shutdown();
  await rejected;
  await shutdown(); // nothing left: still fine
});

// The real setup in the worker: the lock of the setup is the file `setup.lock` the sync workflow and the CLI take too.
test('one change at a time: with a change in progress a second request is answered busy at once, as it was in process', async t => {
  const project = tempProject(t, {seed: false});
  const lock = path.join(dataDir(project.env), 'setup.lock');
  fs.mkdirSync(lock, {recursive: true});
  const wrapped = offload({apply() {}, publish() {}, sync() {}, publishPreview() {}, mergeAndPublish() {}}, {env: project.env});
  const started = Date.now();
  const answers = await Promise.allSettled([
    wrapped.apply({digest: 'x'}), wrapped.apply({digest: 'x'}), wrapped.publish({version: 'v1', digest: 'x'}), wrapped.sync(), wrapped.publishPreview(), wrapped.mergeAndPublish({}),
  ]);
  assert.deepEqual(answers.map(answer => [answer.status, answer.reason?.message]), Array(6).fill(['rejected', 'busy']));
  assert.ok(fs.existsSync(lock), 'the change that holds the lock is not disturbed');
  assert.ok(Date.now() - started < 5000, 'nothing waited for the lock or queued behind it');
});


for (const action of ['preview', 'disconnect']) {
  test(`${action} answers busy while a setup worker owns the lock`, async t => {
    const project = tempProject(t);
    project.writeState({connected: true});
    fs.mkdirSync(path.join(project.dataDir, 'setup.lock'));
    const managed = offload(setup({env: project.env}), {env: project.env});
    if (action === 'preview') await assert.rejects(managed.preview(), {message: 'busy'});
    else assert.throws(() => managed.disconnect(), {message: 'busy'});
    assert.equal(project.readState().connected, true);
  });
}

for (const kind of ['setup', 'profile']) {
  test(`concurrent ${kind} writes use independent temporary files`, async t => {
    const project = tempProject(t);
    const barrier = new Int32Array(new SharedArrayBuffer(4));
    const source = `
      const {workerData: {env, barrier, kind, setupFile, authFile}} = require('node:worker_threads');
      const fs = require('node:fs');
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        Atomics.add(barrier, 0, 1);
        Atomics.notify(barrier, 0);
        if (Atomics.wait(barrier, 0, 1, 3000) === 'timed-out') throw Error('writer barrier timed out');
        rename(...args);
      };
      if (kind === 'setup') require(setupFile).writeState(env, {connected: true});
      else require(authFile).store({env}).saveProfile({accessToken: 'a', refreshToken: 'r'});
    `;
    const write = () => new Promise((resolve, reject) => {
      const worker = new Worker(source, {eval: true, workerData: {env: project.env, barrier, kind,
        setupFile: require.resolve('../extensions/biz/managed-setup.cjs'), authFile: require.resolve('../extensions/biz/auth.cjs')}});
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve() : reject(Error(`writer exited ${code}`)));
    });
    const results = await Promise.allSettled([write(), write()]);
    for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.stack);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project.dataDir, kind === 'setup' ? 'setup.json' : 'profile-oauth.json')))[kind === 'setup' ? 'connected' : 'accessToken'],
      kind === 'setup' ? true : 'a');
  });
}
