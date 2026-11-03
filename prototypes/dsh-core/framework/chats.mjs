/** Ordinary persistent Codex conversations alongside, rather than inside, Superagent routing. */
import {randomUUID} from 'node:crypto'
import {hash} from '../src/durable-runtime.mjs'
import {require} from './contracts.mjs'
export class Chats{
 constructor(host){
  this.host=host;this.db=host.runtime.store.db;this.busy=false
  if(host.runtime.store.get('sa.chat.budget')===undefined)host.runtime.store.set('sa.chat.budget',24)
  this.db.exec(`CREATE TABLE IF NOT EXISTS sa_chat(id TEXT PRIMARY KEY,project TEXT NOT NULL,title TEXT NOT NULL,session_id TEXT,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sa_chat_message(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,chat TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,processed INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS sa_chat_call(id TEXT PRIMARY KEY,chat TEXT NOT NULL,state TEXT NOT NULL,request TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT,error TEXT);`)
 }
 own(project,id){this.host.agent.project(project);const row=this.db.prepare('SELECT * FROM sa_chat WHERE id=? AND project=?').get(id,project);require(row,'Conversation outside project');return row}
 list(project){this.host.agent.project(project);return this.db.prepare('SELECT * FROM sa_chat WHERE project=? ORDER BY rowid DESC').all(project)}
 get budget(){return this.host.runtime.store.get('sa.chat.budget')}
 set budget(value){this.host.runtime.store.set('sa.chat.budget',value)}
 create({project,title='新会话'}){this.host.agent.project(project);require(typeof title==='string'&&title.trim().length>0&&title.length<=100,'Invalid conversation title');
  return this.host.runtime.store.atomic(()=>{
   if(title==='新会话'){const blank=this.db.prepare("SELECT id FROM sa_chat WHERE project=? AND title='新会话' AND session_id IS NULL AND NOT EXISTS (SELECT 1 FROM sa_chat_message m WHERE m.chat=sa_chat.id) ORDER BY rowid LIMIT 1").get(project);if(blank)return {id:blank.id,project}}
   const id=randomUUID();this.db.prepare('INSERT INTO sa_chat VALUES (?,?,?,NULL,?)').run(id,project,title.trim(),new Date().toISOString());return {id,project}
  })
 }
 receive({project,chat,id=randomUUID(),text}){
  const row=this.own(project,chat);require(typeof text==='string'&&text.trim()&&text.length<=4000,'Message must contain 1..4000 characters')
  return this.host.runtime.store.atomic(()=>{
   const prior=this.db.prepare('SELECT * FROM sa_chat_message WHERE id=?').get(id)
   if(prior){require(prior.chat===chat&&prior.text===text&&prior.role==='user','Message ID collision');return {id}}
   this.db.prepare("INSERT INTO sa_chat_message(id,chat,role,text) VALUES (?,?,'user',?)").run(id,chat,text)
   if(row.title==='新会话')this.db.prepare('UPDATE sa_chat SET title=? WHERE id=?').run(text.trim().slice(0,40),chat)
   return {id}
  })
 }
 detail(project,id,before=Number.MAX_SAFE_INTEGER){
  const chat=this.own(project,id);require(Number.isSafeInteger(before)&&before>=0,'Invalid history cursor')
  const rows=this.db.prepare('SELECT * FROM sa_chat_message WHERE chat=? AND seq<? ORDER BY seq DESC LIMIT 51').all(id,before),hasMore=rows.length>50
  rows.length=Math.min(rows.length,50);rows.reverse()
  const executions=this.db.prepare('SELECT id,state,error,response,request FROM sa_chat_call WHERE chat=? ORDER BY rowid DESC LIMIT 30').all(id).map(({request,response,...r})=>({...r,kind:'chat',session_id:response&&JSON.parse(response).session_id||JSON.parse(request).session_id,error:response&&JSON.parse(response).error||r.error}))
  return {project,chat:id,title:chat.title,session_id:chat.session_id,ticket:null,tickets:[],messages:rows.map(r=>({...r,origin:r.role==='assistant'?'codex':'user',body:{text:r.text}})),hasMore,before:rows[0]?.seq??null,executions,paused:false,budget:this.budget,transport:'codex-app-server-stdio-v1'}
 }
 settle(row,result){
  const request=JSON.parse(row.request)
  require(result.request_id===row.id&&result.request_hash===row.request_hash,'Chat receipt identity mismatch')
  return this.host.runtime.store.atomic(()=>{
   if(result.status!=='completed'){
    this.db.prepare("UPDATE sa_chat_call SET state='failed',response=?,error=? WHERE id=?").run(JSON.stringify(result),result.error??'Conversation failed',row.id)
    // A terminal failed call is visible and held; explicit retry is required.
    return
   }
   require(result.session_id&&(!request.session_id||request.session_id===result.session_id),'Conversation session changed')
   require(result.output?.request_id===row.id&&result.output.snapshot_hash===request.snapshot_hash&&typeof result.output.reply==='string','Invalid chat output')
   this.db.prepare('UPDATE sa_chat SET session_id=? WHERE id=?').run(result.session_id,row.chat)
   this.db.prepare("INSERT OR IGNORE INTO sa_chat_message(id,chat,role,text,processed) VALUES (?,?,'assistant',?,1)").run('assistant:'+row.id,row.chat,result.output.reply)
   for(const message of request.context.messages)this.db.prepare('UPDATE sa_chat_message SET processed=1 WHERE id=? AND chat=?').run(message.id,row.chat)
   this.db.prepare("UPDATE sa_chat_call SET state='applied',response=?,error=NULL WHERE id=?").run(JSON.stringify(result),row.id)
  })
 }
 async once(){
  if(this.busy)return;this.busy=true
  try{
   for(const row of this.db.prepare("SELECT * FROM sa_chat_call WHERE state IN ('running','uncertain')").all()){
    const result=await this.host.control.result(row.id)
    if(result){try{this.settle(row,result)}catch(error){this.db.prepare("UPDATE sa_chat_call SET state='invalid',error=? WHERE id=?").run(String(error),row.id)}}
    else this.db.prepare("UPDATE sa_chat_call SET state='uncertain' WHERE id=?").run(row.id)
   }
   if(this.budget<=0)return
   const head=this.db.prepare("SELECT m.chat FROM sa_chat_message m WHERE m.role='user' AND m.processed=0 AND m.chat NOT IN (SELECT chat FROM sa_chat_call WHERE state IN ('running','uncertain','failed','invalid')) ORDER BY seq LIMIT 1").get()
   if(!head)return
   const chat=this.db.prepare('SELECT * FROM sa_chat WHERE id=?').get(head.chat)
   const rows=this.db.prepare('SELECT id,text FROM sa_chat_message WHERE chat=? AND processed=0 ORDER BY seq LIMIT 12').all(chat.id)
   const id=randomUUID(),context={project:chat.project,projects:[],messages:rows},request={kind:'chat',request_id:id,session_id:chat.session_id,snapshot_hash:hash(JSON.stringify(rows)),context},encoded=JSON.stringify(request)
   this.db.prepare("INSERT INTO sa_chat_call VALUES (?,?,'running',?,?,NULL,NULL)").run(id,chat.id,encoded,hash(encoded));this.budget--
   const row=this.db.prepare('SELECT * FROM sa_chat_call WHERE id=?').get(id)
   try{this.settle(row,await this.host.control.execute(request,row.request_hash))}
   catch(error){this.db.prepare("UPDATE sa_chat_call SET state='uncertain',error=? WHERE id=?").run(String(error),id)}
  }finally{this.busy=false}
 }
 retry(project,id){this.own(project,id);const rows=this.db.prepare("SELECT * FROM sa_chat_call WHERE chat=? AND state='failed'").all(id);require(rows.length,'No confirmed failed turn to retry');for(const row of rows)this.db.prepare("UPDATE sa_chat_call SET state='reconciled' WHERE id=?").run(row.id)}
 cancel(){for(const row of this.db.prepare("SELECT id FROM sa_chat_call WHERE state IN ('running','uncertain')").all())this.host.control.cancel(row.id)}
}
