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
  assert.deepEqual(await old.report('t'), {capabilities: ['app:panel'], admin: false, departments: [], policy: null});
  assert.deepEqual(policy({preset: 'weird', ai: -1}).preset, 'personalizado');
  assert.deepEqual(departments('x'), []);
  const bad = projectAccess({env, transport: async () => Response.json({capabilities: [1], departments: []})});
  await assert.rejects(bad.report('t'), /invalid_biz_access_decision/);
});
