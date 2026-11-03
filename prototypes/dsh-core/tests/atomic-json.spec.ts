import {it,expect} from 'vitest'
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {atomicJson} from '../framework/atomic-json.mjs'
it('retries Windows sharing failures and preserves complete old data on persistent failure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sa-atomic-')),path=join(root,'heartbeat.json');writeFileSync(path,'{"old":true}')
 try{
  let count=0;await atomicJson(path,{next:true},{delay:async()=>{},replace:async(a,b)=>{if(count++<2)throw Object.assign(Error('sharing violation'),{code:'EPERM'});renameSync(a,b)}})
  expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({next:true})
  await expect(atomicJson(path,{bad:true},{delay:async()=>{},replace:async()=>{throw Object.assign(Error('sharing violation'),{code:'EPERM'})}})).rejects.toThrow('sharing')
  expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({next:true});expect(readdirSync(root)).toEqual(['heartbeat.json'])
 }finally{rmSync(root,{recursive:true,force:true})}
})
