import {useState} from 'react'
import {Button} from '../vendor/dsh/src/client/controls.tsx'
import {Section,ConfirmButton} from '../vendor/dsh/src/client/widgets.tsx'
import {usePanelData,useAction} from '../vendor/dsh/src/client/provider.tsx'
import {request} from './host-api.ts'
export function CodexTicket({data}:{data:any}){
  const {reload}=usePanelData(),[note,setNote]=useState('')
  const action=useAction(async(accept:boolean)=>{await request('/api/review',{project:data.codex.project,ticket_id:data.id,turn_id:data.codex.turn_id,accept,note});location.reload()},{reload})
  const x=data?.codex;if(!x)return null
  return <Section title="Codex 协作与交付"><div className="cx-ticket">
    <p className="dt-hint">项目 {x.project} · 当前回合 {x.turn_state} {x.review?'· 验收 '+x.review:''}</p>
    {data.state!=='ended'&&<Button size="sm" onClick={()=>window.dispatchEvent(new CustomEvent('codex-compose',{detail:{project:x.project,ticket_id:data.id}}))}>跟进此任务</Button>}
    {x.canReview&&<><ConfirmButton label="验收通过" title="验收交付" message="确认已检查当前回合的交付与验证结果？" onConfirm={()=>action.run(true)}/><label>修正意见<textarea className="dt-textarea" value={note} onChange={e=>setNote(e.target.value)} maxLength={4000}/></label><Button disabled={!note.trim()||action.busy} onClick={()=>void action.run(false)}>要求修正</Button></>}
    {x.workspace&&<details><summary>交付文件</summary><p className="dt-mono">{x.workspace}</p><ul>{x.artifacts.map((a:any)=><li key={a.path}>{a.path}</li>)}</ul></details>}
    {x.jobs.length>0&&<ul>{x.jobs.map((j:any)=><li key={j.id}>{j.profile}：{j.state}</li>)}</ul>}
  </div></Section>
}
