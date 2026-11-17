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
// Fyso Biz: teams with versions and packages; publishing checks the base version, and a
// proposal waits for a person (`decide`) who accepts it (publishing it) or rejects it.
function biz(teams = {}) {
  const calls = [], proposals = [];
  const publish = (args) => {
    const t = teams[args.equipo_id];
    if (args.version_base !== t.version) throw Error(`version_conflict: current ${t.version}`);
    t.version += 1; t.paquete = args.paquete; t.nombre = args.paquete.departamento; return t.version;
  };
  return {calls, teams, proposals,
    decide(id, decision, motivo = null) {
      const p = proposals.find(x => x.id === id);
      if (decision === 'aceptar') { p.version_resultante = publish({equipo_id: p.equipo_id, version_base: p.version_base, paquete: p.paquete}); p.estado = 'aceptada'; }
      else { p.estado = 'rechazada'; p.motivo = motivo; }
    },
    initialize: async () => {},
    tools: async () => ['listar_equipos', 'exportar_equipo', 'publicar_equipo', 'proponer_cambio_equipo', 'listar_propuestas_equipo'].map(name => ({name})),
    call: async (name, args = {}) => {
      calls.push([name, args]);
      if (name === 'listar_equipos') return {equipos: Object.entries(teams).map(([id, t]) => ({id, version: t.version, ...(t.nombre && {nombre: t.nombre})}))};
      if (name === 'proponer_cambio_equipo') {
        const t = teams[args.equipo_id];
        if (args.version_base !== t.version) throw Error(`version_conflict: current ${t.version}`);
        const p = {id: `p${proposals.length + 1}`, equipo_id: args.equipo_id, version_base: args.version_base, paquete: args.paquete, estado: 'pendiente', creado_en: '2026-11-16T00:00:00Z'};
        proposals.push(p); return {propuesta: {...p, paquete: undefined}};
      }
      if (name === 'listar_propuestas_equipo') return {propuestas: proposals.filter(p => p.equipo_id === args.equipo_id).map(p => ({...p, paquete: undefined}))};
      if (name === 'exportar_equipo') { const t = teams[args.equipo_id]; return {equipo: {id: args.equipo_id, version: t.version}, paquete: t.paquete}; }
      if (name === 'publicar_equipo') {
        if (!args.equipo_id) { const id = `e${Object.keys(teams).length + 1}`; teams[id] = {version: 1, paquete: args.paquete, nombre: args.paquete.departamento}; return {equipo: {id, version: 1}, creado: true}; }
        return {equipo: {id: args.equipo_id, version: publish(args)}, creado: false};
      }
      throw Error(`unexpected ${name}`);
    }};
}

test('the decision table: nothing, pull, propose, conflict, a pull waiting for apply and the proposal states', () => {
  const record = {version: 2, digest: 'a'};
  assert.equal(sync.decide({local: 'a', remote: 2, record}), 'synced');
  assert.equal(sync.decide({local: 'a', remote: 3, record}), 'pull');
  assert.equal(sync.decide({local: 'b', remote: 2, record}), 'propose');
  assert.equal(sync.decide({local: 'b', remote: 2, record: {...record, proposal: {digest: 'b', state: 'pending'}}}), 'proposed');
  assert.equal(sync.decide({local: 'b', remote: 2, record: {...record, proposal: {digest: 'b', state: 'rejected'}}}), 'rejected');
  // Changed again after proposing: a new proposal.
  assert.equal(sync.decide({local: 'c', remote: 2, record: {...record, proposal: {digest: 'b', state: 'pending'}}}), 'propose');
  // Accepted: Biz's new version is the local change, so it is a pull, not a conflict.
  assert.equal(sync.decide({local: 'b', remote: 3, record: {...record, proposal: {digest: 'b', state: 'accepted', version: 3}}}), 'pull');
  assert.equal(sync.decide({local: 'b', remote: 3, record}), 'conflict');
  assert.equal(sync.decide({local: 'a', remote: null, record}), 'synced');
  assert.equal(sync.decide({local: 'x', remote: 2, record: {...record, pending: true}}), 'pending_apply');
  assert.equal(sync.decide({local: 'a', remote: null, record: null}), 'unpublished');
});

