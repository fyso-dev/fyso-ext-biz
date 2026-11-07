// Opt-in live panel smoke. Read-only Biz operations; no private screenshots.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const context=await browser.newContext({locale:'es-AR',httpCredentials:{username:process.env.FYSO_ADMIN_USER || 'admin',password:process.env.FYSO_ADMIN_PASSWORD || 'admin'},viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors=[],statuses=[];
  page.on('pageerror',()=>errors.push('pageerror'));
  page.on('response',r=>{if(r.url().includes('/api/dagu/'))statuses.push(r.status());});
  await page.goto(`${process.env.FYSO_BIZ_TEST_PANEL || 'http://panel.localhost:9460'}/?lang=es#/extensions/biz/overview`);
  const view=page.frameLocator('iframe[title="Fyso Biz"]');
  await view.getByRole('heading',{name:'Fyso Biz',exact:true}).waitFor();
  await view.getByText('Conectado con Biz',{exact:true}).waitFor({timeout:120000});
  const values=process.env.FYSO_BIZ_TEST_DEPARTMENT_ID ? [process.env.FYSO_BIZ_TEST_DEPARTMENT_ID] : await view.getByRole('combobox').locator('option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean));
  for(const id of values) {
   await view.getByRole('combobox').selectOption(id);
   await view.getByText('Conectado con Biz',{exact:true}).waitFor({timeout:120000});
   if(await view.getByRole('button',{name:'Ver plan y palancas',exact:true}).count())break;
  }
  const objectives=await view.getByRole('button',{name:'Ver plan y palancas',exact:true}).count();
  assert.ok(objectives>0,'No active test objective visible');
  await view.getByRole('button',{name:'Ver plan y palancas',exact:true}).first().click();
  const section=view.locator('section').filter({has:view.getByRole('heading',{name:'Palancas',exact:true})});
  await section.locator('article').first().waitFor({timeout:120000});
  assert.equal(errors.length,0);assert.equal(statuses.filter(s=>s>=400).length,0);
  console.log(JSON.stringify({mode:'live isolated stack',extensionOwnedPage:true,connected:true,objectives,levers:await section.locator('article').count(),pageErrors:0,daguHttpErrors:0}));
  await context.close();
 }finally{await browser.close();}
})().catch(()=>{console.error('Live browser smoke failed; inspect the isolated stack. No private content logged.');process.exitCode=1;});
