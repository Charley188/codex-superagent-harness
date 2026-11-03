import {it,expect,afterEach} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {DurableRuntime} from '../src/durable-runtime.mjs'
import {Superagent} from '../framework/superagent.mjs'
const roots=[],hosts=[]
const configured=[{id:'test',capabilities:[{id:'read',repo_id:'synthetic-fixture',inputs:[{path:'parallel-a.md',sha256:'a'.repeat(64)}]}]}]
const create=directory=>{const runtime=new DurableRuntime({directory:join(directory,'runtime'),transport:{}});hosts.push(runtime);const agent=new Superagent(runtime,{},configured);agent.hostDirectory=directory;return agent}
afterEach(async()=>{for(const h of hosts.splice(0))await h.close();for(const d of roots.splice(0))rmSync(d,{recursive:true,force:true})})
it('creates a workspace project without a goal and persists a live-access manifest rather than fixed file contents',async()=>{
  const root=mkdtempSync(join(process.env.LOCALAPPDATA,'Temp','sa-project-'));roots.push(root)
  const directory=mkdtempSync(join(tmpdir(),'sa-catalog-'));roots.push(directory)
  writeFileSync(join(root,'note.md'),'SYNTHETIC_NEW_PROJECT')
  const agent=create(directory),project=agent.addProject({name:'新项目',root})
  expect(agent.projects).toHaveLength(2);expect(()=>agent.addProject({name:'duplicate',root})).toThrow('重叠')
  expect(()=>agent.addProject({name:'wrong',root:join(root,'missing')})).toThrow()
  expect(()=>agent.addProject({name:'relative',root:'relative'})).toThrow('绝对路径')
  const cap=agent.prepareProjectCapability(project.id,agent.project(project.id).capabilities[0])
  const snapshot=join(directory,'project-inputs',project.id,cap.inputs[0].path)
  expect(JSON.parse(readFileSync(snapshot,'utf8'))).toMatchObject({root,access:'live-project-tools',version:2})
  expect(readFileSync(snapshot,'utf8')).not.toContain('SYNTHETIC_NEW_PROJECT')
  writeFileSync(join(root,'note.md'),'UPDATED_PROJECT')
  const next=agent.prepareProjectCapability(project.id,agent.project(project.id).capabilities[0])
  expect(next.inputs[0].sha256).not.toBe(cap.inputs[0].sha256)
  const lookup=spawnSync('python',['-B','-c',"import sys,json;from pathlib import Path;sys.path.insert(0,'framework');from project_inputs import repository;print(json.dumps(repository({'repositories':{}},Path(sys.argv[1]),sys.argv[2])))",directory,cap.repo_id],{encoding:'utf8',windowsHide:true})
  expect(lookup.status,lookup.stderr).toBe(0);expect(JSON.parse(lookup.stdout).allow_model_review).toBe(true)
  await agent.runtime.close();hosts.pop()
  const restored=create(directory);expect(restored.project(project.id).root).toBe(root)
  expect(configured).toHaveLength(1)
})
