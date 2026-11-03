import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {DurableRuntime} from '../src/durable-runtime.mjs'
import {Prompts} from '../framework/prompts.mjs'
it('loads substantive defaults into every role and upgrades unsaved legacy blanks without rewriting history or custom edits',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-team-defaults-')),runtime=new DurableRuntime({directory,transport:{}})
 try{
  runtime.store.set('sa.schema',1)
  const prompts=new Prompts(runtime.store,directory),view=prompts.view()
  expect(view.revision).toBe(1);expect(prompts.version(0).config.communication).toBe('')
  for(const section of view.sections){
   expect(view.defaults[section].length).toBeGreaterThan(500)
   for(const role of ['router','worker','watchdog'])expect(prompts.snapshot(role).text).toContain(view.defaults[section])
  }
  expect(view.parts.every(p=>p.text.trim().length>0)).toBe(true)
  expect(new Prompts(runtime.store,directory).current().revision).toBe(1)
  prompts.save({...view.current.config,communication:'CUSTOM',scope:''},1)
  runtime.store.delete('codex.prompts.team-defaults-v1')
  const reopened=new Prompts(runtime.store,directory)
  expect(reopened.current().revision).toBe(2);expect(reopened.current().config.communication).toBe('CUSTOM');expect(reopened.current().config.scope).toBe('')
  // Each active section must reach exactly its declared roles; inactive source/policy templates stay preview-only.
  for(const part of view.parts.filter(p=>!p.key.startsWith('skill/')&&p.key!=='runtime/policy')){
   const marker='SECTION_'+part.key,config={...view.defaults,overrides:{[part.key]:{text:part.text+'\n'+marker}}}
   const preview=prompts.preview(config)
   for(const role of ['orchestrator','worker','watchdog'])expect(preview[role].includes(marker)).toBe(part.roles.includes(role))
  }
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
it('exposes DSH sections, validates template placeholders and composes edited parts into real immutable snapshots',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-prompt-parts-')),runtime=new DurableRuntime({directory,transport:{}})
 try{
  const prompts=new Prompts(runtime.store,directory),config=prompts.current().config,view=prompts.view()
  expect(view.parts).toHaveLength(16)
  for(const part of view.parts){
   const changed={...config,overrides:{[part.key]:{text:part.text+'\nPART_TEST_'+part.key}}}
   expect(()=>prompts.validate(changed)).not.toThrow()
   if(part.placeholders)expect(()=>prompts.validate({...config,overrides:{[part.key]:{text:'Missing placeholders'}}})).toThrow('占位符')
  }
  const next={...config,overrides:{'runtime/shared':{text:'SHARED_EDIT'},'runtime/environment':{text:'ENV_EDIT {variables}'},'runtime/policy/none':{text:'POLICY_EDIT {version} {mode}'},'skill/github':{text:'INACTIVE_GITHUB'}}}
  const before=prompts.snapshot('router');prompts.save(next,0)
  const after=prompts.snapshot('router'),preview=prompts.preview(next)
  expect(after.text).toContain('SHARED_EDIT');expect(after.text).toContain('ENV_EDIT');expect(after.text).toContain(JSON.stringify(directory));expect(after.text).toContain('POLICY_EDIT local-explicit-v1 explicit-only')
  expect(after.text).not.toContain('{variables}');expect(after.text).not.toContain('INACTIVE_GITHUB');expect(preview.skills.github).toBe('INACTIVE_GITHUB')
  expect(preview.orchestrator).toBe(after.text);expect(before.text).not.toContain('SHARED_EDIT')
  expect(prompts.snapshot('worker').text).toContain('SHARED_EDIT');expect(prompts.snapshot('worker').text).not.toContain('POLICY_EDIT')
  expect(()=>prompts.validate({...config,skills:{github:'reserved'}})).toThrow('Invalid prompt skill')
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
it('versions prompt changes, preserves request snapshots, supports preview/restoration and persists history',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-prompts-'));let runtime=new DurableRuntime({directory,transport:{}})
 try{
  let prompts=new Prompts(runtime.store,directory)
  const before=prompts.snapshot('worker'),initial=prompts.view()
  expect(initial.current.revision).toBe(0);expect(initial.revisions).toHaveLength(1)
  const config={...initial.defaults,communication:'Use marker CONFIG_A',skills:{review:'Distinguish evidence from claims.'}}
  prompts.save(config,0)
  const after=prompts.snapshot('worker');expect(after.text).toContain('CONFIG_A');expect(after.text).toContain('Distinguish evidence')
  expect(before.text).not.toContain('CONFIG_A');expect(before.revision).toBe(0);expect(after.revision).toBe(1)
  expect(prompts.preview(config).worker).toBe(after.text)
  expect(()=>prompts.save(config,0)).toThrow('版本已变化')
  expect(prompts.view().revisions.map(r=>r.revision)).toEqual([1,0])
  prompts.save(prompts.version(0).config,1);expect(prompts.snapshot('worker').text).toBe(before.text)
  await runtime.close();runtime=new DurableRuntime({directory,transport:{}});prompts=new Prompts(runtime.store,directory)
  expect(prompts.view().revision).toBe(2);expect(prompts.view({revision:1}).current.config.communication).toBe('Use marker CONFIG_A')
  expect(prompts.snapshot('worker').revision).toBe(2)
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
it('rejects unknown sections, oversized/empty built-in overrides and keeps roles separate',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sa-prompt-validation-')),runtime=new DurableRuntime({directory,transport:{}})
 try{
  const prompts=new Prompts(runtime.store,directory),config=prompts.current().config
  expect(()=>prompts.save({...config,unknown:'ignored'},0)).toThrow('Invalid prompt config')
  expect(()=>prompts.save({...config,scope:'x'.repeat(100001)},0)).toThrow('字符限制')
  expect(()=>prompts.save({...config,overrides:{'runtime/worker':{text:''}}},0)).toThrow('Invalid prompt override')
  expect(()=>prompts.save({...config,overrides:{'runtime/fake':{text:'x'}}},0)).toThrow('Unknown Codex prompt part')
  prompts.save({...config,overrides:{'runtime/watchdog':{text:'WATCH_ONLY'}}},0)
  expect(prompts.snapshot('watchdog').text).toContain('WATCH_ONLY');expect(prompts.snapshot('router').text).not.toContain('WATCH_ONLY')
 }finally{await runtime.close();rmSync(directory,{recursive:true,force:true})}
})
