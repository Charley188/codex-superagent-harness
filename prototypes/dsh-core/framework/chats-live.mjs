import assert from 'node:assert/strict'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {initialize,openRuntime,base} from './bootstrap.mjs'
import {Chats} from './chats.mjs'
const directory=join(base,'state/dsh-core/chats-live',randomUUID());initialize(directory)
let host=openRuntime(directory)
try{
 let chats=new Chats(host),chat=chats.create({project:'synthetic'})
 host.runtime.store.set('sa.paused',true);host.agent.controlBudget=0
 chats.receive({project:'synthetic',chat:chat.id,text:'这是合成会话测试，请记住标记 CHAT_CONTINUITY_91，只回复已记住，不调用工具。'})
 await chats.once();let detail=chats.detail('synthetic',chat.id)
 assert.equal(detail.executions[0].state,'applied',JSON.stringify(detail.executions[0]))
 const session=detail.session_id
 chats.receive({project:'synthetic',chat:chat.id,text:'刚才的完整标记是什么？只回复标记，不调用工具。'})
 await chats.once();detail=chats.detail('synthetic',chat.id)
 assert.equal(detail.executions[0].state,'applied',JSON.stringify(detail.executions[0]))
 assert.equal(detail.session_id,session);assert(detail.messages.at(-1).body.text.includes('CHAT_CONTINUITY_91'))
 assert.equal(host.runtime.turns().length,0);assert.equal(host.agent.status().messages.length,0)
 assert.equal(host.agent.controlBudget,0);assert.equal(chats.budget,22)
 await host.runtime.close();host=openRuntime(directory);chats=new Chats(host)
 assert.equal(chats.detail('synthetic',chat.id).messages.length,4)
 const report={status:'passed',directory,ordinary_chat:true,same_session_resume:true,reopened_history:true,independent_of_superagent_pause:true,independent_budget:true,router_or_workers_created:false,private_inputs_used:false}
 writeFileSync(join(directory,'validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}finally{await host.runtime.close()}
