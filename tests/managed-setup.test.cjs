const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {setup, removalsOf, readState, writeState, isFrozen, stderrTail, redactPaths, collapseNotices} = require('../extensions/biz/managed-setup.cjs');
const {projectAccess} = require('../extensions/biz/project-access.cjs');
const {projectPolicy} = require('../extensions/biz/project-policy.cjs');
const {mcpPolicy} = require('../extensions/biz/mcp-policy.cjs');

const {harness: sharedHarness, fakeBiz, CMD, WINDOWS, miniYaml} = require('./helpers/index.cjs');

const KEY = 'age1' + 'q'.repeat(58);
const POLICY = {preset: 'cuidado', extensions: 0, mcp_servers: 0, bots: 0, read: 1, write: 0, shell: 0, publish: 0, ai: 0};
const SETUP = {version: 'v2', etag: 's2', publishedAt: null, size: 1, sha256: 'x'};

function report(over = {}) {
  return {capabilities: ['app:panel'], admin: false, departments: [], policy: POLICY, reauthorizeRequired: false, setup: SETUP, etag: 'e1', ...over};
}

// A project directory with some local extensions, MCP servers and bots.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-setup-'));
  const data = path.join(root, '.data');
  fs.mkdirSync(path.join(root, 'project/bots'), {recursive: true});
  fs.mkdirSync(path.join(root, 'state/dist'), {recursive: true});
  for (const id of ['biz', 'foo', 'bar']) fs.writeFileSync(path.join(root, `.copier-answers.ext-${id}.yml`), `_src_path: gh:x/${id}\n`);
  fs.writeFileSync(path.join(root, 'project/mcp.json'), JSON.stringify({mcpServers: {mine: {url: 'http://x'}, fromsetup: {url: 'http://y'}}}));
  fs.writeFileSync(path.join(root, 'project/bots/team.yaml'), 'bots:\n  - name: Mine\n  - name: Shared\n');
  fs.writeFileSync(path.join(root, 'state/dist/secrets.sops.yaml'), 'API_KEY: ENC[x]\nOTHER: ENC[y]\nsops: {}\n');
  return {root, env: {FYSO_DATA: data, FYSO_BIZ_ACCESS_ORGANIZATION: 'acme', FYSO_BIZ_URL: 'https://biz.test'}};
}

