const {createHash} = require('node:crypto');
const {origin} = require('./auth.cjs');
const {allows, expandCapabilities, inventoryOf} = require('./department-capabilities.cjs');

const text = value => typeof value === 'string' && value ? value : null;
const level = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The person's departments, keeping only well-formed entries (display data, never a gate). */
function departments(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const id = text(item?.id), name = text(item?.name);
    if (!id || !name) return [];
    const role = item.role && typeof item.role === 'object' ? {
      id: text(item.role.id), name: text(item.role.name), custom: item.role.custom === true,
      levels: Object.fromEntries(Object.entries(item.role.levels && typeof item.role.levels === 'object' ? item.role.levels : {})
        .filter(([, v]) => Number.isSafeInteger(v)).map(([k, v]) => [k, v])),
    } : null;
    const teams = (Array.isArray(item.teams) ? item.teams : []).flatMap(team => text(team?.id) && text(team?.name) ? [{id: team.id, name: team.name}] : []);
    return [{id, name, role, teams}];
  });
}

const POLICY_LEVELS = ['extensions', 'mcp_servers', 'bots', 'read', 'write', 'shell', 'publish', 'ai'];
const PRESET_NAMES = ['cuidado', 'equilibrado', 'libre', 'personalizado'];

/** The person's framework freedom: a preset name and the integer level of each setting. */
function policy(value) {
  if (!value || typeof value !== 'object') return null;
  const preset = PRESET_NAMES.includes(value.preset) ? value.preset : 'personalizado';
  return {preset, ...Object.fromEntries(POLICY_LEVELS.map(key => [key, level(value[key])]))};
}

/**
 * The access report of any `access` object, tolerating one that only offers `capabilities`
 * (an older access client): no policy then, so policy-derived gates stay off.
 */
async function reportOf(access, profileToken) {
  if (typeof access.report === 'function') return access.report(profileToken);
  return {capabilities: await access.capabilities(profileToken), admin: false, departments: [], policy: null, reauthorizeRequired: false};
}

/** The published setup Biz describes (`setup` of the access report), or null. */
function setupOf(value) {
  if (!value || typeof value !== 'object' || !text(value.version)) return null;
  return {version: value.version, etag: text(value.etag), publishedAt: text(value.published_at),
    size: Number.isSafeInteger(value.size) ? value.size : null, sha256: text(value.sha256)};
}

// Access reports are cached per profile token: fresh for 30 s, usable as a fallback for 5 min when
// Biz fails transiently, at most 100 tokens (oldest evicted).
const REPORT_TTL = 30_000, REPORT_STALE = 300_000, REPORT_MAX = 100;
// Report and decision calls are slow server-side (~4 s in production): 15 s for them, 5 s for the rest.
const ACCESS_TIMEOUT = 15_000;

