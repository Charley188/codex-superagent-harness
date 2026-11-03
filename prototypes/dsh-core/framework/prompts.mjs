/** Codex role composition behind the original DSH prompt editor and version protocol. */
import {Versions} from '../vendor/dsh/src/app/versions.ts'
import {family} from '../vendor/dsh/src/kv.ts'
import {hash} from '../src/durable-runtime.mjs'
import {require} from './contracts.mjs'
import {promptParts as parts,roleKeys,fill} from './prompts/parts.mjs'
import {defaultPrompts} from './prompts/team.mjs'
const sections=['communication','scope','delivery']
const heads={communication:'Communication',scope:'Ticket scope',delivery:'Delivery requirements'}
const conflict=()=>Object.assign(Error('提示词版本已变化，请合并最新版本后保存。'),{status:409})
export class Prompts{
 constructor(store,directory,maxChars=()=>100000){
  this.store=store;this.directory=directory;this.limit=maxChars
  this.versions=new Versions(store,'codex.prompts.current',family('codex.prompts.version:'))
  for(const part of parts)if(store.get('codex.prompts.base.'+part.base)===undefined)store.set('codex.prompts.base.'+part.base,part.text)
  store.atomic(()=>{
   if(store.get('codex.prompts.team-defaults-v1'))return
   if(!this.versions.current()){
    const legacy=!!store.get('sa.schema')
    this.versions.keep({revision:0,previousRevision:null,savedAt:'',source:'defaults',config:legacy?{communication:'',scope:'',delivery:'',skills:{}}:defaultPrompts()})
    if(legacy)this.versions.save(revision=>({revision,previousRevision:0,savedAt:new Date().toISOString(),source:'upgrade:team-defaults-v1',config:defaultPrompts()}))
   }
   store.set('codex.prompts.team-defaults-v1',true)
  })
 }
 get maxChars(){return this.limit()}
 current(){return this.versions.current()??this.versions.get(0)}
 version(revision){require(Number.isInteger(revision)&&revision>=0,'Invalid prompt revision');const value=this.versions.get(revision);require(value,'Unknown prompt revision');return value}
 validate(value){
  require(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>[...sections,'skills','overrides'].includes(k)),'Invalid prompt config')
  require(sections.every(k=>typeof value[k]==='string'),'Prompt team sections must be text')
  require(value.skills&&typeof value.skills==='object'&&!Array.isArray(value.skills)&&Object.keys(value.skills).length<=20,'Invalid prompt skills')
  for(const [name,text] of Object.entries(value.skills))require(/^[a-z][a-z0-9-]{0,63}$/.test(name)&&!['github','feishu'].includes(name)&&typeof text==='string','Invalid prompt skill')
  require(value.overrides===undefined||(value.overrides&&typeof value.overrides==='object'&&!Array.isArray(value.overrides)),'Invalid prompt overrides')
  const overrides={}
  for(const [key,entry] of Object.entries(value.overrides??{})){
   const part=parts.find(p=>p.key===key);require(part,'Unknown Codex prompt part')
   require(entry&&typeof entry==='object'&&Object.keys(entry).every(k=>['text','base'].includes(k))&&typeof entry.text==='string'&&entry.text.trim()&&(entry.base===undefined||typeof entry.base==='string'&&entry.base.length<=100),'Invalid prompt override')
   const missing=(part.placeholders??[]).filter(p=>!entry.text.includes(p));require(!missing.length,'提示词模板缺少占位符：'+missing.join(', '))
   if(entry.text!==part.text)overrides[key]={text:entry.text,base:entry.base??this.current().config.overrides?.[key]?.base??part.base}
  }
  const config={...Object.fromEntries(sections.map(k=>[k,value[k]])),skills:{...value.skills},...Object.keys(overrides).length?{overrides}:{}}
  require(JSON.stringify(config).length<=this.maxChars,'提示词配置超过 '+this.maxChars+' 字符限制')
  return config
 }
 compose(config,role){
  const key=roleKeys[role];require(key,'Unknown prompt role')
  const builtIn=key=>config.overrides?.[key]?.text??parts.find(p=>p.key===key).text
  const fixed=key=>({name:key,key,kind:'fixed',text:builtIn(key)})
  const items=[fixed('runtime/shared'),fixed(key)]
  for(const name of sections)items.push({name,kind:'team',heading:'## '+heads[name],text:config[name]?'## '+heads[name]+'\n'+config[name]:''})
  for(const name of ['subscriptions','replies',...(role==='router'?['dispatch','admission']:role==='worker'?['work']:[])])items.push(fixed('runtime/'+name))
  if(role!=='watchdog')items.push(fixed('runtime/handoff/'+(role==='router'?'orchestrator':'worker')))
  const variables=JSON.stringify({stateDir:this.directory,permissions:'registered capabilities only',external_channels:false,model:'Codex local configuration'})
  items.push({name:'runtime/environment',key:'runtime/environment',kind:'generated',text:fill(builtIn('runtime/environment'),{variables})})
  for(const [name,text] of Object.entries(config.skills))items.push({name:'skill/'+name,kind:'team',heading:'## Team instruction: '+name,text:'## Team instruction: '+name+'\n'+text})
  if(role==='router')items.push({name:'runtime/policy',key:'runtime/policy/none',kind:'generated',text:fill(builtIn('runtime/policy/none'),{version:'local-explicit-v1',mode:'explicit-only'})})
  return items
 }
 preview(value){
  const config=this.validate(value),composed={orchestrator:this.compose(config,'router'),worker:this.compose(config,'worker'),watchdog:this.compose(config,'watchdog')}
  return {...Object.fromEntries(Object.entries(composed).map(([k,v])=>[k,v.map(p=>p.text).filter(Boolean).join('\n\n')])),parts:composed,skills:{...Object.fromEntries(['github','feishu'].map(name=>[name,config.overrides?.['skill/'+name]?.text??parts.find(p=>p.key==='skill/'+name).text])),...config.skills},
   scope:'按 DSH 分段组装，环境和当前策略由宿主填充。任务合同、权限、结构化输出及当轮消息另行追加，提示词不能扩大权限。当前仅本地明确请求：有规则策略模板、GitHub/飞书技能可编辑预览，因对应功能尚未接通，不注入运行请求。团队技能随请求提供，不注册原生工具。'}
 }
 snapshot(role){const current=this.current(),text=this.compose(current.config,role).map(p=>p.text).filter(Boolean).join('\n\n');return {role,revision:current.revision,text,sha256:hash(text)}}
 save(value,baseRevision){
  const config=this.validate(value)
  return this.store.atomic(()=>{
   const previous=this.current();if(baseRevision!==previous.revision)throw conflict()
   if(previous.revision===0&&!this.versions.get(0))this.versions.keep(previous)
   const saved=this.versions.save(revision=>({revision,previousRevision:previous.revision,savedAt:new Date().toISOString(),source:'panel',config}))
   return {revision:saved.revision,effect:'next-request',context_delivery:'pending'}
  })
 }
 view({revision,offset=0}={}){
  require(Number.isInteger(offset)&&offset>=0,'Invalid prompt history cursor')
  const current=revision===undefined?this.current():this.version(revision),latest=this.current()
  const history=[...this.versions.list(),...this.versions.get(0)?[]:[this.version(0)]].sort((a,b)=>b.revision-a.revision)
  const config=current.config
  const changed=(a,b)=>{
   const flatten=x=>({...Object.fromEntries(sections.map(k=>[k,x[k]])),...Object.fromEntries(Object.entries(x.skills).map(([k,v])=>['skill/'+k,v])),...Object.fromEntries(Object.entries(x.overrides??{}).map(([k,v])=>['part/'+k,JSON.stringify(v)]))})
   const x=flatten(a),y=flatten(b);return [...new Set([...Object.keys(x),...Object.keys(y)])].filter(k=>x[k]!==y[k])
  }
  const revisions=history.slice(offset,offset+20).map(({config,...summary})=>({...summary,changed:summary.previousRevision===null?[]:changed(config,this.version(summary.previousRevision).config)}))
  const sessions=[];const seen=new Set()
  for(const [table,column] of [['sa_call','response'],['codex_turn','result'],['sa_watch','response']]){
   if(!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue
   for(const row of this.store.db.prepare(`SELECT json_extract(${column},'$.session_id') AS sessionId,json_extract(request,'$.prompt.revision') AS revision FROM ${table} WHERE json_type(request,'$.prompt') IS NOT NULL ORDER BY rowid DESC LIMIT 200`).all()){
    if(row.sessionId&&!seen.has(row.sessionId)){sessions.push({sessionId:row.sessionId,revision:row.revision});seen.add(row.sessionId)}
   }
  }
  return {masterId:'codex-prompts-'+hash(this.directory).slice(0,16),revision:latest.revision,current,defaults:defaultPrompts(),sections,builtin:['github','feishu'],skillPrefix:'codex-superagent-',skillName:'^[a-z][a-z0-9-]{0,63}$',parts,
   defaultChanged:Object.entries(config.overrides??{}).filter(([k,v])=>v.base!==parts.find(p=>p.key===k)?.base).map(([part,v])=>({part,base:v.base,previous:this.store.get('codex.prompts.base.'+v.base)})),
   revisions,next_offset:offset+revisions.length<history.length?offset+revisions.length:null,sessions}
 }
}
