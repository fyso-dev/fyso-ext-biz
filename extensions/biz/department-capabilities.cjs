// TEMPORARY: until Biz sends page/action capabilities.
//
// In department mode (no `FYSO_BIZ_ACCESS_PROJECT`) Biz sends `app:panel`, `app:mcp`, the
// `framework:*` ones, `admin` and the per-department role levels (`objetivos`, `agentes`,
// `fuentes`, 0..2), but not the page/action capabilities the panel and `project-policy.cjs` check.
// `expandCapabilities` derives them from those levels, once per access report, so `/profile/access`
// and the gateway policy see the same set. Delete this file when Biz sends them.
const fs = require('node:fs');
const path = require('node:path');

const AREAS = ['objetivos', 'agentes', 'fuentes'];
const FRAMEWORK_APPS = new Set(['dagu', 'omb']);
const DAG = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const ID = /^[a-z][a-z0-9-]{1,30}$/;
const APP_ID = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Whether the grant `pattern` covers `capability`. A pattern without `*` is an exact match. `*`
 * matches one `:`-separated segment; a trailing `*` matches the rest (one or more segments).
 */
function matches(pattern, capability) {
  if (typeof pattern !== 'string' || typeof capability !== 'string') return false;
  if (!pattern.includes('*')) return pattern === capability;
  const want = pattern.split(':'), have = capability.split(':');
  if (want.every(part => part === '*')) return false;
  const rest = want.at(-1) === '*';
  if (rest ? have.length < want.length : have.length !== want.length) return false;
  return want.every((part, index) => (rest && index === want.length - 1) || part === '*' || part === have[index]);
}

/** Whether any grant (an array or a Set, wildcards allowed) covers `capability`. */
function allows(grants, capability) {
  const list = grants instanceof Set ? grants : new Set(grants);
  if (list.has(capability)) return true;
  for (const grant of list) if (grant.includes('*') && matches(grant, capability)) return true;
  return false;
}

/** The highest level of each area over the person's departments (0 none, 1 read, 2 operate). */
function levelsOf(report) {
  const levels = Object.fromEntries(AREAS.map(area => [area, 0]));
  if (report.admin === true) return Object.fromEntries(AREAS.map(area => [area, 2]));
  for (const department of report.departments || []) {
    for (const area of AREAS) {
      const value = department?.role?.levels?.[area];
      if (Number.isSafeInteger(value)) levels[area] = Math.max(levels[area], Math.min(2, value));
    }
  }
  return levels;
}

const idsOf = (names, test) => [...new Set(names.filter(name => test.test(name)))].sort();

/**
 * What is installed in the project root: extension ids (`.copier-answers.ext-<id>.yml`), app ids
 * (the `id:` of framework/apps, project/apps and extensions app files) and workflow names
 * (project/workflows and framework/workflows; the `name:` or the file name).
 */
function inventoryOf(root = process.cwd()) {
  const list = dir => { try { return fs.readdirSync(path.join(root, dir)); } catch { return []; } };
  const read = file => { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; } };
  const extensions = idsOf(list('.').flatMap(file => /^\.copier-answers\.ext-(.+)\.yml$/.exec(file)?.[1] ?? []), ID);
  const appFiles = [
    ...list('framework/apps').filter(file => file.endsWith('.yaml')).map(file => `framework/apps/${file}`),
    ...list('project/apps').map(dir => `project/apps/${dir}/app.yaml`),
    ...list('extensions').map(dir => `extensions/${dir}/app.yaml`),
  ];
  const apps = [...new Map(appFiles.flatMap(file => {
    const id = /^id:\s*["']?([A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/m.exec(read(file))?.[1];
    return id && APP_ID.test(id) ? [[id, {id, framework: file.startsWith('framework/') && FRAMEWORK_APPS.has(id)}]] : [];
  })).values()];
  const workflows = idsOf(['project/workflows', 'framework/workflows'].flatMap(dir => list(dir)
    .filter(file => file.endsWith('.yaml'))
    .map(file => /^name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*(?:#.*)?$/m.exec(read(`${dir}/${file}`))?.[1] ?? file.slice(0, -5))), DAG);
  return {extensions, apps, workflows};
}

/**
 * The report with the page/action capabilities its role levels imply, added to Biz's own. Wildcard
 * grants (`workflow:*:run`, `page:extension:*`, `action:extension:*`) cover what the gateway sees
 * but the panel matches exactly, so the concrete ids it checks are listed too (from `inventory`).
 * Unchanged when frozen, when the identity must be reauthorized or when `app:panel` is not granted.
 */
function expandCapabilities(report, {inventory = {extensions: [], apps: [], workflows: []}} = {}) {
  if (!report || report.frozen === true || report.reauthorizeRequired === true ||
      !report.capabilities.includes('app:panel')) return report;
  const {objetivos, agentes, fuentes} = levelsOf(report);
  const add = [
    'action:feedback:submit', 'page:extension:biz', 'action:biz:disconnect-agent', 'page:panel:setup',
  ];
  if (agentes >= 1) {
    add.push('action:bots:list', 'action:bots:read-team', 'action:bots:read-versioning', 'action:skills:list',
      'action:observability:read', 'action:workflows:list', 'action:workflows:list-runs',
      'workflow:*:read', 'workflow:*:read-outputs', 'action:wiki:read', 'page:extension:*',
      'page:panel:bots', 'page:panel:observability', 'page:panel:apps',
      ...inventory.extensions.map(id => `page:extension:${id}`),
      ...inventory.apps.filter(app => !app.framework).map(app => `app:${app.id}`));
  }
  if (agentes >= 2) {
    add.push('workflow:*:run', 'action:wiki:write', 'action:extension:*',
      ...inventory.workflows.map(name => `workflow:${name}:run`),
      ...inventory.extensions.map(id => `action:extension:${id}:configure`),
      ...inventory.apps.filter(app => app.framework).map(app => `app:${app.id}`));
  }
  if (fuentes >= 1) add.push('action:connectors:read', 'page:panel:connectors');
  if (fuentes >= 2) add.push('action:connectors:manage', 'action:connectors:authorize', 'action:connectors:test', 'action:connectors:configure');
  if (objetivos >= 1) {
    add.push('action:biz:read-status', 'action:biz:read-teams', 'action:biz:read-context',
      'action:biz:read-objective', 'action:biz:read-work', 'action:biz:read-mailboxes');
  }
  if (objetivos >= 2) add.push('action:biz:create-work', 'action:biz:manage-mailboxes');
  return {...report, capabilities: [...new Set([...report.capabilities, ...add])]};
}

/** The capabilities the panel can match: its exact-match check cannot use wildcard grants. */
const concrete = capabilities => capabilities.filter(capability => !capability.includes('*'));

module.exports = {matches, allows, expandCapabilities, inventoryOf, concrete};
