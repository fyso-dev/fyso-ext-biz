const {test} = require('node:test');
const assert = require('node:assert/strict');
const {projectAccess, departments, policy} = require('../extensions/biz/project-access.cjs');
const {fakeBiz, fakeClock, harness, WINDOWS} = require('./helpers/index.cjs');

const env = {
  FYSO_BIZ_URL: 'https://biz.example',
  FYSO_BIZ_ACCESS_ORGANIZATION: 'acme',
  FYSO_BIZ_ACCESS_PROJECT: 'installation',
};

test('sends the per-person profile token and trusted project configuration to Biz', async () => {
  const access = projectAccess({env, transport: async (url, options) => {
    assert.equal(url.origin, env.FYSO_BIZ_URL);
    assert.equal(options.headers.Authorization, 'Bearer personal-profile');
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/oauth/userinfo') {
      return Response.json({sub: 'person-1', scope: 'framework_access', organization: 'acme'});
    }
    assert.equal(url.pathname, '/oauth/framework-access');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      organization: 'acme', project: 'installation', capability: 'app:dagu',
    });
    return Response.json({allowed: false});
  }});

  assert.deepEqual(await access.identity('personal-profile'), {subject: 'person-1'});
  assert.equal(await access.can('personal-profile', 'app:dagu'), false);
});

test('does not grant access on malformed or unavailable decisions', async () => {
  for (const response of [
    Response.json({allowed: 'true'}),
    Response.json({error: 'unavailable'}, {status: 503}),
  ]) {
    const access = projectAccess({env, transport: async () => response});
    await assert.rejects(access.can('personal-profile', 'app:panel'));
  }
});

test('does not fall back to the installation token', async () => {
  const access = projectAccess({env: {...env, FYSO_BIZ_TOKEN: 'agent-token'}, transport: async () => {
    assert.fail('a request requires an explicit profile token');
  }});
  await assert.rejects(access.can(undefined, 'app:panel'), /profile_required/);
});

test('rejects a profile granted in a different organization', async () => {
  const access = projectAccess({env, transport: async () =>
    Response.json({sub: 'person-1', scope: 'framework_access', organization: 'other'}),
  });
  await assert.rejects(access.identity('wrong-organization'), /invalid_biz_profile/);
});

test('without a project the query carries only the organization', async () => {
  const urls = [];
  const access = projectAccess({env: {...env, FYSO_BIZ_ACCESS_PROJECT: ''}, transport: async url => {
    urls.push(Object.fromEntries(url.searchParams));
    return Response.json({allowed: true, capabilities: ['app:panel']});
  }});
  assert.equal(await access.can('t', 'app:panel'), true);
  // TEMPORARY translation (department-capabilities.cjs): derived page/action capabilities are added.
  assert.deepEqual((await access.capabilities('t')).slice(0, 1), ['app:panel']);
  assert.ok((await access.capabilities('t')).includes('action:feedback:submit'));
  // In department mode the report decides (one Biz call), not a per-capability query.
  assert.deepEqual(urls, [{organization: 'acme'}]);
  const none = projectAccess({env: {FYSO_BIZ_URL: env.FYSO_BIZ_URL}, transport: async () => assert.fail('not configured')});
  await assert.rejects(none.can('t', 'app:panel'), /biz_access_not_configured/);
});

test('the report carries departments, admin and policy, and tolerates their absence', async () => {
  const full = {capabilities: ['app:panel'], admin: true,
    departments: [{id: 'd1', name: 'Ventas', role: {id: 'lider', name: 'Líder', custom: false, levels: {objetivos: 2, agentes: 'x'}},
      teams: [{id: 'e1', name: 'Prospección'}, {id: '', name: 'bad'}]}, {id: 'd2'}, 'junk'],
    policy: {preset: 'equilibrado', extensions: 1, mcp_servers: 1, bots: 1, read: 1, write: 1, shell: 1, publish: 0, ai: 1}};
  const access = projectAccess({env, transport: async () => Response.json(full)});
  const report = await access.report('t');
  assert.equal(report.admin, true);
  assert.deepEqual(report.departments, [{id: 'd1', name: 'Ventas',
    role: {id: 'lider', name: 'Líder', custom: false, levels: {objetivos: 2}}, teams: [{id: 'e1', name: 'Prospección'}]}]);
  assert.deepEqual(report.policy, {preset: 'equilibrado', extensions: 1, mcp_servers: 1, bots: 1, read: 1, write: 1, shell: 1, publish: 0, ai: 1});
  const old = projectAccess({env, transport: async () => Response.json({capabilities: ['app:panel']})});
  assert.deepEqual(await old.report('t'), {capabilities: ['app:panel'], admin: false, departments: [], policy: null, reauthorizeRequired: false});
  assert.deepEqual(policy({preset: 'weird', ai: -1}).preset, 'personalizado');
  assert.deepEqual(departments('x'), []);
  const bad = projectAccess({env, transport: async () => Response.json({capabilities: [1], departments: []})});
  await assert.rejects(bad.report('t'), /invalid_biz_access_decision/);
});

