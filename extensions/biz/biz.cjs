// Thin read-only MCP adapter. Business rules and authorization remain in Biz.
const LIMIT = 100;
const auth = require('./auth.cjs');
// Personal `fyb_` tokens use /api/mcp; OAuth grants use the provider's /mcp route.
function endpoint(origin, oauth = false) {
  return `${auth.origin(origin)}${oauth ? '/mcp' : '/api/mcp'}`;
}
function client(origin, token, transport = fetch, {oauth = false} = {}) {
  const url = endpoint(origin, oauth);
  if (!token || /[\r\n]/.test(token)) throw Error('missing_token');
  let id = 0, session, protocol = '2025-03-26';
  // Retain only a short machine code. A provider's error description may echo credentials.
  const bizCode = value => {
    if (typeof value !== 'string' || !value) return undefined;
    return /^[a-z][a-z0-9_-]{0,63}$/.test(value) && !value.includes(token) && !value.startsWith('fyb_')
      ? value : '[redacted]';
  };
  async function rpc(method, params, notification = false) {
    let response; const requestId = notification ? undefined : ++id;
    try {
      response = await transport(url, {method:'POST', redirect:'error', signal:AbortSignal.timeout(30000), headers:{
        'Content-Type':'application/json', Accept:'application/json, text/event-stream',
        Authorization:`Bearer ${token}`, ...(session ? {'Mcp-Session-Id':session} : {}),
        'MCP-Protocol-Version':protocol,
      }, body:JSON.stringify({jsonrpc:'2.0', ...(!notification && {id:requestId}), method, params})});
    } catch { throw Error('connection_failed'); }
    if (!response.ok) {
      const error = Object.assign(Error(response.status === 401 || response.status === 403 ? 'access_denied' : 'remote_unavailable'),
        {status: response.status});
      // HTTP failures keep their status even if the proxy's body is empty, malformed or unreadable.
      const reader = response.body?.getReader();
      try {
        let text = '';
        const decoder = new TextDecoder();
        while (reader) {
          const {done, value} = await reader.read();
          if (done) break;
          text += decoder.decode(value, {stream:true});
          if (text.length > 4096) break;
        }
        const body = JSON.parse(text);
        error.bizCode = bizCode(body?.error?.code ?? body?.error);
      } catch { /* the status is still available */ }
      finally { await reader?.cancel().catch(() => {}); }
      throw error;
    }
    session = response.headers.get('mcp-session-id') || session;
    if (notification) { await response.body?.cancel(); return; }
    // Read JSON and SSE responses with a size bound and a request timeout.
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const chunk = await reader.read().catch(() => { throw Error('connection_failed'); });
      if (chunk.done) break;
      text += decoder.decode(chunk.value, {stream:true});
      if (text.length > 4_000_000) { await reader.cancel(); throw Error('response_too_large'); }
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        for (const frame of text.split(/\r?\n\r?\n/).slice(0,-1)) {
          const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let message; try { message = JSON.parse(data); } catch { throw Error('invalid_response'); }
          if (message.id === requestId) { await reader.cancel(); return unwrap(message); }
        }
      }
    }
    try { return unwrap(JSON.parse(text)); } catch(e) { if (e.message === 'remote_error') throw e; throw Error('invalid_response'); }
  }
  const unwrap = message => {
    // The JSON-RPC error stays attached for callers that relay it (mcp-proxy.cjs).
    if (message.error) throw Object.assign(Error('remote_error'), {rpc:message.error});
    if (!('result' in message)) throw Error('invalid_response');
    return message.result;
  };
  return {
    origin:new URL(url).origin,
    async initialize() {
      const result = await rpc('initialize', {protocolVersion:protocol, capabilities:{}, clientInfo:{name:'fyso-biz-extension',version:'0.1.0'}});
      protocol = result.protocolVersion;
      await rpc('notifications/initialized', {}, true);
    },
    /** One raw JSON-RPC request, for callers that relay results unchanged. */
    request:(method, params) => rpc(method, params),
    async tools() {
      const all = []; let cursor;
      for (let page=0;page<20;page++) {
        const result = await rpc('tools/list', cursor ? {cursor} : {});
        if (!Array.isArray(result.tools)) throw Error('invalid_response');
        all.push(...result.tools); cursor = result.nextCursor;
        if (!cursor) return all;
      }
      throw Error('incomplete_catalog');
    },
    async call(name, args = {}) {
      const result = await rpc('tools/call', {name, arguments:args});
      // Keep Biz's own error code (for example `version_conflict`) for the caller, never as output.
      if (result.isError) {
        const detail = list(result.content).filter(c=>c.type === 'text').map(c=>String(c.text)).join('\n').slice(0,500);
        const code = /^([a-z][a-z0-9_-]{0,63})(?=:|$)/.exec(detail)?.[1];
        throw Object.assign(Error('tool_denied'), {detail, bizCode: bizCode(code)});
      }
      if (result.structuredContent) return result.structuredContent;
      try { return JSON.parse(result.content.filter(c=>c.type === 'text').map(c=>c.text).join('\n')); }
      catch { throw Error('invalid_response'); }
    },
  };
}
const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value.slice(0,500) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const named = item => ({id:string(item.id), name:string(item.nombre || item.titulo)});
const state = item => ({...named(item), status:string(item.estado)});
async function collect(mcp, department = '') {
  await mcp.initialize();
  const tools = await mcp.tools(), names = new Set(tools.map(t=>t.name));
  if (!names.has('contexto')) throw Error('context_not_supported');
  const context = await mcp.call('contexto', department ? {departamento_id:department} : {});
  const departments = list(context.departamentos_disponibles).map(named);
  if (context.departamento) departments.push(named(context.departamento));
  const selected = context.departamento?.id || '';
  if (department && selected !== department) throw Error('department_mismatch');
  const warnings = [], capabilities = {};
  // Optional reads stay separate from core context. A denied tool never empties
  // an otherwise healthy context or fabricates an empty supported capability.
  const optional = async (key, name, args = {}) => {
    if (!names.has(name)) {capabilities[key] = 'unavailable'; return null;}
    try { const data = await mcp.call(name,args); capabilities[key]='available'; return data; }
    catch {capabilities[key]='failed'; warnings.push(key); return null;}
  };
  const requests = await optional('requests','listar_solicitudes');
  capabilities.levers = tools.some(t=>t.name === 'vision_objetivo' && t.annotations?.readOnlyHint === true) ? 'available' : 'unavailable';
  capabilities.alignment = names.has('vision_objetivo') ? 'available' : 'unavailable';
  const rawRequests = [...list(requests?.local),...list(requests?.cloud)].filter(r=> !selected || (r.departamentoId || r.departamento_id) === selected);
  const kpis = list(context.kpis), objectives = list(context.objetivos);
  const rawLevers = [];
  return {
    collectedAt:new Date().toISOString(), organization:string(context.organizacion), url:mcp.origin, departments, department:selected,
    capabilities, warnings, toolCount:tools.length,
    truncated:[kpis,objectives,rawRequests,rawLevers].some(items=>items.length>LIMIT) || objectives.some(o=>list(o.keyResults).length>LIMIT),
    kpis:kpis.slice(0,LIMIT).map(k=>({...state(k),value:number(k.valor_actual), unit:string(k.unidad), target:number(k.umbral), targetMax:number(k.umbral_max), operator:string(k.operador), window:number(k.ventana_dias), measuredAt:string(k.medido_en)})),
    objectives:objectives.slice(0,LIMIT).map(o=>({...state(o), keyResults:list(o.keyResults).slice(0,LIMIT).map(kr=>({...state(kr),kpiId:string(kr.kpi_id),value:number(kr.valor_actual),target:number(kr.meta)}))})),
    requests:rawRequests.slice(0,LIMIT).map(r=>({...state(r),status:string(r.estado || r.status),krId:string(r.keyResultId || r.key_result_id),executor:string(r.executor)})),
    levers:rawLevers.slice(0,LIMIT).map(state),
  };
}
async function vision(mcp, objectiveId) {
  if (!objectiveId || objectiveId.length > 200) throw Error('invalid_objective');
  await mcp.initialize();
  const tools = await mcp.tools();
  if (!tools.some(t=>t.name === 'vision_objetivo' && t.annotations?.readOnlyHint)) throw Error('vision_not_supported');
  const data = await mcp.call('vision_objetivo',{objetivo_id:objectiveId});
  if (data.objetivo?.id !== objectiveId) throw Error('objective_mismatch');
  return normalizeVision(data);
}
function normalizeVision(data) {
  return {objectiveId:string(data.objetivo.id), name:string(data.objetivo.nombre), paused:data.objetivo.pausado === true,
    pending:data.pendiente === true,
    checkin:data.checkin ? {status:string(data.checkin.estado), expectedAt:string(data.checkin.esperadoEn)} : null,
    levers:list(data.palancas).slice(0,LIMIT).map(p=>({...state(p), name:string(p.nombre || p.titulo || p.descripcion),
      krId:string(p.keyResultId || p.key_result_id),
      description:string(p.queHace), hypothesis:string(p.hipotesis), assignment:string(p.asignacion?.a),
      requests:list(p.ultimasSolicitudes).slice(0,10).map(state)})),
    decisions:list(data.decisionesAbiertas).slice(0,LIMIT).map(d=>({...state(d),name:string(d.pregunta || d.titulo || d.descripcion)})),
    truncated:list(data.palancas).length>LIMIT || list(data.decisionesAbiertas).length>LIMIT || list(data.palancas).some(p=>list(p.ultimasSolicitudes).length>10),
  };
}
module.exports = {client, collect, endpoint, vision, normalizeVision};
const ERRORS = ['invalid_origin','missing_token','access_denied','remote_unavailable','connection_failed','response_too_large','invalid_response','remote_error','tool_denied','incomplete_catalog','context_not_supported','department_mismatch',
  'not_connected','oauth_not_supported','refresh_busy','teams_not_supported','unsupported_format','invalid_export','invalid_team_file','name_conflict','no_model','team_conflict','uncommitted_changes','secret_detected',
  'templates_not_supported','publish_not_supported','unknown_department','version_conflict','conflict','no_package','departamento_requerido','unexpected_response',
  'proposals_not_supported','linked_to_biz','not_renamed','not_published','biz_http_error','operation_failed'];
