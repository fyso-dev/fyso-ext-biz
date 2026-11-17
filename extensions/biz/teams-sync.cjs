// Keep this project's departments in sync with Fyso Biz (framework D82,
// docs/team-templates.md, docs/proposals.md). Biz is the source of truth: its teams flow
// down one way. A department with no Biz team yet is published once (that creates the
// team); after that a local change is never written back: it is sent as a change
// proposal (`proponer_cambio_equipo`) and a person decides on Biz. An accepted proposal is
// a new Biz version that comes down through the normal pull; a rejected one is reported.
// The Biz team's name always wins over the local department name.
// A department travels as the framework's native OpenMausBot package (`omb-team/1`);
// `project/biz-teams.json` holds, per department (keyed by the Biz team's name), the Biz
// team, its version, the package digest at the last sync, its bots and the last proposal.
// Nothing here merges concurrent edits.
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');

const STATE = 'project/biz-teams.json';
const ERRORS = ['templates_not_supported', 'publish_not_supported', 'unknown_department', 'not_published',
  'version_conflict', 'conflict', 'no_package', 'pending_apply', 'uncommitted_changes', 'unexpected_response',
  'proposals_not_supported', 'linked_to_biz', 'not_renamed'];

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

/** Refuse to absorb a person's staged or unstaged state file. */
function ensureClean(root, git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'})) {
  if (git('status', '--porcelain', '--', STATE).trim()) throw Error('uncommitted_changes');
}

/** Write the state and commit only that file, never other work. */
function saveState(root, state, message, git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'})) {
  ensureClean(root, git);
  const sorted = Object.fromEntries(Object.entries(state.departments).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(root, STATE), JSON.stringify({departments: sorted}, null, 2) + '\n');
  git('add', '--', STATE);
  try { git('diff', '--cached', '--quiet', '--', STATE); return null; }
  catch { git('commit', '-q', '-m', message, '--', STATE); return git('rev-parse', 'HEAD').trim(); }
}

const key = name => String(name || '').trim().toLowerCase();
const recordOf = (state, department) => Object.entries(state.departments).find(([name]) => key(name) === key(department));
const recordById = (state, equipoId) => Object.entries(state.departments).find(([, r]) => r?.equipoId === String(equipoId));

// The Biz team id is the one identity of a synchronized department. A team downloaded
// before packages existed (fyso-equipo/v1, team.cjs) records it in
// `project/bots/biz/<slug>/source.json`; its department is the `teams:` entry whose brief
// lives in that directory, so it follows the Biz team's name on every download.
const LEGACY = 'project/bots/biz';
function legacyLinks(root, yaml) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, LEGACY)); } catch { return []; }
  let teams = [];
  try {
    yaml ??= require('./team.cjs').yamlModule();
    const file = yaml.parse(fs.readFileSync(path.join(root, 'project/bots/team.yaml'), 'utf8').replaceAll('${FYSO_ROOT}', '__ROOT__'));
    teams = Array.isArray(file?.teams) ? file.teams : [];
  } catch { return []; }
  const links = [];
  for (const entry of entries) {
    try {
      const source = JSON.parse(fs.readFileSync(path.join(root, LEGACY, entry, 'source.json'), 'utf8'));
      const brief = `__ROOT__/${LEGACY}/${entry}/brief.md`;
      const team = teams.find(t => t?.brief?.file === brief);
      if (source?.equipo?.id && team?.name) links.push({department: String(team.name), equipoId: String(source.equipo.id), version: Number(source.equipo.version) || 0});
    } catch { /* not an import */ }
  }
  return links;
}

/**
 * Every Biz team this project holds, by Biz team id: `{department, version}` from the sync
 * state, and from older downloads the state does not record yet.
 */
function links(root, yaml) {
  const state = readState(root), found = {};
  for (const link of legacyLinks(root, yaml)) found[link.equipoId] = {department: link.department, version: link.version};
  for (const [department, record] of Object.entries(state.departments)) {
    if (record?.equipoId) found[record.equipoId] = {department, version: Number(record.version) || null};
  }
  return found;
}

/**
 * Record older downloads in the sync state under their Biz team id (adopt), and follow a
 * department renamed by a later download. An adopted record has no digest yet (`null`):
 * the caller sets it to the department's current one, so it starts as synchronized.
 */
