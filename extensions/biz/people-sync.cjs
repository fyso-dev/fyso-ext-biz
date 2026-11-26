// Mirror the people assigned to this project in Fyso Biz into the project's people
// directory (owned by the human-requests extension): one Dagu wiki page per person at
// `fyso-people/<uuid>`, content `{"version":1,"name":…}` plus `"source":"biz"` and
// `"biz_id"`. Only pages marked `source: "biz"` are created, renamed or removed here;
// people added by hand are never touched. Biz-managed access only
// (`biz_access_organization`, `biz_access_project`).
//
// The wiki is written through Dagu's own REST API on the project's loopback port with
// the project's technical Dagu credential, as the framework's dagu-client.cjs does
// (run-ext.sh passes FYSO_DAGU_PORT, FYSO_ADMIN_USER and FYSO_ADMIN_PASSWORD).
// `listar_personas_proyecto` is called on the extension's own Biz session; it is not
// offered to bots (mcp-proxy.cjs ALLOWED).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const PREFIX = 'fyso-people/';
const ID = /^fyso-people\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOL = 'listar_personas_proyecto';
const NAME_MAX = 80, PEOPLE_MAX = 5000, PAGES_MAX = 100;
const LOCK_STALE = 10 * 60 * 1000;
const ERRORS = ['not_configured', 'people_not_supported', 'proyecto_desconocido', 'personas_no_disponibles',
  'project_mismatch', 'unexpected_response', 'wiki_unavailable', 'sync_running', 'missing_project_data'];

/** Managed access is configured only when both answers are set. */
function configured(env = process.env) {
  return Boolean(env.FYSO_BIZ_ACCESS_ORGANIZATION && env.FYSO_BIZ_ACCESS_PROJECT);
}

/**
 * Stable directory id of a Biz person: sha256("fyso-biz-person:<org>:<biz id>"), first
 * 16 bytes, RFC 4122 version 4 and variant bits. Same person, same page, on every run.
 */
function personId(organization, bizId) {
  const bytes = crypto.createHash('sha256').update(`fyso-biz-person:${organization}:${bizId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The page content human-requests reads, with the Biz origin. */
const content = (name, bizId) => JSON.stringify({version: 1, name, source: 'biz', biz_id: bizId}) + '\n';

/** A display name the directory accepts: one line, trimmed, at most 80 characters. */
function cleanName(value) {
  if (typeof value !== 'string') return '';
  return [...value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
}

/** The project's people as Biz lists them; any doubt about the answer changes nothing. */
async function bizPeople(mcp, env) {
  let result;
  try { result = await mcp.call(TOOL, {proyecto: env.FYSO_BIZ_ACCESS_PROJECT}); }
  catch (error) {
    // Biz's own error code travels in the tool error text (proyecto_desconocido, …).
    const known = ['proyecto_desconocido', 'personas_no_disponibles'].find(code => String(error.detail || '').includes(code));
    throw known ? Error(known) : error;
  }
  if (!result || typeof result !== 'object' || !Array.isArray(result.personas) || result.personas.length > PEOPLE_MAX) throw Error('unexpected_response');
  if (String(result.proyecto) !== env.FYSO_BIZ_ACCESS_PROJECT) throw Error('project_mismatch');
  const people = new Map();
  for (const person of result.personas) {
    const bizId = typeof person?.id === 'string' || typeof person?.id === 'number' ? String(person.id) : '';
    const name = cleanName(person?.nombre);
    if (!bizId || bizId.length > 200 || !name) throw Error('unexpected_response');
    people.set(bizId, name);
  }
  return people;
}

/** Dagu's wiki REST API (the same one the panel reaches through /api/dagu/wiki). */
function wiki(env = process.env, transport = fetch) {
  if (!/^[0-9]{1,5}$/.test(env.FYSO_DAGU_PORT || '') || !env.FYSO_ADMIN_USER || !env.FYSO_ADMIN_PASSWORD) throw Error('wiki_unavailable');
  const base = `http://127.0.0.1:${env.FYSO_DAGU_PORT}/api/v1`;
  const headers = {Authorization: 'Basic ' + Buffer.from(`${env.FYSO_ADMIN_USER}:${env.FYSO_ADMIN_PASSWORD}`).toString('base64'),
    'Content-Type': 'application/json'};
  const request = async (method, url, body, {missing} = {}) => {
    let response;
    try { response = await transport(base + url, {method, headers, redirect: 'error', signal: AbortSignal.timeout(10000), ...(body && {body: JSON.stringify(body)})}); }
    catch { throw Error('wiki_unavailable'); }
    if (missing && response.status === 404) return null;
    if (!response.ok) throw Error('wiki_unavailable');
    const text = await response.text();
    try { return text ? JSON.parse(text) : {}; } catch { throw Error('wiki_unavailable'); }
  };
  const page = id => `/wiki/page?path=${encodeURIComponent(id)}`;
  return {
    /** Every directory page id. */
    async list() {
      const ids = [];
      for (let number = 1; number <= PAGES_MAX; number++) {
        const query = new URLSearchParams({flat: 'true', prefix: PREFIX.slice(0, -1), page: String(number), perPage: '100'});
        const data = await request('GET', `/wiki?${query}`);
        if (!Array.isArray(data.items) || typeof data.pagination?.hasNextPage !== 'boolean') throw Error('wiki_unavailable');
        ids.push(...data.items.map(item => item?.id).filter(id => typeof id === 'string' && ID.test(id)));
        if (!data.pagination.hasNextPage) return ids;
      }
      throw Error('wiki_unavailable');
    },
    /** The page's content, or null when it no longer exists. */
    async read(id) {
      const data = await request('GET', page(id), undefined, {missing: true});
      if (data === null) return null;
      if (typeof data.content !== 'string') throw Error('wiki_unavailable');
      return data.content;
    },
    create: (id, text) => request('POST', '/wiki', {id, content: text}),
    update: (id, text) => request('PATCH', page(id), {content: text}),
    remove: id => request('DELETE', page(id), undefined, {missing: true}),
  };
}

/** A directory page this sync owns: valid JSON marked `source: "biz"`. */
function synced(text) {
  try { const record = JSON.parse(text); return record?.source === 'biz' ? record : null; } catch { return null; }
}

/**
 * Bring the directory in line with Biz. Reads Biz first and the whole directory next,
 * so a failed read changes nothing. Returns what changed.
 */
async function sync({mcp, directory, env = process.env}) {
  if (!configured(env)) throw Error('not_configured');
  const people = await bizPeople(mcp, env);
  const organization = env.FYSO_BIZ_ACCESS_ORGANIZATION;
  const wanted = new Map([...people].map(([bizId, name]) => [PREFIX + personId(organization, bizId), {bizId, name}]));
  const current = new Map();
  for (const id of await directory.list()) current.set(id, await directory.read(id));
  const result = {count: wanted.size, created: 0, updated: 0, removed: 0, conflicts: 0};
  for (const [id, {bizId, name}] of wanted) {
    const text = content(name, bizId);
    if (!current.has(id) || current.get(id) === null) { await directory.create(id, text); result.created++; continue; }
    // A page at this id that is not a Biz record was written by a person: leave it.
    if (!synced(current.get(id))) { result.conflicts++; continue; }
    if (current.get(id) !== text) { await directory.update(id, text); result.updated++; }
  }
  for (const [id, text] of current) {
    if (wanted.has(id) || text === null || !synced(text)) continue;
    await directory.remove(id); result.removed++;
  }
  return result;
}

const dataDir = env => {
  if (!env.FYSO_DATA) throw Error('missing_project_data');
  return path.join(env.FYSO_DATA, 'ext', 'biz');
};
const statusFile = env => path.join(dataDir(env), 'people-sync.json');

/** One sync at a time per project (the connection hook and the hourly workflow). */
function lock(env, now = Date.now) {
  const directory = dataDir(env); fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, 'people-sync.lock');
  try { if (now() - fs.statSync(file).mtimeMs > LOCK_STALE) fs.rmSync(file, {force: true}); } catch {}
  try { fs.writeFileSync(file, String(process.pid), {flag: 'wx', mode: 0o600}); }
  catch (error) { if (error.code === 'EEXIST') throw Error('sync_running'); throw error; }
  return () => fs.rmSync(file, {force: true});
}