test('an old grant whose identity Biz cannot recover is reported as reauthorize_required, not as no departments', async () => {
  const access = projectAccess({env, transport: async () => Response.json({capabilities: [], reauthorize_required: true})});
  assert.deepEqual(await access.report('t'), {capabilities: [], admin: false, departments: [], policy: null, reauthorizeRequired: true});
  const decision = projectAccess({env, transport: async () => Response.json({allowed: false, reauthorize_required: true})});
  assert.equal(await decision.can('t', 'app:panel'), false);
  // Only an explicit true counts.
  const loose = projectAccess({env, transport: async () => Response.json({capabilities: [], reauthorize_required: 'yes'})});
  assert.equal((await loose.report('t')).reauthorizeRequired, false);
});

test('an administrator reports the libre policy at its maximum; a person without a stored policy reports equilibrado', async () => {
  const admin = projectAccess({env, transport: async () => Response.json({capabilities: ['app:panel', 'framework:shell'], admin: true, departments: [],
    policy: {preset: 'libre', extensions: 2, mcp_servers: 2, bots: 1, read: 1, write: 2, shell: 2, publish: 1, ai: 2}})});
  assert.deepEqual((await admin.report('t')).policy, {preset: 'libre', extensions: 2, mcp_servers: 2, bots: 1, read: 1, write: 2, shell: 2, publish: 1, ai: 2});
  const person = projectAccess({env, transport: async () => Response.json({capabilities: ['app:panel'], admin: false, departments: [],
    policy: {preset: 'equilibrado', extensions: 1, mcp_servers: 1, bots: 1, read: 1, write: 1, shell: 1, publish: 0, ai: 1}})});
  assert.equal((await person.report('t')).policy.preset, 'equilibrado');
});

function cachedAccess(responses) {
  let t = 1_000, calls = 0;
  const access = projectAccess({env, now: () => t, transport: async () => {
    calls++;
    const next = typeof responses === 'function' ? responses(calls) : responses;
    if (next instanceof Error) throw next;
    return next;
  }});
  return {access, calls: () => calls, advance: ms => { t += ms; }};
}
const ok = (extra = {}) => Response.json({capabilities: ['app:panel'], ...extra});

test('report: concurrent calls share one Biz request and later calls are cached for 30 s', async () => {
  const c = cachedAccess(() => ok());
  const reports = await Promise.all(Array.from({length: 10}, () => c.access.report('tok')));
  assert.equal(c.calls(), 1);
  assert.ok(reports.every(r => r === reports[0]));
  c.advance(29_000);
  await c.access.report('tok');
  assert.equal(c.calls(), 1);
  assert.equal(await c.access.can('tok', 'app:panel'), true);
  assert.equal(c.calls(), 1);
  c.advance(2_000);
  await c.access.report('tok');
  assert.equal(c.calls(), 2);
  await c.access.report('other');
  assert.equal(c.calls(), 3);
});

