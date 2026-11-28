const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {harness, fakeRunner, CMD, MACHINE_PATHS, SECRETS} = require('./helpers/index.cjs');

test('regression: repeated identical notices collapse', async t => {
  const h = harness(t, {scenario: 'admin'});
  const preview = await h.managed.publishPreview();
  h.runner.always(CMD.publish, fakeRunner.leaky());

  for (let attempt = 0; attempt < 3; attempt++) {
    h.clock.advance(1000);
    await assert.rejects(h.managed.publish(preview), {message: 'publish_failed'});
  }
  const [notice, ...rest] = h.project.readState().notices;
  assert.deepEqual(rest, []);
  assert.deepEqual([notice.kind, notice.count, notice.at], ['publish_failed', 3, h.clock.iso()]);
  assert.deepEqual(h.managed.status().notices, [notice]);
});

test('runner stderr is redacted in returned details and persisted notices', async t => {
  const h = harness(t, {scenario: 'admin'});
  const preview = await h.managed.publishPreview();
  h.runner.next(CMD.publish, fakeRunner.leaky());

  let detail;
  await assert.rejects(h.managed.publish(preview), error => {
    assert.equal(error.message, 'publish_failed');
    detail = error.detail;
    return true;
  });
  const persisted = fs.readFileSync(h.project.stateFile, 'utf8');
  const displayed = h.managed.status().notices.at(-1).text;
  for (const output of [detail, persisted, displayed]) {
    assert.match(output, /mise ERROR failed to run <path>/);
    assert.match(output, /cache <tmp>/);
    assert.match(output, /password=\[redacted\] Bearer \[redacted\] \[redacted\]/);
    for (const leak of [...MACHINE_PATHS, SECRETS.ageSecret, SECRETS.assignment.split('=')[1], SECRETS.bearer.split(' ')[1]]) {
      assert.equal(output.includes(leak), false);
    }
  }
});

test("regression: the local path check finds no machine-specific paths in the extension source", () => {
  // This local scan checks the checkout for known path patterns. Framework CI exercises the publish scanner.
  const slash = (...parts) => ['', ...parts].join('/');
  const user = '[A-Za-z0-9._-]+';
  const machinePath = new RegExp([
    `${slash('Users')}/${user}`, `${slash('home')}/${user}/`,
    `${slash('private', 'tmp')}/`, `${slash('var', 'folders')}/`,
    `${slash('opt', 'homebrew')}/`, String.raw`C:\\Users\\`,
  ].join('|'));
  const root = path.resolve(__dirname, '../extensions/biz');
  const files = fs.readdirSync(root, {recursive: true, withFileTypes: true}).filter(file => file.isFile());
  assert.ok(files.some(file => file.name === 'managed-setup.cjs'));
  const offending = files.map(file => path.join(file.parentPath, file.name)).filter(file => {
    const bytes = fs.readFileSync(file);
    return !bytes.includes(0) && machinePath.test(bytes.toString('utf8'));
  });
  assert.deepEqual(offending.map(file => path.relative(root, file)), []);
});
