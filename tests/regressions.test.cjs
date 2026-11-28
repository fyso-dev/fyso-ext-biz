const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');

// docs/testing-plan.md §1.2. The panel CI job executes the Vitest entries.
const regressions = [
  [1, 'tests/project-access.test.cjs', 'regression: an expired embedded credential asks to reauthorize, it is not a non-member'],
  [2, 'tests/project-access.test.cjs', 'regression: concurrent requests share one Biz call'],
  [3, 'tests/project-access.test.cjs', 'regression: a 4 s Biz answers within the timeout'],
  [4, 'tests/department-capabilities.test.cjs', 'regression: a member gets page and action capabilities, not only MCP'],
  [5, 'tests/project-policy.test.cjs', 'regression: app hosts such as omb. are allowed with the right capability'],
  [6, 'panel-src/__tests__/setup.test.jsx', 'regression: the shown version follows Biz after a publish'],
  [6, 'tests/profile-session.test.cjs', 'regression: the shown version is fresh after a publish through the gateway'],
  [7, 'tests/managed-setup-publish.test.cjs', 'regression: the extension preview digest tracks the dry-run report independently of git'],
  [8, 'tests/managed-setup-notices.test.cjs', 'regression: the local path check finds no machine-specific paths in the extension source'],
  [9, 'tests/managed-setup.test.cjs', 'regression: a 401 is reported as reauthorize_required, not biz_unreachable'],
  [10, 'tests/managed-setup-notices.test.cjs', 'regression: repeated identical notices collapse'],
  [11, 'tests/managed-setup.test.cjs', 'regression: every pause but frozen has a reauthorize way out'],
  [11, 'panel-src/__tests__/setup.test.jsx', 'regression: a pause always offers a way out (%s)'],
  [11, 'tests/profile-session.test.cjs', 'sign-in saves the replacement credential and resumes the paused setup sync'],
  [12, 'tests/managed-setup-publish.test.cjs', 'regression: extension status picks up a newer version from local distribution answers'],
];

// The repositories listed here verify their real CLI and service contracts in their own CI.
const crossRepoRegressions = [
  [7, 'agentic-framework', 'tests/test_distribution.py', 'test_regression_preview_json_ignores_git_tree_mtime_path_and_memory_logs'],
  [8, 'agentic-framework', 'tests/test_distribution.py', 'test_regression_machine_paths_accepts_extension_source_and_reports_real_leaks'],
  [12, 'agentic-framework', 'tests/test_distribution.py', 'test_two_publishers_merge_instead_of_overwriting'],
  // The concurrent PUT in helpers.test.cjs exercises only the fake's atomicity.
  ['setup PUT concurrency', 'fyso-business', 'worker/framework-access-contract.test.ts'],
];

function checkDeclaration(source, name, label) {
  const title = `(['"])${RegExp.escape(name)}\\1`;
  const declaration = new RegExp(
    `^ *(?:test|it)(?:\\.each\\(\\[[\\s\\S]*?^\\]\\))?\\(\\s*${title}\\s*,\\s*` +
    String.raw`(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*\{`, 'm',
  ).exec(source);
  assert.ok(declaration, `${label} must declare an active test with a callback`);
  const body = source.slice(declaration.index + declaration[0].length);
  const trivia = /^(?:\s|;|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*\}/;
  assert.doesNotMatch(body, trivia, `${label} has an empty body`);
}

test('every production regression in the testing plan has a named test', async t => {
  const root = path.resolve(__dirname, '..');
  const plan = readFileSync(path.join(root, 'docs/testing-plan.md'), 'utf8');
  const section = plan.split(/^### 1\.2\b/m)[1].split(/^## /m)[0];
  const items = Array.from(section.matchAll(/^(\d+)\. /gm), match => Number(match[1]));
  assert.deepEqual([...new Set(regressions.map(([item]) => item))], items);
  assert.deepEqual(crossRepoRegressions.filter(([item]) => Number.isInteger(item)).map(([item]) => item), [7, 8, 12]);

  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  for (const [item, file, name] of regressions) {
    const label = `${item}: ${file} — ${name}`;
    await t.test(label, () => {
      checkDeclaration(readFileSync(path.join(root, file), 'utf8'), name, label);
      if (!file.endsWith('.test.cjs')) return;

      const result = spawnSync(process.execPath, [
        '--require', './tests/isolation-preload.cjs',
        '--test', '--test-reporter=tap', `--test-name-pattern=^${RegExp.escape(name)}$`, file,
      ], {cwd: root, env, encoding: 'utf8', timeout: 30_000});
      if (result.error) throw result.error;
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, output);
      assert.match(result.stdout, new RegExp(`^ok \\d+ - ${RegExp.escape(name)}$`, 'm'), output);
      assert.match(result.stdout, /^# pass [1-9]\d*$/m, output);
      assert.match(result.stdout, /^# skipped 0$/m, output);
      assert.match(result.stdout, /^# todo 0$/m, output);
    });
  }
});
