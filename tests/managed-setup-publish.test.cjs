const {test} = require('node:test');
const assert = require('node:assert/strict');
const {profileSessions} = require('../extensions/biz/profile-session.cjs');
const {harness, fakeRunner, CMD, DRY_RUN, PUBLISHED, WINDOWS} = require('./helpers/index.cjs');

// Drive the panel's request handler in process. The shared harness provides OAuth transport.
async function panel(h) {
  const profiles = profileSessions({env: h.env, auth: h.store, access: h.access, now: h.clock.now, managedSetup: h.managed});
  let cookie;
  const request = async (method, url, body) => {
    const req = {method, url, headers: {'remote-user': 'publisher', cookie},
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); }};
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
      end(raw) { this.body = raw ? JSON.parse(raw) : undefined; },
    };
    assert.equal(await profiles.handle(req, res), true);
    return res;
  };
  const login = await request('POST', '/profile/login');
  assert.equal(login.status, 303);
  cookie = login.headers['Set-Cookie'].split(';')[0];
  const state = new URL(login.headers.Location).searchParams.get('state');
  const callback = await request('GET', `/profile/callback?state=${encodeURIComponent(state)}&code=test-code`);
  assert.equal(callback.status, 303);
  cookie = callback.headers['Set-Cookie'][1].split(';')[0];
  return (method, op, body) => request(method, `/profile/setup/${op}`, body);
}

test('a stale publish preview gets HTTP 409 and leaves the distribution untouched', async t => {
  const h = harness(t, {scenario: 'admin'});
  const request = await panel(h);
  const preview = await request('POST', 'publish-preview');
  assert.equal(preview.status, 200);
  assert.match(preview.body.digest, /^[a-f0-9]{64}$/);
  h.runner.next(CMD.dryRun, JSON.stringify(DRY_RUN({secrets: ['A_DIFFERENT_KEY']})));
  const refused = await request('POST', 'publish', preview.body);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, {error: 'preview_stale'});
  assert.equal(h.runner.count(CMD.publish), 0);
  assert.equal(h.managed.status().selfPublished, null);
});

test('regression: a second edit to an already-modified file makes the preview stale', async t => {
  const h = harness(t, {scenario: 'admin'});
  const request = await panel(h);
  const preview = await request('POST', 'publish-preview');
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.files.modified, ['b.md']);
  h.runner.next(CMD.dryRun, JSON.stringify(DRY_RUN({inputs: 'b'.repeat(64)})));
  const refused = await request('POST', 'publish', preview.body);
  assert.deepEqual([refused.status, refused.body], [409, {error: 'preview_stale'}]);
  assert.equal(h.runner.count(CMD.publish), 0);
});

test('preview and confirm work with a framework that omits inputs', async t => {
  const h = harness(t, {scenario: 'admin', runner: {dryRun: DRY_RUN({inputs: undefined})}});
  const request = await panel(h);
  const preview = await request('POST', 'publish-preview');
  assert.equal(preview.status, 200);
  assert.equal(Object.hasOwn(preview.body, 'inputs'), false);
  const publication = await request('POST', 'publish', preview.body);
  assert.equal(publication.status, 200);
  assert.equal(h.runner.count(CMD.publish), 1);
  assert.equal(Object.hasOwn(h.runner.last(CMD.publish).env, 'FYSO_DIST_EXPECT_INPUTS'), false);
});

for (const [code, stderr, expected] of [
  [6, '', 'preview_stale'],
  [3, 'preview_stale: distribution inputs changed since preview', 'preview_stale'],
  [3, '', 'stale_base'],
]) {
  test(`publish exit ${code} (marker: ${Boolean(stderr)}) returns HTTP 409 ${expected}`, async t => {
    const h = harness(t, {scenario: 'admin'});
    const request = await panel(h);
    const {body: preview} = await request('POST', 'publish-preview');
    h.runner.next(CMD.publish, fakeRunner.exit(code, {stderr}));
    const refused = await request('POST', 'publish', preview);
    assert.deepEqual([refused.status, refused.body], [409, {error: expected}]);
    assert.equal(h.runner.last(CMD.publish).env.FYSO_DIST_EXPECT_INPUTS, DRY_RUN().inputs);
  });
}

