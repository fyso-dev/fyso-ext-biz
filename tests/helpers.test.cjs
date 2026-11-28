// Self-test of tests/helpers/*: each helper behaves as documented, the windows in WINDOWS match the
// production modules, and one smoke per seam shows a helper driving a real production module.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {fakeBiz, fakeRunner, fakeClock, tempProject, harness, WINDOWS, CMD, AGE_KEY, PLAN, MACHINE_PATHS, SECRETS} = require('./helpers/index.cjs');
const {projectAccess} = require('../extensions/biz/project-access.cjs');
const {store} = require('../extensions/biz/auth.cjs');
const {profileSessions} = require('../extensions/biz/profile-session.cjs');
const managedSetup = require('../extensions/biz/managed-setup.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const isSettled = promise => Promise.race([promise.then(() => true, () => true), tick().then(() => false)]);
/** projectAccess wired to a fake Biz and clock, department mode. */
function wiredAccess(t, options = {}) {
  const clock = fakeClock();
  clock.installAbortTimeout(t);
  const project = tempProject(t, {seed: false});
  const biz = fakeBiz({clock, ...options});
  return {clock, project, biz, access: projectAccess({env: project.env, transport: biz.fetch, now: clock.now, root: project.root})};
}

// ---- fake-clock ------------------------------------------------------------------------------------

test('fake-clock: now, advance, set, iso and timers fire in order', () => {
  const clock = fakeClock({start: 1000});
  const fired = [];
  clock.timer(50, () => fired.push(['b', clock.now()]));
  clock.timer(10, () => fired.push(['a', clock.now()]));
  const cancel = clock.timer(20, () => fired.push('never'));
  cancel();
  assert.equal(clock.advance(5), 1005);
  assert.deepEqual(fired, []);
  assert.equal(clock.advance(100), 1105);
  assert.deepEqual(fired, [['a', 1010], ['b', 1050]], 'timers see the time they were due');
  assert.equal(fakeClock().iso(), '2026-01-01T00:00:00.000Z');
  assert.equal(clock.set(2000), 2000);
});

test('fake-clock: AbortSignal.timeout follows the clock', async t => {
  await t.test('inner', st => {
    const clock = fakeClock();
    clock.installAbortTimeout(st);
    const signal = AbortSignal.timeout(15_000);
    clock.advance(14_999);
    assert.equal(signal.aborted, false);
    clock.advance(1);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, 'TimeoutError');
    assert.deepEqual(clock.timeouts, [15_000]);
  });
});

test('fake-clock: AbortSignal.timeout is restored when the owning test ends', async t => {
  const original = AbortSignal.timeout;
  await t.test('owner', st => { fakeClock().installAbortTimeout(st); assert.notEqual(AbortSignal.timeout, original); });
  assert.equal(AbortSignal.timeout, original);
});

// WINDOWS are private constants of the production modules: pin each to observable behaviour.
test('fake-clock: WINDOWS match project-access (30 s fresh, 5 min stale, 15 s / 5 s timeouts)', async t => {
  const {clock, biz, access} = wiredAccess(t);
  await access.report('tok');
  clock.advance(WINDOWS.REPORT_FRESH_MS - 1);
  await access.report('tok');
  assert.equal(biz.count('report'), 1, 'still fresh one ms before the window');
  clock.advance(1);
  await access.report('tok');
  assert.equal(biz.count('report'), 2, 'refetched at the window');

  // Stale: every Biz call fails from now on; the cached report covers it for REPORT_STALE_MS.
  biz.always('report', fakeBiz.http(503));
  clock.advance(WINDOWS.REPORT_STALE_MS - 1);
  assert.deepEqual((await access.report('tok')).capabilities.includes('app:panel'), true);
  clock.advance(1);
  await assert.rejects(access.report('tok'), {status: 503});

  assert.deepEqual(clock.timeouts.filter(ms => ms === WINDOWS.ACCESS_TIMEOUT_MS).length, clock.timeouts.length, 'report calls get the long budget');
  await access.identity('tok');
  assert.equal(clock.timeouts.at(-1), WINDOWS.SHORT_TIMEOUT_MS);
  assert.equal(WINDOWS.ACCESS_TIMEOUT_MS, 15_000);
});

test('fake-clock: WINDOWS match project-access cache size', async t => {
  const {biz, access} = wiredAccess(t);
  for (let i = 0; i < WINDOWS.REPORT_CACHE_MAX + 1; i++) await access.report(`t${i}`);
  const before = biz.count('report');
  await access.report(`t${WINDOWS.REPORT_CACHE_MAX}`);
  assert.equal(biz.count('report'), before, 'the newest token is cached');
  await access.report('t0');
  assert.equal(biz.count('report'), before + 1, 'the oldest was evicted');
});

