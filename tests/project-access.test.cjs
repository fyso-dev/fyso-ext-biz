const {test} = require('node:test');
const assert = require('node:assert/strict');
const {projectAccess, departments, policy} = require('../extensions/biz/project-access.cjs');

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
  assert.deepEqual(await access.capabilities('t'), ['app:panel']);
  assert.deepEqual(urls, [{organization: 'acme', capability: 'app:panel'}, {organization: 'acme'}]);
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
