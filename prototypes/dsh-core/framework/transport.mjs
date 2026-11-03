import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash } from '../src/durable-runtime.mjs'
import { require } from './contracts.mjs'
const root = fileURLToPath(new URL('../../../state/dsh-core/', import.meta.url))
export class ModelTransport {
  constructor(directory) {
    this.directory = resolve(directory)
    const rel = relative(root, this.directory)
    require(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Artifacts must stay in state/dsh-core')
    mkdirSync(this.directory, { recursive: true })
  }
  folder(id) { require(/^[a-f0-9-]{36}$/i.test(id), 'Invalid call ID'); return join(this.directory, id) }
  result(id) { const path = join(this.folder(id), 'result.json'); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null }
  cancel(id) { mkdirSync(this.folder(id), { recursive: true }); writeFileSync(join(this.folder(id), 'cancel'), 'cancel') }
  async execute(request, digest) {
    const folder = this.folder(request.request_id), text = JSON.stringify(request)
    require(hash(text) === digest, 'Request mutated')
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'request.json'), text, { flag: 'wx' })
    const heartbeat = () => writeFileSync(join(folder, 'heartbeat'), String(Date.now()))
    heartbeat(); const interval = setInterval(heartbeat, 1000)
    try {
      await new Promise((done, reject) => {
        const child = spawn('python', ['-B', fileURLToPath(new URL('./model_worker.py', import.meta.url)), '--request', join(folder, 'request.json')],
          { windowsHide: true, stdio: ['ignore','ignore','pipe'] })
        let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-12000) })
        child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error(error || 'Controller exited ' + code)))
      })
      require(this.result(request.request_id), 'No durable model receipt')
      return this.result(request.request_id)
    } finally { clearInterval(interval) }
  }
}
