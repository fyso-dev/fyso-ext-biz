// Turn a Fyso Biz team export (fyso-equipo/v1) into this project's native files:
// soul, skill and team brief Markdown under project/bots/biz/<team>/, plus a proposed
// project/bots/team.yaml with an OpenMausBot native team (`teams:`, `team:` on each
// bot, one room) that the framework's own bots plan/apply reviews and commits.
// Only configuration travels; models, tools and approval stay local decisions.
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process'), {createRequire} = require('node:module');

const FORMAT = 'fyso-equipo/v1', ROOT_VAR = '${FYSO_ROOT}', MARKER = '__FYSO_PATH_ROOT__';
const slug = value => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const text = (value, max = 200000) => typeof value === 'string' ? value.slice(0, max) : '';

function yamlModule() {
  // The project's pinned `yaml` CLI (npm:yaml in mise.toml) carries the library.
  return createRequire(fs.realpathSync(execFileSync('which', ['yaml'], {encoding: 'utf8'}).trim()))('yaml');
}

/** Validate an export and derive every file this import owns. */
function plan(exported) {
  if (exported?.formato !== FORMAT) throw Error('unsupported_format');
  const team = exported.equipo || {}, teamSlug = slug(team.slug || team.nombre);
  if (!teamSlug || !Array.isArray(exported.agentes) || !Array.isArray(exported.skills)) throw Error('invalid_export');
  const dir = `project/bots/biz/${teamSlug}`;
  const skills = [], files = {}, seen = new Set();
  for (const skill of exported.skills) {
    const name = slug(skill?.nombre);
    if (!name || seen.has(`skill:${name}`)) throw Error('invalid_export');
    seen.add(`skill:${name}`);
    const body = text(skill.contenido);
    const description = text(skill.descripcion, 500).replace(/\s+/g, ' ').trim() || name;
    files[`${dir}/skills/${name}/SKILL.md`] = body.startsWith('---\n') ? body
      : `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
    skills.push(name);
  }
  const bots = [];
  for (const agent of exported.agentes) {
    const file = slug(agent?.nombre), name = text(agent?.nombre_visible || agent?.nombre, 80).trim();
    if (!file || !name || seen.has(`agent:${file}`) || seen.has(`bot:${name.toLowerCase()}`)) throw Error('invalid_export');
    seen.add(`agent:${file}`); seen.add(`bot:${name.toLowerCase()}`);
    const sections = [text(agent.soul).trim()];
    if (text(agent.system_prompt).trim()) sections.push(`## Instructions\n\n${text(agent.system_prompt).trim()}`);
    files[`${dir}/souls/${file}.md`] = `${sections.filter(Boolean).join('\n\n')}\n`;
    bots.push({name, title: text(agent.rol, 200).replace(/\s+/g, ' ').trim(), soul: `${ROOT_VAR}/${dir}/souls/${file}.md`});
  }
  // The team prompt is the native team brief: OpenMausBot gives it to every member.
  const teamName = text(team.nombre, 80).replace(/\s+/g, ' ').trim() || teamSlug;
  files[`${dir}/brief.md`] = `${text(team.prompt).trim() || teamName}\n`;
  const source = {formato: FORMAT, equipo: {id: text(team.id, 200), slug: text(team.slug, 200), nombre: text(team.nombre, 200), version: Number(team.version) || 0}};
  files[`${dir}/source.json`] = `${JSON.stringify(source, null, 2)}\n`;
  return {dir, teamSlug, teamName, brief: `${ROOT_VAR}/${dir}/brief.md`, source, bots, skills: skills.map(name => `${ROOT_VAR}/${dir}/skills/${name}/SKILL.md`), skillNames: skills, files};
}

/** The proposed team file: owned bots updated in place, new ones appended, gone ones removed,
 * plus the native team (identified by its brief file) and its room (named after the team). */
