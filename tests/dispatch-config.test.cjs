const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), {execFileSync}=require('node:child_process');
const {configure}=require('../extensions/biz/dispatch-config.cjs');
test('validates a native bot and commits only the dispatch file; preserves dirty work',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'biz-config-'));fs.mkdirSync(path.join(root,'project'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');fs.writeFileSync(path.join(root,'other'),'one');git('add','other');git('commit','-qm','initial');fs.writeFileSync(path.join(root,'other'),'two');
 const original=global.fetch;global.fetch=async()=>({ok:true,json:async()=>({bots:[{id:'bot-1'}]})});
 const env={FYSO_ROOT:root,FYSO_OMB_PORT:'12345',FYSO_BIZ_TARGET:'bot-1'};
 try {await configure(env);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'project/biz-dispatch.json'))),{enabled:true,kind:'bot',target:'bot-1'});assert.equal(git('show','--format=','--name-only','HEAD').trim(),'project/biz-dispatch.json');assert.equal(fs.readFileSync(path.join(root,'other'),'utf8'),'two');
 fs.writeFileSync(path.join(root,'project/biz-dispatch.json'),'custom');await assert.rejects(configure(env),/uncommitted_changes/);
 await assert.rejects(configure({...env,FYSO_BIZ_TARGET:'unknown'}),/invalid_bot/);
 } finally {global.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
});
