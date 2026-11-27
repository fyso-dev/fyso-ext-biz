const {projectAccess, reportOf} = require('./project-access.cjs');
const {isFrozen} = require('./managed-setup.cjs');
const {allows} = require('./department-capabilities.cjs');

const signIn = '/api/ext/biz/profile/sign-in';
const profileRoutes = new Map([
  [signIn, 'GET'],
  ['/api/panel-access', 'GET'],
  ['/api/ext/biz/profile/login', 'POST'],
  ['/extensions/biz/oauth/callback', 'GET'],
  ['/api/ext/biz/profile/status', 'GET'],
  ['/api/ext/biz/profile/logout', 'POST'],
  ['/api/ext/biz/profile/mcp-token', 'POST'],
  // Managed setup: the profile session is the credential; Biz decides what it may do.
  ['/api/ext/biz/profile/setup/status', 'GET'],
  ...['preview', 'confirm', 'cancel', 'publish', 'merge', 'disconnect'].map(op => [`/api/ext/biz/profile/setup/${op}`, 'POST']),
]);
const shell = /^\/(?:index\.html|assets\/[a-z0-9_./-]+|favicon\.[a-z0-9]+)?$/i;
const read = new Set(['GET', 'HEAD']);

const exact = new Map([
  ['GET /api/ext/biz/profile/feedback', 'action:feedback:submit'],
  ['POST /api/ext/biz/profile/feedback', 'action:feedback:submit'],
  ['GET /api/omb/bots', 'action:bots:list'],
  ['GET /config/team.yaml', 'action:bots:read-team'],
  ['GET /config/observability.json', 'action:observability:read'],
  ['GET /config/bot-versioning.json', 'action:bots:read-versioning'],
  ['GET /config/skills.json', 'action:skills:list'],
  ['GET /api/dagu/dags', 'action:workflows:list'],
  ['GET /api/dagu/dag-runs', 'action:workflows:list-runs'],
  ['GET /api/ext/biz/mail/addresses', 'action:biz:read-mailboxes'],
  ['POST /api/ext/biz/mail/activate', 'action:biz:manage-mailboxes'],
  ['POST /api/ext/biz/mail/deactivate', 'action:biz:manage-mailboxes'],
  ['GET /api/ext/biz/status', 'action:biz:read-status'],
  ['GET /api/ext/biz/teams', 'action:biz:read-teams'],
  ['GET /api/ext/biz/context', 'action:biz:read-context'],
  ['GET /api/ext/biz/objective', 'action:biz:read-objective'],
  ['GET /api/ext/biz/work', 'action:biz:read-work'],
  ['POST /api/ext/biz/work', 'action:biz:create-work'],
  ['POST /api/ext/biz/logout', 'action:biz:disconnect-agent'],
  ['POST /api/composio/setup', 'action:connectors:configure'],
  ['GET /api/omb/connectors/catalog', 'action:connectors:read'],
  ['GET /api/omb/connectors/connected', 'action:connectors:read'],
  ['GET /api/omb/connectors/tools', 'action:connectors:read'],
  ['GET /api/omb/mcp/servers', 'action:connectors:read'],
  ['POST /api/connectors/mcp', 'action:connectors:manage'],
]);

