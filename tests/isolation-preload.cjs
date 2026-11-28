// Runtime backstop for the tier-1 source checks. Load before production imports.
const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {syncBuiltinESMExports} = require('node:module');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const temp = fs.realpathSync(os.tmpdir());
const localGit = new Set(['init', 'config', 'add', 'commit', 'log', 'show', 'status', 'rev-parse', 'checkout', 'diff']);

function blocked(operation) {
  const stack = new Error().stack;
  const file = process.argv[1]?.endsWith('.test.cjs') ? process.argv[1] :
    /tests[/\\][^\r\n/\\]+\.test\.cjs/.exec(stack)?.[0] ?? process.argv[1] ?? 'Node test runner';
  throw new Error(`Tier-1 isolation (${file}): blocked ${operation}`);
}

function checkHost(host) {
  const name = String(host ?? 'localhost').toLowerCase();
  if (name === 'localhost' || name === '::1' || name === '[::1]' ||
      (net.isIPv4(name) && name.startsWith('127.'))) return;
  blocked(`network connection to ${name}`);
}

// Both net.connect/createConnection and HTTP agents eventually use Socket.connect.
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  const [options, callback] = normalized;
  // Unix sockets are local, including the API fixture's temporary socket.
  if (options.path) return socketConnect.call(this, normalized);
  checkHost(options.host);
  const lookup = options.lookup ?? dns.lookup;
  return socketConnect.call(this, {...options, lookup(host, lookupOptions, done) {
    lookup(host, lookupOptions, (error, result, family) => {
      if (!error) {
        for (const address of Array.isArray(result) ? result.map(item => item.address) : [result]) checkHost(address);
      }
      done(error, result, family);
    });
  }}, callback);
};

const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const first = args[0];
  const options = typeof first === 'object' ? first :
    (typeof args[1] === 'object' ? args[1] : args[2]) ?? {};
  if (!options.path) checkHost(options.host ?? (typeof args[1] === 'string' ? args[1] : undefined));
  return tlsConnect.apply(this, args);
};

const fetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'data:') checkHost(url.hostname);
  return fetch.call(this, input, options);
};

function checkCommand(file, args, options = {}) {
  // Node runs filtered regressions, test workers, and the disconnected managed-teams entry point.
  if (!options.shell && file === process.execPath) return;
  // The team and sync tests load the real YAML parser via the installed CLI's location.
  if (!options.shell && file === 'which' && args.length === 1 && args[0] === 'yaml') return;
  const searchPath = options.env?.PATH?.split(path.delimiter)[0];
  // The native dispatch test launches its temporary receipt-printing stub through PATH.
  if (!options.shell && file === 'openmausbot' && process.argv[1] === path.join(root, 'tests/dispatch.test.cjs') &&
      searchPath?.startsWith(path.join(os.tmpdir(), 'biz-bin-')) &&
      fs.existsSync(path.join(searchPath, file))) return;
  const cwd = (file === 'git' || file === 'bash') && options.cwd && fs.realpathSync(options.cwd);
  // Git writes are confined to temporary repositories. The source scan lists checkout files.
  if (!options.shell && file === 'git' &&
      ((cwd?.startsWith(temp + path.sep) && localGit.has(args[0])) ||
       (cwd === root && args.join(' ') === 'ls-files -z --cached --others --exclude-standard'))) return;
  // This script test injects a fake node executable at the front of PATH.
  if (!options.shell && file === 'bash' && cwd === root && args.length === 1 &&
      args[0] === 'extensions/biz/connect.sh' && options.env?.PATH?.startsWith(path.join(os.tmpdir(), 'biz-connect-'))) return;
  blocked(`subprocess ${file}`);
}

// All asynchronous child_process entry points converge here, with shell invocations normalized.
const childSpawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
  const pathEntry = options.envPairs?.find(entry => entry.startsWith('PATH='));
  checkCommand(options.file, options.args.slice(1), {cwd: options.cwd, env: {PATH: pathEntry?.slice(5)}});
  if (options.file === process.execPath) options.args.splice(1, 0, '--require', __filename);
  return childSpawn.call(this, options);
};

for (const method of ['spawnSync', 'execFileSync']) {
  const run = cp[method];
  cp[method] = function (file, args, options) {
    if (!Array.isArray(args)) [args, options] = [[], args ?? options];
    checkCommand(file, args, options);
    // Keep the guard in standalone Node fixtures even if they replace their environment.
    if (file === process.execPath) args = ['--require', __filename, ...args];
    return run.call(this, file, args, options);
  };
}

cp.execSync = function () {
  blocked('shell subprocess (execSync)');
};
syncBuiltinESMExports();
