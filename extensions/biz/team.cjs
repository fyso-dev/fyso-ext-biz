// Turn a Fyso Biz team export (fyso-equipo/v1) into this project's native files:
// soul and skill Markdown under project/bots/biz/<team>/, plus a proposed
// project/bots/team.yaml that the framework's own bots plan/apply reviews and commits.
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
    if (text(team.prompt).trim()) sections.push(`## Team: ${text(team.nombre, 200)}\n\n${text(team.prompt).trim()}`);
    files[`${dir}/souls/${file}.md`] = `${sections.filter(Boolean).join('\n\n')}\n`;
    bots.push({name, title: text(agent.rol, 200).replace(/\s+/g, ' ').trim(), soul: `${ROOT_VAR}/${dir}/souls/${file}.md`});
  }
  const source = {formato: FORMAT, equipo: {id: text(team.id, 200), slug: text(team.slug, 200), nombre: text(team.nombre, 200), version: Number(team.version) || 0}};
  files[`${dir}/source.json`] = `${JSON.stringify(source, null, 2)}\n`;
  return {dir, teamSlug, source, bots, skills: skills.map(name => `${ROOT_VAR}/${dir}/skills/${name}/SKILL.md`), skillNames: skills, files};
}

/** The proposed team file: owned bots updated in place, new ones appended, gone ones removed. */
function proposeTeam(current, imported, yaml = yamlModule()) {
  // `${FYSO_ROOT}` opens a flow mapping in YAML (`soul: { file: ${FYSO_ROOT}/… }`);
  // swap it for a plain marker while editing, as the framework's render-team does.
  if (current.includes(MARKER)) throw Error('invalid_team_file');
  const doc = yaml.parseDocument(current.replaceAll(ROOT_VAR, MARKER));
  if (doc.errors.length) throw Error('invalid_team_file');
  const bots = doc.get('bots');
  if (!yaml.isSeq(bots)) throw Error('invalid_team_file');
  const prefix = `${MARKER}/${imported.dir}/`;
  const local = file => file.replace(ROOT_VAR, MARKER);
  const soulOf = node => { const soul = node.get?.('soul'); return yaml.isMap(soul) ? String(soul.get('file') || '') : ''; };
  const owned = new Map(), others = new Set();
  for (const node of bots.items) {
    if (!yaml.isMap(node)) continue;
    const name = String(node.get('name') || '');
    if (soulOf(node).startsWith(prefix)) owned.set(name, node); else others.add(name.toLowerCase());
  }
  const conflict = imported.bots.find(bot => others.has(bot.name.toLowerCase()));
  if (conflict) throw Object.assign(Error('name_conflict'), {bot: conflict.name});
  // A new bot uses the engine of the project's first non-chief bot, as the local default.
  const model = bots.items.map(node => yaml.isMap(node) && !node.get('chief') && node.get('model')).find(Boolean)
    || bots.items.map(node => yaml.isMap(node) && node.get('model')).find(Boolean);
  if (!model && imported.bots.some(bot => !owned.has(bot.name))) throw Error('no_model');
  const wanted = new Set(imported.bots.map(bot => bot.name));
  bots.items = bots.items.filter(node => !(yaml.isMap(node) && owned.has(String(node.get('name'))) && !wanted.has(String(node.get('name')))));
  for (const bot of imported.bots) {
    const fields = {...(bot.title && {title: bot.title}), soul: {file: local(bot.soul)}, skills: imported.skills.map(file => ({file: local(file)}))};
    const node = owned.get(bot.name);
    if (node) {
      if (!bot.title) node.delete('title');
      for (const [key, value] of Object.entries(fields)) node.set(key, doc.createNode(value));
    } else {
      bots.items.push(doc.createNode({name: bot.name, ...(bot.title && {title: bot.title}), model, approval: 'ask', soul: fields.soul, skills: fields.skills}));
    }
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