test('regression: the shown version is fresh after a publish', async t => {
  const h = harness(t, {scenario: 'admin', runner: {published: PUBLISHED('v4')}});
  h.connect({version: 'v2', etag: 'e1'});
  const request = await panel(h);
  assert.equal((await request('GET', 'status')).body.shownVersion, 'v2');
  const preview = await request('POST', 'publish-preview');
  const publication = await request('POST', 'publish', preview.body);
  assert.equal(publication.status, 200);
  assert.equal(publication.body.version, 'v4');

  const {body: status} = await request('GET', 'status');
  assert.deepEqual([status.bizVersion, status.shownVersion, status.selfPublished], ['v2', 'v4', 'v4']);
});

test('regression: the extension preview digest tracks the dry-run report independently of git', async t => {
  const h = harness(t, {scenario: 'admin', runner: {published: PUBLISHED('v4')}});
  let tree = 'before-snapshot';
  const gitTree = call => CMD.git(call) && call.args[0] === 'rev-parse';
  h.runner.always(gitTree, () => tree);
  const before = await h.managed.publishPreview();
  tree = 'after-unrelated-snapshot';
  const after = await h.managed.publishPreview();
  assert.equal(after.digest, before.digest);
  h.runner.next(CMD.dryRun, JSON.stringify(DRY_RUN({secrets: ['A_DIFFERENT_KEY']})));
  const changed = await h.managed.publishPreview();
  assert.deepEqual(changed.secrets, ['A_DIFFERENT_KEY']);
  assert.notEqual(changed.digest, after.digest);
  tree = 'immediately-before-publish';
  assert.equal((await h.managed.publish(after)).version, 'v4');
  assert.equal(h.runner.count(CMD.publish), 1);
});

test('regression: extension status picks up a newer version from local distribution answers', async t => {
  const h = harness(t, {scenario: 'admin'});
  h.connect({version: 'v2', etag: 'e1'});
  const request = await panel(h);
  h.project.makePublisher({commit: 'v2'});
  assert.equal((await request('GET', 'status')).body.shownVersion, 'v2');
  // Seed the answers and Biz state that an out-of-panel publish would leave behind.
  h.project.writeAnswers({commit: 'v3'});
  h.biz.publish('v3');
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  const {body: status} = await request('GET', 'status');
  assert.deepEqual([status.version, status.shownVersion, status.selfPublished], ['v2', 'v3', 'v3']);
  assert.equal(h.project.readState().selfPublished, 'v3');
  assert.equal(h.runner.count(), 0);
});

test('distribution exits 3, 4 and 5 return distinct panel outcomes', async t => {
  const h = harness(t, {scenario: 'admin'});
  const request = await panel(h);
  const {body: preview} = await request('POST', 'publish-preview');
  for (const [failure, error] of [[fakeRunner.staleBase(), 'stale_base'], [fakeRunner.setupNotInstalled(), 'setup_not_installed']]) {
    h.runner.next(CMD.publish, failure);
    const refused = await request('POST', 'publish', preview);
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, {error});
  }
  h.project.writeMergeConflicts(['project/wiki/guide.md']);
  h.runner.next(CMD.update, fakeRunner.mergeConflict());
  const merge = await request('POST', 'merge', {});
  assert.equal(merge.status, 409);
  assert.deepEqual(merge.body, {error: 'merge_conflict', files: ['project/wiki/guide.md']});
  assert.equal(h.runner.count(CMD.publish), 2);
  assert.equal(h.managed.status().selfPublished, null);
});

test('publish preview retries dist:key once before registering its key', async t => {
  const h = harness(t, {scenario: 'admin'});
  h.runner.next(CMD.key, fakeRunner.exit(1, {stderr: 'database is locked'}));
  assert.match((await h.managed.publishPreview()).digest, /^[a-f0-9]{64}$/);
  assert.equal(h.runner.count(CMD.key), 2);
  assert.deepEqual(h.runner.sleeps, [WINDOWS.KEY_RETRY_MS]);
  assert.equal(h.biz.count('recipient'), 1);
  assert.equal(h.runner.count(CMD.publish), 0);
});

