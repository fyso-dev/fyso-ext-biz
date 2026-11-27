// Deliver the system Fyso Biz configured for this project (Biz-managed access). The
// connection hook runs it when the install names a Biz organization
// (`biz_access_organization`; `biz_access_project` is the optional legacy scope). Biz lists the
// teams of the person's departments (`departamentos_framework`), or, when `biz_access_project` is
// set, the project's teams (`proyectos_framework`, legacy); each team comes down through the normal department pull
// (teams-sync.cjs), its bots are recorded as managed by Biz through the framework's
// `managed-bots.cjs`, and the proposed team file is applied through the panel's own
// plan/apply (`panel-actions.sh`). Teams go one at a time so each apply is reviewed
// against the team file the previous one left. A team already at Biz's version is
// skipped, so running the hook again changes nothing.
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
const sync = require('./teams-sync.cjs');

const OWNER = 'biz';
const ERRORS = ['managed_bots_not_supported', 'managed_teams_not_supported', 'organization_mismatch', 'project_not_assigned',
  'unexpected_response', 'apply_failed'];

/** Managed access is configured when the organization is set; the project is the optional legacy scope. */
function configured(env = process.env) {
  return Boolean(env.FYSO_BIZ_ACCESS_ORGANIZATION);
}

/** The framework's managed-bots helper, or a clear error on an older framework. */
function managedBots(root) {
  const file = path.join(root, 'framework/scripts/managed-bots.cjs');
  if (!fs.existsSync(file)) throw Error('managed_bots_not_supported');
  return require(file);
}

/** The panel's own plan/apply (framework panel-actions.sh); stdout's last line is its JSON. */
function panelActions(root, env = process.env) {
  return (op, params) => {
    const out = execFileSync('framework/scripts/panel-actions.sh', [op], {cwd: root, encoding: 'utf8',
      env: {...env, FYSO_ROOT: env.FYSO_ROOT || root, ...params}, stdio: ['ignore', 'pipe', 'inherit'], timeout: 300000});
    return JSON.parse(out.trim().split('\n').at(-1));
  };
}

const teamList = teams => {
  if (!Array.isArray(teams)) return [];
  if (teams.some(t => !t?.equipo_id)) throw Error('unexpected_response');
  return teams.map(t => ({equipoId: String(t.equipo_id), name: t.nombre ?? null}));
};

/**
 * The teams of the person's departments (`departamentos_framework`), checked against this
 * install's organization. The departments replace the project: a team shared by two departments
 * is delivered once.
 */
async function departmentTeams(mcp, env) {
  const result = await mcp.call('departamentos_framework', {});
  if (!result || !Array.isArray(result.departamentos)) throw Error('unexpected_response');
  if (result.organizacion !== env.FYSO_BIZ_ACCESS_ORGANIZATION) throw Error('organization_mismatch');
  const seen = new Map();
  const departments = result.departamentos.map(d => {
    for (const team of teamList(d?.equipos)) if (!seen.has(team.equipoId)) seen.set(team.equipoId, team);
    return {id: String(d?.departamento_id ?? ''), name: d?.nombre ?? null};
  });
  return {project: null, departments, teams: [...seen.values()]};
}

/** The project's teams as Biz assigned them (legacy path), checked against this install's answers. */
async function assignedTeams(mcp, env) {
  const organization = env.FYSO_BIZ_ACCESS_ORGANIZATION, project = env.FYSO_BIZ_ACCESS_PROJECT;
  if (!project) throw Error('project_not_assigned');
  const result = await mcp.call('proyectos_framework', {proyecto_id: project});
  if (!result || !Array.isArray(result.proyectos)) throw Error('unexpected_response');
  if (result.organizacion !== organization) throw Error('organization_mismatch');
  const found = result.proyectos.find(p => String(p?.proyecto_id) === project);
  if (!found) throw Error('project_not_assigned');
  return {project: {id: project, name: found.nombre ?? null, level: found.nivel ?? null}, departments: [], teams: teamList(found.equipos)};
}

const recordById = (state, equipoId) => Object.entries(state.departments).find(([, r]) => r?.equipoId === equipoId);

async function localDigest(tpl, root, department) {
  try { return (await tpl.exportDepartment(department, {root})).digest; } catch { return null; }
}

/**
 * Deliver the project's teams. Returns `{managed: false}` when managed access is not
 * configured; otherwise the project and, per team, whether it was applied now.
 */
