import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { initialize, openRuntime, base } from './bootstrap.mjs'
import {sourceFingerprint} from './release.mjs'
import {panelApi} from './panel-api.mjs'
const fingerprint=sourceFingerprint()
const directory=join(base,'state/dsh-core/framework-e2e',randomUUID())
const projectFolder=mkdtempSync(join(process.env.LOCALAPPDATA,'Temp','sa-project-live-'))
initialize(directory);let host=openRuntime(directory),active=0,peak=0
panelApi(host)('PUT','codex/runtime',new URLSearchParams(),{revision:0,value:{maxWorkers:4}})
const log=value=>console.log(JSON.stringify(value))
log({directory})
try {
  const original=host.runtime.transport.execute.bind(host.runtime.transport)
  host.runtime.transport.execute=async(...args)=>{active++;peak=Math.max(peak,active);try{return await original(...args)}finally{active--}}
  const {agent,jobs,watchdog}=host
  const sharedPart=agent.prompts.view().parts.find(p=>p.key==='runtime/shared')
  agent.prompts.save({...agent.prompts.current().config,overrides:{'runtime/shared':{text:sharedPart.text+'\nSynthetic settings acceptance: include SETTINGS_PROMPT_52 in every nonempty Router reply and every Worker report summary.',base:sharedPart.base}}},0)
  agent.receive({id:'parallel-review',project:'synthetic',text:'纯合成框架并发验收，请明确建立四个独立、无依赖、可并行的 Worker，每个标题不同：1用 evidence-a 核查材料A标记；2用 evidence-a 独立核查材料A计数；3用 evidence-b 核查材料B实际提供的证据；4用 evidence-b 独立核查材料B结论的限制。四项分别报告，不要合并成两个任务。不要使用 implement，不要工具作业，暂不传递彼此结果。随后由你汇总。'})
  assert.equal(await agent.routerOnce(),'applied');assert.equal(agent.tickets('synthetic').length,4);log({stage:'router-delegated',tickets:4})
  await agent.workersOnce();assert.equal(host.runtime.turns().length,4);assert.ok(host.runtime.turns().every(t=>t.state==='completed'),JSON.stringify(host.runtime.turns().map(t=>({state:t.state,error:t.error,result:t.result}))))
  assert.equal(peak,4);assert.equal(await agent.routerOnce(),'applied');log({stage:'parallel-workers',peak})
  assert(host.runtime.turns().every(t=>t.result.report.summary.includes('SETTINGS_PROMPT_52')),'Configured Worker prompt did not reach real turns')
  for(const section of ['communication','scope','delivery']){
    const expected=agent.prompts.current().config[section];assert(expected.trim().length>500)
    assert(host.runtime.turns().every(t=>t.request.prompt.text.includes(expected)),'Team default missing from actual Worker request: '+section)
    const routerRequest=JSON.parse(agent.store.db.prepare('SELECT request FROM sa_call ORDER BY rowid LIMIT 1').get().request)
    assert(routerRequest.prompt.text.includes(expected),'Team default missing from actual Router request: '+section)
  }
  const firstReply=agent.status().messages.find(m=>m.origin==='router')?.body.text
  assert(firstReply?.includes('SETTINGS_PROMPT_52'),'Configured Router prompt did not reach real turn')
  const first=agent.tickets('synthetic')[0],prior=host.runtime.turns().find(t=>t.ticket_id===first.ticket_id)
  agent.receive({id:'followup-review',project:'synthetic',ticket_id:first.ticket_id,text:'在原任务基础上，用一句话解释最重要的限制。在摘要保留 FOLLOWUP_OK 标记。另外请通过结构化 messages 给列出的另一个材料 Worker 发送一条带 PEER_LIVE_FIXTURE 标记的合成事实：材料 A 计数为7，提醒只能作为合成文本证据；无需对方再发消息回复。不要新增 Worker。'})
  assert.equal(await agent.routerOnce(),'applied');await agent.workersOnce()
  const following=host.runtime.turns().filter(t=>t.ticket_id===first.ticket_id).at(-1)
  assert.equal(following.result.session_id,prior.result.session_id);assert.match(following.result.report.summary,/FOLLOWUP_OK/)
  assert.ok(host.runtime.store.db.prepare('SELECT 1 FROM sa_peer').get(),'No real worker peer message was delivered')
  await agent.workersOnce()
  assert.ok(host.runtime.turns().some(t=>JSON.stringify(t.request.inputs).includes('PEER_LIVE_FIXTURE')))
  await agent.routerOnce();log({stage:'same-session-followup-and-peer-message'})
  agent.receive({id:'implementation',project:'synthetic',text:'再单独建立一个实现任务，使用 implement 能力：生成 addition.py 的 add(a,b) 函数和 test_addition.py 的 unittest 测试（断言 2+3=5 和 -1+1=0）。这是纯合成测试，不修改原项目。生成结束后使用该任务登记的 python-tests 工具作业验证。向我汇报实际验证结果。'})
  assert.equal(await agent.routerOnce(),'applied');await agent.workersOnce()
  const implemented=host.runtime.turns().find(t=>t.request.contract.permission==='artifact-write')
  assert.equal(implemented?.state,'completed',JSON.stringify(implemented))
  assert.ok(implemented.result.artifacts.some(a=>a.path==='addition.py'));assert.ok(implemented.result.artifacts.some(a=>a.path==='test_addition.py'))
  log({stage:'generated-code',workspace:implemented.result.workspace})
  // The Router chooses the registered tool profile; no test-only job is silently injected.
  await agent.routerOnce();assert.ok(jobs.rows().some(j=>j.profile==='python-tests'),'Router did not enqueue requested registered test')
  jobs.pump();await Promise.all(jobs.running.values());assert.ok(jobs.rows().every(j=>j.state==='completed'),JSON.stringify(jobs.rows()))
  const job=jobs.rows().at(-1),verification=JSON.parse(readFileSync(join(directory,'jobs',job.id,'output/verification.json'),'utf8'))
  assert.equal(verification.passed,true);log({stage:'registered-tests-passed'})
  await agent.workersOnce();await agent.routerOnce();assert.equal(await watchdog.once(true),'applied');log({stage:'watchdog-reviewed-progress'})
  const watchRequest=JSON.parse(agent.store.db.prepare('SELECT request FROM sa_watch ORDER BY rowid DESC LIMIT 1').get().request)
  for(const section of ['communication','scope','delivery'])assert(watchRequest.prompt.text.includes(agent.prompts.current().config[section]),'Team default missing from actual Watchdog request: '+section)
  writeFileSync(join(projectFolder,'fixture.md'),'This is synthetic project material. Marker: NEW_WORKSPACE_73. Count: 73.\n')
  const created=agent.addProject({name:'合成页面项目执行验收',root:projectFolder})
  agent.receive({id:'workspace-project-goal',project:created.id,text:'请用 create 能力安排一个 Worker：读取工作文件夹的合成 fixture.md，生成 workspace-result.md，内容保留输入中的完整 NEW_WORKSPACE 标记和计数。只生成隔离交付文件，不运行工具，不增加其它任务。'})
  // Other projects can have older pending receipts; one router tick need not select this project.
  for(let tick=0;tick<4&&agent.store.db.prepare("SELECT processed FROM sa_message WHERE id='workspace-project-goal'").get().processed===0;tick++)assert.equal(await agent.routerOnce(),'applied')
  assert.equal(agent.store.db.prepare("SELECT processed FROM sa_message WHERE id='workspace-project-goal'").get().processed,1)
  await agent.workersOnce()
  const workspaceTurn=host.runtime.turns().find(t=>agent.tickets(created.id).some(x=>x.ticket_id===t.ticket_id))
  assert.equal(workspaceTurn?.state,'completed',JSON.stringify(workspaceTurn))
  assert.match(readFileSync(join(workspaceTurn.result.workspace,'workspace-result.md'),'utf8'),/NEW_WORKSPACE_73/)
  assert.equal(readFileSync(join(projectFolder,'fixture.md'),'utf8'),'This is synthetic project material. Marker: NEW_WORKSPACE_73. Count: 73.\n')
  log({stage:'ui-registered-project-worker-passed',project:created.id})
  const before=host.runtime.turns().map(t=>t.id),calls=host.runtime.store.db.prepare('SELECT count(*) n FROM sa_call').get().n
  await host.runtime.close();host=openRuntime(directory);await host.runtime.recover();await host.agent.recoverRouter()
  assert.equal(host.runtime.capacity,4,'Saved concurrency must survive a host restart without the panel')
  assert.deepEqual(host.runtime.turns().map(t=>t.id),before);assert.equal(host.runtime.store.db.prepare('SELECT count(*) n FROM sa_call').get().n,calls)
  assert.equal(host.agent.project(created.id).root,projectFolder)
  assert.equal(sourceFingerprint(),fingerprint,'Source changed during validation')
  const result={status:'passed',fingerprint,directory,peak_workers:peak,router_calls:calls,worker_turns:before.length,same_session_followup:true,
    peer_message_delivered:true,artifact_generation:true,independent_registered_tests:true,watchdog_semantic_call:true,reopened_without_reexecution:true,
    ui_registered_project_worker:true,custom_prompt_reached_router_and_worker:true,built_in_override_reached_router_and_worker:true,cli_workspace_write:'not certified; model session enforced read-only',private_inputs_used:false,
    source_integration:'Generated files stay in isolated workspace; no repository merge or deployment'}
  writeFileSync(join(directory,'validation.json'),JSON.stringify(result,null,2));log(result)
} catch(error) {
  writeFileSync(join(directory,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,status:host.agent.status()},null,2));throw error
} finally {await host.runtime.close();rmSync(projectFolder,{recursive:true,force:true})}