test('publishing creates the Biz team once; after that a local change is only proposed', async () => {
  const {root, git} = project(), mcp = biz(), local = {Ventas: 'd1'};
  const first = await sync.publish({mcp, root, tpl: templates(local), department: 'Ventas', departmentId: 'dep'});
  assert.deepEqual([first.equipoId, first.version], ['e1', 1]);
  assert.equal(mcp.calls.at(-1)[1].departamento_id, 'dep');
  assert.deepEqual(sync.readState(root).departments.Ventas, {equipoId: 'e1', version: 1, digest: 'd1', bots: []});
  assert.match(git('log', '-1', '--format=%s'), /publish department Ventas v1/);
  local.Ventas = 'd2';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'propose');
  // Never written back directly.
  await assert.rejects(sync.publish({mcp, root, tpl: templates(local), department: 'Ventas'}), {message: 'linked_to_biz'});
  assert.equal(mcp.teams.e1.version, 1);
  assert.equal(git('status', '--porcelain'), '');
});

test('a proposal waits for Biz; accepted it comes down as the new version, rejected it is reported', async () => {
  const {root, git} = project(), mcp = biz(), local = {Ventas: 'd1'};
  await sync.publish({mcp, root, tpl: templates(local), department: 'Ventas'});
  local.Ventas = 'd2';
  const sent = await sync.propose({mcp, root, tpl: templates(local), department: 'Ventas', message: 'Precios'});
  assert.deepEqual(mcp.calls.at(-1), ['proponer_cambio_equipo', {equipo_id: 'e1', version_base: 1, paquete: {formato: 'omb-team/1', departamento: 'Ventas', team: 'team d2', skills: []}, mensaje: 'Precios'}]);
  assert.deepEqual(sent.proposal, {id: 'p1', digest: 'd2', base: 1, state: 'pending', sentAt: '2026-11-16T00:00:00Z'});
  assert.match(git('log', '-1', '--format=%s'), /propose a change to department Ventas on v1/);
  assert.equal(mcp.teams.e1.version, 1);
  let row = (await sync.status({mcp, root, tpl: templates(local)})).departments[0];
  assert.deepEqual([row.state, row.proposal.state], ['proposed', 'pending']);

  // Accepted on Biz: the next refresh records it and offers the new version as a pull.
  mcp.decide('p1', 'aceptar');
  mcp.teams.e1.paquete = {formato: 'omb-team/1', departamento: 'Ventas', team: 'team d2', skills: []};
  row = (await sync.status({mcp, root, tpl: templates(local)})).departments[0];
  assert.deepEqual([row.state, row.remoteVersion, row.proposal.state, row.proposal.version], ['pull', 2, 'accepted', 2]);
  assert.match(git('log', '-1', '--format=%s'), /record the Biz decision/);
  const pulled = await sync.pull({mcp, root, tpl: templates(local), equipoId: 'e1'});
  assert.equal(pulled.version, 2);
  assert.equal(sync.readState(root).departments.Ventas.proposal, undefined);
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'synced');

  // Another change, rejected on Biz: reported with its reason; Biz stays the same.
  local.Ventas = 'd3';
  await sync.propose({mcp, root, tpl: templates(local), department: 'Ventas'});
  mcp.decide('p2', 'rechazar', 'No cambiamos precios');
  row = (await sync.status({mcp, root, tpl: templates(local)})).departments[0];
  assert.deepEqual([row.state, row.proposal.state, row.proposal.reason], ['rejected', 'rejected', 'No cambiamos precios']);
  assert.equal(mcp.teams.e1.version, 2);
  assert.equal(git('status', '--porcelain'), '');
});

test('a proposal on a stale version is refused; the person may propose on the current one', async () => {
  const {root} = project(), mcp = biz(), local = {Ventas: 'd1'};
  await sync.publish({mcp, root, tpl: templates(local), department: 'Ventas'});
  mcp.teams.e1.version = 2;
  local.Ventas = 'mine';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'conflict');
  await assert.rejects(sync.propose({mcp, root, tpl: templates(local), department: 'Ventas'}), {message: 'version_conflict'});
  const sent = await sync.propose({mcp, root, tpl: templates(local), department: 'Ventas', overwrite: true});
  assert.equal(sent.proposal.base, 2);
});

