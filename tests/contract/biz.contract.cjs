'use strict';
// Tier 2: the scenarios of tests/helpers/fake-biz.cjs replayed against a real local Biz.
//
// Each scenario is ONE function driving the production client code (extensions/biz/project-access.cjs and the
// auth.cjs store) and is run twice: against fakeBiz and against the real Biz. The test asserts that
//   1. the parsed outcomes agree (what the production code made of the answers), and
//   2. the raw wire exchanges agree: same status, same selected headers, same JSON keys and value types
//      recursively (shape.cjs; volatile values such as etags, ids, names and timestamps never matter).
// When they disagree, the fake is wrong and tests/helpers/fake-biz.cjs gets fixed.
//
//   BIZ_CONTRACT_URL=http://localhost:8787 BIZ_CONTRACT_CREDENTIALS=<path to credentials.env> node --test tests/contract/
// See .env.local-biz.example. Without BIZ_CONTRACT_URL the whole suite is skipped.
const {test, describe, after} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const {fakeBiz} = require('../helpers/fake-biz.cjs');
const {tempProject} = require('../helpers/temp-project.cjs');
const {projectAccess} = require('../../extensions/biz/project-access.cjs');
const {store} = require('../../extensions/biz/auth.cjs');
const {loadConfig, login, approve, fakeFyso} = require('./real-biz.cjs');
const {describeDiff} = require('./shape.cjs');

/** What this stack cannot produce, so the fake's matching scenario has no real counterpart here. Nothing is omitted silently. */
const SKIPPED_ON_REAL = [
  ['report/setup `reauthorize_required` (expired embedded Fyso credential)', 'Biz computes the 8 h credential expiry on its own clock (iniciar-sesion-global.ts); fake-fyso cannot advance it. Reference: the Biz-side fixture (expired, expired_setup).'],
  ['a Fyso 401 turned into `reauthorize_required`', 'fake-fyso offers no failure injection to answer a 401 on demand. Reference: the Biz-side fixture (fyso_401, fyso_401_setup).'],
  ['503 `policy_unavailable` / `setup_unavailable`', 'fake-fyso offers no failure injection (deactivate, reactivate, remove-membership, restore-membership, reset only). Reference: the Biz-side fixture (fyso_500, fyso_500_setup).'],
  ['timeout / hang / network error / single-flight holds', 'Client-side behaviour of the transport: a healthy local Biz cannot be made slow or unreachable on demand.'],
  ['413 `too_large` (setup bundle over 50 MiB)', 'Would upload 50 MiB per run; the limit is Biz\'s LIMITE_PAQUETE.'],
  ['revoked grant (`biz.revoke`)', 'The fake revokes a token at will; the real revocation flow (revocation_endpoint) is not driven by this suite yet.'],
  ['`recipients_pending` counted from zero registered keys', 'Needs an organization where nobody has registered a key yet (a freshly started stack): on a used one the scenario says so and is skipped, never passed.'],
];

const config = loadConfig();
const SKIP = config ? false : 'BIZ_CONTRACT_URL is not set: start the local Biz stack of fyso-business (infra/local) and see .env.local-biz.example';

const PERSONAS = {admin: 'propietario', admin2: 'admin2', member: 'miembro', noAccess: 'sinacceso', congelable: 'congelable'};
const FAKE_SCENARIO = {admin: 'admin', admin2: 'admin', member: 'member', noAccess: 'noAccess', congelable: 'member'};
const REDIRECT = 'http://localhost:47615/callback';
const AGE_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const newAgeKey = () => `age1${Array.from({length: 58}, () => AGE_ALPHABET[crypto.randomInt(AGE_ALPHABET.length)]).join('')}`;
const PEOPLE_WITH_ACCESS = 4;
const WIRE_HEADERS = ['content-type', 'www-authenticate', 'allow', 'etag', 'x-setup-version', 'x-setup-sha256'];

const cleanups = [];
after(() => { for (const clean of cleanups) clean(); });

// ---- targets -------------------------------------------------------------------------------------------------------