function projectAccess({env = process.env, transport = fetch, now = Date.now, root = process.cwd()} = {}) {
  const cache = new Map();     // sha256(token) -> {at, report}
  const inflight = new Map();  // sha256(token) -> Promise<report>
  const keyOf = token => createHash('sha256').update(String(token)).digest('hex');

  async function get(path, profileToken, {method = 'GET', body, timeout = 5000} = {}) {
    if (typeof profileToken !== 'string' || !profileToken) throw Error('profile_required');
    const response = await transport(new URL(path, origin(env.FYSO_BIZ_URL || '')), {
      method,
      headers: {Authorization: `Bearer ${profileToken}`, Accept: 'application/json', ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw Object.assign(Error('biz_access_unavailable'), {status: response.status});
    return response.status === 204 ? null : response.json();
  }

  const organization = () => {
    if (!env.FYSO_BIZ_ACCESS_ORGANIZATION) throw Error('biz_access_not_configured');
    return new URLSearchParams({organization: env.FYSO_BIZ_ACCESS_ORGANIZATION});
  };

  function query(capability) {
    const organization = env.FYSO_BIZ_ACCESS_ORGANIZATION;
    const project = env.FYSO_BIZ_ACCESS_PROJECT;
    if (!organization) throw Error('biz_access_not_configured');
    // The project is the legacy scope: without it Biz derives access from the person's departments.
    const params = new URLSearchParams({organization});
    if (project) params.set('project', project);
    if (capability !== undefined) params.set('capability', capability);
    return `/oauth/framework-access?${params}`;
  }

  return {
    async identity(profileToken) {
      const profile = await get('/oauth/userinfo', profileToken);
      if (typeof profile?.sub !== 'string' || !profile.sub || profile.scope !== 'framework_access' ||
          profile.organization !== env.FYSO_BIZ_ACCESS_ORGANIZATION) {
        throw Error('invalid_biz_profile');
      }
      return {subject: profile.sub};
    },

    async can(profileToken, capability) {
      // A fresh cached report answers without another Biz call; otherwise ask Biz for this capability.
      const hit = typeof profileToken === 'string' && cache.get(keyOf(profileToken));
      if (hit && now() - hit.at < REPORT_TTL && !hit.report.reauthorizeRequired && hit.report.frozen !== true) {
        return allows(hit.report.capabilities, capability);
      }
      // TEMPORARY: until Biz sends page/action capabilities. Biz does not know the derived ones, so in
      // department mode the (expanded) report decides, unless it is frozen or must be reauthorized.
      if (!env.FYSO_BIZ_ACCESS_PROJECT && typeof profileToken === 'string' && profileToken) {
        const report = await this.report(profileToken);
        if (!report.reauthorizeRequired && report.frozen !== true) return allows(report.capabilities, capability);
      }
      const decision = await get(query(capability), profileToken, {timeout: ACCESS_TIMEOUT});
      if (typeof decision?.allowed !== 'boolean') throw Error('invalid_biz_access_decision');
      return decision.allowed;
    },

    async capabilities(profileToken) {
      return (await this.report(profileToken)).capabilities;
    },

    /**
     * The access report: capabilities (required, fails closed) plus the optional `admin`,
     * `departments` and `policy` of department-based access, and `reauthorizeRequired`. A Biz that
     * does not send them yields `admin: false`, `departments: []`, `policy: null` and `false`.
     */
    async report(profileToken) {
      if (typeof profileToken !== 'string' || !profileToken) throw Error('profile_required');
      const key = keyOf(profileToken);
      const hit = cache.get(key);
      if (hit && now() - hit.at < REPORT_TTL) return hit.report;
      if (inflight.has(key)) return inflight.get(key);
      const request = this.fetchReport(profileToken).then(report => {
        if (inflight.get(key) !== request) return report;
        cache.delete(key);
        for (const [k, entry] of cache) if (now() - entry.at >= REPORT_STALE) cache.delete(k);
        while (cache.size >= REPORT_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, {at: now(), report});
        return report;
      }, error => {
        // Transient failure: keep the owner in with a report under five minutes old. A rejected
        // credential (401/403) is never masked; a fresh reauthorize/frozen answer is a success and
        // replaces the entry, so it takes effect at once.
        const transient = error?.status >= 500 || (error?.status === undefined && error?.message !== 'invalid_biz_access_decision');
        if (hit && now() - hit.at < REPORT_STALE && transient) return hit.report;
        throw error;
      }).finally(() => { if (inflight.get(key) === request) inflight.delete(key); });
      inflight.set(key, request);
      return request;
    },

    /** Forget the cached report of a token (login, logout, revoke, setup changes). */
    invalidate(profileToken) {
      if (typeof profileToken !== 'string' || !profileToken) return;
      const key = keyOf(profileToken);
      cache.delete(key);
      inflight.delete(key);
    },

    async fetchReport(profileToken) {
      const report = await get(query(), profileToken, {timeout: ACCESS_TIMEOUT});
      if (!Array.isArray(report?.capabilities) ||
          report.capabilities.some(value => typeof value !== 'string')) throw Error('invalid_biz_access_decision');
      // `reauthorize_required`: an old grant whose identity Biz cannot recover. It is not "no
      // departments": the person must reconnect Fyso Biz.
      const base = {capabilities: report.capabilities, admin: report.admin === true,
        departments: departments(report.departments), policy: policy(report.policy),
        reauthorizeRequired: report.reauthorize_required === true,
        // Managed setup: the published setup, the response etag (changes with anything that
        // affects the member), pending recipients (admins only) and the freeze flag.
        // Present only when Biz sends them; absent means no setup, no etag, none pending, not frozen.
        ...(setupOf(report.setup) ? {setup: setupOf(report.setup)} : {}), ...(text(report.etag) ? {etag: text(report.etag)} : {}),
        ...(report.recipients_pending > 0 && Number.isSafeInteger(report.recipients_pending) ? {recipientsPending: report.recipients_pending} : {}),
        ...(report.frozen === true ? {frozen: true} : {})};
      // TEMPORARY: until Biz sends page/action capabilities (department mode only).
      return env.FYSO_BIZ_ACCESS_PROJECT ? base : expandCapabilities(base, {inventory: inventoryOf(root)});
    },

    /** Register this installation's age public key for the organization's setup (one per person). */
    async registerRecipient(profileToken, ageKey) {
      if (!/^age1[0-9a-z]{40,100}$/.test(ageKey || '')) throw Error('invalid_age_key');
      await get(`/oauth/framework-access/recipient?${organization()}`, profileToken, {method: 'PUT', body: {age_public_key: ageKey}});
    },

    /** Admins: the registered recipients and their etag. */
    async recipients(profileToken) {
      const result = await get(`/oauth/framework-access/recipients?${organization()}`, profileToken);
      if (!Array.isArray(result?.recipients)) throw Error('invalid_biz_access_decision');
      return {recipients: result.recipients, etag: text(result.etag)};
    },
  };
}

module.exports = {projectAccess, reportOf, departments, policy};
