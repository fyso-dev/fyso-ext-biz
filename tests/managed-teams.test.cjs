const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), {execFileSync} = require('node:child_process');
const managed = require('../extensions/biz/managed-teams.cjs');
const sync = require('../extensions/biz/teams-sync.cjs');

const ORG = 'acme', PROJECT = '11111111-2222-3333-4444-555555555555';
const ENV = {FYSO_BIZ_ACCESS_ORGANIZATION: ORG, FYSO_BIZ_ACCESS_PROJECT: PROJECT};

// A git project whose team file holds one `department:digest` line per applied department.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-managed-'));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'project/bots'), {recursive: true});
  fs.writeFileSync(path.join(root, 'project/bots/team.yaml'), '');
  git('add', '.'); git('commit', '-qm', 'init');
  return {root, git, head: () => git('rev-parse', 'HEAD').trim()};
}
const teamFile = root => fs.readFileSync(path.join(root, 'project/bots/team.yaml'), 'utf8');
const lines = text => text.split('\n').filter(Boolean);

// The framework's template module (D82) over that team file.
function templates(root) {
  return {
    departments: () => lines(teamFile(root)).map(l => l.split(':')[0]),
    exportDepartment: async name => {
      const line = lines(teamFile(root)).find(l => l.split(':')[0] === name);
      if (!line) throw Error('unknown');
      return {package: {}, digest: line.split(':')[1]};
    },
    validate: pkg => { if (pkg.formato !== 'omb-team/1') throw Error('invalid_package'); },
    digest: pkg => pkg.firma,
    importPackage: async pkg => {
      const current = teamFile(root);
      const kept = lines(current).filter(l => l.split(':')[0] !== pkg.departamento);
      return {proposedTeamYaml: [...kept, `${pkg.departamento}:${pkg.firma}`].join('\n') + '\n', currentTeamYaml: current, commit: 'files'};
    },
  };
}

// The panel's plan/apply: refuses a stale base, writes the team file and commits it.
function panel(root, git, {failOn} = {}) {
  const calls = [];
  const actions = async (op, params) => {
    calls.push([op, params]);
    const base = Buffer.from(params.TEAM_BASE_B64, 'base64').toString('utf8');
    if (base !== teamFile(root)) throw Error('team declaration changed');
    if (op === 'plan') return {plan: [], created: 1, changed: 0, deleted: 0, removalRevision: ''};
    const proposed = Buffer.from(params.TEAM_B64, 'base64').toString('utf8');
    if (failOn && proposed.includes(failOn)) throw Error('omb failed');
    fs.writeFileSync(path.join(root, 'project/bots/team.yaml'), proposed);
    git('add', '--', 'project/bots/team.yaml');
    try { git('diff', '--cached', '--quiet'); } catch { git('commit', '-qm', 'bots: update from panel'); }
    return {created: 1, changed: 0, deleted: 0, commit: git('rev-parse', 'HEAD').trim()};
  };
  return {calls, actions};
}

// The framework helper: replaces the owner's record and commits only on a change.
function helper(root, git) {
  const calls = [];
  return {calls, record: ({root: r, owner, teamYaml, departments, bots}) => {
    calls.push({owner, teamYaml, departments, bots});
    const file = path.join(r, 'project/bots/managed.json');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    data[owner] = {departments, bots};
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    git('add', '--', 'project/bots/managed.json');
    try { git('diff', '--cached', '--quiet'); } catch { git('commit', '-qm', 'bots: managed'); }
  }};
}

// Fyso Biz: the project's assignment and its teams' packages.
function biz({organizacion = ORG, proyectos, departamentos, teams, tools = ['proyectos_framework', 'listar_equipos', 'exportar_equipo']}) {
  const calls = [];
  return {calls, teams,
    initialize: async () => {},
    tools: async () => tools.map(name => ({name})),
    call: async (name, args = {}) => {
      calls.push([name, args]);
      if (name === 'proyectos_framework') return {organizacion, proyectos: proyectos ?? [{proyecto_id: PROJECT, nombre: 'Ops', nivel: {id: 'n1', nombre: 'Base'},
        equipos: Object.entries(teams).map(([equipo_id, t]) => ({equipo_id, nombre: t.nombre}))}]};
      if (name === 'departamentos_framework') return {organizacion, departamentos: departamentos ?? [
        {departamento_id: 'd1', nombre: 'Ventas', rol: {id: 'lider'}, equipos: [{equipo_id: 'e1', nombre: 'Ventas'}, {equipo_id: 'e2', nombre: 'Soporte'}]},
        {departamento_id: 'd2', nombre: 'Soporte', rol: {id: 'miembro'}, equipos: [{equipo_id: 'e2', nombre: 'Soporte'}]}]};
      if (name === 'listar_equipos') return {equipos: Object.entries(teams).map(([id, t]) => ({id, nombre: t.nombre, version: t.version}))};
      if (name === 'exportar_equipo') {
        const t = teams[args.equipo_id];
        return {equipo: {id: args.equipo_id, nombre: t.nombre, version: t.version},
          paquete: {formato: 'omb-team/1', departamento: t.nombre, firma: `${t.nombre}-v${t.version}`, team: `bots:\n${t.bots.map(b => `  - name: ${b}\n`).join('')}`, skills: []}};
      }
      throw Error(`unexpected ${name}`);
    }};
}
const twoTeams = () => ({e1: {nombre: 'Ventas', version: 2, bots: ['Vendedor']}, e2: {nombre: 'Soporte', version: 5, bots: ['Agente', 'Triage']}});

