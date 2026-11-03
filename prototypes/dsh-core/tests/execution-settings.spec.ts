import {it,expect} from 'vitest'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {rmSync} from 'node:fs'
import {initialize,openRuntime,base} from '../framework/bootstrap.mjs'
import {panelApi} from '../framework/panel-api.mjs'
it('applies saved timeout to each new Worker snapshot and retains it on reopen without the panel',async()=>{
 const directory=join(base,'state/dsh-core/timeout-tests',randomUUID());initialize(directory)
 let host=openRuntime(directory),api=panelApi(host)
 try{
  expect(api('GET','codex/runtime',new URLSearchParams()).settings.value.workerTimeoutSeconds).toBe(1200)
  const first={ticket_id:'none'};host.runtime.enrichRequest(first);expect(first.worker_timeout_seconds).toBe(1200)
  api('PUT','codex/runtime',new URLSearchParams(),{revision:0,value:{maxWorkers:4,workerTimeoutSeconds:3600}})
  const next={ticket_id:'none'};host.runtime.enrichRequest(next);expect(next.worker_timeout_seconds).toBe(3600);expect(first.worker_timeout_seconds).toBe(1200)
  expect(()=>api('PUT','codex/runtime',new URLSearchParams(),{revision:1,value:{maxWorkers:4,workerTimeoutSeconds:7201}})).toThrow()
  api('PUT','codex/runtime',new URLSearchParams(),{revision:1,value:{maxWorkers:8}})
  await host.runtime.close();host=openRuntime(directory)
  const reopened={ticket_id:'none'};host.runtime.enrichRequest(reopened);expect(reopened.worker_timeout_seconds).toBe(3600);expect(host.runtime.capacity).toBe(8)
 }finally{await host.runtime.close();rmSync(directory,{recursive:true,force:true})}
})
