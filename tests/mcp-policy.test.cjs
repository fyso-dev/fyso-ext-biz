const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const {mcpPolicy} = require('../extensions/biz/mcp-policy.cjs');

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
