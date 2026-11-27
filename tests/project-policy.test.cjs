const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {projectPolicy} = require('../extensions/biz/project-policy.cjs');
const {expandCapabilities, inventoryOf} = require('../extensions/biz/department-capabilities.cjs');

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
    access: {capabilities: async token => {
      calls.push(token);
      assert.equal(token, 'person');
      return [...permissions];
    }},
  });
  assert.equal(await check(handler, '/api/omb/bots'), 204);
  assert.deepEqual(calls, ['person']);
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

test('the publish preview is a profile-session route: POST only, nothing else is opened', async () => {
  const handler = projectPolicy({env, profiles: {current: () => null}});
  assert.equal(await check(handler, '/api/ext/biz/profile/setup/publish-preview', {method: 'POST'}), 204);
  assert.equal(await check(handler, '/api/ext/biz/profile/setup/publish-preview'), 403);
  assert.equal(await check(handler, '/api/ext/biz/profile/setup/publish-preview', {method: 'POST', host: 'dagu.project.test'}), 403);
  assert.equal(await check(handler, '/api/ext/biz/profile/setup/publish-previews', {method: 'POST'}), 403);
  // The Caddy snippet strips the profile cookie from every setup route, this one included.
  const caddy = fs.readFileSync(path.join(__dirname, '../extensions/biz/{{ \'authorize.caddy\' if biz_access_organization else \'\' }}.slotjinja'), 'utf8');
  assert.match(caddy, /\/api\/ext\/biz\/profile\/setup\/\*/);
});

