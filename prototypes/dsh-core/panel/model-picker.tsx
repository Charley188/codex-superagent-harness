import {useEffect,useState} from 'react'
import {request} from './host-api.ts'
export function ModelPicker({project,target}:{project:string,target:string}){
 const [data,setData]=useState<any>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[draft,setDraft]=useState<any>(null)
 useEffect(()=>{let alive=true;setData(null);setOpen(false);setError('');request('/api/models?project='+encodeURIComponent(project)+'&target='+encodeURIComponent(target)).then(v=>{if(alive){setData(v);setDraft(v.selection.value??v.defaults)}}).catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[project,target])
 const current=data?.selection.value??data?.defaults,model=data?.models.find(m=>m.model===draft?.model)
 const save=async(value)=>{setBusy(true);setError('');try{const v=await request('/api/models',{project,target,revision:data.selection.revision,value});setData(v);setDraft(v.selection.value??v.defaults);setOpen(false)}catch(e){setError(e.message)}finally{setBusy(false)}}
 return <div className="sa-model-picker" onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);e.stopPropagation()}}}>
  <button type="button" className="sa-model-trigger" aria-label="选择模型和推理强度" aria-expanded={open} onClick={()=>setOpen(!open)}>{current?`${current.model} · ${current.effort} · ${current.serviceTier==='priority'?'Fast':current.serviceTier}`:error?'模型加载失败':'加载模型…'} ▾</button>
  {open&&<div className="sa-model-menu" role="dialog" aria-label="当前会话模型设置"><strong>当前会话</strong>{error&&<p role="alert" className="sa-error">{error}</p>}{data&&<>
   <label>模型<select aria-label="模型" disabled={busy} value={draft.model} onChange={e=>{const m=data.models.find(m=>m.model===e.target.value);setDraft({model:m.model,effort:m.defaultReasoningEffort,serviceTier:'default'})}}>{data.models.map(m=><option key={m.model} value={m.model}>{m.displayName}</option>)}</select></label>
   <label>推理强度<select aria-label="推理强度" disabled={busy} value={draft.effort} onChange={e=>setDraft({...draft,effort:e.target.value})}>{model?.supportedReasoningEfforts.map(e=><option key={e.reasoningEffort} value={e.reasoningEffort}>{e.reasoningEffort}</option>)}</select></label>
   <label>速度<select aria-label="速度" disabled={busy} value={draft.serviceTier} onChange={e=>setDraft({...draft,serviceTier:e.target.value})}><option value="default">Default</option>{model?.serviceTiers.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
   <p>下一回合生效。当前执行不变。Fast 可能增加额度消耗。</p><button type="button" disabled={busy} onClick={()=>void save(draft)}>{busy?'保存中…':'应用'}</button><button type="button" disabled={busy} onClick={()=>void save(data.defaults)}>使用本机默认值</button>
  </>}</div>}
 </div>
}