/** A recording `transport`: every exchange is kept as {key, status, headers, body} for the wire comparison. */
function recording(base) {
  const log = [];
  const transport = async (input, options = {}) => {
    const response = await base(input, options);
    if (transport.muted) return response;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const entry = {key: `${String(options.method ?? 'GET').toUpperCase()} ${url.pathname}`, status: response.status, headers: {}, body: null};
    for (const name of WIRE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) entry.headers[name] = name === 'content-type' ? value.split(';')[0].trim() : '<present>';
    }
    const copy = response.clone();
    entry.done = copy.arrayBuffer().then(bytes => {
      const text = Buffer.from(bytes).toString('utf8');
      try { entry.body = JSON.parse(text); } catch { entry.body = {__raw: bytes.byteLength ? 'binary' : 'empty'}; }
    });
    log.push(entry);
    return response;
  };
  transport.muted = false; // concurrent calls complete in any order: their wire is left out, their outcomes are compared
  transport.take = async () => { const out = log.splice(0); await Promise.all(out.map(e => e.done)); return out.map(({done, ...rest}) => rest); };
  return transport;
}

/**
 * @param {'fake'|'real'} kind
 * @param {{setupVersion: string|null, pending: number}} mirror what the real Biz holds now, copied into the fake so both start equal
 */
function makeTarget(kind, mirror) {
  const organization = config.organization;
  const biz = kind === 'fake' ? fakeBiz({url: config.url, organization, scenario: 'member', setupVersion: mirror.setupVersion}).pendingRecipients(mirror.pending) : null;
  if (biz) biz.strictTokens = true;
  const transport = recording(kind === 'fake' ? biz.fetch : fetch);
  const sessions = new Map();  // real: persona -> Cookie header
  const tokens = new Map();    // persona -> access token
  const projects = [];

  const project = () => {
    const dir = tempProject(null, {seed: false, organization, bizUrl: config.url});
    projects.push(dir); cleanups.push(dir.cleanup);
    return {dir, env: dir.env, access: () => projectAccess({env: dir.env, transport, root: dir.root}), auth: (now = Date.now) => store({env: dir.env, transport, now})};
  };

  const target = {
    kind, biz, organization, url: config.url, transport, project,
    /** The production sign-in: beginProfile, the person's consent, finishProfile. */
    async signIn(persona, {save = false, workspace = project()} = {}) {
      const auth = workspace.auth();
      const pending = await auth.beginProfile(REDIRECT);
      let code = 'code-1';
      if (kind === 'real') {
        if (!sessions.has(persona)) sessions.set(persona, await login(config, PERSONAS[persona]));
        code = await approve(config, sessions.get(persona), pending.url, pending);
      }
      const grant = await auth.finishProfile(pending, code);
      if (kind === 'fake') biz.person(grant.accessToken, {scenario: FAKE_SCENARIO[persona], sub: `person-${persona}`});
      if (save) auth.saveProfile(grant);
      return {grant, auth, workspace};
    },
    /** One access token per persona, cached for the run. */
    async token(persona) {
      if (!tokens.has(persona)) tokens.set(persona, (await target.signIn(persona)).grant.accessToken);
      return tokens.get(persona);
    },
    async setActive(persona, active) {
      if (kind === 'real') await fakeFyso(config, active ? 'reactivate' : 'deactivate', config.persona(PERSONAS[persona]).email);
      else biz.person(await target.token(persona), {scenario: active ? FAKE_SCENARIO[persona] : 'frozen', sub: `person-${persona}`});
    },
    async setMember(persona, member) {
      if (kind === 'real') await fakeFyso(config, member ? 'restore-membership' : 'remove-membership', config.persona(PERSONAS[persona]).email);
      else biz.person(await target.token(persona), {scenario: member ? FAKE_SCENARIO[persona] : 'frozen', sub: `person-${persona}`});
    },
    /** A raw request, through the recording transport. */
    async raw(method, pathAndQuery, {token = null, headers = {}, body} = {}) {
      const response = await transport(new URL(pathAndQuery, config.url), {method, headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...headers}, ...(body === undefined ? {} : {body})});
      const bytes = Buffer.from(await response.arrayBuffer());
      let json = null; try { json = JSON.parse(bytes.toString('utf8')); } catch { /* not JSON */ }
      return {status: response.status, headers: response.headers, json, bytes};
    },
    q: (route, extra = '') => `${route}?organization=${organization}${extra}`,
  };
  return target;
}