test('fake-clock: WINDOWS match auth (60 s renewal margin, 8 h credential), managed-setup (lock, key retry) and profile-session (login/session TTL)', async t => {
  const h = harness(t);
  // The token endpoint's `expires_in` is one hour on the real Biz (tests/contract); the 8 h is the Fyso credential Biz embeds, on Biz's own clock.
  assert.equal(h.biz.credentialExpiresIn, 3600);
  assert.equal(WINDOWS.CREDENTIAL_EXPIRY_MS, 8 * 60 * 60 * 1000);
  // Refresh margin: a token expiring in more than the margin is used as is, at the margin it is renewed.
  h.project.writeProfileGrant({expiresAt: h.clock.now() + WINDOWS.REFRESH_MARGIN_MS + 1});
  assert.equal(await h.store.profileAccessToken(), 'profile-token');
  assert.equal(h.biz.count('oauth.token'), 0);
  h.project.writeProfileGrant({expiresAt: h.clock.now() + WINDOWS.REFRESH_MARGIN_MS});
  assert.equal(await h.store.profileAccessToken(), 'access-1');
  assert.equal(h.project.readProfileGrant().expiresAt, h.clock.now() + h.biz.credentialExpiresIn * 1000);
  // Key retry pause.
  h.runner.next(CMD.key, fakeRunner.exit(1));
  await h.managed.preview();
  assert.deepEqual(h.runner.sleeps, [WINDOWS.KEY_RETRY_MS]);
  // A setup.lock older than the window is taken over; a younger one is `busy`.
  h.connect({version: 'v2', etag: 'e1'});
  const lock = path.join(h.project.dataDir, 'setup.lock');
  const age = ms => { fs.mkdirSync(lock, {recursive: true}); const when = (h.clock.now() - ms) / 1000; fs.utimesSync(lock, when, when); };
  age(WINDOWS.SETUP_LOCK_STALE_MS - 1000);
  await assert.rejects(h.managed.sync(), {message: 'busy'});
  age(WINDOWS.SETUP_LOCK_STALE_MS + 1000);
  assert.notEqual((await h.managed.sync()).status, undefined);
  assert.equal(fs.existsSync(lock), false, 'the lock is released');
  assert.equal(WINDOWS.LOGIN_TTL_MS, 600_000);
  assert.equal(WINDOWS.SESSION_TTL_MS, 3_600_000);
});

// ---- fake-biz --------------------------------------------------------------------------------------

test('fake-biz: the access scenarios produce the reports production parses', async t => {
  const {biz, access} = wiredAccess(t);
  const admin = await biz.scenario('admin') && await access.report('a');
  assert.equal(admin.admin, true);
  assert.equal(admin.policy.preset, 'libre');
  assert.equal(admin.setup.version, 'v2');
  assert.equal(admin.etag, 'e1');
  biz.scenario('member'); access.invalidate('a');
  const member = await access.report('a');
  assert.equal(member.admin, false);
  assert.equal(member.departments[0].name, 'Ventas');
  assert.deepEqual(member.departments[0].teams, [{id: 'e1', name: 'Prospeccion'}]);
  assert.equal(member.policy.preset, 'equilibrado');
  biz.scenario('noAccess'); access.invalidate('a');
  const none = await access.report('a');
  assert.deepEqual([none.capabilities, none.frozen, none.reauthorizeRequired], [[], true, false], 'Biz freezes a person with no department');
  biz.scenario('frozen'); access.invalidate('a');
  assert.equal((await access.report('a')).frozen, true);
  biz.scenario('frozen', {setup: null}); access.invalidate('a');
  assert.equal((await access.report('a')).setup, undefined, 'a person who never had access: no setup described');
  biz.scenario('reauthorize'); access.invalidate('a');
  assert.equal((await access.report('a')).reauthorizeRequired, true);
});

test('fake-biz: decision, identity, per-token people, pending recipients and revoked tokens', async t => {
  const project = tempProject(t, {seed: false, env: {FYSO_BIZ_ACCESS_PROJECT: 'installation'}});
  const biz = fakeBiz().person('admin-tok', {scenario: 'admin', sub: 'p-admin'}).person('frozen-tok', {scenario: 'frozen'});
  const access = projectAccess({env: project.env, transport: biz.fetch});
  assert.equal(await access.can('admin-tok', 'framework:shell'), true);
  assert.equal(await access.can('other', 'framework:extensions:any'), false);
  assert.equal(await access.can('other', 'app:panel'), true);
  assert.equal(await access.can('frozen-tok', 'app:panel'), false, 'frozen answers allowed: false');
  assert.deepEqual(biz.last('decision').query, {organization: 'acme', project: 'installation', capability: 'app:panel'});
  assert.deepEqual(await access.identity('admin-tok'), {subject: 'p-admin'});
  assert.deepEqual(await access.identity('other'), {subject: 'person-1'});
  biz.revoke('other');
  await assert.rejects(access.identity('other'), {status: 401});
  biz.scenario('admin').pendingRecipients(2);
  assert.equal(biz.reportBody('x').recipients_pending, 2);
});

