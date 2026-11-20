const {test} = require('node:test');
const assert = require('node:assert/strict');
const {projectAccess} = require('../extensions/biz/project-access.cjs');

const env = {
  FYSO_BIZ_URL: 'https://biz.example',
  FYSO_BIZ_ACCESS_ORGANIZATION: 'acme',
  FYSO_BIZ_ACCESS_PROJECT: 'installation',
};

test('sends the per-person profile token and trusted project configuration to Biz', async () => {
  const access = projectAccess({env, transport: async (url, options) => {
    assert.equal(url.origin, env.FYSO_BIZ_URL);
    assert.equal(options.headers.Authorization, 'Bearer personal-profile');
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/oauth/userinfo') {
      return Response.json({sub: 'person-1', scope: 'framework_access', organization: 'acme'});
    }
    assert.equal(url.pathname, '/oauth/framework-access');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      organization: 'acme', project: 'installation', capability: 'app:dagu',
    });
    return Response.json({allowed: false});
  }});

  assert.deepEqual(await access.identity('personal-profile'), {subject: 'person-1'});
  assert.equal(await access.can('personal-profile', 'app:dagu'), false);
});

test('does not grant access on malformed or unavailable decisions', async () => {
  for (const response of [
    Response.json({allowed: 'true'}),
    Response.json({error: 'unavailable'}, {status: 503}),
  ]) {
    const access = projectAccess({env, transport: async () => response});
    await assert.rejects(access.can('personal-profile', 'app:panel'));
  }
});

test('does not fall back to the installation token', async () => {
  const access = projectAccess({env: {...env, FYSO_BIZ_TOKEN: 'agent-token'}, transport: async () => {
    assert.fail('a request requires an explicit profile token');
  }});
  await assert.rejects(access.can(undefined, 'app:panel'), /profile_required/);
});

test('rejects a profile granted in a different organization', async () => {
  const access = projectAccess({env, transport: async () =>
    Response.json({sub: 'person-1', scope: 'framework_access', organization: 'other'}),
  });
  await assert.rejects(access.identity('wrong-organization'), /invalid_biz_profile/);
});
