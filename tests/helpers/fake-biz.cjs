'use strict';
// An in-memory Fyso Biz: a `fetch`-compatible function plus a call log, for the `transport` seam of
// projectAccess({transport}) and auth.store({transport}). Bodies follow what the production code
// parses today (project-access.cjs fetchReport/setupOf/recipients, auth.cjs OAuth) and what the
// Biz handler sends (ADR 0134: the setup GET/PUT used by the framework's dist.cjs).
const crypto = require('node:crypto');
const {matches} = require('../../extensions/biz/department-capabilities.cjs');

// Bech32 alphabet (no 1, b, i, o) and exactly 58 characters, as the Biz handler (setup-framework-handler.ts) checks it.
const AGE_KEY_PATTERN = /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SETUP_VERSION = /^v\d+$/;
const MANIFEST_MAX = 8 * 1024;

const LIBRE = {preset: 'libre', extensions: 2, mcp_servers: 2, bots: 1, read: 1, write: 2, shell: 2, publish: 1, ai: 2};
const EQUILIBRADO = {preset: 'equilibrado', extensions: 1, mcp_servers: 1, bots: 1, read: 1, write: 1, shell: 1, publish: 0, ai: 1};
const LIDER = {id: 'lider', name: 'Líder', custom: false, levels: {objetivos: 2, agentes: 2, fuentes: 2}};
const MIEMBRO = {id: 'miembro', name: 'Personalizado (basado en Miembro)', custom: true, levels: {objetivos: 2, agentes: 1, fuentes: 0}};
const OPERACIONES = {id: 'd0', name: 'Operaciones', role: LIDER, teams: []};
const VENTAS = {id: 'd1', name: 'Ventas', role: MIEMBRO, teams: [{id: 'e1', name: 'Prospeccion'}]};

/**
 * Wire body (snake_case, as Biz sends it) of each access scenario, checked against the Biz-side fixture
 * (framework-access-contract.json) and a real local Biz (tests/contract/). `etag` and `setup` are added by the
 * fake to full bodies only: Biz sends the deactivated and reauthorize bodies bare.
 */
const SCENARIOS = {
  /** An administrator: `admin: true`, libre policy, every framework capability, every active department as Líder. */
  admin: () => ({capabilities: ['app:panel', 'app:mcp', 'framework:extensions:catalog', 'framework:extensions:any', 'framework:mcp_servers:catalog', 'framework:mcp_servers:any',
    'framework:bots:create', 'framework:machine:read', 'framework:machine:write', 'framework:shell', 'framework:publish', 'framework:ai:standard', 'framework:ai:high'],
    admin: true, departments: [structuredClone(OPERACIONES), {...structuredClone(OPERACIONES), id: 'd1', name: 'Ventas'}], policy: {...LIBRE}, frozen: false}),
  /** A member of departments with custom roles and the equilibrado policy. */
  member: () => ({capabilities: ['app:panel', 'app:mcp', 'framework:extensions:catalog', 'framework:mcp_servers:catalog', 'framework:bots:create', 'framework:machine:read', 'framework:machine:write',
    'framework:machine:write:ask', 'framework:shell', 'framework:shell:ask', 'framework:ai:standard'],
    admin: false, departments: [structuredClone(VENTAS)], policy: {...EQUILIBRADO}, frozen: false}),
  /** Signed in but with no department and no admin: Biz freezes this person (`estaCongelada`) and still sends the full body with the equilibrado policy. */
  noAccess: () => ({capabilities: [], admin: false, departments: [], policy: {...EQUILIBRADO}, frozen: true}),
  /** A deactivated person, or one without membership: Biz sends only `{capabilities, frozen}`. */
  frozen: () => ({capabilities: [], frozen: true}),
  /** An old grant whose identity Biz cannot recover (an expired Fyso credential): bare `{capabilities, reauthorize_required}`. */
  reauthorize: () => ({capabilities: [], reauthorize_required: true}),
};
// Bodies that are not full carry no `setup` and no `etag`.
const isFull = body => 'departments' in body;

