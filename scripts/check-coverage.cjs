const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extensions', 'biz');
const critical = new Set(['managed-setup', 'project-access', 'profile-session', 'project-policy']);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-coverage-'));

try {
  const report = path.join(temp, 'coverage.lcov');
  const tests = fs.readdirSync(path.join(root, 'tests'))
    .filter(file => file.endsWith('.test.cjs')).sort().map(file => path.join('tests', file));
  const result = spawnSync(process.execPath, [
    '--require', './tests/isolation-preload.cjs',
    '--test', '--experimental-test-coverage',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', `--test-reporter-destination=${report}`,
    ...tests,
  ], {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(result.signal ? `Node tests terminated by ${result.signal}` : 'Node tests failed');
    process.exitCode = result.status ?? 1;
  } else {
    const records = new Map();
    for (const record of fs.readFileSync(report, 'utf8').split('end_of_record')) {
      const source = /^SF:(.+)$/m.exec(record)?.[1];
      if (!source) continue;
      const absolute = path.resolve(root, source);
      if (path.dirname(absolute) !== extension) continue;
      const counts = Object.fromEntries(
        Array.from(record.matchAll(/^(LF|LH|BRF|BRH):(\d+)$/gm), ([, key, value]) => [key, Number(value)]),
      );
      records.set(path.basename(absolute), counts);
    }

    const percent = (hit, total) => Number.isFinite(hit) && total > 0 ? 100 * hit / total : NaN;
    const format = value => Number.isFinite(value) ? `${value.toFixed(2)}%` : 'missing';
    const files = fs.readdirSync(extension).filter(file => file.endsWith('.cjs')).sort();
    console.log('File'.padEnd(32) + 'Lines'.padStart(8) + 'Branches'.padStart(10) + 'Minimum'.padStart(9) + '  Result');
    for (const file of files) {
      const {LH, LF, BRH, BRF} = records.get(file) ?? {};
      const lines = percent(LH, LF);
      const branches = percent(BRH, BRF);
      const minimum = critical.has(path.basename(file, '.cjs')) ? 85 : 70;
      const passed = lines >= minimum && branches >= minimum;
      console.log(file.padEnd(32) + format(lines).padStart(8) + format(branches).padStart(10) +
        `${minimum}%`.padStart(9) + `  ${passed ? 'PASS' : 'FAIL'}`);
      if (!passed) process.exitCode = 1;
    }
  }
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
