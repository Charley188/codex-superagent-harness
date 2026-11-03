import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const here=fileURLToPath(new URL('../',import.meta.url)),base=fileURLToPath(new URL('../../../',import.meta.url))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export function sourceFingerprint(){
  const files=[]
  const visit=dir=>{for(const e of readdirSync(join(here,dir),{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory()){if(!['__pycache__','node_modules'].includes(e.name))visit(p)}else if(!p.endsWith('.pyc'))files.push(p)}}
  for(const dir of ['framework','src','adapted','vendor/dsh','panel'])visit(dir)
  for(const p of ['package.json','pnpm-lock.yaml','upstream-manifest.json','durable_worker.py'])if(existsSync(join(here,p)))files.push(p)
  return sha(JSON.stringify(files.sort().map(p=>[p,sha(readFileSync(join(here,p)))])))
}
export function verifyRelease(){
  const path=join(base,'state/framework-accepted.json')
  if(!existsSync(path))throw Error('Framework has not been certified; run framework/certify.mjs')
  const cert=JSON.parse(readFileSync(path,'utf8'))
  if(cert.status!=='passed'||cert.fingerprint!==sourceFingerprint())throw Error('Framework code/dependencies changed; recertification required. State is preserved.')
  return cert
}
