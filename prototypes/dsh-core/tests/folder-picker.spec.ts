import {expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createFolderPicker} from '../framework/folder-picker.mjs'
it('preserves cancellation and returns an existing Unicode directory',async()=>{
 const root=mkdtempSync(join(tmpdir(),'选择文件夹-'))
 try{
  let n=0;const picker=createFolderPicker({choose:async()=>n++===0?{cancelled:true,path:null}:{path:root}})
  expect(await picker.pick('unchanged')).toEqual({cancelled:true,path:null})
  expect((await picker.pick()).path).toBe(root)
 }finally{rmSync(root,{recursive:true,force:true})}
})
it('prevents duplicate dialogs and cancels the owned dialog on shutdown',async()=>{
 const picker=createFolderPicker({choose:async(_, {signal})=>new Promise(done=>signal.addEventListener('abort',()=>done({cancelled:true}),{once:true}))})
 const first=picker.pick();await expect(picker.pick()).rejects.toThrow('已打开');picker.cancel();expect((await first).cancelled).toBe(true)
})
it('closes an abandoned request without cancelling another request',async()=>{
 const picker=createFolderPicker({choose:async(_, {signal})=>new Promise(done=>signal.addEventListener('abort',()=>done({cancelled:true}),{once:true}))})
 const first=new AbortController(),other=new AbortController(),pending=picker.pick('',{signal:first.signal})
 await expect(picker.pick('',{signal:other.signal})).rejects.toThrow('已打开')
 other.abort();first.abort();expect((await pending).cancelled).toBe(true)
})