test('sync republishes once after the recipients etag changes', async t => {
  const h = harness(t, {scenario: 'admin'});
  h.connect({version: 'v2', etag: 'e1', recipientsEtag: h.biz.recipientsEtag});
  assert.deepEqual(await h.managed.sync(), {status: 'noop'});
  assert.equal(h.runner.count(), 0);
  h.biz.addRecipient(`age1${'r'.repeat(58)}`, 'another-person');
  h.runner.next(CMD.publish, () => {
    assert.equal(h.biz.count('recipient'), 1);
    h.biz.publish('v3');
    return PUBLISHED('v3');
  });

  assert.deepEqual(await h.managed.sync(), {status: 'published'});
  assert.equal(h.managed.status().shownVersion, 'v3');
  assert.match(h.managed.status().notices.at(-1).text, /recipients changed/);
  assert.equal(h.project.readState().recipientsEtag, h.biz.recipientsEtag);
  assert.deepEqual(await h.managed.sync(), {status: 'noop'});
  assert.equal(h.runner.count(CMD.publish), 1);
});

test('misconfigured mise and non-JSON output get readable panel errors', async t => {
  const h = harness(t, {scenario: 'admin'});
  const request = await panel(h);
  const {body: preview} = await request('POST', 'publish-preview');
  h.runner.next(CMD.publish, fakeRunner.notPermitted());
  const failed = await request('POST', 'publish', preview);
  assert.deepEqual([failed.status, failed.body.error], [502, 'publish_failed']);
  assert.match(failed.body.detail, /Operation not permitted/);

  h.runner.next(CMD.dryRun, fakeRunner.nonJson());
  const malformedPreview = await request('POST', 'publish-preview');
  assert.deepEqual([malformedPreview.status, malformedPreview.body], [502, {error: 'unexpected_response'}]);
  h.runner.next(CMD.plan, fakeRunner.nonJson());
  const malformed = await request('POST', 'preview');
  assert.deepEqual([malformed.status, malformed.body], [502, {error: 'unexpected_response'}]);
  assert.equal(h.managed.status().selfPublished, null);
});

test('publish preview fails without contacting recipients when both key outputs lack an age key', async t => {
  const h = harness(t, {scenario: 'admin'});
  h.runner.always(CMD.key, 'warning: missing public key');
  await assert.rejects(h.managed.publishPreview(), {message: 'key_unavailable'});
  assert.equal(h.runner.count(CMD.key), 2);
  assert.deepEqual(h.runner.sleeps, [WINDOWS.KEY_RETRY_MS]);
  assert.equal(h.biz.count('recipient'), 0);
  assert.equal(h.runner.count(CMD.dryRun), 0);
});

test('publish records the reported version when neither command can identify an installed version', async t => {
  const h = harness(t, {scenario: 'admin'});
  const preview = await h.managed.publishPreview();
  h.runner.next(CMD.publish, () => {
    h.biz.publish('v4');
    return 'Upload finished';
  });
  h.runner.next(CMD.status, fakeRunner.exit(1));
  assert.equal((await h.managed.publish(preview)).version, 'v4');
  assert.equal(h.managed.status().shownVersion, 'v4');
  assert.equal(h.runner.count(CMD.status), 1);
});

test('regression: a failed preview is not reported as an outdated framework', async t => {
  const h = harness(t, {scenario: 'admin'});
  const request = await panel(h);
  const secret = 'test-preview-secret';
  h.runner.next(CMD.dryRun, call => fakeRunner.exit(1, {
    message: `Command failed: ${call.argv}`,
    stderr: `usage: dist:publish --dry-run --json\nsops: cannot read key ${h.project.root}/keys.txt token=${secret}`,
  }));
  const failed = await request('POST', 'publish-preview');
  assert.deepEqual([failed.status, failed.body.error], [502, 'publish_failed']);
  assert.match(failed.body.detail, /sops: cannot read key <tmp> token=\[redacted\]/);
  assert.ok(!failed.body.detail.includes(secret));
  assert.match(h.managed.status().notices.at(-1).text, /sops: cannot read key <tmp>/);
});

test('publish preview reports an outdated framework when stderr rejects the flag', async t => {
  const h = harness(t, {scenario: 'admin'});
  const request = await panel(h);
  for (const failure of [fakeRunner.oldFramework(), fakeRunner.exit(1, {stderr: 'error: unknown option --dry-run'})]) {
    h.runner.next(CMD.dryRun, failure);
    const rejected = await request('POST', 'publish-preview');
    assert.deepEqual([rejected.status, rejected.body], [409, {error: 'framework_update_required'}]);
  }
});
