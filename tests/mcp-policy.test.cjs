const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const {mcpPolicy} = require('../extensions/biz/mcp-policy.cjs');
const {harness} = require('./helpers/index.cjs');

test('uses the linked human session and checks the current Biz grant on every MCP tool call', async () => {
  const permissions = new Set(['app:mcp', 'mcp:tool:fyso_context']);
  const handler = mcpPolicy({
    env: {FYSO_BIZ_ACCESS_ORGANIZATION: 'acme', FYSO_BIZ_ACCESS_PROJECT: 'project'},
    profiles: {remote: digest => digest === 'known' ? {accessToken: 'human'} : null},
    access: {capabilities: async token => {
      assert.equal(token, 'human');
      return [...permissions];
    }},
  });
  const principal = {kind: 'delegated', extension: 'biz', digest: 'known'};
  const check = operation => handler(
    Readable.from([Buffer.from(JSON.stringify({principal, ...operation}))]),
    {writeHead: status => ({end: () => status})},
  );
  assert.equal(await check({method: 'authenticate'}), 204);
  assert.equal(await check({method: 'tools/call', tool: 'fyso_context'}), 204);
  assert.equal(await check({method: 'tools/call', tool: 'fyso_status'}), 403);
  assert.equal(await check({method: 'initialize', principal: {kind: 'project'}}), 403);
  permissions.delete('app:mcp');
  assert.equal(await check({method: 'tools/call', tool: 'fyso_context'}), 403);
});

test('MCP decisions by grant and framework policy', async t => {
  const h = harness(t, {grant: false});
  const handler = mcpPolicy({...h, profiles: {
    remote: digest => digest ? {accessToken: digest} : null,
  }});
  const read = 'listar_objetivos';
  const write = 'crear_objetivo';
  const grants = ['app:mcp', `mcp:tool:${read}`, `mcp:tool:${write}`];
  const people = {
    'explicit grants': {capabilities: grants, policy: null},
    'wildcard grants': {capabilities: ['app:*', 'mcp:tool:*'], policy: null},
    'app only': {capabilities: ['app:mcp'], policy: null},
    'tool only': {capabilities: [`mcp:tool:${read}`], policy: null},
    'empty policy': {capabilities: [], policy: {}},
    cuidado: {capabilities: grants, policy: {preset: 'cuidado'}},
    frozen: {capabilities: [], policy: null, frozen: true},
  };
  for (const [digest, report] of Object.entries(people)) h.biz.person(digest, report);

  const rows = [
    ['explicit grants', 'tools/call', read, 204],
    ['explicit grants', 'tools/call', write, 204],
    ['explicit grants', 'tools/call', 'unknown_tool', 403],
    ['wildcard grants', 'tools/call', read, 204],
    ['wildcard grants', 'tools/call', write, 204],
    ['wildcard grants', 'tools/call', 'bad/tool', 403],
    ['wildcard grants', 'tools/call', null, 403],
    ['wildcard grants', 'resources/read', read, 403],
    ['app only', 'tools/list', undefined, 204],
    ['app only', 'tools/call', read, 403],
    ['tool only', 'tools/call', read, 403],
    ['empty policy', 'authenticate', undefined, 204],
    ['empty policy', 'tools/list', undefined, 403],
    ['empty policy', 'tools/call', read, 403],
    ['cuidado', 'tools/call', read, 204],
    ['cuidado', 'tools/call', write, 403],
    ['frozen', 'tools/call', read, 204],
    ['frozen', 'tools/call', write, 403],
    ['frozen', 'initialize', undefined, 204],
    ['', 'authenticate', undefined, 403],
  ];
  for (const [digest, method, tool, status] of rows) {
    await t.test(`${digest || 'no session'} · ${method} ${tool === undefined ? '' : JSON.stringify(tool)} → ${status}`, async () => {
      const principal = {kind: 'delegated', extension: 'biz', digest};
      assert.equal(await callPolicy(handler, JSON.stringify({principal, method, tool})), status);
    });
  }
});

function callPolicy(handler, body) {
  return handler(Readable.from([Buffer.from(body)]), {writeHead: status => ({end: () => status})});
}

test('MCP gateway checks the principal and request body', async t => {
  const h = harness(t, {grant: false});
  const handler = mcpPolicy({...h, profiles: {remote: () => ({accessToken: 'person'})}});
  assert.equal(await callPolicy(handler, '{'), 503);
  assert.equal(await callPolicy(handler, ' '.repeat(4097)), 413);
  assert.equal(await callPolicy(handler, '{}'), 403);
  assert.equal(await callPolicy(handler, JSON.stringify({principal: {kind: 'delegated', extension: 'other'}, method: 'authenticate'})), 403);
  assert.equal(await callPolicy(mcpPolicy({env: {}}), '{}'), 204);
  assert.equal(h.biz.count(), 0);
});
