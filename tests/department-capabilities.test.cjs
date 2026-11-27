const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {matches, allows, expandCapabilities, inventoryOf, concrete} = require('../extensions/biz/department-capabilities.cjs');
const {projectAccess} = require('../extensions/biz/project-access.cjs');
const {projectPolicy} = require('../extensions/biz/project-policy.cjs');
const {profileSessions} = require('../extensions/biz/profile-session.cjs');

const inventory = {
  extensions: ['biz', 'hub'],
  apps: [{id: 'dagu', framework: true}, {id: 'omb', framework: true}, {id: 'hub', framework: false}],
  workflows: ['fyso-bot-architect', 'hello'],
};
const base = {capabilities: ['app:panel', 'app:mcp', 'framework:mcp_servers:catalog'], admin: false, departments: [],
  policy: null, reauthorizeRequired: false};
const member = levels => ({...base, departments: [{id: 'd', name: 'D', role: {id: 'r', name: 'R', custom: false, levels}, teams: []}]});
const expand = report => new Set(expandCapabilities(report, {inventory}).capabilities);

test('matcher: exact, one-segment wildcard and trailing wildcard', () => {
  assert.equal(matches('workflow:*:run', 'workflow:hello:run'), true);
  assert.equal(matches('workflow:*:run', 'workflow:hello:read'), false);
  assert.equal(matches('workflow:*:run', 'workflow:a:b:run'), false);
  assert.equal(matches('page:extension:*', 'page:extension:hub'), true);
  assert.equal(matches('action:extension:*', 'action:extension:hub:get:status'), true);
  assert.equal(matches('action:extension:*', 'action:extension'), false);
  assert.equal(matches('action:extension:*', 'action:bots:list'), false);
  assert.equal(matches('action:bots:list', 'action:bots:list'), true);
  assert.equal(matches('*', 'app:panel'), false);
  assert.equal(matches('app:*', 'app:panel'), true);
  assert.equal(allows(['workflow:*:run'], 'workflow:x:run'), true);
  assert.equal(allows(new Set(['action:bots:list']), 'action:bots:read-team'), false);
});

test('admin gets everything, plus Biz capabilities', () => {
  const caps = expand({...base, admin: true});
  for (const id of ['app:panel', 'app:mcp', 'framework:mcp_servers:catalog', 'action:bots:list', 'action:wiki:write',
    'action:connectors:configure', 'action:biz:create-work', 'action:biz:manage-mailboxes', 'action:feedback:submit',
    'workflow:*:run', 'workflow:hello:run', 'workflow:fyso-bot-architect:run', 'page:extension:*', 'page:extension:hub',
    'action:extension:hub:configure', 'app:dagu', 'app:omb', 'app:hub', 'page:panel:setup', 'page:panel:bots',
    'page:panel:observability', 'page:panel:connectors', 'page:panel:apps']) assert.ok(caps.has(id), id);
});

test('member levels per area: 0 none, 1 read, 2 operate', () => {
  const none = expand(member({objetivos: 0, agentes: 0, fuentes: 0}));
  assert.deepEqual([...none].sort(), [...base.capabilities, 'action:feedback:submit', 'page:extension:biz',
    'action:biz:disconnect-agent', 'page:panel:setup'].sort());

  const read = expand(member({objetivos: 1, agentes: 1, fuentes: 1}));
  for (const id of ['action:bots:list', 'workflow:*:read', 'workflow:*:read-outputs', 'action:wiki:read', 'page:extension:*',
    'page:extension:hub', 'page:panel:bots', 'app:hub', 'action:connectors:read', 'page:panel:connectors', 'action:biz:read-work']) assert.ok(read.has(id), id);
  for (const id of ['workflow:*:run', 'workflow:hello:run', 'action:wiki:write', 'action:extension:*', 'app:dagu', 'action:connectors:manage',
    'action:biz:create-work', 'action:biz:manage-mailboxes']) assert.ok(!read.has(id), id);

  const operate = expand(member({objetivos: 2, agentes: 2, fuentes: 2}));
  for (const id of ['workflow:*:run', 'workflow:hello:run', 'action:wiki:write', 'action:extension:*', 'action:extension:hub:configure',
    'app:dagu', 'action:connectors:manage', 'action:connectors:authorize', 'action:connectors:test', 'action:connectors:configure',
    'action:biz:create-work', 'action:biz:manage-mailboxes']) assert.ok(operate.has(id), id);

  const mixed = expand(member({objetivos: 0, agentes: 0, fuentes: 2}));
  assert.ok(mixed.has('action:connectors:manage') && !mixed.has('action:bots:list') && !mixed.has('action:biz:read-status'));
});

test('takes the highest level of each area across departments', () => {
  const report = member({agentes: 0});
  report.departments.push({id: 'e', name: 'E', role: {levels: {agentes: 2}}, teams: []});
  assert.ok(expand(report).has('workflow:*:run'));
});

test('frozen, reauthorize and no app:panel are not expanded', () => {
  for (const report of [{...base, admin: true, frozen: true}, {...base, admin: true, reauthorizeRequired: true},
    {...base, admin: true, capabilities: ['app:mcp']}]) {
    assert.equal(expandCapabilities(report, {inventory}), report);
  }
});

test('project mode keeps the report unchanged', async () => {
  const env = {FYSO_BIZ_URL: 'https://biz.example', FYSO_BIZ_ACCESS_ORGANIZATION: 'acme', FYSO_BIZ_ACCESS_PROJECT: 'p'};
  const access = projectAccess({env, transport: async () => Response.json({capabilities: ['app:panel'], admin: true})});
  assert.deepEqual(await access.capabilities('t'), ['app:panel']);
});

