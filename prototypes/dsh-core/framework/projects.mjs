import {realpathSync,statSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {isAbsolute,relative,parse,join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {hash} from '../src/durable-runtime.mjs'
import {require} from './contracts.mjs'
const here=fileURLToPath(new URL('.',import.meta.url))
const beneath=(a,b)=>{const r=relative(a,b);return !r||(!r.startsWith('..')&&!isAbsolute(r))}
export function attachProjects(agent){
  const saved=agent.store.get('sa.workspace.projects')??[]
  for(const p of saved){require(!agent.projects.some(x=>x.id===p.id),'Duplicate saved project');agent.projects.push(p)}
  agent.addProject=({name,root})=>{
    require(typeof name==='string'&&name.trim()&&name.length<=100,'请输入 1–100 字的项目名称')
    require(typeof root==='string'&&isAbsolute(root),'请输入工作文件夹的绝对路径')
    const canonical=realpathSync(root);require(statSync(canonical).isDirectory(),'工作路径必须是文件夹')
    require(canonical!==parse(canonical).root,'不能把整个磁盘作为项目')
    const base=fileURLToPath(new URL('../../../',import.meta.url)),config=JSON.parse(readFileSync(join(base,'config.local.json'),'utf8'))
    const forbidden=[base,...Object.values(config.repositories).map(r=>r.root)]
    require(!forbidden.some(p=>beneath(canonical,resolve(p))||beneath(resolve(p),canonical)),'该目录与框架或已登记资料范围重叠，请选择独立项目文件夹')
    require(!agent.projects.some(p=>p.root&& (beneath(p.root,canonical)||beneath(canonical,p.root))),'该文件夹已登记或与现有项目重叠')
    const id='project-'+randomUUID(),repo='workspace-'+id
    const p={id,description:name.trim(),root:canonical,created_at:new Date().toISOString(),capabilities:['read-only','artifact-write'].map((permission,i)=>({id:i?'create':'review',repo_id:repo,permission,
      description:i?'根据项目资料生成交付文件到隔离工作区':'读取项目资料并分析；范围和遗漏见项目上下文',inputs:[{path:'project-context.json',sha256:hash(canonical)}]}))}
    agent.store.atomic(()=>{agent.store.set('sa.workspace.projects',[...(agent.store.get('sa.workspace.projects')??[]),p]);agent.runtime.audit({type:'human.project.created',id,root:canonical,name:p.description})})
    agent.projects.push(p);return {id,name:p.description,root:p.root}
  }
  agent.prepareProjectCapability=(project,cap)=>{
    const p=agent.project(project);if(!p.root)return cap
    const captured=spawnSync('python',['-B',join(here,'project_inputs.py'),'capture',p.root],{encoding:'utf8',windowsHide:true,maxBuffer:900000,timeout:15000})
    require(captured.status===0,'无法准备项目资料：'+(captured.stderr||captured.error||''))
    const content=captured.stdout;JSON.parse(content)
    // Runtime's persistent location is supplied explicitly by the host.
    require(agent.hostDirectory,'Project host directory missing')
    const name=randomUUID()+'/project-context.json',out=join(agent.hostDirectory,'project-inputs',p.id,name)
    mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,content,{flag:'wx'})
    return {...cap,inputs:[{path:name,sha256:hash(content)}]}
  }
}