function adoptLegacy(root, state, yaml, bizNames = {}) {
  const changed = [];
  for (const link of legacyLinks(root, yaml)) {
    const byId = recordById(state, link.equipoId);
    if (byId) {
      // A Biz team with a known name keeps it: the Biz name wins over the local one.
      if (!bizNames[link.equipoId] && byId[0] !== link.department && !recordOf(state, link.department)) {
        delete state.departments[byId[0]]; state.departments[link.department] = byId[1]; changed.push(link.department);
      }
      continue;
    }
    if (recordOf(state, link.department)) continue; // already synchronized with another Biz team
    state.departments[link.department] = {equipoId: link.equipoId, version: link.version, digest: null, legacy: true};
    changed.push(link.department);
  }
  return changed;
}

/** Bot name -> department, from the project's team file (a bot belongs to one department). */
function botDepartments(root, yaml) {
  const map = new Map();
  try {
    yaml ??= require('./team.cjs').yamlModule();
    const file = yaml.parse(fs.readFileSync(path.join(root, 'project/bots/team.yaml'), 'utf8').replaceAll('${FYSO_ROOT}', '__ROOT__')) || {};
    for (const bot of Array.isArray(file.bots) ? file.bots : []) if (bot?.name && bot?.team) map.set(String(bot.name), String(bot.team));
  } catch { /* no team file: nothing to match */ }
  return map;
}

/**
 * The local name of a Biz department renamed locally: the one department that holds its
 * recorded bots, when the Biz name itself is no longer a local department.
 */
function renamedTo(record, name, names, byBot) {
  if (names.some(n => key(n) === key(name)) || !Array.isArray(record?.bots)) return null;
  const found = [...new Set(record.bots.map(bot => byBot.get(bot)).filter(Boolean))];
  return found.length === 1 && key(found[0]) !== key(name) ? found[0] : null;
}

/**
 * Rename a department in the team file text: its `teams:` entry and the `team:` of its bots
 * and rooms. Comments and everything else are kept.
 */
function renameInTeamFile(text, from, to, yaml = require('./team.cjs').yamlModule()) {
  // `${FYSO_ROOT}` is not valid inside a YAML flow map: parse it as a marker and put it back.
  const MARKER = '__FYSO_ROOT_MARKER__';
  if (text.includes(MARKER)) throw Error('invalid_team_file');
  const doc = yaml.parseDocument(text.replaceAll('${FYSO_ROOT}', MARKER));
  if (doc.errors.length || !yaml.isMap(doc.contents)) throw Error('invalid_team_file');
  for (const [list, field] of [['teams', 'name'], ['bots', 'team'], ['rooms', 'team']]) {
    const seq = doc.get(list, true);
    if (!yaml.isSeq(seq)) continue;
    for (const node of seq.items) if (yaml.isMap(node) && key(node.get(field)) === key(from)) node.set(field, to);
  }
  return doc.toString().replaceAll(MARKER, '${FYSO_ROOT}');
}

/**
 * What synchronizing a department would do. `local` is the digest of its package now
 * (null when it does not exist locally), `remote` the Biz team's current version (null
 * when unknown), `record` what was synced last.
 */
function decide({local, remote, record}) {
  if (!record) return local ? 'unpublished' : 'absent';
  // A pull is written but not applied yet: the local department still shows the old content.
  // An older download (no package) waits until the department changes from `before`.
  if (record.pending && ('before' in record ? local === record.before : local !== record.digest)) return 'pending_apply';
  const localChanged = local !== null && local !== record.digest;
  const remoteChanged = remote !== null && remote !== record.version;
  const proposal = record.proposal;
  // The accepted proposal is the new Biz version: it comes down like any other.
  if (proposal?.state === 'accepted' && remote === proposal.version && local === proposal.digest) return 'pull';
  if (localChanged && remoteChanged) return 'conflict';
  if (remoteChanged) return 'pull';
  if (localChanged) {
    if (proposal?.digest === local && proposal.state === 'pending') return 'proposed';
    if (proposal?.digest === local && proposal.state === 'rejected') return 'rejected';
    return 'propose';
  }
  return 'synced';
}

const PROPOSAL_STATES = {pendiente: 'pending', aceptada: 'accepted', rechazada: 'rejected'};

/** Read the Biz decision on the pending proposals of these records; true when one changed. */
async function refreshProposals(mcp, records) {
  let changed = false;
  for (const record of records) {
    const proposal = record.proposal;
    if (proposal?.state !== 'pending') continue;
    let found;
    try { found = ((await mcp.call('listar_propuestas_equipo', {equipo_id: record.equipoId})).propuestas || []).find(p => String(p.id) === proposal.id); }
    catch { continue; } // read again on the next refresh
    const state = PROPOSAL_STATES[found?.estado];
    if (!state || state === 'pending') continue;
    Object.assign(proposal, {state, reason: found.motivo ?? null, decidedBy: found.decidida_por ?? null, decidedAt: found.decidida_en ?? null,
      ...(state === 'accepted' && {version: Number(found.version_resultante)})});
    changed = true;
  }
  return changed;
}

