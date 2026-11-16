const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {dispatch, status, send} = require('../extensions/biz/dispatch.cjs');
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'biz-dispatch-')); fs.mkdirSync(path.join(root,'project'));
  const env={FYSO_ROOT:root,FYSO_DATA:path.join(root,'.data'),FYSO_OMB_PORT:'12345',FYSO_BIZ_URL:'https://example.invalid'};
  const configure=value=>fs.writeFileSync(path.join(root,'project/biz-dispatch.json'),JSON.stringify(value));
  return {env,configure};
}
const remote = requests => ({initialize:async()=>{},call:async()=>({agente:'Project A',solicitudes:requests})});
test('disabled unless explicitly configured',async()=>{
  const {env}=fixture(); assert.deepEqual(await dispatch({env}),{enabled:false,sent:0});
});
test('only requests explicitly assigned to this identity are delivered once',async()=>{
  const {env,configure}=fixture(); configure({enabled:true,kind:'room',target:'room-id'}); const sent=[];
  const mcp=remote([{id:'1',agenteDestino:'Project A'},{id:'2',agenteDestino:null},{id:'3',agenteDestino:'Project B'}]);
  const deliver=async (...args)=>sent.push(args);
  assert.equal((await dispatch({env,mcp,deliver})).sent,1);
  assert.equal((await dispatch({env,mcp,deliver})).sent,0);
  assert.deepEqual(sent.map(x=>x[2]),['1']); assert.equal(status(env).entries[0].state,'sent');
});
test('ambiguous delivery is recorded and never automatically retried',async()=>{
  const {env,configure}=fixture(); configure({enabled:true,kind:'bot',target:'bot-id'}); let count=0;
  const mcp=remote([{id:'one',agenteDestino:'Project A'}]), deliver=async()=>{count++;throw Error('lost acknowledgement');};
  assert.equal((await dispatch({env,mcp,deliver})).uncertain,1);
  await dispatch({env,mcp,deliver}); assert.equal(count,1); assert.equal(status(env).entries[0].state,'uncertain');
});
test('unassigned and reserved requests do not starve later eligible work',async()=>{
  const {env,configure}=fixture(); configure({enabled:true,kind:'bot',target:'bot-id'}); const sent=[];
  const deliver=async (_target,_port,id)=>sent.push(id);
  const assigned=Array.from({length:101},(_,i)=>({id:`assigned-${i}`,agenteDestino:'Project A'}));
  const unassigned=Array.from({length:101},(_,i)=>({id:`other-${i}`,agenteDestino:null}));
  assert.equal((await dispatch({env,mcp:remote([...unassigned,...assigned]),deliver})).sent,100);
  assert.equal((await dispatch({env,mcp:remote([...unassigned,...assigned]),deliver})).sent,1);
  assert.equal(sent.at(-1),'assigned-100');
});
test('invalid identity, target and project port fail closed',async()=>{
  const {env,configure}=fixture(); configure({enabled:true,kind:'bot',target:'-bad'});
  await assert.rejects(dispatch({env}),/invalid_dispatch_config/);
  configure({enabled:true,kind:'bot',target:'x'});
  await assert.rejects(dispatch({env:{...env,FYSO_OMB_PORT:''}}),/missing_project_port/);
  await assert.rejects(dispatch({env,mcp:{initialize:async()=>{},call:async()=>({solicitudes:[]})}}),/invalid_available_requests/);
});
test('concurrent polls reserve a request only once',async()=>{
  const {env,configure}=fixture(); configure({enabled:true,kind:'bot',target:'bot-id'}); let count=0;
  const mcp=remote([{id:'one',agenteDestino:'Project A'}]);
  const deliver=async()=>{count++; await new Promise(resolve=>setTimeout(resolve,10));};
  await Promise.all([dispatch({env,mcp,deliver}),dispatch({env,mcp,deliver})]); assert.equal(count,1);
});
test('native send captures the conversation receipt and passes a stable send id',async()=>{
  const bin=fs.mkdtempSync(path.join(os.tmpdir(),'biz-bin-'));
  fs.writeFileSync(path.join(bin,'openmausbot'), '#!/bin/sh\nprintf "{\\"threadId\\":\\"thread-1\\"}\\n"\n', {mode:0o755});
  const previous=process.env.PATH; process.env.PATH=bin+path.delimiter+previous;
  try {
    const receipt=await send({kind:'room',target:'room-id'},'12345','request-1');
    assert.equal(receipt.threadId,'thread-1'); assert.match(receipt.sendId,/^biz_[a-f0-9]{64}$/);
  } finally { process.env.PATH=previous; }
});
