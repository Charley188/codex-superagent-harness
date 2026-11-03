import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { DurableRuntime } from '../src/durable-runtime.mjs'
import { Superagent } from '../framework/superagent.mjs'
import { Jobs } from '../framework/jobs.mjs'
import { Watchdog } from '../framework/watchdog.mjs'
const areas=[], hosts=[]
const projects=[{id:'demo',capabilities:[{id:'a',repo_id:'repo-a',description:'A',inputs:[{path:'a.md',sha256:'a'.repeat(64)}]},
{id:'b',repo_id:'repo-b',description:'B',inputs:[{path:'b.md',sha256:'b'.repeat(64)}]}],jobs:[{id:'build',argv:['python','--version'],timeout_seconds:10,artifacts:[]}]}]
function action(kind='accept', extra={}) {return {kind,trigger_id:'human',ticket_id:null,key:null,capability_id:'a',title:'Check A',role:'Analyst',worktree_name:'check-a',acknowledgement:'I will check the input.',note:null,reason:null,depends_on:[],job_profile:null,...extra}}
function answer(r,d,actions=[]) {return {request_id:r.request_id,request_hash:d,session_id:r.session_id??randomUUID(),status:'completed',output:{request_id:r.request_id,snapshot_hash:r.snapshot_hash,reply:'已处理',actions}}}
function setup(fn=(r,d)=>answer(r,d,[action()]), directory=null) {
  const dir=directory??mkdtempSync(join(tmpdir(),'sa-')); if(!directory)areas.push(dir)
  const worker={calls:[],cancel(){},result:async()=>null,async execute(r,d){this.calls.push(r);return {ticket_id:r.ticket_id,assignment_id:r.assignment_id,turn_id:r.turn_id,request_hash:d,session_id:r.session_id??randomUUID(),status:'completed',report:{task_id:r.ticket_id,attempt_id:r.turn_id,summary:'Fixture result'}}}}
  const control={calls:[],receipts:new Map(),result:async id=>control.receipts.get(id),async execute(r,d){control.calls.push(r); const v=await fn(r,d);control.receipts.set(r.request_id,v);return v}}
  const runtime=new DurableRuntime({directory:dir,transport:worker});hosts.push(runtime)
  const agent=new Superagent(runtime,control,projects)
  return {agent,runtime,worker,control,dir}
}
afterEach(async()=>{for(const h of hosts.splice(0))await h.close();for(const d of areas.splice(0))rmSync(d,{recursive:true,force:true})})
it('forks only a proven pre-turn writer conflict and preserves pending messages and old session history',async()=>{
 let calls=0
 const {agent,runtime}=setup((r,d)=>{if(calls++===0)return {...answer(r,d),status:'failed',session_id:null,failure_code:'session_in_use',failed_before_turn:true};return answer(r,d,[])})
 const old=randomUUID();agent.store.set('sa.session.demo',old);agent.receive({id:'human',project:'demo',text:'Continue existing task'})
 expect(await agent.routerOnce()).toBe('reconciled');expect(agent.store.get('sa.session.demo')).toBeUndefined()
 expect(agent.store.db.prepare("SELECT processed FROM sa_message WHERE id='human'").get().processed).toBe(0)
 expect(await agent.routerOnce()).toBe('applied');expect(agent.store.get('sa.session.demo')).not.toBe(old)
 expect(runtime.turns()).toHaveLength(0)
})
it('keeps queue identity when a tool body contains its own id, then routes the next project',async()=>{
  const {agent,control}=setup((r,d)=>answer(r,d,[]))
  agent.projects.push({...projects[0],id:'other'})
  agent.message('queue-job-id','demo','job',{id:'business-job-id',origin:'user',text:'Completed synthetic job'})
  agent.receive({id:'next-project-request',project:'other',text:'New project goal'})
  expect(await agent.routerOnce()).toBe('applied')
  expect(control.calls[0].context.messages[0].id).toBe('queue-job-id')
  expect(control.calls[0].context.messages[0].origin).toBe('job')
  expect(agent.store.db.prepare("SELECT processed FROM sa_message WHERE id='queue-job-id'").get().processed).toBe(1)
  expect(await agent.routerOnce()).toBe('applied')
  expect(control.calls[1].context.project).toBe('other')
})
it('routes a real upstream ticket and relays a result exactly once',async()=>{
  const {agent,runtime,worker}=setup();agent.receive({id:'human',project:'demo',text:'Check A'});expect(await agent.routerOnce()).toBe('applied')
  await agent.workersOnce();agent.relayResults();expect(worker.calls).toHaveLength(1)
  expect(agent.status().messages.filter(m=>m.origin==='worker')).toHaveLength(1)
  expect(runtime.store.db.prepare('SELECT state FROM codex_review').get().state).toBe('pending')
})
it('delivers a human follow-up to its subscribed worker without replacing its session',async()=>{
  const {agent,runtime,worker,control}=setup((r,d)=>answer(r,d,r.context.messages.some(m=>m.id==='human')?[action()]:[]))
  agent.receive({id:'human',project:'demo',text:'Check A'});await agent.routerOnce();await agent.workersOnce()
  const ticket=agent.tickets('demo')[0].ticket_id
  agent.receive({id:'followup',project:'demo',ticket_id:ticket,text:'Explain this finding'});await agent.routerOnce();await agent.workersOnce()
  expect(worker.calls).toHaveLength(2);expect(worker.calls[1].session_id).toBe(runtime.turns()[0].result.session_id)
  expect(control.calls[1].context.messages.find(m=>m.id==='followup').owned_by_workers).toHaveLength(1)
})
it('enforces project scopes and unique intake identity',()=>{
  const {agent}=setup();agent.receive({id:'human',project:'demo',text:'A'})
  expect(()=>agent.receive({id:'human',project:'demo',text:'B'})).toThrow('collision')
  expect(()=>agent.receive({project:'demo',ticket_id:'other',text:'B'})).toThrow('scope')
})
it('keeps successful batch actions when another original routing action is refused',async()=>{
  const {agent}=setup((r,d)=>answer(r,d,[action('accept',{worktree_name:null}),action('accept')]))
  agent.receive({id:'human',project:'demo',text:'A'});expect(await agent.routerOnce()).toBe('applied');expect(agent.tickets('demo')).toHaveLength(1)
  expect(agent.status().messages.some(m=>m.origin==='system')).toBe(true)
})
it('delegates a dependency graph and sends the provisional upstream result',async()=>{
  const {agent,worker}=setup((r,d)=>answer(r,d,[action('delegate',{key:'a'}),action('delegate',{key:'b',capability_id:'b',depends_on:['a'],title:'Check B',worktree_name:'check-b'})]))
  agent.receive({id:'human',project:'demo',text:'Check A then B'});expect(await agent.routerOnce()).toBe('applied')
  const [a,b]=agent.tickets('demo');expect(agent.dependenciesReady(b.ticket_id)).toBe(false)
  await agent.workersOnce();expect(agent.dependenciesReady(b.ticket_id)).toBe(true)
  // Effects' original retry deadline is 2 seconds; explicit delivery here only exercises the now-ready dependency.
  await agent.runtime.deliver(b.ticket_id);expect(worker.calls).toHaveLength(2);expect(JSON.stringify(worker.calls[1].inputs)).toContain('PEER_RESULT')
})
it('rejects cyclic delegation without admitting any task',async()=>{
  const {agent}=setup((r,d)=>answer(r,d,[action('delegate',{key:'a',depends_on:['b']}),action('delegate',{key:'b',depends_on:['a']})]))
  agent.receive({id:'human',project:'demo',text:'A'});expect(await agent.routerOnce()).toBe('invalid');expect(agent.tickets('demo')).toEqual([])
})
it('discards a Router plan when its observed task state changed while reasoning',async()=>{
  const {agent}=setup((r,d)=>{agent.store.db.prepare('UPDATE sa_message SET processed=processed').run();agent.fingerprint=()=> 'changed';return answer(r,d,[action()])})
  agent.receive({id:'human',project:'demo',text:'A'});expect(await agent.routerOnce()).toBe('stale');expect(agent.tickets('demo')).toEqual([])
})
it('recovers a control receipt after interruption without another external execution',async()=>{
  const {agent,control}=setup((r,d)=>{control.receipts.set(r.request_id,answer(r,d,[action()]));throw new Error('lost callback')})
  agent.receive({id:'human',project:'demo',text:'A'});expect(await agent.routerOnce()).toBe('uncertain');await agent.recoverRouter()
  expect(agent.tickets('demo')).toHaveLength(1);expect(control.calls).toHaveLength(1)
})
it('does not re-execute an uncertain control call; evidence is required to clear it',async()=>{
  const {agent,control}=setup(()=>{throw new Error('unknown')});agent.receive({id:'human',project:'demo',text:'A'});await agent.routerOnce();await agent.routerOnce()
  expect(control.calls).toHaveLength(1);expect(()=>agent.clearControl(control.calls[0].request_id,{})).toThrow('evidence')
})
it('separates tool job completion from worker completion and fences acceptance',async()=>{
  const {agent,dir}=setup();agent.receive({id:'human',project:'demo',text:'A'});await agent.routerOnce();await agent.workersOnce()
  const t=agent.tickets('demo')[0];let done
  const jobs=new Jobs(agent,join(dir,'jobs'),{launch:async(folder,encoded)=>new Promise(resolve=>{const r=JSON.parse(encoded);done=()=>resolve({id:r.id,request_hash:hash(encoded),status:'completed',artifacts:[]})})})
  const one=jobs.enqueue('demo',t.ticket_id,'build','call');expect(jobs.enqueue('demo',t.ticket_id,'build','call')).toEqual(one)
  jobs.pump();expect(()=>agent.review('demo',t.ticket_id,t.turn_id,true)).toThrow('active jobs');done();await Promise.all(jobs.running.values())
  expect(agent.status().messages.filter(m=>m.origin==='job')).toHaveLength(1)
})
import {hash} from '../src/durable-runtime.mjs'
it('Watchdog directs a bounded correction through Router only once per current turn',async()=>{
  const {agent}=setup();agent.receive({id:'human',project:'demo',text:'A'});await agent.routerOnce();await agent.workersOnce()
  const t=agent.tickets('demo')[0], control={result:async()=>null,execute:async(r,d)=>({...answer(r,d),output:{request_id:r.request_id,snapshot_hash:r.snapshot_hash,assessment:'Review direction',concerns:[{ticket_id:t.ticket_id,turn_id:t.turn_id,kind:'drift',evidence:'Fixture result does not answer A',action:'suggest_correction',instruction:'Address A'}]}})}
  const watch=new Watchdog(agent,control);await watch.once(true);await watch.once(true)
  expect(agent.status().messages.filter(m=>m.origin==='watchdog')).toHaveLength(1)
  expect(agent.runtime.turns()).toHaveLength(1)
})
it('refuses Watchdog evidence for an unknown turn',async()=>{
  const {agent}=setup();agent.receive({id:'human',project:'demo',text:'A'});await agent.routerOnce();await agent.workersOnce()
  const control={result:async()=>null,execute:async(r,d)=>({...answer(r,d),output:{request_id:r.request_id,snapshot_hash:r.snapshot_hash,assessment:'wrong',concerns:[{ticket_id:agent.tickets('demo')[0].ticket_id,turn_id:'wrong',kind:'drift',evidence:'x',action:'suggest_correction',instruction:'x'}]}})}
  expect(await new Watchdog(agent,control).once(true)).toBe('invalid');expect(agent.status().messages.filter(m=>m.origin==='watchdog')).toEqual([])
})
it('routes bounded peer messages once and rejects unknown project recipients',async()=>{
  const {agent,runtime,worker}=setup((r,d)=>answer(r,d,[action('delegate',{key:'a'}),action('delegate',{key:'b',capability_id:'b',title:'B',worktree_name:'b'})]))
  agent.receive({id:'human',project:'demo',text:'A and B'});await agent.routerOnce()
  const [a,b]=agent.tickets('demo'),original=worker.execute.bind(worker)
  worker.execute=async(r,d)=>({...await original(r,d),messages:r.ticket_id===a.ticket_id?[{ticket_id:b.ticket_id,text:'PEER_FACT'},{ticket_id:'foreign',text:'outside'}]:[]})
  await agent.workersOnce();agent.relayResults()
  expect(runtime.store.db.prepare('SELECT * FROM sa_peer').all()).toHaveLength(1)
  expect(JSON.stringify(runtime.store.tickets.get(b.ticket_id).inputs)).toContain('PEER_FACT')
})
it('permits evidence-driven follow-on delegation within an existing human goal',async()=>{
  const {agent,control}=setup((r,d)=>answer(r,d,control.calls.length===1?[action()]:[action('delegate',{key:'follow',capability_id:'b',title:'Independent follow-on',worktree_name:'follow'})]))
  agent.receive({id:'human',project:'demo',text:'Complete A with any necessary independent verification'});await agent.routerOnce();await agent.workersOnce()
  expect(await agent.routerOnce()).toBe('applied');expect(agent.tickets('demo')).toHaveLength(2)
})
it('does not delegate after all tasks under the goal were explicitly stopped',async()=>{
  const {agent,control}=setup((r,d)=>answer(r,d,control.calls.length===1?[action()]:[action('delegate',{key:'later',title:'New scope',worktree_name:'later'})]))
  agent.receive({id:'human',project:'demo',text:'A'});await agent.routerOnce();const ticket=agent.tickets('demo')[0].ticket_id
  agent.stop(ticket,'demo');agent.message('trigger-report','demo','worker',{text:'Try more work'})
  expect(await agent.routerOnce()).toBe('invalid');expect(agent.tickets('demo')).toHaveLength(1)
})
it('refuses tool jobs before a worker has produced its first output',async()=>{
  const {agent,dir}=setup();agent.receive({id:'human',project:'demo',text:'A'});await agent.routerOnce()
  const jobs=new Jobs(agent,join(dir,'jobs'));expect(()=>jobs.enqueue('demo',agent.tickets('demo')[0].ticket_id,'build','early')).toThrow('Wait for the worker')
})
it.each(['failed','cancelled'])('retries only explicitly after confirmed %s, with a new assignment and preserved history',async state=>{
  const {agent,runtime,worker}=setup();const original=worker.execute.bind(worker)
  worker.execute=async(r,d)=>({...await original(r,d),status:state,error:'Synthetic interruption'})
  agent.receive({id:'human',project:'demo',text:'A'});await agent.routerOnce();await agent.workersOnce()
  const ticket=agent.tickets('demo')[0].ticket_id,failed=runtime.turns()[0]
  worker.execute=original;agent.retry('demo',ticket);await agent.workersOnce()
  expect(runtime.turns()).toHaveLength(2);expect(runtime.turns()[1].state).toBe('completed');expect(runtime.turns()[1].assignment_id).not.toBe(failed.assignment_id)
  expect(()=>agent.retry('demo',ticket)).toThrow('confirmed failed')
})
