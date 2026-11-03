import {spawn} from 'node:child_process'
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {sourceFingerprint} from './release.mjs'
import {base} from './bootstrap.mjs'
const here=fileURLToPath(new URL('../',import.meta.url)),folder=join(base,'state/dsh-core/certifications',randomUUID()),fingerprint=sourceFingerprint()
mkdirSync(folder,{recursive:true})
async function run(name,exe,args,cwd=here){
  console.log(JSON.stringify({stage:name,state:'running'}));let output=''
  const code=await new Promise((done,reject)=>{const child=spawn(exe,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('close',done)})
  writeFileSync(join(folder,name+'.log'),output)
  if(code!==0)throw Error(name+' failed: '+output.slice(-2500))
  console.log(JSON.stringify({stage:name,state:'passed'}));return output
}
try{
  await run('panel-ui',process.execPath,['panel/check.mjs'])
  await run('compatibility','python',['-B','durable_worker.py','--check'])
  await run('node-tests',process.execPath,['run-tests.mjs','--json'])
  await run('python-tests','python',['-B','-m','unittest','discover','-s','tests','-p','test_*.py','-v'])
  await run('legacy-tests','python',['-B','-m','unittest','discover','-s','tests','-v'],join(base,'app'))
  const audit=await run('continuity','python',['-B','framework/validate_release.py'])
  await run('app-server-protocol','python',['-B','framework/app_server_check.py'])
  const workspace=await run('live-workspace','python',['-B','framework/workspace_live.py'])
  const chats=await run('ordinary-chat',process.execPath,['--experimental-transform-types','framework/chats-live.mjs'])
  const crash=await run('host-crash',process.execPath,['--experimental-transform-types','framework/crash-demo.mjs'])
  const live=await run('live-model',process.execPath,['--experimental-transform-types','framework/live-demo.mjs'])
  if(sourceFingerprint()!==fingerprint)throw Error('Source changed during certification')
  const summary=JSON.parse(readFileSync(join(base,'state/dsh-core/framework-tests.json'),'utf8'))
  const report={status:'passed',fingerprint,at:new Date().toISOString(),node_tests:summary.numPassedTests,folder,
    audit:JSON.parse(audit.trim()),chats:JSON.parse(chats.trim().split('\n').filter(l=>l.startsWith('{')).at(-1)),crash:JSON.parse(crash.trim().split('\n').filter(l=>l.startsWith('{')).at(-1)),
    live:JSON.parse(live.trim().split('\n').filter(l=>l.startsWith('{')).at(-1)),
    workspace:JSON.parse(workspace.trim().split('\n').filter(l=>l.startsWith('{')).at(-1)),
    scope:'Local synthetic framework acceptance; no private data, physical FPGA toolchain, unattended production soak or source merge certification'}
  writeFileSync(join(folder,'validation.json'),JSON.stringify(report,null,2));writeFileSync(join(base,'state/framework-accepted.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}catch(error){writeFileSync(join(folder,'failure.json'),JSON.stringify({status:'failed',fingerprint,error:String(error)},null,2));console.error(error);process.exitCode=1}
