// Opt-in live read-only smoke: counts only, never credentials or business text.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {client,collect,vision}=require('../extensions/biz/biz.cjs');
const file=process.argv[2] || '.data/biz-test/connection.env';
(async()=>{
 const env={};
 for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
  const m=/^([A-Z_]+)=(.*)$/.exec(line);
  if(m)env[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');
 }
 const users=[];
 for(const [label,token] of [['primary',env.BOT_FYSO_BIZ_TOKEN],['secondary',env.BOT_FYSO_BIZ_SECONDARY_TOKEN]]) {
  if(!token){if(label==='primary')throw Error('missing_primary_token');continue;}
  const initial=await collect(client(env.FYSO_BIZ_URL,token));let selected;
  const departments=env.FYSO_BIZ_TEST_DEPARTMENT_ID ? initial.departments.filter(d=>d.id===env.FYSO_BIZ_TEST_DEPARTMENT_ID) : initial.departments;
  for(const department of departments) {
   selected=await collect(client(env.FYSO_BIZ_URL,token),department.id);
   if(selected.objectives.length)break;
  }
  let levers=0;
  if(selected?.objectives.length && selected.capabilities.levers==='available') {
   levers=(await vision(client(env.FYSO_BIZ_URL,token),selected.objectives[0].id)).levers.length;
  }
  users.push({token,initial});
  console.log(JSON.stringify({user:label,connected:true,tools:initial.toolCount,departments:initial.departments.length,kpis:selected?.kpis.length||0,objectives:selected?.objectives.length||0,levers}));
 }
 let isolation='not_checked_second_token_missing';
 if(users.length===2) {
  isolation='not_checked_no_distinct_department';
  for(const user of users) {
   const other=users.find(u=>u!==user);
   const forbidden=other.initial.departments.find(d=>!user.initial.departments.some(a=>a.id===d.id));
   if(forbidden) {
    await assert.rejects(()=>collect(client(env.FYSO_BIZ_URL,user.token),forbidden.id),{message:'tool_denied'});
    isolation='foreign_department_denied';break;
   }
  }
 }
 console.log(JSON.stringify({isolation,mutations:0}));
})().catch(()=>{console.error('Live Biz smoke failed; check credentials, scope and connectivity. No remote content logged.');process.exitCode=1;});