test('fake-biz: recipients_pending drops once per person who registers, as the real Biz counts it', async t => {
  const {biz, access} = wiredAccess(t, {setupVersion: 'v1'});
  biz.person('admin-tok', {scenario: 'admin', sub: 'p-admin'}).person('member-tok', {scenario: 'member', sub: 'p-member'}).pendingRecipients(2);
  assert.equal((await access.fetchReport('admin-tok')).recipientsPending, 2);
  await access.registerRecipient('member-tok', AGE_KEY);
  assert.equal((await access.fetchReport('admin-tok')).recipientsPending, 1, 'a member with a key is no longer pending');
  assert.deepEqual((await access.recipients('admin-tok')).recipients.map(r => r.person_id), ['p-member'], 'and is listed');
  await access.registerRecipient('member-tok', `age1${'q'.repeat(58)}`);
  assert.equal((await access.fetchReport('admin-tok')).recipientsPending, 1, 'a new key of the same person changes nothing');
  assert.equal((await access.recipients('admin-tok')).recipients.length, 1);
  await access.registerRecipient('admin-tok', AGE_KEY);
  assert.equal((await access.fetchReport('admin-tok')).recipientsPending, undefined, 'none pending: the parsed report omits the count');
});

test('fake-biz: failures production must classify (401, 403, 409, 5xx, network error)', async t => {
  const {biz, access} = wiredAccess(t);
  for (const status of [401, 403, 503]) {
    biz.queue('report', fakeBiz.http(status));
    await assert.rejects(access.report(`t${status}`), {message: 'biz_access_unavailable', status});
  }
  biz.queue('report', fakeBiz.networkError());
  await assert.rejects(access.report('net'), {name: 'TypeError', message: 'fetch failed'});
  biz.queue('report', fakeBiz.reply(200, {capabilities: [1]}));
  await assert.rejects(access.report('bad'), {message: 'invalid_biz_access_decision'});
  assert.deepEqual(biz.callsTo('report').map(call => call.outcome.status ?? call.outcome.error), [401, 403, 503, 'TypeError', 200]);
});

test('fake-biz: queueing, always, clear and per-route counts', async t => {
  const {biz, access} = wiredAccess(t);
  biz.queue('report', fakeBiz.http(503), fakeBiz.ok({capabilities: ['app:panel'], etag: 'q1'}));
  await assert.rejects(access.fetchReport('t'), {status: 503});
  assert.equal((await access.fetchReport('t')).etag, 'q1');
  assert.equal((await access.fetchReport('t')).etag, 'e1', 'the queue is spent: the default answers again');
  biz.always('report', fakeBiz.http(401));
  await assert.rejects(access.fetchReport('t'), {status: 401});
  await assert.rejects(access.fetchReport('t'), {status: 401});
  biz.clear();
  await access.fetchReport('t');
  assert.deepEqual([biz.count('report'), biz.count('identity'), biz.count()], [6, 0, 6]);
  biz.always('*', fakeBiz.networkError());
  await assert.rejects(access.identity('t'), TypeError);
  biz.reset();
  assert.equal(biz.count(), 0);
});

test('fake-biz: the call log records method, route, query, headers, token and body', async t => {
  const {biz, access} = wiredAccess(t, {scenario: 'admin'});
  await access.registerRecipient('tok', AGE_KEY);
  const call = biz.last('recipient');
  assert.deepEqual([call.method, call.path, call.query, call.token, call.body], ['PUT', '/oauth/framework-access/recipient', {organization: 'acme'}, 'tok', {age_public_key: AGE_KEY}]);
  assert.equal(call.headers.authorization, 'Bearer tok');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.index, 0);
  await assert.rejects(access.registerRecipient('tok', `age1${'q'.repeat(10)}`), {message: 'invalid_age_key'});
  assert.equal(biz.count('recipient'), 1, 'production validates before calling');
});

test('fake-biz: a held request whose abort comes first rejects, it is not answered when released later', async t => {
  const {clock, biz, access} = wiredAccess(t);
  const gate = biz.hold('report');
  const pending = access.report('held');
  clock.advance(WINDOWS.ACCESS_TIMEOUT_MS);          // the 15 s signal fires while Biz still holds the call
  await assert.rejects(pending, {name: 'TimeoutError'});
  gate.release();                                    // released after the abort: no answer reaches the caller
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(biz.last('report').outcome, {error: 'TimeoutError', message: 'The operation was aborted due to timeout'});
  // Released first: the held call is answered normally.
  const second = biz.hold('report');
  const ok = access.report('held-2');
  second.release();
  assert.equal((await ok).admin, false);
});