const panelMetadata = new Set(['/config/project.json', '/config/apps.json', '/config/extensions.json']);
const dagName = '([a-z0-9][a-z0-9_.-]{0,127})';
const dag = new RegExp(`^/api/dagu/dags/${dagName}(?:/(dag-runs|start|enqueue))?$`);
const run = new RegExp(`^/api/dagu/dag-runs/${dagName}/[a-zA-Z0-9_-]{1,128}(?:/(outputs))?$`);
// Answering a waiting human task (human-requests' Pending page) acts on the run,
// so it needs the same permission as starting the workflow.
const humanTask = new RegExp(`^/api/dagu/dag-runs/${dagName}/[a-zA-Z0-9_-]{1,128}/human-tasks/(?:resume|[a-zA-Z0-9_.-]{1,128}/(?:complete|push-back))$`);
// Dagu's wiki (human-requests' people directory). The page id travels in the
// query string, which the policy does not see, so reads and writes are coarse.
const wiki = /^\/api\/dagu\/wiki(?:\/page)?$/;

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
  const task = humanTask.exec(path);
  if (task && method === 'POST') return `workflow:${task[1]}:run`;

  if (wiki.test(path)) {
    if (read.has(method)) return 'action:wiki:read';
    if (['POST', 'PATCH', 'DELETE'].includes(method)) return 'action:wiki:write';
  }

  const execution = run.exec(path);
  if (method === 'GET' && execution) {
    return `workflow:${execution[1]}:${execution[2] ? 'read-outputs' : 'read'}`;
  }

  if (method === 'POST' && /^\/api\/omb\/connectors\/[a-z][a-z0-9_-]{0,63}\/authorize$/.test(path)) {
    return 'action:connectors:authorize';
  }
  if (method === 'DELETE' && /^\/api\/omb\/connectors\/[a-z][a-z0-9_-]{0,63}\/accounts\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(path)) {
    return 'action:connectors:manage';
  }
  const server = /^\/api\/omb\/mcp\/servers\/[a-z][a-z0-9_-]{0,31}(?:\/(test|sign-in|sign-out)(?:\/([0-9a-f-]{36}))?)?$/.exec(path);
  if (server) {
    const [, operation, flow] = server;
    if (!operation && method === 'GET') return 'action:connectors:read';
    if (operation === 'test' && !flow && method === 'POST') return 'action:connectors:test';
    if ((operation === 'sign-in' && (flow ? ['GET', 'POST', 'DELETE'].includes(method) : method === 'POST')) ||
        (operation === 'sign-out' && !flow && method === 'POST')) return 'action:connectors:authorize';
  }
  if (['PATCH', 'DELETE'].includes(method) && /^\/api\/connectors\/mcp\/[a-z][a-z0-9_-]{0,31}$/.test(path)) {
    return 'action:connectors:manage';
  }
  const secrets = /^\/api\/extensions\/([a-z][a-z0-9-]{1,30})\/secrets$/.exec(path);
  if (secrets && method === 'POST') return `action:extension:${secrets[1]}:configure`;

  const extension = /^\/api\/ext\/([a-z][a-z0-9-]{1,30})\/([a-z0-9][a-z0-9_.-]{0,63})$/.exec(path);
  if (extension && extension[1] !== 'biz' && ['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    return `action:extension:${extension[1]}:${method.toLowerCase()}:${extension[2]}`;
  }
  return null;
}

/**
 * The framework-freedom capability a panel action also needs, when Biz sends the person's
 * policy (`framework:*`). It narrows the action capability above, never widens it, and is
 * skipped for a Biz that sends no policy. Only the actions the panel exposes can be gated
 * here; machine access, shell, publishing and AI have no panel action (see docs/integration.md).
 * An MCP server may be a catalog one or any: the policy cannot tell them apart from the path,
 * so `catalog` is the floor and the framework core decides the rest.
 */
function frameworkRequirement(method, path) {
  const permission = capability(method, path);
  if (permission === 'action:connectors:manage') return 'framework:mcp_servers:catalog';
  return null;
}

function projectPolicy({env = process.env, profiles, access = projectAccess({env})} = {}) {
  return async function check(req, res) {
    const configured = env.FYSO_BIZ_ACCESS_ORGANIZATION;
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
    if (method === 'POST' && path === '/api/session/logout') {
      profiles.revoke(req);
      return reply(204);
    }
    if (profileRoutes.get(path) === method) return reply(204);

    const session = profiles.current(req);
    if (!session) return reply(403);
    const entryOnly = read.has(method) && (shell.test(path) || panelMetadata.has(path) || path === '/api/session');
    const permission = capability(method, path);
    if (!permission && !entryOnly) return reply(403);
    try {
      const report = await reportOf(access, session.accessToken);
      // A frozen project (the person lost access) is read-only, as the `cuidado` preset: Biz says so
      // (`frozen`) or the last sync recorded it, so it holds while Biz cannot be reached.
      // Biz sends `capabilities: []` when frozen, so reads are allowed here without them.
      if (report.frozen === true || isFrozen(env)) return reply(read.has(method) ? 204 : 403);
      const granted = new Set(report.capabilities);
      const required = report.policy && !entryOnly ? frameworkRequirement(method, path) : null;
      return reply(granted.has('app:panel') && (entryOnly || allows(granted, permission)) && (!required || allows(granted, required)) ? 204 : 403);
    } catch {
      return reply(503);
    }
  };
}

module.exports = {projectPolicy, frameworkRequirement};
