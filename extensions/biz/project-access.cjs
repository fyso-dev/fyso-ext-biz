const {origin} = require('./auth.cjs');

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

function projectAccess({env = process.env, transport = fetch} = {}) {
  async function get(path, profileToken, {method = 'GET', body} = {}) {
    if (typeof profileToken !== 'string' || !profileToken) throw Error('profile_required');
    const response = await transport(new URL(path, origin(env.FYSO_BIZ_URL || '')), {
      method,
      headers: {Authorization: `Bearer ${profileToken}`, Accept: 'application/json', ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('biz_access_unavailable');
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
      const decision = await get(query(capability), profileToken);
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
      const report = await get(query(), profileToken);
      if (!Array.isArray(report?.capabilities) ||
          report.capabilities.some(value => typeof value !== 'string')) throw Error('invalid_biz_access_decision');
      // `reauthorize_required`: an old grant whose identity Biz cannot recover. It is not "no
      // departments": the person must reconnect Fyso Biz.
      return {capabilities: report.capabilities, admin: report.admin === true,
        departments: departments(report.departments), policy: policy(report.policy),
        reauthorizeRequired: report.reauthorize_required === true,
        // Managed setup: the published setup, the response etag (changes with anything that
        // affects the member), pending recipients (admins only) and the freeze flag.
        // Present only when Biz sends them; absent means no setup, no etag, none pending, not frozen.
        ...(setupOf(report.setup) ? {setup: setupOf(report.setup)} : {}), ...(text(report.etag) ? {etag: text(report.etag)} : {}),
        ...(report.recipients_pending > 0 && Number.isSafeInteger(report.recipients_pending) ? {recipientsPending: report.recipients_pending} : {}),
        ...(report.frozen === true ? {frozen: true} : {})};
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
