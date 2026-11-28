'use strict';
// A fake for the command runner of managed-setup.cjs (`setup({run, sleep})`): the synchronous
// `run(command, args, {env, cwd, timeout})` that returns stdout or throws like `execFileSync`
// (an Error with `status`, `stdout`, `stderr`). No mise, sops, git or node child is ever started.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// Machine paths and secrets are built at runtime so no file of this repository spells one out
// (tests/machine-paths.test.cjs scans every file).
const slash = (...parts) => ['', ...parts].join('/');
const MACHINE_PATHS = Object.freeze([
  path.join(os.homedir(), 'projects', 'demo', 'framework', 'scripts', 'dist.cjs'),
  slash('Users', 'ana', 'work', 'secrets.enc.yaml'),
  slash('home', 'ana', '.config', 'mise', 'config.toml'),
  slash('private', 'tmp', 'dist-1a2b', 'bundle.tar'),
]);
const SECRETS = Object.freeze({
  ageSecret: ['AGE-SECRET-', 'KEY-', '1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ'].join(''),
  assignment: ['pass', 'word=hunter2'].join(''),
  bearer: ['Bear', 'er abc.def-123'].join(''),
});
/** Stderr text carrying every path and secret above: a tool crashing the way real ones do. */
const leakyStderr = () => `mise ERROR failed to run ${MACHINE_PATHS[0]}\n  at ${MACHINE_PATHS[1]} and ${MACHINE_PATHS[2]} (cache ${MACHINE_PATHS[3]})\n` +
  `${SECRETS.assignment} ${SECRETS.bearer} ${SECRETS.ageSecret}\n`;

const AGE_KEY = `age1${'q'.repeat(58)}`;

/** `dist:plan --json` answer (the shape managed-setup checks: `files` and `extensions` required). */
const PLAN = (over = {}) => ({mode: 'update', current: 'v1', version: 'v2', up_to_date: false,
  files: {added: [], replaced: [{path: 'a', local_edits: ['committed']}, {path: 'b', local_edits: []}], removed: []},
  secrets: {names: ['API_KEY'], decryptable: true}, extensions: {added: ['sext']}, bots: {added: ['Shared']}, mcp_servers: {added: ['fromsetup']}, ...over});

/** `dist:publish --dry-run --json` answer (what `publishPreviewOf` accepts). */
const DRY_RUN = (over = {}) => ({transport: 'biz', base: 'v3', version: 'v4', changed: true, inputs: 'a'.repeat(64),
  files: {added: ['a.md'], modified: ['b.md'], removed: []}, files_count: 234, bots: {added: [], modified: ['Chief'], removed: []},
  extensions: {added: [], removed: []}, mcp_servers: {added: [], removed: []}, secrets: ['API_KEY'],
  recipients: {count: 2, changed: false}, framework: '0.1.15', checks: {gitleaks: 'ok', machine_paths: 'ok'}, ...over});

const PUBLISHED = (version = 'v3', files = 234) => `published ${version} (${files} files) to Biz`;

// ---- matchers: what a call is ---------------------------------------------------------------
const has = (...tokens) => call => tokens.every(token => call.args.includes(token));
/** Named matchers for `runner.next(CMD.publish, ...)`. Strings and RegExps work too (tested on `call.argv`). */
const CMD = Object.freeze({
  key: has('dist:key'), plan: has('dist:plan'), add: has('dist:add'), update: has('dist:update'), status: has('dist:status'),
  dryRun: has('dist:publish', '--dry-run'), publish: call => call.args.includes('dist:publish') && !call.args.includes('--dry-run'),
  snapshot: call => call.argv.includes('snapshot'), extRemove: has('ext:remove'),
  sopsDecrypt: call => call.command === 'sops' && call.args[0] === 'decrypt', sopsUnset: call => call.command === 'sops' && call.args[0] === 'unset',
  git: call => call.command === 'git', marketplace: call => call.command === 'node' && String(call.args[0]).endsWith('marketplace.cjs'),
  botArchitect: call => call.command === 'node' && String(call.args[0]).endsWith('bot-architect.cjs'),
});
const matcher = match => typeof match === 'function' ? match : match instanceof RegExp ? call => match.test(call.argv) : call => call.argv.includes(String(match));

