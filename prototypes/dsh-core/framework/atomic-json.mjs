import {writeFile,rename,unlink} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
// Windows readers can briefly deny replacement. Keep the old complete document until a rename succeeds.
export async function atomicJson(path,value,{replace=rename,delay=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const temporary=path+'.'+randomUUID()+'.tmp'
  try{
    await writeFile(temporary,JSON.stringify(value))
    for(let attempt=0;;attempt++){
      try{await replace(temporary,path);return}
      catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=4)throw error;await delay(25*(attempt+1))}
    }
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
}
