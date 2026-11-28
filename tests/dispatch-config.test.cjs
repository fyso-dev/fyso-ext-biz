const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {configure} = require('../extensions/biz/dispatch-config.cjs');
const {tempProject} = require('./helpers/index.cjs');

function fixture(t) {
  const project = tempProject(t);
  const git = (...args) => execFileSync('git', args, {cwd: project.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  project.writeFile('other', 'one');
  git('add', 'other');
  git('commit', '-qm', 'initial');
  return {project, git, env: {...project.env, FYSO_ROOT: project.root, FYSO_OMB_PORT: '12345', FYSO_BIZ_TARGET: ''}};
}

const config = 'project/biz-dispatch.json';

test('validates a native bot and commits only the dispatch file; preserves dirty work', async t => {
  const {project, git, env} = fixture(t);
  project.writeFile('other', 'two');
  const transport = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'http://127.0.0.1:12345/api/bots');
    return Response.json({bots: [{id: 'another-bot'}, {id: 'bot-1'}]});
  });
  const targetEnv = {...env, FYSO_BIZ_TARGET: 'bot-1'};
  assert.deepEqual(await configure(targetEnv), {ok: true});
  assert.deepEqual(JSON.parse(project.readFile(config)), {enabled: true, kind: 'bot', target: 'bot-1'});
  assert.equal(git('show', '--format=', '--name-only', 'HEAD').trim(), config);
  assert.equal(project.readFile('other'), 'two');
  assert.equal(transport.mock.callCount(), 1);
  project.writeFile(config, 'custom');
  await assert.rejects(configure(targetEnv), {message: 'uncommitted_changes'});
  assert.equal(project.readFile(config), 'custom');
});

test('disables dispatch without contacting the bot API or committing the same setting twice', async t => {
  const {project, git, env} = fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('disabling dispatch must not call the bot API'));
  await configure(env);
  assert.deepEqual(JSON.parse(project.readFile(config)), {enabled: false});
  const commit = git('rev-parse', 'HEAD');
  assert.deepEqual(await configure(env), {ok: true});
  assert.equal(git('rev-parse', 'HEAD'), commit);
});

test('rejects invalid inputs before inspecting bots or touching git', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('invalid input must not call the bot API'));
  const env = {FYSO_ROOT: 'unused', FYSO_OMB_PORT: '12345', FYSO_BIZ_TARGET: 'bot'};
  for (const patch of [
    {FYSO_ROOT: undefined}, {FYSO_OMB_PORT: undefined}, {FYSO_OMB_PORT: '12x'},
    {FYSO_OMB_PORT: '0'}, {FYSO_OMB_PORT: '65536'}, {FYSO_BIZ_TARGET: 'bad/bot'},
  ]) {
    await assert.rejects(configure({...env, ...patch}), {message: 'invalid_input'});
  }
});

test('rejects an unknown bot and an unavailable bot API without changing the repository', async t => {
  const {project, git, env} = fixture(t);
  const commit = git('rev-parse', 'HEAD');
  const transport = t.mock.method(globalThis, 'fetch', async () => Response.json({bots: [{id: 'other'}]}));
  const targetEnv = {...env, FYSO_BIZ_TARGET: 'missing'};
  await assert.rejects(configure(targetEnv), {message: 'invalid_bot'});
  transport.mock.mockImplementation(async () => new Response(null, {status: 503}));
  await assert.rejects(configure(targetEnv), {message: 'invalid_bot'});
  assert.equal(project.readFile(config), null);
  assert.equal(git('rev-parse', 'HEAD'), commit);
});

test('rejects an empty directory at the dispatch configuration path', async t => {
  const {project, git, env} = fixture(t);
  fs.mkdirSync(project.path(config));
  await assert.rejects(configure(env), {message: 'invalid_config_file'});
  assert.equal(git('status', '--porcelain', '--', config).trim(), '');
});
