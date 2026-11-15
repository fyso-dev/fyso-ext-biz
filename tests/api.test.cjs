const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const {api} = require('../extensions/biz/api.cjs');
const {listenPrivate} = require('../extensions/biz/gateway.cjs');

const text = data => ({content:[{type:'text', text:JSON.stringify(data)}]});
// A Biz MCP double that counts round trips and can expire its session once.
function biz({expireOnce = false} = {}) {
  const counts = {initialize:0, 'tools/list':0, 'tools/call':0};
  let expired = !expireOnce;
  const transport = async (url, options) => {
    const request = JSON.parse(options.body), {method, params} = request;
    if (method === 'notifications/initialized') return new Response(null, {status:202});
    counts[method]++;
    if (method === 'tools/call' && !expired) { expired = true; return new Response('gone', {status:404}); }
    let result;
    if (method === 'initialize') result = {protocolVersion:'2025-03-26'};
    if (method === 'tools/list') result = {tools:[{name:'contexto'}, {name:'listar_equipos'}, {name:'vision_objetivo', annotations:{readOnlyHint:true}}]};
    if (method === 'tools/call' && params.name === 'contexto') result = text(params.arguments.departamento_id
      ? {organizacion:'Acme', departamento:{id:'d1', nombre:'Ventas'}, kpis:[], objetivos:[]}
      : {organizacion:'Acme', departamentos_disponibles:[{id:'d1', nombre:'Ventas'}]});
    if (method === 'tools/call' && params.name === 'listar_equipos') result = text({equipos:[{id:'t1', nombre:'Ventas', version:2}]});
    if (method === 'tools/call' && params.name === 'vision_objetivo') result = text({objetivo:{id:'o1', nombre:'Crecer'}, palancas:[], decisionesAbiertas:[]});
    return new Response(JSON.stringify({jsonrpc:'2.0', id:request.id, result}), {headers:{'content-type':'application/json'}});
  };
  return {transport, counts};
}
function env(extra = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-api-'));
  return {FYSO_DATA:data, FYSO_BIZ_URL:'https://example.invalid', ...extra};
}
// Drive the handler like the gateway does, without a socket.
async function call(handler, method, url) {
  return new Promise(resolve => {
    const res = {status:0, headers:{}, writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this; },
      end(body) { resolve({status:this.status, headers:this.headers, body:body ? JSON.parse(body) : null}); }};
    handler({method, url}, res);
  });
}

test('one read opens the only department and later reads reuse the MCP session', async () => {
  const {transport, counts} = biz();
  const handler = api({env:env({BOT_FYSO_BIZ_TOKEN:'TEST_ONLY'}), transport});
  const first = await call(handler, 'GET', '/context?department=');
  assert.equal(first.status, 200); assert.equal(first.body.department, 'd1'); assert.equal(first.body.organization, 'Acme');
  assert.equal(first.headers['Cache-Control'], 'no-store');
  await call(handler, 'GET', '/objective?id=o1');
  assert.deepEqual([counts.initialize, counts['tools/list']], [1, 1]);
  assert.ok(!JSON.stringify(first.body).includes('TEST_ONLY'));
});

test('teams carry the connection and are read without a separate status call', async () => {
  const {transport} = biz();
  const result = await call(api({env:env({BOT_FYSO_BIZ_TOKEN:'TEST_ONLY'}), transport}), 'GET', '/teams');
  assert.equal(result.body.connection.connected, true); assert.equal(result.body.connection.method, 'token');
  assert.deepEqual(result.body.teams.map(t => [t.id, t.version, t.localVersion]), [['t1', 2, null]]);
});

test('without a connection, teams answer at once and never contact Biz', async () => {
  const {transport, counts} = biz();
  const result = await call(api({env:env(), transport}), 'GET', '/teams');
  assert.deepEqual(result.body.connection.connected, false); assert.equal(result.body.teams, undefined);
  assert.equal(counts.initialize, 0);
});

test('an expired MCP session is opened again once', async () => {
  const {transport, counts} = biz({expireOnce:true});
  const result = await call(api({env:env({BOT_FYSO_BIZ_TOKEN:'TEST_ONLY'}), transport}), 'GET', '/context?department=d1');
  assert.equal(result.body.department, 'd1'); assert.equal(counts.initialize, 2);
});

test('only the declared routes exist and failures stay structured', async () => {
  const handler = api({env:env({BOT_FYSO_BIZ_TOKEN:'TEST_ONLY'}), transport:async () => { throw Error('SECRET socket detail'); }});
  assert.equal((await call(handler, 'GET', '/team-prepare')).status, 404);
  assert.equal((await call(handler, 'GET', '/logout')).status, 404);
  const failed = await call(handler, 'GET', '/context');
  assert.deepEqual(failed.body, {error:'connection_failed'});
});

test('logout removes the grant and answers the new state', async () => {
  const environment = env();
  const dir = path.join(environment.FYSO_DATA, 'ext/biz'); fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, 'oauth.json'), JSON.stringify({origin:'https://example.invalid', accessToken:'x'}));
  const handler = api({env:environment, transport:biz().transport});
  assert.equal((await call(handler, 'GET', '/status')).body.connected, true);
  const result = await call(handler, 'POST', '/logout');
  assert.equal(result.body.connected, false); assert.ok(!fs.existsSync(path.join(dir, 'oauth.json')));
});

test('the private socket is owner-only and replaces a stale one', async () => {
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bz-')), 's.sock');
  fs.writeFileSync(socket, 'stale');
  const server = await listenPrivate((req, res) => { res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"ok":true}'); }, socket);
  try {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    const status = await new Promise((resolve, reject) => http.get({socketPath:socket, path:'/health'}, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    assert.equal(status, 204);
  } finally { server.close(); }
});

test('creating work uses the connected identity and never retries an ambiguous mutation', async () => {
  let creates=0, args;
  const base=biz().transport;
  const transport=async (url,options)=>{
    const request=JSON.parse(options.body);
    if (request.method==='tools/call' && request.params.name==='solicitudes_disponibles') return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:text({agente:'Project A',solicitudes:[]})}),{headers:{'content-type':'application/json'}});
    if (request.method==='tools/call' && request.params.name==='crear_solicitud') {creates++;args=request.params.arguments;throw Error('connection lost');}
    return base(url,options);
  };
  const handler=api({env:env({BOT_FYSO_BIZ_TOKEN:'TEST_ONLY'}),transport});
  const {Readable}=require('node:stream');
  const req=Readable.from([JSON.stringify({department:'d1',kr:'kr1',title:'Title',instructions:'Instructions'})]); req.method='POST';req.url='/work';
  const result=await new Promise(resolve=>handler(req,{writeHead(){},end(body){resolve(JSON.parse(body));}}));
  assert.deepEqual(result,{error:'uncertain'}); assert.equal(creates,1);
  assert.deepEqual(args,{ejecutor:'agente',agente_destino:'Project A',titulo:'Title',instrucciones:'Instructions',key_result_id:'kr1'});
});
