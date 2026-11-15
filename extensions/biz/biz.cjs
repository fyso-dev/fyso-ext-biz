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
  async function rpc(method, params, notification = false) {
    let response;
    try {
      response = await transport(url, {method:'POST', redirect:'error', signal:AbortSignal.timeout(30000), headers:{
        'Content-Type':'application/json', Accept:'application/json, text/event-stream',
        Authorization:`Bearer ${token}`, ...(session ? {'Mcp-Session-Id':session} : {}),
        'MCP-Protocol-Version':protocol,
      }, body:JSON.stringify({jsonrpc:'2.0', ...(!notification && {id:++id}), method, params})});
    } catch { throw Error('connection_failed'); }
    if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? 'access_denied' : 'remote_unavailable');
    session = response.headers.get('mcp-session-id') || session;
    if (notification) { await response.body?.cancel(); return; }
    // Read JSON and SSE responses with a size bound and a request timeout.
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, {stream:true});
      if (text.length > 4_000_000) { await reader.cancel(); throw Error('response_too_large'); }
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        for (const frame of text.split(/\r?\n\r?\n/).slice(0,-1)) {
          const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let message; try { message = JSON.parse(data); } catch { throw Error('invalid_response'); }
          if (message.id === id) { await reader.cancel(); return unwrap(message); }
        }
      }
    }
    try { return unwrap(JSON.parse(text)); } catch(e) { if (e.message === 'remote_error') throw e; throw Error('invalid_response'); }
  }
  const unwrap = message => {
    if (message.error) throw Error('remote_error');
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
      if (result.isError) throw Error('tool_denied');
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
  'not_connected','oauth_not_supported','refresh_busy','teams_not_supported','unsupported_format','invalid_export','invalid_team_file','name_conflict','no_model','uncommitted_changes','secret_detected'];
// A personal token (sops) wins; otherwise the grant from the panel's OAuth login.
async function token(env = process.env) {
  if (env.BOT_FYSO_BIZ_TOKEN) return {token:env.BOT_FYSO_BIZ_TOKEN, oauth:false};
  return {token:await auth.store({env}).accessToken(), oauth:true};
}
// Teams already in this project, from the provenance each import commits.
function imported(root = process.cwd()) {
  const fs = require('node:fs'), path = require('node:path'), dir = path.join(root, 'project/bots/biz'), found = {};
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return found; }
  for (const entry of entries) {
    try {
      const source = JSON.parse(fs.readFileSync(path.join(dir, entry, 'source.json'), 'utf8'));
      if (source?.equipo?.id) found[source.equipo.id] = {version:number(source.equipo.version)};
    } catch { /* not an import */ }
  }
  return found;
}
async function teams(mcp, {root = process.cwd()} = {}) {
  await mcp.initialize();
  if (!(await mcp.tools()).some(t=>t.name === 'listar_equipos')) throw Error('teams_not_supported');
  const result = await mcp.call('listar_equipos'), local = imported(root);
  return {teams:list(result.equipos).slice(0,LIMIT).map(e=>({id:string(e.id), slug:string(e.slug), name:string(e.nombre), description:string(e.descripcion), version:number(e.version), agents:number(e.agentes), skills:number(e.skills),
    localVersion:local[string(e.id)]?.version ?? null}))};
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
const PANEL_OPS = ['status','logout','teams','team-prepare'];
const commandOf = argv => argv[2] === 'panel' ? (PANEL_OPS.includes(process.env.FYSO_BIZ_OP) ? process.env.FYSO_BIZ_OP : 'status') : argv[2];
if (require.main === module) (async()=>{
  const command = commandOf(process.argv);
  if (command === 'status') { console.log(JSON.stringify(statusOf())); return; }
  if (command === 'logout') { auth.store().logout(); console.log(JSON.stringify({connected:false})); return; }
  if (command === 'teams') { console.log(JSON.stringify(await overview())); return; }
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
    console.log(JSON.stringify(await prepareTeam(mcp, process.env.FYSO_BIZ_TEAM, {
      scan:dir=>execFileSync('gitleaks',['dir',dir,'--no-banner','--redact'],{stdio:['ignore','ignore','inherit']})})));
  }
  else console.log(JSON.stringify(await context(mcp, process.env.FYSO_BIZ_DEPARTMENT || '')));
})().catch(error=>{
  const code = ERRORS.includes(error.message) ? error.message : 'connection_failed';
  console.error(`Fyso Biz: ${code}${error.bot ? ` (${error.bot})` : ''}`);
  // Panel actions read a structured failure from the output.
  if (['teams','team-prepare','status','logout'].includes(commandOf(process.argv))) console.log(JSON.stringify({error:code, ...(error.bot && {bot:error.bot}), ...(commandOf(process.argv) === 'teams' && {connection:statusOf()})}));
  else process.exitCode=1;
});
