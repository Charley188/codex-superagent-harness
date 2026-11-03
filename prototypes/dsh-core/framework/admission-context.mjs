/** Local source reader for DSH's bounded admissionContext and threadWindow algorithms. */
import {admissionContext} from '../adapted/admission-context.ts'
import {threadKey} from '../vendor/dsh/src/core/index.ts'
export async function localAdmissionContext(store,project,ids,limits,{now=()=>performance.now(),readPage}={}){
 const contexts=[],seen=new Set(),cutoff=store.db.prepare('SELECT MAX(rowid) n FROM trigger').get().n??0
 for(const id of ids){
  const trigger=store.triggers.get(id);if(!trigger||trigger.meta?.project!==project)continue
  const key=threadKey(trigger.threads[0]);if(seen.has(key))continue
  seen.add(key)
  // Bound aggregate context as well as each upstream paginated read.
  if(contexts.length===4){contexts.push({thread:key,status:'batch-context-limit',complete:false});break}
  const deadline=now()+limits.admissionContextTimeoutMs
  const check=()=>{if(now()>=deadline)throw Error('context-timeout')}
  let pages=0
  try{
   const result=await admissionContext({messageId:id,read:async(_commands,_kind,cursor)=>{
    check();pages++
    const rows=readPage?await readPage(key,cursor):store.db.prepare(`SELECT t.value,x.at,x.id FROM trigger_thread x JOIN trigger t ON t.id=x.id
     JOIN sa_message m ON m.id=t.id WHERE x.thread=? AND m.project=? AND t.rowid<=?
     ${cursor?'AND (x.at,x.id)>(?,?)':''} ORDER BY x.at,x.id LIMIT 51`).all(key,project,cutoff,...cursor?JSON.parse(cursor):[])
    check()
    const messages=rows.slice(0,50).map(row=>{const value=JSON.parse(row.value);return {id:value.id,text:value.text,human:value.human}})
    const last=rows[Math.min(rows.length,50)-1]
    return {messages,...rows.length>50?{next:JSON.stringify([last.at,last.id])}:{}}
   }},undefined,limits.admissionContextMaxPages)
   contexts.push({thread:key,trigger_id:id,pages,complete:result.complete,next:result.next??null,
    window:{...result.window,entries:result.window.entries.map(entry=>({...entry,message:{...entry.message,text:String(entry.message.text??'').slice(0,300),full_chars:String(entry.message.text??'').length}}))}})
  }catch(error){if(error.message!=='context-timeout')throw error;contexts.push({thread:key,trigger_id:id,pages,complete:false,status:'context-timeout'})}
 }
 return contexts
}
