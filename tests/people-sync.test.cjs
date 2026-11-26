const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const people = require('../extensions/biz/people-sync.cjs');
const {ALLOWED} = require('../extensions/biz/mcp-proxy.cjs');

const ORG = 'acme', PROJECT = 'b9209a13-a003-48f9-abc7-65f98e25b856';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const env = (extra = {}) => ({FYSO_BIZ_ACCESS_ORGANIZATION: ORG, FYSO_BIZ_ACCESS_PROJECT: PROJECT,
  FYSO_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'biz-people-')), ...extra});
const page = bizId => people.PREFIX + people.personId(ORG, bizId);

// Biz answering listar_personas_proyecto, or failing like the MCP client does.
function biz(personas, {fail, proyecto = PROJECT} = {}) {
  const calls = [];
  return {calls, call: async (name, args) => {
    calls.push([name, args]);
    if (fail) throw fail;
    return {proyecto, personas};
  }};
}

// The Dagu wiki as an in-memory map of page id → content, recording every write.
function directory(pages = {}) {
  const store = new Map(Object.entries(pages)), writes = [];
  return {store, writes,
    list: async () => [...store.keys()],
    read: async id => store.has(id) ? store.get(id) : null,
    create: async (id, text) => { writes.push(['create', id]); store.set(id, text); },
    update: async (id, text) => { writes.push(['update', id]); store.set(id, text); },
    remove: async id => { writes.push(['remove', id]); store.delete(id); },
  };
}

