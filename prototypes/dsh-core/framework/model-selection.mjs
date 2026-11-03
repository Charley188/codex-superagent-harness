/** DSH per-session selection semantics adapted to the Codex catalog and owned SQLite state. */
import {execFile} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {require} from './contracts.mjs'
export const modelKey=(project,target='')=>'sa.model:'+JSON.stringify([project,target])
export function modelSelection(host,loadCatalog=null){
 let cached,pending,at=0
 const catalog=async()=>{
  if(loadCatalog)return loadCatalog()
  if(cached&&Date.now()-at<60000)return cached
  if(!pending)pending=new Promise((resolve,reject)=>execFile('python',['-B',fileURLToPath(new URL('./model_catalog.py',import.meta.url))],{windowsHide:true,timeout:40000,maxBuffer:1024*1024},(error,out)=>{if(error)return reject(Error('无法获取 Codex 模型列表，请检查本机登录与兼容性。'));try{cached=JSON.parse(out);at=Date.now();resolve(cached)}catch(e){reject(e)}})).finally(()=>{pending=null})
  return pending
 }
 const scope=(project,target)=>{host.agent.project(project);require(typeof target==='string','Invalid conversation');if(target.startsWith('chat:'))host.chats.own(project,target.slice(5));else if(target)host.agent.owns(project,target)}
 const view=async(project,target)=>{scope(project,target);const data=await catalog();return {...data,selection:host.runtime.store.get(modelKey(project,target))??{revision:0,value:null}}}
 return {view,save:async({project,target='',revision,value})=>{
  scope(project,target);const data=await catalog()
  if(value!==null){const m=data.models.find(m=>m.model===value?.model);require(m,'模型当前不可用');require(Object.keys(value).sort().join(',')==='effort,model,serviceTier','Invalid model selection');require(m.supportedReasoningEfforts.some(e=>e.reasoningEffort===value.effort),'推理强度不受该模型支持');require(value.serviceTier==='default'||m.serviceTiers.some(t=>t.id===value.serviceTier),'速度档位不受该模型支持')}
  const key=modelKey(project,target)
  host.runtime.store.atomic(()=>{const old=host.runtime.store.get(key)??{revision:0,value:null};require(old.revision===revision,'配置已在其他窗口修改，请重新打开后选择');const next={revision:revision+1,value};host.runtime.store.set(key,next);host.runtime.audit({type:'human.model.selection',project,target,...next})})
  return view(project,target)
 }}
}