async function deliver({mcp, root, env = process.env, tpl, helper, actions, git, yaml}) {
  if (!configured(env)) return {managed: false};
  helper ??= managedBots(root);
  tpl ??= sync.templates(root);
  actions ??= panelActions(root, env);
  await mcp.initialize();
  const tools = await mcp.tools();
  // A configured project keeps the legacy path (same teams and errors as before); without one,
  // the person's departments are the source, so Biz must offer `departamentos_framework`.
  const legacy = Boolean(env.FYSO_BIZ_ACCESS_PROJECT);
  const byDepartment = !legacy;
  const offered = tools.some(t => t.name === (legacy ? 'proyectos_framework' : 'departamentos_framework'));
  if (!offered) throw Error('managed_teams_not_supported');
  const {project, departments: assigned, teams} = byDepartment ? await departmentTeams(mcp, env) : await assignedTeams(mcp, env);
  // Biz's current versions, to skip a team that is already applied.
  const versions = {};
  if (tools.some(t => t.name === 'listar_equipos')) {
    for (const e of (await mcp.call('listar_equipos')).equipos || []) versions[String(e.id)] = Number(e.version) || null;
  }
  // The owner's record is replaced on every call: it always carries every department so far.
  const departments = [], bots = [];
  const add = (department, names) => {
    if (!departments.includes(department)) departments.push(department);
    for (const name of names) if (!bots.includes(name)) bots.push(name);
  };
  const todo = [], results = [];
  const state = sync.readState(root);
  for (const team of teams) {
    const entry = recordById(state, team.equipoId), record = entry?.[1];
    const current = record && !record.pending && versions[team.equipoId] != null && versions[team.equipoId] === record.version
      && await localDigest(tpl, root, entry[0]) === record.digest;
    if (current) { add(entry[0], record.bots || []); results.push({equipoId: team.equipoId, department: entry[0], version: record.version, applied: false}); }
    else todo.push(team);
  }
  const teamFile = () => fs.readFileSync(path.join(root, 'project/bots/team.yaml'), 'utf8');
  for (const team of todo) {
    const pulled = await sync.pull({mcp, root, tpl, equipoId: team.equipoId, overwrite: true, git, yaml});
    add(pulled.department, (pulled.bots || []).map(b => b.name));
    const params = {TEAM_B64: pulled.teamB64, TEAM_BASE_B64: pulled.teamBaseB64};
    await helper.record({root, owner: OWNER, teamYaml: Buffer.from(pulled.teamB64, 'base64').toString('utf8'), departments: [...departments], bots: [...bots]});
    let applied;
    try {
      const plan = await actions('plan', params);
      applied = await actions('apply', {...params, REMOVAL_REVISION: plan?.removalRevision ?? ''});
    } catch (error) { throw Object.assign(Error('apply_failed'), {department: pulled.department, cause: error}); }
    if (typeof applied?.commit !== 'string') throw Object.assign(Error('apply_failed'), {department: pulled.department});
    await settle({root, tpl, equipoId: team.equipoId, git});
    results.push({equipoId: team.equipoId, department: pulled.department, version: pulled.version, applied: true});
  }
  if (!todo.length) await helper.record({root, owner: OWNER, teamYaml: teamFile(), departments: [...departments], bots: [...bots]});
  await markManaged({root, equipoIds: teams.map(t => t.equipoId), git});
  return {managed: true, project, departments: assigned, teams: results};
}

/** The pull is applied, as the panel's status() records it: the department matches the package. */
async function settle({root, tpl, equipoId, git}) {
  const state = sync.readState(root), entry = recordById(state, equipoId);
  if (!entry?.[1].pending || await localDigest(tpl, root, entry[0]) !== entry[1].digest) return null;
  delete entry[1].pending;
  return sync.saveState(root, state, `biz: applied department ${entry[0]}`, git);
}

/** Flag the departments Biz manages for this project (the panel reads it); unflag the rest. */
async function markManaged({root, equipoIds, git}) {
  const state = sync.readState(root);
  let changed = false;
  for (const record of Object.values(state.departments)) {
    const managed = equipoIds.includes(record?.equipoId);
    if (managed && !record.managed) { record.managed = true; changed = true; }
    if (!managed && record?.managed) { delete record.managed; changed = true; }
  }
  return changed ? sync.saveState(root, state, 'biz: record the departments Biz manages', git) : null;
}

module.exports = {OWNER, ERRORS, configured, deliver, managedBots, panelActions};

if (require.main === module) (async () => {
  if (!configured()) return;
  const biz = require('./biz.cjs');
  const credential = await biz.token();
  const mcp = biz.client(process.env.FYSO_BIZ_URL || '', credential.token, fetch, {oauth: credential.oauth});
  console.log(JSON.stringify(await deliver({mcp, root: process.cwd()})));
})().catch(error => {
  const code = ERRORS.includes(error.message) || sync.ERRORS.includes(error.message) ? error.message : 'connection_failed';
  console.error(`Fyso Biz: managed teams failed: ${code}${error.department ? ` (${error.department})` : ''}`);
  process.exitCode = 1;
});