test('report: failures are not cached and reject every waiter', async () => {
  const c = cachedAccess(n => n === 1 ? Response.json({}, {status: 503}) : ok());
  const results = await Promise.allSettled([c.access.report('tok'), c.access.report('tok')]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(c.calls(), 1);
  assert.deepEqual((await c.access.report('tok')).capabilities, ['app:panel']);
  assert.equal(c.calls(), 2);
});

test('report: a stale report under five minutes old covers transient errors only', async () => {
  for (const failure of [Response.json({}, {status: 503}), new TypeError('fetch failed')]) {
    const c = cachedAccess(n => n === 1 ? ok() : failure);
    await c.access.report('tok');
    c.advance(60_000);
    assert.deepEqual((await c.access.report('tok')).capabilities, ['app:panel']);
    c.advance(300_000);
    await assert.rejects(c.access.report('tok'));
  }
  for (const status of [401, 403]) {
    const c = cachedAccess(n => n === 1 ? ok() : Response.json({}, {status}));
    await c.access.report('tok');
    c.advance(60_000);
    await assert.rejects(c.access.report('tok'));
  }
});

test('report: a fresh reauthorize or frozen answer replaces the cached report at once', async () => {
  for (const [extra, key] of [[{capabilities: [], reauthorize_required: true}, 'reauthorizeRequired'], [{frozen: true}, 'frozen']]) {
    const c = cachedAccess(n => n === 1 ? ok() : n === 2 ? ok(extra) : Response.json({}, {status: 503}));
    await c.access.report('tok');
    c.advance(31_000);
    assert.equal((await c.access.report('tok'))[key], true);
    c.advance(31_000);
    assert.equal((await c.access.report('tok'))[key], true);
  }
});

test('invalidate drops the cached report of one token and the cache stays bounded', async () => {
  const c = cachedAccess(() => ok());
  await c.access.report('tok');
  c.access.invalidate('tok');
  await c.access.report('tok');
  assert.equal(c.calls(), 2);
  for (let i = 0; i < 150; i++) await c.access.report(`t${i}`);
  const before = c.calls();
  await c.access.report('t149');
  assert.equal(c.calls(), before);
  await c.access.report('t0');
  assert.equal(c.calls(), before + 1);
});

test('gives the report and decision calls a 15 s budget and other calls 5 s', async () => {
  const spy = () => {
    const timeouts = [];
    const original = AbortSignal.timeout;
    AbortSignal.timeout = ms => { timeouts.push(ms); return original.call(AbortSignal, ms); };
    return {timeouts, restore: () => { AbortSignal.timeout = original; }};
  };
  const {timeouts, restore} = spy();
  try {
    const access = projectAccess({env, transport: async url => {
      if (url.pathname === '/oauth/userinfo') return Response.json({sub: 'p', scope: 'framework_access', organization: 'acme'});
      return url.searchParams.has('capability') ? Response.json({allowed: true}) : Response.json({capabilities: ['app:dagu']});
    }});
    await access.identity('tok');
    await access.report('tok');
    await access.can('tok2', 'app:dagu');
    assert.deepEqual(timeouts, [5000, 15000, 15000]);
  } finally { restore(); }
});

test('regression: concurrent requests share one Biz call', async t => {
  const {access, biz, clock} = harness(t);
  const gate = biz.hold('report');
  const readers = Array.from({length: 12}, () => access.report('shared'));
  const callsWhileHeld = biz.count();
  gate.release();
  const reports = await Promise.all(readers);
  assert.equal(callsWhileHeld, 1);
  assert.equal(biz.count(), 1);
  assert.ok(reports.every(report => report.capabilities.includes('app:panel')));

  biz.bumpEtag();
  clock.advance(WINDOWS.REPORT_FRESH_MS - 1);
  assert.equal((await access.report('shared')).etag, reports[0].etag);
  assert.equal(biz.count(), 1);
  clock.advance(1);
  assert.equal((await access.report('shared')).etag, biz.etag);
  assert.equal(biz.count(), 2);
});

test('regression: a 4 s Biz answers within the timeout', async t => {
  const {access, biz, clock} = harness(t);
  const gate = biz.hold('report');
  clock.timer(4_000, gate.release);
  const pending = access.report('slow');
  let settled = false;
  const result = pending.finally(() => { settled = true; });
  clock.advance(3_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  clock.advance(1);
  assert.ok((await result).capabilities.includes('app:panel'));
  assert.equal(biz.last('report').signal.aborted, false);
  assert.deepEqual(clock.timeouts, [WINDOWS.ACCESS_TIMEOUT_MS]);
});

test('an unresponsive Biz report aborts at 15 s', async t => {
  const {access, biz, clock} = harness(t);
  biz.queue('report', fakeBiz.hang());
  const result = assert.rejects(access.report('slow'), {name: 'TimeoutError'});
  const {signal} = biz.last('report');
  const abortTimes = [];
  signal.addEventListener('abort', () => abortTimes.push(clock.now()));
  const start = clock.now();
  clock.advance(5_000);
  assert.equal(signal.aborted, false);
  clock.advance(9_999);
  assert.deepEqual(abortTimes, []);
  clock.advance(1);
  assert.deepEqual(abortTimes, [start + 15_000]);
  await result;
});

test('transient report failures fall back only while the original report is under five minutes old', async t => {
  for (const [name, failure, error] of [
    ['network', fakeBiz.networkError(), {name: 'TypeError'}],
    ['timeout', fakeBiz.hang(), {name: 'TimeoutError'}],
    ['server error', fakeBiz.http(503), {status: 503}],
  ]) {
    await t.test(name, async st => {
      const {access, biz, clock} = harness(st);
      const good = await access.report('token');
      biz.always('report', failure);
      const delay = name === 'timeout' ? WINDOWS.ACCESS_TIMEOUT_MS : 0;
      clock.advance(WINDOWS.REPORT_STALE_MS - delay - 1);
      const stale = access.report('token');
      clock.advance(delay);
      assert.deepEqual(await stale, good);
      assert.equal(biz.count('report'), 2);

      clock.advance(1);
      const expired = assert.rejects(access.report('token'), error);
      clock.advance(delay);
      await expired;
      assert.equal(biz.count('report'), 3);
    });
  }
});

test('authorization errors and restrictions take precedence over a stale grant', async t => {
  for (const status of [401, 403]) {
    await t.test(String(status), async st => {
      const {access, biz, clock} = harness(st);
      assert.ok((await access.report('token')).capabilities.includes('app:panel'));
      clock.advance(WINDOWS.REPORT_FRESH_MS);
      biz.queue('report', fakeBiz.http(status));
      await assert.rejects(access.report('token'), {status});
    });
  }
  for (const [scenario, flag] of [['frozen', 'frozen'], ['reauthorize', 'reauthorizeRequired']]) {
    await t.test(scenario, async st => {
      const {access, biz, clock} = harness(st);
      assert.ok((await access.report('token')).capabilities.includes('app:panel'));
      clock.advance(WINDOWS.REPORT_FRESH_MS);
      biz.scenario(scenario);
      assert.equal((await access.report('token'))[flag], true);
      assert.equal(await access.can('token', 'app:panel'), false);
    });
  }
});

test('invalidating one grant immediately refetches it and leaves other grants cached', async t => {
  const {access, biz} = harness(t);
  const first = await access.report('first');
  const second = await access.report('second');
  biz.bumpEtag();
  access.invalidate(null);
  access.invalidate('first');
  assert.equal((await access.report('second')).etag, second.etag);
  const updated = await access.report('first');
  assert.notEqual(updated.etag, first.etag);
  assert.equal(updated.etag, biz.etag);
  assert.deepEqual(biz.callsTo('report').map(call => call.token), ['first', 'second', 'first']);
  await assert.rejects(access.report(null), {message: 'profile_required'});
});

test('regression: an expired embedded credential asks to reauthorize, it is not a non-member', async t => {
  const {access, biz, clock, connect, managed, project, runner} = harness(t);
  const grant = project.readProfileGrant();
  const original = await access.report(grant.accessToken);
  assert.ok(original.capabilities.includes('app:panel'));
  connect({version: original.setup.version, etag: original.etag, lastCapabilities: original.capabilities.length});

  // The framework token is live, but Biz can no longer recover the embedded identity.
  clock.advance(WINDOWS.REPORT_FRESH_MS);
  biz.person(grant.accessToken, {scenario: 'reauthorize'});
  assert.deepEqual(await managed.sync(), {status: 'paused', reason: 'reauthorize_required'});
  const status = managed.status();
  assert.equal(status.frozen, false);
  assert.equal(status.noAccess, false);
  assert.equal(status.version, original.setup.version);
  assert.equal(project.readState().lastCapabilities, original.capabilities.length);
  assert.equal(runner.calls.length, 0);
});

test('recipient responses handle missing etags and reject malformed lists', async () => {
  const clock = fakeClock();
  const biz = fakeBiz({clock});
  const access = projectAccess({env, transport: biz.fetch, now: clock.now});
  biz.queue('recipients', fakeBiz.ok({recipients: []}), fakeBiz.http(204));
  assert.deepEqual(await access.recipients('token'), {recipients: [], etag: null});
  await assert.rejects(access.recipients('token'), {message: 'invalid_biz_access_decision'});
  const unconfigured = projectAccess({env: {}, transport: biz.fetch});
  await assert.rejects(unconfigured.recipients('token'), {message: 'biz_access_not_configured'});
});

test('invalidation detaches an in-flight report so it cannot restore the old version', async () => {
  const access = projectAccess();
  let finishOld;
  access.fetchReport = () => new Promise(resolve => { finishOld = resolve; });
  const old = access.report('tok');
  access.invalidate('tok');
  const current = {setup: {version: 'v3'}};
  access.fetchReport = async () => current;
  const fresh = access.report('tok');
  finishOld({setup: {version: 'v2'}});
  assert.equal((await old).setup.version, 'v2');
  assert.equal(await fresh, current);
  assert.equal(await access.report('tok'), current);
});