function setup(opts = {}) {
  const p = project(), mcp = biz({teams: twoTeams(), ...opts}), ui = panel(p.root, p.git, opts), h = helper(p.root, p.git);
  const run = (extra = {}) => managed.deliver({mcp, root: p.root, env: ENV, tpl: templates(p.root), helper: h, actions: ui.actions, ...extra});
  return {...p, mcp, ui, h, run};
}

test('two teams: each is pulled, recorded as managed and applied in turn', async () => {
  const s = setup();
  const result = await s.run();
  assert.equal(result.managed, true);
  assert.deepEqual(result.project, {id: PROJECT, name: 'Ops', level: {id: 'n1', nombre: 'Base'}});
  assert.deepEqual(result.teams.map(t => [t.equipoId, t.department, t.version, t.applied]), [['e1', 'Ventas', 2, true], ['e2', 'Soporte', 5, true]]);
  assert.deepEqual(s.mcp.calls[0], ['proyectos_framework', {proyecto_id: PROJECT}]);
  // The helper got the cumulative set and the proposed team file of each apply.
  assert.deepEqual(s.h.calls.map(c => [c.owner, c.departments, c.bots]), [
    ['biz', ['Ventas'], ['Vendedor']],
    ['biz', ['Ventas', 'Soporte'], ['Vendedor', 'Agente', 'Triage']],
  ]);
  assert.equal(s.h.calls[1].teamYaml, 'Ventas:Ventas-v2\nSoporte:Soporte-v5\n');
  // Plan then apply per team, each on the team file the previous one left.
  assert.deepEqual(s.ui.calls.map(c => c[0]), ['plan', 'apply', 'plan', 'apply']);
  assert.equal(teamFile(s.root), 'Ventas:Ventas-v2\nSoporte:Soporte-v5\n');
  // Applied (no pull waiting) and flagged as managed, with everything committed.
  const state = sync.readState(s.root);
  assert.deepEqual(Object.entries(state.departments).map(([n, r]) => [n, r.equipoId, r.version, r.pending, r.managed]).sort(),
    [['Soporte', 'e2', 5, undefined, true], ['Ventas', 'e1', 2, undefined, true]]);
  assert.equal(s.git('status', '--porcelain').trim(), '');
  // The panel's status reads them as synchronized and managed.
  const rows = (await sync.status({mcp: s.mcp, root: s.root, tpl: templates(s.root)})).departments;
  assert.deepEqual(rows.map(r => [r.department, r.state, r.managed]).sort(), [['Soporte', 'synced', true], ['Ventas', 'synced', true]]);
});

test('running the hook again changes nothing; a new Biz version is delivered on the next run', async () => {
  const s = setup();
  await s.run();
  const head = s.head(), exports = s.mcp.calls.filter(c => c[0] === 'exportar_equipo').length;
  const again = await s.run();
  assert.deepEqual(again.teams.map(t => t.applied), [false, false]);
  assert.equal(s.mcp.calls.filter(c => c[0] === 'exportar_equipo').length, exports);
  assert.equal(s.ui.calls.length, 4);
  assert.equal(s.head(), head);
  assert.deepEqual(s.h.calls.at(-1).departments, ['Ventas', 'Soporte']);
  // Biz publishes a new version of one team: only that one comes down.
  s.mcp.teams.e2.version = 6;
  const next = await s.run();
  assert.deepEqual(next.teams.map(t => [t.equipoId, t.applied]), [['e1', false], ['e2', true]]);
  assert.equal(teamFile(s.root), 'Ventas:Ventas-v2\nSoporte:Soporte-v6\n');
  assert.deepEqual(s.h.calls.at(-1).bots, ['Vendedor', 'Agente', 'Triage']);
});

