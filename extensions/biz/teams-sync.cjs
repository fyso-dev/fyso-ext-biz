// Publish this project's departments to Fyso Biz and keep them in sync (framework D82,
// docs/team-templates.md). A department travels as the framework's native OpenMausBot
// package (`omb-team/1`); this file only decides what to do and records what was synced:
// `project/biz-teams.json` holds, per department, the Biz team, its version and the
// package digest at the last publish or pull. Both sides changed: stop and let the
// person choose. Nothing here merges concurrent edits.
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');

const STATE = 'project/biz-teams.json';
const ERRORS = ['templates_not_supported', 'publish_not_supported', 'unknown_department', 'not_published',
  'version_conflict', 'conflict', 'no_package', 'pending_apply', 'uncommitted_changes'];

/** The framework's department-template module (D82), or a clear error on an older framework. */
function templates(root) {
  const file = path.join(root, 'framework/scripts/team-template.cjs');
  if (!fs.existsSync(file)) throw Error('templates_not_supported');
  return require(file);
}

function readState(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, STATE), 'utf8'));
    return data && typeof data.departments === 'object' && data.departments ? data : {departments: {}};
  } catch { return {departments: {}}; }
}

/** Write the state and commit only that file, never other work. */
function saveState(root, state, message, git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'})) {
  const sorted = Object.fromEntries(Object.entries(state.departments).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(root, STATE), JSON.stringify({departments: sorted}, null, 2) + '\n');
  git('add', '--', STATE);
  try { git('diff', '--cached', '--quiet', '--', STATE); return null; }
  catch { git('commit', '-q', '-m', message, '--', STATE); return git('rev-parse', 'HEAD').trim(); }
}

const key = name => String(name || '').trim().toLowerCase();
const recordOf = (state, department) => Object.entries(state.departments).find(([name]) => key(name) === key(department));

/**
 * What synchronizing a department would do. `local` is the digest of its package now
 * (null when it does not exist locally), `remote` the Biz team's current version (null
 * when unknown), `record` what was synced last.
 */
function decide({local, remote, record}) {
  if (!record) return local ? 'unpublished' : 'absent';
  // A pull is written but not applied yet: the local department still shows the old content.
  if (record.pending && local !== record.digest) return 'pending_apply';
  const localChanged = local !== null && local !== record.digest;
  const remoteChanged = remote !== null && remote !== record.version;
  if (localChanged && remoteChanged) return 'conflict';
  if (remoteChanged) return 'pull';
  if (localChanged) return 'publish';
  return 'synced';
}

/** Local departments (from the project's team file) and recorded ones, with their sync state. */
async function status({mcp, root, tpl = templates(root), departments}) {
  const state = readState(root);
  await mcp.initialize();
  const tools = await mcp.tools();
  const remote = {};
  if (tools.some(t => t.name === 'listar_equipos')) {
    for (const e of (await mcp.call('listar_equipos')).equipos || []) remote[String(e.id)] = Number(e.version) || null;
  }
  const names = [...new Set([...(departments || tpl.departments(root)), ...Object.keys(state.departments)].map(n => String(n).trim()).filter(Boolean))];
  const rows = [];
  for (const name of names) {
    const entry = recordOf(state, name), record = entry?.[1];
    let local = null;
    try { local = (await tpl.exportDepartment(name, {root})).digest; } catch { local = null; }
    const remoteVersion = record ? remote[record.equipoId] ?? null : null;
    const action = decide({local, remote: remoteVersion, record});
    // Settle a finished pull: the applied department now matches the package.
    if (record?.pending && action !== 'pending_apply') delete record.pending;
    rows.push({department: entry?.[0] ?? name, equipoId: record?.equipoId ?? null, version: record?.version ?? null,
      remoteVersion, state: action});
  }
  return {publishSupported: tools.some(t => t.name === 'publicar_equipo'), departments: rows};
}

/**
 * Publish a department: create its Biz team the first time, else a new version based on
 * the recorded one. `overwrite` (after a conflict, the person's choice) bases it on Biz's
 * current version instead.
 */
async function publish({mcp, root, tpl = templates(root), department, departmentId, overwrite = false, git}) {
  await mcp.initialize();
  if (!(await mcp.tools()).some(t => t.name === 'publicar_equipo')) throw Error('publish_not_supported');
  const exported = await tpl.exportDepartment(department, {root}).catch(() => { throw Error('unknown_department'); });
  const state = readState(root), entry = recordOf(state, department), record = entry?.[1];
  const args = {paquete: exported.package};
  if (record) {
    let base = record.version;
    if (overwrite) {
      const current = ((await mcp.call('listar_equipos')).equipos || []).find(e => String(e.id) === record.equipoId);
      base = Number(current?.version) || base;
    }
    Object.assign(args, {equipo_id: record.equipoId, version_base: base});
  } else if (departmentId) args.departamento_id = departmentId;
  let result;
  try { result = await mcp.call('publicar_equipo', args); }
  catch (error) {
    const detail = `${error.detail || ''} ${error.message}`;
    const code = ['version_conflict', 'departamento_requerido'].find(c => detail.includes(c));
    throw code ? Error(code) : error;
  }
  const name = entry?.[0] ?? department;
  state.departments[name] = {equipoId: String(result.id), version: Number(result.version), digest: exported.digest};
  const commit = saveState(root, state, `biz: publish department ${name} v${result.version}`, git);
  return {department: name, equipoId: String(result.id), version: Number(result.version), commit};
}

/**
 * Pull a Biz team's package: write its files, commit them, and return the proposed team
 * file for the panel's review (the person applies it). Pulling over local changes needs
 * the person's explicit choice (`overwrite`).
 */
async function pull({mcp, root, tpl = templates(root), equipoId, overwrite = false, git}) {
  await mcp.initialize();
  const exported = await mcp.call('exportar_equipo', {equipo_id: equipoId});
  const pkg = exported?.paquete;
  if (!pkg) throw Error('no_package');
  tpl.validate(pkg);
  const state = readState(root), entry = recordOf(state, pkg.departamento), record = entry?.[1];
  if (record && !overwrite) {
    let local = null;
    try { local = (await tpl.exportDepartment(pkg.departamento, {root})).digest; } catch { local = null; }
    if (local !== null && local !== record.digest) throw Error('conflict');
  }
  const imported = await tpl.importPackage(pkg, {root, source: {kind: 'biz', equipoId, version: Number(exported.equipo?.version)}});
  const name = entry?.[0] ?? pkg.departamento;
  state.departments[name] = {equipoId: String(equipoId), version: Number(exported.equipo?.version), digest: tpl.digest(pkg), pending: true};
  const commit = saveState(root, state, `biz: pull department ${name} v${exported.equipo?.version}`, git);
  return {department: name, version: Number(exported.equipo?.version), commit, files: imported.commit,
    teamB64: Buffer.from(imported.proposedTeamYaml).toString('base64'), teamBaseB64: Buffer.from(imported.currentTeamYaml).toString('base64')};
}

module.exports = {STATE, ERRORS, decide, readState, saveState, status, publish, pull, templates};