// A personal token (sops) wins; otherwise the grant from the panel's OAuth login.
async function token(env = process.env) {
  if (env.BOT_FYSO_BIZ_TOKEN) return {token:env.BOT_FYSO_BIZ_TOKEN, oauth:false};
  return {token:await auth.store({env}).accessToken(), oauth:true};
}
async function teams(mcp, {root = process.cwd()} = {}) {
  await mcp.initialize();
  if (!(await mcp.tools()).some(t=>t.name === 'listar_equipos')) throw Error('teams_not_supported');
  // Matched by Biz team id: synchronized departments and older downloads alike (teams-sync.cjs).
  const result = await mcp.call('listar_equipos'), local = require('./teams-sync.cjs').links(root);
  return {teams:list(result.equipos).slice(0,LIMIT).map(e=>({id:string(e.id), slug:string(e.slug), name:string(e.nombre), description:string(e.descripcion), version:number(e.version), agents:number(e.agentes), skills:number(e.skills),
    localVersion:local[string(e.id)]?.version ?? null, department:local[string(e.id)]?.department ?? null}))};
}
async function prepareTeam(mcp, teamId, {root = process.cwd(), scan} = {}) {
  if (!teamId || teamId.length > 200) throw Error('invalid_export');
  await mcp.initialize();
  if (!(await mcp.tools()).some(t=>t.name === 'exportar_equipo')) throw Error('teams_not_supported');
  const team = require('./team.cjs'), fs = require('node:fs'), path = require('node:path');
  const plan = team.plan(await mcp.call('exportar_equipo', {equipo_id:teamId}));
  const current = fs.readFileSync(path.join(root, 'project/bots/team.yaml'), 'utf8');
  const proposed = team.proposeTeam(current, plan);
  const commit = team.writeFiles(plan, {root, scan});
  return {team:{...plan.source.equipo}, bots:plan.bots.map(b=>({name:b.name, title:b.title})), skills:plan.skillNames, commit,
    teamB64:Buffer.from(proposed).toString('base64'), teamBaseB64:Buffer.from(current).toString('base64')};
}
module.exports.teams = teams; module.exports.prepareTeam = prepareTeam; module.exports.token = token;
// How this project is connected, without contacting Biz.
function statusOf(env = process.env) {
  const state = env.BOT_FYSO_BIZ_TOKEN ? {connected:true, method:'token'} : {...auth.store({env}).status(), method:'oauth'};
  let login = null; try { login = auth.addresses(env).login; } catch { /* no gateway address */ }
  return {...state, url:auth.origin(env.FYSO_BIZ_URL || ''), login};
}
// With no department asked and only one available, open it in the same call.
async function context(mcp, department = '') {
  const first = await collect(mcp, department);
  return !department && !first.department && first.departments.length === 1 ? collect(mcp, first.departments[0].id) : first;
}
// Teams carry the connection, so the page needs one read to show either.
async function overview(env = process.env, open = async () => { const c = await token(env); return client(env.FYSO_BIZ_URL || '', c.token, fetch, {oauth:c.oauth}); }) {
  const connection = statusOf(env);
  if (!connection.connected) return {connection};
  return {connection, ...(await teams(await open()))};
}
Object.assign(module.exports, {statusOf, context, overview, ERRORS});
// `panel` reads the operation from the workflow parameter, from a fixed list only.
const PANEL_OPS = ['status','logout','teams','team-prepare','team-sync','team-publish','team-propose','team-rename'];
const commandOf = argv => argv[2] === 'panel' ? (PANEL_OPS.includes(process.env.FYSO_BIZ_OP) ? process.env.FYSO_BIZ_OP : 'status') : argv[2];
const sync = require('./teams-sync.cjs');
/**
 * The structured code of a failed panel action. `connection_failed` is what the client itself throws for a network
 * failure; anything else that is not a coded error is not "could not reach Biz": an HTTP error keeps its status, the
 * rest is `operation_failed`.
 */