test('Biz always wins on the name: a record follows the Biz name without a new version, a local rename is a proposal', async () => {
  const {root, git} = project();
  const yaml = require('../extensions/biz/team.cjs').yamlModule();
  const writeTeam = name => { fs.mkdirSync(path.join(root, 'project/bots'), {recursive: true});
    fs.writeFileSync(path.join(root, 'project/bots/team.yaml'), `# equipo\nteams:\n  - name: ${name}\n    brief: hola\nbots:\n  - name: vendedor\n    team: ${name}\nrooms:\n  - name: sala\n    team: ${name}\n`); };
  writeTeam('Ventas'); git('add', '.'); git('commit', '-qm', 'team');
  const mcp = biz(), local = {Ventas: 'd1'};
  const tpl = () => ({...templates(local), departments: () => Object.keys(local)});
  await sync.publish({mcp, root, tpl: tpl(), department: 'Ventas', yaml});
  assert.deepEqual(sync.readState(root).departments.Ventas.bots, []);
  // Bots are learned from the team file on the next sync.
  await sync.status({mcp, root, tpl: tpl(), yaml});
  assert.deepEqual(sync.readState(root).departments.Ventas.bots, ['vendedor']);

  // Renamed on Biz, same version: the record takes the Biz name at once.
  mcp.teams.e1.nombre = 'Comercial';
  let rows = (await sync.status({mcp, root, tpl: tpl(), yaml})).departments;
  assert.deepEqual(Object.keys(sync.readState(root).departments), ['Comercial']);
  assert.match(git('log', '-1', '--format=%s'), /department Ventas -> Comercial \(Biz name\)/);
  // The local department still has the old name: it is shown under the Biz name, renamed locally.
  assert.deepEqual(rows.map(d => [d.department, d.localName, d.state]), [['Comercial', 'Ventas', 'renamed']]);
  const restored = sync.restoreName({root, tpl: tpl(), equipoId: 'e1', yaml});
  const proposed = Buffer.from(restored.teamB64, 'base64').toString();
  assert.match(proposed, /^# equipo/);
  assert.deepEqual(yaml.parse(proposed), {teams: [{name: 'Comercial', brief: 'hola'}], bots: [{name: 'vendedor', team: 'Comercial'}], rooms: [{name: 'sala', team: 'Comercial'}]});

  // A local rename is never kept as is: it is proposed, and Biz still names the department.
  delete local.Ventas; local.Gerencia = 'g1'; writeTeam('Gerencia');
  rows = (await sync.status({mcp, root, tpl: tpl(), yaml})).departments;
  assert.deepEqual(rows.map(d => [d.department, d.localName, d.state]), [['Comercial', 'Gerencia', 'renamed']]);
  const sent = await sync.propose({mcp, root, tpl: tpl(), department: 'Gerencia', equipoId: 'e1'});
  assert.equal(mcp.calls.at(-1)[1].paquete.departamento, 'Gerencia');
  assert.equal(sent.department, 'Comercial');
  rows = (await sync.status({mcp, root, tpl: tpl(), yaml})).departments;
  assert.deepEqual(rows.map(d => [d.department, d.localName, d.state]), [['Comercial', 'Gerencia', 'proposed']]);
  assert.equal(Buffer.from(sync.restoreName({root, tpl: tpl(), equipoId: 'e1', yaml}).teamB64, 'base64').toString().includes('name: Comercial'), true);
  // Accepted: Biz is now Gerencia, and the record follows it.
  mcp.decide('p1', 'aceptar');
  rows = (await sync.status({mcp, root, tpl: tpl(), yaml})).departments;
  assert.deepEqual(rows.map(d => [d.department, d.localName, d.state]), [['Gerencia', null, 'pull']]);
});

test('both sides changed: status reports a conflict, proposing and pulling stop until the person chooses', async () => {
  const {root} = project(), mcp = biz(), local = {Ventas: 'd1'};
  await sync.publish({mcp, root, tpl: templates(local), department: 'Ventas'});
  mcp.teams.e1.version = 2; mcp.teams.e1.paquete = {formato: 'omb-team/1', departamento: 'Ventas', team: 'team r2', skills: []};
  local.Ventas = 'mine';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'conflict');
  await assert.rejects(sync.propose({mcp, root, tpl: templates(local), department: 'Ventas'}), {message: 'version_conflict'});
  await assert.rejects(sync.pull({mcp, root, tpl: templates(local), equipoId: 'e1'}), {message: 'conflict'});
  assert.equal(mcp.teams.e1.version, 2);
});

