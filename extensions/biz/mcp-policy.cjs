const {projectAccess} = require('./project-access.cjs');

const rpc = new Set(['initialize', 'ping', 'notifications/initialized', 'tools/list']);

function mcpPolicy({env = process.env, profiles, access = projectAccess({env})}) {
  return async function check(req, res) {
    const reply = status => res.writeHead(status, {'Cache-Control': 'no-store'}).end();
    const enabled = env.FYSO_BIZ_ACCESS_ORGANIZATION;
    if (!enabled) return reply(204);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) return reply(413);
        chunks.push(chunk);
      }
      const {principal, method, tool} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (principal?.kind !== 'delegated' || principal.extension !== 'biz') return reply(403);
      const session = profiles.remote(principal.digest);
      if (!session) return reply(403);
      if (method === 'authenticate') return reply(204);

      const granted = new Set(await access.capabilities(session.accessToken));
      if (!granted.has('app:mcp')) return reply(403);
      if (rpc.has(method)) return reply(204);
      if (method !== 'tools/call' || typeof tool !== 'string' || !/^[a-z0-9_]{1,100}$/.test(tool)) return reply(403);
      return reply(granted.has(`mcp:tool:${tool}`) ? 204 : 403);
    } catch {
      return reply(503);
    }
  };
}

module.exports = {mcpPolicy};
