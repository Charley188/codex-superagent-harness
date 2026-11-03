import { latestAssignment, ticketStage } from '../vendor/dsh/src/core/index.ts'
import { Versions } from '../vendor/dsh/src/app/versions.ts'
import { family } from '../vendor/dsh/src/kv.ts'
import { overview } from './panel-views/overview.ts'
import { ticketDetail, ticketRow, executorLoad } from './panel-views/tickets.ts'
import { threadList, threadDetail, decisionList, search } from './panel-views/threads.ts'
import { snapshot, page, newestFirst } from './panel-views/records.ts'
import { sourcesStatus } from './panel-views/sources.ts'
import { withSessions } from './panel-views/sessions.mjs'
import { require } from './contracts.mjs'
import { randomUUID } from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {LIMITS} from '../vendor/dsh/src/limits.ts'
import {DEFAULT_WORKER_TIMEOUT_SECONDS,validateWorkerTimeout} from './execution-settings.mjs'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const integer=(value,fallback,max)=>{const n=Number(value??fallback);require(Number.isInteger(n)&&n>=0&&n<=max,'Invalid page range');return n}
export function panelApi(host) {
  const {runtime,agent,directory}=host,store=runtime.store
  agent.hostDirectory=directory
  const versions=new Versions(store,'codex.panel.settings.revision',family('codex.panel.settings.version:'))
  const initial={maxWorkers:runtime.capacity,workerTimeoutSeconds:DEFAULT_WORKER_TIMEOUT_SECONDS}
  const settings=()=>{const current=versions.current()??{revision:0,value:initial,savedAt:null};return {...current,value:{...initial,...current.value}}}
  if(versions.current())runtime.capacity=settings().value.maxWorkers
  const title={zh:'本地对话',en:'Local conversation'}
  const sources={instances:()=>[{id:'local',kind:'local',installed:true,enabled:true,config:{}}],
    kind:id=>id==='local'?{title,health:['local']}:undefined,
    find:value=>({terms:[value],threads:store.threads.list().filter(t=>t.key.includes(value)).map(t=>t.key)})}
  // Read projection of actual local settings; never persist DSH's GitHub/Linux defaults.
  const projectedStore=new Proxy(store,{get(target,key){
    if(key==='settings')return ()=>{const s=store.settings();return {...s,paused:!!store.get('sa.paused'),
      policy:{...s.policy,rules:[],sources:{local:{allowed:[{id:'local-user',name:'本机用户'}],admission:{}}}},
      executor:{...s.executor,maxWorkers:runtime.capacity}}}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  const view={store:projectedStore,sources,links:channel=>({url:'',label:channel.thread??'',source:'local'})}
  const scope=id=>{const row=store.db.prepare('SELECT project FROM sa_ticket WHERE ticket_id=?').get(id);require(row,'Unknown local ticket');agent.owns(row.project,id);return row.project}
  const session=ticketId=>{
    const t=store.tickets.get(ticketId),a=t&&latestAssignment(t)
    return a&&runtime.binding(a.id)?.session_id||'worker:'+ticketId
  }
  const local=id=>{
    const project=scope(id),t=store.tickets.get(id),a=latestAssignment(t),b=a&&runtime.binding(a.id),turn=b?.current_turn&&runtime.turn(b.current_turn)
    const review=turn&&store.db.prepare('SELECT state FROM codex_review WHERE turn_id=?').get(turn.id)?.state
    const jobs=agent.jobStatus?.(id)??[],activeJobs=jobs.some(j=>['queued','running','uncertain'].includes(j.state))
    let failure=turn?.result?.error??turn?.error??null
    if(turn?.state==='failed'&&failure==='Unclean worker output'){
      try{const exit=JSON.parse(readFileSync(join(directory,'turns',turn.id,'exit.json'),'utf8'));if(exit.stop_reason==='timeout')failure='Worker 超过执行时限，已停止。可缩小任务范围后重试。'}catch{}
    }
    return {project,turn_id:turn?.id??null,turn_state:turn?.state??'queued',turn_error:failure,review:review??null,jobs,
      workspace:turn?.result?.workspace??null,artifacts:turn?.result?.artifacts??[],
      canReview:!t.ended&&turn?.state==='completed'&&review==='pending'&&!t.undelivered.length&&!activeJobs,
      canRetry:!t.ended&&['failed','cancelled'].includes(turn?.state)&&!activeJobs}
  }
  const decorate=row=>{
    if(!row?.id||!store.tickets.get(row.id))return row
    const x=local(row.id),needs=x.canReview||x.turn_state==='uncertain'
    return {...row,sessionId:session(row.id),actions:{...row.actions,retry:x.canRetry},
      ...(x.turn_state==='failed'&&x.turn_error?{summary:x.turn_error,note:{text:x.turn_error,error:true}}:{}),
      ...(needs?{stage:'person',action:'answer',note:{text:x.canReview?'交付已完成，等待验收':'执行状态不确定，等待核查',error:x.turn_state==='uncertain'}}:{}),codex:x}
  }
  const rows=()=>{const v=snapshot(view);return store.tickets.list().filter(t=>store.db.prepare('SELECT 1 FROM sa_ticket WHERE ticket_id=?').get(t.id)).sort(newestFirst).map(t=>decorate(ticketRow(v,t)))}
  const health=()=>{
    const blocked=[...runtime.turns().filter(t=>t.state==='uncertain').map(t=>t.id),
      ...store.db.prepare("SELECT id FROM sa_call WHERE state IN ('invalid','uncertain')").all().map(t=>t.id)]
    return {local:{state:'ready',detail:'Local authenticated conversation'},
      ...(blocked.length?{codex:{state:'error',detail:'等待核查的执行：'+blocked.join(', ')}}:{})}
  }
  const stripRequeue=value=>{
    // Original DSH Eval requeue needs a Codex Router replay contract before enabling it.
    if(Array.isArray(value))return value.map(stripRequeue)
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='requeue'?false:stripRequeue(v)]))
    return value
  }
  agent.prompts.directory=directory
  const setup=()=>({machine:{stateDir:directory,...agent.deployment.value},problem:null,feishuProblem:null,accounts:null})
  return function handle(method,path,query,value={}) {
    return withSessions(session,()=>{
      const project=query.get('project')??agent.projects[0]?.id
      if(project)agent.project(project)
      if(method==='GET'&&path==='codex/deployment')return agent.deployment.view()
      if(method==='PUT'&&path==='codex/deployment')return agent.deployment.mutate(value.ops,value.revision)
      if(method==='GET'&&path==='prompts')return agent.prompts.view({revision:query.has('revision')?integer(query.get('revision'),0,1e7):undefined,offset:integer(query.get('offset'),0,1e7)})
      if(method==='POST'&&path==='prompts/preview')return agent.prompts.preview(value)
      if(method==='PUT'&&path==='prompts')return agent.prompts.save(value.config,value.baseRevision)
      if(method==='GET'&&path==='settings')return {blocks:{executor:{revision:settings().revision,value:{maxWorkers:runtime.capacity}}},sources:[],environment:{root:directory,variables:[]}}
      const offset=()=>integer(query.get('offset'),0,1e7),limit=(n=20,max=100)=>Math.max(1,integer(query.get('limit'),n,max))
      const ticketMatch=path.match(/^tickets\/([^/]+)(?:\/(retry|stop))?$/)
      if(method==='POST'&&path==='codex/projects')return agent.addProject(value)
      if(method==='GET'&&path==='state')return {masterId:store.get('sa.session.'+project)??'router:'+project,paused:!!store.get('sa.paused'),setup:setup(),
        load:{...executorLoad(store,runtime.turns().filter(t=>t.state==='running').length),maxWorkers:runtime.capacity},health:health()}
      if(method==='GET'&&path==='overview'){
        const result=overview(view,health(),'local-explicit-v1',executorLoad(store,runtime.turns().filter(t=>t.state==='running').length))
        return {...result,person:rows().filter(t=>t.stage==='person'),problems:result.problems.filter(p=>p.kind!=='no-allowed')}
      }
      if(method==='GET'&&path==='sources')return sourcesStatus(view,health(),{})
      if(method==='GET'&&path==='search')return stripRequeue(search(view,(query.get('q')??'').slice(0,500),new Map()))
      if(method==='GET'&&path==='tickets'){
        const filter=query.get('state')??'open';require(['open','person','working','idle','ended'].includes(filter),'Invalid ticket filter')
        return page(rows().filter(t=>filter==='open'?t.state==='open':t.stage===filter),offset(),limit())
      }
      if(ticketMatch){
        const id=decodeURIComponent(ticketMatch[1]),p=scope(id)
        if(method==='GET'&&!ticketMatch[2]){
          const detail=decorate(ticketDetail(view,id))
          return {...detail,assignments:detail.assignments.map(a=>({...a,ref:runtime.binding(a.id)?.session_id??''})),
            environment:[],paused:!!store.get('sa.paused')}
        }
        if(method==='POST'&&ticketMatch[2]==='stop'){agent.stop(id,p);return {stopped:true}}
        if(method==='POST'&&ticketMatch[2]==='retry'){agent.retry(p,id);return {retried:true}}
      }
      if(method==='GET'&&path==='threads'){
        const filter=query.get('filter')??'subscribed';require(['subscribed','evaluating','recent','all'].includes(filter),'Invalid thread filter')
        return stripRequeue(threadList(view,filter,offset(),limit()))
      }
      const tm=path.match(/^threads\/([^/]+)(?:\/(unsubscribe))?$/)
      if(tm){
        const key=decodeURIComponent(tm[1]);require(store.threads.get(key)?.ref.source==='local','Unknown local thread')
        if(method==='GET'&&!tm[2])return stripRequeue(threadDetail(view,key,query.get('before')??undefined,limit(50),query.get('around')??undefined))
        if(method==='POST'&&tm[2]){
          return store.atomic(()=>{
            const projects=new Set(store.threads.get(key).subscriptions.map(id=>scope(id)))
            const removed=runtime.engine.unsubscribe(key)
            if(removed)for(const project of projects)agent.message(randomUUID(),project,'system',{text:'用户取消了线程订阅：'+key+'。后续消息不再自动投递到原任务。'})
            runtime.audit({type:'human.unsubscribe',thread:key,removed})
            return {removed,thread:key,context_delivery:'pending'}
          })
        }
      }
      if(method==='GET'&&path==='decisions')return decisionList(view,(query.get('kind')??'').split(',').filter(Boolean),offset(),limit(30,200),query.get('window')==='24h'?new Date(Date.now()-86400000).toISOString():'')
      const dm=path.match(/^decisions\/([^/]+)\/dismiss$/)
      if(method==='POST'&&dm){runtime.engine.dismiss(decodeURIComponent(dm[1]));return {dismissed:true}}
      if(method==='POST'&&path==='executor/pause'){require(typeof value.paused==='boolean','Boolean required');store.set('sa.paused',value.paused);return {paused:value.paused}}
      if(method==='GET'&&path==='codex/runtime')return {settings:settings(),history:versions.list(20),directory,projects:agent.projects.map(p=>({id:p.id,description:p.description})),
        budgets:{worker:runtime.remaining,router:agent.controlBudget,watchdog:host.watchdog.budget},policy:'本地用户明确授权；仅登记能力；结果需验收',models:'Codex 当前配置',
        sessions:agent.projects.map(p=>({project:p.id,id:store.get('sa.session.'+p.id)??''}))}
      if(method==='PUT'&&path==='codex/runtime')return store.atomic(()=>{
        if(value.revision!==versions.revision())throw Object.assign(Error('设置已被其他页面修改，请合并最新版本后保存。'),{status:409})
        require(value.value&&Object.hasOwn(value.value,'maxWorkers')&&Object.keys(value.value).every(k=>['maxWorkers','workerTimeoutSeconds'].includes(k)),'Unknown runtime settings')
        require(Number.isInteger(value.value.maxWorkers)&&value.value.maxWorkers>=LIMITS.maxWorkers.min&&value.value.maxWorkers<=LIMITS.maxWorkers.max,'Worker 并发必须为 1–16 的整数')
        const next={...settings().value,...value.value};validateWorkerTimeout(next.workerTimeoutSeconds)
        const saved=versions.save(revision=>({revision,value:next,savedAt:new Date().toISOString()}))
        runtime.capacity=saved.value.maxWorkers;runtime.audit({type:'human.settings',...saved})
        return {revision:saved.revision,restarting:false}
      })
      if(method==='GET'&&path.startsWith('codex/sessions/')){
        const id=path.slice('codex/sessions/'.length)
        require(UUID.test(id),'Invalid Codex session ID')
        const bound=agent.projects.some(p=>store.get('sa.session.'+p.id)===id)||!!store.db.prepare('SELECT 1 FROM codex_binding WHERE session_id=?').get(id)
        require(bound,'Session does not belong to this framework')
        return {id,url:'codex://threads/'+id}
      }
      throw Object.assign(Error('该功能尚未完成 Codex 适配。'),{status:404})
    })
  }
}
