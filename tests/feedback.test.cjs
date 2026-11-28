const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const {Readable} = require('node:stream');
const {setImmediate: nextTurn, setTimeout: delay} = require('node:timers/promises');
const {runInNewContext} = require('node:vm');
const {feedback} = require('../extensions/biz/feedback.cjs');

const id = '28056ceb-01f7-45d2-a813-4bb5c2446310';
const url = 'https://github.com/fyso-dev/agentic-framework/issues/24';
const receipt = {number: 24, url};
const published = receipt => ({status: 409, result: {error: 'already_published', receipt}});

async function fixture(t, beforeResponse = async () => {}) {
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'af-report-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const folder = path.join(root, 'project/wiki/feedback');
  await fs.mkdir(folder, {recursive: true});
  const reportPath = path.join(folder, id + '.md');
  await fs.writeFile(reportPath,
    `# Feedback\n\n- ID: ${id}\n\n## Title\n\nFailure\n\n## Component\n\nPanel\n\n## Description and evidence\n\nEvidence\n`);
  const env = {
    FYSO_ROOT: root, FYSO_DATA: path.join(root, '.data'), FYSO_BIZ_URL: 'https://biz.example',
    FYSO_BIZ_ACCESS_PROJECT: 'project', FYSO_BIZ_ACCESS_ORGANIZATION: 'tenant',
    FYSO_WEB_DOMAIN: 'preview.example', FYSO_WEB_SCHEME: 'https',
  };
  let posted = 0;
  let lookup = () => new Response(null, {status: 404});
  const createHandler = (bizUrl = env.FYSO_BIZ_URL) => feedback({
    env: {...env, FYSO_BIZ_URL: bizUrl},
    access: {can: async (token, capability) => token === 'person' && capability === 'action:feedback:submit'},
    transport: async (target, init) => {
      assert.equal(init.headers.Authorization, 'Bearer person');
      const endpoint = 'https://biz.example/oauth/framework-feedback?organization=tenant&project=project';
      if (init.method === 'GET') {
        assert.equal(target.href, endpoint + '&id=' + id);
        assert.equal(init.body, undefined);
        return lookup();
      }
      posted++;
      assert.equal(target.href, endpoint);
      assert.deepEqual(JSON.parse(init.body), {id, title: 'Reviewed', body: 'Sanitized'});
      await beforeResponse(root);
      return Response.json(receipt, {status: 201});
    },
  });
  let handle = createHandler();
  async function call(method, token, origin = 'https://panel.preview.example', report = id, title = 'Reviewed') {
    const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify({id: report, title, body: 'Sanitized'}))] : []);
    Object.assign(req, {method, headers: {origin, 'content-type': 'application/json'}});
    let status, result;
    await handle(req, {
      writeHead: code => {status = code;},
      end: text => {result = JSON.parse(text);},
    }, new URL('/profile/feedback?id=' + report, 'https://panel.preview.example'), {accessToken: token});
    return {status, result};
  }
  return {
    call, root, reportPath, posted: () => posted,
    restart: bizUrl => {handle = createHandler(bizUrl);},
    setLookup: responder => {lookup = responder;},
  };
}

test('reuses a saved receipt after restarting with an equivalent Biz URL', async t => {
  const {call, posted, restart} = await fixture(t);
  restart('https://biz.example/');
  assert.deepEqual(await call('POST', 'person'), {status: 200, result: receipt});
  restart('https://BIZ.EXAMPLE:443');
  assert.deepEqual(await call('GET', 'person'), {status: 200, result: {id, receipt}});
  assert.deepEqual(await call('POST', 'person'), published(receipt));
  assert.equal(posted(), 1);
});

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

test('recovers a confirmed receipt after a local write failure and archival', async t => {
  const {call, root, reportPath, posted} = await fixture(t, root => fs.writeFile(path.join(root, '.data'), ''));
  const cache = path.join(root, '.data');
  const pending = {number: 24, url, persistencePending: true};
  assert.deepEqual(await call('POST', 'person'), {status: 200, result: pending});
  await fs.unlink(reportPath);
  assert.deepEqual(await call('GET', 'person'), {status: 200, result: {id, receipt: pending}});
  assert.deepEqual(await call('POST', 'person'), published(pending));
  await fs.unlink(cache);
  assert.deepEqual((await call('GET', 'person')).result.receipt, {number: 24, url});
  assert.deepEqual(await call('POST', 'person'), published(receipt));
  assert.equal(posted(), 1);
});

test('shares the confirmed receipt between simultaneous submissions', async t => {
  const {call, posted} = await fixture(t, async root => {
    await delay(50);
    await fs.writeFile(path.join(root, '.data'), '');
  });
  const confirmation = {status: 200, result: {number: 24, url, persistencePending: true}};
  assert.deepEqual(await Promise.all([call('POST', 'person'), call('POST', 'person')]),
    [confirmation, confirmation]);
  assert.equal(posted(), 1);
});

