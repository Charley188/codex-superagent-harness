import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { DurableRuntime } from '../src/durable-runtime.mjs'
import { Store } from '../adapted/store.ts'
import {Versions} from '../vendor/dsh/src/app/versions.ts'
import {family} from '../vendor/dsh/src/kv.ts'

const areas: string[] = [], hosts: DurableRuntime[] = []
const area = () => { const path = mkdtempSync(join(tmpdir(), 'codex-durable-')); areas.push(path); return path }
const contract = (repo = 'any-project', role = 'algorithm-designer') => ({ repo_id: repo, worker_role: role,
  objective: 'Synthetic test', permission: 'read-only', inputs: [{ path: 'fixture.md', sha256: 'a'.repeat(64) }] })
function answer(request, requestHash, extra = {}) {
  return { ticket_id: request.ticket_id, assignment_id: request.assignment_id, turn_id: request.turn_id,
    request_hash: requestHash, session_id: request.session_id ?? randomUUID(), status: 'completed',
    report: { task_id: request.ticket_id, attempt_id: request.turn_id, summary: 'Synthetic result' }, ...extra }
}
function transport(run = async (request, digest) => answer(request, digest)) {
  const receipts = new Map(), calls: any[] = [], cancelled: string[] = []
  return { calls, receipts, cancelled, cancel: id => cancelled.push(id), result: async id => receipts.get(id),
    async execute(request, digest) { calls.push(request); const response = await run(request, digest); receipts.set(request.turn_id, response); return response } }
}
function host(directory = area(), port = transport(), options = {}) {
  const runtime = new DurableRuntime({ directory, transport: port, ...options }); hosts.push(runtime)
  return runtime
}
async function close(runtime) { hosts.splice(hosts.indexOf(runtime), 1); await runtime.close() }
afterEach(async () => { for (const runtime of hosts.splice(0)) await runtime.close(); for (const dir of areas.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('uses Store nested transaction rollback without leaving effects or bindings', async () => {
  const h = host(), port = h.transport
  expect(() => h.store.atomic(() => { h.submit('rollback', contract()); throw new Error('rollback') })).toThrow('rollback')
  await h.run()
  expect(h.store.tickets.list()).toEqual([])
  expect(h.store.db.prepare('SELECT * FROM codex_binding').all()).toEqual([])
  expect(port.calls).toEqual([])
})
it('deduplicates explicit submissions and rejects event ID content collisions', async () => {
  const h = host(), id = h.submit('event', contract())
  expect(h.submit('event', contract())).toBe(id)
  expect(() => h.submit('event', contract('changed'))).toThrow('different content')
  await h.run(); await h.run()
  expect(h.transport.calls).toHaveLength(1)
  expect(h.turns()[0].state).toBe('completed')
  expect(h.store.db.prepare('SELECT state FROM codex_review').get()).toMatchObject({ state: 'pending' })
})
it('stores arbitrary worker responsibilities without a domain role enumeration', async () => {
  const h = host()
  h.submit('one', contract('hardware', '定点精度与误差复核'))
  h.submit('two', contract('software', 'release investigator'))
  await h.run()
  expect(h.transport.calls.map(r => r.contract.worker_role)).toEqual(['定点精度与误差复核', 'release investigator'])
})
it('leaves pending work unclaimed when the Codex compatibility gate rejects an update', async () => {
  const port = transport(); port.preflight = () => { throw new Error('recertification required') }
  const h = host(area(), port); h.submit('a', contract())
  await expect(h.run()).rejects.toThrow('recertification')
  expect(h.turns()).toEqual([]); expect(port.calls).toEqual([])
  expect(h.effects.pending('launch')).toBe(true)
})
it('holds one exclusive host and releases the OS lock when closed', async () => {
  const dir = area(), h = host(dir)
  expect(() => new DurableRuntime({ directory: dir, transport: transport() })).toThrow('Another host')
  await close(h)
  host(dir)
})
it('rejects legacy and future DSH schemas rather than attempting deployment migration', () => {
  for (const version of [1, 10, 12]) {
    const path = join(area(), 'db.sqlite'), db = new DatabaseSync(path)
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(version)); db.close()
    expect(() => new Store(path)).toThrow(/Unsupported/)
    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare('SELECT value FROM kv WHERE key=?').get('schema')?.value).toBe(String(version)); unchanged.close()
  }
})
it('resumes the same explicit session with a distinct turn after reopening the store', async () => {
  const dir = area(), port = transport(), h = host(dir, port), id = h.submit('task', contract())
  await h.run(); const first = h.turns()[0]
  await close(h)
  const next = host(dir, port)
  next.engine.note(id, 'PEER_RESULT: follow-up context')
  await next.run()
  expect(port.calls).toHaveLength(2)
  expect(port.calls[1].session_id).toBe(first.result.session_id)
  expect(port.calls[1].turn_id).not.toBe(first.id)
  expect(JSON.stringify(port.calls[1].inputs)).toContain('PEER_RESULT')
})
it('retains a note arriving during execution for the next turn', async () => {
  let h, id
  const port = transport(async (request, digest) => {
    if (port.calls.length === 1) h.engine.note(id, 'Arrived while busy')
    return answer(request, digest)
  })
  h = host(area(), port); id = h.submit('task', contract())
  await h.run()
  expect(port.calls).toHaveLength(2)
  expect(JSON.stringify(port.calls[0].inputs)).not.toContain('Arrived while busy')
  expect(JSON.stringify(port.calls[1].inputs)).toContain('Arrived while busy')
  expect(h.store.tickets.get(id).undelivered).toEqual([])
})
it('does not dispatch new work outside an explicit finite run', async () => {
  const h = host(), id = h.submit('a', contract()); await h.run()
  h.engine.note(id, 'queued after return')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(h.transport.calls).toHaveLength(1)
  await h.run(); expect(h.transport.calls).toHaveLength(2)
})
it.each([2,4,16])('keeps the same resource serialized at capacity %i', async capacity => {
  let active = 0, peak = 0
  const activeRepos = new Set()
  let clock = Date.now()
  const port = transport(async (request, digest) => {
    expect(activeRepos.has(request.contract.repo_id)).toBe(false)
    activeRepos.add(request.contract.repo_id); peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--; activeRepos.delete(request.contract.repo_id)
    return answer(request, digest)
  })
  const h = host(area(), port, { capacity,now: () => clock })
  h.submit('a', contract('same')); h.submit('b', contract('same')); h.submit('c', contract('other'))
  await h.run(); clock += 2001; await h.run()
  expect(port.calls).toHaveLength(3); expect(peak).toBe(2)
})
it.each([4,16])('runs up to %i independent workers and queues the rest',async capacity=>{
 let active=0,peak=0,release
 const barrier=new Promise<void>(done=>{release=done})
 const port=transport(async(request,digest)=>{
  peak=Math.max(peak,++active);if(active===capacity)release()
  await barrier;await new Promise(r=>setTimeout(r,10));active--
  return answer(request,digest)
 })
 const h=host(area(),port,{capacity,maxTurns:20})
 for(let i=0;i<capacity+2;i++)h.submit('parallel-'+i,contract('resource-'+i))
 await h.run();expect(peak).toBe(capacity);expect(port.calls).toHaveLength(capacity+2)
 expect(h.turns().every(t=>t.state==='completed')).toBe(true)
})
it('reduces capacity without cancelling active work and restores saved capacity without opening a panel',async()=>{
 let active=0,h
 const port=transport(async(request,digest)=>{
  if(port.calls.length>4)expect(active).toBe(0)
  active++;if(port.calls.length===4)h.capacity=1
  await new Promise(r=>setTimeout(r,25));active--;return answer(request,digest)
 })
 const dir=area();h=host(dir,port,{capacity:4})
 for(let i=0;i<6;i++)h.submit('lower-'+i,contract('resource-'+i))
 await h.run();expect(port.calls).toHaveLength(6);expect(port.cancelled).toEqual([])
 new Versions(h.store,'codex.panel.settings.revision',family('codex.panel.settings.version:')).save(revision=>({revision,value:{maxWorkers:16}}))
 await close(h);const reopened=host(dir,port)
 expect(reopened.capacity).toBe(16)
 for(const invalid of [0,17,2.5,NaN])expect(()=>{reopened.capacity=invalid}).toThrow('1..16')
})
it('retains four uncertain slots across restart and refuses a fifth launch',async()=>{
 const dir=area(),port=transport(async()=>{throw Error('Lost receipt')})
 let h=host(dir,port,{capacity:4})
 for(let i=0;i<4;i++)h.submit('unknown-'+i,contract('resource-'+i))
 await h.run();expect(port.calls).toHaveLength(4);await close(h)
 h=host(dir,port,{capacity:4});h.submit('fifth',contract('fifth-resource'));await h.run()
 expect(port.calls).toHaveLength(4);expect(h.turns().every(t=>t.state==='uncertain')).toBe(true)
})
it('preserves unresolved execution and its capacity across a restart', async () => {
  const dir = area(), port = transport(async () => { throw new Error('Connection lost after launch') })
  const h = host(dir, port, { capacity: 1 })
  h.submit('a', contract('one')); await h.run(); await close(h)
  const next = host(dir, port, { capacity: 1 }); next.submit('b', contract('two')); await next.run()
  expect(port.calls).toHaveLength(1)
  expect(next.turns()).toHaveLength(1); expect(next.turns()[0].state).toBe('uncertain')
})
it('adopts a durable receipt on recovery without re-execution', async () => {
  const dir = area()
  let saved
  const port = transport(async (request, digest) => { saved = answer(request, digest); throw new Error('Lost callback') })
  const h = host(dir, port); h.submit('a', contract()); await h.run(); await close(h)
  port.receipts.set(saved.turn_id, saved)
  const next = host(dir, port); await next.run()
  expect(port.calls).toHaveLength(1); expect(next.turns()[0].state).toBe('completed')
  expect(next.store.db.prepare('SELECT * FROM codex_review').all()).toHaveLength(1)
})
it('requires explicit stop evidence before releasing an uncertain turn for a new assignment', async () => {
  const port = transport(async () => { throw new Error('Unknown outcome') })
  const h = host(area(), port), id = h.submit('a', contract()); await h.run()
  const turn = h.turns()[0]
  expect(() => h.reconcileStopped(turn.id)).toThrow('evidence')
  expect(h.turn(turn.id).state).toBe('uncertain')
  h.reconcileStopped(turn.id, { confirmedStopped: true, evidence: 'Test transport has no live process', operator: 'test' })
  await h.run(); expect(port.calls).toHaveLength(1)
  h.engine.retryTicket(id); await h.run(); expect(port.calls).toHaveLength(2)
})
it('does not automatically retry a confirmed failed turn on another delivery effect', async () => {
  const port = transport(async (request, digest) => answer(request, digest, { status: 'failed', error: 'bad output' }))
  const h = host(area(), port), id = h.submit('a', contract()); await h.run()
  h.engine.note(id, 'new context'); await h.run()
  expect(port.calls).toHaveLength(1)
  h.engine.retryTicket(id); await h.run()
  expect(port.calls).toHaveLength(2)
  expect(port.calls[0].assignment_id).not.toBe(port.calls[1].assignment_id)
  expect(port.calls[1].session_id).toBeNull()
})
it('fences a late result after explicit assignment replacement', async () => {
  let h, id, replacement = false
  const port = transport(async (request, digest) => {
    if (!replacement) { replacement = true; h.engine.report(id, { state: 'failed', summary: 'retry requested' }); h.engine.retryTicket(id) }
    return answer(request, digest)
  })
  h = host(area(), port); id = h.submit('a', contract()); await h.run()
  expect(h.turns().map(t => t.state)).toEqual(['stale', 'completed'])
  expect(h.store.db.prepare('SELECT * FROM codex_review').all()).toHaveLength(1)
})
it('stops queued work without launching and keeps it stopped after restart', async () => {
  const dir = area(), port = transport(), h = host(dir, port), id = h.submit('a', contract())
  h.engine.stopTicket(id); await h.run(); await close(h)
  const next = host(dir, port); await next.run()
  expect(port.calls).toEqual([]); expect(next.store.tickets.get(id).ended.by).toBe('human')
})
it('requests running cancellation and rejects the late successful result', async () => {
  let h, id
  const port = transport(async (request, digest) => { h.engine.stopTicket(id); return answer(request, digest) })
  h = host(area(), port); id = h.submit('a', contract()); await h.run()
  expect(port.cancelled).toEqual([h.turns()[0].id])
  expect(h.turns()[0].state).toBe('stale')
  expect(h.store.db.prepare('SELECT * FROM codex_review').all()).toEqual([])
})
it.each(['request_hash', 'ticket_id', 'assignment_id', 'turn_id', 'session_id'])('holds a mismatched %s callback for inspection', async field => {
  const port = transport(async (request, digest) => answer(request, digest, { [field]: 'wrong' }))
  const h = host(area(), port); h.submit('a', contract()); await h.run()
  expect(h.turns()[0].state).toBe('uncertain')
  expect(h.store.db.prepare('SELECT * FROM codex_review').all()).toEqual([])
})
it('rejects a changed resume session and conflicting duplicate result', async () => {
  const port = transport(async (request, digest) => answer(request, digest, { session_id: randomUUID() }))
  const h = host(area(), port), id = h.submit('a', contract()); await h.run()
  const first = h.turns()[0]
  expect(h.complete(first.id, first.result)).toBe('completed')
  expect(() => h.complete(first.id, { ...first.result, report: { ...first.result.report, summary: 'tampered' } })).toThrow('Conflicting')
  h.engine.note(id, 'resume'); await h.run(); expect(h.turns()[1].state).toBe('uncertain')
})
it('retains queued input after a finite turn budget is exhausted', async () => {
  let h, id
  const port = transport(async (request, digest) => { h.engine.note(id, 'more'); return answer(request, digest) })
  h = host(area(), port, { maxTurns: 1 }); id = h.submit('a', contract()); await h.run()
  expect(port.calls).toHaveLength(1); expect(h.store.tickets.get(id).undelivered).toHaveLength(1)
})
it.each(['receipt', 'uncertain'])('recovers after abrupt OS process exit: %s', mode => {
  const directory = area(), script = fileURLToPath(new URL('./fixtures/crash-host.mjs', import.meta.url))
  const run = action => spawnSync(process.execPath, ['--experimental-transform-types', script, directory, action], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  const crashed = run(mode); expect(crashed.status, crashed.stderr).toBe(73)
  const recovered = run('recover'); expect(recovered.status, recovered.stderr).toBe(0)
  expect(JSON.parse(recovered.stdout)).toEqual({ state: mode === 'receipt' ? 'completed' : 'uncertain', calls: 0 })
})
