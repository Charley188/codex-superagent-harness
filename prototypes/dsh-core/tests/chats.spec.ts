import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {it,expect} from 'vitest'
import {DurableRuntime} from '../src/durable-runtime.mjs'
import {Superagent} from '../framework/superagent.mjs'
import {Chats} from '../framework/chats.mjs'
const projects=[{id:'one',capabilities:[{id:'read',repo_id:'synthetic',inputs:[{path:'x',sha256:'a'.repeat(64)}]}]},{id:'two',capabilities:[{id:'read',repo_id:'synthetic',inputs:[{path:'x',sha256:'a'.repeat(64)}]}]}]
it('reuses each workspace blank and keeps ordinary chat independent of Superagent pause and budget',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-chat-independence-'))
 const control={result:async()=>null,execute:async(r,h)=>({status:'completed',request_id:r.request_id,request_hash:h,session_id:randomUUID(),output:{request_id:r.request_id,snapshot_hash:r.snapshot_hash,reply:'Ordinary reply while Superagent paused'}})}
 const runtime=new DurableRuntime({directory,transport:control})
 try{
  const agent=new Superagent(runtime,control,projects),chats=new Chats({runtime,agent,control})
  const a=chats.create({project:'one'});expect(chats.create({project:'one'}).id).toBe(a.id)
  const b=chats.create({project:'two'});expect(b.id).not.toBe(a.id)
  runtime.store.set('sa.paused',true);agent.controlBudget=0
  chats.receive({project:'one',chat:a.id,text:'Normal conversation'});await chats.once()
  expect(chats.detail('one',a.id).messages.at(-1).body.text).toBe('Ordinary reply while Superagent paused')
  expect(chats.detail('one',a.id).paused).toBe(false);expect(agent.controlBudget).toBe(0);expect(chats.budget).toBe(23)
  expect(chats.create({project:'one'}).id).not.toBe(a.id)
  expect(agent.status().messages).toHaveLength(0);expect(runtime.turns()).toHaveLength(0)
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
it('keeps ordinary chat separate from routing, resumes one session, paginates and retains history after reopening',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-chats-')),calls=[]
 const control={result:async()=>null,execute:async(r,h)=>{calls.push(r);return {status:'completed',request_id:r.request_id,request_hash:h,session_id:r.session_id??randomUUID(),output:{request_id:r.request_id,snapshot_hash:r.snapshot_hash,reply:'Synthetic reply'}}}}
 let runtime=new DurableRuntime({directory,transport:control})
 try{
  const agent=new Superagent(runtime,control,projects),chat=new Chats({runtime,agent,control}),created=chat.create({project:'one'})
  chat.receive({project:'one',chat:created.id,id:'first',text:'Question'});chat.receive({project:'one',chat:created.id,id:'first',text:'Question'})
  expect(()=>chat.detail('two',created.id)).toThrow('outside project')
  await chat.once();const session=chat.detail('one',created.id).session_id
  chat.receive({project:'one',chat:created.id,text:'Follow-up'});await chat.once()
  expect(calls).toHaveLength(2);expect(calls[1].session_id).toBe(session)
  expect(runtime.turns()).toHaveLength(0);expect(agent.status().messages).toHaveLength(0)
  for(let n=0;n<60;n++)chat.receive({project:'one',chat:created.id,text:'Saved '+n})
  const page=chat.detail('one',created.id);expect(page.messages).toHaveLength(50);expect(page.hasMore).toBe(true)
  expect(chat.detail('one',created.id,page.before).messages).toHaveLength(14)
  await runtime.close();runtime=new DurableRuntime({directory,transport:control})
  const reopened=new Chats({runtime,agent:new Superagent(runtime,control,projects),control})
  expect(reopened.list('one')).toHaveLength(1);expect(reopened.detail('one',created.id).session_id).toBe(session)
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
it('holds a failed or uncertain chat without replay until explicitly retried',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-chats-'));let calls=0
 const control={result:async()=>null,execute:async(r,h)=>{calls++;return {status:'failed',request_id:r.request_id,request_hash:h,session_id:null,error:'Synthetic failure'}}}
 const runtime=new DurableRuntime({directory,transport:control})
 try{
  const agent=new Superagent(runtime,control,projects),chat=new Chats({runtime,agent,control}),created=chat.create({project:'one'})
  chat.receive({project:'one',chat:created.id,text:'Question'});await chat.once();await chat.once();expect(calls).toBe(1)
  chat.retry('one',created.id);await chat.once();expect(calls).toBe(2)
  runtime.store.db.prepare("UPDATE sa_chat_call SET state='uncertain'").run();await chat.once();expect(calls).toBe(2)
  expect(()=>chat.retry('one',created.id)).toThrow('No confirmed failed')
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