test('rejects a different confirmation during an active submission', async t => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const {call, posted} = await fixture(t, () => {
    started.resolve();
    return release.promise;
  });
  const first = call('POST', 'person');
  try {
    await started.promise;
    assert.deepEqual(await call('POST', 'person', undefined, id, 'Different title'),
      {status: 409, result: {error: 'confirmation_in_progress'}});
  } finally {
    release.resolve();
    assert.deepEqual(await first, {status: 200, result: receipt});
  }
  assert.equal(posted(), 1);
});

test('recovers the durable Biz receipt after a restart without a local cache', async t => {
  const {call, posted, root, restart, setLookup} = await fixture(t, root => fs.writeFile(path.join(root, '.data'), ''));
  assert.deepEqual(await call('POST', 'person'), {status: 200, result: {...receipt, persistencePending: true}});
  await fs.unlink(path.join(root, '.data'));
  restart();
  setLookup(() => Response.json(receipt));
  assert.deepEqual(await call('GET', 'person'), {status: 200, result: {id, receipt}});
  setLookup(() => new Response(null, {status: 502}));
  restart();
  assert.deepEqual(await call('POST', 'person'), published(receipt));
  assert.equal(posted(), 1);
});

test('blocks preview and publication while Biz reports pending or an uncertain result', async t => {
  const {call, posted, setLookup} = await fixture(t);
  for (const [response, status, error] of [
    [() => new Response(null, {status: 409}), 409, 'submission_pending'],
    [() => new Response(null, {status: 502}), 503, 'receipt_unavailable'],
    [() => Response.json({number: 24}), 503, 'receipt_unavailable'],
    [() => new Response('{'), 503, 'receipt_unavailable'],
  ]) {
    setLookup(response);
    for (const method of ['GET', 'POST']) {
      assert.deepEqual(await call(method, 'person'), {status, result: {error}});
    }
  }
  assert.equal(posted(), 0);
});

test('requires a local Markdown report for a first submission', async t => {
  const {call, reportPath, posted} = await fixture(t);
  await fs.unlink(reportPath);
  assert.equal((await call('GET', 'person')).status, 404);
  assert.equal((await call('POST', 'person')).status, 404);
  assert.equal(posted(), 0);
});

test('returns a saved receipt when the Markdown directory is inaccessible', async t => {
  const {call, reportPath} = await fixture(t);
  assert.equal((await call('POST', 'person')).status, 200);
  const realpath = fs.realpath;
  t.mock.method(fs, 'realpath', async file => {
    if (file === path.dirname(reportPath)) throw Object.assign(new Error('Permission denied'), {code: 'EACCES'});
    return realpath(file);
  });
  assert.deepEqual(await call('GET', 'person'), {status: 200, result: {id, receipt: {number: 24, url}}});
});

test('blocks publication when a saved receipt cannot be read or validated', async t => {
  const {call, root, posted} = await fixture(t);
  assert.equal((await call('POST', 'person')).status, 200);
  const folder = path.join(root, '.data/ext/biz/feedback');
  const [name] = await fs.readdir(folder);
  const file = path.join(folder, name);
  const unavailable = {status: 503, result: {error: 'receipt_unavailable'}};
  for (const content of ['{', '{"number":24}']) {
    await fs.writeFile(file, content);
    assert.deepEqual(await call('GET', 'person'), unavailable);
    assert.deepEqual(await call('POST', 'person'), unavailable);
  }
  await fs.unlink(file);
  await fs.mkdir(file);
  assert.deepEqual(await call('GET', 'person'), unavailable);
  assert.deepEqual(await call('POST', 'person'), unavailable);
  assert.equal(posted(), 1);
});

test('the panel clears stale previews and requires the reviewer to enter the related report', async () => {
  const elements = new Map();
  const actions = new Map();
  const requests = [];
  const stale = Promise.withResolvers();
  const another = '28056ceb-01f7-45d2-a813-4bb5c2446311';
  const panel = await fs.readFile(path.join(__dirname, '../extensions/biz/panel/feedback.js'), 'utf8');
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      addEventListener: (type, action) => actions.set(id + ':' + type, action),
    });
    return elements.get(id);
  }
  runInNewContext(panel, {
    navigator: {language: 'en'},
    document: {documentElement: {}, getElementById: element},
    fetch: async (target, init) => {
      requests.push({target, init});
      if (requests.length === 1) return stale.promise;
      if (init?.method === 'POST') return Response.json(receipt);
      return Response.json({id: another, title: 'Review', body: '- Related report: project/wiki/feedback/' + id + '.md'});
    },
  });
  const fire = (id, type) => actions.get(id + ':' + type)({preventDefault() {}});
  element('report-path').value = id;
  fire('load', 'submit');
  element('report-path').value = another;
  fire('report-path', 'input');
  stale.resolve(Response.json({id, title: 'Stale', body: 'Stale'}));
  await nextTurn();
  assert.equal(element('send').hidden, true);
  fire('send', 'submit');
  assert.equal(requests.length, 1);

  fire('load', 'submit');
  await nextTurn();
  assert.equal(element('send').hidden, false);
  assert.equal(element('loaded-id').textContent, another);
  assert.equal(element('related').value, '');
  element('related').value = id;
  fire('send', 'submit');
  await nextTurn();
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    id: another, related: id, title: 'Review', body: '- Related report: project/wiki/feedback/' + id + '.md',
  });
});
