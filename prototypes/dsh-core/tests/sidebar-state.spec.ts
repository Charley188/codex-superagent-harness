import {it,expect} from 'vitest'
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {DurableRuntime} from '../src/durable-runtime.mjs'
import {Superagent} from '../framework/superagent.mjs'
import {Chats} from '../framework/chats.mjs'
import {sidebarState} from '../framework/sidebar-state.mjs'
const projects=[{id:'one',capabilities:[{id:'a',repo_id:'synthetic',inputs:[{path:'x',sha256:'a'.repeat(64)}]}]}]
function open(directory,control){const runtime=new DurableRuntime({directory,transport:control}),agent=new Superagent(runtime,control,projects),host={runtime,agent,control};host.chats=new Chats(host);return {...host,sidebar:sidebarState(host)}}
it('removes only workspace membership and restores it after restart with session and files intact',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-sidebar-')),control={result:async()=>null,cancel(){}}
 let host=open(directory,control)
 try{
  const file=join(directory,'original.txt');writeFileSync(file,'unchanged')
  const chat=host.chats.create({project:'one'});host.chats.receive({project:'one',chat:chat.id,text:'saved'})
  host.sidebar.workspace({project:'one',removed:true})
  expect(host.sidebar.project(host.agent.status().projects[0]).removed).toBe(true)
  await host.runtime.close();host=open(directory,control)
  const row=host.sidebar.project(host.agent.status().projects[0]);expect(row.removed).toBe(true);expect(row.chats[0].id).toBe(chat.id)
  expect(readFileSync(file,'utf8')).toBe('unchanged');expect(host.chats.detail('one',chat.id).messages).toHaveLength(1)
  host.sidebar.workspace({project:'one',removed:false});expect(host.sidebar.project(host.agent.status().projects[0]).removed).toBe(false)
  expect(()=>host.sidebar.workspace({project:'other',removed:true})).toThrow()
 }finally{await host.runtime.close();rmSync(directory,{recursive:true,force:true})}
})
it('archiving running chat cancels only its call and prevents pending input replay after restoration',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-archive-'));let finish,request,hash,cancelled=[],calls=0
 const control={result:async()=>null,cancel(id){cancelled.push(id)},execute(r,h){calls++;request=r;hash=h;return new Promise(resolve=>{finish=resolve})}}
 const host=open(directory,control)
 try{
  const chat=host.chats.create({project:'one'});host.chats.receive({project:'one',chat:chat.id,text:'first'})
  const running=host.chats.once();for(let n=0;n<10&&!finish;n++)await Promise.resolve()
  host.chats.receive({project:'one',chat:chat.id,text:'pending'})
  host.sidebar.archive({project:'one',target:'chat:'+chat.id,archived:true})
  expect(cancelled).toEqual([request.request_id]);expect(()=>host.chats.receive({project:'one',chat:chat.id,text:'hidden'})).toThrow()
  expect(()=>host.chats.archive('one',chat.id,false)).toThrow('停止')
  finish({request_id:request.request_id,request_hash:hash,status:'cancelled',error:'cancelled'});await running
  host.chats.archive('one',chat.id,false);await host.chats.once();expect(calls).toBe(1)
  expect(host.chats.detail('one',chat.id).messages).toHaveLength(2)
  host.chats.archive('one',chat.id,true);expect(host.chats.list('one')[0].archived).toBe(true)
 }finally{await host.runtime.close();rmSync(directory,{recursive:true,force:true})}
})
it('never reuses an archived empty chat and never restarts an archived Worker when restoring its row',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-worker-archive-')),control={result:async()=>null,cancel(){}}
 const host=open(directory,control)
 try{
  const chat=host.chats.create({project:'one'});host.chats.archive('one',chat.id,true);expect(host.chats.create({project:'one'}).id).not.toBe(chat.id)
  const ticket=host.runtime.submit('one-ticket',{repo_id:'synthetic',worker_role:'read',objective:'Synthetic',permission:'read-only',inputs:[{path:'x',sha256:'a'.repeat(64)}]})
  host.runtime.store.db.prepare('INSERT INTO sa_ticket VALUES (?,?,?,?)').run(ticket,'one','a','one-ticket')
  host.sidebar.archive({project:'one',target:ticket,archived:true});expect(host.runtime.store.tickets.get(ticket).ended.by).toBe('human')
  host.sidebar.archive({project:'one',target:ticket,archived:false});expect(host.runtime.store.tickets.get(ticket).ended.by).toBe('human')
  expect(host.runtime.turns()).toHaveLength(0)
 }finally{await host.runtime.close();rmSync(directory,{recursive:true,force:true})}
})