// ---- response specs (what a call does) -------------------------------------------------------
// A spec is: a string (stdout of a success), an Error (thrown as is), a function(call) returning a
// spec, or an object `{status, stdout, stderr}` (status 0 or absent = success).

/** Fail like `execFileSync`: throws an Error with `status`, `stdout`, `stderr`. */
const exit = (status, {stdout = '', stderr = '', message} = {}) => ({status, stdout, stderr, message});
/** Exit 3: Biz has a newer version (`dist:publish`; its JSON explanation is on stdout like the framework's). */
const staleBase = ({base = 'v2', current = 'v3'} = {}) => exit(3, {stdout: JSON.stringify({stale_base: true, base, current}), stderr: `stale_base: Biz is at ${current}, built on ${base}`});
/** Exit 5: this publisher never installed the setup Biz has. */
const setupNotInstalled = () => exit(5, {stdout: JSON.stringify({stale_base: true, base: 'none', current: 'v3'}), stderr: 'setup not installed'});
/** Exit 4: `dist:update` hit a merge conflict (pair with `project.writeMergeConflicts([...])`). */
const mergeConflict = () => exit(4, {stderr: 'merge conflict: resolve with --ours/--theirs'});
/** Exit 1 with a failed publish check: gitleaks / machine_paths (`dist:publish --dry-run --json`). */
const failedChecks = (checks = {gitleaks: 'ok', machine_paths: 'failed'}, error = 'machine-specific paths found') =>
  exit(1, {stdout: JSON.stringify({checks, error}), stderr: error});
/** mise cannot write its state (a sandbox, a read-only home). Exit 1. */
const notPermitted = (command = 'mise') => exit(1, {stderr: `${command} ERROR failed to write the state file: Operation not permitted (os error 1)\n`});
/** An old framework without `--dry-run`: it takes the flag as a version and refuses it. */
const oldFramework = () => exit(2, {stderr: 'error: invalid version "--dry-run"\nusage: dist:publish [version]'});
/** A failure whose stderr is full of machine paths and secrets (see MACHINE_PATHS, SECRETS). */
const leaky = (status = 1) => exit(status, {stderr: leakyStderr()});
/** Success whose stdout is not JSON, for commands that must print JSON. */
const nonJson = (text = 'warning: something unexpected\nnot json at all\n') => text;

// ---- the runner ------------------------------------------------------------------------------
/**
 * @param {object} [options]
 * @param {string} [options.root] project root; when set, `ext:remove <id>` deletes `.copier-answers.ext-<id>.yml` like the real task
 * @param {string} [options.key] age public key `dist:key` prints (AGE_KEY)
 * @param {object} [options.plan] `dist:plan` JSON (PLAN())
 * @param {object|string} [options.dryRun] `dist:publish --dry-run` JSON, or a raw string (DRY_RUN())
 * @param {string} [options.published] line `dist:publish` prints (PUBLISHED())
 * @param {string} [options.installed] version `dist:status` reports ('v3')
 * @param {string} [options.tree] output of `git rev-parse` ('tree1')
 * @param {string[]|null} [options.sopsKeys] names `sops decrypt` lists; null = it cannot be read (every name is tried)
 * @param {object} [options.bots] `bot-architect.cjs` list answer ({bots:[{id:'b1',name:'Mine'}], planId:'p1'})
 */
