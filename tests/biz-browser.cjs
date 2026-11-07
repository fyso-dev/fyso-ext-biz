// Local UX smoke using the existing Playwright installation. MCP/Dagu results
// are fixtures, while the panel is the real generated application over Caddy.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.FYSO_BIZ_TEST_PANEL || 'http://panel.localhost:9460';
const extension={id:'biz',src:'framework/extensions/biz',version:null,apps:['biz'],secrets:[{name:'BOT_FYSO_BIZ_TOKEN',required:true,set:true}],mcpServers:['fyso-biz'],workflows:['ext-biz-context','ext-biz-objective'],skills:['fyso-biz'],pages:[{id:'overview',name:'Fyso Biz',url:'/extensions/biz/panel/index.html'}]};
const snapshot={collectedAt:new Date().toISOString(),toolCount:70,departments:[{id:'demo',name:'Equipo de prueba'},{id:'other',name:'Otro equipo'}],department:'demo',capabilities:{requests:'available',levers:'available'},warnings:[],truncated:false,kpis:[{id:'k1',name:'Entregas verificadas',status:'saludable',value:8,target:10,unit:'%',operator:'gte',window:7,measuredAt:''},{id:'k2',name:'Tiempo de respuesta',status:'sin_datos',value:null,target:24,unit:'h',operator:'lte',window:7,measuredAt:''}],objectives:[{id:'o1',name:'Mejorar las entregas del equipo',status:'activo',keyResults:[{id:'kr1',name:'Alcanzar el objetivo de entregas',status:'activo',kpiId:'k1',value:8,target:10}]}],requests:[{id:'r1',name:'Verificar el flujo de entrega',status:'draft',krId:'kr1',executor:'local'}],levers:[]};
const plan={objectiveId:'o1',name:'Mejorar las entregas del equipo',paused:false,pending:true,checkin:{status:'pendiente',expectedAt:'2026-11-13'},levers:[{id:'p1',name:'Revisar evidencias antes de entregar',status:'aprobada',krId:'kr1',description:'Comprobar el resultado con una prueba funcional.',hypothesis:'Las verificaciones reducen los reintentos.',assignment:'cualquier_agente',requests:[{id:'r1',name:'Verificar el flujo de entrega',status:'draft'}]}],decisions:[],truncated:false};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
 const context=await browser.newContext({locale:'es-AR',httpCredentials:{username:process.env.FYSO_ADMIN_USER || 'admin',password:process.env.FYSO_ADMIN_PASSWORD || 'admin'},viewport:{width:1440,height:1100}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.name));let installed=false,fail=false;
 await page.route('**/config/extensions.json',route=>route.fulfill({json:installed?[extension]:[]}));
 await page.route('**/api/dagu/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p.endsWith('/enqueue'))return route.fulfill({json:{dagRunId:'fixture'}});
  if(p.endsWith('/outputs'))return route.fulfill({json:{outputs:{result:JSON.stringify(p.includes('ext-biz-objective')?plan:snapshot)}}});
  if(p.includes('/dag-runs/')&&!p.endsWith('/dag-runs'))return route.fulfill({json:{dagRunDetails:{dagRunId:'fixture',statusLabel:fail?'failed':'succeeded',finishedAt:new Date().toISOString()}}});
  return route.fulfill({json:{dagRuns:[]}});
 });
 await page.goto(`${base}/?lang=es`);
 if(await page.getByRole('navigation').getByRole('link',{name:'Fyso Biz',exact:true}).count())throw Error('tab_visible_before_install');
 installed=true;await page.reload();
 await page.getByRole('navigation').getByRole('link',{name:'Fyso Biz',exact:true}).first().click();
 const view=page.frameLocator('iframe[title="Fyso Biz"]');
 await view.getByText('Conectado con Biz',{exact:true}).waitFor();
 await view.getByRole('button',{name:'Ver plan y palancas',exact:true}).click();
 await view.getByText('Revisar evidencias antes de entregar',{exact:true}).waitFor();
 if(await view.getByText('Sin datos',{exact:true}).count()===0)throw Error('null_as_zero');
 const folder=path.resolve(__dirname,'../artifacts/delivery-evidence/fyso-biz');fs.mkdirSync(folder,{recursive:true});
 await page.screenshot({path:path.join(folder,'biz-context-desktop.png')});
 await view.getByRole('heading',{name:'Palancas',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));
 await page.screenshot({path:path.join(folder,'biz-plan-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('mobile_overflow');
 if(await view.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('page_mobile_overflow');
 await view.getByRole('heading',{name:'Palancas',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));
 await page.screenshot({path:path.join(folder,'biz-context-mobile.png')});
 await page.setViewportSize({width:1440,height:1100});
 await page.getByRole('button',{name:'EN',exact:true}).first().click();
 await view.getByRole('heading',{name:'Objectives and Key Results',exact:true}).waitFor();
 await page.getByRole('button',{name:/dark/i}).first().click();
 await view.locator('html.fy-dark').waitFor();
 await view.getByText('Connected to Biz',{exact:true}).waitFor();
 fail=true;await view.getByRole('button',{name:'Refresh context',exact:true}).click();
 await view.getByRole('alert').filter({hasText:'Could not read Biz'}).waitFor();
 if(await view.getByText('Mejorar las entregas del equipo',{exact:true}).count())throw Error('stale_context_after_failure');
 installed=false;await page.reload();
 await page.getByRole('alert').filter({hasText:/página de la extensión no está instalada|This extension page is not installed/}).waitFor();
 if(await page.locator('iframe').count())throw Error('uninstalled_page_still_mounted');
 if(await page.getByRole('navigation').getByRole('link',{name:'Fyso Biz',exact:true}).count())throw Error('tab_visible_after_removal');
 if(errors.length)throw Error('page_errors');
 console.log(JSON.stringify({mode:'extension-owned page with fixture MCP results',registration:true,tabVisibleOnlyWhenInstalled:true,context:true,plan:true,nullPreserved:true,mobileOverflow:false,english:true,sharedTheme:true,failedReadClearsContext:true,pageErrors:0,screenshots:3}));
 await context.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message.slice(0,220));process.exitCode=1;});