function harness({reports, plan, recipients = {recipients: [], etag: 'r1'}, teams = {managed: true, teams: []}, tokenFails = false, sopsKeys = null, dry = DRY(), published = 'published v3 (234 files) to Biz'} = {}) {
  const p = project();
  const calls = [];
  const state = {registered: [], grant: true, tree: 'tree1', dry, published, current: [].concat(reports || report())[0]};
  const access = {
    report: async () => {
      if (state.current instanceof Error) throw state.current;
      return state.current;
    },
    registerRecipient: async (_t, key) => { state.registered.push(key); },
    recipients: async () => recipients,
  };
  const store = {
    profileAccessToken: async () => { if (tokenFails) throw Error('not_connected'); return 'profile-token'; },
    profileStatus: () => ({connected: state.grant}),
    profileLogout: () => { state.grant = false; },
  };
  const exits = {};
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    for (const [needle, queue] of Object.entries(exits)) if (args.includes(needle) && queue.length) {
      const next = queue.shift(), {status = next, stderr = '', stdout = ''} = typeof next === 'object' ? next : {};
      if (status) throw Object.assign(Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr}`), {status, stderr, stdout});
    }
    if (cmd === 'git' && args[0] === 'rev-parse') return `${state.tree}\n`;
    if (cmd === 'mise' && args.includes('dist:status')) return `Distribution: Biz (managed setup)\nVersion:      ${state.installed || 'v3'}\nLatest:       v3\n`;
    if (cmd === 'mise' && args.includes('--dry-run')) return typeof state.dry === 'string' ? state.dry : `log\n${JSON.stringify(state.dry)}`;
    if (cmd === 'mise' && args.includes('dist:publish')) return `log\n${state.published}\n`;
    if (cmd === 'sops' && args[0] === 'decrypt' && sopsKeys) return JSON.stringify(Object.fromEntries(sopsKeys.map(k => [k, 'v'])));
    if (cmd === 'mise' && args.includes('dist:key')) return `${KEY}\n`;
    if (cmd === 'mise' && args.includes('dist:plan')) return `log line\n${JSON.stringify(plan)}`;
    if (cmd === 'mise' && args.includes('ext:remove')) { fs.rmSync(path.join(p.root, `.copier-answers.ext-${args.at(-1)}.yml`)); return ''; }
    if (cmd === 'node' && args[0].endsWith('marketplace.cjs')) throw Error('not in the catalog');
    if (cmd === 'node' && args[0].endsWith('bot-architect.cjs')) return JSON.stringify({bots: [{id: 'b1', name: 'Mine'}], planId: 'p1'});
    return '';
  };
  const s = setup({env: p.env, root: p.root, access, store, run, yaml: miniYaml, deliverTeams: async () => teams, now: () => 1000, sleep: () => {}});
  return {...p, s, calls, state, access, store, exits};
}

const DRY = (over = {}) => ({transport: 'biz', base: 'v3', version: 'v4', changed: true, files: {added: ['a.md'], modified: ['b.md'], removed: []}, files_count: 234,
  bots: {added: [], modified: ['Chief'], removed: []}, extensions: {added: [], removed: []}, mcp_servers: {added: [], removed: []}, secrets: ['API_KEY'],
  recipients: {count: 2, changed: false}, framework: '0.1.15', checks: {gitleaks: 'ok', machine_paths: 'ok'}, ...over});

const PLAN = () => ({mode: 'update', current: 'v1', version: 'v2', up_to_date: false, files: {added: [], replaced: [{path: 'a', local_edits: ['committed']}, {path: 'b', local_edits: []}], removed: []},
  secrets: {names: ['API_KEY'], decryptable: true}, extensions: {added: ['sext']}, bots: {added: ['Shared']}, mcp_servers: {added: ['fromsetup']}});

test('compatible mode removes only what contradicts the policy', () => {
  const local = {extensions: [{id: 'biz', src: null}, {id: 'foo', src: 'a'}, {id: 'sext', src: 'b'}], mcpServers: ['mine', 'fromsetup'],
    bots: [{name: 'Mine'}, {name: 'Shared'}, {name: 'Managed'}], managed: new Set(['managed']),
    teams: {Ventas: {managed: true, equipoId: 'e1', bots: ['Managed']}, Soporte: {managed: true, equipoId: 'e2', bots: []}}};
  const setupNames = {extensions: ['sext'], mcp_servers: ['fromsetup'], bots: ['Shared']};
  const catalog = {extension: item => item.id === 'foo', mcp: () => false};
  const base = {local, setup: setupNames, catalog};
  const none = removalsOf({...base, report: report({capabilities: ['app:panel'], departments: [{id: 'd', teams: [{id: 'e2'}]}]})});
  assert.deepEqual(none.extensions, [{id: 'foo', reason: 'not_allowed'}]);
  assert.deepEqual(none.mcp_servers, [{id: 'mine', reason: 'not_allowed'}]);
  assert.deepEqual(none.bots, [{name: 'Mine', reason: 'not_allowed'}]);
  assert.deepEqual(none.teams.map(t => t.department), ['Ventas']);
  const catalogOnly = removalsOf({...base, report: report({capabilities: ['framework:extensions:catalog', 'framework:mcp_servers:catalog', 'framework:bots:create']})});
  assert.deepEqual(catalogOnly.extensions, []);
  assert.deepEqual(catalogOnly.mcp_servers.map(i => i.id), ['mine']);
  assert.deepEqual(catalogOnly.bots, []);
  const any = removalsOf({...base, report: report({capabilities: ['framework:extensions:any', 'framework:mcp_servers:any']})});
  assert.deepEqual([any.extensions, any.mcp_servers], [[], []]);
  // No policy, or an admin: nothing is removed.
  assert.equal(JSON.stringify(removalsOf({...base, report: report({policy: null})})), JSON.stringify({extensions: [], mcp_servers: [], bots: [], teams: []}));
  assert.deepEqual(removalsOf({...base, report: report({admin: true})}).extensions, []);
  // Team ids of another space than the delivered ones are not comparable: no team is judged lost.
  assert.deepEqual(removalsOf({...base, report: report({departments: [{id: 'd', teams: [{id: 'zzz'}]}]})}).teams, []);
});

test('connect: the preview lists everything, registers the key and changes nothing; confirm applies it', async () => {
  const h = harness({plan: PLAN()});
  const preview = await h.s.preview();
  assert.deepEqual(h.state.registered, [KEY]);
  assert.equal(preview.replaced.length, 1);
  assert.deepEqual(preview.removals.extensions.map(e => e.id).sort(), ['bar', 'foo']);
  assert.deepEqual(preview.removals.mcp_servers.map(e => e.id), ['mine']);
  assert.ok(preview.removalCount >= 4);
  assert.ok(!h.calls.some(c => /dist:(add|update)|ext:remove|snapshot/.test(c)), 'a preview changes nothing');
  assert.deepEqual(readState(h.env), {});
  await assert.rejects(h.s.apply({digest: 'stale'}), {message: 'preview_changed'});
  const result = await h.s.apply({digest: preview.digest});
  const order = h.calls.map(c => c.match(/snapshot|dist:add|ext:remove/)?.[0]).filter(Boolean);
  assert.deepEqual(order, ['snapshot', 'dist:add', 'ext:remove', 'ext:remove']);
  assert.deepEqual(result.removed.extensions.sort(), ['bar', 'foo']);
  const state = readState(h.env);
  assert.equal(state.connected, true);
  assert.equal(state.etag, 'e1');
  assert.deepEqual(state.delivered.secrets, ['API_KEY']);
  assert.equal(fs.existsSync(path.join(h.root, '.copier-answers.ext-biz.yml')), true, 'the extension itself stays');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.root, 'project/mcp.json'))).mcpServers, {fromsetup: {url: 'http://y'}});
});

test('connect: cancel disconnects and leaves the project as it was', async () => {
  const h = harness({plan: PLAN()});
  await h.s.preview();
  assert.deepEqual(h.s.disconnect(), {connected: false});
  assert.equal(h.state.grant, false);
  assert.deepEqual(readState(h.env), {});
  assert.ok(!h.calls.some(c => /dist:(add|update)|ext:remove|snapshot/.test(c)));
  assert.equal(fs.existsSync(path.join(h.root, '.copier-answers.ext-foo.yml')), true);
});

test('connect: a person without access, or frozen before any setup, connects nothing', async () => {
  await assert.rejects(harness({reports: report({capabilities: []}), plan: PLAN()}).s.preview(), {message: 'access_required'});
  const h = harness({reports: report({frozen: true, capabilities: []}), plan: PLAN()});
  await assert.rejects(h.s.preview(), {message: 'no_access'});
  assert.deepEqual(h.state.registered, []);
});

test('sync: the same etag does nothing; a changed one is snapshotted, applied and announced', async () => {
  const h = harness({plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.calls.length = 0;
  assert.equal((await h.s.sync()).status, 'noop');
  assert.deepEqual(h.calls, []);
  h.state.current = report({etag: 'e2'});
  const changed = await h.s.sync();
  assert.equal(changed.status, 'applied');
  assert.ok(h.calls[0].includes('snapshot'));
  assert.equal(readState(h.env).etag, 'e2');
  assert.equal(readState(h.env).notices.at(-1).kind, 'applied');
});

test('sync: a failed, empty or reauthorize answer pauses and removes nothing', async () => {
  for (const [bad, reason] of [[Error('biz_access_unavailable'), 'biz_unreachable'], [report({reauthorizeRequired: true}), 'reauthorize_required'],
    [report({capabilities: [], etag: 'x'}), 'unexpected_empty_response'], [report({setup: undefined, etag: 'x'}), 'unexpected_empty_response']]) {
    const h = harness({plan: PLAN()});
    await h.s.apply({digest: (await h.s.preview()).digest});
    h.state.current = bad;
    h.calls.length = 0;
    const before = fs.readdirSync(h.root).sort();
    const result = await h.s.sync();
    assert.deepEqual([result.status, result.reason], ['paused', reason]);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(fs.readdirSync(h.root).sort(), before);
    assert.equal(readState(h.env).paused.reason, reason);
  }
  const lost = harness({plan: PLAN()});
  await lost.s.apply({digest: (await lost.s.preview()).digest});
  lost.store.profileAccessToken = async () => { throw Error('boom'); };
  assert.equal((await lost.s.sync()).reason, 'not_connected');
});

test('sync: an admin publishes again when recipients are pending or changed', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN(), recipients: {recipients: [], etag: 'r2'}});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.state.current = report({admin: true, recipientsPending: 1});
  h.calls.length = 0;
  const result = await h.s.sync();
  assert.equal(result.status, 'published');
  assert.ok(h.calls.some(c => c.includes('dist:publish')));
  assert.equal(readState(h.env).recipientsEtag, 'r2');
  assert.ok(!h.calls.some(c => c.includes('dist:update')), 'the publisher does not replace its own files');
});

test('freeze: access revoked after a setup makes the project read-only and deletes the delivered secrets', async () => {
  const h = harness({plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  assert.equal(isFrozen(h.env), false);
  h.state.current = report({frozen: true, capabilities: [], etag: 'f'});
  h.calls.length = 0;
  const frozen = await h.s.sync();
  assert.equal(frozen.status, 'frozen');
  assert.equal(frozen.removedSecrets, 2);
  assert.deepEqual(h.calls.filter(c => c.startsWith('sops unset')).map(c => c.split(' ').slice(-1)[0]).sort(), ['["API_KEY"]', '["OTHER"]']);
  assert.equal(fs.existsSync(path.join(h.root, 'state/dist/secrets.sops.yaml')), false);
  assert.equal(isFrozen(h.env), true);
  // Everything else stays, and a second run stops without doing anything.
  assert.equal(fs.existsSync(path.join(h.root, '.copier-answers.ext-biz.yml')), true);
  h.calls.length = 0;
  assert.equal((await h.s.sync()).changed, false);
  assert.deepEqual(h.calls, []);
  // Biz returns frozen:false: unfrozen and reconciled again.
  h.state.current = report({etag: 'e9'});
  assert.equal((await h.s.sync()).status, 'applied');
  assert.equal(isFrozen(h.env), false);
});

test('freeze: frozen on a project that never received a setup is "no access yet": nothing is deleted', async () => {
  const h = harness({reports: report({frozen: true, capabilities: [], setup: undefined}), plan: PLAN()});
  require('../extensions/biz/managed-setup.cjs').writeState(h.env, {connected: true});
  const result = await h.s.sync();
  assert.equal(result.status, 'no_access');
  assert.deepEqual(h.calls, []);
  assert.equal(isFrozen(h.env), false);
  assert.equal(fs.existsSync(path.join(h.root, 'state/dist/secrets.sops.yaml')), true);
  assert.equal(h.s.status().noAccess, true);
});

test('frozen: the panel policy and the MCP policy are read-only', async () => {
  const env = {FYSO_WEB_DOMAIN: 'p.test', FYSO_BIZ_ACCESS_ORGANIZATION: 'acme'};
  const access = {report: async () => report({capabilities: ['app:panel', 'app:mcp', 'action:bots:list', 'workflow:x:run', 'mcp:tool:crear_nota', 'mcp:tool:listar_equipos'], frozen: true})};
  const profiles = {current: () => ({accessToken: 't'}), remote: () => ({accessToken: 't'})};
  const panel = projectPolicy({env, profiles, access});
  const ask = (method, p) => panel({headers: {'remote-user': 'a', 'x-fyso-policy-host': 'panel.p.test', 'x-fyso-policy-path': p, 'x-forwarded-method': method}}, {writeHead: s => ({end: () => s})});
  assert.equal(await ask('GET', '/api/omb/bots'), 204);
  assert.equal(await ask('POST', '/api/dagu/dags/x/start'), 403);
  const mcp = mcpPolicy({env, profiles, access});
  const call = tool => {
    const body = JSON.stringify({principal: {kind: 'delegated', extension: 'biz', digest: 'd'}, method: 'tools/call', tool});
    return mcp({async *[Symbol.asyncIterator]() { yield Buffer.from(body); }}, {writeHead: s => ({end: () => s})});
  };
  assert.equal(await call('listar_equipos'), 204);
  assert.equal(await call('crear_nota'), 403);

  // Biz sends `capabilities: []` when frozen: still read-only, not deny-all.
  const empty = {report: async () => report({capabilities: [], frozen: true})};
  const panel2 = projectPolicy({env, profiles, access: empty}), mcp2 = mcpPolicy({env, profiles, access: empty});
  const ask2 = (method, p) => panel2({headers: {'remote-user': 'a', 'x-fyso-policy-host': 'panel.p.test', 'x-fyso-policy-path': p, 'x-forwarded-method': method}}, {writeHead: s => ({end: () => s})});
  assert.equal(await ask2('GET', '/api/omb/bots'), 204);
  assert.equal(await ask2('POST', '/api/dagu/dags/x/start'), 403);
  const call2 = tool => {
    const body = JSON.stringify({principal: {kind: 'delegated', extension: 'biz', digest: 'd'}, method: 'tools/call', tool});
    return mcp2({async *[Symbol.asyncIterator]() { yield Buffer.from(body); }}, {writeHead: s => ({end: () => s})});
  };
  assert.equal(await call2('listar_equipos'), 204);
  assert.equal(await call2('crear_nota'), 403);
});

test('the patch notice appears only when there were uncommitted edits', async () => {
  const notice = async edits => {
    const h = harness({plan: {...PLAN(), files: {added: [], replaced: [{path: 'a', local_edits: edits}], removed: []}}});
    h.state.current = report({capabilities: ['app:panel', 'framework:extensions:any', 'framework:mcp_servers:any', 'framework:bots:create']});
    await h.s.apply({digest: (await h.s.preview()).digest});
    h.state.current = report({etag: 'e2', capabilities: ['app:panel', 'framework:extensions:any', 'framework:mcp_servers:any', 'framework:bots:create']});
    await h.s.sync();
    return h.s.status().notices.map(n => n.text).join('\n');
  };
  assert.match(await notice(['uncommitted']), /replaced \(a patch is kept in \.data\/dist\)/);
  assert.doesNotMatch(await notice(['committed']), /patch/);
});

test('secrets pending: shown in the status and retried when the etag changes', async () => {
  const plan = {...PLAN(), secrets: {names: ['API_KEY'], decryptable: false, pending: true}};
  const h = harness({plan});
  const pending = path.join(h.root, '.data/dist/secrets-pending.json');
  const updates = () => h.calls.filter(c => /dist:(add|update)/.test(c)).length;
  await h.s.apply({digest: (await h.s.preview()).digest});
  assert.deepEqual(h.s.status().secretsPending, []);
  // The framework records what it could not decrypt while installing.
  fs.mkdirSync(path.dirname(pending), {recursive: true});
  fs.writeFileSync(pending, JSON.stringify({names: ['API_KEY']}));
  plan.up_to_date = true;
  h.state.current = report({etag: 'e2'});
  await h.s.sync();
  assert.deepEqual(h.s.status().secretsPending, ['API_KEY']);
  // Same version, new etag, still pending: dist:update runs again.
  const before = updates();
  h.state.current = report({etag: 'e3'});
  await h.s.sync();
  assert.equal(updates(), before + 1);
  // The framework decrypted them this time and removed the record: no more retries.
  fs.rmSync(pending);
  h.state.current = report({etag: 'e4'});
  await h.s.sync();
  assert.deepEqual(h.s.status().secretsPending, []);
  assert.equal(updates(), before + 2);
  h.state.current = report({etag: 'e5'});
  await h.s.sync();
  assert.equal(updates(), before + 2, 'cleared: nothing to retry');
});

test('the access client sends the organization on every endpoint and reads setup, etag, pending and frozen', async () => {
  const env = {FYSO_BIZ_URL: 'https://biz.test', FYSO_BIZ_ACCESS_ORGANIZATION: 'acme'};
  const seen = [];
  const access = projectAccess({env, transport: async (url, {method}) => {
    assert.equal(url.origin, env.FYSO_BIZ_URL);
    assert.equal(url.searchParams.get('organization'), 'acme');
    seen.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith('/recipients')) return Response.json({recipients: [{}], etag: 'r'});
    if (url.pathname.endsWith('/recipient')) return new Response(null, {status: 204});
    return Response.json({capabilities: ['a'], setup: {version: 'v3', etag: 'z', published_at: 'now', size: 5, sha256: 'h'},
      etag: 'e', recipients_pending: 2, frozen: true});
  }});
  const r = await access.report('t');
  assert.deepEqual([r.setup.version, r.etag, r.recipientsPending, r.frozen], ['v3', 'e', 2, true]);
  await access.registerRecipient('t', KEY);
  assert.equal((await access.recipients('t')).etag, 'r');
  assert.deepEqual(seen, ['GET /oauth/framework-access', 'PUT /oauth/framework-access/recipient', 'GET /oauth/framework-access/recipients']);
});

test('the extension sets the distribution transport environment', () => {
  const toml = fs.readFileSync(path.join(__dirname, '../.config/mise/conf.d/ext-biz.toml.slotjinja'), 'utf8');
  for (const name of ['FYSO_DIST_BIZ_URL', 'FYSO_DIST_BIZ_ORGANIZATION', 'FYSO_DIST_BIZ_TOKEN_CMD']) assert.ok(toml.includes(name), name);
  assert.match(fs.readFileSync(path.join(__dirname, "../project/workflows/{{ 'ext-biz-sync.yaml' if biz_access_organization else '' }}.slotjinja"), 'utf8'), /\*\/15 \* \* \* \*/);
});

test('something local that is identical to the setup is the setup\'s: the policy never removes it', async () => {
  const withContents = {...PLAN(), contents: {extensions: ['foo', 'sext'], mcp_servers: ['mine', 'fromsetup'], bots: ['Mine', 'Shared']}};
  const h = harness({plan: withContents});
  const preview = await h.s.preview();
  assert.deepEqual(preview.removals.extensions.map(e => e.id), ['bar']);
  assert.deepEqual([preview.removals.mcp_servers, preview.removals.bots], [[], []]);
  await h.s.apply({digest: preview.digest});
  assert.equal(fs.existsSync(path.join(h.root, '.copier-answers.ext-foo.yml')), true);
  assert.equal(fs.existsSync(path.join(h.root, '.copier-answers.ext-bar.yml')), false);
  // Without `contents` (older framework) only what was delivered counts: foo is local.
  assert.deepEqual((await harness({plan: PLAN()}).s.preview()).removals.extensions.map(e => e.id).sort(), ['bar', 'foo']);
});

test('the panel status payload shows frozen and "no access yet"', async () => {
  const h = harness({plan: PLAN()});
  const {writeState} = require('../extensions/biz/managed-setup.cjs');
  writeState(h.env, {connected: true, version: 'v2', frozen: true, pendingSecrets: ['X']});
  assert.deepEqual([h.s.status().frozen, h.s.status().noAccess, h.s.status().pendingSecrets], [true, false, 1]);
  writeState(h.env, {connected: true, noAccess: true});
  assert.deepEqual([h.s.status().frozen, h.s.status().noAccess, h.s.status().version], [false, true, null]);
});

test('snapshot: a project that never started commits only; a started one takes the full snapshot', async () => {
  const fresh = harness({plan: PLAN()});
  await fresh.s.apply({digest: (await fresh.s.preview()).digest});
  const first = fresh.calls.find(c => c.includes('snapshot'));
  assert.equal(first, 'mise exec -- framework/scripts/snapshot.sh commit', 'OpenMausBot is not running before the first start');
  assert.ok(!fresh.calls.includes('mise run snapshot'));

  const started = harness({plan: PLAN()});
  fs.mkdirSync(path.join(started.root, '.data/omb'), {recursive: true});
  fs.writeFileSync(path.join(started.root, '.data/omb/.fyso-restored'), '');
  await started.s.apply({digest: (await started.s.preview()).digest});
  assert.ok(started.calls.includes('mise run snapshot'));
});

// A preview and its answer, as the panel posts them back.
const previewed = async h => { const p = await h.s.publishPreview(); return {version: p.version, digest: p.digest}; };

test('publish: the admin registers its own key before the first publish (Biz has no setup and no recipients yet)', async () => {
  const h = harness({reports: report({admin: true, setup: undefined, etag: 'e0'}), plan: PLAN()});
  const shown = await previewed(h);
  h.state.registered.length = 0; h.calls.length = 0;
  await h.s.publish(shown);
  assert.deepEqual(h.state.registered, [KEY]);
  const order = h.calls.map(c => c.match(/dist:key|dist:publish( v4)?$/)?.[0]).filter(Boolean);
  assert.deepEqual(order, ['dist:key', 'dist:publish v4'], 'the key is known to Biz before dist:publish asks for recipients');
  await assert.rejects(harness({plan: PLAN()}).s.publish({version: 'v4', digest: 'x'}), {message: 'admin_required'});
});

test('sync: an admin whose own key was pending registers it before republishing', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN(), recipients: {recipients: [], etag: 'r2'}});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.state.registered.length = 0;
  h.state.current = report({admin: true, recipientsPending: 1});
  assert.equal((await h.s.sync()).status, 'published');
  assert.deepEqual(h.state.registered, [KEY]);
});

test('sync: a policy-only change replaces no file, so it reports no replaced files', async () => {
  const h = harness({plan: PLAN()});
  const first = await h.s.apply({digest: (await h.s.preview()).digest});
  assert.equal(first.replaced, 1, 'an install replaces the locally edited file');
  h.state.current = report({etag: 'e2'});
  h.s = setup({env: h.env, root: h.root, access: h.access, store: h.store, now: () => 1000, deliverTeams: async () => ({managed: true, teams: []}),
    run: (cmd, args) => (cmd === 'mise' && args.includes('dist:plan') ? JSON.stringify({...PLAN(), up_to_date: true}) : cmd === 'node' && args[0].endsWith('marketplace.cjs') ? (() => { throw Error('x'); })() : '')});
  const result = await h.s.sync();
  assert.equal(result.status, 'applied');
  assert.equal(result.installed, false);
  assert.equal(result.replaced, 0);
  assert.ok(!readState(h.env).notices.at(-1).text.includes('replaced'));
});

test('unfreeze: the setup is taken again although the version is current (the delivered secrets were removed)', async () => {
  const h = harness({plan: {...PLAN(), up_to_date: true}});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.state.current = report({frozen: true, capabilities: [], etag: 'f'});
  assert.equal((await h.s.sync()).status, 'frozen');
  h.state.current = report({etag: 'e9'});
  h.calls.length = 0;
  assert.equal((await h.s.sync()).status, 'applied');
  assert.ok(h.calls.some(c => /dist:(add|update)/.test(c)), 'the secrets come back with the setup');
  assert.equal(readState(h.env).restoreSecrets, false);
  h.state.current = report({etag: 'e10'});
  h.calls.length = 0;
  await h.s.sync();
  assert.ok(!h.calls.some(c => /dist:(add|update)/.test(c)), 'a later change of an unchanged version installs nothing');
});

test('freeze: a secret that is already gone is not pending (second freeze after an unfreeze)', async () => {
  const h = harness({plan: PLAN(), sopsKeys: ['OTHER', 'FYSO_ADMIN_PASSWORD']});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.state.current = report({frozen: true, capabilities: [], etag: 'f'});
  const frozen = await h.s.sync();
  assert.deepEqual([frozen.removedSecrets, frozen.pendingSecrets], [2, 0]);
  assert.deepEqual(h.calls.filter(c => c.startsWith('sops unset')).map(c => c.split(' ').slice(-1)[0]), ['["OTHER"]']);
  assert.deepEqual(readState(h.env).pendingSecrets, []);
});

test('panel publish: stale_base asks for "update and merge", which merges and publishes again; a conflict stops', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  h.exits['dist:publish'] = [3];
  await assert.rejects(h.s.publishPreview(), {message: 'stale_base'});
  assert.ok(!h.calls.some(c => c.includes('dist:update')));
  // Update and merge: snapshot, merge, publish again.
  h.calls.length = 0;
  await h.s.mergeAndPublish();
  assert.deepEqual(h.calls.map(c => c.match(/snapshot|dist:update|dist:publish/)?.[0]).filter(Boolean), ['snapshot', 'dist:update', 'dist:publish']);
  // Conflict (exit 4): stop before publishing, with the files the framework listed.
  fs.mkdirSync(path.join(h.env.FYSO_DATA, 'dist'), {recursive: true});
  fs.writeFileSync(path.join(h.env.FYSO_DATA, 'dist/merge-conflicts.json'), JSON.stringify({base: 'v2', latest: 'v3', files: ['project/wiki/a.md']}));
  h.exits['dist:update'] = [4];
  h.calls.length = 0;
  await assert.rejects(h.s.mergeAndPublish(), error => error.message === 'merge_conflict' && error.files[0] === 'project/wiki/a.md');
  assert.ok(!h.calls.some(c => c.includes('dist:publish')));
});

test('sync: admin auto-republish merges once on stale_base and retries; a conflict pauses it with a notice', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN(), recipients: {recipients: [], etag: 'r2'}});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.state.current = report({admin: true, recipientsPending: 1});
  h.exits['dist:publish'] = [3, 0];
  h.calls.length = 0;
  assert.equal((await h.s.sync()).status, 'published');
  assert.deepEqual(h.calls.map(c => c.match(/dist:update|dist:publish/)?.[0]).filter(Boolean), ['dist:publish', 'dist:update', 'dist:publish']);
  // Conflict: paused, nothing else done, and the next runs do not try again.
  fs.mkdirSync(path.join(h.env.FYSO_DATA, 'dist'), {recursive: true});
  fs.writeFileSync(path.join(h.env.FYSO_DATA, 'dist/merge-conflicts.json'), JSON.stringify({files: ['x.md', 'y.md']}));
  h.state.current = report({admin: true, recipientsPending: 2, etag: 'e1'});
  require('../extensions/biz/managed-setup.cjs').writeState(h.env, {...readState(h.env), recipientsEtag: 'old'});
  h.exits['dist:publish'] = [3]; h.exits['dist:update'] = [4];
  h.calls.length = 0;
  await h.s.sync();
  assert.deepEqual(readState(h.env).publishPaused.files, ['x.md', 'y.md']);
  assert.equal(readState(h.env).notices.at(-1).kind, 'merge_conflict');
  assert.match(readState(h.env).notices.at(-1).text, /x\.md, y\.md/);
  h.calls.length = 0;
  await h.s.sync();
  assert.ok(!h.calls.some(c => c.includes('dist:publish') || c.includes('dist:update')));
  assert.deepEqual(h.s.status().publishPaused.files, ['x.md', 'y.md']);
});

test('publisher that never installed the setup (exit 5) is told to install it first; sync only notices', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN(), recipients: {recipients: [], etag: 'r2'}});
  h.exits['dist:publish'] = [5];
  await assert.rejects(h.s.publishPreview(), {message: 'setup_not_installed'});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.state.current = report({admin: true, recipientsPending: 1});
  h.exits['dist:publish'] = [5];
  await h.s.sync();
  assert.equal(readState(h.env).notices.some(n => n.kind === 'setup_not_installed'), true);
});

test('resolving conflicts passes --ours/--theirs by file name, then publishes, and clears a paused auto-republish', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  require('../extensions/biz/managed-setup.cjs').writeState(h.env, {...readState(h.env), publishPaused: {files: ['a.md']}});
  h.calls.length = 0;
  await h.s.mergeAndPublish({ours: ['a.md'], theirs: ['b.md', '--evil']});
  assert.ok(h.calls.some(c => c.endsWith('dist:update --ours a.md --theirs b.md')), h.calls.join('\n'));
  assert.ok(h.calls.at(-1).includes('dist:publish') || h.calls.some(c => c.includes('dist:publish')));
  assert.equal(readState(h.env).publishPaused ?? null, null);
  // Still conflicting (a file not named): exit 4, nothing published.
  h.exits['dist:update'] = [4];
  h.calls.length = 0;
  await assert.rejects(h.s.mergeAndPublish({ours: ['a.md']}), {message: 'merge_conflict'});
  assert.ok(!h.calls.some(c => c.includes('dist:publish')));
});

test('sync: a newer setup that conflicts with a publisher\'s edits pauses publishing with the files (not a generic failure)', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  fs.mkdirSync(path.join(h.env.FYSO_DATA, 'dist'), {recursive: true});
  fs.writeFileSync(path.join(h.env.FYSO_DATA, 'dist/merge-conflicts.json'), JSON.stringify({files: ['project/wiki/w.md']}));
  h.state.current = report({admin: true, etag: 'newer', setup: {...SETUP, version: 'v3'}});
  fs.writeFileSync(path.join(h.root, '.copier-answers.dist.yml'), '_commit: v2\n');
  h.exits['dist:update'] = [4];
  require('../extensions/biz/managed-setup.cjs').writeState(h.env, {...readState(h.env), recipientsEtag: 'r1'});
  const result = await h.s.sync();
  assert.deepEqual([result.status, result.files], ['conflict', ['project/wiki/w.md']]);
  assert.deepEqual(readState(h.env).publishPaused.files, ['project/wiki/w.md']);
  assert.equal(readState(h.env).notices.at(-1).kind, 'merge_conflict');
  assert.ok(!readState(h.env).notices.some(n => n.kind === 'failed'));
});

test('publish records the published version (not Biz\'s cached report), and adds a notice', async () => {
  // Biz's report is still the cached v2 right after the publish.
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  assert.equal(h.s.status().version, 'v2');
  const result = await h.s.publish(await previewed(h));
  assert.equal(result.version, 'v3');
  const state = readState(h.env);
  assert.deepEqual([state.version, state.selfPublished], ['v3', 'v3']);
  assert.deepEqual(state.notices.at(-1), {at: new Date(1000).toISOString(), kind: 'published', text: 'Published setup v3 (234 files)'});
  assert.deepEqual([h.s.status().version, h.s.status().selfPublished], ['v3', 'v3']);
});

test('publish: when the output has no version, dist:status says which one is installed; "nothing published" adds no notice', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN(), published: 'no changes since the last version; nothing published'});
  h.state.installed = 'v7';
  await h.s.publish(await previewed(h));
  assert.equal(readState(h.env).selfPublished, 'v7');
  assert.ok(!(readState(h.env).notices || []).some(n => n.kind === 'published'));
});

test('sync: the automatic republish records the new version and a notice too', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN(), recipients: {recipients: [], etag: 'r2'}});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.state.current = report({admin: true, recipientsPending: 1});
  await h.s.sync();
  const state = readState(h.env);
  assert.deepEqual([state.version, state.selfPublished], ['v3', 'v3']);
  assert.match(state.notices.at(-1).text, /^Published setup v3 \(234 files\)/);
  assert.equal(state.notices.at(-1).kind, 'published');
});

test('a failed publish says why: the notice carries the stderr tail, never a secret', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  const shown = await previewed(h);
  const noise = 'x'.repeat(900);
  h.exits['dist:publish'] = [0, {status: 1, stderr: `${noise}\nerror: nothing to publish AGE-SECRET-KEY-1ABCDEF token=abc123\n`}];
  await assert.rejects(h.s.publish(shown), error => error.message === 'publish_failed' && error.detail.length < 500);
  const notice = readState(h.env).notices.at(-1);
  assert.equal(notice.kind, 'publish_failed');
  assert.match(notice.text, /^Could not publish: Command failed: mise run dist:publish v4 \(/);
  assert.match(notice.text, /error: nothing to publish/);
  assert.doesNotMatch(notice.text, /AGE-SECRET-KEY|abc123/);
  assert.ok(notice.text.length < 500);
  assert.ok(stderrTail({stderr: 'a'.repeat(1000)}).length <= 303);
});

test('dist:key is tried twice: a transient failure still publishes, a persistent one reports stderr', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  const shown = await previewed(h);
  let slept = 0;
  const flaky = setup({env: h.env, root: h.root, access: h.access, store: h.store, now: () => 1000, deliverTeams: async () => ({managed: true, teams: []}), sleep: () => { slept++; },
    run: (cmd, args) => {
      h.calls.push([cmd, ...args].join(' '));
      if (args.includes('dist:key')) { if (!h.flaky) { h.flaky = 1; throw Object.assign(Error('Command failed: mise run -q dist:key'), {status: 1, stderr: 'database is locked'}); } return `${KEY}\n`; }
      if (args.includes('--dry-run')) return JSON.stringify(DRY());
      if (args.includes('dist:publish')) return 'published v4 (10 files) to Biz';
      if (args.includes('dist:status')) return 'Version: v4';
      return '';
    }});
  h.calls.length = 0;
  const preview = await flaky.publishPreview();
  assert.equal(preview.version, 'v4');
  assert.equal(slept, 1);
  assert.equal(h.calls.filter(c => c.includes('dist:key')).length, 2);
  // Persistent failure: both attempts fail, the notice names the command and the stderr.
  h.exits['dist:key'] = [{status: 1, stderr: 'database is locked'}, {status: 1, stderr: 'database is locked'}];
  await assert.rejects(h.s.publishPreview(), {message: 'key_unavailable'});
  assert.equal(h.calls.filter(c => c.includes('dist:key')).length, 4);
  assert.match(readState(h.env).notices.at(-1).text, /^Could not publish: Command failed: mise run -q dist:key \(database is locked\)/);
});

test('publish-preview: returns the validated dry run with a digest; nothing is published', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  const preview = await h.s.publishPreview();
  assert.equal(preview.version, 'v4');
  assert.equal(preview.base, 'v3');
  assert.deepEqual(preview.files.modified, ['b.md']);
  assert.deepEqual(preview.secrets, ['API_KEY']);
  assert.match(preview.digest, /^[0-9a-f]{64}$/);
  assert.ok(h.calls.some(c => c.endsWith('dist:publish --dry-run --json')));
  assert.ok(!h.calls.some(c => /dist:publish( v\d+)?$/.test(c)));
  assert.deepEqual(h.state.registered, [KEY]);
  // Only admins preview a publication.
  await assert.rejects(harness({plan: PLAN()}).s.publishPreview(), {message: 'admin_required'});
  // An answer that is not the contract fails closed.
  const bad = harness({reports: report({admin: true}), plan: PLAN(), dry: {version: 'v4', changed: true}});
  await assert.rejects(bad.s.publishPreview(), {message: 'unexpected_response'});
});

test('publish-preview: an older framework (no --dry-run) answers framework_update_required; exit 3 is stale_base', async () => {
  // It takes the flag as a version and refuses it.
  const old = harness({reports: report({admin: true}), plan: PLAN()});
  old.exits['--dry-run'] = [{status: 1, stderr: 'error: invalid version --dry-run (use 1, 2, … or 1.2.0)'}];
  await assert.rejects(old.s.publishPreview(), {message: 'framework_update_required'});
  // Plain text without an explicit flag rejection is an unexpected response.
  const quiet = harness({reports: report({admin: true}), plan: PLAN(), dry: 'no changes since the last version; nothing published'});
  await assert.rejects(quiet.s.publishPreview(), {message: 'unexpected_response'});
  const stale = harness({reports: report({admin: true}), plan: PLAN()});
  stale.exits['--dry-run'] = [3];
  await assert.rejects(stale.s.publishPreview(), {message: 'stale_base'});
});

test('publish needs the preview, and only what was shown is published (preview_stale otherwise)', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  await assert.rejects(h.s.publish(), {message: 'preview_required'});
  await assert.rejects(h.s.publish({version: 'v4'}), {message: 'preview_required'});
  const shown = await previewed(h);
  const published = () => h.calls.some(c => /dist:publish v\d+$/.test(c));
  // A commit that touches nothing published (a snapshot of memory, a log) does not make the preview stale.
  h.state.tree = 'tree2';
  h.state.dry = DRY();
  assert.equal((await h.s.publishPreview()).digest, shown.digest, 'the digest covers the preview only');
  await h.s.publish(shown);
  assert.ok(h.calls.includes('mise run dist:publish v4'));
  h.calls.length = 0;
  // The set of changes changed.
  const again = await previewed(h);
  h.state.dry = DRY({files: {added: ['a.md', 'c.md'], modified: [], removed: []}});
  await assert.rejects(h.s.publish(again), {message: 'preview_stale'});
  // A different version, or nothing left to publish.
  h.state.dry = DRY();
  await assert.rejects(h.s.publish({...await previewed(h), version: 'v9'}), {message: 'preview_stale'});
  h.state.dry = DRY({changed: false});
  await assert.rejects(h.s.publish(await previewed(h)), {message: 'preview_stale'});
  assert.equal(published(), false);
  // A published file changed since the preview (a file moved from modified to added): stale, nothing published.
  h.state.dry = DRY();
  const listed = await previewed(h);
  h.state.dry = DRY({files: {added: ['a.md'], modified: [], removed: []}});
  await assert.rejects(h.s.publish(listed), {message: 'preview_stale'});
  assert.equal(published(), false);
});

test('publish-preview: a failed check is shown (no version, nothing to confirm); a stale base that was never installed asks to install first', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  const failed = {transport: 'biz', base: 'v3', version: null, changed: null, checks: {gitleaks: 'failed', machine_paths: 'ok'}, error: 'gitleaks found 1 leak in a.md token=abc123'};
  h.exits['--dry-run'] = [{status: 1, stderr: 'usage: noise', stdout: JSON.stringify(failed)}];
  const blocked = await h.s.publishPreview();
  assert.deepEqual([blocked.blocked, blocked.changed, blocked.version, blocked.checks.gitleaks], [true, false, null, 'failed']);
  assert.match(blocked.error, /gitleaks found 1 leak in a\.md/);
  assert.doesNotMatch(blocked.error, /abc123/);
  // It cannot be published, even by posting its digest back.
  h.exits['--dry-run'] = [{status: 1, stdout: JSON.stringify(failed)}];
  await assert.rejects(h.s.publish({version: 'v4', digest: blocked.digest}), {message: 'preview_stale'});
  assert.ok(!h.calls.some(c => /dist:publish v\d+$/.test(c)));
  // Stale: Biz is ahead (JSON on stdout); never installed (base none) is the install-first flow.
  h.exits['--dry-run'] = [{status: 3, stdout: JSON.stringify({transport: 'biz', base: 'v3', current: 'v5', version: null, stale_base: true, changed: null})}];
  await assert.rejects(h.s.publishPreview(), {message: 'stale_base'});
  h.exits['--dry-run'] = [{status: 3, stdout: JSON.stringify({transport: 'biz', base: 'none', current: 'v5', version: null, stale_base: true, changed: null})}];
  await assert.rejects(h.s.publishPreview(), {message: 'setup_not_installed'});
  // Nothing changed: the version is the latest published one.
  h.state.dry = DRY({changed: false, version: 'v3'});
  assert.deepEqual([(await h.s.publishPreview()).changed, (await h.s.publishPreview()).version], [false, 'v3']);
});

// Machine paths are built from pieces: this repo's own files must not contain one (tests/machine-paths.test.cjs).
const SYSTEM_TMP = ['', 'var', 'folders', '68', 'abc', 'T'].join('/');
const USER_FILE = ['', 'Users', 'ana', 'work', 'x.json'].join('/');
const TMP_FAIL = dir => `Sync failed (Command failed: mise run snapshot\nmise ERROR Operation not permitted (os error 1) at path "${SYSTEM_TMP}/.tmp${dir}"\nmise ERROR Version: 2026.11.7\n); the next run tries again`;

test('machine paths are redacted: temporary ones become <tmp>, other absolute ones <path>, relative ones and URLs stay', () => {
  assert.equal(redactPaths(`at path "${SYSTEM_TMP}/.tmpebgR6L" failed`), 'at path "<tmp>" failed');
  assert.equal(redactPaths('cannot write /tmp/x/y.txt'), 'cannot write <tmp>');
  assert.equal(redactPaths(`open ${USER_FILE} now`), 'open <path> now');
  assert.equal(redactPaths('in ~/work/proj/file'), 'in <path>');
  assert.equal(redactPaths('state/dist/secrets.sops.yaml at https://biz.test/oauth/authorize on 2026/11/28'), 'state/dist/secrets.sops.yaml at https://biz.test/oauth/authorize on 2026/11/28');
  assert.ok(!stderrTail({stderr: `bad path ${SYSTEM_TMP}/.tmpAAA\n`}).includes(SYSTEM_TMP));
});

test('notices: consecutive identical ones become one row with a count and the latest time; others stay separate', () => {
  const at = n => new Date(n * 1000).toISOString();
  const list = [
    {at: at(1), kind: 'failed', text: TMP_FAIL('aaaaaa')},
    {at: at(2), kind: 'failed', text: TMP_FAIL('bbbbbb')},
    {at: at(3), kind: 'failed', text: TMP_FAIL('cccccc')},
    {at: at(4), kind: 'paused', text: 'Sync paused: reauthorize_required. Nothing was changed.'},
    {at: at(5), kind: 'failed', text: TMP_FAIL('dddddd')},
  ];
  const out = collapseNotices(list);
  assert.deepEqual(out.map(n => [n.kind, n.count, n.at]), [['failed', 3, at(3)], ['paused', undefined, at(4)], ['failed', undefined, at(5)]]);
  assert.ok(out.every(n => !n.text.includes(SYSTEM_TMP)));
  assert.match(out[0].text, /at path "<tmp>"/);
  // Applying it again changes nothing, and a stored count is added up.
  assert.deepEqual(collapseNotices(out), out);
  assert.equal(collapseNotices([{...out[0]}, {at: at(9), kind: 'failed', text: TMP_FAIL('zzzzzz')}])[0].count, 4);
  // Numbers in a message do not make it a different one.
  assert.equal(collapseNotices([{at: at(1), kind: 'applied', text: 'Setup v2 applied; 3 files'}, {at: at(2), kind: 'applied', text: 'Setup v3 applied; 4 files'}]).length, 1);
});

test('notices: repeated failures of every sync are counted in the state and the status, never repeated', async () => {
  const h = harness({plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  h.state.current = report({etag: 'e2'});
  h.exits.commit = Array.from({length: 6}, (_, i) => ({status: 1, stderr: `mise ERROR Operation not permitted at path "${SYSTEM_TMP}/.tmp${i}x${i}x${i}x"`}));
  for (let i = 0; i < 6; i++) assert.equal((await h.s.sync()).status, 'failed');
  const failed = readState(h.env).notices.filter(n => n.kind === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].count, 6);
  assert.ok(!JSON.stringify(readState(h.env).notices).includes(SYSTEM_TMP));
  assert.equal(h.s.status().notices.filter(n => n.kind === 'failed')[0].count, 6);
  // Old state written before the collapse is shown collapsed and redacted too.
  const state = readState(h.env);
  writeState(h.env, {...state, notices: Array.from({length: 9}, (_, i) => ({at: new Date(i * 1000).toISOString(), kind: 'failed', text: TMP_FAIL(`t${i}t${i}t${i}`)}))});
  const shown = h.s.status().notices;
  assert.deepEqual([shown.length, shown[0].count], [1, 9]);
  assert.ok(!shown[0].text.includes(SYSTEM_TMP));
});

test('reauthorize: signing in again clears a pause for it, keeps the new grant and notes it; other pauses stay', async () => {
  const h = harness({plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  const saved = [];
  h.store.saveProfile = grant => saved.push(grant);
  // Not paused: nothing to resume.
  assert.equal(h.s.reauthorized({accessToken: 'new'}), false);
  h.state.current = report({reauthorizeRequired: true});
  assert.equal((await h.s.sync()).reason, 'reauthorize_required');
  assert.equal(h.s.status().paused.reason, 'reauthorize_required');
  assert.equal(h.s.reauthorized({accessToken: 'new'}), true);
  assert.deepEqual(saved, [{accessToken: 'new'}]);
  assert.equal(h.s.status().paused, null);
  assert.equal(readState(h.env).notices.at(-1).kind, 'reconnected');
  // The sync that follows works again with the renewed credential.
  h.state.current = report({etag: 'e2'});
  assert.equal((await h.s.sync()).status, 'applied');
  // A pause for any other reason is cleared by a sign-in too; a frozen project is not a pause and stays frozen.
  h.state.current = new Error('biz_access_unavailable');
  assert.equal((await h.s.sync()).reason, 'biz_unreachable');
  assert.equal(h.s.reauthorized({accessToken: 'newer'}), true);
  assert.equal(h.s.status().paused, null);
  assert.equal(saved.length, 2);
  h.state.current = new Error('biz_access_unavailable');
  await h.s.sync();
  writeState(h.env, {...readState(h.env), frozen: true});
  assert.equal(h.s.reauthorized({accessToken: 'frozen'}), false);
  assert.equal(h.s.status().paused.reason, 'biz_unreachable');
});

test('sync: why Biz could not be read decides the pause: a rejected or unrenewable credential is reauthorize, only a failed call is unreachable', async () => {
  const paused = async (setupFn) => {
    const h = harness({plan: PLAN()});
    await h.s.apply({digest: (await h.s.preview()).digest});
    setupFn(h);
    const result = await h.s.sync();
    return [result.reason, readState(h.env).paused.detail];
  };
  // Biz answers 401/403 to the report: the credential expired or was revoked.
  assert.deepEqual(await paused(h => { h.state.current = Object.assign(Error('biz_access_unavailable'), {status: 401}); }), ['reauthorize_required', '401']);
  assert.equal((await paused(h => { h.state.current = Object.assign(Error('biz_access_unavailable'), {status: 403}); }))[0], 'reauthorize_required');
  // The renewal of the saved credential was refused.
  assert.equal((await paused(h => { h.store.profileAccessToken = async () => { throw Error('access_denied'); }; }))[0], 'reauthorize_required');
  // Biz down, slow or erroring: unreachable, with what failed kept for the log.
  assert.deepEqual(await paused(h => { h.state.current = Object.assign(Error('biz_access_unavailable'), {status: 503}); }), ['biz_unreachable', '503']);
  assert.deepEqual(await paused(h => { h.state.current = Error('fetch failed'); }), ['biz_unreachable', 'fetch failed']);
});

test('status: the shown version is the newer of the applied and the self-published one', async () => {
  const h = harness({plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  assert.equal(h.s.status().shownVersion, 'v2');
  writeState(h.env, {...readState(h.env), selfPublished: 'v3'});
  assert.equal(h.s.status().shownVersion, 'v3');
  writeState(h.env, {...readState(h.env), selfPublished: 'v1'});
  assert.equal(h.s.status().shownVersion, 'v2');
  writeState(h.env, {...readState(h.env), version: 'v9', selfPublished: 'v10'});
  assert.equal(h.s.status().shownVersion, 'v10');
});

test('a version published outside the panel (dist:publish) is recorded as this project\'s own when Biz shows it', async () => {
  const h = harness({reports: report({admin: true}), plan: PLAN()});
  await h.s.apply({digest: (await h.s.preview()).digest});
  const biz = report({admin: true, setup: {...SETUP, version: 'v3'}, etag: 'e3'});
  // A member (no publisher settings) never records it, even when the answers file says v3.
  fs.writeFileSync(path.join(h.root, '.copier-answers.dist.yml'), '_commit: v3\n_src_path: .data/dist/biz-source\n');
  assert.equal(h.s.noteReport(biz), false);
  fs.mkdirSync(path.join(h.root, 'project'), {recursive: true});
  fs.writeFileSync(path.join(h.root, 'project/distribution.yaml'), 'repo: biz\nsecrets: []\n');
  // Biz is on another version than the one this project recorded: not ours.
  assert.equal(h.s.noteReport(report({admin: true, setup: {...SETUP, version: 'v4'}})), false);
  assert.equal(readState(h.env).selfPublished ?? null, null);
  assert.equal(h.s.noteReport(biz), true);
  assert.equal(readState(h.env).selfPublished, 'v3');
  assert.equal(h.s.noteReport(biz), false);
  // A sync does it too, and does not replace the files with the version it published itself.
  const sync = harness({reports: report({admin: true}), plan: PLAN()});
  await sync.s.apply({digest: (await sync.s.preview()).digest});
  fs.writeFileSync(path.join(sync.root, '.copier-answers.dist.yml'), '_commit: v3\n');
  fs.mkdirSync(path.join(sync.root, 'project'), {recursive: true});
  fs.writeFileSync(path.join(sync.root, 'project/distribution.yaml'), 'repo: biz\n');
  sync.state.current = report({admin: true, setup: {...SETUP, version: 'v3'}, etag: 'e3'});
  sync.calls.length = 0;
  await sync.s.sync();
  assert.equal(readState(sync.env).selfPublished, 'v3');
  assert.ok(!sync.calls.some(c => /dist:(add|update)/.test(c)));
});

// Exercise sync through the real access client and profile grant store.

test('sync skips every command for the same etag and snapshots before updating a newer setup', async t => {
  const h = sharedHarness(t);
  h.connect({version: 'v2', etag: 'e1'});
  h.project.writeAnswers();
  h.project.markStarted();

  assert.deepEqual(await h.managed.sync(), {status: 'noop'});
  assert.equal(h.runner.count(), 0);

  h.biz.publish('v3');
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  const result = await h.managed.sync();
  assert.deepEqual([result.status, result.version, result.installed], ['applied', 'v3', true]);
  assert.deepEqual(h.runner.calls.filter(call => CMD.snapshot(call) || CMD.update(call)).map(call => call.args),
    [['run', 'snapshot'], ['run', 'dist:update']]);
  assert.equal(h.project.readState().etag, h.biz.etag);
});

test('regression: a 401 is reported as reauthorize_required, not biz_unreachable', async t => {
  for (const status of [401, 403]) {
    await t.test(String(status), async st => {
      const h = sharedHarness(st);
      h.connect({version: 'v2', etag: 'e1'});
      await h.managed.sync();
      h.clock.advance(WINDOWS.REPORT_FRESH_MS);
      h.biz.queue('report', fakeBiz.http(status));
      assert.deepEqual(await h.managed.sync(), {status: 'paused', reason: 'reauthorize_required'});
      assert.deepEqual(h.managed.status().paused, {reason: 'reauthorize_required', detail: String(status), at: h.clock.iso()});
      assert.equal(h.runner.count(), 0);
    });
  }
});

test('sync reports failures to reach Biz once the cached report expires', async t => {
  const cases = [
    ['network', fakeBiz.networkError(), /fetch failed/],
    ['timeout', fakeBiz.hang(), /timeout/i],
    ['server', fakeBiz.http(503), /^503$/],
  ];
  for (const [name, failure, detail] of cases) {
    await t.test(name, async st => {
      const h = sharedHarness(st);
      h.connect({version: 'v2', etag: 'e1'});
      await h.managed.sync();
      h.clock.advance(WINDOWS.REPORT_STALE_MS);
      h.biz.queue('report', failure);
      const result = h.managed.sync();
      if (name === 'timeout') {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.biz.count('report'), 2);
        assert.equal(h.clock.timeouts.at(-1), WINDOWS.ACCESS_TIMEOUT_MS);
        h.clock.advance(WINDOWS.ACCESS_TIMEOUT_MS);
      }
      assert.deepEqual(await result, {status: 'paused', reason: 'biz_unreachable'});
      assert.match(h.project.readState().paused.detail, detail);
      assert.equal(h.runner.count(), 0);
    });
  }
});

test('a frozen report leaves first contact intact and revokes only delivered secrets after setup', async t => {
  const keyFile = 'fixture.age';
  const h = sharedHarness(t, {scenario: 'frozen', setupVersion: null,
    project: {env: {MISE_SOPS_AGE_KEY_FILE: keyFile}}});
  const deliveredFile = 'state/dist/secrets.sops.yaml';
  h.connect();
  assert.deepEqual(await h.managed.sync(), {status: 'no_access'});
  assert.equal(h.managed.status().frozen, false);
  assert.equal(h.runner.count(), 0);
  assert.equal(h.project.exists(deliveredFile), true);

  h.project.writeAnswers();
  h.biz.scenario('member').publish('v2');
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  assert.equal((await h.managed.sync()).status, 'applied');
  assert.equal(h.managed.status().noAccess, false);

  // The shared runner logs sops calls. Model the local vault mutation at that seam.
  const vault = h.project.writeFile('secrets.enc.yaml', {API_KEY: 'enc', OTHER: 'enc', LOCAL_ONLY: 'enc'});
  const checkSops = ({command, args, cwd, env}, expectedArgs) => {
    assert.deepEqual([command, ...args], ['sops', ...expectedArgs]);
    assert.equal(cwd, h.root);
    assert.equal(path.resolve(cwd, args[expectedArgs.indexOf('secrets.enc.yaml')]), vault);
    assert.deepEqual(env, {...h.env, SOPS_AGE_KEY_FILE: keyFile});
  };
  const decryptArgs = ['decrypt', '--output-type', 'json', 'secrets.enc.yaml'];
  h.runner.always(CMD.sopsDecrypt, call => {
    checkSops(call, decryptArgs);
    return fs.readFileSync(vault, 'utf8');
  });
  const allowedKeys = new Map(['API_KEY', 'OTHER'].map(name => [JSON.stringify([name]), name]));
  h.runner.always(CMD.sopsUnset, call => {
    const name = allowedKeys.get(call.args[2]);
    assert.ok(name, 'SOPS must unset a delivered key');
    checkSops(call, ['unset', 'secrets.enc.yaml', JSON.stringify([name])]);
    const secrets = JSON.parse(fs.readFileSync(vault, 'utf8'));
    assert.ok(Object.hasOwn(secrets, name), 'SOPS must unset an existing key');
    delete secrets[name];
    fs.writeFileSync(vault, JSON.stringify(secrets));
    return '';
  });
  h.biz.scenario('frozen');
  h.clock.advance(WINDOWS.REPORT_FRESH_MS);
  assert.deepEqual(await h.managed.sync(),
    {status: 'frozen', changed: true, frozen: true, removedSecrets: 2, pendingSecrets: 0});
  assert.deepEqual(JSON.parse(fs.readFileSync(vault, 'utf8')), {LOCAL_ONLY: 'enc'});
  assert.equal(h.project.exists(deliveredFile), false);
  assert.deepEqual(await h.managed.sync(), {status: 'frozen', changed: false});
  assert.equal(h.runner.count(CMD.sopsUnset), 2);
  checkSops(h.runner.last(CMD.sopsDecrypt), decryptArgs);
});

test('regression: every pause but frozen has a reauthorize way out', async t => {
  const cases = [
    ['reauthorize_required', h => h.biz.scenario('reauthorize')],
    ['biz_unreachable', h => h.biz.queue('report', fakeBiz.http(503))],
    ['not_connected', h => h.store.profileLogout()],
    // Biz freezes a person with no access, so an empty, not frozen report is an anomaly: inject it.
    ['unexpected_empty_response', h => h.biz.queue('report', fakeBiz.ok({capabilities: [], admin: false, departments: [], policy: null}))],
  ];
  for (const [reason, interrupt] of cases) {
    await t.test(reason, async st => {
      const h = sharedHarness(st);
      h.connect({version: 'v2', etag: 'e1', lastCapabilities: 1});
      const grant = {...h.project.readProfileGrant(), accessToken: 'renewed-profile'};
      interrupt(h);
      assert.deepEqual(await h.managed.sync(), {status: 'paused', reason});
      assert.equal(h.managed.status().paused.reason, reason);

      h.biz.scenario('member');
      assert.equal(h.managed.reauthorized(grant), true);
      assert.equal(h.managed.status().paused, null);
      assert.equal(h.managed.status().notices.at(-1).kind, 'reconnected');
      assert.equal(await h.store.profileAccessToken(), grant.accessToken);
      assert.deepEqual(await h.managed.sync(), {status: 'noop'});
      assert.equal(h.biz.last('report').token, grant.accessToken);
    });
  }
  await t.test('frozen', async st => {
    const h = sharedHarness(st, {scenario: 'frozen'});
    h.connect({version: 'v2', etag: 'e1'});
    assert.equal((await h.managed.sync()).status, 'frozen');
    const grant = h.project.readProfileGrant();
    assert.equal(h.managed.reauthorized({...grant, accessToken: 'unused'}), false);
    assert.equal(h.managed.status().frozen, true);
    assert.equal(await h.store.profileAccessToken(), grant.accessToken);
  });
});


test('apply cannot restore a setup whose grant and state were removed while it ran', async t => {
  const h = sharedHarness(t, {deliverTeams: async () => {
    h.store.profileLogout();
    fs.rmSync(h.project.stateFile);
    return {managed: true, teams: []};
  }});
  h.connect();
  const {digest} = await h.managed.preview();
  await assert.rejects(h.managed.apply({digest}), {message: 'not_connected'});
  assert.equal(fs.existsSync(h.project.stateFile), false);
});

test('setup immediately reclaims a dead owner and keeps a live owner past the legacy timeout', async t => {
  const {execFileSync} = require('node:child_process');
  const {root, env} = project();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const managed = setup({env, store: {profileAccessToken: async () => { throw Error('not_connected'); }}});
  const lock = path.join(require('../extensions/biz/auth.cjs').dataDir(env), 'setup.lock');
  fs.mkdirSync(lock, {recursive: true});
  const pid = Number(execFileSync(process.execPath, ['-p', 'process.pid'], {encoding: 'utf8'}));
  fs.writeFileSync(path.join(lock, 'owner.test.json'), JSON.stringify({pid, at: Date.now()}));
  assert.equal((await managed.sync()).status, 'disconnected');

  fs.mkdirSync(lock);
  const old = new Date(Date.now() - WINDOWS.SETUP_LOCK_STALE_MS - 60_000);
  fs.writeFileSync(path.join(lock, 'owner.test.json'), JSON.stringify({pid: process.pid, at: +old}));
  fs.utimesSync(lock, old, old);
  await assert.rejects(managed.sync(), {message: 'busy'});
});

test('sync CLI quietly skips a held setup lock', t => {
  const {spawnSync} = require('node:child_process');
  const {root, env} = project();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(require('../extensions/biz/auth.cjs').dataDir(env), 'setup.lock'), {recursive: true});
  const result = spawnSync(process.execPath, [require.resolve('../extensions/biz/managed-setup.cjs'), 'sync'],
    {env: {...process.env, ...env}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {status: 'busy'});
});

test('atomic writes remove only abandoned temporary files older than a day', t => {
  const {writePrivate} = require('../extensions/biz/atomic-write.cjs');
  const {root} = project();
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const stale = 'setup.json.123.0.1e2647a1-c543-4665-9982-248e22faab81.tmp';
  const fresh = 'profile-oauth.json.123.2.2e2647a1-c543-4665-9982-248e22faab81.tmp';
  const unrelated = 'setup.json.123.0.unrelated.tmp';
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  for (const name of [stale, fresh, unrelated]) fs.writeFileSync(path.join(root, name), '');
  for (const name of [stale, unrelated]) fs.utimesSync(path.join(root, name), old, old);
  writePrivate(path.join(root, 'setup.json'), {connected: true});
  assert.equal(fs.existsSync(path.join(root, stale)), false);
  assert.equal(fs.existsSync(path.join(root, fresh)), true);
  assert.equal(fs.existsSync(path.join(root, unrelated)), true);
});
