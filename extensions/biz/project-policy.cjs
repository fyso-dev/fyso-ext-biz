const {projectAccess} = require('./project-access.cjs');

const signIn = '/api/ext/biz/profile/sign-in';
const profileRoutes = new Map([
  [signIn, 'GET'],
  ['/api/panel-access', 'GET'],
  ['/api/ext/biz/profile/login', 'POST'],
  ['/extensions/biz/oauth/callback', 'GET'],
  ['/api/ext/biz/profile/status', 'GET'],
  ['/api/ext/biz/profile/logout', 'POST'],
  ['/api/ext/biz/profile/mcp-token', 'POST'],
  ['/api/session/logout', 'POST'],
]);
const shell = /^\/(?:index\.html|assets\/[a-z0-9_./-]+|favicon\.[a-z0-9]+)?$/i;
const read = new Set(['GET', 'HEAD']);

const exact = new Map([
  ['GET /api/omb/bots', 'action:bots:list'],
  ['GET /config/team.yaml', 'action:bots:read-team'],
  ['GET /config/observability.json', 'action:observability:read'],
  ['GET /config/bot-versioning.json', 'action:bots:read-versioning'],
  ['GET /config/skills.json', 'action:skills:list'],
  ['GET /api/dagu/dags', 'action:workflows:list'],
  ['GET /api/dagu/dag-runs', 'action:workflows:list-runs'],
  ['GET /api/ext/biz/status', 'action:biz:read-status'],
  ['GET /api/ext/biz/teams', 'action:biz:read-teams'],
  ['GET /api/ext/biz/context', 'action:biz:read-context'],
  ['GET /api/ext/biz/objective', 'action:biz:read-objective'],
  ['GET /api/ext/biz/work', 'action:biz:read-work'],
  ['POST /api/ext/biz/work', 'action:biz:create-work'],
  ['POST /api/ext/biz/logout', 'action:biz:disconnect-agent'],
  ['POST /api/composio/setup', 'action:connectors:configure'],
]);

const panelMetadata = new Set(['/config/project.json', '/config/apps.json', '/config/extensions.json']);
const dagName = '([a-z0-9][a-z0-9_.-]{0,127})';
const dag = new RegExp(`^/api/dagu/dags/${dagName}(?:/(dag-runs|start|enqueue))?$`);
const run = new RegExp(`^/api/dagu/dag-runs/${dagName}/[a-zA-Z0-9_-]{1,128}(?:/(outputs))?$`);

function capability(method, path) {
  const fixed = exact.get(`${method} ${path}`);
  if (fixed) return fixed;
  const page = /^\/extensions\/([a-z0-9-]+)\/panel\//.exec(path);
  if (page && read.has(method)) return `page:extension:${page[1]}`;

  const workflow = dag.exec(path);
  if (workflow) {
    const [, name, operation] = workflow;
    if (method === 'POST' && ['start', 'enqueue'].includes(operation)) return `workflow:${name}:run`;
    if (method === 'GET' && (!operation || operation === 'dag-runs')) return `workflow:${name}:read`;
  }
  const execution = run.exec(path);
  if (method === 'GET' && execution) {
    return `workflow:${execution[1]}:${execution[2] ? 'read-outputs' : 'read'}`;
  }

  const extension = /^\/api\/ext\/([a-z][a-z0-9-]{1,30})\/([a-z0-9][a-z0-9_.-]{0,63})$/.exec(path);
  if (extension && extension[1] !== 'biz' && ['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    return `action:extension:${extension[1]}:${method.toLowerCase()}:${extension[2]}`;
  }
  return null;
}

function projectPolicy({env = process.env, profiles, access = projectAccess({env})} = {}) {
  return async function check(req, res) {
    const configured = env.FYSO_BIZ_ACCESS_ORGANIZATION || env.FYSO_BIZ_ACCESS_PROJECT;
    const reply = status => res.writeHead(status, {'Cache-Control': 'no-store'}).end();
    if (!configured) return reply(204);
    if (!req.headers['remote-user']) return reply(401);
    if (req.headers['x-fyso-policy-host'] !== `panel.${env.FYSO_WEB_DOMAIN}`) return reply(403);
    const method = req.headers['x-forwarded-method'];
    const path = req.headers['x-fyso-policy-path'] || '';
    if (path.includes('%') || path.includes('\\') || path.includes('//') ||
        path.split('/').some(segment => segment === '.' || segment === '..')) return reply(403);
    if (method === 'GET' && path === '/' && !profiles.current(req)) {
      return res.writeHead(303, {'Cache-Control': 'no-store', Location: signIn}).end();
    }
    if (profileRoutes.get(path) === method) return reply(204);

    const session = profiles.current(req);
    if (!session) return reply(403);
    const entryOnly = read.has(method) && (shell.test(path) || panelMetadata.has(path) || path === '/api/session');
    const permission = capability(method, path);
    if (!permission && !entryOnly) return reply(403);
    try {
      const panel = await access.can(session.accessToken, 'app:panel');
      return reply(panel && (entryOnly || await access.can(session.accessToken, permission)) ? 204 : 403);
    } catch {
      return reply(503);
    }
  };
}

module.exports = {projectPolicy};