/** Run one sync and record its outcome for `status()`; the outcome is also returned. */
async function run({env = process.env, mcp, directory, now = () => new Date().toISOString()} = {}) {
  if (!configured(env)) return {managed: false};
  const release = lock(env);
  let outcome;
  try {
    if (!mcp) {
      const biz = require('./biz.cjs');
      const credential = await biz.token(env);
      mcp = biz.client(env.FYSO_BIZ_URL || '', credential.token, fetch, {oauth: credential.oauth});
      await mcp.initialize();
      if (!(await mcp.tools()).some(t => t.name === TOOL)) throw Error('people_not_supported');
    }
    outcome = {ok: true, ...(await sync({mcp, directory: directory || wiki(env), env}))};
  } catch (error) {
    outcome = {ok: false, error: ERRORS.includes(error.message) ? error.message : 'connection_failed'};
  } finally { release(); }
  outcome = {managed: true, at: now(), ...outcome};
  const previous = read(env);
  // Keep the last good count visible while a later run fails.
  const record = outcome.ok ? outcome : {...outcome, ...(previous?.lastOk && {lastOk: previous.lastOk})};
  if (outcome.ok) record.lastOk = {at: outcome.at, count: outcome.count};
  fs.writeFileSync(statusFile(env), JSON.stringify(record) + '\n', {mode: 0o600});
  return record;
}

function read(env) {
  try { return JSON.parse(fs.readFileSync(statusFile(env), 'utf8')); } catch { return null; }
}

/** `people_synced` / `people_count` for GET /status, from the last recorded run. */
function status(env = process.env) {
  if (!configured(env)) return {};
  let last = null; try { last = read(env); } catch {}
  return {people_synced: last?.ok === true, people_count: last?.lastOk?.count ?? null,
    people_sync: last ? {at: last.at, ok: last.ok, ...(last.error && {error: last.error})} : null};
}

module.exports = {PREFIX, TOOL, ERRORS, configured, personId, content, cleanName, bizPeople, wiki, sync, run, status};

if (require.main === module) run().then(result => {
  console.log(JSON.stringify(result));
  if (result.managed && !result.ok) { console.error(`Fyso Biz: people sync failed: ${result.error}`); process.exitCode = 1; }
}, error => { console.error(`Fyso Biz: people sync failed: ${ERRORS.includes(error.message) ? error.message : 'internal_error'}`); process.exitCode = 1; });
