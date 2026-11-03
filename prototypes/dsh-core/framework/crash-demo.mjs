import { spawn,spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync,readFileSync,writeFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import {initialize,openRuntime,base} from './bootstrap.mjs'
const [stage,dir]=process.argv.slice(2),wait=ms=>new Promise(r=>setTimeout(r,ms))
if(stage==='child'){
  const worker={result:async()=>null,cancel(){},async execute(r,d){return {ticket_id:r.ticket_id,assignment_id:r.assignment_id,turn_id:r.turn_id,request_hash:d,status:'completed',session_id:randomUUID(),report:{task_id:r.ticket_id,attempt_id:r.turn_id,summary:'Synthetic infrastructure fixture'}}}}
  const host=openRuntime(dir,{worker}),ticket=host.runtime.submit('crash',{repo_id:'synthetic-fixture',worker_role:'test',objective:'Synthetic crash fixture',permission:'read-only',inputs:[{path:'parallel-a.md',sha256:'a'.repeat(64)}]})
  host.runtime.store.db.prepare('INSERT INTO sa_ticket VALUES (?,?,?,?)').run(ticket,'synthetic','evidence-a','crash')
  await host.runtime.run()
  const {job}=host.jobs.enqueue('synthetic',ticket,'crash','crash');host.jobs.pump()
  const folder=host.jobs.folder(job)
  while(!existsSync(join(folder,'output/child-pid.txt')))await wait(100)
  writeFileSync(join(dir,'crash-evidence.json'),JSON.stringify({job,pid:process.pid,at:Date.now(),process:JSON.parse(readFileSync(join(folder,'process.json'),'utf8')),child_pid:Number(readFileSync(join(folder,'output/child-pid.txt'),'utf8'))}))
  process.exit(73)
}else{
  const directory=join(base,'state/dsh-core/crash-e2e',randomUUID());initialize(directory)
  const path=join(directory,'projects.json'),config=JSON.parse(readFileSync(path,'utf8'))
  config.projects[0].jobs.push({id:'crash',description:'Synthetic process-tree fixture',argv:['python','-B','-c',"import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)']);Path('child-pid.txt').write_text(str(p.pid));time.sleep(120)"],timeout_seconds:120,artifacts:[]})
  writeFileSync(path,JSON.stringify(config))
  const code=await new Promise((done,reject)=>{const child=spawn(process.execPath,['--experimental-transform-types',fileURLToPath(import.meta.url),'child',directory],{windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',done)})
  assert.equal(code,73)
  const evidence=JSON.parse(readFileSync(join(directory,'crash-evidence.json'),'utf8')),host=openRuntime(directory)
  try{
    host.jobs.recover();assert.equal(host.jobs.rows()[0].state,'uncertain')
    const deadline=Date.now()+30000
    while(!existsSync(join(host.jobs.folder(evidence.job),'result.json'))&&Date.now()<deadline)await wait(300)
    host.jobs.recover();let row=host.jobs.rows()[0]
    // Some Windows parent job lifetimes terminate the helper too; absence of a receipt must remain quarantined.
    const probe=spawnSync('python',['-B','-c',"import sys,json;sys.path.insert(0,sys.argv[1]);from test_framework import alive;print(json.dumps([alive(int(x)) for x in sys.argv[2:]]))",fileURLToPath(new URL('../tests/',import.meta.url)),String(evidence.process.pid),String(evidence.child_pid)],{encoding:'utf8',windowsHide:true})
    assert.equal(probe.status,0,probe.stderr);assert.deepEqual(JSON.parse(probe.stdout),[false,false])
    const hadReceipt=!!row.result
    if(!hadReceipt){assert.equal(row.state,'uncertain');host.jobs.reconcileStopped(row.id,{confirmedStopped:true,evidence:'Synthetic crash acceptance: OS confirmed both recorded owned process IDs exited; no new execution launched.'});row=host.jobs.rows()[0]}
    const result=JSON.parse(row.result);assert.equal(row.state,'failed');assert.equal(host.jobs.rows().length,1)
    const report={status:'passed',directory,actual_host_exit_during_job:true,exit_code:73,held_until_receipt_or_verified_stop:true,owned_parent_and_child_exited:true,terminal_receipt_survived:hadReceipt,no_relaunch:true,evidence,result}
    writeFileSync(join(directory,'validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
  }finally{await host.runtime.close()}
}
