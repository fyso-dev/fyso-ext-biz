const {test}=require('node:test');const assert=require('node:assert/strict');
const {provision}=require('../extensions/biz/bot.cjs');
function fixture(existing=[]) {
 const calls=[],bots=[...existing];let profile;
 return {bots,calls,port:{origin:'https://example.invalid',root:'/fixture',models:async()=>({instances:[{instanceId:'native',snapshot:{state:'available'},models:{default:'offered-model',options:[{id:'offered-model'}]}}]}),architect:async p=>{
  calls.push(p);
  if(p.OP==='list')return {bots};
  if(p.OP==='read')return {bot:profile||{name:'Biz Partner',description:'Fyso Biz integration assistant',cwd:'/fixture'}};
  if(p.OP==='plan'){profile=JSON.parse(Buffer.from(p.BOT_B64,'base64'));return {planId:'exact-plan',preview:{created:1,changed:0,deleted:0}};}
  if(p.OP==='apply'){assert.equal(p.PLAN_ID,'exact-plan');bots.push({id:'biz-id',name:'Biz Partner'});return {botId:'biz-id'};}
 }}};
}
test('creates one contextual bot through exact native plan/apply, with project MCP cwd and ask approval',async()=>{
 const f=fixture();const result=await provision(f.port);assert.equal(result.created,true);
 const entry=JSON.parse(Buffer.from(f.calls.find(c=>c.OP==='plan').BOT_B64,'base64'));
 assert.equal(entry.cwd,'${FYSO_ROOT}');assert.equal(entry.model,'native/offered-model');assert.equal(entry.approval,'ask');assert.equal(entry.computer,'off');assert.ok(entry.soul.length>500);
 await provision(f.port);assert.equal(f.calls.filter(c=>c.OP==='apply').length,1);assert.equal(f.bots.length,1);
});
test('does not take over another bot with the same name',async()=>{
 const f=fixture([{id:'other',name:'Biz Partner'}]);f.port.architect=async p=>p.OP==='list'?{bots:f.bots}:{bot:{description:'Another bot'}};
 await assert.rejects(provision(f.port),/belongs to another bot/);
});
test('refuses a native preview that touches unrelated bots',async()=>{
 const f=fixture(),real=f.port.architect;f.port.architect=async p=>p.OP==='plan'?{preview:{created:1,changed:1}}:real(p);
 await assert.rejects(provision(f.port),/unexpected Biz bot preview/);assert.equal(f.calls.some(c=>c.OP==='apply'),false);
});