test('a failed apply is retried by the next run (the Mac app reruns the hook once)', async () => {
  const s = setup({failOn: 'Soporte'});
  await assert.rejects(s.run(), error => error.message === 'apply_failed' && error.department === 'Soporte');
  const retry = panel(s.root, s.git);
  const result = await s.run({actions: retry.actions});
  assert.deepEqual(result.teams.map(t => [t.equipoId, t.applied]), [['e1', false], ['e2', true]]);
  assert.equal(teamFile(s.root), 'Ventas:Ventas-v2\nSoporte:Soporte-v5\n');
  assert.equal(s.git('status', '--porcelain').trim(), '');
});

test('another organization: nothing is pulled, recorded or applied', async () => {
  const s = setup({organizacion: 'other'});
  await assert.rejects(s.run(), {message: 'organization_mismatch'});
  assert.deepEqual(s.mcp.calls.map(c => c[0]), ['proyectos_framework']);
  assert.equal(s.h.calls.length + s.ui.calls.length, 0);
});

test('a project Biz does not list for this connection: nothing is applied', async () => {
  const s = setup({proyectos: [{proyecto_id: 'another', nombre: 'X', nivel: null, equipos: [{equipo_id: 'e1', nombre: 'Ventas'}]}]});
  await assert.rejects(s.run(), {message: 'project_not_assigned'});
  assert.deepEqual(s.mcp.calls.map(c => c[0]), ['proyectos_framework']);
  assert.equal(s.h.calls.length + s.ui.calls.length, 0);
});

test('an older framework without managed-bots.cjs: refused before contacting Biz', async () => {
  const s = setup();
  await assert.rejects(s.run({helper: undefined}), {message: 'managed_bots_not_supported'});
  assert.equal(s.mcp.calls.length, 0);
  assert.equal(s.ui.calls.length, 0);
});

test('the framework helper is loaded from the project', async () => {
  const s = setup({teams: {e1: {nombre: 'Ventas', version: 1, bots: ['Vendedor']}}});
  const file = path.join(s.root, 'framework/scripts/managed-bots.cjs');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `exports.calls = []; exports.record = args => { exports.calls.push(args); };\n`);
  await s.run({helper: undefined});
  assert.deepEqual(require(file).calls.map(c => [c.owner, c.departments, c.bots]), [['biz', ['Ventas'], ['Vendedor']]]);
});

test('a Biz without proyectos_framework is reported as such', async () => {
  const s = setup({tools: ['listar_equipos', 'exportar_equipo']});
  await assert.rejects(s.run(), {message: 'managed_teams_not_supported'});
  assert.equal(s.ui.calls.length, 0);
});

test('without managed access the delivery does nothing', async () => {
  const s = setup();
  for (const env of [{}, {FYSO_BIZ_ACCESS_ORGANIZATION: '', FYSO_BIZ_ACCESS_PROJECT: ''}, {FYSO_BIZ_ACCESS_PROJECT: PROJECT}]) {
    assert.deepEqual(await s.run({env, helper: undefined}), {managed: false});
  }
  assert.equal(s.mcp.calls.length + s.ui.calls.length + s.h.calls.length, 0);
});

test('connect.sh runs the people sync and managed delivery only when managed access is configured', () => {
  const repo = path.resolve(__dirname, '..');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-connect-')), log = path.join(bin, 'log');
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$@" >> "${log}"\n`, {mode: 0o755});
  const run = env => {
    fs.rmSync(log, {force: true});
    execFileSync('bash', ['extensions/biz/connect.sh'], {cwd: repo, env: {PATH: `${bin}:${process.env.PATH}`, ...env}});
    return fs.readFileSync(log, 'utf8').trim().split('\n');
  };
  assert.deepEqual(run({}), ['extensions/biz/bot.cjs']);
  assert.deepEqual(run({FYSO_BIZ_ACCESS_ORGANIZATION: '', FYSO_BIZ_ACCESS_PROJECT: ''}), ['extensions/biz/bot.cjs']);
  assert.deepEqual(run(ENV), ['extensions/biz/bot.cjs', 'extensions/biz/people-sync.cjs', 'extensions/biz/managed-teams.cjs']);
  // The organization alone is enough: no project, so no people sync.
  assert.deepEqual(run({FYSO_BIZ_ACCESS_ORGANIZATION: ORG}), ['extensions/biz/bot.cjs', 'extensions/biz/managed-teams.cjs']);
  // A failed people sync does not stop the hook.
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$1" in *people-sync*) exit 1;; esac\n`, {mode: 0o755});
  assert.deepEqual(run(ENV), ['extensions/biz/bot.cjs', 'extensions/biz/people-sync.cjs', 'extensions/biz/managed-teams.cjs']);
});