function proposeTeam(current, imported, yaml = yamlModule()) {
  // `${FYSO_ROOT}` opens a flow mapping in YAML (`soul: { file: ${FYSO_ROOT}/… }`);
  // swap it for a plain marker while editing, as the framework's render-team does.
  if (current.includes(MARKER)) throw Error('invalid_team_file');
  const doc = yaml.parseDocument(current.replaceAll(ROOT_VAR, MARKER));
  if (doc.errors.length) throw Error('invalid_team_file');
  const bots = doc.get('bots');
  if (!yaml.isSeq(bots)) throw Error('invalid_team_file');
  const sequence = key => {
    const node = doc.get(key);
    if (node !== undefined && !yaml.isSeq(node)) throw Error('invalid_team_file');
    return node ? node.items.filter(item => yaml.isMap(item)) : [];
  };
  const prefix = `${MARKER}/${imported.dir}/`;
  const local = file => file.replace(ROOT_VAR, MARKER);
  const fileOf = (node, key) => { const value = node.get?.(key); return yaml.isMap(value) ? String(value.get('file') || '') : ''; };
  const owned = new Map(), others = new Set();
  for (const node of bots.items) {
    if (!yaml.isMap(node)) continue;
    const name = String(node.get('name') || '');
    if (fileOf(node, 'soul').startsWith(prefix)) owned.set(name, node); else others.add(name.toLowerCase());
  }
  const conflict = imported.bots.find(bot => others.has(bot.name.toLowerCase()));
  if (conflict) throw Object.assign(Error('name_conflict'), {bot: conflict.name});
  // The team this import created earlier, found by its brief; its room carries the team's name.
  const ownedTeam = sequence('teams').find(node => fileOf(node, 'brief') === local(imported.brief));
  const previous = ownedTeam ? String(ownedTeam.get('name') || '') : null;
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const ownedRoom = previous === null ? undefined : sequence('rooms').find(node => same(String(node.get('name') || ''), previous));
  const taken = (key, node) => sequence(key).some(item => item !== node && same(String(item.get('name') || ''), imported.teamName));
  if (taken('teams', ownedTeam) || taken('rooms', ownedRoom)) throw Object.assign(Error('team_conflict'), {bot: imported.teamName});
  // A new bot uses the engine of the project's first non-chief bot, as the local default.
  const model = bots.items.map(node => yaml.isMap(node) && !node.get('chief') && node.get('model')).find(Boolean)
    || bots.items.map(node => yaml.isMap(node) && node.get('model')).find(Boolean);
  if (!model && imported.bots.some(bot => !owned.has(bot.name))) throw Error('no_model');
  const wanted = new Set(imported.bots.map(bot => bot.name));
  const retired = new Set([...owned.keys()].filter(name => !wanted.has(name)));
  bots.items = bots.items.filter(node => !(yaml.isMap(node) && retired.has(String(node.get('name')))));
  if (previous !== null && previous !== imported.teamName) {
    for (const node of bots.items) {
      if (yaml.isMap(node) && same(String(node.get('team') || ''), previous)) node.set('team', imported.teamName);
    }
  }
  for (const bot of imported.bots) {
    const fields = {team: imported.teamName, ...(bot.title && {title: bot.title}), soul: {file: local(bot.soul)}, skills: imported.skills.map(file => ({file: local(file)}))};
    const node = owned.get(bot.name);
    if (node) {
      if (!bot.title) node.delete('title');
      for (const [key, value] of Object.entries(fields)) node.set(key, doc.createNode(value));
    } else {
      bots.items.push(doc.createNode({name: bot.name, team: fields.team, ...(bot.title && {title: bot.title}), model, approval: 'ask', soul: fields.soul, skills: fields.skills}));
    }
  }
  // Native team: the brief reaches every member. A new `teams:` list goes before `bots:`.
  if (ownedTeam) ownedTeam.set('name', imported.teamName);
  else {
    if (!doc.has('teams')) doc.contents.items.splice(doc.contents.items.findIndex(pair => String(pair.key) === 'bots'), 0, doc.createPair('teams', []));
    doc.get('teams').items.push(doc.createNode({name: imported.teamName, brief: {file: local(imported.brief)}}));
  }
  // One room with every member; other rooms keep their own members minus retired bots.
  const members = imported.bots.map(bot => bot.name);
  for (const room of sequence('rooms')) {
    if (previous !== null && room.get('team') === previous) room.set('team', imported.teamName);
    const list = room.get('members');
    const kept = yaml.isSeq(list) ? list.items.filter(item => !retired.has(String(yaml.isScalar(item) ? item.value : item))) : [];
    if (yaml.isSeq(list) && kept.length !== list.items.length) list.items = kept;
    if (retired.has(String(room.get('responder') || ''))) room.delete('responder');
  }
  if (ownedRoom) {
    ownedRoom.set('name', imported.teamName);
    ownedRoom.set('team', imported.teamName);
    ownedRoom.set('members', doc.createNode(members, {flow: true}));
    if (ownedRoom.get('responder') && !members.includes(String(ownedRoom.get('responder')))) ownedRoom.delete('responder');
  } else {
    if (!doc.has('rooms')) doc.set('rooms', doc.createNode([]));
    const room = doc.createNode({name: imported.teamName, team: imported.teamName, members});
    room.get('members').flow = true;
    doc.get('rooms').items.push(room);
  }
  return doc.toString().replaceAll(MARKER, ROOT_VAR);
}

/** Replace the team's directory with the export's files and commit them on their own. */
function writeFiles(imported, {root = process.cwd(), git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}), scan} = {}) {
  const dir = path.join(root, imported.dir);
  if (git('status', '--porcelain', '--', imported.dir).trim()) throw Error('uncommitted_changes');
  fs.rmSync(dir, {recursive: true, force: true});
  for (const [file, content] of Object.entries(imported.files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), content);
  }
  try { scan?.(dir); } catch (error) {
    // Restore the committed version of this directory only.
    fs.rmSync(dir, {recursive: true, force: true});
    try { git('checkout', 'HEAD', '--', imported.dir); } catch { /* the team was new */ }
    throw Object.assign(Error('secret_detected'), {cause: error});
  }
  git('add', '-A', '--', imported.dir);
  let commit = null;
  try { git('diff', '--cached', '--quiet', '--', imported.dir); }
  catch {
    git('commit', '-q', '-m', `biz: import team ${imported.teamSlug} v${imported.source.equipo.version}`, '--', imported.dir);
    commit = git('rev-parse', 'HEAD').trim();
  }
  return commit;
}

module.exports = {FORMAT, plan, proposeTeam, writeFiles, slug, yamlModule};
