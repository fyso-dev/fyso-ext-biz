const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gitImport = "{execFileSync} = require('node:child_process')";
const tempGit = "execFileSync('git', args, {cwd: root, encoding: 'utf8'})";

// Remove only the approved source fragments, so new process calls in these files are also scanned.
const processAllowlist = {
  'biz-bot.test.cjs': [
    // The VM supplies a fake process module to the bot entry point.
    "if (id === 'node:child_process') return {execFileSync: exec};",
  ],
  'dispatch-config.test.cjs': [
    // Git commits are confined to the temporary dispatch repository.
    gitImport, "execFileSync('git', args, {cwd: project.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})",
  ],
  'email-delivery.test.cjs': [
    // The test replaces the process runner before loading email delivery.
    "const childProcess = require('node:child_process');",
    "test.mock.method(childProcess, 'execFile', (...args) => exec(...args))",
  ],
  'machine-paths.test.cjs': [
    // Read the repository file list, including new source files.
    gitImport,
    "execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: root, encoding: 'utf8'})",
  ],
  'managed-setup.test.cjs': [
    // Local Node processes for a dead PID fixture and the busy sync CLI exit status.
    gitImport, "execFileSync(process.execPath, ['-p', 'process.pid'], {encoding: 'utf8'})",
    "{spawnSync} = require('node:child_process')",
    "spawnSync(process.execPath, [require.resolve('../extensions/biz/managed-setup.cjs'), 'sync'],",
  ],
  'managed-teams.test.cjs': [
    // Git in a temporary project, connect.sh with a fake node on PATH, and the disconnected Node entry point.
    gitImport, tempGit,
    "execFileSync('bash', ['extensions/biz/connect.sh'], {cwd: repo, env: {PATH: `${bin}:${process.env.PATH}`, ...env}})",
    "require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '../extensions/biz/managed-teams.cjs')], {",
  ],
  'regressions.test.cjs': [
    // Run each mapped Node regression by its exact title with the isolation preload.
    "{spawnSync} = require('node:child_process')",
    'spawnSync(process.execPath, [',
  ],
  'team.test.cjs': [gitImport, tempGit], // Git in a temporary team repository.
  'teams-sync.test.cjs': [gitImport, tempGit], // Git in a temporary sync repository.
};

const productionHost = /https:\/\/(?:[\w-]+\.)*fyso\.biz\b|\bapi\.fyso\.dev\b/i;
const networkAllowlist = {
  'api.test.cjs': [
    // local unix socket in a temp dir; verifies real file mode
    "http.get({socketPath:socket, path:'/health'}, r => { r.resume(); resolve(r.statusCode); }).on('error', reject)",
  ],
};
const realNetwork = [
  /\b(?:globalThis|global|window|self)\s*(?:\??\.\s*fetch\b|(?:\?\.)?\[\s*['"`]fetch['"`]\s*\])/,
  /(?<![\w$.])fetch\s*(?:\??\.\s*\(|\()/,
  /[:=]\s*fetch\b(?!\s*\.\s*mock\b)|[(,]\s*fetch\b(?=\s*[,);}\n])/,
  /\{\s*fetch\b[^}]*\}\s*=\s*(?:globalThis|global)\b/,
  /\b(?:http|https|net|tls)\s*\.\s*(?:get|request|connect|createConnection)\s*\(/,
];
const subprocess = /\b(?:child_process|childProcess)\b|\b(?:execFile(?:Sync)?|execSync|spawn(?:Sync)?|fork)\s*\(/;

// These calls deliberately go through the real entry points. The preload rejects them synchronously.
const blockedAttempts = [
  [() => require('node:net').connect(443, 'outside.invalid'), 'network connection to outside.invalid'],
  [() => require('node:tls').connect({port: 443, host: 'outside.invalid'}), 'network connection to outside.invalid'],
  [() => globalThis.fetch(new Request('https://outside.invalid')), 'network connection to outside.invalid'],
  [() => require('node:child_process').spawn('mise', ['run', 'dist:publish']), 'subprocess mise'],
  [() => require('node:child_process').spawnSync('unexpected-command'), 'subprocess unexpected-command'],
];

test('tier-1 sources use fake network transports and only approved subprocesses', () => {
  const sources = [
    ...fs.readdirSync(__dirname).filter(file => file.endsWith('.test.cjs')),
    ...fs.readdirSync(path.join(__dirname, 'helpers')).filter(file => file.endsWith('.cjs'))
      .map(file => path.join('helpers', file)),
  ].sort();
  const violations = [];
  for (const file of sources) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');

    // Replace this test's own declarations and allowlist, then scan its executable test body too.
    const body = file === path.basename(__filename) ? source.slice(source.indexOf("\ntest(")) : source;
    if (productionHost.test(body)) violations.push(`${file}: production network host`);
    let network = body;
    for (const fragment of networkAllowlist[file] ?? []) {
      if (!network.includes(fragment)) violations.push(`${file}: stale network allowance: ${fragment}`);
      network = network.replace(fragment, '');
    }
    if (realNetwork.some(pattern => pattern.test(network))) {
      violations.push(`${file}: use an injected transport or stub network I/O`);
    }
    if (/\.mock\.method\(\s*(?:globalThis|global)\s*,\s*['"]fetch['"]\s*\)/.test(body)) {
      violations.push(`${file}: provide a fake implementation when mocking fetch`);
    }

    let commands = body;
    for (const fragment of processAllowlist[file] ?? []) {
      if (!commands.includes(fragment)) violations.push(`${file}: stale process allowance: ${fragment}`);
      commands = commands.replace(fragment, '');
    }
    if (subprocess.test(commands)) violations.push(`${file}: unapproved subprocess reference`);
  }
  assert.deepEqual(violations, []);
});

test('the runtime guard blocks external connections and unexpected commands', () => {
  require('./isolation-preload.cjs');
  for (const [attempt, reason] of blockedAttempts) {
    assert.throws(attempt, error => {
      assert.match(error.message, /Tier-1 isolation \(.*isolation\.test\.cjs\): blocked /);
      assert.ok(error.message.endsWith(reason));
      return true;
    });
  }
});
