let token = location.hash.slice(1)
if (/^[a-f0-9]{64}$/.test(token)) { sessionStorage.setItem('codex-panel-token', token); sessionStorage.setItem('codex-superagent-token:'+location.port, token); history.replaceState(null, '', location.pathname) }
else token = sessionStorage.getItem('codex-panel-token') ?? ''
export const requestHeaders = () => ({ authorization: 'Bearer ' + token })
export const projectQuery = (path: string) => path + (path.includes('?') ? '&' : '?') + 'project=' + encodeURIComponent(sessionStorage.getItem('codex-panel-project') ?? 'synthetic')
export async function request(path: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') {
  let response:Response
  try{response = await fetch(path, { method, headers: { ...requestHeaders(), 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) })}
  catch{throw new Error('工作台连接已断开。请从桌面图标重新打开工作台；原页面可能仍连接旧地址。')}
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error ?? '请求失败'), {status:response.status})
  return result
}
export async function openSession(id: string) {
  const project=sessionStorage.getItem('codex-panel-project')??''
  const result = await request('/api/harness/resolve?project='+encodeURIComponent(project)+'&session='+encodeURIComponent(id))
  window.dispatchEvent(new CustomEvent('codex-session',{detail:result}))
}