test('pulling writes the package for review, waits for apply, then settles as synced', async () => {
  const {root} = project();
  const mcp = biz({e7: {version: 4, paquete: {formato: 'omb-team/1', departamento: 'Marketing', team: 'team m4', skills: []}}});
  const local = {};
  const yaml = {parse: () => ({bots: [{name: 'Estratega', title: 'Planifica'}, {name: 'Redactor'}]})};
  const pulled = await sync.pull({mcp, root, tpl: templates(local), equipoId: 'e7', yaml});
  // The panel's download preview needs the agents and skills (Teams.tsx).
  assert.deepEqual(pulled.bots, [{name: 'Estratega', title: 'Planifica'}, {name: 'Redactor', title: ''}]);
  assert.deepEqual(pulled.skills, []);
  assert.deepEqual(pulled.team, {id: 'e7', version: 4});
  assert.deepEqual(sync.preview({team: '', skills: [{path: 'skills/estratega/calendario/SKILL.md'}, {path: 'skills/redactor/calendario/SKILL.md'}]}, yaml).skills, ['calendario']);
  assert.equal(Buffer.from(pulled.teamB64, 'base64').toString(), 'proposed Marketing');
  assert.deepEqual(sync.readState(root).departments.Marketing, {equipoId: 'e7', version: 4, digest: 'm4', pending: true, bots: ['Estratega', 'Redactor']});
  local.Marketing = 'old';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments.find(d => d.department === 'Marketing').state, 'pending_apply');
  local.Marketing = 'm4';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments.find(d => d.department === 'Marketing').state, 'synced');
  assert.deepEqual(sync.readState(root).departments.Marketing, {equipoId: 'e7', version: 4, digest: 'm4', bots: ['Estratega', 'Redactor']});
  // A later local change reads as a change to propose, not as a pull waiting for apply.
  local.Marketing = 'm5';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments.find(d => d.department === 'Marketing').state, 'propose');
});

test('a Biz team without a package and an older framework fail with clear codes', async () => {
  const {root} = project();
  await assert.rejects(sync.pull({mcp: biz({e1: {version: 1}}), root, tpl: templates({}), equipoId: 'e1'}), {message: 'no_package'});
  assert.throws(() => sync.templates(root), {message: 'templates_not_supported'});
});

// A department downloaded from Biz before packages existed (team.cjs, fyso-equipo/v1).
function legacy(root, git, {id = 'e9', version = 1, slug = 'equipo-comercial-local', department = 'Equipo comercial'} = {}) {
  const dir = path.join(root, 'project/bots/biz', slug);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify({formato: 'fyso-equipo/v1', equipo: {id, slug, nombre: `${department} (Biz)`, version}}));
  fs.writeFileSync(path.join(dir, 'brief.md'), 'brief\n');
  fs.mkdirSync(path.join(root, 'project/bots'), {recursive: true});
  fs.writeFileSync(path.join(root, 'project/bots/team.yaml'),
    `version: 1\nteams:\n  - name: ${department}\n    brief: { file: \${FYSO_ROOT}/project/bots/biz/${slug}/brief.md }\n  - name: Otro\n    brief: hola\nbots: []\n`);
  git('add', '.'); git('commit', '-qm', 'legacy import');
}

