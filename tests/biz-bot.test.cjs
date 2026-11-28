const {test}=require('node:test');const assert=require('node:assert/strict');
const {provision,provisionWithRetry}=require('../extensions/biz/bot.cjs');
function fixture(existing=[]) {
 const calls=[],bots=[...existing];let profile;
 return {bots,calls,port:{origin:'https://example.invalid',root:'/fixture',models:async()=>({instances:[{instanceId:'native',snapshot:{state:'available'},models:{default:'offered-model',options:[{id:'offered-model'}]}}]}),architect:async p=>{
  calls.push(p);
  if(p.OP==='list')return {bots};
  if(p.OP==='read')return {bot:profile||{name:'Biz Partner',description:'Fyso Biz integration assistant',cwd:'/fixture'}};
  if(p.OP==='plan'){profile=JSON.parse(Buffer.from(p.BOT_B64,'base64'));return {planId:'exact-plan',preview:{created:1,changed:0,deleted:0}};}
  if(p.OP==='apply'){assert.equal(p.PLAN_ID,'exact-plan');bots.push({id:'biz-id',name:'Biz Partner'});return {botId:'biz-id'};}
 }}};
}
test('creates one contextual bot through exact native plan/apply, with project MCP cwd and ask approval',async()=>{
 const f=fixture();const result=await provision(f.port);assert.equal(result.created,true);
 const entry=JSON.parse(Buffer.from(f.calls.find(c=>c.OP==='plan').BOT_B64,'base64'));
 assert.equal(entry.cwd,'${FYSO_ROOT}');assert.equal(entry.model,'native/offered-model');assert.equal(entry.approval,'ask');assert.equal(entry.computer,'off');assert.ok(entry.soul.length>500);
 await provision(f.port);assert.equal(f.calls.filter(c=>c.OP==='apply').length,1);assert.equal(f.bots.length,1);
});
test('does not take over another bot with the same name',async()=>{
 const f=fixture([{id:'other',name:'Biz Partner'}]);f.port.architect=async p=>p.OP==='list'?{bots:f.bots}:{bot:{description:'Another bot'}};
 await assert.rejects(provision(f.port),/belongs to another bot/);
});
test('refuses a native preview that touches unrelated bots',async()=>{
 const f=fixture(),real=f.port.architect;f.port.architect=async p=>p.OP==='plan'?{preview:{created:1,changed:1}}:real(p);
 await assert.rejects(provision(f.port),/unexpected Biz bot preview/);assert.equal(f.calls.some(c=>c.OP==='apply'),false);
});

test('rejects ambiguous names before reading or creating a bot', async () => {
  const f = fixture([{id: 'one', name: 'Biz Partner'}, {id: 'two', name: ' biz partner '}]);
  await assert.rejects(provision(f.port), /ambiguous Biz Partner name/);
  assert.deepEqual(f.calls, [{OP: 'list'}]);
});

test('prefers the Bot Architect engine among the offered defaults', async () => {
  const f = fixture([{name: 'Bot Architect', model: {instanceId: 'preferred'}}]);
  const {instances} = await f.port.models();
  f.port.models = async () => ({instances: [
    ...instances,
    {...instances[0], instanceId: 'preferred'},
  ]});
  assert.deepEqual(await provision(f.port), {botId: 'biz-id', name: 'Biz Partner', created: true});
  const plan = f.calls.find(call => call.OP === 'plan');
  assert.equal(JSON.parse(Buffer.from(plan.BOT_B64, 'base64')).model, 'preferred/offered-model');
});

test('refuses engines without an available, offered default', async () => {
  const f = fixture();
  f.port.models = async () => ({instances: [
    {}, {snapshot: {state: 'offline'}}, {snapshot: {state: 'available'}},
    {snapshot: {state: 'available'}, models: {default: 'hidden'}},
    {snapshot: {state: 'available'}, models: {default: 'hidden', options: [{id: 'other'}]}},
  ]});
  await assert.rejects(provision(f.port), /no available engine/);
  assert.deepEqual(f.calls, [{OP: 'list'}]);
});

