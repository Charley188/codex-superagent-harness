import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { require } from './contracts.mjs'
import { panelApi } from './panel-api.mjs'
import {atomicJson} from './atomic-json.mjs'
import {createFolderPicker} from './folder-picker.mjs'
import {harnessApi} from './harness-api.mjs'
import {Chats} from './chats.mjs'

export async function serve(host,{port=0,pump=true,monitor=true,writeMonitor=atomicJson,folderPicker=createFolderPicker()}={}) {
  const {directory,runtime,agent,jobs,watchdog,control}=host
  // Pin the frontend with the running backend; a development build cannot swap its UI mid-session.
  const assets=new Map([
    ['/', '../panel/index.html'],['/classic','./ui/index.html'],
    ['/panel.js','../panel/dist/panel.js'],['/panel.css','../panel/dist/panel.css'],
    ['/app.js','./ui/app.js'],['/style.css','./ui/style.css']
  ].map(([route,path])=>[route,readFileSync(new URL(path,import.meta.url))]))
  const panel=panelApi(host)
  const chats=host.chats=new Chats(host)
  const harness=harnessApi(host)
  const token=randomBytes(32).toString('hex');let closing=false, timer, heartbeatTimer, child, childEnded, busy=new Set(),lastError=null
  let closingWork, httpClose, closedStatus, phase='running', attention=0
  const activity=()=>closedStatus?{workers:0,router:0,watchdog:0,jobs:0}:{
    workers:runtime.turns().filter(t=>t.state==='running').length,router:(agent.routerBusy?1:0)+(chats.busy?1:0),watchdog:watchdog.busy?1:0,jobs:jobs.running.size}
  const lifecycle=()=>({state:phase,active:activity(),paused:closedStatus?closedStatus.paused:!!runtime.store.get('sa.paused'),attention})
  const work=fn=>{const p=Promise.resolve().then(fn).catch(e=>{lastError=String(e)}).finally(()=>busy.delete(p));busy.add(p);return p}
  let monitorWriting=false
  const monitorInput=async()=>{
    if(monitorWriting||closedStatus)return
    monitorWriting=true
    try{await writeMonitor(join(directory,'monitor-input.json'),{at:Date.now()/1000,executions:[...runtime.turns().map(t=>({id:t.id,state:t.state})),...jobs.rows().map(j=>({id:j.id,state:j.state}))]});if(lastError?.startsWith('Monitor input:'))lastError=null}
    catch(error){lastError='Monitor input: '+error}
    finally{monitorWriting=false}
  }
  let lastMonitor=null
  const monitorStatus=()=>{try{if(existsSync(join(directory,'monitor-status.json')))lastMonitor=JSON.parse(readFileSync(join(directory,'monitor-status.json'),'utf8'))}catch{}return lastMonitor}
  function tick() {
    if(closing)return
    jobs.pump()
    if(!runtime.running)work(()=>agent.workersOnce())
    if(!agent.routerBusy)work(()=>agent.routerOnce())
    if(!watchdog.busy)work(()=>watchdog.once())
    if(!chats.busy)work(()=>chats.once())
  }
  const server=createServer(async(req,res)=>{
    const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value))}
    try {
      const expected='127.0.0.1:'+server.address().port
      require(req.headers.host===expected,'Invalid host')
      if(req.method==='GET' && ['/', '/classic'].includes(req.url)) {
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"})
        res.end(assets.get(req.url));return
      }
      if(req.method==='GET' && ['/panel.js','/panel.css'].includes(req.url)) {
        res.writeHead(200,{'content-type':req.url.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'})
        res.end(assets.get(req.url));return
      }
      if(req.method==='GET' && ['/app.js','/style.css'].includes(req.url)) {
        res.writeHead(200,{'content-type':req.url.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','x-content-type-options':'nosniff'});res.end(assets.get(req.url));return
      }
      require(req.headers.authorization==='Bearer '+token,'Authentication required')
      if(req.method==='GET'&&req.url.startsWith('/api/harness')){
        require(!closing,'工作台正在退出')
        require(!req.headers.origin||req.headers.origin==='http://'+expected,'Cross-origin request refused')
        const url=new URL(req.url,'http://'+expected)
        json(200,harness(url.pathname,url.searchParams));return
      }
      if(req.url.startsWith('/orchestrator/api/')){
        require(!closing,'工作台正在退出')
        require(req.headers['x-orchestrator-request']==='1','Panel request header required')
        require(!req.headers.origin||req.headers.origin==='http://'+expected,'Cross-origin request refused')
        const url=new URL(req.url,'http://'+expected)
        let value={}
        if(req.method!=='GET'){
          require(['POST','PUT'].includes(req.method),'POST or PUT required')
          const chunks=[];let size=0
          const limit=['/orchestrator/api/prompts','/orchestrator/api/prompts/preview'].includes(url.pathname)?8000000:16000
          for await(const part of req){size+=part.length;require(size<=limit,'Request too large');chunks.push(part)}
          const body=Buffer.concat(chunks).toString('utf8')
          // DSH sends bodyless action POSTs. Authentication, panel header and Origin checks still apply.
          if(body.length){require(req.headers['content-type']?.split(';')[0].trim().toLowerCase()==='application/json','JSON request required');value=JSON.parse(body)}
        }
        json(200,await panel(req.method,url.pathname.slice('/orchestrator/api/'.length),url.searchParams,value));return
      }
      if(req.method==='GET' && req.url==='/api/lifecycle'){json(200,lifecycle());return}
      if(req.method==='GET' && req.url==='/api/status') {
        if(closedStatus){json(200,{...closedStatus,lifecycle:lifecycle()});return}
        const status=agent.status()
        json(200,{...status,navigation:runtime.store.get('sa.ui.navigation')??null,projects:status.projects.map(p=>({...p,chats:chats.list(p.id)})),lifecycle:lifecycle(),last_error:lastError,budgets:{worker:runtime.remaining,router:agent.controlBudget,watchdog:watchdog.budget},watchdog:runtime.store.db.prepare('SELECT id,project,state,error,response FROM sa_watch ORDER BY rowid DESC LIMIT 4').all(),
          monitor:monitorStatus()});return
      }
      require(req.method==='POST' && req.headers['content-type']==='application/json','JSON POST required')
      require(!req.headers.origin || req.headers.origin==='http://'+expected,'Cross-origin request refused')
      let data='';for await(const part of req){data+=part;require(data.length<=16000,'Request too large')}
      const value=JSON.parse(data)
      if(req.url==='/api/shutdown'){
        await prepareClose(value.mode??'now')
        res.once('finish',()=>{void closeHttp()})
        json(200,{stopped:true,attention});return
      }
      if(closing){json(409,{error:'工作台正在退出，请等待退出完成后重新打开。'});return}
      if(req.url==='/api/folders/pick'){
        const controller=new AbortController()
        res.once('close',()=>{if(!res.writableEnded)controller.abort()})
        json(200,await folderPicker.pick(value.initial??'',{signal:controller.signal}))
      }
      else if(req.url==='/api/message') json(200,{id:agent.receive(value)})
      else if(req.url==='/api/chats')json(200,chats.create(value))
      else if(req.url==='/api/chats/message')json(200,chats.receive(value))
      else if(req.url==='/api/chats/retry'){chats.retry(value.project,value.chat);json(200,{retried:true})}
      else if(req.url==='/api/navigation'){
        agent.project(value.project);require(typeof value.target==='string'&&typeof value.compose==='boolean','Invalid navigation')
        if(value.target.startsWith('chat:'))chats.own(value.project,value.target.slice(5))
        else if(value.target)agent.owns(value.project,value.target)
        runtime.store.set('sa.ui.navigation',{project:value.project,target:value.target,compose:value.compose});json(200,{saved:true})
      }
      else if(req.url==='/api/pause'){require(typeof value.paused==='boolean','Boolean required');runtime.store.set('sa.paused',value.paused);json(200,{paused:value.paused})}
      else if(req.url==='/api/stop'){agent.stop(value.ticket_id,value.project);json(200,{stopped:true})}
      else if(req.url==='/api/retry'){agent.retry(value.project,value.ticket_id);json(200,{retried:true})}
      else if(req.url==='/api/review'){require(typeof value.accept==='boolean','Boolean required');agent.review(value.project,value.ticket_id,value.turn_id,value.accept,value.note);json(200,{reviewed:true})}
      else if(req.url==='/api/job'){json(200,jobs.enqueue(value.project,value.ticket_id,value.profile,value.id))}
      else if(req.url==='/api/clear-control'){agent.clearControl(value.id,value);json(200,{cleared:true})}
      else if(req.url==='/api/reconcile-worker'){runtime.reconcileStopped(value.id,{...value,operator:'local-user'});json(200,{reconciled:true})}
      else if(req.url==='/api/reconcile-job'){jobs.reconcileStopped(value.id,value);json(200,{reconciled:true})}
      else if(req.url==='/api/budgets/add'){
        const roles={worker:[runtime,'remaining',20],router:[agent,'controlBudget',100],watchdog:[watchdog,'budget',20],chat:[chats,'budget',100]},role=roles[value.role]
        require(role&&Number.isInteger(value.amount)&&value.amount>0&&value.amount<=20,'Invalid budget increment')
        runtime.store.atomic(()=>{const [owner,key,max]=role;require(owner[key]+value.amount<=max,'Budget exceeds finite limit');owner[key]+=value.amount;runtime.audit({type:'human.budget.add',role:value.role,amount:value.amount})})
        json(200,{remaining:role[0][role[1]]})
      }
      else if(req.url==='/api/budgets'){
        require(Number.isInteger(value.worker)&&value.worker>=0&&value.worker<=20&&Number.isInteger(value.router)&&value.router>=0&&value.router<=100&&Number.isInteger(value.watchdog)&&value.watchdog>=0&&value.watchdog<=20,'Invalid finite budgets')
        runtime.remaining=value.worker;agent.controlBudget=value.router;watchdog.budget=value.watchdog;runtime.audit({type:'human.budgets',...value});json(200,value)
      }
      else json(404,{error:'Unknown endpoint'})
    }catch(error){json(/Authentication|origin|Invalid host/.test(String(error))?403:error.status??400,{error:String(error)})}
  })
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done)})
  const url='http://127.0.0.1:'+server.address().port+'/#'+token
  await atomicJson(join(directory,'connection.json'),{url,pid:process.pid,started_at:new Date().toISOString()})
  await monitorInput()
  heartbeatTimer=setInterval(()=>{if(!closedStatus)monitorInput()},1000)
  if(monitor){
    const stop=join(directory,'monitor.stop');if(existsSync(stop))unlinkSync(stop)
    child=spawn('python',['-B',fileURLToPath(new URL('./monitor.py',import.meta.url)),'--directory',directory],{windowsHide:true,stdio:'ignore'})
    childEnded=new Promise(done=>{child.once('exit',done);child.once('error',done)})
    child.on('error',error=>{lastError='Monitor: '+error});child.on('exit',()=>{if(!closing)lastError='Independent monitor exited'})
  }
  if(pump){timer=setInterval(tick,2000);tick()}
  function cancelExecutions(){
    for(const t of runtime.turns())if(['running','uncertain'].includes(t.state))runtime.transport.cancel(t.id)
    for(const table of ['sa_call','sa_watch'])for(const row of runtime.store.db.prepare(`SELECT id FROM ${table} WHERE state IN ('running','uncertain')`).all())control.cancel?.(row.id)
    jobs.cancelRunning()
    chats.cancel()
  }
  function prepareClose(mode='now'){
    require(['now','drain'].includes(mode),'Unknown shutdown mode')
    if(closingWork){if(mode==='now'&&phase==='draining'){phase='stopping';cancelExecutions()}return closingWork}
    closing=true;clearInterval(timer);folderPicker.cancel();phase=mode==='drain'?'draining':'stopping'
    const wasPaused=!!runtime.store.get('sa.paused')
    runtime.store.set('sa.paused',true)
    if(mode==='now')cancelExecutions()
    closingWork=(async()=>{
      await Promise.allSettled([...busy,...jobs.running.values()])
      // Preserve queued jobs and the user's pause choice; interrupted calls require explicit retry.
      attention=runtime.turns().filter(t=>t.state==='uncertain').length+jobs.rows().filter(j=>j.state==='uncertain').length
        +['sa_call','sa_watch'].reduce((n,table)=>n+runtime.store.db.prepare(`SELECT count(*) n FROM ${table} WHERE state='uncertain'`).get().n,0)
        +runtime.store.db.prepare("SELECT count(*) n FROM sa_chat_call WHERE state='uncertain'").get().n
      runtime.audit({type:'host.shutdown',mode,attention})
      runtime.store.set('sa.paused',wasPaused)
      closedStatus={...agent.status(),budgets:{worker:runtime.remaining,router:agent.controlBudget,watchdog:watchdog.budget},watchdog:[],monitor:null,last_error:lastError}
      clearInterval(heartbeatTimer);writeFileSync(join(directory,'monitor.stop'),'stop')
      if(childEnded){
        // The observer owns no work; do not let a stuck observer hold shutdown open.
        let timeout
        await Promise.race([childEnded,new Promise(done=>{timeout=setTimeout(()=>{child.kill();done()},3000)})])
        clearTimeout(timeout)
      }
      await runtime.close();phase='stopped'
      await atomicJson(join(directory,'shutdown.json'),{state:'stopped',pid:process.pid,at:new Date().toISOString(),attention,paused:wasPaused})
    })().catch(error=>{phase='error';lastError=String(error);throw error})
    return closingWork
  }
  function closeHttp(){if(!httpClose)httpClose=new Promise(done=>server.close(done));return httpClose}
  async function close(mode='now'){await prepareClose(mode);await closeHttp()}
  return {url,token,server,close,tick,lifecycle}
}
