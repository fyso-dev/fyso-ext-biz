const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
async function configure(env = process.env) {
  const root = env.FYSO_ROOT, port = env.FYSO_OMB_PORT, target = env.FYSO_BIZ_TARGET || '';
  if (!root || !/^\d+$/.test(port || '') || +port < 1 || +port > 65535 || (target && (!/^[A-Za-z0-9_-]{1,200}$/.test(target)))) throw Error('invalid_input');
  if (target) {
    const response = await fetch(`http://127.0.0.1:${port}/api/bots`, {signal:AbortSignal.timeout(10000)});
    if (!response.ok || !(await response.json()).bots.some(bot => bot.id === target)) throw Error('invalid_bot');
  }
  const file = 'project/biz-dispatch.json', absolute = path.join(root, file);
  const git = args => execFileSync('git', args, {cwd:root, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  if (git(['status','--porcelain','--',file]).trim()) throw Error('uncommitted_changes');
  if (fs.existsSync(absolute) && !fs.lstatSync(absolute).isFile()) throw Error('invalid_config_file');
  const contents = JSON.stringify(target ? {enabled:true, kind:'bot', target} : {enabled:false}, null, 2) + '\n';
  if (fs.existsSync(absolute) && fs.readFileSync(absolute,'utf8') === contents) return {ok:true};
  fs.writeFileSync(absolute, contents, {flag:'w', mode:0o600});
  git(['add','--',file]);
  git(['commit','--only','-m','biz: configure request dispatch','--',file]);
  return {ok:true};
}
if (require.main === module) configure().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports = {configure};