function failureOf(error) {
  const http = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
  const code = ERRORS.includes(error?.message) ? error.message : http ? 'biz_http_error' : 'operation_failed';
  return {code, detail: code === 'biz_http_error' ? ` (HTTP ${error.status})` : ''};
}
Object.assign(module.exports, {failureOf});
if (require.main === module) (async()=>{
  const command = commandOf(process.argv);
  if (command === 'status') { console.log(JSON.stringify(statusOf())); return; }
  if (command === 'logout') { auth.store().logout(); console.log(JSON.stringify({connected:false})); return; }
  if (command === 'teams') { console.log(JSON.stringify(await overview())); return; }
  // Restoring the Biz name only reads the project: no Biz session needed.
  if (command === 'team-rename') { console.log(JSON.stringify(sync.restoreName({root:process.cwd(), equipoId:process.env.FYSO_BIZ_TEAM || ''}))); return; }
  const credential = await token();
  const mcp = client(process.env.FYSO_BIZ_URL || '', credential.token, fetch, {oauth:credential.oauth});
  if (command === 'check') {
    await mcp.initialize();
    const tools = await mcp.tools();
    if (!tools.some(t=>t.name === 'contexto')) throw Error('context_not_supported');
    await mcp.call('contexto');
    console.log(JSON.stringify({ok:true,toolCount:tools.length}));
  } else if (command === 'vision') console.log(JSON.stringify(await vision(mcp,process.env.FYSO_BIZ_OBJECTIVE)));
  else if (command === 'team-prepare') {
    const {execFileSync} = require('node:child_process');
    const overwrite = process.env.FYSO_BIZ_OVERWRITE === '1';
    // A team published from a project carries the full native package (framework D82).
    let pulled = null;
    try { pulled = await sync.pull({mcp, root:process.cwd(), equipoId:process.env.FYSO_BIZ_TEAM, overwrite}); }
    catch (error) { if (!['no_package','templates_not_supported'].includes(error.message)) throw error; }
    if (pulled) { console.log(JSON.stringify({...pulled, full:true})); return; }
    const prepared = await prepareTeam(mcp, process.env.FYSO_BIZ_TEAM, {
      scan:dir=>execFileSync('gitleaks',['dir',dir,'--no-banner','--redact'],{stdio:['ignore','ignore','inherit']})});
    // Keep the sync state on the same Biz team id when it holds this department.
    try { await sync.legacyPulled({root:process.cwd(), equipoId:prepared.team.id, version:prepared.team.version}); } catch { /* older framework: nothing to record */ }
    console.log(JSON.stringify(prepared));
  }
  else if (command === 'team-sync') console.log(JSON.stringify(await sync.status({mcp, root:process.cwd()})));
  else if (command === 'team-publish') console.log(JSON.stringify(await sync.publish({mcp, root:process.cwd(),
    department:process.env.FYSO_BIZ_LOCAL_DEPARTMENT || ''})));
  else if (command === 'team-propose') console.log(JSON.stringify(await sync.propose({mcp, root:process.cwd(),
    department:process.env.FYSO_BIZ_LOCAL_DEPARTMENT || '', equipoId:process.env.FYSO_BIZ_TEAM || '',
    message:process.env.FYSO_BIZ_MESSAGE || '', overwrite:process.env.FYSO_BIZ_OVERWRITE === '1'})));
  else console.log(JSON.stringify(await context(mcp, process.env.FYSO_BIZ_DEPARTMENT || '')));
})().catch(error=>{
  const {code, detail} = failureOf(error);
  console.error(`Fyso Biz: ${code}${error.bot ? ` (${error.bot})` : detail}`);
  // Panel actions read a structured failure from the output.
  if (['teams','team-prepare','team-sync','team-publish','team-propose','team-rename','status','logout'].includes(commandOf(process.argv))) console.log(JSON.stringify({error:code, ...(error.bot && {bot:error.bot}), ...(commandOf(process.argv) === 'teams' && {connection:statusOf()})}));
  else process.exitCode=1;
});