test('returns an unavailable decision without granting access', async () => {
  const handler = projectPolicy({
    env, profiles: {current: () => ({accessToken: 'person'})},
    access: {capabilities: async () => { throw Error('unavailable'); }},
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
    access: {capabilities: async () => [...permissions]},
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

test('revokes the linked session before forwarding native web logout', async () => {
  const revocations = [];
  const handler = projectPolicy({env, profiles: {
    current: () => null,
    revoke: request => revocations.push(request.headers['remote-user']),
  }});
  assert.equal(await check(handler, '/api/session/logout'), 403);
  assert.equal(await check(handler, '/api/session/logout', {method: 'POST'}), 204);
  assert.deepEqual(revocations, ['ana']);
});

test('connector read, OAuth, probe and definition writes use different permissions', async () => {
  const permissions = new Set(['app:panel', 'action:connectors:read', 'action:connectors:test']);
  const handler = projectPolicy({
    env, profiles: {current: () => ({accessToken: 'person'})},
    access: {capabilities: async () => [...permissions]},
  });
  assert.equal(await check(handler, '/api/omb/connectors/catalog'), 204);
  assert.equal(await check(handler, '/api/omb/mcp/servers/demo/test', {method: 'POST'}), 204);
  assert.equal(await check(handler, '/api/omb/connectors/sheets/authorize', {method: 'POST'}), 403);
  assert.equal(await check(handler, '/api/connectors/mcp/demo', {method: 'DELETE'}), 403);
  permissions.add('action:connectors:manage');
  assert.equal(await check(handler, '/api/connectors/mcp/demo', {method: 'DELETE'}), 204);
  assert.equal(await check(handler, '/api/omb/mcp/servers/demo/test/633151c4-db73-4ee9-87bf-554d327e8091', {method: 'POST'}), 403);
});

test('human-requests: answering a task needs the workflow run permission, the wiki its own', async () => {
  const permissions = new Set(['app:panel', 'workflow:ext-human-requests-request:run', 'action:wiki:read']);
  const handler = projectPolicy({
    env, profiles: {current: () => ({accessToken: 'person'})},
    access: {capabilities: async () => [...permissions]},
  });
  const runPath = '/api/dagu/dag-runs/ext-human-requests-request/run_1/human-tasks';
  assert.equal(await check(handler, `${runPath}/ask/complete`, {method: 'POST'}), 204);
  assert.equal(await check(handler, `${runPath}/ask/push-back`, {method: 'POST'}), 204);
  assert.equal(await check(handler, `${runPath}/resume`, {method: 'POST'}), 204);
  assert.equal(await check(handler, `${runPath}/ask/complete`), 403);
  assert.equal(await check(handler, `${runPath}/ask/delete`, {method: 'POST'}), 403);
  assert.equal(await check(handler, '/api/dagu/dag-runs/other/run_1/human-tasks/ask/complete', {method: 'POST'}), 403);

  assert.equal(await check(handler, '/api/dagu/wiki'), 204);
  assert.equal(await check(handler, '/api/dagu/wiki/page'), 204);
  assert.equal(await check(handler, '/api/dagu/wiki', {method: 'POST'}), 403);
  assert.equal(await check(handler, '/api/dagu/wiki/page', {method: 'PATCH'}), 403);
  permissions.add('action:wiki:write');
  assert.equal(await check(handler, '/api/dagu/wiki', {method: 'POST'}), 204);
  assert.equal(await check(handler, '/api/dagu/wiki/page', {method: 'DELETE'}), 204);
  assert.equal(await check(handler, '/api/dagu/wiki/other'), 403);
});

test('works with the organization alone and narrows connector management by the framework policy', async () => {
  const organizationOnly = {FYSO_WEB_DOMAIN: 'project.test', FYSO_BIZ_ACCESS_ORGANIZATION: 'acme'};
  let report = {capabilities: ['app:panel', 'action:connectors:manage'], admin: false, departments: [], policy: null};
  const handler = projectPolicy({env: organizationOnly, profiles: {current: () => ({accessToken: 'person'})},
    access: {report: async () => report}});
  const add = () => check(handler, '/api/connectors/mcp', {method: 'POST'});
  // A Biz that sends no policy: the action capability decides, as before.
  assert.equal(await add(), 204);
  // With a policy, the framework capability is required too.
  report = {...report, policy: {preset: 'cuidado'}};
  assert.equal(await add(), 403);
  report = {...report, capabilities: [...report.capabilities, 'framework:mcp_servers:catalog']};
  assert.equal(await add(), 204);
  // Unconfigured stays open.
  assert.equal(await check(projectPolicy({env: {FYSO_WEB_DOMAIN: 'project.test'}, profiles: {}}), '/'), 204);
});

// Other hosts of the project (omb., dagu., docs., biz.): the profile cookie is host-only on the panel,
// so the session comes from the gateway's Remote-User.
function projectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-hosts-'));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), text); };
  write('framework/apps/omb.yaml', 'id: omb\nname: Chat\n');
  write('framework/apps/dagu.yaml', 'id: dagu\nname: Automations\n');
  write('extensions/silverbullet/app.yaml', 'id: silverbullet\nurl: http://docs.${FYSO_WEB_DOMAIN}:${FYSO_HTTP_PORT}\n');
  write('extensions/hub/app.yaml', 'id: hub\nurl: "https://portal.example.com/"\n');
  write('extensions/biz/app.yaml', 'id: biz\nurl: /#/extensions/biz/overview\n');
  write('project/apps/crm/app.yaml', 'id: crm\nurl: "http://crm.${FYSO_WEB_DOMAIN}"\n');
  write('project/apps/sneaky/app.yaml', 'id: sneaky\nurl: http://omb.${FYSO_WEB_DOMAIN}\n');
  write('.copier-answers.ext-silverbullet.yml', '_commit: x\n');
  return root;
}

function hostPolicy({report, session = {accessToken: 'person'}, users = []} = {}) {
  const lookups = [];
  const handler = projectPolicy({
    env: {...env, FYSO_HTTP_PORT: '8080'}, root: projectRoot(),
    profiles: {current: () => { throw Error('the cookie session is for the panel'); },
      forUser: user => { lookups.push(user); return session; }},
    access: {report: async () => (typeof report === 'function' ? report() : report)},
  });
  return {handler, lookups};
}

const departmentReport = levels => expandCapabilities({
  capabilities: ['app:panel'], admin: levels === 'admin',
  departments: levels === 'admin' ? [] : [{id: 'd', name: 'D', role: {id: 'r', name: 'R', levels}, teams: []}],
  policy: null,
}, {inventory: inventoryOf(projectRoot())});

test('omb. and dagu.: an admin is allowed, a member without the app capability is not', async () => {
  const admin = hostPolicy({report: departmentReport('admin')});
  assert.equal(await check(admin.handler, '/', {host: 'omb.project.test'}), 204);
  assert.equal(await check(admin.handler, '/api/chat', {host: 'omb.project.test', method: 'POST'}), 204);
  assert.equal(await check(admin.handler, '/', {host: 'dagu.project.test'}), 204);
  assert.deepEqual(admin.lookups.slice(0, 1), ['ana']);

  const member = hostPolicy({report: departmentReport({objetivos: 0, agentes: 1, fuentes: 0})});
  assert.equal(await check(member.handler, '/', {host: 'omb.project.test'}), 403);
  assert.equal(await check(member.handler, '/', {host: 'dagu.project.test'}), 403);
});

test('app hosts need app:panel as well as the app capability, and wildcard grants count', async () => {
  const noPanel = hostPolicy({report: {capabilities: ['app:omb'], admin: false, departments: [], policy: null}});
  assert.equal(await check(noPanel.handler, '/', {host: 'omb.project.test'}), 403);
  const wildcard = hostPolicy({report: {capabilities: ['app:panel', 'app:*'], admin: false, departments: [], policy: null}});
  assert.equal(await check(wildcard.handler, '/', {host: 'omb.project.test'}), 204);
  assert.equal(await check(wildcard.handler, '/', {host: 'docs.project.test'}), 204);
});

test('app hosts without a live profile session: 403, and a sign-in redirect to the panel for /', async () => {
  const none = hostPolicy({session: null, report: departmentReport('admin')});
  assert.equal(await check(none.handler, '/api/x', {host: 'omb.project.test'}), 403);
  assert.equal(await check(none.handler, '/', {host: 'omb.project.test', method: 'POST'}), 403);
  assert.equal(await check(none.handler, '/', {host: 'omb.project.test'}), 303);
  const redirects = [];
  const handler = projectPolicy({env: {...env, FYSO_HTTP_PORT: '8080'}, root: projectRoot(), profiles: {forUser: () => null}});
  await handler({headers: {'remote-user': 'ana', 'x-fyso-policy-host': 'omb.project.test', 'x-fyso-policy-path': '/', 'x-forwarded-method': 'GET'}},
    {writeHead: (status, headers) => { redirects.push([status, headers.Location]); return {end() {}}; }});
  assert.deepEqual(redirects, [[303, 'http://panel.project.test:8080/api/ext/biz/profile/sign-in']]);
});

test('a frozen project allows reads on app hosts and refuses writes', async () => {
  const frozen = hostPolicy({report: {capabilities: [], frozen: true, admin: false, departments: [], policy: null}});
  assert.equal(await check(frozen.handler, '/', {host: 'omb.project.test'}), 204);
  assert.equal(await check(frozen.handler, '/api/chat', {host: 'omb.project.test', method: 'POST'}), 403);
  assert.equal(await check(frozen.handler, '/login', {host: 'biz.project.test'}), 403);
});

test('extension and project apps map their url host to app:<id>', async () => {
  const admin = hostPolicy({report: {capabilities: ['app:panel', 'app:silverbullet'], admin: false, departments: [], policy: null}});
  assert.equal(await check(admin.handler, '/page', {host: 'docs.project.test'}), 204);
  assert.equal(await check(admin.handler, '/', {host: 'crm.project.test'}), 403);
  assert.equal(await check(admin.handler, '/', {host: 'portal.project.test'}), 403);
  const crm = hostPolicy({report: {capabilities: ['app:panel', 'app:crm'], admin: false, departments: [], policy: null}});
  assert.equal(await check(crm.handler, '/', {host: 'crm.project.test'}), 204);
  assert.equal(await check(crm.handler, '/', {host: 'docs.project.test'}), 403);
  // An app file cannot take over a framework host.
  const sneaky = hostPolicy({report: {capabilities: ['app:panel', 'app:sneaky'], admin: false, departments: [], policy: null}});
  assert.equal(await check(sneaky.handler, '/', {host: 'omb.project.test'}), 403);
  // Members get the extension and project apps at agentes 1 (derived), not the framework ones.
  const member = hostPolicy({report: departmentReport({objetivos: 0, agentes: 1, fuentes: 0})});
  assert.equal(await check(member.handler, '/', {host: 'docs.project.test'}), 204);
});

test('biz. serves only the agent login routes, behind the Biz page', async () => {
  const person = hostPolicy({report: {capabilities: ['app:panel', 'page:extension:biz'], admin: false, departments: [], policy: null}});
  assert.equal(await check(person.handler, '/login', {host: 'biz.project.test'}), 204);
  assert.equal(await check(person.handler, '/callback', {host: 'biz.project.test'}), 204);
  assert.equal(await check(person.handler, '/login', {host: 'biz.project.test', method: 'POST'}), 403);
  assert.equal(await check(person.handler, '/health', {host: 'biz.project.test'}), 403);
  assert.equal(await check(person.handler, '/', {host: 'biz.project.test'}), 403);
  const without = hostPolicy({report: {capabilities: ['app:panel'], admin: false, departments: [], policy: null}});
  assert.equal(await check(without.handler, '/login', {host: 'biz.project.test'}), 403);
});

test('unknown hosts, foreign domains and unsafe paths are refused', async () => {
  const admin = hostPolicy({report: departmentReport('admin')});
  assert.equal(await check(admin.handler, '/', {host: 'nope.project.test'}), 403);
  assert.equal(await check(admin.handler, '/', {host: 'omb.evil.test'}), 403);
  assert.equal(await check(admin.handler, '/', {host: 'a.omb.project.test'}), 403);
  assert.equal(await check(admin.handler, '/', {host: 'project.test'}), 403);
  assert.equal(await check(admin.handler, '/', {host: 'auth.project.test'}), 403);
  assert.equal(await check(admin.handler, '/a/../b', {host: 'omb.project.test'}), 403);
  assert.equal(await check(admin.handler, '/a%2fb', {host: 'omb.project.test'}), 403);
  assert.equal(await check(admin.handler, '//x', {host: 'omb.project.test'}), 403);
  const unavailable = hostPolicy({report: () => { throw Error('down'); }});
  assert.equal(await check(unavailable.handler, '/', {host: 'omb.project.test'}), 503);
});

test('panel behavior is unchanged: it still uses the cookie session', async () => {
  const handler = projectPolicy({env, profiles: {current: () => ({accessToken: 'p'}), forUser: () => { throw Error('panel does not look up by user'); }},
    access: {capabilities: async () => ['app:panel', 'action:bots:list']}});
  assert.equal(await check(handler, '/api/omb/bots'), 204);
  assert.equal(await check(handler, '/api/omb/bots', {method: 'POST'}), 403);
});
