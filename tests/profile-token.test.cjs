const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {harness, WINDOWS} = require('./helpers/index.cjs');

const filename = require.resolve('../extensions/biz/profile-token.cjs');

async function tokenCommand(store) {
  const entry = {};
  const output = {stdout: '', stderr: [], exitCode: 0};
  // Execute the actual CLI entry point with the production store wired to the shared fake transport.
  const requireFromCommand = id => {
    assert.equal(id, './auth.cjs');
    return {store: () => store};
  };
  requireFromCommand.main = entry;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: entry,
    require: requireFromCommand,
    process: {
      stdout: {write: chunk => { output.stdout += chunk; }},
      set exitCode(code) { output.exitCode = code; },
    },
    console: {error: line => output.stderr.push(line)},
  }, {filename});
  await new Promise(resolve => setImmediate(resolve));
  return output;
}

test('token command refreshes at the renewal margin and persists the rotated grant', async t => {
  const h = harness(t);
  const original = h.project.readProfileGrant();
  const lifetime = h.biz.credentialExpiresIn * 1000;
  h.clock.advance(lifetime - WINDOWS.REFRESH_MARGIN_MS - 1);
  assert.deepEqual(await tokenCommand(h.store), {stdout: 'profile-token\n', stderr: [], exitCode: 0});
  assert.equal(h.biz.count('oauth.token'), 0);
  h.clock.advance(1);
  assert.deepEqual(await tokenCommand(h.store), {stdout: 'access-1\n', stderr: [], exitCode: 0});
  assert.deepEqual(h.biz.last('oauth.token').body, {
    grant_type: 'refresh_token', refresh_token: original.refreshToken, client_id: original.clientId,
  });
  const saved = h.project.readProfileGrant();
  assert.equal(saved.accessToken, 'access-1');
  assert.equal(saved.refreshToken, 'refresh-1');
  assert.equal(saved.expiresAt, h.clock.now() + lifetime);
  assert.equal(saved.connectedAt, original.connectedAt);
});

test('token command fails closed when Biz refuses an expired grant', async t => {
  const h = harness(t);
  const original = h.project.readProfileGrant();
  h.clock.advance(WINDOWS.CREDENTIAL_EXPIRY_MS);
  h.biz.refreshRefused = true;
  assert.deepEqual(await tokenCommand(h.store), {stdout: '', stderr: ['Fyso Biz: connection_failed'], exitCode: 1});
  assert.equal(h.biz.count('oauth.token'), 1);
  assert.equal(h.biz.last('oauth.token').outcome.status, 400);
  assert.deepEqual(h.project.readProfileGrant(), original);
});

test('token command reports a missing grant without calling Biz', async t => {
  const h = harness(t, {grant: false});
  assert.deepEqual(await tokenCommand(h.store), {stdout: '', stderr: ['Fyso Biz: not_connected'], exitCode: 1});
  assert.equal(h.biz.count(), 0);
});

test('profile OAuth exchange records the expiry Biz says (expires_in, one hour on the real Biz)', async t => {
  const h = harness(t, {grant: false});
  const pending = await h.store.beginProfile('https://panel.example.test/callback');
  const issuedAt = h.clock.now();
  const grant = await h.store.finishProfile(pending, 'oauth-code');
  assert.equal(grant.expiresAt, issuedAt + h.biz.credentialExpiresIn * 1000);
  h.store.saveProfile(grant);
  assert.equal(h.project.readProfileGrant().expiresAt, grant.expiresAt);
});
