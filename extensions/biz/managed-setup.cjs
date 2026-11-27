// Biz-managed setup (ADR 0134): the organization's framework setup, published to Biz by an
// admin, reaches every member's project. One credential does it all: the person's
// `framework_access` profile grant, stored by the explicit connect (auth.cjs) and read by the
// framework's distribution commands through `profile-token.cjs`.
//
//   preview()  read what Biz offers, register this installation's age key, plan the
//              distribution (`dist:plan`) and add what the policy removes ("compatible mode").
//   apply()    snapshot, `dist:add`/`dist:update`, policy removals, managed teams.
//   sync()     the `ext-biz-sync` workflow: same etag does nothing; a change is reconciled
//              automatically; an unreadable or empty answer pauses and removes nothing.
//   freeze()   a person who lost access keeps read-only access and loses the delivered secrets.
//
// State lives in `.data/ext/biz/setup.json` (never in git). Commands run through an injected
// `run`, so tests need neither the framework nor a network.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const auth = require('./auth.cjs');

const STATE = 'setup.json';
const NOTICES = 20;
const SECRETS_FILE = 'state/dist/secrets.sops.yaml';
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ID = /^[a-z][a-z0-9-]{1,30}$/;
// The extension itself is never removed: it is what keeps the setup in sync.
const KEEP_EXTENSIONS = new Set(['biz']);
const ERRORS = ['no_access', 'not_connected', 'reauthorize_required', 'frozen', 'access_required', 'admin_required', 'preview_changed',
  'dist_failed', 'key_unavailable', 'invalid_age_key', 'biz_access_unavailable', 'invalid_biz_access_decision', 'profile_required',
  'unexpected_response', 'busy', 'preview_stale', 'preview_required', 'framework_update_required', 'publish_failed'];
// Errors the publish flow answers with as they are; anything else becomes `publish_failed` with the command's stderr tail.
const PUBLISH_CODES = new Set([...ERRORS, 'stale_base', 'setup_not_installed', 'merge_conflict']);
const KEY_RETRY_MS = 1500;
const DETAIL = 300;

/** Run a command in the project and return its stdout; stderr goes to the caller's log. */
function defaultRun(command, args, {env = process.env, cwd = process.cwd(), timeout = 900000} = {}) {
  // stderr is captured (a failure carries it as `error.stderr`) and still passed on to the caller's log.
  try {
    const stdout = execFileSync(command, args, {cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 16 * 1024 * 1024});
    return stdout;
  } catch (error) {
    if (error.stderr) process.stderr.write(String(error.stderr));
    throw error;
  }
}

/** Block the thread for a moment (the retry of a command that failed once; nothing else is waiting on it). */
const pauseFor = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The last part of a failed command's stderr, without anything that looks like a secret. */
function stderrTail(error, max = DETAIL) {
  const text = String(error?.stderr ?? '').replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/AGE-SECRET-KEY-[A-Z0-9]+/g, '[redacted]')
    .replace(/\b((?:token|password|passwd|secret|api[_-]?key|authorization|bearer)\w*\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? `...${text.slice(-max)}` : text;
}

const stateFile = env => path.join(auth.dataDir(env), STATE);

function readState(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(env), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function writeState(env, state) {
  const file = stateFile(env);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), {mode: 0o600});
  fs.renameSync(tmp, file);
}

/** Whether this project is frozen (the person lost access). Read by both policy checks. */
function isFrozen(env = process.env) {
  try { return readState(env).frozen === true; } catch { return false; }
}

const names = value => (Array.isArray(value) ? value : []).filter(item => typeof item === 'string');
const union = (...lists) => [...new Set(lists.flatMap(names))];
const digestOf = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** JSON with sorted keys, so the same data always has the same digest. */
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

const LIST_MAX = 2000, ITEM_MAX = 300;
const list = value => (Array.isArray(value) ? value : []).filter(item => typeof item === 'string').map(item => item.slice(0, ITEM_MAX)).slice(0, LIST_MAX);
const isLists = (value, keys) => value && typeof value === 'object' && keys.every(key => Array.isArray(value[key]));

