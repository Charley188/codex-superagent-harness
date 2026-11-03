import {useEffect,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {App} from '../vendor/dsh/src/client/app.tsx'
import {PanelProvider} from '../vendor/dsh/src/client/provider.tsx'
import {Button,Modal} from '../vendor/dsh/src/client/controls.tsx'
import {usePoll} from '../vendor/dsh/src/client/api.ts'
import {zh} from '../vendor/dsh/src/client/locales.ts'
import {request,openSession} from './host-api.ts'
import {Conversation} from './conversation.tsx'
import {useDeploymentForm} from './deployment-form.ts'
import sidebar from './upstream-harness/packages/client/ui-sidebar/src/client/SidebarRoot.module.css'
const overrides={'title':'Codex Superagent','searchPlaceholder':'搜索任务、消息、ID','searchNoneGithub':'没有找到匹配的本地记录。',
 'promptPart.runtime/watchdog':'Watchdog 监督指令','promptRole.watchdog':'Watchdog','promptReadBy.watchdog':'Watchdog 使用此部分。',
 'promptReadBy.skill':'团队技能说明随请求提供；GitHub、飞书内置模板当前未启用，不注入运行请求。均未注册原生工具。',
 'promptReadBy.both':'Router、Worker 和 Watchdog 都会读取团队部分。',
 'promptSavedPending':'已保存，将从后续新请求生效；正在执行的回合保留原版本。',
 'deploymentIntro':'这台机器上的 Codex Superagent 配置保存在本地运行库。限额保存后立即用于后续读取和配置校验，无需重启。',
 'deploymentStateDirHint':'本机工单、会话、锁和执行记录所在目录。这里仅展示；更换目录需要停服并迁移运行库。',
 'promptPartHint.communication':'何时通知人、消息语言和写法',
 'promptPartHint.scope':'工单范围、继续与暂停条件',
 'promptPartHint.delivery':'交付文件、验证证据和验收要求',
 'deploymentLimitsHint':'限制保存的提示词字符数、Router 接单读取本地线程上下文的页数及每个线程读取时限；当前不包含外部来源的主动评估。'}
const t=(key:string,values:Record<string,unknown>={})=>String(overrides[key]??zh[key]??key).replace(/\{(\w+)\}/g,(_,k)=>String(values[k]??'{'+k+'}'))

function Shell(){
  const deploymentForm=useDeploymentForm()
  const {data,error,reload}=usePoll(()=>request('/api/status'),[],3000) as any
  const [project,setProject]=useState(sessionStorage.getItem('codex-panel-project')??'')
  const [compose,setCompose]=useState(true),[target,setTarget]=useState(''),[busy,setBusy]=useState(false)
  const [collapsed,setCollapsed]=useState(false)
  const [failure,setFailure]=useState('')
  const [adding,setAdding]=useState(false),[projectName,setProjectName]=useState(''),[projectRoot,setProjectRoot]=useState('')
  const [picking,setPicking]=useState(false)
  const navigationReady=useRef(false)
  const navigationSave=useRef(Promise.resolve())
  const browse=async()=>{
    if(picking)return
    setPicking(true);setFailure('')
    try{
      const selected=await request('/api/folders/pick',{initial:projectRoot})
      if(!selected.cancelled){setProjectRoot(selected.path);setProjectName(name=>name||selected.path.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||'')}
    }catch(e){setFailure(e.message??String(e))}
    finally{setPicking(false)}
  }
  useEffect(()=>{
    if(!data)return
    if(!navigationReady.current){navigationReady.current=true;const nav=data.navigation
      if(nav&&data.projects.some(p=>p.id===nav.project)){setProject(nav.project);sessionStorage.setItem('codex-panel-project',nav.project);setTarget(nav.target);setCompose(nav.compose);return}
      const initial=data.projects.find(p=>p.id===project)?.id??data.projects[0]?.id
      if(initial){void request('/api/chats',{project:initial}).then(chat=>{setProject(initial);sessionStorage.setItem('codex-panel-project',initial);setTarget('chat:'+chat.id);setCompose(true);void reload()}).catch(e=>setFailure(e.message));return}}
    if(!data.projects.some(p=>p.id===project)){const id=data.projects[0]?.id??'';setProject(id);setTarget('');sessionStorage.setItem('codex-panel-project',id)}
  },[data,project])
  useEffect(()=>{
    if(!navigationReady.current||!project)return
    const timer=setTimeout(()=>{navigationSave.current=navigationSave.current.then(()=>request('/api/navigation',{project,target,compose})).catch(()=>{})},100)
    return()=>clearTimeout(timer)
  },[project,target,compose])
  useEffect(()=>{const listener=(e:any)=>{setTarget(e.detail.ticket_id);setProject(e.detail.project);sessionStorage.setItem('codex-panel-project',e.detail.project);setCompose(true)};window.addEventListener('codex-compose',listener);return()=>window.removeEventListener('codex-compose',listener)},[])
  useEffect(()=>{const listener=(e:any)=>{setProject(e.detail.project);sessionStorage.setItem('codex-panel-project',e.detail.project);setTarget(e.detail.ticket??'');setCompose(true)};window.addEventListener('codex-session',listener);return()=>window.removeEventListener('codex-session',listener)},[])
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setFailure('');try{await fn();await reload()}catch(e){setFailure(String(e.message??e))}finally{setBusy(false)}}
  if(!data||!project)return <div className="cx-closed">{error?.message??'正在读取工作台…'}</div>
  const choose=(id:string,ticket='')=>{setProject(id);sessionStorage.setItem('codex-panel-project',id);setTarget(ticket);setCompose(true)}
  const openWorkspace=(id:string)=>run(async()=>{const chat=await request('/api/chats',{project:id});choose(id,'chat:'+chat.id)})
  const newChat=()=>openWorkspace(project)
  return <div className={'sa-shell '+(collapsed?'sa-collapsed':'')}>
    <aside className={sidebar.root+' sa-sidebar'} aria-label="工作区侧栏">
      <div className={sidebar.logoRow}><strong className={sidebar.brandName}>{collapsed?'C':'Codex'} <small>HARNESS</small></strong><button className="sa-collapse" aria-label={collapsed?'展开侧边栏':'收起侧边栏'} onClick={()=>setCollapsed(!collapsed)}>☰</button></div>
      <button className={sidebar.newSession} onClick={()=>void newChat()} disabled={busy} title="新建 Codex 对话">＋ {collapsed?'':'新会话'}</button>
      <nav aria-label="全局面板"><button className={sidebar.panelRow+' '+(!compose?sidebar.panelActive:'')} aria-current={!compose?'page':undefined} onClick={()=>setCompose(false)}>⚒ {collapsed?'':'Superagent'}</button></nav>
      {!collapsed&&<><div className="sa-workspace-heading"><span>工作区</span><button aria-label="添加工作区" onClick={()=>{setFailure('');setAdding(true)}}>＋</button></div>
      <div className="sa-workspace-list">{data.projects.map(p=><section key={p.id}><button className="sa-project" disabled={busy} onClick={()=>void openWorkspace(p.id)} title={p.root??p.description}>▱ {p.description??p.id}</button>
        <button className={'sa-session '+(compose&&project===p.id&&!target?'sa-selected':'')} onClick={()=>choose(p.id)}>Superagent 主 Session</button>
        {p.chats?.filter(c=>c.session_id||c.title!=='新会话'||target==='chat:'+c.id).map(c=><button key={c.id} className={'sa-session '+(compose&&project===p.id&&target==='chat:'+c.id?'sa-selected':'')} onClick={()=>choose(p.id,'chat:'+c.id)} title={c.title}>◇ {c.title}</button>)}
        {p.tickets.map(t=><button key={t.ticket_id} className={'sa-session '+(compose&&project===p.id&&target===t.ticket_id?'sa-selected':'')} onClick={()=>choose(p.id,t.ticket_id)} title={t.title}><span className={t.turn_state==='running'?'sa-dot':''}>◦</span> {t.title}</button>)}
      </section>)}</div></>}
    </aside>
    <main className="sa-main">
    {(failure||error)&&<p className="cx-error" role="alert">{failure||error?.message}</p>}
    {compose?<Conversation key={project+':'+target} project={project} ticket={target} onPanel={()=>setCompose(false)} onRefresh={reload}/>:<div className="sa-panel-scroll"><App key={project} t={t as any} openSession={openSession} deploymentForm={deploymentForm as any}/></div>}
    <Modal open={adding} onClose={()=>{if(!busy&&!picking)setAdding(false)}} title="添加工作区" closeLabel="关闭" footer={<Button variant="primary" disabled={busy||picking||!projectName.trim()||!projectRoot.trim()} onClick={()=>void run(async()=>{
      const created=await request('/orchestrator/api/codex/projects',{name:projectName.trim(),root:projectRoot.trim()})
      const chat=await request('/api/chats',{project:created.id});await reload();choose(created.id,'chat:'+chat.id);setAdding(false);setProjectName('');setProjectRoot('')
    })}>添加工作区</Button>}><div className="cx-compose">
      <label htmlFor="cx-project-name">工作区名称</label><input id="cx-project-name" maxLength={100} value={projectName} onChange={e=>setProjectName(e.target.value)} disabled={busy}/>
      <label htmlFor="cx-project-root">工作文件夹</label><div className="cx-folder-field"><input id="cx-project-root" placeholder="选择文件夹或输入完整路径" value={projectRoot} onChange={e=>setProjectRoot(e.target.value)} disabled={busy||picking}/><Button variant="outline" disabled={busy||picking} onClick={()=>void browse()}>{picking?'选择中…':'浏览文件夹…'}</Button></div>
      <p className="dt-hint">选择已存在的文件夹作为工作区。添加后进入普通会话；需要分工时，通过 Superagent 主 Session 发起任务。</p>
      {failure&&<p className="dt-error" role="alert">{failure}</p>}
    </div></Modal>
    </main>
  </div>
}
createRoot(document.getElementById('root')!).render(<PanelProvider t={t as any}><Shell/></PanelProvider>)

