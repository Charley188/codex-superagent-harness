import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {DurableRuntime} from '../src/durable-runtime.mjs'
import {Superagent} from '../framework/superagent.mjs'
import {localAdmissionContext} from '../framework/admission-context.mjs'
const projects=[{id:'p',capabilities:[{id:'c',repo_id:'r',inputs:[{path:'a',sha256:'a'.repeat(64)}]}]}]
it('persists atomic DSH limit edits, rejects stale/invalid writes, resets inheritance and applies prompt limits immediately',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-deployment-'));let runtime=new DurableRuntime({directory,transport:{}})
 try{
  let agent=new Superagent(runtime,{},projects),deployment=agent.deployment
  expect(deployment.value).toEqual({promptMaxChars:100000,admissionContextMaxPages:10,admissionContextTimeoutMs:15000})
  deployment.mutate([{op:'set',path:['promptMaxChars'],value:1000}],0)
  expect(()=>agent.prompts.save({...agent.prompts.current().config,communication:'x'.repeat(1100)},0)).toThrow('1000 字符')
  expect(()=>deployment.mutate([{op:'set',path:['promptMaxChars'],value:2000}],0)).toThrow('配置已变化')
  for(const op of [{op:'set',path:['stateDir'],value:'wrong'},{op:'set',path:['admissionContextMaxPages'],value:0},{op:'set',path:['admissionContextTimeoutMs'],value:1.1}])expect(()=>deployment.mutate([op],1)).toThrow()
  expect(()=>deployment.mutate([{op:'set',path:['promptMaxChars'],value:2000},{op:'set',path:['admissionContextMaxPages'],value:0}],1)).toThrow()
  expect(deployment.value.promptMaxChars).toBe(1000);expect(deployment.current().revision).toBe(1)
  await runtime.close();runtime=new DurableRuntime({directory,transport:{}});agent=new Superagent(runtime,{},projects);deployment=agent.deployment
  expect(deployment.value.promptMaxChars).toBe(1000)
  deployment.mutate([{op:'unset',path:['promptMaxChars']}],1)
  agent.prompts.save({...agent.prompts.current().config,communication:'x'.repeat(1100)},0)
  expect(deployment.view().user).toEqual({});expect(deployment.current().revision).toBe(2)
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
it('uses configured context pages and deadlines with the DSH window, isolates projects, and marks incomplete reads',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-admission-')),runtime=new DurableRuntime({directory,transport:{}})
 try{
  const agent=new Superagent(runtime,{},projects)
  for(let n=0;n<65;n++){
   const id='message-'+String(n).padStart(3,'0');agent.message(id,'p','user',{text:'text '+n})
   runtime.engine.receive({id,source:'local',threads:[{source:'local',id:'thread'}],actor:{source:'local',id:'local-user'},human:true,at:new Date(1700000000000+n).toISOString(),text:'text '+n,meta:{project:'p'}})
  }
  let limits={admissionContextMaxPages:1,admissionContextTimeoutMs:15000}
  const one=await localAdmissionContext(runtime.store,'p',['message-064'],limits)
  expect(one[0].pages).toBe(1);expect(one[0].complete).toBe(false);expect(one[0].window.loaded_messages).toBe(50);expect(one[0].window.source_found).toBe(false)
  limits={...limits,admissionContextMaxPages:2}
  const two=await localAdmissionContext(runtime.store,'p',['message-064'],limits)
  expect(two[0].pages).toBe(2);expect(two[0].complete).toBe(true);expect(two[0].window.loaded_messages).toBe(65);expect(two[0].window.source_found).toBe(true)
  expect(two[0].window.entries.map(e=>e.position)).toEqual([1,2,3,4,5,60,61,62,63,64,65])
  expect(await localAdmissionContext(runtime.store,'other',['message-064'],limits)).toEqual([])
  let clock=0
  const timed=await localAdmissionContext(runtime.store,'p',['message-064'],{...limits,admissionContextTimeoutMs:1},{now:()=>clock,readPage:async()=>{clock=2;return []}})
  expect(timed[0].status).toBe('context-timeout');expect(timed[0].complete).toBe(false)
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
