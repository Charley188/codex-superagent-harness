import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { resolve, join,relative,isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { defaultDirectory, initialize, openRuntime, ownedDirectory, base } from './bootstrap.mjs'
import { serve } from './server.mjs'
import { verifyRelease } from './release.mjs'
const [command='help',directoryArg,...extra]=process.argv.slice(2),directory=resolve(directoryArg??defaultDirectory)
if(command==='init') console.log(initialize(directory))
else if(command==='serve'){
  verifyRelease()
  const host=openRuntime(directory)
  const app=await serve(host,{port:Number(extra[0]??0)});console.log('Codex Superagent: '+app.url)
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close())
}else if(command==='doctor'){
  verifyRelease()
  const check=spawnSync('python',['-B',resolve(base,'prototypes/dsh-core/durable_worker.py'),'--check'],{encoding:'utf8',windowsHide:true,timeout:120000})
  console.log(check.stdout || check.stderr);process.exitCode=check.status??1
}else if(command==='backup'){
  const target=ownedDirectory(extra[0]??join(base,'state/dsh-core/backups',new Date().toISOString().replaceAll(':','-')))
  const rel=relative(directory,target);if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw new Error('Backup destination cannot be inside its source')
  const host=openRuntime(directory)
  try {
    if(host.runtime.turns().some(t=>['running','uncertain'].includes(t.state)) || host.jobs.rows().some(j=>['running','uncertain'].includes(j.state)))throw new Error('Resolve active/uncertain execution before backup')
    for(const table of ['sa_call','sa_watch','sa_chat_call'])if(host.runtime.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&host.runtime.store.db.prepare(`SELECT 1 FROM ${table} WHERE state IN ('running','uncertain')`).get())throw new Error('Resolve control/chat execution before backup')
    if(existsSync(target))throw new Error('Backup target already exists')
  }finally{await host.runtime.close()}
  cpSync(directory,target,{recursive:true,errorOnExist:true,force:false});console.log(target)
}else if(['status','send','pause','resume','stop','shutdown'].includes(command)){
  const link=JSON.parse(readFileSync(join(directory,'connection.json'),'utf8')),url=new URL(link.url),token=url.hash.slice(1);url.hash=''
  const endpoint=command==='status'?'status':command==='send'?'message':command==='resume'||command==='pause'?'pause':command
  const body=command==='send'?{project:extra[0],text:extra.slice(1).join(' ')}:command==='stop'?{project:extra[0],ticket_id:extra[1]}:{paused:command==='pause'}
  const response=await fetch(new URL('/api/'+endpoint,url),{method:command==='status'?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(command==='status'?{}:{body:JSON.stringify(body)})})
  console.log(await response.text());if(!response.ok)process.exitCode=1
}else console.log('node --experimental-transform-types framework/cli.mjs init|serve|doctor|backup|status|send|pause|resume|stop|shutdown [runtime-directory] [arguments]\nDefault runtime: '+defaultDirectory)