/** The `dist:publish --dry-run --json` answer, checked and reduced to the fields the panel shows; null when it is not that. */
function publishPreviewOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.version !== 'string' || typeof raw.changed !== 'boolean') return null;
  if (!isLists(raw.files, ['added', 'modified', 'removed']) || !isLists(raw.bots, ['added', 'modified', 'removed'])
    || !isLists(raw.extensions, ['added', 'removed']) || !isLists(raw.mcp_servers, ['added', 'removed']) || !Array.isArray(raw.secrets)) return null;
  if (!raw.recipients || !Number.isFinite(raw.recipients.count)) return null;
  const group = (value, keys) => Object.fromEntries(keys.map(key => [key, list(value[key])]));
  const checks = {};
  for (const [name, state] of Object.entries(raw.checks && typeof raw.checks === 'object' ? raw.checks : {}).slice(0, 20)) {
    if (typeof state === 'string') checks[name.slice(0, 40)] = state.slice(0, 40);
  }
  return {transport: typeof raw.transport === 'string' ? raw.transport.slice(0, 20) : null, base: typeof raw.base === 'string' ? raw.base.slice(0, 40) : null,
    version: raw.version.slice(0, 40), changed: raw.changed, files: group(raw.files, ['added', 'modified', 'removed']),
    files_count: Number.isFinite(raw.files_count) ? raw.files_count : 0, bots: group(raw.bots, ['added', 'modified', 'removed']),
    extensions: group(raw.extensions, ['added', 'removed']), mcp_servers: group(raw.mcp_servers, ['added', 'removed']), secrets: list(raw.secrets),
    recipients: {count: raw.recipients.count, changed: raw.recipients.changed === true}, framework: typeof raw.framework === 'string' ? raw.framework.slice(0, 40) : null, checks};
}

/** The JSON object a command printed (tolerating log lines before it). */
function jsonOf(output) {
  const text = String(output);
  const at = text.search(/^\{/m);
  if (at < 0) throw Error('unexpected_response');
  try { return JSON.parse(text.slice(at)); } catch { throw Error('unexpected_response'); }
}

/** What is installed here, from files only. */
function inspect(root, {yaml} = {}) {
  const read = file => { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return null; } };
  yaml ??= require('./team.cjs').yamlModule();
  const extensions = fs.readdirSync(root, {withFileTypes: true}).filter(e => e.isFile() && /^\.copier-answers\.ext-[a-z][a-z0-9-]{1,30}\.yml$/.test(e.name))
    .map(e => {
      const answers = yaml.parse(read(e.name) || '') || {};
      return {id: e.name.slice('.copier-answers.ext-'.length, -4), src: typeof answers._src_path === 'string' ? answers._src_path : null};
    });
  let mcpServers = [];
  try { mcpServers = Object.keys(JSON.parse(read('project/mcp.json') || '{}').mcpServers || {}); } catch { /* none */ }
  let declared = [];
  try {
    const team = yaml.parse((read('project/bots/team.yaml') || '').replaceAll('${FYSO_ROOT}', '__ROOT__')) || {};
    declared = Array.isArray(team.bots) ? team.bots.filter(b => typeof b?.name === 'string') : [];
  } catch { /* no team file */ }
  let managed = new Set();
  try {
    for (const record of Object.values(JSON.parse(read('project/bots/managed.json') || '{}').owners || {})) {
      for (const bot of Object.keys(record?.bots || {})) managed.add(bot.toLowerCase());
    }
  } catch { managed = new Set(); }
  let teams = {};
  try { teams = JSON.parse(read('project/biz-teams.json') || '{}').departments || {}; } catch { /* none */ }
  return {extensions, mcpServers, bots: declared.map(b => ({name: b.name, protected: b.chiefOfStaff === true || b.chief === true})), managed, teams};
}

/**
 * Compatible mode: only what contradicts the person's policy is removed; everything else local
 * stays. No policy from Biz, or an admin, removes nothing. `setup` is what the distribution
 * brought (by name); `catalog` tells catalog extensions and MCP servers from custom ones.
 */
function removalsOf({report, local, setup, catalog}) {
  const none = {extensions: [], mcp_servers: [], bots: [], teams: []};
  if (!report?.policy || report.admin) return none;
  const caps = new Set(report.capabilities);
  const out = structuredClone(none);
  // Extensions and MCP servers: `any` keeps all; `catalog` keeps the setup's and the catalog's; none keeps the setup's.
  const scan = (kind, items, kept, inCatalog) => {
    if (caps.has(`framework:${kind}:any`)) return [];
    const catalogOnly = caps.has(`framework:${kind}:catalog`);
    return items.filter(item => !kept.has(item.id) && !(catalogOnly && inCatalog(item)))
      .map(item => ({id: item.id, reason: catalogOnly ? 'not_in_catalog' : 'not_allowed'}));
  };
  out.extensions = scan('extensions', local.extensions.filter(e => !KEEP_EXTENSIONS.has(e.id)),
    new Set(setup.extensions), item => catalog.extension(item));
  out.mcp_servers = scan('mcp_servers', local.mcpServers.map(id => ({id})), new Set(setup.mcp_servers), item => catalog.mcp(item.id));
  // Teams of departments the person no longer has: their bots go.
  const held = new Set((report.departments || []).flatMap(d => (d.teams || []).map(t => t.id)));
  const teamBots = new Set();
  const delivered = Object.entries(local.teams).filter(([, record]) => record?.managed && record.equipoId);
  // The team ids of the report must be the ones the delivery recorded; if none matches, they are not
  // comparable and no team is judged lost.
  const comparable = held.size === 0 || delivered.some(([, record]) => held.has(record.equipoId));
  for (const [department, record] of comparable ? delivered : []) {
    if (held.has(record.equipoId)) continue;
    const bots = names(record.bots);
    for (const bot of bots) teamBots.add(bot.toLowerCase());
    out.teams.push({department, equipoId: record.equipoId, bots});
  }
  // Own bots without `framework:bots:create`: not the setup's, not managed by Biz, not a protected bot.
  if (!caps.has('framework:bots:create')) {
    const kept = new Set(setup.bots.map(b => b.toLowerCase()));
    out.bots = local.bots.filter(b => !b.protected && !kept.has(b.name.toLowerCase()) && !local.managed.has(b.name.toLowerCase()) && !teamBots.has(b.name.toLowerCase()))
      .map(b => ({name: b.name, reason: 'not_allowed'}));
  }
  return out;
}

