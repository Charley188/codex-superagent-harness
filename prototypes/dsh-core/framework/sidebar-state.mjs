/** DSH workspace removal keeps folders and sessions; archival never erases audit records. */
import {require} from './contracts.mjs'
const removedKey='sa.ui.removedWorkspaces',workersKey='sa.ui.archivedWorkers'
export function sidebarState(host){
 const {agent,runtime,chats}=host,store=runtime.store
 return {
  project(row){return {...row,removed:(store.get(removedKey)??[]).includes(row.id),chats:chats.list(row.id),tickets:row.tickets.map(t=>({...t,archived:(store.get(workersKey)??[]).includes(t.ticket_id)}))}},
  workspace({project,removed}){
   agent.project(project);require(typeof removed==='boolean','Boolean required')
   store.atomic(()=>{const values=new Set(store.get(removedKey)??[]);removed?values.add(project):values.delete(project);store.set(removedKey,[...values]);runtime.audit({type:'human.workspace.remove',project,removed})})
   return {removed,filesPreserved:true,sessionsPreserved:true}
  },
  archive({project,target,archived}){
   agent.project(project);require(typeof target==='string'&&target&&typeof archived==='boolean','Invalid conversation archive request')
   if(target.startsWith('chat:'))return chats.archive(project,target.slice(5),archived)
   agent.owns(project,target)
   store.atomic(()=>{
    if(archived&&!store.tickets.get(target).ended)agent.stop(target,project)
    const values=new Set(store.get(workersKey)??[]);archived?values.add(target):values.delete(target);store.set(workersKey,[...values])
    const nav=store.get('sa.ui.navigation');if(archived&&nav?.target===target)store.set('sa.ui.navigation',null)
    runtime.audit({type:'human.worker.archive',project,ticket:target,archived})
   })
   return {archived,workResumesAutomatically:false}
  }
 }
}