/** Local departments (from the project's team file) and recorded ones, with their sync state. */
async function status({mcp, root, tpl = templates(root), departments, git, yaml}) {
  const state = readState(root);
  await mcp.initialize();
  const tools = await mcp.tools();
  const remote = {}, remoteName = {};
  if (tools.some(t => t.name === 'listar_equipos')) {
    for (const e of (await mcp.call('listar_equipos')).equipos || []) {
      remote[String(e.id)] = Number(e.version) || null;
      if (typeof e.nombre === 'string' && e.nombre.trim()) remoteName[String(e.id)] = e.nombre.trim();
    }
  }
  const adopted = adoptLegacy(root, state, yaml, remoteName);
  // Biz always wins on the name: the record follows the Biz team's current name, with or
  // without a new version. A local rename is a local change like any other (a proposal).
  const renamed = [];
  for (const [name, record] of Object.entries(state.departments)) {
    const bizName = remoteName[record?.equipoId];
    if (!bizName || bizName === name) continue;
    const other = recordOf(state, bizName);
    if (other && other[0] !== name) continue; // another record holds that name: leave both as they are
    delete state.departments[name]; state.departments[bizName] = record; renamed.push(`${name} -> ${bizName}`);
  }
  const proposalsSupported = tools.some(t => t.name === 'proponer_cambio_equipo');
  const decided = tools.some(t => t.name === 'listar_propuestas_equipo') && await refreshProposals(mcp, Object.values(state.departments));
  const localNames = (departments || tpl.departments(root)).map(n => String(n).trim()).filter(Boolean);
  const byBot = botDepartments(root, yaml);
  // A department renamed locally is shown under its Biz name, never as a new one.
  const hidden = new Set();
  const localNameOf = {};
  // An older download is found by its files (source.json) as well as by its bots.
  const legacyName = Object.fromEntries(legacyLinks(root, yaml).map(link => [link.equipoId, link.department]));
  for (const [name, record] of Object.entries(state.departments)) {
    const old = legacyName[record?.equipoId];
    const to = renamedTo(record, name, localNames, byBot)
      || (old && key(old) !== key(name) && !localNames.some(n => key(n) === key(name)) && localNames.some(n => key(n) === key(old)) ? old : null);
    if (to) { localNameOf[name] = to; hidden.add(key(to)); }
  }
  const names = [...new Set([...localNames.filter(n => !hidden.has(key(n)) || recordOf(state, n)), ...Object.keys(state.departments)])];
  const rows = [], settled = [];
  for (const name of names) {
    const entry = recordOf(state, name), record = entry?.[1];
    const localName = entry ? localNameOf[entry[0]] ?? null : null;
    let local = null;
    try { local = (await tpl.exportDepartment(localName ?? name, {root})).digest; } catch { local = null; }
    if (record && record.digest === null) record.digest = local;
    // An older download (no package) is applied once the department changed: that is its new base.
    if (record?.pending && 'before' in record && local !== record.before) { record.digest = local; delete record.before; }
    // Remember the department's bots: they find it again after a local rename.
    if (record && !localName && local !== null && !record.bots?.length) {
      const bots = [...byBot].filter(([, team]) => key(team) === key(name)).map(([bot]) => bot).sort();
      if (bots.length) { record.bots = bots; settled.push(entry[0]); }
    }
    const remoteVersion = record ? remote[record.equipoId] ?? null : null;
    let action = decide({local, remote: remoteVersion, record});
    if (localName && (action === 'propose' || action === 'synced')) action = 'renamed';
    // Settle a finished pull: the applied department now matches the package.
    if (record?.pending && action !== 'pending_apply') { delete record.pending; settled.push(entry[0]); }
    const proposal = record?.proposal ? {id: record.proposal.id, state: record.proposal.state, base: record.proposal.base,
      reason: record.proposal.reason ?? null, version: record.proposal.version ?? null} : null;
    rows.push({department: entry?.[0] ?? name, localName, equipoId: record?.equipoId ?? null, version: record?.version ?? null,
      remoteVersion, state: action, proposal});
  }
  // Record it, or the next local change would still read as a pull waiting for apply.
  if (adopted.length || settled.length || renamed.length || decided) {
    const message = renamed.length ? `biz: department ${renamed.join(', ')} (Biz name)`
      : decided ? 'biz: record the Biz decision on a department proposal'
      : settled.length ? `biz: applied department ${[...new Set(settled)].join(', ')}` : `biz: link department ${adopted.join(', ')} to its Biz team`;
    saveState(root, state, message, git);
  }
  return {publishSupported: tools.some(t => t.name === 'publicar_equipo'), proposalsSupported, departments: rows};
}

