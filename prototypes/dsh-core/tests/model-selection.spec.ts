import {it,expect} from 'vitest'
import {modelSelection} from '../framework/model-selection.mjs'
it('isolates conversation selections, rejects unavailable capabilities and stale writes',async()=>{
 const values=new Map(),audit=[],host={runtime:{store:{get:k=>values.get(k),set:(k,v)=>values.set(k,v),atomic:fn=>fn()},audit:v=>audit.push(v)},agent:{project:p=>{if(p!=='p')throw Error('project')},owns:(p,t)=>{if(t!=='worker')throw Error('ticket')}},chats:{own:(p,t)=>{if(t!=='chat')throw Error('chat')}}}
 const value={model:'m',effort:'low',serviceTier:'default'},catalog={models:[{model:'m',supportedReasoningEfforts:[{reasoningEffort:'low'}],serviceTiers:[{id:'priority'}]}],defaults:value},api=modelSelection(host,async()=>catalog)
 await api.save({project:'p',target:'',revision:0,value})
 expect((await api.view('p','')).selection.value).toEqual(value)
 expect((await api.view('p','chat:chat')).selection.value).toBeNull()
 expect((await api.view('p','worker')).selection.value).toBeNull()
 await expect(api.save({project:'p',target:'',revision:0,value})).rejects.toThrow('配置已')
 await expect(api.save({project:'p',target:'worker',revision:0,value:{...value,effort:'ultra'}})).rejects.toThrow('推理')
 await expect(api.save({project:'p',target:'worker',revision:0,value:{...value,serviceTier:'unknown'}})).rejects.toThrow('速度')
 await expect(api.view('p','chat:foreign')).rejects.toThrow('chat')
 await api.save({project:'p',target:'worker',revision:0,value:{...value,serviceTier:'priority'}})
 expect(audit).toHaveLength(2)
})
