const {projectAccess, reportOf} = require('./project-access.cjs');
const {isFrozen} = require('./managed-setup.cjs');
const {allows} = require('./department-capabilities.cjs');
const fs = require('node:fs');
const path = require('node:path');
const {addresses} = require('./auth.cjs');

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

// Hosts the framework itself serves (Caddyfile); an app file cannot claim them. `panel` is the
// panel branch below and `auth` never goes through this gate.
const frameworkHosts = new Map([['omb', 'app:omb'], ['dagu', 'app:dagu']]);
const reservedHosts = new Set(['panel', 'auth', 'omb', 'dagu', 'biz']);
const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APPS_TTL = 30 * 1000;

/**
 * Subdomain -> app capability for the apps installed in the project root: an app whose `url` host is
 * `<sub>.${FYSO_WEB_DOMAIN}` (framework/apps, project/apps/*, extensions/*, as in `inventoryOf`) maps
 * `<sub>` to `app:<id>`. The framework hosts (omb, dagu) are fixed and cannot be overridden.
 */
function appHostsOf(root, domain) {
  const hosts = new Map();
  const list = dir => { try { return fs.readdirSync(path.join(root, dir)); } catch { return []; } };
  const files = [
    ...list('framework/apps').filter(file => file.endsWith('.yaml')).map(file => `framework/apps/${file}`),
    ...list('project/apps').map(dir => `project/apps/${dir}/app.yaml`),
    ...list('extensions').map(dir => `extensions/${dir}/app.yaml`),
  ];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    const id = /^id:\s*["']?([A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/m.exec(text)?.[1];
    const url = /^url:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(text)?.[1];
    if (!id || !url) continue;
    let host;
    try { host = new URL(url.replace(/\$\{FYSO_WEB_DOMAIN\}/g, domain).replace(/\$\{[A-Z_]+\}/g, '0')).hostname.toLowerCase(); } catch { continue; }
    if (!host.endsWith(`.${domain}`)) continue;
    const sub = host.slice(0, -domain.length - 1);
    if (hostLabel.test(sub) && !reservedHosts.has(sub) && !hosts.has(sub)) hosts.set(sub, `app:${id}`);
  }
  return hosts;
}

/** `<sub>` of `<sub>.${domain}`, or null (also for the bare domain and nested subdomains). */
function subdomainOf(host, domain) {
  if (typeof host !== 'string' || !domain) return null;
  const name = host.toLowerCase();
  if (!name.endsWith(`.${domain.toLowerCase()}`)) return null;
  const sub = name.slice(0, -domain.length - 1);
  return hostLabel.test(sub) ? sub : null;
}

function projectPolicy({env = process.env, profiles, access = projectAccess({env}), root = process.cwd(), now = Date.now} = {}) {
  let appHosts = null, appHostsAt = 0;
  const hostCapability = sub => {
    if (!appHosts || now() - appHostsAt > APPS_TTL) { appHosts = appHostsOf(root, env.FYSO_WEB_DOMAIN); appHostsAt = now(); }
    return frameworkHosts.get(sub) ?? appHosts.get(sub) ?? null;
  };

  /**
   * Another host of the project (omb., dagu., docs., biz., an app's own). The UIs behind them have
   * their own per-request semantics, so any method and path is allowed when the person holds
   * `app:panel` and the host's app capability. The profile cookie is host-only on the panel and never
   * reaches these hosts, so the gateway's `Remote-User` finds the person's latest live profile session
   * (which was bound to that same user when it was created). No session: 403, and a sign-in
   * redirect to the panel for a navigation to `/`. A frozen project allows reads only.
   */
  async function appHost(req, res, {sub, method, path, reply}) {
    // The login for the agent's own Biz connection (`/login`, then Biz returns to `/callback`): it
    // changes state, so it needs the Biz page and is refused while frozen.
    const login = sub === 'biz';
    if (login && !(method === 'GET' && (path === '/login' || path === '/callback'))) return reply(403);
    const permission = login ? 'page:extension:biz' : hostCapability(sub);
    if (!permission) return reply(403);
    const session = profiles.forUser?.(req.headers['remote-user']) ?? null;
    if (!session) {
      if (method === 'GET' && path === '/') {
        try { return res.writeHead(303, {'Cache-Control': 'no-store', Location: new URL(signIn, addresses(env).page).href}).end(); } catch { /* no public address */ }
      }
      return reply(403);
    }
    try {
      const report = await reportOf(access, session.accessToken);
      if (report.frozen === true || isFrozen(env)) return reply(!login && read.has(method) ? 204 : 403);
      const granted = new Set(report.capabilities);
      return reply(granted.has('app:panel') && allows(granted, permission) ? 204 : 403);
    } catch {
      return reply(503);
    }
  }

  return async function check(req, res) {
    const configured = env.FYSO_BIZ_ACCESS_ORGANIZATION;
    const reply = status => res.writeHead(status, {'Cache-Control': 'no-store'}).end();
    if (!configured) return reply(204);
    if (!req.headers['remote-user']) return reply(401);
    const host = req.headers['x-fyso-policy-host'];
    const panel = host === `panel.${env.FYSO_WEB_DOMAIN}`;
    const sub = panel ? null : subdomainOf(host, env.FYSO_WEB_DOMAIN);
    if (!panel && !sub) return reply(403);
    const method = req.headers['x-forwarded-method'];
    const path = req.headers['x-fyso-policy-path'] || '';
    if (path.includes('%') || path.includes('\\') || path.includes('//') ||
        path.split('/').some(segment => segment === '.' || segment === '..')) return reply(403);
    if (!panel) return appHost(req, res, {sub, method, path, reply});
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
