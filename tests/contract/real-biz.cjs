'use strict';
// Dependency-free access to a real local Biz (the stack of fyso-business infra/local): configuration from the
// environment, the sign-in a person does (login, consent) and the fake-fyso admin endpoints. Nothing here
// prints a password, a cookie or a token.
const fs = require('node:fs');

const parseEnvFile = text => Object.fromEntries(text.split(/\r?\n/).map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(m => [m[1], m[2]]));

/** null when BIZ_CONTRACT_URL is not set (the suite then skips). */
function loadConfig(env = process.env) {
  if (!env.BIZ_CONTRACT_URL) return null;
  const file = env.BIZ_CONTRACT_CREDENTIALS;
  if (!file) throw Error('BIZ_CONTRACT_CREDENTIALS must point to the stack\'s credentials.env');
  const credentials = parseEnvFile(fs.readFileSync(file, 'utf8'));
  return {
    url: new URL(env.BIZ_CONTRACT_URL).origin,
    organization: env.BIZ_CONTRACT_ORGANIZATION || credentials.BIZ_ORGANIZATION || 'local-org',
    fakeFysoUrl: env.BIZ_CONTRACT_FAKE_FYSO_URL || credentials.FAKE_FYSO_URL || null,
    fakeFysoToken: env.BIZ_CONTRACT_FAKE_FYSO_ADMIN_TOKEN || credentials.FAKE_FYSO_ADMIN_TOKEN || null,
    persona: key => {
      const email = credentials[`${key.toUpperCase()}_EMAIL`], password = credentials[`${key.toUpperCase()}_PASSWORD`];
      if (!email || !password) throw Error(`credentials.env has no ${key.toUpperCase()}_EMAIL / _PASSWORD`);
      return {email, password};
    },
  };
}

/** The Cookie header of a signed-in person (POST /api/auth/login). */
async function login(config, key) {
  const response = await fetch(`${config.url}/api/auth/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(config.persona(key))});
  const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  if (response.status !== 200 || !cookies.includes('session=')) throw Error(`login of ${key} failed (HTTP ${response.status})`);
  return cookies;
}

/**
 * What a person's browser does between `store.beginProfile` and the callback: open the consent page, press
 * "approve" and read the `code` Biz puts on the redirect back. Returns it for `store.finishProfile`.
 */
async function approve(config, cookies, authorizeUrl, pending) {
  const url = new URL(authorizeUrl);
  const page = await fetch(url, {headers: {cookie: cookies}, redirect: 'manual'});
  if (page.status !== 200) throw Error(`consent page: HTTP ${page.status}`);
  const response = await fetch(`${config.url}/api/oauth/authorize`, {method: 'POST', headers: {'content-type': 'application/json', cookie: cookies, origin: config.url},
    body: JSON.stringify({accion: 'aprobar', peticion: url.search})});
  const body = await response.json().catch(() => ({}));
  if (!body.redirectTo) throw Error(`consent: HTTP ${response.status}`);
  const back = new URL(body.redirectTo);
  if (back.searchParams.get('state') !== pending.state) throw Error('consent: state mismatch');
  return back.searchParams.get('code');
}

/** The fake Fyso that stands in for the backend: deactivate / reactivate / remove-membership / restore-membership. */
async function fakeFyso(config, action, email) {
  if (!config.fakeFysoUrl || !config.fakeFysoToken) throw Error('no fake-fyso configured');
  const response = await fetch(`${config.fakeFysoUrl}/__admin/users/${action}`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${config.fakeFysoToken}`}, body: JSON.stringify({email})});
  if (!response.ok) throw Error(`fake-fyso ${action}: HTTP ${response.status}`);
}

module.exports = {loadConfig, parseEnvFile, login, approve, fakeFyso};
