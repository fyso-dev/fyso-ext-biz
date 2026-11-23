const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const {Readable} = require('node:stream');
const {feedback} = require('../extensions/biz/feedback.cjs');

const id = '28056ceb-01f7-45d2-a813-4bb5c2446310';
const url = 'https://github.com/fyso-dev/agentic-framework/issues/24';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'af-report-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const folder = path.join(root, 'project/wiki/feedback');
  await fs.mkdir(folder, {recursive: true});
  await fs.writeFile(path.join(folder, id + '.md'),
    `# Feedback\n\n- ID: ${id}\n\n## Title\n\nFailure\n\n## Component\n\nPanel\n\n## Description and evidence\n\nEvidence\n`);
  const env = {
    FYSO_ROOT: root, FYSO_DATA: path.join(root, '.data'), FYSO_BIZ_URL: 'https://fyso.biz',
    FYSO_BIZ_ACCESS_PROJECT: 'project', FYSO_BIZ_ACCESS_ORGANIZATION: 'tenant',
    FYSO_WEB_DOMAIN: 'preview.example', FYSO_WEB_SCHEME: 'https',
  };
  let posted = 0;
  const handle = feedback({
    env,
    access: {can: async (token, capability) => token === 'person' && capability === 'action:feedback:submit'},
    transport: async (target, init) => {
      posted++;
      assert.equal(target.href, 'https://fyso.biz/oauth/framework-feedback?organization=tenant&project=project');
      assert.equal(init.headers.Authorization, 'Bearer person');
      assert.deepEqual(JSON.parse(init.body), {id, title: 'Reviewed', body: 'Sanitized'});
      return Response.json({number: 24, url}, {status: 201});
    },
  });
  async function call(method, token, origin = 'https://panel.preview.example', report = id) {
    const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify({id: report, title: 'Reviewed', body: 'Sanitized'}))] : []);
    Object.assign(req, {method, headers: {origin, 'content-type': 'application/json'}});
    let status, result;
    await handle(req, {
      writeHead: code => {status = code;},
      end: text => {result = JSON.parse(text);},
    }, new URL('/profile/feedback?id=' + report, 'https://panel.preview.example'), {accessToken: token});
    return {status, result};
  }
  return {call, root, posted: () => posted};
}

test('reviews a local report, checks the individual grant and origin, and saves the receipt', async t => {
  const {call, posted} = await fixture(t);
  assert.equal((await call('GET', 'installation')).status, 403);
  assert.equal((await call('POST', 'person', 'https://foreign.example')).status, 403);
  assert.equal((await call('GET', 'person', undefined, '../outside')).status, 404);
  assert.equal((await call('GET', 'person')).result.body, 'Component: Panel\n\nEvidence');
  assert.equal(posted(), 0);
  assert.deepEqual(await call('POST', 'person'), {status: 200, result: {number: 24, url}});
  assert.deepEqual((await call('GET', 'person')).result.receipt, {number: 24, url});
  assert.equal(posted(), 1);
});

test('recovers a confirmed receipt after a local write failure without publishing again', async t => {
  const {call, root, posted} = await fixture(t);
  const cache = path.join(root, '.data');
  await fs.writeFile(cache, '');
  const pending = {number: 24, url, persistencePending: true};
  assert.deepEqual(await call('POST', 'person'), {status: 200, result: pending});
  assert.deepEqual((await call('GET', 'person')).result.receipt, pending);
  assert.deepEqual(await call('POST', 'person'), {status: 200, result: pending});
  await fs.unlink(cache);
  assert.deepEqual((await call('GET', 'person')).result.receipt, {number: 24, url});
  assert.deepEqual(await call('POST', 'person'), {status: 200, result: {number: 24, url}});
  assert.equal(posted(), 1);
});
