const {test} = require('node:test');
const assert = require('node:assert/strict');
const {projectPolicy} = require('../extensions/biz/project-policy.cjs');

const env = {
  FYSO_WEB_DOMAIN: 'project.test',
  FYSO_BIZ_ACCESS_ORGANIZATION: 'acme',
  FYSO_BIZ_ACCESS_PROJECT: 'project-id',
};

function check(handler, path, {host = 'panel.project.test', method = 'GET', user = 'ana'} = {}) {
  const req = {headers: {
    'remote-user': user, 'x-fyso-policy-host': host, 'x-fyso-policy-path': path, 'x-forwarded-method': method,
  }};
  return handler(req, {writeHead: status => ({end: () => status})});
}

test('requires both panel and route permissions for a protected request', async () => {
  const calls = [];
  const permissions = new Set(['app:panel', 'action:bots:list']);
  const handler = projectPolicy({
    env, profiles: {current: () => ({accessToken: 'person'})},
    access: {can: async (token, capability) => {
      calls.push(capability);
      assert.equal(token, 'person');
      return permissions.has(capability);
    }},
  });
  assert.equal(await check(handler, '/api/omb/bots'), 204);
  assert.deepEqual(calls, ['app:panel', 'action:bots:list']);
  permissions.delete('action:bots:list');
  assert.equal(await check(handler, '/api/omb/bots'), 403);
  assert.equal(await check(handler, '/api/omb/bots', {method: 'POST'}), 403);
});

test('keeps sign-in routes reachable and denies native hosts and unmapped operations', async () => {
  const handler = projectPolicy({env, profiles: {current: () => null}});
  assert.equal(await check(handler, '/'), 303);
  assert.equal(await check(handler, '/api/ext/biz/profile/sign-in'), 204);
  assert.equal(await check(handler, '/api/ext/biz/profile/login', {method: 'POST'}), 204);
  assert.equal(await check(handler, '/extensions/biz/oauth/callback'), 204);
  assert.equal(await check(handler, '/assets/../config/team.yaml'), 403);
  assert.equal(await check(handler, '/api/agent/remote', {method: 'POST'}), 403);
  assert.equal(await check(handler, '/', {host: 'dagu.project.test'}), 403);
  assert.equal(await check(handler, '/api/omb/bots'), 403);
});

test('returns an unavailable decision without granting access', async () => {
  const handler = projectPolicy({
    env, profiles: {current: () => ({accessToken: 'person'})},
    access: {can: async () => { throw Error('unavailable'); }},
  });
  assert.equal(await check(handler, '/api/omb/bots'), 503);
});

test('separates workflow metadata, execution, outputs, and extension actions', async () => {
  const permissions = new Set([
    'app:panel', 'workflow:invoice:read', 'workflow:invoice:run',
    'page:extension:reports', 'action:extension:reports:get:status',
  ]);
  const handler = projectPolicy({
    env, profiles: {current: () => ({accessToken: 'person'})},
    access: {can: async (_token, capability) => permissions.has(capability)},
  });
  assert.equal(await check(handler, '/'), 204);
  assert.equal(await check(handler, '/config/project.json'), 204);
  assert.equal(await check(handler, '/config/team.yaml'), 403);
  assert.equal(await check(handler, '/api/dagu/dags/invoice'), 204);
  assert.equal(await check(handler, '/api/dagu/dags/invoice/enqueue', {method: 'POST'}), 204);
  assert.equal(await check(handler, '/api/dagu/dags/payroll/enqueue', {method: 'POST'}), 403);
  assert.equal(await check(handler, '/api/dagu/dags/invoice', {method: 'PATCH'}), 403);
  assert.equal(await check(handler, '/api/dagu/dag-runs/invoice/run_1/outputs'), 403);
  assert.equal(await check(handler, '/extensions/reports/panel/index.html'), 204);
  assert.equal(await check(handler, '/extensions/other/panel/index.html'), 403);
  assert.equal(await check(handler, '/api/ext/reports/status'), 204);
  assert.equal(await check(handler, '/api/ext/reports/status', {method: 'POST'}), 403);
  permissions.delete('app:panel');
  assert.equal(await check(handler, '/'), 403);
  assert.equal(await check(handler, '/api/dagu/dags/invoice'), 403);
});
