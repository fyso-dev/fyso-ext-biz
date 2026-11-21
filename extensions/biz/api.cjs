// Same-origin panel API (framework D79): the gateway forwards /api/ext/biz/<path> to this
// handler on a private socket, behind the project's web login. Reads only, plus logout;
// downloading a team stays a Dagu workflow because it commits to the repository.
const biz = require('./biz.cjs'), auth = require('./auth.cjs');

const SESSION_TTL = 10 * 60 * 1000;
// Errors after which a fresh MCP session (and a refreshed token) may succeed.
const RETRY = new Set(['remote_unavailable', 'access_denied', 'invalid_response']);

function api({env = process.env, transport = fetch, now = Date.now} = {}) {
  // One MCP session and tool catalog reused across reads: initialize + tools/list cost
  // two round trips that each panel read paid before.
  let cached;
  const open = () => {
    if (cached && now() - cached.at < SESSION_TTL) return cached.session;
    const session = (async () => {
      const credential = await biz.token(env);
      const mcp = biz.client(env.FYSO_BIZ_URL || '', credential.token, transport, {oauth:credential.oauth});
      await mcp.initialize();
      const tools = await mcp.tools();
      return {origin:mcp.origin, call:mcp.call, initialize:async () => {}, tools:async () => tools};
    })();
    cached = {at:now(), session};
    session.catch(() => { if (cached?.session === session) cached = undefined; });
    return session;
  };
  const reset = () => { cached = undefined; };
  const withMcp = async read => {
    try { return await read(await open()); }
    catch (error) {
      if (!RETRY.has(error.message)) throw error;
      reset();
      return read(await open());
    }
  };
  const routes = {
    'GET /mail/addresses': () => require('./email.cjs').remote('addresses', undefined, env),
    'GET /status': () => biz.statusOf(env),
    'GET /teams': () => biz.overview(env, () => open()).catch(error => {
      if (RETRY.has(error.message)) { reset(); return biz.overview(env, () => open()); }
      throw error;
    }),
    'GET /context': query => withMcp(mcp => biz.context(mcp, query.get('department') || '')),
    'GET /objective': query => withMcp(mcp => biz.vision(mcp, query.get('id') || '')),
    'GET /work': () => withMcp(async mcp => {
      const result = await mcp.call('solicitudes_disponibles');
      if (!Array.isArray(result.solicitudes) || typeof result.agente !== 'string') throw Error('invalid_response');
      const available = result.solicitudes.filter(r => r.agenteDestino === result.agente).slice(0,100).map(r => ({id:r.id, title:r.titulo}));
      return {...require('./dispatch.cjs').status(env), available, identity:result.agente};
    }),
    'POST /logout': () => { auth.store({env}).logout(); reset(); return biz.statusOf(env); },
  };
  return async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const route = routes[`${req.method} ${url.pathname}`];
    const send = (status, body) => {
      res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && ['/mail/activate','/mail/deactivate'].includes(url.pathname)) {
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415,{error:'invalid_input'});
      try {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 2048) return send(400,{error:'invalid_input'}); }
        const {bot} = JSON.parse(raw);
        let thread;
        if (url.pathname === '/mail/activate') {
          if (!/^[0-9]{1,5}$/.test(env.FYSO_OMB_PORT || '')) throw Error();
          const exec = require('node:util').promisify(require('node:child_process').execFile);
          const {stdout} = await exec('openmausbot',['bots','--port',env.FYSO_OMB_PORT,'--json'],{timeout:10000});
          thread = JSON.parse(stdout).bots.find(item=>item.id === bot)?.activeTaskId;
          if (!thread) return send(400,{error:'invalid_bot'});
        }
        return send(200, await require('./email.cjs').remote(url.pathname.split('/').pop(), {bot,thread}, env));
      } catch { return send(502,{error:'agent_mail_unavailable'}); }
    }
    if (req.method === 'POST' && url.pathname === '/work') {
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 20000) throw Error('invalid_input'); }
        const data = JSON.parse(body);
        const valid = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 10000;
        if (!valid(data.title) || !valid(data.instructions) || !valid(data.department) || (data.kr && !valid(data.kr)) || (data.lever && !valid(data.lever)) || (data.kr && data.lever)) throw Error('invalid_input');
        const mcp = await open();
        const identity = await mcp.call('solicitudes_disponibles');
        if (!valid(identity.agente) || identity.agente.length > 120) throw Error('invalid_input');
        const args = {ejecutor:'agente', agente_destino:identity.agente, titulo:data.title.trim(), instrucciones:data.instructions.trim(), ...(data.lever ? {palanca_id:data.lever} : data.kr ? {key_result_id:data.kr} : {departamento_id:data.department})};
        // Never retry a business mutation after an ambiguous response.
        const result = await mcp.call('crear_solicitud', args);
        if (!result || typeof result.id !== 'string') throw Error('uncertain');
        send(200, {id:result.id});
      } catch (error) { send(200, {error:error.message === 'invalid_input' || error.message === 'tool_denied' ? error.message : 'uncertain'}); }
      return;
    }
    if (!route) { send(404, {error:'not_found'}); return; }
    try { send(200, await route(url.searchParams)); }
    catch (error) {
      // Same structured failure the Dagu workflows print; never internal details.
      const code = biz.ERRORS.includes(error.message) ? error.message : 'connection_failed';
      send(200, {error:code, ...(error.bot && {bot:error.bot}), ...(url.pathname === '/teams' && {connection:biz.statusOf(env)})});
    }
  };
}

module.exports = {api};
