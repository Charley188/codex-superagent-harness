import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
const sha=value=>createHash('sha256').update(value).digest('hex')
export function folderPickerExecutable(){
  const source=fileURLToPath(new URL('./FolderPicker.cs',import.meta.url)),directory=fileURLToPath(new URL('../../../state/desktop/',import.meta.url))
  mkdirSync(directory,{recursive:true})
  const executable=join(directory,'FolderPicker.exe'),record=join(directory,'folder-picker-build.json'),sourceHash=sha(readFileSync(source))
  if(existsSync(executable)&&existsSync(record)){
    const saved=JSON.parse(readFileSync(record,'utf8'))
    if(saved.source===sourceHash&&saved.binary===sha(readFileSync(executable)))return executable
  }
  const temporary=join(directory,'FolderPicker.'+randomUUID()+'.exe')
  const compiler=join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  const compiled=spawnSync(compiler,['/nologo','/target:exe','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/out:'+temporary,source],{encoding:'utf8',windowsHide:true,timeout:30000})
  if(compiled.status!==0)throw Error('文件夹选择组件构建失败：'+(compiled.stdout||compiled.stderr||compiled.error))
  renameSync(temporary,executable)
  writeFileSync(record,JSON.stringify({source:sourceHash,binary:sha(readFileSync(executable))}))
  return executable
}