// ---- comparison ----------------------------------------------------------------------------------------------------

async function realMirror() {
  const real = makeTarget('real', {setupVersion: null, pending: 0});
  const admin = await real.token('admin');
  const report = (await real.raw('GET', real.q('/oauth/framework-access'), {token: admin})).json;
  const listed = (await real.raw('GET', real.q('/oauth/framework-access/recipients'), {token: admin})).json;
  return {setupVersion: report.setup?.version ?? null, pending: report.recipients_pending ?? 0, registered: listed?.recipients?.length ?? 0};
}

/** Run `scenario` on the fake and on the real Biz and assert that outcomes and wire exchanges agree. */
async function agree(t, scenario, {needsFreshSetup = false, needsFreshRecipients = false} = {}) {
  const mirror = await realMirror();
  if (needsFreshSetup && mirror.setupVersion) return t.skip(`the real organization already has setup ${mirror.setupVersion}; this scenario needs a fresh stack (node infra/local/orquestador.mjs down, then up)`);
  if (needsFreshRecipients && mirror.registered > 0) return t.skip(`${mirror.registered} person(s) already registered a key in the real organization; this scenario needs a fresh stack (node infra/local/orquestador.mjs down, then up)`);
  const results = {};
  for (const kind of ['fake', 'real']) {
    const target = makeTarget(kind, mirror);
    const outcome = await scenario(target);
    results[kind] = {outcome, wire: await target.transport.take()};
  }
  try { assert.deepEqual(results.fake.outcome, results.real.outcome); }
  catch (error) { throw new Error(`parsed outcomes differ (+ fake, - real)\n${error.message.replace(/^Expected values to be strictly deep-equal:\n\+ actual - expected\n?/, '')}`); }
  const problems = [];
  const {fake, real} = results;
  if (fake.wire.length !== real.wire.length) problems.push(`the wire exchanges differ in number: fake ${fake.wire.map(e => e.key).join(', ')} / real ${real.wire.map(e => e.key).join(', ')}`);
  for (let i = 0; i < Math.min(fake.wire.length, real.wire.length); i++) {
    const [f, r] = [fake.wire[i], real.wire[i]], label = `#${i + 1} ${r.key}`;
    if (f.key !== r.key) { problems.push(`${label}: the fake made ${f.key}`); continue; }
    if (f.status !== r.status) problems.push(`${label}: status fake ${f.status}, real ${r.status} (real body ${JSON.stringify(r.body)}, fake body ${JSON.stringify(f.body)})`);
    if (JSON.stringify(f.headers) !== JSON.stringify(r.headers)) problems.push(`${label}: headers fake ${JSON.stringify(f.headers)}, real ${JSON.stringify(r.headers)}`);
    const shape = describeDiff(label, f.body, r.body);
    if (shape) problems.push(shape);
  }
  if (problems.length) throw new Error(`wire exchanges differ\n${problems.join('\n')}`);
}

const summary = report => ({
  keys: Object.keys(report).sort(), admin: report.admin, frozen: report.frozen === true, reauthorize: report.reauthorizeRequired,
  panel: report.capabilities.includes('app:panel'), mcp: report.capabilities.includes('app:mcp'), anyCapability: report.capabilities.length > 0,
  departments: report.departments.length > 0, policy: report.policy && Object.keys(report.policy).sort(),
  setup: report.setup && Object.keys(report.setup).sort(), etag: typeof report.etag, pending: typeof report.recipientsPending,
});
const settled = async promise => { try { return {ok: await promise}; } catch (error) { return {error: error.message, status: error.status}; } };

