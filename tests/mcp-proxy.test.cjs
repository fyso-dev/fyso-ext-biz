const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const proxy = require('../extensions/biz/mcp-proxy.cjs');

const TOOLS = [{name: 'contexto'}, {name: 'tomar_solicitud'}, {name: 'aprobar_palanca'}, {name: 'aceptar_entrega'}, {name: 'crear_solicitud'}];
function relay() {
  const calls = [];
  const fn = async (method, params) => {
    calls.push({method, params});
    if (method === 'tools/list') return {tools: TOOLS};
    if (method === 'tools/call') return {content: [{type: 'text', text: '{"ok":true}'}], isError: false};
    throw Error('unexpected');
  };
  return Object.assign(fn, {calls});
}

test('the allow-list holds reads and the work cycle, never person-side decisions', () => {
  for (const name of ['solicitudes_disponibles', 'tomar_solicitud', 'soltar_solicitud', 'registrar_avance', 'subir_evidencia', 'cerrar_solicitud', 'crear_nota', 'crear_solicitud', 'guardar_plan_objetivo', 'ver_solicitud', 'contexto']) assert.ok(proxy.ALLOWED.has(name), name);
  for (const name of ['aprobar_palanca', 'aceptar_entrega', 'autorizar_ejecucion', 'responder_decision', 'pedir_cambios', 'cancelar_solicitud', 'ejecutar_accion', 'eliminar_kpi']) assert.ok(!proxy.ALLOWED.has(name), name);
});

test('answers initialize locally and lists only allowed tools', async () => {
  const r = relay();
  const init = await proxy.handle({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-03-26'}}, r);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, {tools: {}});
  assert.equal(r.calls.length, 0);
  const cloud = await proxy.handle({jsonrpc: '2.0', id: 31, method: 'tools/call', params: {name: 'crear_solicitud', arguments: {ejecutor: 'fyso_cloud'}}}, r);
  assert.equal(cloud.error.code, -32602);
  assert.equal(r.calls.length, 0);
  assert.equal(await proxy.handle({jsonrpc: '2.0', method: 'notifications/initialized'}, r), null);
  const list = await proxy.handle({jsonrpc: '2.0', id: 2, method: 'tools/list'}, r);
  assert.deepEqual(list.result.tools.map(t => t.name), ['contexto', 'tomar_solicitud', 'crear_solicitud']);
});

test('refuses hidden tools without contacting Biz and relays allowed calls unchanged', async () => {
  const r = relay();
  const denied = await proxy.handle({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'aprobar_palanca', arguments: {}}}, r);
  assert.equal(denied.error.code, -32602);
  assert.match(denied.error.message, /aprobar_palanca/);
  assert.equal(r.calls.length, 0);
  const ok = await proxy.handle({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'tomar_solicitud', arguments: {solicitud_id: 's1'}}}, r);
  assert.deepEqual(ok, {jsonrpc: '2.0', id: 4, result: {content: [{type: 'text', text: '{"ok":true}'}], isError: false}});
  assert.deepEqual(r.calls, [{method: 'tools/call', params: {name: 'tomar_solicitud', arguments: {solicitud_id: 's1'}}}]);
  const unknown = await proxy.handle({jsonrpc: '2.0', id: 5, method: 'resources/list'}, r);
  assert.equal(unknown.error.code, -32601);
});

test('relays a Biz JSON-RPC error and maps local failures to a code, never a token', async () => {
  const rpc = await proxy.handle({jsonrpc: '2.0', id: 6, method: 'tools/list'}, async () => { throw Object.assign(Error('remote_error'), {rpc: {code: -32000, message: 'busy'}}); });
  assert.deepEqual(rpc.error, {code: -32000, message: 'busy'});
  const local = await proxy.handle({jsonrpc: '2.0', id: 7, method: 'tools/list'}, async () => { throw Error('not_connected'); });
  assert.equal(local.error.message, 'Fyso Biz: not_connected');
});

test('upstream follows the current credential and retries once after a rejected token', async () => {
  let token = 'A', opened = [];
  const connect = (origin, c) => {
    opened.push(c.token);
    return {initialize: async () => {}, request: async () => {
      if (c.token === 'A' && token === 'B') throw Error('access_denied');
      return {token: c.token};
    }};
  };
  const relay = proxy.upstream({env: {FYSO_BIZ_URL: 'https://example.invalid'}, credential: async () => ({token, oauth: true}), connect});
  assert.deepEqual(await relay('tools/list', {}), {token: 'A'});
  assert.deepEqual(await relay('tools/list', {}), {token: 'A'});
  assert.deepEqual(opened, ['A']);
  // A refreshed credential opens a new session.
  token = 'B';
  assert.deepEqual(await relay('tools/list', {}), {token: 'B'});
  assert.deepEqual(opened, ['A', 'B']);
  // Rejected even after reconnecting: the error surfaces once, no loop.
  const failing = proxy.upstream({env: {}, credential: async () => ({token: 'C'}), connect: () => ({initialize: async () => {}, request: async () => { throw Error('access_denied'); }})});
  await assert.rejects(failing('tools/list', {}), {message: 'access_denied'});
});

test('serves newline-delimited JSON-RPC over stdio', async () => {
  const input = new PassThrough(), output = new PassThrough();
  proxy.serve({input, output, relay: relay()});
  const lines = [];
  output.setEncoding('utf8');
  const done = new Promise(resolve => output.on('data', chunk => { lines.push(...chunk.trim().split('\n')); if (lines.length >= 3) resolve(); }));
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"aceptar_entrega"}}\n');
  await done;
  const messages = lines.map(line => JSON.parse(line));
  assert.ok(messages.some(m => m.id === 1 && m.result));
  assert.ok(messages.some(m => m.id === null && m.error.code === -32700));
  assert.ok(messages.some(m => m.id === 2 && m.error.code === -32602));
});