test('refuses a missing preview, no creation and unexpected deletion', async () => {
  for (const preview of [undefined, {created: 0}, {created: 1, changed: 0, deleted: 1}]) {
    const f = fixture();
    const architect = f.port.architect;
    f.port.architect = async params => params.OP === 'plan' ? {preview} : architect(params);
    await assert.rejects(provision(f.port), /unexpected Biz bot preview/);
    assert.equal(f.calls.some(call => call.OP === 'apply'), false);
  }
});

test('verifies the created name, marker and project directory', async () => {
  const marker = 'Fyso Biz integration assistant';
  for (const bot of [
    undefined, {name: 'other'}, {name: 'Biz Partner', description: 'other'},
    {name: 'Biz Partner', description: marker, cwd: 'outside'},
    {name: 'Biz Partner', description: marker, cwd: 'project-root'},
  ]) {
    const f = fixture();
    const architect = f.port.architect;
    f.port.root = 'project-root';
    f.port.architect = async params => {
      if (params.OP !== 'read') return architect(params);
      assert.equal(params.BOT_ID, 'biz-id');
      return {bot};
    };
    if (bot?.cwd === f.port.root) {
      assert.equal((await provision(f.port)).created, true);
    } else {
      await assert.rejects(provision(f.port), /Biz bot verification failed/);
    }
  }
});

test('CLI uses Dagu and model discovery under a lock and removes it after success or failure', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Module = require('node:module');
  const filename = require.resolve('../extensions/biz/bot.cjs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-bot-'));
  const names = ['FYSO_DATA', 'FYSO_OMB_PORT', 'FYSO_BIZ_URL', 'FYSO_BIZ_BOT_RETRY_MS'];
  const saved = names.map(name => process.env[name]);
  const previousCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousCode;
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
    fs.rmSync(temp, {recursive: true, force: true});
  });
  Object.assign(process.env, {FYSO_DATA: temp, FYSO_OMB_PORT: '7080', FYSO_BIZ_URL: 'https://biz.example.test', FYSO_BIZ_BOT_RETRY_MS: '0'});
  const lock = path.join(temp, 'ext', 'biz', 'bot.lock');
  const f = fixture();
  const logs = [];
  const errors = [];
  let done;
  t.mock.method(console, 'log', line => { logs.push(line); done(); });
  t.mock.method(console, 'error', line => { errors.push(line); done(); });
  const dagu = t.mock.fn(async (task, params, options) => {
    assert.equal(fs.statSync(lock).isDirectory(), true);
    assert.equal(task, 'fyso-bot-architect');
    assert.deepEqual(options, {output: 'RESULT', timeoutMs: 180000});
    return {output: await f.port.architect(params)};
  });
  const modelList = await f.port.models();
  const exec = t.mock.fn((command, args, options) => {
    assert.equal(command, 'openmausbot');
    assert.deepEqual(args, ['models', '--json', '--port', '7080']);
    assert.deepEqual(options, {encoding: 'utf8', timeout: 30000});
    return JSON.stringify(modelList);
  });
  async function run() {
    const completion = Promise.withResolvers();
    done = completion.resolve;
    process.exitCode = undefined;
    const entry = new Module(filename);
    entry.filename = filename;
    const load = entry.require.bind(entry);
    entry.require = id => {
      if (id === 'node:child_process') return {execFileSync: exec};
      if (id === path.resolve('framework/scripts/dagu-client.cjs')) return {client: () => ({run: dagu})};
      return load(id);
    };
    const previous = process.mainModule;
    process.mainModule = entry;
    try {
      entry._compile(fs.readFileSync(filename, 'utf8'), filename);
    } finally {
      process.mainModule = previous;
    }
    await completion.promise;
  }

  await run();
  assert.deepEqual(JSON.parse(logs[0]), {botId: 'biz-id', name: 'Biz Partner', created: true});
  assert.equal(exec.mock.callCount(), 1);
  assert.equal(fs.existsSync(lock), false);
  dagu.mock.mockImplementation(async () => { throw Error('internal detail'); });
  await run();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(process.exitCode, 1);

  fs.mkdirSync(lock);
  await run();
  assert.equal(fs.existsSync(lock), true);
  assert.equal(process.exitCode, 1);
  fs.rmdirSync(lock);

  delete process.env.FYSO_OMB_PORT;
  await run();
  process.env.FYSO_OMB_PORT = '7080';
  delete process.env.FYSO_DATA;
  await run();
  assert.equal(process.exitCode, 1);
  assert.equal(dagu.mock.callCount(), 7, 'the successful run, then the failing one three times');
  assert.deepEqual(errors, Array(4).fill(
    'Biz Partner setup failed; inspect Bot Architect runs and check for a name conflict.',
  ));
});