function fakeRunner({root, key = AGE_KEY, plan = PLAN(), dryRun = DRY_RUN(), published = PUBLISHED(), installed = 'v3', tree = 'tree1', sopsKeys = null,
  bots = {bots: [{id: 'b1', name: 'Mine'}], planId: 'p1'}} = {}) {
  const calls = [], sleeps = [], queues = [], overrides = [];

  const defaults = call => {
    if (CMD.git(call)) return call.args[0] === 'rev-parse' ? `${tree}\n` : '';
    if (CMD.key(call)) return `${key}\n`;
    if (CMD.plan(call)) return `log line\n${JSON.stringify(plan)}`;
    if (CMD.status(call)) return `Distribution: Biz (managed setup)\nVersion:      ${installed}\nLatest:       ${installed}\n`;
    if (CMD.dryRun(call)) return typeof dryRun === 'string' ? dryRun : `log\n${JSON.stringify(dryRun)}`;
    if (CMD.publish(call)) return `log\n${published}\n`;
    if (CMD.extRemove(call)) {
      if (root) fs.rmSync(path.join(root, `.copier-answers.ext-${call.args.at(-1)}.yml`), {force: true});
      return '';
    }
    if (CMD.sopsDecrypt(call) && sopsKeys) return JSON.stringify(Object.fromEntries(sopsKeys.map(name => [name, 'v'])));
    if (CMD.marketplace(call)) throw Error('not in the catalog');
    if (CMD.botArchitect(call)) return JSON.stringify(bots);
    return ''; // dist:add, dist:update, snapshot, sops unset, mcp-config, ...
  };

  function settle(spec, call) {
    if (typeof spec === 'function') return settle(spec(call), call);
    if (spec instanceof Error) throw spec;
    if (typeof spec === 'number') spec = exit(spec);
    if (typeof spec === 'string' || spec === undefined) return spec ?? '';
    const {status = 0, stdout = '', stderr = '', message} = spec;
    if (!status) return stdout;
    throw Object.assign(Error(message ?? `Command failed: ${call.argv}\n${stderr}`), {status, stdout, stderr, signal: null});
  }

  const runner = {
    /** The `run` seam: `setup({run: runner.run})`. */
    run(command, args = [], options = {}) {
      const call = {index: calls.length, command, args: [...args], argv: [command, ...args].join(' '), env: {...options.env}, cwd: options.cwd, options: {...options}};
      calls.push(call);
      for (const queue of queues) if (queue.items.length && queue.test(call)) return settle(queue.items.shift(), call);
      for (const rule of overrides) if (rule.test(call)) return settle(rule.spec, call);
      return settle(defaults(call), call);
    },
    /** The `sleep` seam of managed-setup (the `dist:key` retry pause): records, never waits. */
    sleep: ms => { sleeps.push(ms); },
    /** Every call so far: `{index, command, args, argv, env, cwd, options}`. `argv` is the joined command line. */
    calls,
    sleeps,
    /** Calls matching `match` (a CMD matcher, a string found in argv, a RegExp, or a function). No argument: all. */
    callsTo: match => match === undefined ? [...calls] : calls.filter(matcher(match)),
    count: match => runner.callsTo(match).length,
    last: match => runner.callsTo(match).at(-1),
    /** Queue answers for the next matching calls, one each, in order; afterwards the defaults apply again. */
    next(match, ...specs) { queues.push({test: matcher(match), items: [...specs]}); return runner; },
    /** Replace the answer of every matching call from now on (unless a `next` queue still has items). */
    always(match, spec) { overrides.unshift({test: matcher(match), spec}); return runner; },
    /** Forget the call log and any queued/overridden answers (state like `plan` stays). */
    reset() { calls.length = 0; sleeps.length = 0; queues.length = 0; overrides.length = 0; return runner; },
  };
  return runner;
}

Object.assign(fakeRunner, {CMD, exit, staleBase, setupNotInstalled, mergeConflict, failedChecks, notPermitted, oldFramework, leaky, nonJson});

module.exports = {fakeRunner, CMD, exit, staleBase, setupNotInstalled, mergeConflict, failedChecks, notPermitted, oldFramework, leaky, nonJson,
  leakyStderr, MACHINE_PATHS, SECRETS, AGE_KEY, PLAN, DRY_RUN, PUBLISHED};
