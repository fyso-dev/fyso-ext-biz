const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), {execFileSync} = require('node:child_process');
const sync = require('../extensions/biz/teams-sync.cjs');

// A git project with nothing but the files these tests touch.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-sync-'));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'project'));
  fs.writeFileSync(path.join(root, 'README'), 'x'); git('add', '.'); git('commit', '-qm', 'init');
  return {root, git};
}
// The framework's template module (D82), with each department's current package digest.
function templates(local) {
  return {
    departments: () => Object.keys(local),
    exportDepartment: async name => {
      if (!(name in local)) throw Error('unknown');
      return {package: {formato: 'omb-team/1', departamento: name, team: `team ${local[name]}`, skills: []}, digest: local[name]};
    },
    validate: pkg => { if (pkg.formato !== 'omb-team/1') throw Error('invalid_package'); },
    digest: pkg => pkg.team.replace('team ', ''),
    importPackage: async (pkg, {root}) => ({proposedTeamYaml: `proposed ${pkg.departamento}`, currentTeamYaml: 'current', commit: 'abc', slug: 'x'}),
  };
}
// Fyso Biz: teams with versions and packages; publishing checks the base version.
function biz(teams = {}) {
  const calls = [];
  return {calls, teams,
    initialize: async () => {},
    tools: async () => [{name: 'listar_equipos'}, {name: 'exportar_equipo'}, {name: 'publicar_equipo'}],
    call: async (name, args = {}) => {
      calls.push([name, args]);
      if (name === 'listar_equipos') return {equipos: Object.entries(teams).map(([id, t]) => ({id, version: t.version}))};
      if (name === 'exportar_equipo') { const t = teams[args.equipo_id]; return {equipo: {id: args.equipo_id, version: t.version}, paquete: t.paquete}; }
      if (name === 'publicar_equipo') {
        if (!args.equipo_id) { const id = `e${Object.keys(teams).length + 1}`; teams[id] = {version: 1, paquete: args.paquete}; return {equipo: {id, version: 1}, creado: true}; }
        const t = teams[args.equipo_id];
        if (args.version_base !== t.version) throw Error(`version_conflict: current ${t.version}`);
        t.version += 1; t.paquete = args.paquete; return {equipo: {id: args.equipo_id, version: t.version}, creado: false};
      }
      throw Error(`unexpected ${name}`);
    }};
}

test('the decision table: nothing, pull, publish, conflict, and a pull waiting for apply', () => {
  const record = {version: 2, digest: 'a'};
  assert.equal(sync.decide({local: 'a', remote: 2, record}), 'synced');
  assert.equal(sync.decide({local: 'a', remote: 3, record}), 'pull');
  assert.equal(sync.decide({local: 'b', remote: 2, record}), 'publish');
  assert.equal(sync.decide({local: 'b', remote: 3, record}), 'conflict');
  assert.equal(sync.decide({local: 'a', remote: null, record}), 'synced');
  assert.equal(sync.decide({local: 'x', remote: 2, record: {...record, pending: true}}), 'pending_apply');
  assert.equal(sync.decide({local: 'a', remote: null, record: null}), 'unpublished');
});

test('publishing creates the Biz team once, then publishes versions based on the recorded one', async () => {
  const {root, git} = project(), mcp = biz(), local = {Ventas: 'd1'};
  const first = await sync.publish({mcp, root, tpl: templates(local), department: 'Ventas', departmentId: 'dep'});
  assert.deepEqual([first.equipoId, first.version], ['e1', 1]);
  assert.equal(mcp.calls.at(-1)[1].departamento_id, 'dep');
  assert.deepEqual(sync.readState(root).departments.Ventas, {equipoId: 'e1', version: 1, digest: 'd1'});
  assert.match(git('log', '-1', '--format=%s'), /publish department Ventas v1/);
  local.Ventas = 'd2';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'publish');
  const second = await sync.publish({mcp, root, tpl: templates(local), department: 'Ventas'});
  assert.equal(second.version, 2); assert.equal(mcp.calls.at(-1)[1].version_base, 1);
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'synced');
  assert.equal(git('status', '--porcelain'), '');
});

test('both sides changed: status reports a conflict, publish and pull stop until the person chooses', async () => {
  const {root} = project(), mcp = biz(), local = {Ventas: 'd1'};
  await sync.publish({mcp, root, tpl: templates(local), department: 'Ventas'});
  mcp.teams.e1.version = 2; mcp.teams.e1.paquete = {formato: 'omb-team/1', departamento: 'Ventas', team: 'team r2', skills: []};
  local.Ventas = 'mine';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'conflict');
  await assert.rejects(sync.publish({mcp, root, tpl: templates(local), department: 'Ventas'}), {message: 'version_conflict'});
  await assert.rejects(sync.pull({mcp, root, tpl: templates(local), equipoId: 'e1'}), {message: 'conflict'});
  // "Publish mine" bases the new version on Biz's current one.
  const kept = await sync.publish({mcp, root, tpl: templates(local), department: 'Ventas', overwrite: true});
  assert.equal(kept.version, 3);
});

test('pulling writes the package for review, waits for apply, then settles as synced', async () => {
  const {root} = project();
  const mcp = biz({e7: {version: 4, paquete: {formato: 'omb-team/1', departamento: 'Marketing', team: 'team m4', skills: []}}});
  const local = {};
  const pulled = await sync.pull({mcp, root, tpl: templates(local), equipoId: 'e7'});
  assert.equal(Buffer.from(pulled.teamB64, 'base64').toString(), 'proposed Marketing');
  assert.deepEqual(sync.readState(root).departments.Marketing, {equipoId: 'e7', version: 4, digest: 'm4', pending: true});
  local.Marketing = 'old';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments.find(d => d.department === 'Marketing').state, 'pending_apply');
  local.Marketing = 'm4';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments.find(d => d.department === 'Marketing').state, 'synced');
  assert.deepEqual(sync.readState(root).departments.Marketing, {equipoId: 'e7', version: 4, digest: 'm4'});
  // A later local change reads as a change to publish, not as a pull waiting for apply.
  local.Marketing = 'm5';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments.find(d => d.department === 'Marketing').state, 'publish');
});

test('a Biz team without a package and an older framework fail with clear codes', async () => {
  const {root} = project();
  await assert.rejects(sync.pull({mcp: biz({e1: {version: 1}}), root, tpl: templates({}), equipoId: 'e1'}), {message: 'no_package'});
  assert.throws(() => sync.templates(root), {message: 'templates_not_supported'});
});
