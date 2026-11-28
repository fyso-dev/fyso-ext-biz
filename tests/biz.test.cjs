const {test} = require('node:test');
const assert = require('node:assert/strict');
const {client,collect,endpoint,vision,failureOf} = require('../extensions/biz/biz.cjs');
const text = data=>({content:[{type:'text',text:JSON.stringify(data)}]});
function fixture({deny=false,sse=false}={}) {
  const calls=[];
  const transport=async (url,options)=>{
    const request=JSON.parse(options.body);calls.push({url,options,request});
    const {method,params}=request;let result;
    if(method==='notifications/initialized') return new Response(null,{status:202});
    if(method==='initialize') result={protocolVersion:'2025-03-26'};
    if(method==='tools/list') result={tools:[{name:'contexto'},{name:'listar_solicitudes'},{name:'vision_objetivo',annotations:{readOnlyHint:true}}]};
    if(method==='tools/call') {
      if(deny) return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{isError:true,content:[{type:'text',text:'SECRET unauthorized data'}]}}));
      if(params.name==='contexto') result=text(params.arguments.departamento_id ? {departamento:{id:'d1',nombre:'Demo'},kpis:[{id:'k1',nombre:'Sales',valor_actual:null,umbral:0,umbral_max:5}],objetivos:[{id:'o1',nombre:'Grow',estado:'activo',keyResults:[{id:'kr1',kpi_id:'k1',valor_actual:0,meta:10}]}]} : {departamentos_disponibles:[{id:'d1',nombre:'Demo'}]});
      if(params.name==='listar_solicitudes') result=text({local:[{id:'r1',titulo:'Own',departamentoId:'d1',keyResultId:'kr1'},{id:'r2',titulo:'Other',departamentoId:'d2'}]});
      if(params.name==='vision_objetivo') result=text({objetivo:{id:'o1',nombre:'Grow'},palancas:[{id:'p1',titulo:'Improve',queHace:'Act',hipotesis:'Result',asignacion:{a:'cualquier_agente'},ultimasSolicitudes:[{id:'r1',titulo:'Work'}]}],decisionesAbiertas:[]});
    }
    const body=JSON.stringify({jsonrpc:'2.0',id:request.id,result});
    return new Response(sse?`event: message\ndata: ${body}\n\n`:body,{headers:{'content-type':sse?'text/event-stream':'application/json'}});
  };
  return {mcp:client('https://example.invalid','TEST_ONLY',transport),calls};
}
test('rejects origins that could redirect or expose the token',()=>{
  for(const origin of ['http://example.invalid','https://user:pass@example.invalid','https://example.invalid/api/mcp','https://example.invalid?x=1']) assert.throws(()=>endpoint(origin));
});
test('discovers departments before selecting a scope; exposes no token',async()=>{
  const {mcp,calls}=fixture();const data=await collect(mcp);
  assert.equal(data.departments[0].id,'d1');assert.equal(data.department,'');assert.equal(data.capabilities.levers,'available');assert.ok(!JSON.stringify(data).includes('TEST_ONLY'));
  assert.ok(calls.every(c=>c.options.redirect==='error'));assert.ok(calls.every(c=>!c.request.method.startsWith('tools/')||!c.request.params.name||['contexto','listar_solicitudes'].includes(c.request.params.name)));
});
test('preserves null vs zero, KR links, and selected-department request filtering',async()=>{
  const {mcp}=fixture();const data=await collect(mcp,'d1');
  assert.equal(data.kpis[0].value,null);assert.equal(data.kpis[0].target,0);assert.equal(data.kpis[0].targetMax,5);assert.equal(data.objectives[0].keyResults[0].value,0);
  assert.deepEqual(data.requests.map(r=>r.id),['r1']);assert.equal(data.requests[0].krId,'kr1');
});
test('reads native vision and lever requests using the live MCP shape over SSE',async()=>{
  const {mcp,calls}=fixture({sse:true});const plan=await vision(mcp,'o1');assert.equal(plan.levers[0].name,'Improve');assert.equal(plan.levers[0].requests[0].name,'Work');assert.equal(plan.levers[0].assignment,'cualquier_agente');assert.ok(calls.some(c=>c.request.params?.name==='vision_objetivo'));
});
test('denied scope fails closed without propagating remote text',async()=>{
  const {mcp}=fixture({deny:true});await assert.rejects(collect(mcp,'d2'),{message:'tool_denied'});
});
test('a mismatched department is never rendered as selected context',async()=>{
  const {mcp}=fixture();await assert.rejects(collect(mcp,'d2'),{message:'department_mismatch'});
});
test('optional request failure remains explicit while context succeeds',async()=>{
  const mcp={initialize:async()=>{},tools:async()=>[{name:'contexto'},{name:'listar_solicitudes'}],call:async(name)=>{if(name==='listar_solicitudes')throw Error('denied');return {departamento:{id:'d1'},kpis:[],objetivos:[]};}};
  const data=await collect(mcp,'d1');assert.equal(data.capabilities.requests,'failed');assert.deepEqual(data.warnings,['requests']);assert.equal(data.capabilities.levers,'unavailable');
});

test('nested result limits are explicit instead of silently hiding KRs',async()=>{
  const mcp={initialize:async()=>{},tools:async()=>[{name:'contexto'}],call:async()=>({departamento:{id:'d1'},objetivos:[{id:'o1',keyResults:Array.from({length:101},(_,i)=>({id:String(i)}))}]})};
  const data=await collect(mcp,'d1');assert.equal(data.objectives[0].keyResults.length,100);assert.equal(data.truncated,true);
});

test('a panel action failure is coded: its own codes stay, an HTTP error keeps its status, anything else is not "could not reach Biz"',()=>{
  assert.deepEqual(failureOf(Error('connection_failed')),{code:'connection_failed',detail:''});
  assert.deepEqual(failureOf(Error('uncommitted_changes')),{code:'uncommitted_changes',detail:''});
  assert.deepEqual(failureOf(Object.assign(Error('Request failed'),{status:503})),{code:'biz_http_error',detail:' (HTTP 503)'});
  for(const error of [new TypeError('x is not a function'),Error('Command failed: git commit'),Object.assign(Error('weird'),{status:'nope'}),null,undefined])assert.equal(failureOf(error).code,'operation_failed');
  assert.ok(['biz_http_error','operation_failed'].every(code=>require('../extensions/biz/biz.cjs').ERRORS.includes(code)));
});
