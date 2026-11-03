import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DurableRuntime } from '../src/durable-runtime.mjs'
import { Superagent } from '../framework/superagent.mjs'
import { Jobs } from '../framework/jobs.mjs'
import { Watchdog } from '../framework/watchdog.mjs'
import { serve } from '../framework/server.mjs'
const apps=[],areas=[]
async function start(options={}){
  const directory=mkdtempSync(join(tmpdir(),'sa-http-'));areas.push(directory)
  const control={cancel(){},result:async()=>null,execute:async()=>{throw Error('No model call expected')}}
  const runtime=new DurableRuntime({directory:join(directory,'runtime'),transport:control})
  const agent=new Superagent(runtime,control,[{id:'demo',capabilities:[{id:'a',repo_id:'repo-a',inputs:[{path:'a.md',sha256:'a'.repeat(64)}]}]}])
  const jobs=new Jobs(agent,join(directory,'jobs')),watchdog=new Watchdog(agent,control)
  const app=await serve({directory,runtime,agent,jobs,watchdog,control},{pump:false,monitor:false,...options});apps.push(app)
  const url=new URL(app.url);url.hash=''
  const call=(path,value,headers={})=>fetch(new URL(path,url),{method:value===undefined?'GET':'POST',headers:{authorization:'Bearer '+app.token,'content-type':'application/json',...headers},...(value===undefined?{}:{body:JSON.stringify(value)})})
  return {app,call,url,agent,runtime,jobs,watchdog,control,directory}
}
afterEach(async()=>{for(const a of apps.splice(0))await a.close();for(const d of areas.splice(0))rmSync(d,{recursive:true,force:true})})
it('accepts 4 and 16 worker slots through settings and rejects limits outside the upstream range',async()=>{
 const {app,runtime}=await start(),endpoint=new URL('/orchestrator/api/codex/runtime',app.url);endpoint.hash=''
 const save=(maxWorkers,revision)=>fetch(endpoint,{method:'PUT',headers:{authorization:'Bearer '+app.token,'x-orchestrator-request':'1','content-type':'application/json'},body:JSON.stringify({value:{maxWorkers},revision})})
 expect((await save(4,0)).status).toBe(200);expect(runtime.capacity).toBe(4)
 expect((await save(16,1)).status).toBe(200);expect(runtime.capacity).toBe(16)
 expect((await save(17,2)).status).toBe(400);expect((await save(0,2)).status).toBe(400)
 expect((await save(8,1)).status).toBe(409);expect(runtime.capacity).toBe(16)
})
it('exposes authenticated version-fenced deployment operations and refreshes setup from accepted values',async()=>{
 const {call,app,agent}=await start(),headers={'x-orchestrator-request':'1'},path='/orchestrator/api/codex/deployment'
 const initial=await (await call(path,undefined,headers)).json();expect(initial.writable).toBe(true)
 const endpoint=new URL(path,app.url);endpoint.hash=''
 const save=(body,extra={})=>fetch(endpoint,{method:'PUT',headers:{authorization:'Bearer '+app.token,'content-type':'application/json',...headers,...extra},body:JSON.stringify(body)})
 const body={revision:0,ops:[{op:'set',path:['admissionContextMaxPages'],value:2}]}
 expect((await save(body,{origin:'https://attacker.invalid'})).status).toBe(403)
 expect((await save(body)).status).toBe(200);expect((await save(body)).status).toBe(409)
 expect((await (await call('/orchestrator/api/state',undefined,headers)).json()).setup.machine.admissionContextMaxPages).toBe(2)
 expect(agent.deployment.value.admissionContextMaxPages).toBe(2)
 expect((await save({revision:1,ops:[{op:'set',path:['stateDir'],value:'wrong'}]})).status).toBe(400)
})
it('serves original prompt settings with real saves, conflicts, preview and no implicit model calls',async()=>{
 const {call,agent,runtime,app}=await start()
 const header={'x-orchestrator-request':'1'},url='/orchestrator/api/prompts'
 const initial=await (await call(url,undefined,header)).json()
 const endpoint=new URL(url,app.url);endpoint.hash=''
 const save=(body,extra={})=>fetch(endpoint,{method:'PUT',headers:{authorization:'Bearer '+app.token,'content-type':'application/json',...header,...extra},body:JSON.stringify(body)})
 const config={...initial.defaults,delivery:'HTTP_PROMPT_77'}
 expect((await save({config,baseRevision:0},{origin:'https://attacker.invalid'})).status).toBe(403)
 expect((await save({config,baseRevision:0})).status).toBe(200)
 expect((await save({config,baseRevision:0})).status).toBe(409)
 const preview=await (await call('/orchestrator/api/prompts/preview',config,header)).json();expect(preview.worker).toContain('HTTP_PROMPT_77')
 expect(agent.status().messages).toHaveLength(0);expect(runtime.turns()).toHaveLength(0)
 expect((await (await call('/orchestrator/api/prompts?revision=0',undefined,header)).json()).current.config.delivery).toBe(initial.defaults.delivery)
 expect((await save({config:{...config,unknown:'x'},baseRevision:1})).status).toBe(400)
})
it('provides scoped paginated chat history beyond the old 100-message status limit',async()=>{
 const {call,agent}=await start()
 for(let n=0;n<115;n++)agent.receive({id:'history-'+n,project:'demo',text:'Synthetic history '+n})
 const last=await (await call('/api/harness?project=demo')).json()
 expect(last.messages).toHaveLength(50);expect(last.hasMore).toBe(true)
 const prior=await (await call('/api/harness?project=demo&before='+last.before)).json()
 const first=await (await call('/api/harness?project=demo&before='+prior.before)).json()
 expect([...first.messages,...prior.messages,...last.messages]).toHaveLength(115)
 expect(first.messages[0].body.text).toBe('Synthetic history 0')
 expect((await call('/api/harness?project=unknown')).status).toBe(400)
 expect((await call('/api/harness/events?project=demo&call=00000000-0000-0000-0000-000000000000')).status).toBe(400)
 expect((await call('/api/harness?project=demo',undefined,{authorization:''})).status).toBe(403)
})
it('creates ordinary conversations without routing and retries message delivery idempotently',async()=>{
 const {call,agent}=await start(),created=await (await call('/api/chats',{project:'demo'})).json()
 const message={project:'demo',chat:created.id,id:'normal-once',text:'Synthetic normal chat'}
 expect((await call('/api/chats/message',message)).status).toBe(200);await call('/api/chats/message',message)
 const detail=await (await call('/api/harness?project=demo&chat='+created.id)).json()
 expect(detail.messages).toHaveLength(1);expect(detail.title).toBe(message.text)
 expect(agent.status().messages).toHaveLength(0)
 expect((await call('/api/harness?project=demo&chat=not-owned')).status).toBe(400)
 expect((await call('/api/navigation',{project:'demo',target:'chat:'+created.id,compose:true})).status).toBe(200)
 expect((await (await call('/api/status')).json()).navigation.target).toBe('chat:'+created.id)
 expect((await call('/api/navigation',{project:'demo',target:'chat:not-owned',compose:true})).status).toBe(400)
})
it('opens a Router view before its first model turn and replenishes only the selected finite budget',async()=>{
 const {call}=await start()
 expect(await (await call('/api/harness/resolve?project=demo&session=router%3Ademo')).json()).toEqual({project:'demo',ticket:null})
 await call('/api/budgets',{worker:0,router:0,watchdog:0})
 expect((await call('/api/budgets/add',{role:'router',amount:20})).status).toBe(200)
 const status=await (await call('/api/status')).json();expect(status.budgets).toEqual({worker:0,router:20,watchdog:0})
 expect((await call('/api/budgets/add',{role:'worker',amount:21})).status).toBe(400)
})
it('navigates global-panel worker sessions to their actual project without exposing unknown Codex sessions',async()=>{
 const {call,agent,runtime}=await start()
 agent.projects.push({...agent.project('demo'),id:'other'})
 const ticket=runtime.submit('cross-navigation',{repo_id:'repo-a',worker_role:'Synthetic worker',objective:'Synthetic cross-project navigation',permission:'read-only',inputs:[{path:'a.md',sha256:'a'.repeat(64)}]})
 runtime.store.db.prepare('INSERT INTO sa_ticket VALUES (?,?,?,?)').run(ticket,'other','a','cross-navigation')
 const virtual=await (await call('/api/harness/resolve?project=demo&session=worker:'+ticket)).json()
 expect(virtual).toEqual({project:'other',ticket})
 const session='99999999-9999-4999-8999-999999999999'
 runtime.store.db.prepare('UPDATE codex_binding SET session_id=? WHERE ticket_id=?').run(session,ticket)
 expect(await (await call('/api/harness/resolve?project=demo&session='+session)).json()).toEqual({project:'other',ticket})
 expect((await call('/api/harness?project=demo&ticket='+ticket)).status).toBe(400)
 expect((await call('/api/harness/resolve?project=demo&session=00000000-0000-0000-0000-000000000000')).status).toBe(400)
})
it('streams only registered execution events with stable byte offsets, including UTF-8 and partial tails',async()=>{
 const {call,agent,runtime,directory}=await start(),id='12345678-1234-1234-1234-123456789abc'
 const request={session_id:null},file=join(directory,'control',id,'ui-events.jsonl')
 runtime.store.db.prepare("INSERT INTO sa_call VALUES (?,?,'running',?,'hash',NULL,NULL)").run(id,'demo',JSON.stringify(request))
 mkdirSync(join(directory,'control',id),{recursive:true})
 const frame=JSON.stringify({method:'item/agentMessage/delta',params:{delta:'合成实时回复'}})+'\n'
 writeFileSync(file,frame+'{"method":')
 const first=await (await call('/api/harness/events?project=demo&call='+id)).json()
 expect(first.events[0].params.delta).toBe('合成实时回复');expect(first.offset).toBe(Buffer.byteLength(frame))
 writeFileSync(file,frame+JSON.stringify({method:'turn/completed',params:{}})+'\n')
 const second=await (await call('/api/harness/events?project=demo&call='+id+'&offset='+first.offset)).json()
 expect(second.events).toHaveLength(1);expect(second.events[0].method).toBe('turn/completed')
})
it('accepts original DSH bodyless actions and JSON charset, but rejects non-JSON payloads',async()=>{
 const {app,url,runtime}=await start()
 const ticket=runtime.submit('bodyless-stop',{repo_id:'repo-a',worker_role:'Fixture',objective:'Synthetic stop test',permission:'read-only',inputs:[{path:'a.md',sha256:'a'.repeat(64)}]})
 runtime.store.db.prepare('INSERT INTO sa_ticket VALUES (?,?,?,?)').run(ticket,'demo','a','bodyless-stop')
 const headers={authorization:'Bearer '+app.token,'x-orchestrator-request':'1'}
 const endpoint=new URL('/orchestrator/api/tickets/'+ticket+'/stop',url)
 const bad=await fetch(endpoint,{method:'POST',headers:{...headers,'content-type':'text/plain'},body:'{}'})
 expect(bad.status).toBe(400);expect(runtime.store.tickets.get(ticket).ended).toBeUndefined()
 expect((await fetch(endpoint,{method:'POST',headers:{...headers,origin:'https://attacker.invalid'}})).status).toBe(403)
 const result=await fetch(endpoint,{method:'POST',headers});expect(result.status).toBe(200);expect(runtime.store.tickets.get(ticket).ended.by).toBe('human')
 const pause=await fetch(new URL('/orchestrator/api/executor/pause',url),{method:'POST',headers:{...headers,'content-type':'application/json; charset=utf-8'},body:'{"paused":true}'})
 expect(pause.status).toBe(200);expect(runtime.store.get('sa.paused')).toBe(true)
})
it('guards native dialogs with authentication and origin checks and handles cancellation',async()=>{
 let calls=0,cancelled=false
 const {call}=await start({folderPicker:{pick:async()=>{calls++;return {cancelled:true,path:null}},cancel(){cancelled=true}}})
 expect((await call('/api/folders/pick',{}, {authorization:''})).status).toBe(403)
 expect((await call('/api/folders/pick',{}, {origin:'https://attacker.invalid'})).status).toBe(403)
 expect(calls).toBe(0);expect(await (await call('/api/folders/pick',{})).json()).toEqual({cancelled:true,path:null});expect(calls).toBe(1)
 await call('/api/shutdown',{});expect(cancelled).toBe(true)
})
it('keeps the HTTP service alive when heartbeat replacement is denied',async()=>{
 const {call}=await start({writeMonitor:async()=>{throw Object.assign(Error('sharing violation'),{code:'EPERM'})}})
 const response=await call('/api/status');expect(response.status).toBe(200);expect((await response.json()).last_error).toContain('Monitor input:')
})
it('protects local API with a per-start token and rejects cross-origin writes',async()=>{
  const {call}=await start()
  expect((await call('/api/status',undefined,{authorization:''})).status).toBe(403)
  expect((await call('/api/message',{project:'demo',text:'x'},{origin:'https://attacker.invalid'})).status).toBe(403)
  expect((await call('/api/status')).status).toBe(200)
})
it('accepts new messages while dispatch is paused and deduplicates browser retries',async()=>{
  const {call,agent}=await start();expect((await call('/api/pause',{paused:true})).ok).toBe(true)
  const message={id:'once',project:'demo',text:'Check A'};await call('/api/message',message);await call('/api/message',message)
  expect(agent.status().messages).toHaveLength(1);expect(agent.status().paused).toBe(true)
})
it('serves a local static UI with CSP and refuses invalid budgets/unknown routes',async()=>{
  const {call}=await start(),html=await call('/')
  expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(await html.text()).toContain('Codex Superagent')
  expect((await call('/api/budgets',{worker:-1,router:1,watchdog:1})).status).toBe(400)
  expect((await call('/api/unknown',{})).status).toBe(404)
})
it.each([true,false])('confirms shutdown after saving records and preserves pause=%s',async paused=>{
  const {call,directory,runtime}=await start()
  runtime.store.db.prepare("INSERT INTO sa_job (id,state) VALUES ('queued-fixture','queued')").run()
  await call('/api/pause',{paused});await call('/api/message',{id:'saved',project:'demo',text:'Keep my request'})
  expect(await (await call('/api/shutdown',{mode:'now'})).json()).toMatchObject({stopped:true,attention:0})
  expect(JSON.parse(readFileSync(join(directory,'shutdown.json'),'utf8'))).toMatchObject({state:'stopped',paused})
  const reopened=new DurableRuntime({directory:join(directory,'runtime'),transport:{}})
  try{expect(reopened.store.get('sa.paused')).toBe(paused);expect(reopened.store.db.prepare('SELECT id FROM sa_message').all()).toHaveLength(1);expect(reopened.store.db.prepare('SELECT state FROM sa_job').get().state).toBe('queued')}finally{await reopened.close()}
})
it('drains current work, blocks new submissions, and can escalate to cancellation',async()=>{
  const {app,call,agent,jobs,watchdog}=await start()
  let finish,cancelled=0;const pending=new Promise<void>(done=>{finish=done})
  agent.workersOnce=async()=>{};agent.routerOnce=async()=>{};watchdog.once=async()=>{}
  jobs.pump=()=>{};jobs.running.set('active-test',pending);jobs.cancelRunning=()=>{cancelled++;finish();jobs.running.delete('active-test')}
  const waiting=call('/api/shutdown',{mode:'drain'})
  for(let i=0;i<100&&app.lifecycle().state!=='draining';i++)await new Promise(done=>setTimeout(done,10))
  expect(app.lifecycle()).toMatchObject({state:'draining',active:{jobs:1}});expect(cancelled).toBe(0)
  expect((await call('/api/message',{id:'late',project:'demo',text:'Too late'})).status).toBe(409)
  const immediate=call('/api/shutdown',{mode:'now'})
  expect(await (await immediate).json()).toMatchObject({stopped:true})
  expect(await (await waiting).json()).toMatchObject({stopped:true});expect(cancelled).toBe(1)
})
it('waits for natural completion without cancelling when draining',async()=>{
  const {app,call,jobs}=await start();let finish,cancelled=false
  const pending=new Promise<void>(done=>{finish=done});jobs.running.set('active-test',pending);jobs.cancelRunning=()=>{cancelled=true}
  const waiting=call('/api/shutdown',{mode:'drain'})
  for(let i=0;i<100&&app.lifecycle().state!=='draining';i++)await new Promise(done=>setTimeout(done,10))
  expect(app.lifecycle().state).toBe('draining');finish();jobs.running.delete('active-test')
  expect(await (await waiting).json()).toMatchObject({stopped:true});expect(cancelled).toBe(false)
})
