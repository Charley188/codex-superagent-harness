import {spawn} from 'node:child_process'
import {realpathSync,statSync} from 'node:fs'
import {isAbsolute} from 'node:path'
import {folderPickerExecutable} from './build-folder-picker.mjs'
import {require} from './contracts.mjs'

function nativeChoose(initial,{signal}){
  require(process.platform==='win32','本机文件夹选择器目前仅支持 Windows')
  return new Promise((resolve,reject)=>{
    const child=spawn(folderPickerExecutable(),[],
      {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,CODEX_PROJECT_FOLDER_INITIAL:initial}})
    let output='',error=''
    const stop=()=>child.kill()
    signal.addEventListener('abort',stop,{once:true})
    if(signal.aborted)stop()
    child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>16000)stop()})
    child.stderr.on('data',b=>{error=(error+b.toString('utf8')).slice(-2000)})
    child.once('error',reject)
    child.once('close',code=>{
      signal.removeEventListener('abort',stop)
      if(signal.aborted){resolve({cancelled:true,path:null});return}
      if(code!==0){reject(Error('无法打开文件夹选择窗口：'+error));return}
      try{resolve(JSON.parse(output.replace(/^\uFEFF/,'').trim()))}catch{reject(Error('文件夹选择窗口未返回有效结果'))}
    })
  })
}
export function createFolderPicker({choose=nativeChoose,timeoutMs=300000}={}){
  let current=null
  return {
    async pick(initial='',{signal}={}){
      require(typeof initial==='string'&&initial.length<=4096,'文件夹路径过长或格式无效')
      if(current)throw Object.assign(Error('文件夹选择窗口已打开，请先完成选择或取消。'),{status:409})
      const controller=new AbortController();current=controller
      const abort=()=>controller.abort()
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
      const timer=setTimeout(()=>controller.abort(),timeoutMs)
      try{
        const value=await choose(initial,{signal:controller.signal})
        if(controller.signal.aborted||value.cancelled)return {cancelled:true,path:null}
        require(typeof value.path==='string'&&isAbsolute(value.path),'选择的文件夹路径无效')
        const path=realpathSync(value.path);require(statSync(path).isDirectory(),'选择的路径不是文件夹')
        return {cancelled:false,path}
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(current===controller)current=null}
    },
    cancel(){current?.abort()},
  }
}