const removalCount = removals => Object.values(removals).reduce((total, items) => total + items.length, 0);

function setup({env = process.env, root = process.cwd(), access, store, run = defaultRun, now = Date.now, deliverTeams, catalog, yaml, sleep = pauseFor} = {}) {
  access ??= require('./project-access.cjs').projectAccess({env});
  store ??= auth.store({env});
  const sh = (command, args, options = {}) => run(command, args, {env, cwd: root, ...options});
  const mise = (...args) => sh('mise', args);
  const installed = () => fs.existsSync(path.join(root, '.copier-answers.dist.yml'));
  catalog ??= {
    // A catalog extension resolves by id to the source it was installed from (project/marketplaces.yaml).
    extension: item => {
      try { return item.src && sh('node', ['framework/scripts/marketplace.cjs', 'resolve', item.id]).split('\t')[0].trim() === item.src; } catch { return false; }
    },
    // The framework's own MCP servers are the catalog; a project server is custom.
    mcp: id => { try { return id in (JSON.parse(fs.readFileSync(path.join(root, 'framework/mcp.json'), 'utf8')).mcpServers || {}); } catch { return false; } },
  };

  const save = patch => { const state = {...readState(env), ...patch}; writeState(env, state); return state; };
  /** A notice for the panel (and the workflow log); the same one is not repeated back to back. */
  function notify(kind, text) {
    const state = readState(env), last = (state.notices || []).at(-1);
    console.error(`Fyso Biz setup: ${kind}: ${text}`);
    if (last && last.kind === kind && last.text === text) return;
    save({notices: [...(state.notices || []), {at: new Date(now()).toISOString(), kind, text}].slice(-NOTICES)});
  }
  // A project that never started has no bots or memory in OpenMausBot yet: git is the state (as dist.sh
  // does before the first `up`), so only the commit step runs. Once started, the full snapshot is required.
  const snapshot = () => fs.existsSync(path.join(root, '.data/omb/.fyso-restored'))
    ? mise('run', 'snapshot') : sh('mise', ['exec', '--', 'framework/scripts/snapshot.sh', 'commit']);

  async function token() {
    try { return await store.profileAccessToken(); } catch { throw Error('not_connected'); }
  }

  /** The access report, refusing the answers a change must never rest on. */
  async function readReport(bearer) {
    const report = await access.report(bearer);
    if (report.reauthorizeRequired) throw Error('reauthorize_required');
    return report;
  }

  // `dist:key` prints this installation's PUBLIC key. It can fail while a snapshot runs, so it is tried twice.
  const ageKey = () => {
    let failure = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) sleep(KEY_RETRY_MS);
      try {
        const key = mise('run', '-q', 'dist:key').split('\n').map(line => line.trim()).reverse().find(line => /^age1[0-9a-z]+$/.test(line));
        if (key) return key;
        failure = null;
      } catch (error) { failure = error; }
    }
    throw Object.assign(Error('key_unavailable'), failure ? {cause: failure, detail: describe(failure)} : {});
  };

  /** What `dist:add`/`dist:update` would do; null when Biz has no setup. */
  function planFor(report) {
    if (!report.setup) return null;
    const plan = jsonOf(mise('run', '-q', 'dist:plan', ...(installed() ? [] : ['biz']), '--json'));
    if (!plan || typeof plan !== 'object' || !plan.files || !plan.extensions) throw Error('unexpected_response');
    return plan;
  }

  /** The names the distribution brought (earlier deliveries and this plan) the policy keeps. */
  function setupNames(state, plan) {
    const delivered = state.delivered || {}, contents = plan?.contents;
    // `contents` is the full set of the incoming version, so something local that is identical to the
    // setup's is still the setup's. Without it (an older framework) only what was delivered is known.
    const from = key => contents && Array.isArray(contents[key]) ? union(contents[key], plan[key]?.added)
      : union(delivered[key], plan?.[key]?.added);
    return {extensions: from('extensions'), mcp_servers: from('mcp_servers'), bots: from('bots')};
  }

  async function preview({register = true} = {}) {
    const bearer = await token();
    const report = await readReport(bearer);
    // Biz also answers `frozen` to someone who never had access: that is "no access yet", not a revocation.
    if (report.frozen) throw Error(readState(env).version ? 'frozen' : 'no_access');
    if (!report.capabilities.includes('app:panel') && !report.admin) throw Error('access_required');
    // Even before any setup exists: a publisher needs its own key registered before its first publish.
    if (register) await access.registerRecipient(bearer, ageKey());
    const plan = planFor(report), state = readState(env);
    const removals = removalsOf({report, local: inspect(root, {yaml}), setup: setupNames(state, plan), catalog});
    const result = {setup: report.setup, admin: report.admin, upToDate: plan ? plan.up_to_date === true : true, plan, removals,
      replaced: plan ? plan.files.replaced.filter(f => f.local_edits?.length) : [], removalCount: removalCount(removals)};
    return {...result, digest: digestOf({etag: report.etag, version: report.setup?.version, files: plan?.files, ext: plan?.extensions, removals})};
  }

  function removeExtension(id) { mise('run', 'ext:remove', id); }

  function removeMcpServer(name) {
    const file = path.join(root, 'project/mcp.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete data.mcpServers[name];
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    sh('git', ['add', '--', 'project/mcp.json']);
    sh('git', ['commit', '-q', '-m', `biz: remove MCP server ${name} (policy)`, '--', 'project/mcp.json']);
    sh('mise', ['exec', '--', 'node', 'framework/scripts/mcp-config.cjs']);
  }

  /** Bot Architect's own plan/apply (exact id), never a panel shortcut. */
  function removeBot(name) {
    const architect = (params) => jsonOf(sh('node', ['framework/scripts/bot-architect.cjs'], {env: {...env, ...params}}));
    const bot = architect({OP: 'list'}).bots.find(b => b.name.toLowerCase() === name.toLowerCase());
    if (!bot) return;
    const planned = architect({OP: 'plan', ACTION: 'delete', BOT_ID: bot.id});
    architect({OP: 'apply', PLAN_ID: planned.planId});
  }

  /** Apply each removal; one that fails is reported and never stops the rest. */
  function removeAll(removals) {
    const done = {extensions: [], mcp_servers: [], bots: [], teams: []}, failed = [];
    const attempt = (kind, id, fn) => { try { fn(); done[kind].push(id); } catch (error) { failed.push({kind, id, error: String(error.message).slice(0, 200)}); } };
    for (const item of removals.extensions) attempt('extensions', item.id, () => removeExtension(item.id));
    for (const item of removals.mcp_servers) attempt('mcp_servers', item.id, () => removeMcpServer(item.id));
    // The bots of a lost department are removed by their names, once teams no longer record them as managed.
    const bots = [...removals.bots.map(b => b.name), ...removals.teams.flatMap(t => t.bots)];
    for (const name of [...new Set(bots)]) attempt('bots', name, () => removeBot(name));
    done.teams = removals.teams.map(t => t.department);
    return {done, failed};
  }

  /** Names of delivered secrets this key could not decrypt, as recorded by dist.cjs. */
  function pendingSecretNames() {
    try { return JSON.parse(fs.readFileSync(path.join(root, '.data/dist/secrets-pending.json'), 'utf8')).names || []; } catch { return []; }
  }

  /** Install or update the distribution, then the policy removals and the managed teams. */
  async function reconcile(report, bearer, {planned, selfPublished = false} = {}) {
    snapshot();
    const plan = planned === undefined ? planFor(report) : planned;
    let installedNow = false;
    // After an unfreeze the delivered secrets are gone although the version is current: take the setup again.
    const restore = readState(env).restoreSecrets === true || (readState(env).secretsPending || []).length > 0;
    if (plan && (plan.up_to_date !== true || restore) && !selfPublished) {
      try { mise('run', installed() ? 'dist:update' : 'dist:add', ...(installed() ? [] : ['biz'])); } catch (error) { throw error.status === 4 ? conflictError() : Object.assign(Error('dist_failed'), {cause: error}); }
      installedNow = true;
    }
    // The framework records secrets it could not decrypt (this key is not a recipient yet); the next etag retries.
    const secretsPending = pendingSecretNames();
    const before = readState(env);
    const delivered = before.delivered || {};
    // What is flagged as Biz's teams is read first: delivering them unflags the departments that are gone.
    const local = inspect(root, {yaml});
    let teams = null;
    try { teams = deliverTeams ? await deliverTeams({bearer}) : await defaultTeams(bearer); } catch (error) { teams = {error: String(error.message).slice(0, 100)}; }
    if (!teams || teams.skipped || teams.error || teams.managed === false) local.teams = {};
    const removals = removalsOf({report, local, setup: setupNames(before, plan), catalog});
    const removed = removeAll(removals);
    const secrets = plan?.secrets?.names;
    save({connected: true, etag: report.etag, version: report.setup?.version ?? null, appliedAt: new Date(now()).toISOString(), frozen: false, paused: null, restoreSecrets: false, secretsPending,
      lastCapabilities: report.capabilities.length,
      delivered: {extensions: union(delivered.extensions, plan?.extensions?.added), mcp_servers: union(delivered.mcp_servers, plan?.mcp_servers?.added),
        bots: union(delivered.bots, plan?.bots?.added), secrets: union(delivered.secrets, secrets)}});
    return {version: report.setup?.version ?? null, installed: installedNow, removed: removed.done, failed: removed.failed, teams, replaced: plan && installedNow ? plan.files.replaced.filter(f => f.local_edits?.length).length : 0,
      // The framework keeps a patch of uncommitted edits only.
      patched: plan && installedNow ? plan.files.replaced.filter(f => f.local_edits?.includes('uncommitted')).length : 0, secretsPending};
  }

  /** Managed teams with the agent grant (Biz MCP) and the profile token as the access guard. */
  async function defaultTeams(bearer) {
    const biz = require('./biz.cjs');
    let credential;
    try { credential = await biz.token(env); } catch { return {skipped: 'agent_not_connected'}; }
    const mcp = biz.client(env.FYSO_BIZ_URL || '', credential.token, fetch, {oauth: credential.oauth});
    return require('./managed-teams.cjs').deliver({mcp, root, env, access, credential: bearer});
  }

  /** Confirm: what the person saw is what is applied, or nothing is. */
  async function apply({digest}) {
    const current = await preview({register: false});
    if (!digest || current.digest !== digest) throw Error('preview_changed');
    const bearer = await token();
    const report = await readReport(bearer);
    const result = await reconcile(report, bearer, {planned: current.plan});
    notify('connected', `Applied setup ${result.version || '(none)'}`);
    return result;
  }

  /** Cancel (or disconnect): the grant goes, local files stay as they are. */
  function disconnect() {
    store.profileLogout();
    fs.rmSync(stateFile(env), {force: true});
    return {connected: false};
  }

  /** `dist:publish`: exit 3 (`stale_base`) means Biz has a newer version than this project was built on. */
  function distPublish(version) {
    try { return mise('run', 'dist:publish', ...(version ? [version] : [])); } catch (error) {
      if (error.status === 3 || /stale_base/.test(`${error.message}${error.stderr || ''}`)) throw Object.assign(Error('stale_base'), {cause: error});
      // Exit 5: this publisher never installed the setup Biz already has; install it first.
      if (error.status === 5) throw Object.assign(Error('setup_not_installed'), {cause: error});
      throw error;
    }
  }

  /** The `merge_conflict` error of a `dist:update` that exited 4, with the files `merge-conflicts.json` lists. */
  function conflictError() {
    let files = [];
    try { files = names(JSON.parse(fs.readFileSync(path.join(env.FYSO_DATA || path.join(root, '.data'), 'dist', 'merge-conflicts.json'), 'utf8')).files); } catch { /* unreadable list */ }
    return Object.assign(Error('merge_conflict'), {files});
  }

  /** `dist:update` on a publisher merges; exit 4 is a conflict that left the project unchanged. */
  function distMerge({ours = [], theirs = []} = {}) {
    // Conflicts are resolved per file by name: `--ours` keeps the project's, `--theirs` takes the published one.
    const named = list => names(list).filter(f => f && !f.startsWith('-') && f.length <= 300).slice(0, 500);
    const [keep, take] = [named(ours), named(theirs)];
    try {
      const output = mise('run', 'dist:update', ...(keep.length ? ['--ours', ...keep] : []), ...(take.length ? ['--theirs', ...take] : []));
      if (readState(env).publishPaused) save({publishPaused: null});
      return output;
    } catch (error) {
      throw error.status === 4 ? conflictError() : error;
    }
  }

  /** What a failed command says, short and without secrets: its first line plus the tail of its stderr. */
  function describe(error) {
    const first = String((error.cause || error).message || '').split('\n')[0].slice(0, 120);
    const tail = stderrTail(error.cause || error);
    return tail && !first.includes(tail) ? `${first} (${tail})` : first;
  }

  /** The tree of the committed project: what `dist:publish` exports comes from it, so a change to it makes a preview stale. */
  function treeOf() { try { return String(sh('git', ['rev-parse', 'HEAD^{tree}'])).trim(); } catch { return ''; } }

  /** `dist:publish --dry-run --json`: what a publish would do, checked. Nothing is sent to Biz. */
  function dryRun() {
    let output;
    try { output = mise('run', '-q', 'dist:publish', '--dry-run', '--json'); } catch (error) {
      // The framework explains these on stdout as JSON: Biz is ahead (exit 3, also when this project never installed the setup).
      let answer = null;
      try { answer = jsonOf(error.stdout || ''); } catch { /* not JSON: an old framework or a crash */ }
      if (error.status === 3 || answer?.stale_base === true || /stale_base/.test(`${error.stdout || ''}${error.stderr || ''}`)) {
        throw Object.assign(Error(answer && (answer.base === 'none' || answer.base === null) ? 'setup_not_installed' : 'stale_base'), {cause: error});
      }
      // A failed check (gitleaks, machine paths): shown, with nothing to confirm.
      if (answer?.checks && typeof answer.checks === 'object' && Object.values(answer.checks).includes('failed')) {
        const checks = Object.fromEntries(Object.entries(answer.checks).slice(0, 20).filter(([, state]) => typeof state === 'string').map(([name, state]) => [name.slice(0, 40), state.slice(0, 40)]));
        const blocked = {blocked: true, version: null, changed: false, checks, error: typeof answer.error === 'string' ? stderrTail({stderr: answer.error}) : ''};
        return {...blocked, digest: digestOf(blocked)};
      }
      if (error.status === 5) throw Object.assign(Error('setup_not_installed'), {cause: error});
      // A framework without the flag takes it as a version number and refuses it.
      if (/dry-run|invalid version|unknown (option|flag|argument)|unrecognized|usage/i.test(`${error.stderr || ''}${error.message || ''}`)) throw Object.assign(Error('framework_update_required'), {cause: error});
      throw error;
    }
    let raw;
    try { raw = jsonOf(output); } catch { throw Error('framework_update_required'); }
    const preview = publishPreviewOf(raw);
    if (!preview) throw Error('unexpected_response');
    return {...preview, digest: digestOf({preview, tree: treeOf()})};
  }

  async function adminBearer() {
    const bearer = await token();
    if (!(await readReport(bearer)).admin) throw Error('admin_required');
    return bearer;
  }

  /** Anything not coded is reported to the panel and the notices with the command's stderr tail. */
  async function reporting(fn) {
    try { return await fn(); } catch (error) {
      if (error.message === 'key_unavailable' && error.detail) notify('publish_failed', `Could not publish: ${error.detail}`.slice(0, 500));
      if (PUBLISH_CODES.has(error.message)) throw error;
      const detail = error.detail || describe(error);
      notify('publish_failed', `Could not publish: ${detail}`.slice(0, 500));
      throw Object.assign(Error('publish_failed'), {cause: error, detail});
    }
  }

  /** The preview before publishing: the framework's dry run, with the digest `publish` will ask for. */
  async function publishPreview() {
    return reporting(async () => {
      const bearer = await adminBearer();
      await access.registerRecipient(bearer, ageKey());
      return dryRun();
    });
  }

  /** Publish what the preview showed (same version, same digest), or nothing. */
  async function publish({version, digest} = {}) {
    if (typeof version !== 'string' || !version || typeof digest !== 'string' || !digest) throw Error('preview_required');
    return reporting(async () => {
      const bearer = await adminBearer();
      await access.registerRecipient(bearer, ageKey());
      const current = dryRun();
      if (current.blocked || !current.changed || current.version !== version || current.digest !== digest) throw Error('preview_stale');
      return publishNow(bearer, version);
    });
  }

  /** `dist:publish` and the record of it (version, notice). */
  async function publishNow(bearer, version, {reason} = {}) {
    const output = String(distPublish(version));
    await afterPublish(bearer, output, {reason});
    return {output: output.trim().split('\n').slice(-5).join('\n'), version: readState(env).selfPublished ?? null};
  }

  /** "Update and merge": bring the latest version into this publisher's project (never discarding its edits), then publish again. */
  async function mergeAndPublish(choices) {
    return reporting(async () => {
      const bearer = await adminBearer();
      snapshot();
      distMerge(choices);
      await access.registerRecipient(bearer, ageKey());
      return publishNow(bearer);
    });
  }

  /** The version `dist:status` reports as installed (a publisher records what it published). */
  function installedVersion() {
    try { return /^Version:\s+(\S+)/m.exec(String(mise('run', '-q', 'dist:status')))?.[1] ?? null; } catch { return null; }
  }

  /**
   * The publisher's own project already is the setup: remember it so the next sync does not replace its files.
   * The version comes from what `dist:publish` printed (`published v3 (234 files) to Biz`), not from Biz's
   * report, which can still be a cached older answer.
   */
  async function afterPublish(bearer, output, {reason} = {}) {
    const printed = /published (v\d+(?:\.\d+){0,2}) \((\d+) files/.exec(String(output || ''));
    const version = printed?.[1] ?? installedVersion();
    access.invalidate?.(bearer);
    const report = await readReport(bearer);
    const recipients = await access.recipients(bearer);
    const published = version ?? report.setup?.version ?? null;
    save({publishPaused: null, selfPublished: published, etag: report.etag, version: published, recipientsEtag: recipients.etag});
    // "No changes since the last version; nothing published" is not a publication.
    if (printed) notify('published', `Published setup ${printed[1]} (${printed[2]} files)${reason ? `: ${reason}` : ''}`);
    return published;
  }

  /** Names of the secrets the distribution delivered: the keys of its (encrypted) file, plus what earlier plans listed. */
  function deliveredSecrets(state) {
    let fromFile = [];
    try {
      const yamlLib = yaml ?? require('./team.cjs').yamlModule();
      fromFile = Object.keys(yamlLib.parse(fs.readFileSync(path.join(root, SECRETS_FILE), 'utf8')) || {}).filter(k => k !== 'sops');
    } catch { /* no delivered file */ }
    return union(state.delivered?.secrets, fromFile).filter(n => NAME.test(n));
  }

  /** Delete the delivered secrets from secrets.enc.yaml (and the delivered copy). Returns the names still present. */
  function deleteSecrets(secretNames) {
    const keyFile = env.SOPS_AGE_KEY_FILE || env.MISE_SOPS_AGE_KEY_FILE || env.FYSO_COMPOSIO_AGE_KEY_FILE;
    const sopsEnv = {...env, ...(keyFile ? {SOPS_AGE_KEY_FILE: keyFile} : {})};
    const left = [];
    // A name that is already gone (an earlier freeze, a second freeze after an unfreeze) is done, not pending:
    // `sops unset` fails on it. When the file cannot be listed, every name is tried.
    let present = null;
    try { present = new Set(Object.keys(JSON.parse(sh('sops', ['decrypt', '--output-type', 'json', 'secrets.enc.yaml'], {env: sopsEnv})))); } catch { /* try them all */ }
    for (const name of secretNames) {
      if (present && !present.has(name)) continue;
      try { sh('sops', ['unset', 'secrets.enc.yaml', `["${name}"]`], {env: sopsEnv}); } catch { left.push(name); }
    }
    const delivered = path.join(root, SECRETS_FILE);
    if (fs.existsSync(delivered)) { fs.rmSync(delivered); }
    for (const file of ['secrets.enc.yaml', SECRETS_FILE]) { try { sh('git', ['add', '-A', '--', file]); } catch { /* untracked or absent */ } }
    try { sh('git', ['diff', '--cached', '--quiet', '--', 'secrets.enc.yaml', SECRETS_FILE]); } catch {
      try { sh('git', ['commit', '-q', '-m', 'biz: remove the secrets delivered by the setup (access revoked)', '--', 'secrets.enc.yaml', SECRETS_FILE]); } catch { /* the next sync retries */ }
    }
    return left;
  }

  function freeze() {
    const state = readState(env), secretNames = deliveredSecrets(state);
    const left = deleteSecrets(secretNames);
    save({frozen: true, frozenAt: state.frozenAt || new Date(now()).toISOString(), pendingSecrets: left, paused: null, etag: null});
    if (!state.frozen) notify('frozen', `Access revoked: read-only, ${secretNames.length - left.length} delivered secret(s) removed`);
    return {frozen: true, removedSecrets: secretNames.length - left.length, pendingSecrets: left.length};
  }

  /** Stop without touching anything: record why and tell the person once. */
  function pause(reason) {
    save({paused: {reason, at: new Date(now()).toISOString()}});
    notify('paused', `Sync paused: ${reason}. Nothing was changed.`);
    return {status: 'paused', reason};
  }

  /** An answer that must not drive removals: empty where it cannot be, or without the setup it had. */
  function suspicious(report, state) {
    if (report.frozen) return false;
    if (!report.admin && report.capabilities.length === 0 && (state.lastCapabilities || 0) > 0) return true;
    return state.version && !report.setup;
  }

  async function sync() {
    const state = readState(env);
    if (!state.connected && !state.frozen) return {status: 'disconnected'};
    let bearer, report;
    try {
      bearer = await token();
      report = await readReport(bearer);
    } catch (error) {
      return pause(error.message === 'reauthorize_required' ? 'reauthorize_required' : error.message === 'not_connected' ? 'not_connected' : 'biz_unreachable');
    }
    if (report.frozen && !state.version && !state.frozen) {
      // Never received a setup: nothing to freeze or delete, and nothing to apply.
      if (!state.noAccess) save({noAccess: true});
      return {status: 'no_access'};
    }
    if (state.noAccess) save({noAccess: false});
    if (report.frozen) {
      if (state.frozen && !(state.pendingSecrets || []).length) return {status: 'frozen', changed: false};
      return {status: 'frozen', changed: true, ...freeze()};
    }
    if (suspicious(report, state)) return pause('unexpected_empty_response');
    if (state.frozen) {
      // Access is back: register the key again and take the setup as a first delivery.
      save({frozen: false, etag: null, pendingSecrets: [], frozenAt: null, restoreSecrets: true});
      notify('unfrozen', 'Access restored: the setup is applied again, secrets included when the published version was encrypted for your key (otherwise they arrive with the next version).');
      if (report.setup) await access.registerRecipient(bearer, ageKey()).catch(() => {});
    }
    const result = {status: 'noop'};
    if (report.admin) {
      try {
        const recipients = await access.recipients(bearer);
        if (!readState(env).publishPaused && ((report.recipientsPending || 0) > 0 || recipients.etag !== readState(env).recipientsEtag)) {
          // The publisher's own key counts as pending until registered: register it, or every run would publish.
          await access.registerRecipient(bearer, ageKey());
          let output;
          try { output = distPublish(); } catch (error) {
            if (error.message !== 'stale_base') throw error;
            // Biz has a newer version: merge it once (the admin's edits are kept), then publish again.
            snapshot();
            distMerge();
            output = distPublish();
          }
          await afterPublish(bearer, output, {reason: 'recipients changed'});
          report = await readReport(bearer);
          result.status = 'published';
        }
      } catch (error) {
        if (error.message === 'setup_not_installed') notify('setup_not_installed', 'Automatic publishing needs the current setup installed first: open the Setup tab and connect.');
        else if (error.message === 'merge_conflict') {
          save({publishPaused: {files: error.files, at: new Date(now()).toISOString()}});
          notify('merge_conflict', `Automatic publishing paused: the latest setup conflicts with local edits in ${error.files.join(', ') || 'some files'}. Nothing was changed; resolve them and publish from the panel.`);
        } else notify('publish_failed', `Could not publish: ${error.detail || describe(error)}`.slice(0, 500));
      }
    }
    const latest = readState(env);
    if (latest.etag === report.etag) {
      if (latest.paused) save({paused: null});
      return result;
    }
    try {
      const applied = await reconcile(report, bearer, {selfPublished: Boolean(report.setup) && latest.selfPublished === report.setup.version});
      const removedCount = Object.values(applied.removed).reduce((n, items) => n + items.length, 0);
      notify('applied', `Setup ${applied.version || '(none)'} applied${removedCount ? `; removed ${removedCount} item(s) not allowed by policy` : ''}${applied.replaced ? `; ${applied.replaced} locally edited file(s) replaced${applied.patched ? ' (a patch is kept in .data/dist)' : ''}` : ''}${applied.secretsPending?.length ? `; secrets pending until the publisher adds your key: ${applied.secretsPending.join(', ')}` : ''}`);
      return {...result, status: 'applied', ...applied};
    } catch (error) {
      if (error.message === 'merge_conflict') {
        // A publisher whose edits conflict with a newer setup: nothing was changed; pause auto-publishing until the person resolves it.
        if (!readState(env).publishPaused) save({publishPaused: {files: error.files, at: new Date(now()).toISOString()}});
        notify('merge_conflict', `The latest setup conflicts with local edits in ${error.files.join(', ') || 'some files'}. Nothing was changed; resolve them in the Setup tab.`);
        return {status: 'conflict', files: error.files};
      }
      notify('failed', `Sync failed (${error.message}); the next run tries again`);
      return {status: 'failed', error: error.message};
    }
  }

  /** What the panel shows. */
  function status() {
    const state = readState(env), grant = store.profileStatus();
    return {connected: Boolean(state.connected) && grant.connected, grant: grant.connected, frozen: state.frozen === true, paused: state.paused || null,
      publishPaused: state.publishPaused || null, version: state.version ?? null, selfPublished: state.selfPublished ?? null, noAccess: state.noAccess === true, appliedAt: state.appliedAt ?? null, notices: state.notices || [], pendingSecrets: (state.pendingSecrets || []).length, secretsPending: state.secretsPending || []};
  }

  // One change at a time: the sync workflow and the panel must not interleave.
  const exclusive = fn => async (...args) => {
    const lock = path.join(auth.dataDir(env), 'setup.lock');
    fs.mkdirSync(path.dirname(lock), {recursive: true, mode: 0o700});
    try { fs.mkdirSync(lock); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (now() - fs.statSync(lock).mtimeMs <= 30 * 60 * 1000) throw Error('busy');
      fs.rmSync(lock, {recursive: true, force: true}); fs.mkdirSync(lock);
    }
    try { return await fn(...args); } finally { fs.rmSync(lock, {recursive: true, force: true}); }
  };

  return {preview, apply: exclusive(apply), disconnect, publishPreview: exclusive(publishPreview), publish: exclusive(publish), mergeAndPublish: exclusive(mergeAndPublish), sync: exclusive(sync), status, freeze, readReport, removalsOf};
}

module.exports = {setup, stderrTail, publishPreviewOf, removalsOf, inspect, readState, writeState, isFrozen, ERRORS, jsonOf};

if (require.main === module) (async () => {
  const command = process.argv[2];
  const managed = setup();
  if (command === 'status') return console.log(JSON.stringify(managed.status()));
  if (command !== 'sync') throw Error('usage: managed-setup.cjs <sync|status>');
  if (!process.env.FYSO_BIZ_ACCESS_ORGANIZATION) return console.log(JSON.stringify({status: 'disabled'}));
  console.log(JSON.stringify(await managed.sync()));
})().catch(error => {
  console.error(`Fyso Biz setup: ${ERRORS.includes(error.message) ? error.message : 'sync_failed'}`);
  process.exitCode = 1;
});
