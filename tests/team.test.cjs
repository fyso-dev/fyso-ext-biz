const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), {execFileSync} = require('node:child_process');
const team = require('../extensions/biz/team.cjs');
const yaml = team.yamlModule();
const parse = text => yaml.parse(text.replaceAll('${FYSO_ROOT}', '__R__'));

const TEAM = `# Project bots.
version: 1
bots:
  - name: MausBot
    chief: true
    soul: { file: \${FYSO_ROOT}/framework/bots/souls/chief.md }
    model: claude/claude-sonnet-5
  - name: Builder # keep this comment
    model: claude/claude-haiku-4-5
    approval: full
`;
const exported = (over = {}) => ({formato: 'fyso-equipo/v1',
  equipo: {id: 'e1', slug: 'comercial', nombre: 'Comercial', descripcion: '', prompt: 'Embudo B2B.', version: 3},
  agentes: [{id: 'a1', nombre: 'redactor', nombre_visible: 'Redactor', rol: 'Escribe', soul: 'Breve.', system_prompt: 'Redactás.'},
    {id: 'a2', nombre: 'analista', nombre_visible: '', rol: 'Analiza', soul: 'Preciso.', system_prompt: ''}],
  skills: [{nombre: 'tono-de-marca', descripcion: 'Tono', contenido: '# Tono'}], ...over});

test('rejects unknown formats and malformed exports', () => {
  assert.throws(() => team.plan({...exported(), formato: 'fyso-equipo/v2'}), {message: 'unsupported_format'});
  assert.throws(() => team.plan(exported({agentes: [{nombre: 'x'}, {nombre: 'x'}]})), {message: 'invalid_export'});
});

test('derives souls, skills and provenance under the team directory', () => {
  const p = team.plan(exported());
  assert.equal(p.dir, 'project/bots/biz/comercial');
  assert.deepEqual(Object.keys(p.files).sort(), ['project/bots/biz/comercial/skills/tono-de-marca/SKILL.md', 'project/bots/biz/comercial/souls/analista.md', 'project/bots/biz/comercial/souls/redactor.md', 'project/bots/biz/comercial/source.json']);
  assert.match(p.files['project/bots/biz/comercial/skills/tono-de-marca/SKILL.md'], /^---\nname: tono-de-marca\ndescription: "Tono"\n---/);
  assert.match(p.files['project/bots/biz/comercial/souls/redactor.md'], /Breve\.\n\n## Instructions\n\nRedactás\.\n\n## Team: Comercial\n\nEmbudo B2B\./);
  assert.deepEqual(p.bots.map(b => b.name), ['Redactor', 'analista']);
  assert.ok(!JSON.stringify(p).includes('/Users/'));
});

test('appends new bots with the local engine, keeps comments, and updates owned bots in place', () => {
  const first = team.proposeTeam(TEAM, team.plan(exported()), yaml);
  assert.match(first, /# keep this comment/);
  assert.match(first, /soul: \{ file: \$\{FYSO_ROOT\}\/framework\/bots\/souls\/chief\.md \}/);
  const doc = parse(first);
  const redactor = doc.bots.find(b => b.name === 'Redactor');
  assert.equal(redactor.model, 'claude/claude-haiku-4-5');
  assert.equal(redactor.approval, 'ask');
  assert.deepEqual(redactor.soul, {file: '__R__/project/bots/biz/comercial/souls/redactor.md'});
  assert.deepEqual(redactor.skills, [{file: '__R__/project/bots/biz/comercial/skills/tono-de-marca/SKILL.md'}]);
  // A local model choice survives; an agent retired in Biz leaves the declaration.
  const edited = first.replace(/(name: Redactor[\s\S]*?model: )claude\/claude-haiku-4-5/, '$1claude/claude-sonnet-5');
  const second = parse(team.proposeTeam(edited, team.plan(exported({agentes: [exported().agentes[0]]})), yaml));
  assert.deepEqual(second.bots.map(b => b.name), ['MausBot', 'Builder', 'Redactor']);
  assert.equal(second.bots[2].model, 'claude/claude-sonnet-5');
});

test('never takes over a bot the project already declares', () => {
  assert.throws(() => team.proposeTeam(TEAM, team.plan(exported({agentes: [{nombre: 'builder', nombre_visible: 'Builder', soul: 'x'}]})), yaml), {message: 'name_conflict', bot: 'Builder'});
});

test('writes and commits only the team directory; a secret aborts and restores it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-team-'));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(root, 'other.txt'), 'untouched');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, 'other.txt'), 'local edit');
  const commit = team.writeFiles(team.plan(exported()), {root, git});
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(git('log', '-1', '--format=%s').trim(), 'biz: import team comercial v3');
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').every(f => f.startsWith('project/bots/biz/comercial/')), true);
  assert.equal(fs.readFileSync(path.join(root, 'other.txt'), 'utf8'), 'local edit');
  assert.equal(team.writeFiles(team.plan(exported()), {root, git}), null);
  assert.throws(() => team.writeFiles(team.plan(exported({skills: []})), {root, git, scan: () => { throw Error('leak'); }}), {message: 'secret_detected'});
  assert.ok(fs.existsSync(path.join(root, 'project/bots/biz/comercial/skills/tono-de-marca/SKILL.md')));
});
