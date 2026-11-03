const $=id=>document.getElementById(id)
const key='codex-superagent-token:'+location.port
if(location.hash){sessionStorage.setItem(key,location.hash.slice(1));history.replaceState(null,'',location.pathname)}
const token=sessionStorage.getItem(key);let snapshot,rendered='',exiting=false,stopped=false,poll
async function api(path,value){const response=await fetch('/api/'+path,{method:value===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});const result=await response.json();if(!response.ok)throw Error(result.error);return result}
const node=(tag,text,className)=>{const n=document.createElement(tag);n.textContent=text??'';if(className)n.className=className;return n}
function button(text,fn){const b=node('button',text);b.onclick=async()=>{b.disabled=true;try{await fn();await refresh()}catch(e){$('error').textContent=e.message}finally{b.disabled=false}};return b}
function render(){
  const project=$('project').value,p=snapshot.projects.find(p=>p.id===project);if(!p)return
  const messages=snapshot.messages.filter(m=>m.project===project),digest=JSON.stringify(messages)
  if(rendered!==digest){rendered=digest;$('messages').replaceChildren(...messages.map(m=>{const el=node('div',null,'message '+m.origin);el.append(node('b',({user:'你',router:'Router',worker:'Worker',job:'工具作业',watchdog:'Watchdog',system:'系统'})[m.origin]??m.origin),node('span',m.body.text??m.body.report?.summary??m.body.suggestion??JSON.stringify(m.body)));return el}));$('messages').scrollTop=$('messages').scrollHeight}
  const selected=$('target').value;$('target').replaceChildren(new Option('新请求',''),...p.tickets.filter(t=>!t.ended).map(t=>new Option('跟进：'+t.title,t.ticket_id)));$('target').value=selected
  $('tasks').replaceChildren(...p.tickets.map(t=>{const el=node('div',null,'task');el.append(node('h3',t.title),node('p',(t.ended?'已结束':t.turn_state)+' · '+(t.dependencies_ready?'依赖就绪':'等待上游')))
    if(t.result)el.append(node('p',t.result.summary))
    if(t.workspace){const detail=node('details');detail.append(node('summary','交付文件（隔离工作区）'),node('pre',t.workspace+'\n'+t.artifacts.map(a=>a.path).join('\n')));el.append(detail)}
    for(const j of t.jobs)el.append(node('p','工具 '+j.profile+'：'+j.state))
    if(!t.ended){el.append(button('继续此任务',async()=>{$('target').value=t.ticket_id;$('text').focus()}),button('停止任务',()=>api('stop',{project,ticket_id:t.ticket_id})))
      if(['failed','cancelled'].includes(t.turn_state))el.append(button('重新执行',()=>api('retry',{project,ticket_id:t.ticket_id})))
      if(t.turn_state==='completed'&&!t.queued_inputs&&!t.jobs.some(j=>['queued','running','uncertain'].includes(j.state)))el.append(button('验收通过',()=>api('review',{project,ticket_id:t.ticket_id,turn_id:t.turn_id,accept:true})))
    }return el}))
  $('health').textContent=snapshot.paused?'已暂停新调度':snapshot.router_busy||snapshot.worker_busy?'协作运行中':'等待新请求'
  $('pause').textContent=snapshot.paused?'继续任务':'暂停任务'
  $('budget').textContent='剩余轮次 W '+snapshot.budgets.worker+' / R '+snapshot.budgets.router
  if(!p.tickets.length)$('tasks').append(node('p','还没有任务。发送目标后，Router 会安排工作。','hint'))
  const assessment=snapshot.watchdog.map(w=>w.response?JSON.parse(w.response).output?.assessment:w.error).filter(Boolean)
  $('watch').textContent=(snapshot.monitor?.healthy?'运行检查正常。':snapshot.monitor?'运行检查发现需要关注的状态，请展开诊断信息。':'等待运行检查。')+'\n'+(assessment.join('\n')||'有任务进展后，Watchdog 会检查方向和阻塞情况。')
  $('diagnostics').textContent=JSON.stringify({last_error:snapshot.last_error,calls:snapshot.calls,monitor:snapshot.monitor},null,2)
}
function closingView(mode){
  exiting=true;$('lifecycle').hidden=false
  $('lifecycle-title').textContent=mode==='draining'?'完成当前工作后退出':'正在保存并退出…'
  $('lifecycle-detail').textContent=mode==='draining'?'当前工作仍在进行，新的工作暂不开始。你也可以现在停止。':'正在停止执行并保存记录，请稍候。'
  $('stop-now').hidden=mode!=='draining'
  document.querySelectorAll('#workbench button,#workbench select,#workbench textarea,header button').forEach(e=>e.disabled=true)
}
async function refresh(){if(stopped)return;try{snapshot=await api('status');if(stopped)return;if(!$('project').options.length)$('project').replaceChildren(...snapshot.projects.map(p=>new Option(p.description??p.id,p.id)));render();if(['draining','stopping'].includes(snapshot.lifecycle?.state))closingView(snapshot.lifecycle.state)}catch(e){if(stopped)return;$('error').textContent=exiting?'连接已断开。可通过桌面图标查看工作台状态。':e.message;$('health').textContent='连接中断'}}
async function shutdown(mode){
  $('exit-dialog').close();closingView(mode==='drain'?'draining':'stopping');$('error').textContent=''
  try{
    const result=await api('shutdown',{mode});if(!result.stopped)throw Error('退出尚未确认')
    stopped=true;clearInterval(poll);$('workbench').hidden=true;$('stop-now').hidden=true
    $('lifecycle-title').textContent='已退出，记录已保存'
    $('lifecycle-detail').textContent='可以关闭此页面。下次双击桌面上的 Codex Superagent 图标即可打开。'+(result.attention?'有执行状态需要在下次打开时核查。':'')
    $('health').textContent='已退出'
  }catch(e){if(stopped)return;$('lifecycle-title').textContent='尚未确认退出';$('lifecycle-detail').textContent='连接没有返回退出确认。请从桌面图标或托盘查看状态。';$('stop-now').hidden=false;$('error').textContent=e.message}
}
$('exit').onclick=async()=>{try{const s=await api('lifecycle');if(Object.values(s.active).some(n=>n>0))$('exit-dialog').showModal();else await shutdown('now')}catch(e){$('error').textContent=e.message}}
$('drain').onclick=()=>shutdown('drain');$('exit-now').onclick=()=>shutdown('now');$('stop-now').onclick=()=>shutdown('now');$('cancel-exit').onclick=()=>$('exit-dialog').close()
$('compose').onsubmit=async e=>{e.preventDefault();const text=$('text').value.trim();if(!text)return;const submit=e.target.querySelector('button');submit.disabled=true;try{await api('message',{id:crypto.randomUUID(),project:$('project').value,text,ticket_id:$('target').value||null});$('text').value='';$('error').textContent='';await refresh()}catch(e){$('error').textContent=e.message}finally{submit.disabled=false}}
$('project').onchange=()=>{rendered='';render()};$('pause').onclick=()=>api('pause',{paused:!snapshot.paused}).then(refresh).catch(e=>$('error').textContent=e.message)
refresh();poll=setInterval(refresh,2000)