test('fake-biz: hang honours the AbortSignal (timeout) and a hold proves single-flight', async t => {
  const {clock, biz, access} = wiredAccess(t);
  biz.queue('report', fakeBiz.hang());
  const pending = access.report('slow');
  assert.equal(await isSettled(pending), false, 'never resolves by itself');
  clock.advance(WINDOWS.ACCESS_TIMEOUT_MS - 1);
  assert.equal(await isSettled(pending), false);
  clock.advance(1);
  await assert.rejects(pending, {name: 'TimeoutError'});
  assert.deepEqual(biz.last('report').outcome, {error: 'TimeoutError', message: 'The operation was aborted due to timeout'});
  // With a plain AbortController, and an already aborted signal.
  const controller = new AbortController();
  biz.queue('identity', fakeBiz.hang());
  const request = biz.fetch('/oauth/userinfo', {headers: {Authorization: 'Bearer x'}, signal: controller.signal});
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(request, {name: 'AbortError'});
  await assert.rejects(biz.fetch('/oauth/userinfo', {signal: AbortSignal.abort()}), {name: 'AbortError'});
  // timedOut(): the same TimeoutError without waiting.
  biz.queue('report', fakeBiz.timedOut());
  await assert.rejects(access.report('fast'), {name: 'TimeoutError'});
  // Ten concurrent readers while Biz is held: one call.
  const gate = biz.hold('report');
  const readers = Array.from({length: 10}, () => access.report('shared'));
  await tick();
  assert.equal(biz.count('report'), 3, 'slow, fast and one shared call; none per reader');
  gate.release();
  const reports = await Promise.all(readers);
  assert.ok(reports.every(report => report === reports[0]));
  assert.equal(biz.count('report'), 3);
});

test('fake-biz: the published setup and etag change between calls', async t => {
  const {biz, access} = wiredAccess(t);
  const first = await access.fetchReport('t');
  assert.deepEqual([first.setup.version, first.etag], ['v2', 'e1']);
  assert.match(first.setup.sha256, /^[0-9a-f]{64}$/);
  biz.bumpEtag();
  assert.equal((await access.fetchReport('t')).etag, 'e2');
  biz.publish('v3');
  const third = await access.fetchReport('t');
  assert.deepEqual([third.setup.version, third.setup.etag, third.etag], ['v3', `v3-${biz.setup.sha256.slice(0, 16)}`, 'e3']);
  biz.queue('report', fakeBiz.ok({...biz.reportBody('t'), etag: 'queued', setup: {...biz.setup, version: 'v9'}}));
  assert.deepEqual([(await access.fetchReport('t')).setup.version, (await access.fetchReport('t')).setup.version], ['v9', 'v3']);
  const none = fakeBiz({setupVersion: null});
  assert.equal(none.setup, null);
  assert.equal(none.reportBody('t').setup, null);
});

const putSetup = (biz, {token = 'admin', version = 'v3', base = 'v2', body = Buffer.from('bundle'), headers = {}, query = '?organization=acme'} = {}) =>
  biz.fetch(`/oauth/framework-access/setup${query}`, {method: 'PUT', body, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
    'X-Setup-Version': version, 'X-Setup-Base': base, 'X-Setup-Sha256': require('node:crypto').createHash('sha256').update(body).digest('hex'),
    'X-Setup-Manifest': Buffer.from('{}').toString('base64'), ...headers}});