/**
 * Publish a department that has no Biz team yet: this creates the team at version 1. A
 * department already linked to a Biz team is never published over: its changes are
 * proposals (`propose`), decided on Biz.
 */
async function publish({mcp, root, tpl = templates(root), department, departmentId, git, yaml}) {
  ensureClean(root, git);
  await mcp.initialize();
  if (!(await mcp.tools()).some(t => t.name === 'publicar_equipo')) throw Error('publish_not_supported');
  const exported = await tpl.exportDepartment(department, {root}).catch(() => { throw Error('unknown_department'); });
  const state = readState(root);
  // A department downloaded from Biz before packages belongs to that team, never a new one.
  adoptLegacy(root, state, yaml);
  const entry = recordOf(state, department), record = entry?.[1];
  if (record) throw Error('linked_to_biz');
  const args = {paquete: exported.package};
  if (departmentId) args.departamento_id = departmentId;
  let result;
  try { result = await mcp.call('publicar_equipo', args); }
  catch (error) {
    const detail = `${error.detail || ''} ${error.message}`;
    const code = ['version_conflict', 'departamento_requerido'].find(c => detail.includes(c));
    throw code ? Error(code) : error;
  }
  // Biz answers {equipo: {id, slug, nombre, version}, creado}.
  const team = result?.equipo;
  if (!team?.id || !Number.isInteger(Number(team.version))) throw Error('unexpected_response');
  const name = entry?.[0] ?? department, version = Number(team.version);
  state.departments[name] = {equipoId: String(team.id), version, digest: exported.digest, bots: botsOf(exported.package, yaml)};
  const commit = saveState(root, state, `biz: publish department ${name} v${version}`, git);
  return {department: name, equipoId: String(team.id), version, commit};
}

/** Bot names of a package, sorted. */
function botsOf(pkg, yaml) {
  return preview(pkg, yaml).bots.map(bot => bot.name).sort();
}

/**
 * Send a local change of a Biz department as a change proposal, built on the recorded Biz
 * version. `department` is its local name (it may differ from the Biz name after a local
 * rename; the Biz team is then `equipoId`). `overwrite` (after a conflict, the person's
 * choice) bases it on Biz's current version instead. Nothing is written back to Biz.
 */
async function propose({mcp, root, tpl = templates(root), department, equipoId, message = '', overwrite = false, git, yaml}) {
  ensureClean(root, git);
  await mcp.initialize();
  if (!(await mcp.tools()).some(t => t.name === 'proponer_cambio_equipo')) throw Error('proposals_not_supported');
  const exported = await tpl.exportDepartment(department, {root}).catch(() => { throw Error('unknown_department'); });
  const state = readState(root);
  adoptLegacy(root, state, yaml);
  const entry = (equipoId && recordById(state, equipoId)) || recordOf(state, department);
  if (!entry) throw Error('not_published');
  const [name, record] = entry;
  let base = record.version;
  if (overwrite) {
    const current = ((await mcp.call('listar_equipos')).equipos || []).find(e => String(e.id) === record.equipoId);
    base = Number(current?.version) || base;
  }
  let result;
  try {
    result = await mcp.call('proponer_cambio_equipo', {equipo_id: record.equipoId, version_base: base, paquete: exported.package,
      ...(String(message).trim() && {mensaje: String(message).trim().slice(0, 2000)})});
  } catch (error) {
    if (`${error.detail || ''} ${error.message}`.includes('version_conflict')) throw Error('version_conflict');
    throw error;
  }
  const id = result?.propuesta?.id;
  if (!id) throw Error('unexpected_response');
  record.proposal = {id: String(id), digest: exported.digest, base, state: 'pending', sentAt: result.propuesta.creado_en ?? null};
  const commit = saveState(root, state, `biz: propose a change to department ${name} on v${base}`, git);
  return {department: name, equipoId: record.equipoId, proposal: record.proposal, commit};
}

/**
 * The Biz name wins: the proposed team file that gives a locally renamed department its
 * Biz name back, for the panel's review and apply (the extension never writes team.yaml).
 */
