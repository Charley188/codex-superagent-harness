import {useEffect,useRef,useState} from 'react'
import {request} from './host-api.ts'
import {ConversationHeader} from './upstream-harness/packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx'
import css from './upstream-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css'
import {Button} from '../vendor/dsh/src/client/controls.tsx'
import {previewField} from './stream-text.ts'
import {ModelPicker} from './model-picker.tsx'

const states={running:'执行中',completed:'已完成',applied:'已完成',failed:'失败',cancelled:'已取消',uncertain:'等待核查',invalid:'需要处理',reconciled:'已核查'}
function Report({report}:{report:any}){
 if(!report)return null
 return <><p>{report.summary}</p>{['findings','changes','checks','limitations'].map(k=>report[k]?.length>0&&<details key={k}><summary>{{findings:'具体发现',changes:'变更',checks:'检查',limitations:'局限'}[k]}</summary><pre>{typeof report[k]==='string'?report[k]:JSON.stringify(report[k],null,2)}</pre></details>)}</>
}
export function Conversation({project,ticket,onPanel,onRefresh}:{project:string,ticket:string,onPanel:()=>void,onRefresh:()=>void}){
 const chat=ticket.startsWith('chat:')?ticket.slice(5):'',worker=!!ticket&&!chat
 const scope='project='+encodeURIComponent(project)+(chat?'&chat='+encodeURIComponent(chat):ticket?'&ticket='+encodeURIComponent(ticket):'')
 const [data,setData]=useState<any>(null),[failure,setFailure]=useState(''),[busy,setBusy]=useState(false),[view,setView]=useState('chat')
 const [text,setText]=useState(()=>sessionStorage.getItem('sa-draft:'+project+':'+ticket)??'')
 const [messages,setMessages]=useState<any[]>([]),[more,setMore]=useState(false),[events,setEvents]=useState<any[]>([]),[eventError,setEventError]=useState('')
 const [call,setCall]=useState(''),pending=useRef<{key:string,id:string}|null>(null),bottom=useRef<HTMLDivElement>(null),nearBottom=useRef(true)
 const generation=useRef(0)
 const olderLoaded=useRef(false)
 useEffect(()=>{sessionStorage.setItem('sa-draft:'+project+':'+ticket,text)},[text,project,ticket])
 const merge=(rows:any[])=>setMessages(old=>[...new Map([...old,...rows].map(m=>[m.seq,m])).values()].sort((a,b)=>a.seq-b.seq))
 useEffect(()=>{
  const id=++generation.current;let stopped=false,timer:any
  const poll=async()=>{try{const value=await request('/api/harness?'+scope);if(stopped||id!==generation.current)return
   setData(value);merge(value.messages);if(!olderLoaded.current)setMore(value.hasMore);setFailure('')
  }catch(e){if(!stopped)setFailure(e.message)}finally{if(!stopped)timer=setTimeout(poll,1500)}}
  void poll();return()=>{stopped=true;clearTimeout(timer)}
 },[scope])
 useEffect(()=>{if(nearBottom.current)bottom.current?.scrollIntoView({block:'end'})},[messages,events.length])
 const execution=call||data?.executions?.[0]?.id||''
 useEffect(()=>{
  let stopped=false,timer:any,offset=0;setEvents([]);setEventError('')
  if(!execution)return
  const poll=async()=>{try{const value=await request('/api/harness/events?'+scope+'&call='+execution+'&offset='+offset);if(stopped)return
   offset=value.offset;setEvents(old=>[...old,...value.events].slice(-1000));setEventError(value.legacy?'此历史回合由旧版执行器完成；对话和交付记录仍保留。':'')
   if(value.more||value.state==='running')timer=setTimeout(poll,value.more?50:600)
  }catch(e){if(!stopped)setEventError(e.message)}}
  void poll();return()=>{stopped=true;clearTimeout(timer)}
 },[scope,execution])
 const send=async()=>{
  if(busy||!text.trim())return
  setBusy(true);setFailure('')
  const key=JSON.stringify([project,ticket,text]);if(pending.current?.key!==key)pending.current={key,id:crypto.randomUUID()}
  try{await request(chat?'/api/chats/message':'/api/message',{id:pending.current.id,project,...chat?{chat}:{ticket_id:ticket||null},text});pending.current=null;setText('');nearBottom.current=true
   const value=await request('/api/harness?'+scope);setData(value);merge(value.messages);onRefresh()
  }catch(e){setFailure(e.message)}finally{setBusy(false)}
 }
 const older=async()=>{try{const value=await request('/api/harness?'+scope+'&before='+messages[0].seq);olderLoaded.current=true;merge(value.messages);setMore(value.hasMore)}catch(e){setFailure(e.message)}}
 const selected=data?.tickets.find(t=>t.ticket_id===ticket),active=data?.executions.find(t=>t.state==='running')
 const snapshot={blank:false,running:!!active,awaitingFirstTurn:false}
 const title=chat?data?.title??'新会话':ticket?selected?.title??'Worker 会话':'Superagent 主 Session'
 const streamText=previewField(events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta??'').join(''),worker?'summary':'reply')
 return <section className={css.root+' sa-conversation'} aria-label="会话界面">
  <ConversationHeader sessionId={data?.session_id??'pending'} useSession={(fn:any)=>fn(snapshot)} useConversation={(fn:any)=>fn({activeTargets:new Set()})} renderSlot={(slot:string)=>slot==='conversation.header.leading'?null:<div className="sa-chat-header"><strong>{title}</strong><small>{chat?'Codex':worker?'Codex Worker':'Codex Router'}</small><div className="sa-chat-tabs"><button aria-pressed={view==='chat'} onClick={()=>setView('chat')}>对话</button><button aria-pressed={view==='trace'} onClick={()=>setView('trace')}>轨迹</button></div></div>} />
  <div className="sa-chat-scroll" onScroll={e=>{const x=e.currentTarget;nearBottom.current=x.scrollHeight-x.scrollTop-x.clientHeight<100}}>
   <div className="sa-chat-width">
    {view==='chat'?<>
     {more&&<Button size="sm" onClick={()=>void older()}>加载更早的消息</Button>}
     {!messages.length&&<div className="sa-empty"><h2>{worker?'查看执行与交付':'今天想完成什么？'}</h2><p>{chat?'这是普通 Codex 对话。需要多人分工时可打开 Superagent 主 Session。':worker?'追问将发给这项任务的 Worker。':'向 Router 描述目标，它会按需要组织 Worker 协作。'}</p></div>}
     {messages.map(m=><article key={m.seq} className={'sa-message '+(m.origin==='user'?'sa-user':'')}><small>{m.origin==='user'?'你':m.origin==='router'?'Router':m.origin==='worker'?'Worker':m.origin==='codex'?'Codex':m.origin}{m.origin==='user'&&!m.processed?' · 已排队':''}</small>
      {m.body.text&&<p>{m.body.text}</p>}<Report report={m.body.report}/>{m.body.error&&<p className="sa-error">{m.body.error}</p>}
      {!m.body.text&&!m.body.report&&!m.body.error&&<details><summary>执行记录</summary><pre>{JSON.stringify(m.body,null,2)}</pre></details>}
      {m.body.ticket_id&&!ticket&&<button className="sa-link" onClick={()=>window.dispatchEvent(new CustomEvent('codex-compose',{detail:{project,ticket_id:m.body.ticket_id}}))}>打开 Worker 会话 →</button>}
     </article>)}
     {active&&<div className="sa-running" role="status">Codex 正在执行… <button className="sa-link" onClick={()=>setView('trace')}>查看实时轨迹</button></div>}
     {active&&streamText&&<article className="sa-message" aria-label="实时回复"><small>{chat?'Codex':worker?'Worker':'Router'} · 正在回复</small><p>{streamText}</p></article>}
     {!chat&&data?.executions[0]?.error&&<div className="sa-error" role="alert"><p>{data.executions[0].error}</p><button className="sa-link" onClick={()=>setView('trace')}>查看执行记录</button></div>}
     {chat&&data?.executions[0]?.state==='failed'&&<div className="sa-error"><p>{data.executions[0].error}</p><Button onClick={()=>void request('/api/chats/retry',{project,chat}).then(onRefresh).catch(e=>setFailure(e.message))}>重试失败回合</Button></div>}
     {selected?.workspace&&<details><summary>交付文件</summary><p>{selected.workspace}</p><ul>{selected.artifacts.map(a=><li key={a.path}>{a.path}</li>)}</ul><Button size="sm" onClick={onPanel}>前往 Superagent 验收</Button></details>}
    </>:<>
     <label>执行回合 <select aria-label="执行回合" value={execution} onChange={e=>setCall(e.target.value)}>{data?.executions.map(r=><option key={r.id} value={r.id}>{states[r.state]??r.state} · {r.id.slice(0,8)}</option>)}</select></label>
     {eventError&&<p>{eventError}</p>}{data?.executions.find(r=>r.id===execution)?.error&&<p className="sa-error">{data.executions.find(r=>r.id===execution).error}</p>}
     {events.map((e,i)=><details className="sa-event" key={i}><summary>{e.method}{e.params?.item?.type?' · '+e.params.item.type:''}</summary><pre>{JSON.stringify(e.params,null,2)}</pre></details>)}
     {!events.length&&!eventError&&<p>暂无执行事件。开始任务后将在这里显示。</p>}
    </>}
    <div ref={bottom}/>
   </div>
  </div>
  <div className="sa-composer-wrap"><div className="sa-composer">
   {failure&&<p className="sa-error" role="alert">{failure}</p>}
   {data?.budget===0&&<p className="sa-error" role="status">执行预算已用完，排队消息仍会保留。<Button size="sm" onClick={()=>void request('/api/budgets/add',{role:chat?'chat':worker?'worker':'router',amount:20}).then(onRefresh).catch(e=>setFailure(e.message))}>补充 20 轮</Button></p>}
   <textarea id="sa-chat-input" aria-label="目标或追问" placeholder={worker?'向这个 Worker 追问或补充要求':chat?'发消息':'发消息或创建任务'} value={text} maxLength={4000} disabled={busy||!!selected?.ended} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send()}}}/>
   <div className="sa-composer-footer"><small>{selected?.ended?'任务已结束，请向 Router 提出新请求':data?.paused?'任务已暂停 · 消息将保留在队列':'Enter 发送 · Shift+Enter 换行'}</small><ModelPicker key={project+':'+ticket} project={project} target={ticket}/><Button variant="primary" disabled={busy||!text.trim()||!!selected?.ended} onClick={()=>void send()}>发送</Button></div>
  </div></div>
 </section>
}