/** The setup PUT of a target. Versions are relative to what Biz holds now: `version(n)` is `current + n`, `rel` the inverse. */
async function publisher(target) {
  const SETUP = '/oauth/framework-access/setup';
  const current = (await target.project().access().report(await target.token('admin'))).setup?.version ?? null;
  const base = current ? Number(current.slice(1)) : 0;
  const rel = v => v === null || v === undefined ? v : `base+${Number(v.slice(1)) - base}`;
  const version = n => `v${base + n}`;
  const bundle = Buffer.from(`contract bundle ${crypto.randomUUID()}`);
  const manifest = obj => Buffer.from(JSON.stringify(obj)).toString('base64');
  const headers = (v, b, over = {}) => ({'X-Setup-Version': v, 'X-Setup-Base': b, 'X-Setup-Sha256': crypto.createHash('sha256').update(bundle).digest('hex'),
    'X-Setup-Manifest': manifest({extensions: ['biz'], files_count: 1, framework: '1.0.0'}), 'Content-Type': 'application/octet-stream', ...over});
  const put = async (token, h, body = bundle) => { const r = await target.raw('PUT', target.q(SETUP), {token, headers: h, body}); return {status: r.status, error: r.json?.error, current: rel(r.json?.current), version: rel(r.json?.version), etag: typeof r.json?.etag}; };
  return {SETUP, current, base, rel, version, bundle, manifest, headers, put, baseHeader: current ?? 'none'};
}

// ---- scenarios -----------------------------------------------------------------------------------------------------

