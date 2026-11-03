import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { hash } from './durable-runtime.mjs'

const owned = fileURLToPath(new URL('../../../state/dsh-core/', import.meta.url))
/** Synthetic-only execution transport; the domain runtime has no fixed worker role enumeration. */
export class PythonTransport {
  constructor(directory, { helper = new URL('../durable_worker.py', import.meta.url) } = {}) {
    this.helper = fileURLToPath(helper)
    this.directory = resolve(directory)
    const rel = relative(owned, this.directory)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Transport artifacts must be inside state/dsh-core')
    mkdirSync(this.directory, { recursive: true })
  }
  folder(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid turn ID')
    return join(this.directory, id)
  }
  async preflight() {
    await new Promise((done,reject)=>{
      const child=spawn('python',['-B',fileURLToPath(new URL('../durable_worker.py',import.meta.url)),'--check'],{windowsHide:true,stdio:['ignore','ignore','pipe'],timeout:120000})
      let error='';child.stderr.on('data',b=>{error=(error+b).slice(-8000)})
      child.once('error',reject);child.once('close',code=>code===0?done():reject(new Error('Codex compatibility gate failed before dispatch: '+error)))
    })
  }
  cancel(id) { const folder = this.folder(id); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'cancel'), 'cancel') }
  result(id) {
    const file = join(this.folder(id), 'result.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  }
  async execute(request, requestHash) {
    const folder = this.folder(request.turn_id)
    mkdirSync(folder, { recursive: true })
    const text = JSON.stringify(request)
    if (hash(text) !== requestHash) throw new Error('Request mutated before launch')
    writeFileSync(join(folder, 'request.json'), text, { flag: 'wx' })
    const heartbeat = () => writeFileSync(join(folder, 'heartbeat'), String(Date.now()))
    heartbeat()
    const timer = setInterval(heartbeat, 1000)
    try {
      await new Promise((done, reject) => {
        const child = spawn('python', ['-B', this.helper, '--request', join(folder, 'request.json')],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        let errors = ''
        child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-16_000) })
        child.once('error', reject)
        child.once('close', code => code === 0 ? done() : reject(new Error(`Worker exited ${code}: ${errors}`)))
      })
      const response = this.result(request.turn_id)
      if (!response) throw new Error('Worker exited without a durable receipt')
      return response
    } finally { clearInterval(timer) }
  }
}
