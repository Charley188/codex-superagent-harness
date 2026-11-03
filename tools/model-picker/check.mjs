import {JSDOM} from '../../prototypes/dsh-core/panel/node_modules/jsdom/lib/api.js'
import {readFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
const directory=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--experimental-transform-types',fileURLToPath(new URL('../../desktop/ui-fixture.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',b=>{out+=b;if(out.includes('\n'))resolve(out.trim())});p.once('error',reject)})
const connection=JSON.parse(readFileSync(directory+'/connection.json','utf8')),base=new URL(connection.url),headers={authorization:'Bearer '+base.hash.slice(1),'content-type':'application/json'}
const dom=new JSDOM('<div id="root"></div>',{url:connection.url,runScripts:'dangerously',pretendToBeVisual:true})
dom.window.fetch=(p,o)=>fetch(new URL(p,base),o);dom.window.HTMLElement.prototype.scrollIntoView=function(){}
const wait=async fn=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')}
try{
 dom.window.eval(readFileSync(new URL('../../prototypes/dsh-core/panel/dist/panel.js',import.meta.url),'utf8'))
 const doc=dom.window.document
 await wait(()=>doc.querySelector('.sa-model-trigger')?.textContent.includes('gpt-'))
 doc.querySelector('.sa-model-trigger').click();await wait(()=>doc.querySelector('[aria-label="模型"]'))
 const model=doc.querySelector('[aria-label="模型"]'),original=model.value,next=[...model.options].find(o=>o.value!==original).value
 model.value=next;model.dispatchEvent(new dom.window.Event('change',{bubbles:true}))
 await wait(()=>doc.querySelector('[aria-label="模型"]').value===next)
 const effort=doc.querySelector('[aria-label="推理强度"]');effort.value='high';effort.dispatchEvent(new dom.window.Event('change',{bubbles:true}))
 await new Promise(r=>setTimeout(r,50))
 ;[...doc.querySelectorAll('.sa-model-menu button')].find(b=>b.textContent==='应用').click()
 await wait(()=>!doc.querySelector('.sa-model-menu'))
 assert(doc.querySelector('.sa-model-trigger').textContent.includes(next));assert(doc.querySelector('.sa-model-trigger').textContent.includes('high'))
 const status=await (await fetch(new URL('/api/status',base),{headers})).json(),p=status.projects[0],chat=p.chats[0]
 const read=async target=>(await fetch(new URL('/api/models?project='+p.id+'&target='+encodeURIComponent(target),base),{headers})).json()
 assert.equal((await read('chat:'+chat.id)).selection.value.model,next)
 assert.equal((await read('')).selection.value,null)
 console.log(JSON.stringify({status:'passed',composer_selection:true,persisted:true,router_isolated:true}))
}finally{dom.window.close();await fetch(new URL('/api/shutdown',base),{method:'POST',headers,body:JSON.stringify({mode:'now'})})}
