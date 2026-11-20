const {origin} = require('./auth.cjs');

function projectAccess({env = process.env, transport = fetch} = {}) {
  async function get(path, profileToken) {
    if (typeof profileToken !== 'string' || !profileToken) throw Error('profile_required');
    const response = await transport(new URL(path, origin(env.FYSO_BIZ_URL || '')), {
      headers: {Authorization: `Bearer ${profileToken}`, Accept: 'application/json'},
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('biz_access_unavailable');
    return response.json();
  }

  function query(capability) {
    const organization = env.FYSO_BIZ_ACCESS_ORGANIZATION;
    const project = env.FYSO_BIZ_ACCESS_PROJECT;
    if (!organization || !project) throw Error('biz_access_not_configured');
    const params = new URLSearchParams({organization, project});
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
      const report = await get(query(), profileToken);
      if (!Array.isArray(report?.capabilities) ||
          report.capabilities.some(value => typeof value !== 'string')) throw Error('invalid_biz_access_decision');
      return report.capabilities;
    },
  };
}

module.exports = {projectAccess};