test('a transient Bot Architect failure is retried and the bot is made once', async () => {
  const f = fixture(), real = f.port.architect;
  let failed = 0;
  f.port.architect = async p => { if (p.OP === 'apply' && !failed) { failed = 1; throw new Error('command failed: native server closed the connection'); } return real(p); };
  const pauses = [];
  const result = await provisionWithRetry(f.port, {pause: async ms => { pauses.push(ms); }, delayMs: 10});
  assert.equal(result.created, true);
  assert.equal(failed, 1, 'the first apply failed');
  assert.equal(f.calls.filter(c => c.OP === 'apply').length, 1, 'and the retry applied once');
  assert.equal(f.bots.length, 1);
  assert.deepEqual(pauses, [10]);
});

test('its own refusals are not retried, and a persistent failure stops after the attempts', async () => {
  const other = fixture([{id: 'other', name: 'Biz Partner'}]);
  other.port.architect = async p => p.OP === 'list' ? {bots: other.bots} : {bot: {description: 'Another bot'}};
  await assert.rejects(provisionWithRetry(other.port, {pause: async () => { throw Error('must not wait'); }}), /belongs to another bot/);
  const down = fixture();
  let tries = 0;
  down.port.architect = async () => { tries++; throw new Error('native server closed the connection'); };
  await assert.rejects(provisionWithRetry(down.port, {attempts: 3, pause: async () => {}}), /native server closed/);
  assert.equal(tries, 3);
});

test('retries are bounded, back off through an injected pause, and skip what a retry cannot fix', async () => {
  const failing = message => {
    const f = fixture(); let tries = 0;
    f.port.architect = async () => { tries++; throw Object.assign(new Error(message), message.status ? {status: message.status} : {}); };
    return {f, tries: () => tries};
  };
  const pauses = [];
  const pause = async ms => { pauses.push(ms); };
  // Bounded: asking for more attempts than the cap still stops at three, with the delay growing and capped.
  const flaky = failing('native server closed the connection');
  await assert.rejects(provisionWithRetry(flaky.f.port, {attempts: 99, delayMs: 999999, pause}), /native server closed/);
  assert.equal(flaky.tries(), 3);
  assert.deepEqual(pauses, [10000, 20000]);
  // Not retried: HTTP 4xx (Dagu's message or a status), Dagu not configured, a run still going, our own refusals.
  for (const message of ['Dagu POST /api/v2/dag-runs failed (404): not found', 'Dagu is not configured: run through mise', 'fyso-bot-architect still running after 180 s (run x)', 'no available engine for Biz Partner']) {
    const one = failing(message);
    await assert.rejects(provisionWithRetry(one.f.port, {pause: async () => { throw Error('must not wait'); }}), error => error.message === message);
    assert.equal(one.tries(), 1, message);
  }
  const withStatus = fixture(); let calls = 0;
  withStatus.port.architect = async () => { calls++; throw Object.assign(new Error('rejected'), {status: 403}); };
  await assert.rejects(provisionWithRetry(withStatus.port, {pause}), {status: 403});
  assert.equal(calls, 1);
  // A zero delay never waits at all (the CLI test and a project that wants no pause).
  const zero = failing('native server closed the connection');
  await assert.rejects(provisionWithRetry(zero.f.port, {delayMs: 0, pause: async () => { throw Error('must not wait'); }}), /native server closed/);
  assert.equal(zero.tries(), 3);
  // A 5xx is a transient failure and is retried.
  const server = fixture(); let hits = 0, real = server.port.architect;
  server.port.architect = async p => { if (!hits++) throw Object.assign(new Error('Dagu GET /x failed (503): busy'), {}); return real(p); };
  assert.equal((await provisionWithRetry(server.port, {pause})).created, true);
});
