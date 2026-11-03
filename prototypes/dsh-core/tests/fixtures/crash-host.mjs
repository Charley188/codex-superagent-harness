import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DurableRuntime } from '../../src/durable-runtime.mjs'
const [directory, mode] = process.argv.slice(2)
let calls = 0
const file = join(directory, 'terminal-receipt.json')
const transport = { cancel() {}, result() { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined },
  async execute(request, digest) {
    calls++
    if (mode === 'recover') throw new Error('Recovery must not launch a new turn')
    if (mode === 'receipt') writeFileSync(file, JSON.stringify({ ...Object.fromEntries(['ticket_id', 'assignment_id', 'turn_id'].map(k => [k, request[k]])),
      request_hash: digest, status: 'completed', session_id: randomUUID(), report: { task_id: request.ticket_id, attempt_id: request.turn_id, summary: 'Result before host crash' } }))
    process.exit(73) // No close(): proves SQLite releases host ownership on real process exit.
  } }
const host = new DurableRuntime({ directory, transport })
if (mode !== 'recover') host.submit('crash', { repo_id: 'test', worker_role: 'any-role', objective: 'Synthetic', permission: 'read-only', inputs: [{ path: 'a.md', sha256: 'a'.repeat(64) }] })
await host.run()
console.log(JSON.stringify({ state: host.turns()[0].state, calls }))
await host.close()