test('a department downloaded before packages keeps its Biz team: linked, listed, never published as a second team', async () => {
  const {root, git} = project();
  legacy(root, git);
  const mcp = biz({e9: {version: 1}}), local = {'Equipo comercial': 'c1', Otro: 'o1'};
  // Both screens see the same Biz team id.
  assert.deepEqual(sync.links(root), {e9: {department: 'Equipo comercial', version: 1}});
  const rows = (await sync.status({mcp, root, tpl: templates(local)})).departments;
  assert.deepEqual(rows.find(d => d.department === 'Equipo comercial'), {department: 'Equipo comercial', localName: null, equipoId: 'e9', version: 1, remoteVersion: 1, state: 'synced', proposal: null});
  assert.equal(rows.find(d => d.department === 'Otro').state, 'unpublished');
  assert.deepEqual(sync.readState(root).departments['Equipo comercial'], {equipoId: 'e9', version: 1, digest: 'c1', legacy: true});
  assert.match(git('log', '-1', '--format=%s'), /link department Equipo comercial to its Biz team/);
  // A local change is proposed to the same Biz team.
  local['Equipo comercial'] = 'c2';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments.find(d => d.department === 'Equipo comercial').state, 'propose');
  await assert.rejects(sync.publish({mcp, root, tpl: templates(local), department: 'Equipo comercial'}), {message: 'linked_to_biz'});
  const proposed = await sync.propose({mcp, root, tpl: templates(local), department: 'Equipo comercial'});
  assert.deepEqual([proposed.equipoId, proposed.proposal.base], ['e9', 1]);
  assert.deepEqual(Object.keys(mcp.teams), ['e9']);
  assert.equal(mcp.calls.filter(([name, args]) => name === 'publicar_equipo' && !args.equipo_id).length, 0);
  assert.equal(git('status', '--porcelain'), '');
});

test('proposing a never-checked older download goes to its Biz team too', async () => {
  const {root, git} = project();
  legacy(root, git, {version: 3});
  const mcp = biz({e9: {version: 3}});
  const proposed = await sync.propose({mcp, root, tpl: templates({'Equipo comercial': 'c1'}), department: 'Equipo comercial'});
  assert.equal(proposed.equipoId, 'e9');
  assert.equal(mcp.calls.at(-1)[1].version_base, 3);
});

test('a newer older-style download waits for apply, then settles on the applied department', async () => {
  const {root, git} = project();
  legacy(root, git);
  const mcp = biz({e9: {version: 2}}), local = {'Equipo comercial': 'c1'};
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'pull');
  // team.cjs wrote version 2; the department has not been applied yet.
  legacy(root, git, {version: 2});
  await sync.legacyPulled({root, tpl: templates(local), equipoId: 'e9', version: 2});
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'pending_apply');
  local['Equipo comercial'] = 'c-applied';
  assert.equal((await sync.status({mcp, root, tpl: templates(local)})).departments[0].state, 'synced');
  assert.deepEqual(sync.readState(root).departments['Equipo comercial'], {equipoId: 'e9', version: 2, digest: 'c-applied', legacy: true});
  // Reviewing the same version again records nothing to wait for.
  assert.equal(await sync.legacyPulled({root, tpl: templates(local), equipoId: 'e9', version: 2}), null);
});

test('an older download named differently from its Biz team takes the Biz name once, not on every sync', async () => {
  const {root, git} = project();
  legacy(root, git);
  const mcp = biz({e9: {version: 1, nombre: 'Equipo comercial (Biz)'}}), local = {'Equipo comercial': 'c1'};
  await sync.status({mcp, root, tpl: templates(local)});
  assert.deepEqual(Object.keys(sync.readState(root).departments), ['Equipo comercial (Biz)']);
  const rows = (await sync.status({mcp, root, tpl: templates(local)})).departments;
  assert.deepEqual(rows.map(d => [d.department, d.localName, d.state]), [['Equipo comercial (Biz)', 'Equipo comercial', 'renamed']]);
  const restored = Buffer.from(sync.restoreName({root, tpl: templates(local), equipoId: 'e9'}).teamB64, 'base64').toString();
  assert.match(restored, /- name: Equipo comercial \(Biz\)/);
  const head = git('rev-parse', 'HEAD');
  await sync.status({mcp, root, tpl: templates(local)});
  await sync.status({mcp, root, tpl: templates(local)});
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(Object.keys(sync.readState(root).departments), ['Equipo comercial (Biz)']);
});

test('a department renamed by a later download keeps its Biz team record', async () => {
  const {root, git} = project();
  legacy(root, git);
  await sync.status({mcp: biz({e9: {version: 1}}), root, tpl: templates({'Equipo comercial': 'c1'})});
  legacy(root, git, {department: 'Comercial'});
  const rows = (await sync.status({mcp: biz({e9: {version: 1}}), root, tpl: templates({Comercial: 'c1'})})).departments;
  assert.deepEqual(rows.map(d => [d.department, d.equipoId, d.state]), [['Comercial', 'e9', 'synced']]);
});