function restoreName({root, tpl = templates(root), equipoId, git, yaml}) {
  ensureClean(root, git);
  const state = readState(root), entry = recordById(state, equipoId);
  if (!entry) throw Error('not_published');
  const [name, record] = entry;
  const localNames = tpl.departments(root);
  const old = legacyLinks(root, yaml).find(link => link.equipoId === record.equipoId)?.department;
  const from = renamedTo(record, name, localNames, botDepartments(root, yaml))
    || (old && key(old) !== key(name) && !localNames.some(n => key(n) === key(name)) && localNames.some(n => key(n) === key(old)) ? old : null);
  if (!from) throw Error('not_renamed');
  const current = fs.readFileSync(path.join(root, 'project/bots/team.yaml'), 'utf8');
  const proposed = renameInTeamFile(current, from, name, yaml);
  return {department: name, localName: from, team: {id: record.equipoId, slug: '', nombre: name, version: record.version},
    bots: (record.bots || []).map(bot => ({name: bot, title: ''})), skills: [], commit: null,
    teamB64: Buffer.from(proposed).toString('base64'), teamBaseB64: Buffer.from(current).toString('base64')};
}

/** Agents (name, title) and skill names of a package, for the download preview. */
function preview(pkg, yaml = require('./team.cjs').yamlModule()) {
  let bots = [];
  try {
    const team = yaml.parse(pkg.team) || {};
    bots = (Array.isArray(team.bots) ? team.bots : []).map(bot => ({name: String(bot?.name ?? ''), title: String(bot?.title ?? '')})).filter(bot => bot.name);
  } catch { /* validated already; an unreadable file only leaves the list empty */ }
  const skills = [...new Set((pkg.skills || []).map(skill => String(skill.path).split('/').at(-2)))].sort();
  return {bots, skills};
}

/**
 * Pull a Biz team's package: write its files, commit them, and return the proposed team
 * file for the panel's review (the person applies it). Pulling over local changes needs
 * the person's explicit choice (`overwrite`).
 */
async function pull({mcp, root, tpl = templates(root), equipoId, overwrite = false, git, yaml}) {
  ensureClean(root, git);
  await mcp.initialize();
  const exported = await mcp.call('exportar_equipo', {equipo_id: equipoId});
  const pkg = exported?.paquete;
  if (!pkg) throw Error('no_package');
  tpl.validate(pkg);
  const state = readState(root), entry = recordOf(state, pkg.departamento), record = entry?.[1];
  if (record && !overwrite) {
    let local = null;
    try { local = (await tpl.exportDepartment(pkg.departamento, {root})).digest; } catch { local = null; }
    // The local change that became this version through an accepted proposal is not a conflict.
    const accepted = record.proposal?.state === 'accepted' && local === record.proposal.digest;
    if (local !== null && local !== record.digest && !accepted) throw Error('conflict');
  }
  const imported = await tpl.importPackage(pkg, {root, source: {kind: 'biz', equipoId, version: Number(exported.equipo?.version)}});
  const name = entry?.[0] ?? pkg.departamento;
  state.departments[name] = {equipoId: String(equipoId), version: Number(exported.equipo?.version), digest: tpl.digest(pkg), pending: true, bots: botsOf(pkg, yaml)};
  const commit = saveState(root, state, `biz: pull department ${name} v${exported.equipo?.version}`, git);
  return {department: name, version: Number(exported.equipo?.version), commit, files: imported.commit,
    // The panel's download preview: the Biz team, the agents and the skills that arrive.
    team: exported.equipo, ...preview(pkg, yaml),
    teamB64: Buffer.from(imported.proposedTeamYaml).toString('base64'), teamBaseB64: Buffer.from(imported.currentTeamYaml).toString('base64')};
}

/**
 * After an older download (a Biz team without a package, team.cjs) wrote version
 * `version` of team `equipoId`: record it as waiting for apply until the department
 * changes from what it is now. A team downloaded for the first time is adopted once applied.
 */
async function legacyPulled({root, tpl = templates(root), equipoId, version, git, yaml}) {
  const state = readState(root);
  adoptLegacy(root, state, yaml);
  const entry = recordById(state, equipoId);
  if (!entry) return null;
  const [name, record] = entry;
  // The same version again (a review) changes nothing to wait for.
  if (!(Number(version) > Number(record.version))) return null;
  let local = null;
  try { local = (await tpl.exportDepartment(name, {root})).digest; } catch { local = null; }
  state.departments[name] = {...record, version: Number(version), digest: record.digest ?? local, pending: true, before: local};
  return saveState(root, state, `biz: pull department ${name} v${version}`, git);
}

module.exports = {STATE, ERRORS, decide, readState, saveState, status, publish, propose, restoreName, renameInTeamFile, pull, preview, templates, links, legacyLinks, adoptLegacy, legacyPulled};