test('person ids are stable v4 UUIDs, scoped by organization', () => {
  const id = people.personId(ORG, 'u-1');
  assert.match(id, ID);
  assert.equal(people.personId(ORG, 'u-1'), id);
  assert.notEqual(people.personId(ORG, 'u-2'), id);
  assert.notEqual(people.personId('other', 'u-1'), id);
  // Fixed vector: sha256("fyso-biz-person:acme:u-1"), 16 bytes, version 4, variant 10xx.
  const hex = require('node:crypto').createHash('sha256').update('fyso-biz-person:acme:u-1').digest('hex').slice(0, 32);
  assert.equal(id.replaceAll('-', '').slice(0, 12), hex.slice(0, 12));
  assert.equal(id[14], '4');
  assert.ok('89ab'.includes(id[19]));
  assert.match(`${people.PREFIX}${id}`, /^fyso-people\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('creates missing people with the directory format and the Biz origin', async () => {
  const mcp = biz([{id: 'u-1', nombre: 'Ana Pérez'}, {id: 'u-2', nombre: '  Luis\n Gómez '}]);
  const dir = directory();
  const result = await people.sync({mcp, directory: dir, env: env()});
  assert.deepEqual(mcp.calls, [['listar_personas_proyecto', {proyecto: PROJECT}]]);
  assert.deepEqual(result, {count: 2, created: 2, updated: 0, removed: 0, conflicts: 0});
  assert.equal(dir.store.get(page('u-1')), '{"version":1,"name":"Ana Pérez","source":"biz","biz_id":"u-1"}\n');
  assert.equal(JSON.parse(dir.store.get(page('u-2'))).name, 'Luis Gómez');
});

test('long names are cut to the directory limit', async () => {
  const dir = directory();
  await people.sync({mcp: biz([{id: 'u-1', nombre: 'ñ'.repeat(120)}]), directory: dir, env: env()});
  assert.equal(JSON.parse(dir.store.get(page('u-1'))).name, 'ñ'.repeat(80));
});

test('renames changed people, removes people Biz no longer lists, and is idempotent', async () => {
  const dir = directory({
    [page('u-1')]: people.content('Ana', 'u-1'),
    [page('u-2')]: people.content('Luis', 'u-2'),
  });
  const mcp = biz([{id: 'u-1', nombre: 'Ana Pérez'}, {id: 'u-3', nombre: 'Marta'}]);
  assert.deepEqual(await people.sync({mcp, directory: dir, env: env()}), {count: 2, created: 1, updated: 1, removed: 1, conflicts: 0});
  assert.equal(JSON.parse(dir.store.get(page('u-1'))).name, 'Ana Pérez');
  assert.equal(dir.store.has(page('u-2')), false);
  assert.equal(dir.store.has(page('u-3')), true);
  dir.writes.length = 0;
  assert.deepEqual(await people.sync({mcp, directory: dir, env: env()}), {count: 2, created: 0, updated: 0, removed: 0, conflicts: 0});
  assert.deepEqual(dir.writes, []);
});

test('never touches people added by hand', async () => {
  const manual = 'fyso-people/0f8fad5b-d9cb-469f-a165-70867728950e';
  const manualText = JSON.stringify({version: 1, name: 'Someone'}) + '\n';
  const unreadable = 'fyso-people/7c9e6679-7425-40de-944b-e07fc1f90ae7';
  // A hand-made page at a synced id (a collision) is kept as it is.
  const collision = page('u-9');
  const dir = directory({[manual]: manualText, [unreadable]: 'not json', [collision]: manualText, [page('u-2')]: people.content('Luis', 'u-2')});
  const result = await people.sync({mcp: biz([{id: 'u-9', nombre: 'Nine'}]), directory: dir, env: env()});
  assert.deepEqual(result, {count: 1, created: 0, updated: 0, removed: 1, conflicts: 1});
  assert.equal(dir.store.get(manual), manualText);
  assert.equal(dir.store.get(unreadable), 'not json');
  assert.equal(dir.store.get(collision), manualText);
  assert.deepEqual(dir.writes, [['remove', page('u-2')]]);
  // An empty Biz project removes only synced people.
  await people.sync({mcp: biz([]), directory: dir, env: env()});
  assert.deepEqual([...dir.store.keys()].sort(), [collision, manual, unreadable].sort());
});

test('fails closed: a failed or doubtful Biz answer changes nothing', async () => {
  const pages = {[page('u-1')]: people.content('Ana', 'u-1')};
  const cases = [
    [biz(null, {fail: Object.assign(Error('tool_denied'), {detail: 'personas_no_disponibles'})}), 'personas_no_disponibles'],
    [biz(null, {fail: Object.assign(Error('tool_denied'), {detail: 'proyecto_desconocido: no such project'})}), 'proyecto_desconocido'],
    [biz(null, {fail: Error('connection_failed')}), 'connection_failed'],
    [biz([{id: 'u-2', nombre: 'Luis'}], {proyecto: 'another'}), 'project_mismatch'],
    [biz([{id: 'u-2', nombre: '   '}]), 'unexpected_response'],
    [biz([{nombre: 'No id'}]), 'unexpected_response'],
    [{call: async () => ({proyecto: PROJECT})}, 'unexpected_response'],
  ];
  for (const [mcp, code] of cases) {
    const dir = directory(pages);
    await assert.rejects(people.sync({mcp, directory: dir, env: env()}), {message: code});
    assert.deepEqual(dir.writes, [], code);
  }
  // A directory that cannot be read is not written either.
  const dir = directory(pages);
  dir.list = async () => { throw Error('wiki_unavailable'); };
  await assert.rejects(people.sync({mcp: biz([]), directory: dir, env: env()}), {message: 'wiki_unavailable'});
  assert.deepEqual(dir.writes, []);
});

test('run records the outcome for GET /status and keeps the last good count on failure', async () => {
  const e = env();
  assert.deepEqual(people.status(e), {people_synced: false, people_count: null, people_sync: null});
  const dir = directory();
  const ok = await people.run({env: e, mcp: biz([{id: 'u-1', nombre: 'Ana'}]), directory: dir, now: () => 'T1'});
  assert.equal(ok.ok, true);
  assert.deepEqual(people.status(e), {people_synced: true, people_count: 1, people_sync: {at: 'T1', ok: true}});
  const failed = await people.run({env: e, mcp: biz(null, {fail: Error('connection_failed')}), directory: dir, now: () => 'T2'});
  assert.deepEqual([failed.ok, failed.error], [false, 'connection_failed']);
  assert.deepEqual(people.status(e), {people_synced: false, people_count: 1, people_sync: {at: 'T2', ok: false, error: 'connection_failed'}});
  assert.equal(dir.store.size, 1);
  // A second sync while one runs is refused; the lock is released afterwards.
  fs.writeFileSync(path.join(e.FYSO_DATA, 'ext/biz/people-sync.lock'), '1');
  await assert.rejects(people.run({env: e, mcp: biz([]), directory: dir}), {message: 'sync_running'});
  fs.rmSync(path.join(e.FYSO_DATA, 'ext/biz/people-sync.lock'));
  assert.equal((await people.run({env: e, mcp: biz([]), directory: dir})).ok, true);
  assert.equal(fs.existsSync(path.join(e.FYSO_DATA, 'ext/biz/people-sync.lock')), false);
});

test('without managed access nothing runs and /status is unchanged', async () => {
  for (const e of [{}, {FYSO_BIZ_ACCESS_ORGANIZATION: ORG}]) {
    assert.deepEqual(await people.run({env: e, mcp: {call: () => assert.fail('called Biz')}}), {managed: false});
    assert.deepEqual(people.status(e), {});
  }
});

test('the wiki client uses Dagu\'s REST API with the project credential', async () => {
  const requests = [];
  const transport = async (url, init) => {
    requests.push([init.method, url.replace('http://127.0.0.1:29501/api/v1', ''), init.headers.Authorization, init.body]);
    if (url.includes('/wiki?')) return new Response(JSON.stringify({items: [{id: page('u-1')}, {id: 'fyso-people/not-a-uuid'}], pagination: {hasNextPage: false}}));
    if (init.method === 'GET') return url.includes('missing') ? new Response('', {status: 404}) : new Response(JSON.stringify({content: 'x'}));
    return new Response('{}');
  };
  const w = people.wiki({FYSO_DAGU_PORT: '29501', FYSO_ADMIN_USER: 'admin', FYSO_ADMIN_PASSWORD: 'secret'}, transport);
  assert.deepEqual(await w.list(), [page('u-1')]);
  assert.equal(await w.read(page('u-1')), 'x');
  assert.equal(await w.read('fyso-people/missing'), null);
  await w.create(page('u-1'), 'a'); await w.update(page('u-1'), 'b'); await w.remove(page('u-1'));
  const auth = 'Basic ' + Buffer.from('admin:secret').toString('base64');
  assert.ok(requests.every(r => r[2] === auth));
  const encoded = encodeURIComponent(page('u-1'));
  assert.deepEqual(requests.map(r => [r[0], r[1], r[3]]), [
    ['GET', '/wiki?flat=true&prefix=fyso-people&page=1&perPage=100', undefined],
    ['GET', `/wiki/page?path=${encoded}`, undefined],
    ['GET', `/wiki/page?path=${encodeURIComponent('fyso-people/missing')}`, undefined],
    ['POST', '/wiki', JSON.stringify({id: page('u-1'), content: 'a'})],
    ['PATCH', `/wiki/page?path=${encoded}`, JSON.stringify({content: 'b'})],
    ['DELETE', `/wiki/page?path=${encoded}`, undefined],
  ]);
  assert.throws(() => people.wiki({}), {message: 'wiki_unavailable'});
  const down = people.wiki({FYSO_DAGU_PORT: '1', FYSO_ADMIN_USER: 'a', FYSO_ADMIN_PASSWORD: 'b'}, async () => new Response('', {status: 500}));
  await assert.rejects(down.list(), {message: 'wiki_unavailable'});
});

test('bots do not get the people tool through the proxy', () => {
  assert.equal(ALLOWED.has(people.TOOL), false);
});