test('inventoryOf reads what is installed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dept-'));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), text); };
  write('.copier-answers.ext-hub.yml', '_commit: x\n');
  write('.copier-answers.ext-pack-software-production.yml', '_commit: x\n');
  write('framework/apps/dagu.yaml', 'id: dagu\nname: x\n');
  write('project/apps/mine/app.yaml', 'id: mine\n');
  write('extensions/hub/app.yaml', 'id: hub\nname: {es: Hub}\n');
  write('project/workflows/hello.yaml', 'name: hello\nsteps: []\n');
  write('project/workflows/ext-hub-x.yaml', 'steps: []\n');
  const found = inventoryOf(root);
  assert.deepEqual(found.extensions, ['hub', 'pack-software-production']);
  assert.deepEqual(found.apps, [{id: 'dagu', framework: true}, {id: 'mine', framework: false}, {id: 'hub', framework: false}]);
  assert.deepEqual(found.workflows, ['ext-hub-x', 'hello']);
  assert.deepEqual(inventoryOf(path.join(root, 'nope')), {extensions: [], apps: [], workflows: []});
});

// Integration: a department report from Biz through the real access client.
const deptEnv = {FYSO_BIZ_URL: 'https://biz.test', FYSO_WEB_DOMAIN: 'project.test', FYSO_WEB_SCHEME: 'https', FYSO_BIZ_ACCESS_ORGANIZATION: 'acme'};
function deptAccess(report) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dept-'));
  fs.writeFileSync(path.join(root, '.copier-answers.ext-hub.yml'), '_commit: x\n');
  fs.mkdirSync(path.join(root, 'project/workflows'), {recursive: true});
  fs.writeFileSync(path.join(root, 'project/workflows/hello.yaml'), 'name: hello\n');
  return projectAccess({env: deptEnv, root, transport: async () => Response.json(report)});
}
const bizReport = (extra = {}) => ({capabilities: ['app:panel', 'app:mcp'], admin: false, departments: [], ...extra});
const dept = levels => [{id: 'd', name: 'D', role: {id: 'r', name: 'R', custom: false, levels}, teams: []}];
const check = (handler, path, method = 'GET') => handler({headers: {'remote-user': 'ana', 'x-fyso-policy-host': 'panel.project.test',
  'x-fyso-policy-path': path, 'x-forwarded-method': method}}, {writeHead: status => ({end: () => status})});
const policyFor = report => projectPolicy({env: deptEnv, profiles: {current: () => ({accessToken: 'person'})}, access: deptAccess(report)});

test('policy: an admin department report may list bots', async () => {
  const handler = policyFor(bizReport({admin: true}));
  assert.equal(await check(handler, '/api/omb/bots'), 204);
  assert.equal(await check(handler, '/api/dagu/dags/anything/start', 'POST'), 204);
  assert.equal(await check(handler, '/api/ext/hub/anything', 'POST'), 204);
  assert.equal(await check(handler, '/api/ext/hub/status', 'GET'), 204);
});

test('policy: a member runs workflows only with agentes 2', async () => {
  const one = policyFor(bizReport({departments: dept({agentes: 1})}));
  assert.equal(await check(one, '/api/dagu/dags/x', 'GET'), 204);
  assert.equal(await check(one, '/api/dagu/dags/x/start', 'POST'), 403);
  assert.equal(await check(one, '/api/omb/bots'), 204);
  assert.equal(await check(one, '/api/omb/connectors/catalog'), 403);
  const two = policyFor(bizReport({departments: dept({agentes: 2})}));
  assert.equal(await check(two, '/api/dagu/dags/x/start', 'POST'), 204);
  const none = policyFor(bizReport({departments: dept({agentes: 0})}));
  assert.equal(await check(none, '/api/omb/bots'), 403);
});

test('/profile/access lists the expanded concrete capabilities, no wildcards', async () => {
  const access = deptAccess(bizReport({departments: dept({agentes: 2, fuentes: 1})}));
  access.identity = async () => ({subject: 'person-1'});
  const profiles = profileSessions({env: deptEnv, access, auth: {
    beginProfile: async () => ({state: 's', url: 'https://biz.test/oauth/authorize?state=s'}),
    finishProfile: async () => ({accessToken: 'person', expiresAt: Date.now() + 3_600_000}),
    profileLogout() {},
  }});
  const call = async (url, method, cookie) => {
    const out = {};
    await profiles.handle({url, method, headers: {'remote-user': 'ana', cookie}}, {
      writeHead(status, headers) { Object.assign(out, {status, headers}); return this; }, end(body) { out.body = body; }});
    return out;
  };
  const login = await call('/profile/login', 'POST');
  const binding = login.headers['Set-Cookie'].split(';')[0];
  const done = await call('/profile/callback?state=s&code=c', 'GET', binding);
  const cookie = done.headers['Set-Cookie'][1].split(';')[0];
  const listed = JSON.parse((await call('/profile/access', 'GET', cookie)).body).capabilities;
  for (const id of ['app:panel', 'app:mcp', 'workflow:hello:run', 'page:extension:hub', 'action:extension:hub:configure',
    'page:panel:connectors', 'page:panel:bots', 'action:connectors:read', 'action:feedback:submit']) assert.ok(listed.includes(id), id);
  assert.ok(!listed.includes('action:connectors:manage'));
  assert.ok(!listed.some(capability => capability.includes('*')));
});