describe('contract: fake Biz vs the real local Biz', {skip: SKIP}, () => {
  test('the suite documents what it cannot reproduce on the real Biz', () => {
    assert.ok(SKIPPED_ON_REAL.length > 0 && SKIPPED_ON_REAL.every(([what, why]) => what && why));
    for (const [what, why] of SKIPPED_ON_REAL) console.log(`# SKIPPED_ON_REAL ${what}: ${why}`);
  });

  test('oauth: metadata, dynamic registration, PKCE sign-in and token exchange (auth.store)', t => agree(t, async target => {
    const {grant} = await target.signIn('member');
    return {grant: Object.keys(grant).sort(), lifetimeMinutes: Math.round((grant.expiresAt - Date.now()) / 60000), token: typeof grant.accessToken, renewable: Boolean(grant.refreshToken)};
  }));

  test('oauth: the grant is renewed with the refresh token, which Biz rotates', t => agree(t, async target => {
    const {auth, workspace, grant} = await target.signIn('member', {save: true});
    const later = workspace.auth(() => Date.now() + 2 * 3600 * 1000); // an hour past the expiry
    const renewed = await later.profileAccessToken();
    return {rotated: renewed !== grant.accessToken, status: auth.profileStatus()};
  }));

  test('oauth: a refused refresh fails as access_denied', t => agree(t, async target => {
    const {workspace, grant} = await target.signIn('member', {save: true});
    if (target.kind === 'fake') target.biz.refreshRefused = true;
    else { const file = path.join(workspace.dir.dataDir, 'profile-oauth.json'); fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), refreshToken: 'not-a-refresh-token'})); }
    const later = workspace.auth(() => Date.now() + 2 * 3600 * 1000);
    return {...await settled(later.profileAccessToken()), had: Boolean(grant.refreshToken)};
  }));

  test('identity: /oauth/userinfo gives the subject of the framework_access grant', t => agree(t, async target => {
    const access = target.project().access();
    const member = await settled(access.identity(await target.token('member')));
    const admin = await settled(access.identity(await target.token('admin')));
    return {member: Object.keys(member.ok ?? member), admin: Object.keys(admin.ok ?? admin), distinct: member.ok?.subject !== admin.ok?.subject, text: typeof member.ok?.subject};
  }));

  for (const persona of ['admin', 'admin2', 'member', 'noAccess']) {
    test(`report: ${persona} (access.report parses the same thing)`, t => agree(t, async target => summary(await target.project().access().report(await target.token(persona)))));
  }

  test('report: a deactivated person is frozen with a bare body, and recovers when reactivated', t => agree(t, async target => {
    const access = () => target.project().access();
    const token = await target.token('congelable');
    const out = {before: summary(await access().report(token))};
    try {
      await target.setActive('congelable', false);
      out.deactivated = summary(await access().report(token));
      out.decision = await access().can(token, 'app:mcp');
      await target.setActive('congelable', true);
      out.reactivated = summary(await access().report(token));
    } finally { await target.setActive('congelable', true); }
    return out;
  }));

  test('report: a person removed from the organization is frozen, and recovers when restored', t => agree(t, async target => {
    const token = await target.token('congelable');
    const out = {};
    try {
      await target.setMember('congelable', false);
      out.removed = summary(await target.project().access().report(token));
      await target.setMember('congelable', true);
      out.restored = summary(await target.project().access().report(token));
    } finally { await target.setMember('congelable', true); }
    return out;
  }));

  test('decision: ?capability= answers {allowed} and access.can follows it', t => agree(t, async target => {
    const out = {};
    for (const persona of ['admin', 'member', 'noAccess']) {
      const token = await target.token(persona);
      for (const capability of ['app:mcp', 'framework:publish']) {
        const answer = await target.raw('GET', target.q('/oauth/framework-access', `&capability=${encodeURIComponent(capability)}`), {token});
        out[`${persona} ${capability}`] = {status: answer.status, allowed: answer.json?.allowed};
      }
      out[`${persona} can`] = await target.project().access().can(token, 'app:panel');
    }
    return out;
  }));

  test('401: no token, a bad token', t => agree(t, async target => {
    const access = target.project().access();
    const out = {};
    for (const [route, extra] of [['/oauth/framework-access', ''], ['/oauth/framework-access', '&capability=app:mcp'], ['/oauth/framework-access/setup', ''], ['/oauth/framework-access/recipients', '']]) {
      out[`${route}${extra} none`] = (await target.raw('GET', target.q(route, extra))).status;
      out[`${route}${extra} bad`] = (await target.raw('GET', target.q(route, extra), {token: 'not-a-token'})).status;
    }
    out.report = await settled(access.report('not-a-token'));
    out.identity = await settled(access.identity('not-a-token'));
    out.userinfo = (await target.raw('GET', '/oauth/userinfo')).status;
    return out;
  }));

  test('organization: another one has no capabilities on the report and 403 on the setup routes; none at all is a 400', t => agree(t, async target => {
    const token = await target.token('admin');
    const out = {};
    const other = '/oauth/framework-access';
    const answer = async (method, route, query, extra = {}) => { const r = await target.raw(method, `${route}${query}`, {token, ...extra}); return {status: r.status, error: r.json?.error, caps: r.json?.capabilities}; };
    out.report = await answer('GET', other, '?organization=somewhere-else');
    out.decision = await answer('GET', other, '?organization=somewhere-else&capability=app:mcp');
    out.noOrg = await answer('GET', other, '');
    for (const [method, route] of [['GET', '/setup'], ['PUT', '/setup'], ['GET', '/recipients'], ['PUT', '/recipient']]) {
      out[`${method} ${route}`] = await answer(method, `${other}${route}`, '?organization=somewhere-else', method === 'PUT' ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify({age_public_key: newAgeKey()})} : {});
    }
    return out;
  }));

  test('setup: no setup yet (404 no_setup, report without one)', t => agree(t, async target => {
    const admin = await target.token('admin');
    const get = await target.raw('GET', target.q('/oauth/framework-access/setup'), {token: admin});
    return {get: [get.status, get.json?.error], report: (await target.project().access().report(admin)).setup ?? null};
  }, {needsFreshSetup: true}));

  test('recipients_pending counts the people with access that have no key yet, one per person', t => agree(t, async target => {
    const admin = await target.token('admin');
    const kit = await publisher(target);
    // The seed's people with access: propietario, admin2, miembro and congelable (sinacceso has no department, inactiva is deactivated).
    // The fake has no directory, so it is told; the real Biz counts them from fake-fyso.
    if (target.kind === 'fake') target.biz.pendingRecipients(PEOPLE_WITH_ACCESS);
    // The admin report carries the count once a setup is published.
    if (!kit.current) await kit.put(admin, kit.headers(kit.version(1), 'none'));
    const state = async () => {
      const report = await target.project().access().report(admin);
      return {pending: report.recipientsPending ?? 0, listed: (await target.project().access().recipients(admin)).recipients.length};
    };
    const out = {start: await state(), steps: []};
    assert.equal(out.start.pending, PEOPLE_WITH_ACCESS, 'every person with access and no key is pending');
    assert.equal(out.start.listed, 0);
    for (const persona of ['member', 'admin', 'admin2', 'congelable']) {
      await target.project().access().registerRecipient(await target.token(persona), newAgeKey());
      out.steps.push({persona, ...await state()});
    }
    // Registering again replaces the key: nobody becomes pending again and nobody is listed twice.
    await target.project().access().registerRecipient(await target.token('member'), newAgeKey());
    out.again = await state();
    for (const [i, step] of out.steps.entries()) {
      assert.equal(step.listed, i + 1, `${step.persona} is listed`);
      assert.equal(step.pending, out.start.pending - (i + 1), `${step.persona} is no longer pending`);
    }
    assert.deepEqual(out.again, {pending: out.steps.at(-1).pending, listed: out.steps.at(-1).listed});
    return out;
  }, {needsFreshRecipients: true}));

  test('recipients: a person registers an age key; only admins list them', t => agree(t, async target => {
    const member = await target.token('member'), admin = await target.token('admin');
    const access = target.project().access();
    const key = newAgeKey();
    const out = {};
    const memberKey = newAgeKey();
    out.registerMember = await settled(access.registerRecipient(member, memberKey));
    out.register = await settled(access.registerRecipient(admin, key));
    out.registerInvalid = await settled(access.registerRecipient(member, 'age1abc'));
    for (const [name, body] of [['malformed', 'age1abc'], ['no key', undefined], ['wrong alphabet', `age1${'b'.repeat(58)}`]]) {
      const r = await target.raw('PUT', target.q('/oauth/framework-access/recipient'), {token: member, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body === undefined ? {} : {age_public_key: body})});
      out[`wire ${name}`] = [r.status, r.json?.error];
    }
    const listed = await settled(access.recipients(admin));
    out.admin = {keys: Object.keys(listed.ok ?? {}).sort(), etag: typeof listed.ok?.etag, entry: Object.keys(listed.ok?.recipients?.[0] ?? {}).sort(), hasKey: Boolean(listed.ok?.recipients.some(r => r.age_public_key === key)),
      // A member who registered a key is listed too (not only the owner), each under their own person.
      hasMemberKey: Boolean(listed.ok?.recipients.some(r => r.age_public_key === memberKey)),
      distinctPeople: new Set(listed.ok?.recipients.filter(r => [key, memberKey].includes(r.age_public_key)).map(r => r.person_id)).size};
    out.member = await settled(access.recipients(member));
    out.noAccess = await settled(access.recipients(await target.token('noAccess')));
    return out;
  }));

  test('setup: publish with X-Setup-Base, stale_base, version_conflict, validation, concurrent publishes, download', async t => {
    await agree(t, async target => {
      const admin = await target.token('admin'), member = await target.token('member'), noAccess = await target.token('noAccess'), admin2 = await target.token('admin2');
      const {SETUP, current, rel, version, bundle, manifest, headers, put, baseHeader} = await publisher(target);
      const out = {initial: rel(current)};
      out.member = await put(member, headers(version(1), baseHeader));
      out.noHeaders = await put(admin, {'Content-Type': 'application/octet-stream'});
      out.badVersion = await put(admin, headers('x1', baseHeader));
      out.badBase = await put(admin, headers(version(1), 'latest'));
      out.badDigest = await put(admin, headers(version(1), baseHeader, {'X-Setup-Sha256': 'f'.repeat(64)}));
      out.shortDigest = await put(admin, headers(version(1), baseHeader, {'X-Setup-Sha256': 'abc'}));
      out.bigManifest = await put(admin, headers(version(1), baseHeader, {'X-Setup-Manifest': manifest({files: 'x'.repeat(9000)})}));
      out.notJsonManifest = await put(admin, headers(version(1), baseHeader, {'X-Setup-Manifest': Buffer.from('not json').toString('base64')}));
      out.emptyBody = await put(admin, headers(version(1), baseHeader), Buffer.alloc(0));
      out.published = await put(admin, headers(version(1), baseHeader));
      out.staleBase = await put(admin, headers(version(2), baseHeader));
      out.notNewer = await put(admin, headers(version(1), version(1)));
      // Two admins publish on the same base: exactly one wins.
      target.transport.muted = true;
      const race = await Promise.all([put(admin, headers(version(2), version(1))), put(admin2, headers(version(2), version(1)))]);
      target.transport.muted = false;
      out.race = race.map(r => [r.status, r.error, r.current]).sort();
      // Download: the bytes, the headers, and the report that describes the setup.
      for (const [who, token] of [['admin', admin], ['member', member]]) {
        const got = await target.raw('GET', target.q(SETUP), {token});
        out[`get ${who}`] = {status: got.status, version: rel(got.headers.get('x-setup-version')), sha: got.headers.get('x-setup-sha256') === crypto.createHash('sha256').update(got.bytes).digest('hex'),
          etag: got.headers.get('etag') === `"${got.headers.get('x-setup-version')}-${got.headers.get('x-setup-sha256').slice(0, 16)}"` || typeof got.headers.get('etag'), type: got.headers.get('content-type')};
      }
      const report = await target.project().access().report(member);
      out.report = {version: rel(report.setup.version), keys: Object.keys(report.setup).sort(), etag: typeof report.etag};
      const before = report.etag;
      out.etagMovesWithPublish = (await put(admin, headers(version(3), version(2)))).status === 201 && (await target.project().access().report(member)).etag !== before;
      out.noAccess = await settled((async () => { const r = await target.raw('GET', target.q(SETUP), {token: noAccess}); return {status: r.status, error: r.json?.error}; })());
      const wrong = await target.raw('POST', target.q(SETUP), {token: member});
      out.wrongMethod = {status: wrong.status, allow: wrong.headers.get('allow'), error: wrong.json?.error};
      return out;
    });
  });

  test('setup: eleven publishes in a row each become the current version, past v9', t => agree(t, async target => {
    const admin = await target.token('admin'), member = await target.token('member');
    const {SETUP, current, rel, version, headers, put, baseHeader} = await publisher(target);
    const out = {initial: rel(current), steps: []};
    let base = baseHeader;
    for (let n = 1; n <= 11; n++) {
      const published = await put(admin, headers(version(n), base));
      const report = await target.project().access().report(member);
      const download = await target.raw('GET', target.q(SETUP), {token: member});
      // Absolute versions: the current one follows the number (v10 and v11 after v9), not the text order of the names.
      assert.equal(published.status, 201, `publish ${version(n)} on ${base}: ${JSON.stringify(published)}`);
      assert.equal(report.setup.version, version(n), `the report follows the publish of ${version(n)}`);
      assert.equal(download.headers.get('x-setup-version'), version(n), `the download serves ${version(n)}`);
      out.steps.push({n, status: published.status, report: rel(report.setup.version), download: rel(download.headers.get('x-setup-version'))});
      base = version(n);
    }
    // The base is still enforced after it: an old one is stale and says which version is current.
    out.stale = await put(admin, headers(version(12), version(3)));
    out.latest = rel((await target.project().access().report(member)).setup.version);
    return out;
  }));

  test('setup: a frozen person cannot download it', t => agree(t, async target => {
    const token = await target.token('congelable');
    try {
      await target.setActive('congelable', false);
      const r = await target.raw('GET', target.q('/oauth/framework-access/setup'), {token});
      return {status: r.status, error: r.json?.error};
    } finally { await target.setActive('congelable', true); }
  }));
});