test('without a project the teams come from the person\'s departments, each once', async () => {
  const s = setup({tools: ['departamentos_framework', 'proyectos_framework', 'listar_equipos', 'exportar_equipo']});
  const result = await s.run({env: {FYSO_BIZ_ACCESS_ORGANIZATION: ORG}});
  assert.equal(result.project, null);
  assert.deepEqual(result.departments, [{id: 'd1', name: 'Ventas'}, {id: 'd2', name: 'Soporte'}]);
  assert.deepEqual(result.teams.map(t => [t.equipoId, t.applied]), [['e1', true], ['e2', true]]);
  assert.deepEqual(s.mcp.calls[0], ['departamentos_framework', {}]);
  assert.ok(!s.mcp.calls.some(c => c[0] === 'proyectos_framework'));
});

test('a configured project keeps the legacy path even when Biz offers departments', async () => {
  const s = setup({tools: ['departamentos_framework', 'proyectos_framework', 'listar_equipos', 'exportar_equipo']});
  assert.equal((await s.run()).project.id, PROJECT);
  assert.deepEqual(s.mcp.calls[0], ['proyectos_framework', {proyecto_id: PROJECT}]);
  assert.ok(!s.mcp.calls.some(c => c[0] === 'departamentos_framework'));
  await assert.rejects(setup({organizacion: 'other'}).run(), {message: 'organization_mismatch'});
  await assert.rejects(setup({proyectos: []}).run(), {message: 'project_not_assigned'});
});

test('without a project a Biz lacking departamentos_framework is unsupported', async () => {
  await assert.rejects(setup().run({env: {FYSO_BIZ_ACCESS_ORGANIZATION: ORG}}), {message: 'managed_teams_not_supported'});
});

test('departments of another organization are refused', async () => {
  const s = setup({organizacion: 'other', tools: ['departamentos_framework', 'listar_equipos', 'exportar_equipo']});
  await assert.rejects(s.run({env: {FYSO_BIZ_ACCESS_ORGANIZATION: ORG}}), {message: 'organization_mismatch'});
  assert.equal(s.ui.calls.length, 0);
});

test('by department, a grant Biz asks to reauthorize skips the sync without touching anything', async () => {
  const s = setup({tools: ['departamentos_framework', 'listar_equipos', 'exportar_equipo']});
  const env = {FYSO_BIZ_ACCESS_ORGANIZATION: ORG};
  await s.run({env});
  const before = {head: s.head(), teams: teamFile(s.root), state: JSON.stringify(sync.readState(s.root)), calls: s.mcp.calls.length, helper: s.h.calls.length, ui: s.ui.calls.length};
  const access = {report: async token => { assert.equal(token, 'grant'); return {capabilities: [], admin: false, departments: [], policy: null, reauthorizeRequired: true}; }};
  const result = await s.run({env, access, credential: 'grant'});
  assert.deepEqual(result, {managed: true, skipped: 'reauthorize_required', project: null, departments: [], teams: []});
  assert.equal(s.head(), before.head);
  assert.equal(teamFile(s.root), before.teams);
  assert.equal(JSON.stringify(sync.readState(s.root)), before.state);
  assert.equal(s.mcp.calls.length, before.calls);
  assert.equal(s.h.calls.length, before.helper);
  assert.equal(s.ui.calls.length, before.ui);
});

test('by department, an access report that does not ask to reauthorize (or cannot be read) does not block the sync', async () => {
  const env = {FYSO_BIZ_ACCESS_ORGANIZATION: ORG};
  const tools = ['departamentos_framework', 'listar_equipos', 'exportar_equipo'];
  for (const access of [
    {report: async () => ({capabilities: ['app:panel'], admin: false, departments: [], policy: null, reauthorizeRequired: false})},
    {report: async () => { throw Error('biz_access_unavailable'); }},
  ]) {
    const s = setup({tools});
    const result = await s.run({env, access, credential: 'grant'});
    assert.equal(result.managed, true);
    assert.equal(result.skipped, undefined);
    assert.deepEqual(result.teams.map(t => t.equipoId), ['e1', 'e2']);
  }
});

test('the legacy project path never asks for the access report', async () => {
  const s = setup();
  const access = {report: async () => assert.fail('legacy path')};
  assert.equal((await s.run({access, credential: 'grant'})).managed, true);
});
