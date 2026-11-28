// The framework refuses to publish a project whose tracked files contain machine-specific absolute paths
// (framework/scripts/check-paths.sh), and this extension's files are copied into every project that installs it:
// one such path here breaks the publish preview of every publisher (`machine_paths` check). This runs the same
// pattern over every file of the repository. The pattern and the samples are built from pieces so that this
// file does not match itself.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');

const root = path.resolve(__dirname, '..');
const slash = (...parts) => ['', ...parts].join('/');
const name = '[A-Za-z0-9._-]+';
const PATTERN = [
  `${slash('Users')}/${name}`, `${slash('home')}/${name}/`, `${slash('private', 'tmp')}/`, `${slash('var', 'folders')}/`, `${slash('opt', 'homebrew')}/`, 'C:\\\\Users\\\\',
].join('|');

test('the pattern is the framework\'s own (check-paths.sh)', () => {
  const regex = new RegExp(PATTERN);
  for (const sample of [slash('Users', 'ana', 'x'), `${slash('home', 'ana')}/x`, `${slash('private', 'tmp')}/x`, `${slash('var', 'folders')}/x`, `${slash('opt', 'homebrew')}/bin`, 'C:\\Users\\ana']) {
    assert.match(sample, regex, sample);
  }
  for (const sample of ['state/dist/x', 'https://biz.test/oauth/authorize', '<tmp>', '/api/ext/biz/profile/login']) assert.doesNotMatch(sample, regex, sample);
});

test('no file of the extension (nor of this repository) contains a machine-specific absolute path', () => {
  // Tracked files, plus new ones not yet committed (so a mistake fails before it is committed). Text only, like `git grep -I`.
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean);
  assert.ok(files.length > 20 && files.includes('extensions/biz/managed-setup.cjs'));
  const regex = new RegExp(PATTERN);
  const found = [];
  for (const file of files) {
    let data;
    try { data = fs.readFileSync(path.join(root, file)); } catch { continue; }
    if (data.includes(0)) continue;
    data.toString('utf8').split('\n').forEach((line, i) => { if (regex.test(line)) found.push(`${file}:${i + 1}`); });
  }
  assert.deepEqual(found, [], `machine-specific paths in: ${found.join(', ')}`);
});
