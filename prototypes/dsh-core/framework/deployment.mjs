/** DSH deployment limits, persisted behind the original ConfigPageForm protocol. */
import {Versions} from '../vendor/dsh/src/app/versions.ts'
import {family} from '../vendor/dsh/src/kv.ts'
import {LIMITS} from '../vendor/dsh/src/limits.ts'
import {require} from './contracts.mjs'
export const deploymentDefaults={promptMaxChars:100000,admissionContextMaxPages:10,admissionContextTimeoutMs:15000}
export class Deployment {
 constructor(store){this.store=store;this.versions=new Versions(store,'codex.deployment.current',family('codex.deployment.version:'))}
 current(){return this.versions.current()??{revision:0,user:{},savedAt:null}}
 get value(){return {...deploymentDefaults,...this.current().user}}
 view(){const current=this.current();return {status:'ready',writable:true,revision:current.revision,value:this.value,base:deploymentDefaults,user:current.user}}
 mutate(ops,revision){return this.store.atomic(()=>{
  const current=this.current()
  if(revision!==current.revision)throw Object.assign(Error('部署配置已变化，请合并最新版本后保存。'),{status:409})
  require(Array.isArray(ops)&&ops.length>0&&ops.length<=3,'Invalid deployment operations')
  const user={...current.user},seen=new Set()
  for(const op of ops){
   require(op&&['set','unset'].includes(op.op)&&Array.isArray(op.path)&&op.path.length===1&&Object.hasOwn(deploymentDefaults,op.path[0])&&!seen.has(op.path[0])&&Object.keys(op).every(k=>['op','path',...op.op==='set'?['value']:[]].includes(k)),'Unknown deployment field or operation')
   const key=op.path[0];seen.add(key)
   if(op.op==='unset')delete user[key]
   else{const range=LIMITS[key];require(Number.isInteger(op.value)&&op.value>=range.min&&op.value<=range.max,`${key} 必须为 ${range.min}–${range.max} 的整数`);user[key]=op.value}
  }
  if(current.revision===0&&!this.versions.get(0))this.versions.keep(current)
  this.versions.save(revision=>({revision,user,savedAt:new Date().toISOString()}))
  return this.view()
 })}
}
