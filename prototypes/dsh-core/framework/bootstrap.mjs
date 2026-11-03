import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DurableRuntime, hash } from '../src/durable-runtime.mjs'
import { PythonTransport } from '../src/python-transport.mjs'
import { ModelTransport } from './transport.mjs'
import { Superagent } from './superagent.mjs'
import { Jobs } from './jobs.mjs'
import { Watchdog } from './watchdog.mjs'
import { latestAssignment } from '../vendor/dsh/src/core/index.ts'
import { require } from './contracts.mjs'
import {executionSettings} from './execution-settings.mjs'
export const base=fileURLToPath(new URL('../../../',import.meta.url))
export const defaultDirectory=join(base,'state/dsh-core/framework-local')
export function ownedDirectory(directory) {
  const path=resolve(directory), rel=relative(join(base,'state/dsh-core'),path)
  require(rel && !rel.startsWith('..') && !isAbsolute(rel),'Runtime must be below state/dsh-core');return path
}
export function syntheticConfig() {
  const input=(dir,path)=>[{path,sha256:hash(readFileSync(join(base,'state/fixtures',dir,path)))}]
  return {version:1,capacity:2,worker_budget:20,router_budget:24,watchdog_budget:8,projects:[{
    id:'synthetic',description:'合成验收项目：可审阅、生成隔离代码和运行登记测试',capabilities:[
      {id:'evidence-a',repo_id:'synthetic-fixture',description:'审阅合成材料 A（标记和计数）',permission:'read-only',inputs:input('synthetic-review','parallel-a.md')},
      {id:'evidence-b',repo_id:'synthetic-paper',description:'独立审阅合成论文 B 的证据与结论',permission:'read-only',inputs:input('synthetic-paper','parallel-b.md')},
      {id:'implement',repo_id:'synthetic-fixture',description:'生成代码与测试文件到独立工作区；工具验证用 python-tests 作业',permission:'artifact-write',inputs:input('synthetic-review','parallel-a.md')}
    ],jobs:[{id:'python-tests',description:'在本任务隔离工作区运行 Python unittest，并产出独立检查报告',argv:['python','-B',fileURLToPath(new URL('./test_job.py',import.meta.url)),'{workspace}','{output}'],timeout_seconds:60,artifacts:['verification.json']}]
  }]}
}
export function initialize(directory) {
  directory=ownedDirectory(directory);mkdirSync(directory,{recursive:true})
  const path=join(directory,'projects.json');require(!existsSync(path),'Already initialized')
  writeFileSync(path,JSON.stringify(syntheticConfig(),null,2)+'\n',{flag:'wx'});return directory
}
export function openRuntime(directory=defaultDirectory, overrides={}) {
  directory=ownedDirectory(directory)
  const config=JSON.parse(readFileSync(join(directory,'projects.json'),'utf8'))
  require(config.version===1 && Number.isInteger(config.router_budget) && config.router_budget>=0 && config.router_budget<=100,'Invalid framework config')
  const transport=overrides.worker??new PythonTransport(join(directory,'turns'),{helper:new URL('./execution_worker.py',import.meta.url)})
  const control=overrides.control??new ModelTransport(join(directory,'control'))
  const runtime=new DurableRuntime({directory:join(directory,'runtime'),transport,capacity:config.capacity,maxTurns:config.worker_budget})
  try {
    const agent=new Superagent(runtime,control,config.projects,{controlBudget:config.router_budget})
    agent.hostDirectory=directory
    agent.prompts.directory=directory
    // Every task writes only its isolated assignment workspace; original source paths remain snapshots.
    runtime.resourceKey=(ticket,contract)=>contract.repo_id+':'+ticket.id
    const enrichRequest=runtime.enrichRequest
    runtime.enrichRequest=request=>{
      enrichRequest?.(request)
      request.worker_timeout_seconds=executionSettings(runtime.store,runtime.capacity).workerTimeoutSeconds
      const scope=runtime.store.db.prepare('SELECT project FROM sa_ticket WHERE ticket_id=?').get(request.ticket_id)
      request.collaborators=scope?agent.tickets(scope.project).filter(t=>t.ticket_id!==request.ticket_id&&!t.ended).slice(-16).map(t=>({ticket_id:t.ticket_id,title:t.title})):[]
    }
    agent.workspace=ticket=>join(directory,'workspaces',latestAssignment(runtime.store.tickets.get(ticket)).id)
    const jobs=new Jobs(agent,join(directory,'jobs'))
    const watchdog=new Watchdog(agent,control,{budget:config.watchdog_budget})
    for(const [object,property,key] of [[runtime,'remaining','worker'],[agent,'controlBudget','router'],[watchdog,'budget','watchdog']]) {
      if(runtime.store.get('budget.'+key)===undefined)runtime.store.set('budget.'+key,object[property])
      Object.defineProperty(object,property,{get:()=>runtime.store.get('budget.'+key),set:value=>runtime.store.set('budget.'+key,value)})
    }
    return {directory,config,runtime,agent,jobs,watchdog,control}
  } catch (error) {runtime.store.close();runtime.guard.close();throw error}
}