// ---- response specs ----------------------------------------------------------------------------
// A spec is what a route answers: build one with these and give it to `biz.queue(route, ...)` /
// `biz.always(route, ...)`. (A function(call) returning a spec, an Error to throw, or a Response also work.)
const DEFAULT_ERRORS = {400: 'invalid_request', 401: 'invalid_token', 403: 'access_denied', 404: 'not_found', 409: 'conflict', 413: 'too_large', 502: 'bad_gateway'};
// Biz's 503 names what failed: the setup routes say `setup_unavailable`, the report and decision `policy_unavailable`.
const unavailableOf = route => /^(setup|recipient)/.test(route) ? 'setup_unavailable' : 'policy_unavailable';
const INVALID_TOKEN = {error: 'invalid_token', error_description: 'Invalid access token'};
const WWW_AUTHENTICATE = 'Bearer realm="OAuth", error="invalid_token", scope="mcp"';
/** Answer `status` with a JSON `body` (or none for 204) and extra headers. */
const reply = (status, body, headers = {}) => ({kind: 'reply', status, body, headers});
/** 200 with a JSON body. */
const ok = body => reply(200, body);
/** An error status with Biz's usual body: http(401), http(403), http(503), http(409, {error: 'stale_base', current: 'v3'}). */
const http = (status, body) => body === undefined && status >= 500 ? {...reply(status, undefined), route503: true} : reply(status, body ?? (status === 401 ? INVALID_TOKEN : {error: DEFAULT_ERRORS[status] ?? 'error'}), status === 401 ? {'WWW-Authenticate': WWW_AUTHENTICATE} : {});
/** 409 `stale_base` of a setup PUT: the base is not Biz's current version. */
const staleBase = current => reply(409, {error: 'stale_base', current: current ?? null});
/** 409 `version_conflict` of a setup PUT: the version is not newer than the current one. */
const versionConflict = current => reply(409, {error: 'version_conflict', current: current ?? null});
/** The request never completes by itself; it rejects only when the caller's AbortSignal fires (AbortSignal.timeout, or clock.advance with installAbortTimeout). */
const hang = () => ({kind: 'hang'});
/** The request is aborted as if the timeout had just fired: rejects at once with a TimeoutError DOMException. */
const timedOut = () => ({kind: 'throw', error: () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')});
/** The connection fails: rejects with a TypeError('fetch failed'), like undici. */
const networkError = (message = 'fetch failed') => ({kind: 'throw', error: () => new TypeError(message)});

const ROUTES = ['identity', 'report', 'decision', 'recipient', 'recipients', 'setup.get', 'setup.put', 'oauth.metadata', 'oauth.register', 'oauth.token', 'method', 'unknown'];

function routeOf(method, pathname, query) {
  switch (`${method} ${pathname}`) {
  case 'GET /oauth/userinfo': return 'identity';
  case 'GET /oauth/framework-access': return query.has('capability') ? 'decision' : 'report';
  case 'PUT /oauth/framework-access/recipient': return 'recipient';
  case 'GET /oauth/framework-access/recipients': return 'recipients';
  case 'GET /oauth/framework-access/setup': return 'setup.get';
  case 'PUT /oauth/framework-access/setup': return 'setup.put';
  case 'GET /.well-known/oauth-authorization-server': return 'oauth.metadata';
  case 'POST /oauth/register': return 'oauth.register';
  case 'POST /oauth/token': return 'oauth.token';
  default: return ALLOWED[pathname] ? 'method' : 'unknown';
  }
}
// Known paths answer 405 with `Allow` to any other method (after the token check, as Biz does).
const ALLOWED = {'/oauth/framework-access/setup': 'GET, PUT', '/oauth/framework-access/recipient': 'PUT', '/oauth/framework-access/recipients': 'GET'};

const headersOf = value => {
  const out = {};
  if (!value) return out;
  const entries = typeof value.entries === 'function' ? [...value.entries()] : Object.entries(value);
  for (const [name, item] of entries) out[name.toLowerCase()] = String(item);
  return out;
};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * @param {object} [options]
 * @param {string} [options.url] Biz origin ('https://biz.test'; must match the env's FYSO_BIZ_URL)
 * @param {string} [options.organization] the organization Biz serves ('acme'; framework-access routes answer 403 for another)
 * @param {'admin'|'member'|'noAccess'|'frozen'|'reauthorize'} [options.scenario] the access report of every token without its own person ('member')
 * @param {{now: () => number}} [options.clock] a fakeClock, for `published_at` / `registered_at`
 * @param {string} [options.setupVersion] the published setup version ('v2'); null = Biz has no setup
 */
function fakeBiz({url = 'https://biz.test', organization = 'acme', scenario = 'member', clock = {now: Date.now}, setupVersion = 'v2'} = {}) {
  const origin = new URL(url).origin;
  const calls = [];
  const queues = new Map();    // route|'*' -> spec[]
  const overrides = new Map(); // route|'*' -> spec
  const people = new Map();    // token -> {sub, body}
  const revoked = new Set();
  const issued = new Set();   // tokens the token endpoint handed out or `person` registered
  let reportSerial = 1, tokenSerial = 0;

  const biz = {
    url: origin, organization,
    /** The one number to compare against: how often each route was hit. */
    calls,
    /** Seconds a token endpoint answer says (`expires_in`): 1 h, what the real Biz issues (the 8 h is the embedded Fyso credential, Biz's own clock). */
    credentialExpiresIn: 3600,
    /** true: `grant_type=refresh_token` answers 400 (the refresh is refused). */
    refreshRefused: false,
    /** true: only tokens the token endpoint issued (or `person` registered) are valid, like the real Biz; false (default): any bearer token is, so tests can say 'tok'. */
    strictTokens: false,
    /** The published setup `{version, etag, published_at, size, sha256}` the report describes, or null. */
    setup: null,
    /** The bytes `GET .../setup` serves (set by `publish`/PUT). */
    bundle: null,
    /** Value of the report's `etag` (changes with `bumpEtag` and `publish`; registering a recipient does not change it). */
    etag: 'e1',
    /** Registered recipients `[{person_id, age_public_key, registered_at}]` and their etag. */
    recipientList: [],
    recipientsEtag: 'r1',
    /** `recipients_pending` an admin's report carries. */
    recipientsPending: 0,
  };
  let defaultBody = SCENARIOS[scenario]();

  // ---- state setters ---------------------------------------------------------------------------
  /** Switch the default access scenario: biz.scenario('frozen'), optionally with overrides of the wire body (snake_case). */
  biz.scenario = (name, over = {}) => { defaultBody = {...SCENARIOS[name](), ...over}; return biz; };
  /** Override fields of the default wire body: biz.report({frozen: true}), biz.report({setup: null}). */
  biz.report = (over = {}) => { defaultBody = {...defaultBody, ...over}; return biz; };
  /** Give a token its own person: biz.person('admin-token', {scenario: 'admin', sub: 'p-admin', ...wireOverrides}). */
  biz.person = (token, {scenario: name = 'member', sub = `person-${people.size + 1}`, ...over} = {}) => { people.set(token, {sub, body: {...SCENARIOS[name](), ...over}}); issued.add(token); return biz; };
  /** After this, the token is answered 401 on every authenticated route (a revoked grant). */
  biz.revoke = token => { revoked.add(token); return biz; };
  /** Change what the report's `etag` says. Without an argument it counts up: e2, e3, ... */
  biz.bumpEtag = etag => { biz.etag = etag ?? `e${++reportSerial}`; return biz; };
  /** Biz now has a setup `version` (new setup etag, new report etag, a bundle): what a publisher's PUT leaves behind. */
  biz.publish = (version, bytes = Buffer.from(`bundle ${version}`)) => {
    biz.bundle = Buffer.from(bytes);
    biz.setup = {version, etag: `${version}-${sha256(biz.bundle).slice(0, 16)}`, published_at: new Date(clock.now()).toISOString(), size: biz.bundle.length, sha256: sha256(biz.bundle)};
    return biz.bumpEtag();
  };
  /** Pending recipients an admin's report announces. */
  biz.pendingRecipients = count => { biz.recipientsPending = count; return biz; };
  /** Register recipients as if people had PUT their keys: biz.addRecipient('age1...'). Changes the recipients etag. */
  biz.addRecipient = (key, person = `person-${biz.recipientList.length + 1}`) => {
    biz.recipientList = [...biz.recipientList.filter(item => item.person_id !== person), {person_id: person, age_public_key: key, registered_at: new Date(clock.now()).toISOString()}];
    biz.recipientsEtag = `r${biz.recipientList.length + 1}`;
    return biz;
  };
  if (setupVersion) { biz.publish(setupVersion); biz.etag = 'e1'; reportSerial = 1; }

  // ---- scripting -------------------------------------------------------------------------------
  const list = route => { if (!queues.has(route)) queues.set(route, []); return queues.get(route); };
  /** Answer the next calls of `route` (or '*' for any) with these specs, one each, in order; then the default applies again. */
  biz.queue = (route, ...specs) => { list(route).push(...specs); return biz; };
  /** Answer every call of `route` (or '*') with `spec` until `clear()`. A queue still has priority. */
  biz.always = (route, spec) => { overrides.set(route, spec); return biz; };
  /** Hold the next `times` calls of `route` until `gate.release()`; they then get the normal answer. Use to prove single-flight. */
  biz.hold = (route, times = 1) => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    for (let i = 0; i < times; i++) list(route).push({kind: 'hold', promise});
    return {release};
  };
  /** Drop queued and overriding specs (state stays). */
  biz.clear = () => { queues.clear(); overrides.clear(); return biz; };
  /** Forget the call log (state and scripts stay). */
  biz.reset = () => { calls.length = 0; return biz; };

  // ---- inspection ------------------------------------------------------------------------------
  /** Calls to one route (see ROUTES), or all of them. */
  biz.callsTo = route => route === undefined ? [...calls] : calls.filter(call => call.route === route);
  biz.count = route => biz.callsTo(route).length;
  biz.last = route => biz.callsTo(route).at(-1);
  /** The wire body of the access report for a token right now (no call is logged): copy it to queue a changed answer. */
  biz.reportBody = token => bodyFor(token);

  function bodyFor(token) {
    const body = people.get(token)?.body ?? defaultBody;
    if (!isFull(body)) return {...body};
    return {setup: biz.setup, etag: biz.etag, ...(body.admin && biz.setup ? {recipients_pending: biz.recipientsPending} : {}), ...body};
  }
  const subjectOf = token => people.get(token)?.sub ?? 'person-1';
  const isAdmin = token => (people.get(token)?.body ?? defaultBody).admin === true;
  const mayRead = token => { const body = people.get(token)?.body ?? defaultBody; return body.frozen !== true && body.reauthorize_required !== true && (body.admin === true || body.capabilities.length > 0); };
  const reauthorizes = token => (people.get(token)?.body ?? defaultBody).reauthorize_required === true;
  const denied = token => reauthorizes(token) ? json(403, {error: 'reauthorize_required'}) : json(403, {error: 'access_denied'});

  // ---- default handlers --------------------------------------------------------------------------
  const json = (status, body, headers = {}) => reply(status, body, headers);
  const handlers = {
    identity: call => json(200, {sub: subjectOf(call.token), scope: 'framework_access', organization}),
    report: call => json(200, bodyFor(call.token)),
    decision: call => {
      const body = bodyFor(call.token);
      return json(200, {allowed: body.frozen !== true && !body.reauthorize_required && matchesAny(body.capabilities, call.query.capability), ...(body.reauthorize_required ? {reauthorize_required: true} : {})});
    },
    recipient: call => {
      const key = call.body?.age_public_key;
      if (typeof key !== 'string' || !AGE_KEY_PATTERN.test(key)) return json(400, {error: 'invalid_request'});
      // Like the real Biz (servicio.pendientes): only a person who had no key yet stops being pending; a new key replaces the old one.
      const first = !biz.recipientList.some(item => item.person_id === subjectOf(call.token));
      biz.addRecipient(key, subjectOf(call.token));
      if (first) biz.recipientsPending = Math.max(0, biz.recipientsPending - 1);
      return reply(204);
    },
    recipients: call => isAdmin(call.token) ? json(200, {recipients: biz.recipientList, etag: biz.recipientsEtag}) : json(403, {error: 'admin_required'}),
    'setup.get': call => {
      if (!mayRead(call.token)) return denied(call.token);
      if (!biz.setup) return json(404, {error: 'no_setup'});
      return reply(200, biz.bundle, {'Content-Type': 'application/octet-stream', ETag: `"${biz.setup.etag}"`, 'X-Setup-Version': biz.setup.version, 'X-Setup-Sha256': biz.setup.sha256});
    },
    'setup.put': call => {
      if (!mayRead(call.token)) return denied(call.token);
      if (!isAdmin(call.token)) return json(403, {error: 'admin_required'});
      const version = call.headers['x-setup-version'], base = call.headers['x-setup-base'], digest = call.headers['x-setup-sha256'], manifest = call.headers['x-setup-manifest'];
      if (!version || !base || !digest || !manifest) return json(400, {error: 'invalid_request'});
      if (!SETUP_VERSION.test(version) || !(base === 'none' || SETUP_VERSION.test(base)) || !SHA256_PATTERN.test(digest) || !call.rawBody?.length) return json(400, {error: 'invalid_request'});
      if (sha256(call.rawBody) !== digest) return json(400, {error: 'sha256_mismatch'});
      const manifestBytes = Buffer.from(manifest, 'base64');
      if (manifestBytes.length > MANIFEST_MAX) return json(400, {error: 'manifest_too_large'});
      let parsed = null;
      try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch { /* invalid below */ }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json(400, {error: 'invalid_request'});
      // Check and insert without awaiting in between: of two concurrent publishes on one base, exactly one wins.
      const current = biz.setup?.version ?? null;
      if (base !== (current ?? 'none')) return json(409, {error: 'stale_base', current});
      if (current && Number(version.slice(1)) <= Number(current.slice(1))) return json(409, {error: 'version_conflict', current});
      biz.publish(version, call.rawBody);
      return json(201, {version, etag: biz.setup.etag});
    },
    'oauth.metadata': () => json(200, {issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, scopes_supported: ['mcp', 'perfil', 'framework_access'], response_types_supported: ['code'], response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      revocation_endpoint: `${origin}/oauth/token`, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false, userinfo_endpoint: `${origin}/oauth/userinfo`}),
    'oauth.register': call => json(201, {client_id: 'client-1', ...(call.body && typeof call.body === 'object' ? call.body : {}), client_id_issued_at: Math.floor(clock.now() / 1000)}),
    'oauth.token': call => {
      if (call.body?.grant_type === 'refresh_token' && biz.refreshRefused) return json(400, {error: 'invalid_grant', error_description: 'Invalid refresh token'});
      const n = ++tokenSerial;
      issued.add(`access-${n}`);
      return json(200, {access_token: `access-${n}`, token_type: 'bearer', expires_in: biz.credentialExpiresIn, scope: 'framework_access', refresh_token: `refresh-${n}`});
    },
    method: call => reply(405, {error: 'method_not_allowed'}, {Allow: ALLOWED[call.path]}),
    unknown: () => json(404, {error: 'not_found'}),
  };
  // Same matching rule the gateway uses (exact, or `*` for one segment / the rest); kept tiny and local.
  function matchesAny(grants, wanted) {
    return grants.some(grant => grant === wanted || (grant.includes('*') && matches(grant, wanted)));
  }
  const PUBLIC = new Set(['oauth.metadata', 'oauth.register', 'oauth.token', 'unknown']);
  const GUARDED = new Set(['report', 'decision', 'recipient', 'recipients', 'setup.get', 'setup.put']);

  function gate(call) {
    if (PUBLIC.has(call.route)) return null;
    // No token at all: Biz answers an empty 401 with only WWW-Authenticate; a bad token gets the JSON body.
    if (!call.token) return reply(401, undefined, {'WWW-Authenticate': WWW_AUTHENTICATE});
    if (revoked.has(call.token) || (biz.strictTokens && !issued.has(call.token))) return http(401);
    if (GUARDED.has(call.route)) {
      if (!call.query.organization) return http(400, {error: 'invalid_access_request'});
      // Another organization: the report and the decision know nothing about it (no capabilities), the setup routes refuse.
      if (call.query.organization !== organization) return call.route === 'report' || call.route === 'decision' ? json(200, call.route === 'decision' ? {allowed: false} : {capabilities: []}) : http(403, {error: 'access_denied'});
    }
    return null;
  }

  async function settle(spec, call) {
    if (spec === undefined) {
      const denied = gate(call);
      return settle(denied ?? handlers[call.route](call), call);
    }
    if (typeof spec === 'function') return settle(spec(call), call);
    if (spec instanceof Response) return spec;
    if (spec instanceof Error) throw spec;
    switch (spec.kind) {
    case 'reply': {
      const {status, headers} = spec;
      const body = spec.route503 ? {error: unavailableOf(call.route)} : spec.body;
      const raw = body instanceof Uint8Array || typeof body === 'string';
      return new Response(status === 204 || status === 304 || body === undefined ? null : raw ? body : JSON.stringify(body),
        {status, headers: {'Cache-Control': 'no-store', ...(body !== undefined && !raw ? {'Content-Type': 'application/json'} : {}), ...headers}});
    }
    case 'throw': throw typeof spec.error === 'function' ? spec.error() : spec.error;
    case 'hang':
      return new Promise((resolve, reject) => {
        const signal = call.signal;
        if (!signal) return; // nothing can ever stop it: the caller asked for it
        const fail = () => reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
        if (signal.aborted) fail(); else signal.addEventListener('abort', fail, {once: true});
      });
    case 'hold': {
      // A held request still honours its AbortSignal: when the abort comes first the caller sees the abort, not the late answer.
      const aborted = call.signal ? new Promise((_, reject) => {
        const fail = () => reject(call.signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
        if (call.signal.aborted) fail(); else call.signal.addEventListener('abort', fail, {once: true});
      }) : null;
      await (aborted ? Promise.race([spec.promise, aborted]) : spec.promise);
      return settle(undefined, call);
    }
    default: throw Error(`fake-biz: unknown spec ${JSON.stringify(spec)}`);
    }
  }

  /** The `transport`: `projectAccess({transport: biz.fetch})`, `store({transport: biz.fetch})`. */
  biz.fetch = async (input, options = {}) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
    const method = String(options.method ?? 'GET').toUpperCase();
    const headers = headersOf(options.headers);
    const raw = options.body === undefined || options.body === null ? null : typeof options.body === 'string' ? Buffer.from(options.body) : Buffer.from(options.body);
    let body = raw ? raw.toString('utf8') : null;
    if (raw && (headers['content-type'] || '').startsWith('application/json')) { try { body = JSON.parse(body); } catch { /* keep the text */ } }
    else if (raw && (headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(body));
    const call = {index: calls.length, route: routeOf(method, target.pathname, target.searchParams), method, url: target, path: target.pathname,
      query: Object.fromEntries(target.searchParams), headers, token: /^Bearer (.+)$/i.exec(headers.authorization ?? '')?.[1] ?? null,
      body, rawBody: raw, signal: options.signal ?? null, at: clock.now(), outcome: null};
    calls.push(call);
    try {
      if (call.signal?.aborted) throw call.signal.reason;
      const queued = list(call.route).length ? list(call.route) : list('*');
      const spec = queued.length ? queued.shift() : overrides.get(call.route) ?? overrides.get('*');
      const response = await settle(spec, call);
      call.outcome = {status: response.status};
      return response;
    } catch (error) {
      call.outcome = {error: error?.name ?? 'Error', message: error?.message};
      throw error;
    }
  };

  return biz;
}

Object.assign(fakeBiz, {SCENARIOS, ROUTES, reply, ok, http, staleBase, versionConflict, hang, timedOut, networkError});

module.exports = {fakeBiz, SCENARIOS, ROUTES, reply, ok, http, staleBase, versionConflict, hang, timedOut, networkError, LIBRE, EQUILIBRADO, VENTAS};
