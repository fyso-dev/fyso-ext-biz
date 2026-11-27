const {projectAccess, reportOf} = require('./project-access.cjs');
const {isFrozen} = require('./managed-setup.cjs');

const rpc = new Set(['initialize', 'ping', 'notifications/initialized', 'tools/list']);
// Biz's read tools; every other tool changes something. `cuidado` and a frozen project may only read.
const READ_TOOL = /^(?:listar|ver|buscar|obtener|explicar|vision|contexto$|solicitudes_disponibles$|como_trabajar)/;

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

      const report = await reportOf(access, session.accessToken);
      const granted = new Set(report.capabilities);
      if (!granted.has('app:mcp')) return reply(403);
      if (rpc.has(method)) return reply(204);
      if (method !== 'tools/call' || typeof tool !== 'string' || !/^[a-z0-9_]{1,100}$/.test(tool)) return reply(403);
      const readOnly = report.frozen === true || isFrozen(env) || report.policy?.preset === 'cuidado';
      if (readOnly && !READ_TOOL.test(tool)) return reply(403);
      return reply(granted.has(`mcp:tool:${tool}`) ? 204 : 403);
    } catch {
      return reply(503);
    }
  };
}

module.exports = {mcpPolicy};