test('fake-biz: setup GET and PUT with X-Setup-Base (stale_base, version_conflict, atomic publish)', async t => {
  const biz = fakeBiz().person('admin', {scenario: 'admin'});
  const got = await biz.fetch('/oauth/framework-access/setup?organization=acme', {headers: {Authorization: 'Bearer member'}});
  assert.deepEqual([got.status, got.headers.get('x-setup-version'), got.headers.get('etag'), await got.text()], [200, 'v2', `"v2-${biz.setup.sha256.slice(0, 16)}"`, 'bundle v2']);
  assert.equal((await putSetup(biz, {token: 'member'})).status, 403);
  assert.equal((await putSetup(biz, {headers: {'X-Setup-Base': ''}})).status, 400);
  assert.equal((await putSetup(biz, {headers: {'X-Setup-Sha256': '0'.repeat(64)}})).status, 400);
  const stale = await putSetup(biz, {base: 'v1'});
  assert.deepEqual([stale.status, await stale.json()], [409, {error: 'stale_base', current: 'v2'}]);
  assert.deepEqual(await (await putSetup(biz, {version: 'v2', base: 'v2'})).json(), {error: 'version_conflict', current: 'v2'});
  assert.deepEqual(await (await putSetup(biz, {headers: {'X-Setup-Manifest': Buffer.alloc(9000).toString('base64')}})).json(), {error: 'manifest_too_large'});
  assert.equal((await putSetup(biz, {query: '?organization=other'})).status, 403);
  // Two publishes on the same base at once: exactly one wins.
  const [a, b] = await Promise.all([putSetup(biz, {body: Buffer.from('from a')}), putSetup(biz, {body: Buffer.from('from b')})]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(biz.setup.version, 'v3');
  assert.equal(biz.reportBody('x').etag, 'e2');
  assert.equal(biz.count('setup.put'), 9);
  // No setup: 404; frozen: 403.
  assert.equal((await fakeBiz({setupVersion: null}).fetch('/oauth/framework-access/setup?organization=acme', {headers: {Authorization: 'Bearer m'}})).status, 404);
  assert.equal((await fakeBiz({scenario: 'frozen'}).fetch('/oauth/framework-access/setup?organization=acme', {headers: {Authorization: 'Bearer m'}})).status, 403);
  // The first publish of an organization is based on `none`.
  const empty = fakeBiz({setupVersion: null}).person('admin', {scenario: 'admin'});
  assert.equal((await putSetup(empty, {version: 'v1', base: 'none'})).status, 201);
});

test('fake-biz: recipients are registered by key, listed to admins only, and clear the pending count', async t => {
  const {biz, access} = wiredAccess(t, {scenario: 'admin'});
  biz.pendingRecipients(1);
  assert.deepEqual(await access.recipients('adm'), {recipients: [], etag: 'r1'});
  await access.registerRecipient('adm', AGE_KEY);
  const listed = await access.recipients('adm');
  assert.deepEqual(listed.recipients.map(item => [item.person_id, item.age_public_key]), [['person-1', AGE_KEY]]);
  assert.equal(listed.etag, 'r2');
  assert.equal(biz.recipientsPending, 0);
  assert.equal(biz.reportBody('adm').recipients_pending, 0, 'with a setup the admin report always says how many are pending, even none');
  biz.person('member-tok', {scenario: 'member'});
  await assert.rejects(access.recipients('member-tok'), {status: 403});
  biz.addRecipient(AGE_KEY, 'someone');
  assert.equal(biz.recipientList.length, 2);
  const invalid = await biz.fetch('/oauth/framework-access/recipient?organization=acme', {method: 'PUT', headers: {Authorization: 'Bearer adm', 'Content-Type': 'application/json'}, body: '{"age_public_key":"nope"}'});
  assert.equal(invalid.status, 400);
});

test('fake-biz: OAuth metadata, registration and token endpoints drive auth.cjs, including a refused refresh', async t => {
  const h = harness(t, {grant: false});
  const auth = store({env: h.env, transport: h.biz.fetch, now: h.clock.now});
  const request = await auth.beginProfile('https://panel.demo.test/extensions/biz/oauth/callback');
  assert.equal(new URL(request.url).origin, 'https://biz.test');
  const grant = await auth.finishProfile(request, 'code');
  assert.deepEqual(grant, {accessToken: 'access-1', expiresAt: h.clock.now() + h.biz.credentialExpiresIn * 1000});
  auth.saveProfile(grant);
  assert.equal(h.biz.last('oauth.token').body.grant_type, 'authorization_code');
  assert.equal(await auth.profileAccessToken(), 'access-1');
  h.clock.advance(h.biz.credentialExpiresIn * 1000);
  assert.equal(await auth.profileAccessToken(), 'access-2');
  assert.equal(h.biz.last('oauth.token').body.grant_type, 'refresh_token');
  h.clock.advance(h.biz.credentialExpiresIn * 1000);
  h.biz.refreshRefused = true;
  await assert.rejects(auth.profileAccessToken(), {message: 'access_denied'});
  h.biz.refreshRefused = false;
  h.biz.queue('oauth.token', fakeBiz.http(503));
  await assert.rejects(auth.profileAccessToken(), {message: 'remote_unavailable'});
  assert.equal(h.biz.count('oauth.metadata') >= 3, true);
});

test('fake-biz: a request outside the known routes is a 404 and the organization must match', async t => {
  const biz = fakeBiz();
  assert.equal((await biz.fetch('/nope')).status, 404);
  assert.equal(biz.last().route, 'unknown');
  assert.equal((await biz.fetch('/oauth/framework-access/setup?organization=zzz', {headers: {Authorization: 'Bearer t'}})).status, 403);
  const other = await biz.fetch('/oauth/framework-access?organization=zzz', {headers: {Authorization: 'Bearer t'}});
  assert.deepEqual([other.status, await other.json()], [200, {capabilities: []}], 'the report of another organization knows nothing');
  assert.equal((await biz.fetch('/oauth/framework-access', {headers: {Authorization: 'Bearer t'}})).status, 400);
  assert.equal((await biz.fetch('/oauth/framework-access?organization=acme')).status, 401);
  assert.deepEqual(fakeBiz.ROUTES.slice(0, 3), ['identity', 'report', 'decision']);
});

// ---- fake-runner -----------------------------------------------------------------------------------

test('fake-runner: canned success outputs of every command, and a full call record', () => {
  const runner = fakeRunner();
  const run = (...argv) => runner.run(argv[0], argv.slice(1), {env: {X: '1'}, cwd: 'somewhere'});
  assert.equal(run('mise', 'run', '-q', 'dist:key'), `${AGE_KEY}\n`);
  assert.deepEqual(managedSetup.jsonOf(run('mise', 'run', '-q', 'dist:plan', 'biz', '--json')), PLAN());
  const dry = managedSetup.jsonOf(run('mise', 'run', '-q', 'dist:publish', '--dry-run', '--json'));
  assert.ok(managedSetup.publishPreviewOf(dry), 'the dry run is a preview production accepts');
  assert.match(run('mise', 'run', 'dist:publish', 'v4'), /published v3 \(234 files\) to Biz/);
  assert.match(run('mise', 'run', '-q', 'dist:status'), /^Version:\s+v3$/m);
  assert.equal(run('mise', 'run', 'dist:update'), '');
  assert.equal(run('mise', 'run', 'snapshot'), '');
  assert.equal(run('git', 'rev-parse', 'HEAD'), 'tree1\n');
  assert.throws(() => run('node', 'framework/scripts/marketplace.cjs', 'resolve', 'x'), /not in the catalog/);
  assert.equal(runner.count(CMD.publish), 1, 'a dry run is not a publish');
  assert.equal(runner.count(CMD.dryRun), 1);
  assert.equal(runner.count('dist:'), 6);
  const first = runner.calls[0];
  assert.deepEqual([first.command, first.args, first.argv, first.env, first.cwd, first.index], ['mise', ['run', '-q', 'dist:key'], 'mise run -q dist:key', {X: '1'}, 'somewhere', 0]);
  assert.equal(runner.last(CMD.key), first);
  runner.sleep(1500);
  assert.deepEqual(runner.sleeps, [1500]);
  runner.reset();
  assert.deepEqual([runner.calls.length, runner.sleeps.length], [0, 0]);
});

test('fake-runner: failures carry the exit code, stdout and stderr like execFileSync', () => {
  const runner = fakeRunner();
  const fail = (spec, ...command) => { runner.always(CMD.publish, spec); try { runner.run('mise', ['run', 'dist:publish', ...command]); } catch (error) { return error; } assert.fail('should have thrown'); };
  for (const code of [1, 3, 4, 5]) assert.equal(fail(fakeRunner.exit(code, {stderr: `boom ${code}`})).status, code);
  const error = fail(fakeRunner.exit(3, {stdout: 'out', stderr: 'err'}));
  assert.deepEqual([error.status, error.stdout, error.stderr, error.message], [3, 'out', 'err', 'Command failed: mise run dist:publish\nerr']);
  assert.equal(fail(fakeRunner.staleBase()).status, 3);
  assert.deepEqual(JSON.parse(fail(fakeRunner.staleBase()).stdout).stale_base, true);
  assert.equal(fail(fakeRunner.setupNotInstalled()).status, 5);
  assert.equal(fail(fakeRunner.mergeConflict()).status, 4);
  assert.match(fail(fakeRunner.notPermitted()).stderr, /Operation not permitted/);
  assert.equal(JSON.parse(fail(fakeRunner.failedChecks()).stdout).checks.machine_paths, 'failed');
  assert.match(fail(fakeRunner.oldFramework()).stderr, /invalid version/);
  assert.equal(fail(Object.assign(Error('custom'), {status: 7})).status, 7);
  assert.equal(fail(5).status, 5, 'a bare number is an exit code');
  assert.equal(fail(() => fakeRunner.exit(9)).status, 9);
  runner.reset().always(CMD.dryRun, fakeRunner.nonJson());
  assert.throws(() => managedSetup.jsonOf(runner.run('mise', ['run', '-q', 'dist:publish', '--dry-run', '--json'])), {message: 'unexpected_response'});
});

test('fake-runner: next queues one answer per call, then the defaults; always overrides; callers see both', () => {
  const runner = fakeRunner({published: 'published v8 (1 files) to Biz'});
  runner.next(CMD.key, fakeRunner.exit(1), fakeRunner.exit(1)).next(CMD.key, `${AGE_KEY}\n`);
  const key = () => runner.run('mise', ['run', '-q', 'dist:key']);
  assert.throws(key, {status: 1});
  assert.throws(key, {status: 1});
  assert.equal(key(), `${AGE_KEY}\n`);
  assert.equal(key(), `${AGE_KEY}\n`, 'defaults after the queue');
  runner.always('dist:update', 'merged\n');
  assert.equal(runner.run('mise', ['run', 'dist:update']), 'merged\n');
  runner.next(/dist:update/, () => { throw Error('dynamic'); });
  assert.throws(() => runner.run('mise', ['run', 'dist:update']), {message: 'dynamic'});
  assert.match(runner.run('mise', ['run', 'dist:publish']), /published v8/);
  runner.next(call => call.cwd === 'x', 'special');
  assert.equal(runner.run('mise', ['run', 'dist:publish'], {cwd: 'x'}), 'special');
});

test('fake-runner: stderr with machine paths and secrets, built at runtime, and production redacts it', () => {
  const runner = fakeRunner().always(CMD.update, fakeRunner.leaky(4));
  let error;
  try { runner.run('mise', ['run', 'dist:update']); } catch (e) { error = e; }
  assert.equal(error.status, 4);
  for (const leak of [...MACHINE_PATHS, ...Object.values(SECRETS)]) assert.ok(error.stderr.includes(leak), leak);
  const tail = managedSetup.stderrTail(error, 2000);
  for (const leak of [...MACHINE_PATHS, SECRETS.ageSecret, SECRETS.bearer, SECRETS.assignment.split('=')[1]]) assert.ok(!tail.includes(leak), `leaked: ${leak}`);
  assert.match(tail, /<path>|<tmp>/);
  assert.ok(MACHINE_PATHS.every(item => path.isAbsolute(item)));
});

test('fake-runner: ext:remove deletes the extension answers when a root is given', t => {
  const project = tempProject(t);
  const runner = fakeRunner({root: project.root});
  runner.run('mise', ['run', 'ext:remove', 'foo']);
  assert.deepEqual(project.list('.').filter(name => name.startsWith('.copier-answers.ext-')), ['.copier-answers.ext-bar.yml', '.copier-answers.ext-biz.yml']);
});

// ---- temp-project ----------------------------------------------------------------------------------

test('temp-project: a folder per test, removed when the test ends', async t => {
  let root;
  await t.test('owner', st => {
    const project = tempProject(st);
    root = project.root;
    assert.ok(project.root.startsWith(require('node:os').tmpdir()));
    assert.equal(fs.existsSync(root), true);
    assert.equal(tempProject(st).root === root, false);
  });
  assert.equal(fs.existsSync(root), false);
  const manual = tempProject(null, {seed: false});
  assert.deepEqual(manual.list(), []);
  manual.cleanup();
  assert.equal(fs.existsSync(manual.root), false);
});

test('temp-project: setup.json, answers, distribution.yaml and the other files sit where production reads them', t => {
  const project = tempProject(t);
  // setup.json is the file managed-setup reads and writes.
  project.writeState({connected: true, version: 'v2'});
  assert.deepEqual(managedSetup.readState(project.env), {connected: true, version: 'v2'});
  managedSetup.writeState(project.env, {frozen: true});
  assert.deepEqual(project.readState(), {frozen: true});
  project.patchState({etag: 'x'});
  assert.deepEqual(project.readState(), {frozen: true, etag: 'x'});
  assert.equal(fs.statSync(project.stateFile).mode & 0o777, 0o600);
  assert.equal(path.basename(project.stateFile), 'setup.json');
  // answers + distribution.yaml: a publisher is detected and its own version recognised.
  project.makePublisher({commit: 'v3'});
  assert.equal(project.answersVersion(), 'v3');
  assert.match(project.readAnswers(), /^_commit: v3$/m);
  assert.match(project.readDistribution(), /^repo: biz$/m);
  const setup = managedSetup.setup({env: project.env, root: project.root, access: {}, store: {}});
  assert.equal(setup.noteReport({setup: {version: 'v3'}}), true, 'production reads the answers and distribution.yaml');
  assert.equal(project.readState().selfPublished, 'v3');
  // Seeded content is what inspect() sees.
  const local = managedSetup.inspect(project.root, {yaml: project.yaml});
  assert.deepEqual(local.extensions.map(e => e.id).sort(), ['bar', 'biz', 'foo']);
  assert.deepEqual(local.mcpServers, ['mine', 'fromsetup']);
  assert.deepEqual(local.bots.map(bot => bot.name), ['Mine', 'Shared'], 'the stand-in yaml reads team.yaml');
  assert.deepEqual(local.extensions.find(e => e.id === 'foo').src, 'gh:x/foo');
  assert.deepEqual(project.readMcp(), {mine: {url: 'http://x'}, fromsetup: {url: 'http://y'}});
  // Other writers.
  project.writeMergeConflicts(['a.md']);
  assert.deepEqual(JSON.parse(project.readFile('.data/dist/merge-conflicts.json')), {files: ['a.md']});
  project.writePendingSecrets(['K']);
  project.markStarted();
  assert.equal(project.exists('.data/omb/.fyso-restored'), true);
  project.writeProfileGrant({accessToken: 'x'});
  assert.equal(store({env: project.env}).profileStatus().connected, true);
  assert.equal(project.readProfileGrant().accessToken, 'x');
  assert.equal(tempProject(t, {seed: false}).list().length, 0);
  assert.deepEqual(tempProject(t, {env: {FYSO_BIZ_ACCESS_PROJECT: 'p'}}).env.FYSO_BIZ_ACCESS_PROJECT, 'p');
  assert.equal(project.readFile('missing'), null);
});

// ---- integration smokes: a helper drives a real production module -------------------------------------

test('smoke project-access: a report from fake-biz, one Biz call for concurrent readers', async t => {
  const {biz, access} = wiredAccess(t, {scenario: 'admin'});
  const [a, b] = await Promise.all([access.report('tok'), access.report('tok')]);
  assert.equal(a, b);
  assert.equal(a.admin, true);
  assert.equal(biz.count('report'), 1);
  assert.equal(await access.can('tok', 'app:panel'), true);
  assert.equal(biz.count(), 1, 'a fresh cached report answers `can` too');
});

test('smoke managed-setup: sync with fake-biz + fake-runner + temp project (connect, no-op, change, pauses)', async t => {
  const h = harness(t, {runner: {plan: PLAN()}});
  const preview = await h.managed.preview();
  assert.deepEqual(preview.setup.version, 'v2');
  assert.equal(h.biz.last('recipient').body.age_public_key, AGE_KEY, 'the key printed by the fake dist:key is registered');
  const applied = await h.managed.apply({digest: preview.digest});
  assert.equal(applied.version, 'v2');
  assert.deepEqual(h.runner.callsTo(call => /snapshot|dist:add/.test(call.argv)).map(call => call.argv.match(/snapshot|dist:add/)[0]), ['snapshot', 'dist:add']);
  assert.equal(h.project.readState().etag, 'e1');
  // Same etag: no-op, nothing run.
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  h.runner.reset();
  assert.equal((await h.managed.sync()).status, 'noop');
  assert.equal(h.runner.calls.length, 0);
  // Biz publishes v3: the sync applies it.
  h.biz.publish('v3');
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  assert.equal((await h.managed.sync()).status, 'applied');
  assert.equal(h.runner.count(CMD.snapshot), 1);
  assert.equal(h.project.readState().version, 'v3');
  assert.equal(h.project.readState().notices.at(-1).kind, 'applied');
  // Biz rejects the credential: paused as reauthorize_required (never masked by the cached report); then unreachable.
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  h.biz.queue('report', fakeBiz.http(401));
  assert.deepEqual(await h.managed.sync(), {status: 'paused', reason: 'reauthorize_required'});
  const hung = async () => {
    h.biz.queue('report', fakeBiz.hang());
    const slow = h.managed.sync();
    await tick();
    h.clock.advance(WINDOWS.ACCESS_TIMEOUT_MS);
    return slow;
  };
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  assert.equal((await hung()).status, 'noop', 'a timeout is covered by a cached report younger than the stale window');
  h.clock.advance(WINDOWS.REPORT_STALE_MS);
  assert.deepEqual(await hung(), {status: 'paused', reason: 'biz_unreachable'});
  // Frozen: the delivered secrets are deleted through the fake sops.
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  h.biz.scenario('frozen');
  assert.equal((await h.managed.sync()).status, 'frozen');
  assert.equal(h.runner.count(CMD.sopsUnset), 2);
  assert.equal(h.project.exists('state/dist/secrets.sops.yaml'), false);
});

test('smoke managed-setup: publish flow with exit codes and the runner queue', async t => {
  const h = harness(t, {scenario: 'admin'});
  const preview = await h.managed.publishPreview();
  assert.equal(preview.version, 'v4');
  h.runner.next(CMD.publish, fakeRunner.staleBase());
  await assert.rejects(h.managed.publish({version: preview.version, digest: preview.digest}), {message: 'stale_base'});
  h.runner.next(CMD.dryRun, fakeRunner.failedChecks());
  assert.equal((await h.managed.publishPreview()).blocked, true);
  const published = await h.managed.publish({version: preview.version, digest: preview.digest});
  assert.equal(published.version, 'v3');
  assert.equal(h.project.readState().selfPublished, 'v3');
  assert.equal(h.biz.count('recipient') >= 3, true);
});

test('smoke profile-session: login, callback and /profile/access against fake-biz with one Biz call per request', async t => {
  const h = harness(t);
  const profiles = profileSessions({env: h.env, now: h.clock.now, access: h.access, managedSetup: {},
    auth: {beginProfile: async () => ({state: 's1', url: 'https://biz.test/oauth/authorize?state=s1'}),
      finishProfile: async () => ({accessToken: 'tok-ana', expiresAt: h.clock.now() + WINDOWS.CREDENTIAL_EXPIRY_MS})}});
  const call = async (url, {method = 'GET', cookie} = {}) => {
    const out = {};
    const res = {writeHead(status, headers) { Object.assign(out, {status, headers}); return this; }, end(body) { out.body = body; }};
    await profiles.handle({url, method, headers: {'remote-user': 'ana', cookie}}, res);
    return out;
  };
  const login = await call('/profile/login', {method: 'POST'});
  assert.equal(login.status, 303);
  assert.match(login.headers['Set-Cookie'], new RegExp(`Max-Age=${WINDOWS.LOGIN_TTL_MS / 1000}`));
  const callback = await call('/profile/callback?state=s1&code=c', {cookie: login.headers['Set-Cookie'].split(';')[0]});
  assert.equal(callback.status, 303);
  assert.match(callback.headers['Set-Cookie'][1], new RegExp(`Max-Age=${WINDOWS.SESSION_TTL_MS / 1000}`));
  assert.equal(h.biz.count('identity'), 1);
  const cookie = callback.headers['Set-Cookie'][1].split(';')[0];
  const access = await call('/profile/access', {cookie});
  assert.equal(JSON.parse(access.body).capabilities.includes('app:panel'), true);
  assert.equal(JSON.parse(access.body).departments[0].name, 'Ventas');
  await call('/profile/access', {cookie});
  assert.equal(h.biz.count('report'), 1, 'two requests, one Biz call');
  // A 503 with no cached report is a 502 for the panel; a revoked token is not masked.
  h.clock.advance(WINDOWS.REPORT_STALE_MS);
  h.biz.queue('report', fakeBiz.http(503));
  assert.equal((await call('/profile/access', {cookie})).status, 502);
});

test('smoke profile-token: the token command reads the saved grant and refreshes it against fake-biz', async t => {
  const h = harness(t);
  h.clock.advance(WINDOWS.CREDENTIAL_EXPIRY_MS - WINDOWS.REFRESH_MARGIN_MS);
  assert.equal(await h.store.profileAccessToken(), 'access-1');
  assert.equal(h.biz.last('oauth.token').body.refresh_token, 'profile-refresh');
  h.clock.advance(h.biz.credentialExpiresIn * 1000);
  h.biz.refreshRefused = true;
  await assert.rejects(h.store.profileAccessToken(), {message: 'access_denied'});
});
