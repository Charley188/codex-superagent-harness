// Synthetic desktop/browser acceptance fixture; never starts a model or reads project input.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DurableRuntime } from '../prototypes/dsh-core/src/durable-runtime.mjs'
import { Superagent } from '../prototypes/dsh-core/framework/superagent.mjs'
import { Jobs } from '../prototypes/dsh-core/framework/jobs.mjs'
import { Watchdog } from '../prototypes/dsh-core/framework/watchdog.mjs'
import { serve } from '../prototypes/dsh-core/framework/server.mjs'
import {createFolderPicker} from '../prototypes/dsh-core/framework/folder-picker.mjs'
import {latestAssignment} from '../prototypes/dsh-core/vendor/dsh/src/core/index.ts'
const directory=fileURLToPath(new URL('../state/desktop/ui-tests/'+randomUUID()+'/',import.meta.url))
mkdirSync(directory,{recursive:true})
const control={cancel(){},result:async()=>null,execute:async()=>{throw Error('No model call allowed')}}
const runtime=new DurableRuntime({directory:join(directory,'runtime'),transport:control})
const agent=new Superagent(runtime,control,[{id:'ui-test',description:'退出流程验证（合成数据）',capabilities:[{id:'fixture',repo_id:'fixture',inputs:[{path:'fixture.md',sha256:'a'.repeat(64)}]}]}])
const jobs=new Jobs(agent,join(directory,'jobs')),watchdog=new Watchdog(agent,control)
// An explicit synthetic failed ticket exercises the real upstream Stop confirmation flow.
for(const [event,objective] of [['ui-stop-fixture','合成停止操作验证'],['ui-retry-fixture','合成重试操作验证']]){
const ticket=runtime.submit(event,{repo_id:'fixture',worker_role:objective,objective,permission:'read-only',inputs:[{path:'fixture.md',sha256:'a'.repeat(64)}]})
runtime.store.db.prepare('INSERT INTO sa_ticket VALUES (?,?,?,?)').run(ticket,'ui-test','fixture',event)
const assignment=latestAssignment(runtime.store.tickets.get(ticket)),turn=randomUUID()
runtime.engine.assignmentStarted(ticket,assignment.id)
runtime.store.db.prepare('INSERT INTO codex_turn VALUES (?,?,?,?,?,?,?,?,?,?)').run(turn,ticket,assignment.id,'fixture','failed','f'.repeat(64),JSON.stringify({turn_id:turn,ticket_id:ticket,assignment_id:assignment.id}),JSON.stringify({status:'failed',error:'Synthetic failed turn'}),null,new Date().toISOString())
runtime.store.db.prepare('UPDATE codex_binding SET current_turn=? WHERE assignment_id=?').run(turn,assignment.id)
runtime.engine.report(ticket,{state:'failed',summary:'Synthetic failed turn'});runtime.engine.turnEnded(ticket,assignment.id)
}
let finish
jobs.running.set('synthetic-pending',new Promise(done=>{finish=done}))
jobs.cancelRunning=()=>{jobs.running.delete('synthetic-pending');finish()}
let selections=0
const folderPicker=process.env.SA_TEST_PICK_FOLDER?createFolderPicker({choose:async()=>{await new Promise(r=>setTimeout(r,80));return selections++===0?{cancelled:true,path:null}:{cancelled:false,path:process.env.SA_TEST_PICK_FOLDER}}}):undefined
const app=await serve({directory,runtime,agent,jobs,watchdog,control},{pump:false,monitor:false,...folderPicker?{folderPicker}:{}})
console.log(directory)
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close())
