/** Project-scoped chat/history and cursor-based execution events. No arbitrary Codex session IDs or paths. */
import {openSync,readSync,closeSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {latestAssignment} from '../vendor/dsh/src/core/index.ts'
import {require} from './contracts.mjs'
const number=(v,f,max)=>{const n=Number(v??f);require(Number.isSafeInteger(n)&&n>=0&&n<=max,'Invalid history cursor');return n}
export function harnessApi(host){
 const {agent,runtime,directory}=host,store=runtime.store,db=store.db
 const scope=(project,ticket)=>{agent.project(project);if(ticket)agent.owns(project,ticket)}
 const executions=(project,ticket)=>ticket?db.prepare('SELECT id,state,error,request,result AS response FROM codex_turn WHERE ticket_id=? ORDER BY rowid DESC LIMIT 30').all(ticket).map(r=>({...r,kind:'worker'})):
   db.prepare('SELECT id,state,error,request,response FROM sa_call WHERE project=? ORDER BY rowid DESC LIMIT 30').all(project).map(r=>({...r,kind:'router'}))
 return function get(path,query){
  const project=query.get('project')??agent.projects[0]?.id,ticket=query.get('ticket')||null
  const chat=query.get('chat')||null
  scope(project,ticket)
  if(chat)host.chats.own(project,chat)
  if(path==='/api/harness'){
   if(chat)return host.chats.detail(project,chat,number(query.get('before'),Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER))
   const before=number(query.get('before'),Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),limit=Math.max(1,number(query.get('limit'),50,200))
   // SQLite JSON predicates retain stable queue sequence numbers across pages and restarts.
   const filter=ticket?"AND json_extract(body,'$.ticket_id')=?":""
   const rows=db.prepare(`SELECT seq,id,origin,body,processed FROM sa_message WHERE project=? AND seq<? ${filter} ORDER BY seq DESC LIMIT ?`).all(...(ticket?[project,before,ticket,limit+1]:[project,before,limit+1]))
   const hasMore=rows.length>limit;rows.length=Math.min(rows.length,limit);rows.reverse()
   const tickets=agent.tickets(project).map(t=>{
    const original=store.tickets.get(t.ticket_id),assignment=latestAssignment(original)
    const binding=assignment&&runtime.binding(assignment.id)
    return {...t,session_id:binding?.session_id??null}
   })
   return {project,ticket,session_id:ticket?tickets.find(t=>t.ticket_id===ticket)?.session_id:store.get('sa.session.'+project)??null,
    messages:rows.map(r=>({...r,body:JSON.parse(r.body)})),hasMore,before:rows[0]?.seq??null,tickets,
    executions:executions(project,ticket).map(({request,response,...r})=>{const data=response&&JSON.parse(response);return {...r,session_id:data?.session_id??JSON.parse(request).session_id??null,error:data?.error??r.error,summary:data?.report?.summary??data?.output?.reply??null}}),
    paused:!!store.get('sa.paused'),budget:ticket?runtime.remaining:agent.controlBudget,transport:'codex-app-server-stdio-v1'}
  }
  if(path==='/api/harness/events'){
   const id=query.get('call');require(typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id),'Invalid execution ID')
   const record=(chat?host.chats.detail(project,chat).executions:executions(project,ticket)).find(r=>r.id===id)
   require(record,'Execution is not in this conversation')
   const offset=number(query.get('offset'),0,32*1024*1024)
   const file=join(directory,record.kind==='worker'?'turns':'control',id,'ui-events.jsonl')
   if(!existsSync(file))return {events:[],offset,legacy:true,state:record.state}
   const descriptor=openSync(file,'r');let buffer=Buffer.alloc(2*1024*1024),count
   try{count=readSync(descriptor,buffer,0,buffer.length,offset)}finally{closeSync(descriptor)}
   buffer=buffer.subarray(0,count);const end=buffer.lastIndexOf(10)
   if(end<0){require(count<buffer.length,'Execution frame exceeds stream page limit');return {events:[],offset,state:record.state}}
   const events=[]
   for(const line of buffer.subarray(0,end).toString('utf8').split('\n')){
    if(!line.trim())continue
    const value=JSON.parse(line)
    if(value.method&&value.params)events.push({method:value.method,params:value.params,...value.id===undefined?{}:{request_id:value.id}})
   }
   return {events,offset:offset+end+1,state:record.state,more:count===buffer.length}
  }
  if(path==='/api/harness/resolve'){
   const id=query.get('session')
   if(id==='router:'+project)return {project,ticket:null}
   if(typeof id==='string'&&/^worker:[a-f0-9]{32}$/i.test(id)){
    const ticketId=id.slice(7),owner=db.prepare('SELECT project FROM sa_ticket WHERE ticket_id=?').get(ticketId)
    require(owner,'Unknown managed worker');scope(owner.project,ticketId);return {project:owner.project,ticket:ticketId}
   }
   require(typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id),'Invalid session ID')
   const ordinary=db.prepare('SELECT id,project FROM sa_chat WHERE session_id=?').get(id)
   if(ordinary){scope(ordinary.project,null);return {project:ordinary.project,ticket:'chat:'+ordinary.id}}
   const router=agent.projects.find(p=>store.get('sa.session.'+p.id)===id)
   if(router)return {project:router.id,ticket:null}
   const binding=db.prepare('SELECT ticket_id FROM codex_binding WHERE session_id=?').get(id)
   if(binding){const owner=db.prepare('SELECT project FROM sa_ticket WHERE ticket_id=?').get(binding.ticket_id);require(owner,'Unknown worker project');scope(owner.project,binding.ticket_id);return {project:owner.project,ticket:binding.ticket_id}}
   // Historical assignments are still inspectable through their task's durable history.
   const call=db.prepare('SELECT project FROM sa_call WHERE json_extract(response,\'$.session_id\')=?').get(id)
   require(call,'Session does not belong to this host');scope(call.project,null);return {project:call.project,ticket:null}
  }
  throw Error('Unknown Harness endpoint')
 }
}
