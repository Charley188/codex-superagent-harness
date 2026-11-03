import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { Engine, MemoryRepositories } from '../vendor/dsh/src/core/index.ts'
import { routeTool } from '../adapted/router-tools.ts'

function fixture() {
  const repo = new MemoryRepositories(), launches: string[] = [], deliveries: string[] = []
  const engine = new Engine({ repo,
    policy: () => ({ version: 'test', paused: false, evalTimeoutMs: 60_000,
      gate: t => t.human ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'notHuman' },
      revalidate: () => true, admitsInferred: () => false }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request() {} },
    executor: { start: (t, a) => launches.push(a.id), deliver: t => deliveries.push(t.id), stop() {} },
    outbox: { send() { throw new Error('No external channel') }, status() {}, withdraw() {} } })
  const tool = routeTool({ engine, store: repo, quietly: fn => fn(), requestPass() {}, context: { logger: { warn() {} } } } as never)
  const receive = (id: string, thread = id, human = true) => engine.receive({ id, source: 'local', threads: [{ source: 'local', id: thread }],
    actor: { source: 'local', id: human ? 'user' : 'bot' }, human, at: new Date().toISOString(), text: 'Synthetic request ' + id, meta: {} })
  const run = async (...decisions: any[]) => tool.execute(tool.schema.parse({ decisions }), new AbortController().signal) as any
  const accept = (trigger_id: string) => ({ kind: 'accept', trigger_id, title: 'Review synthetic input', worktree_name: 'review-input', acknowledgement: '收到，检查这份材料。' })
  return { repo, engine, launches, deliveries, receive, run, accept }
}
it('keeps upstream accept idempotency and does not turn a replay into another worker', async () => {
  const h = fixture(); h.receive('a')
  const first = await h.run(h.accept('a')), second = await h.run({ ...h.accept('a'), title: 'changed' })
  expect(second.results[0].ticket.ticket_id).toBe(first.results[0].ticket.ticket_id)
  expect(second.results[0].ticket.title).toBe('Review synthetic input'); expect(h.launches).toHaveLength(1)
})
it('keeps per-item refusal without rolling back other routing decisions', async () => {
  const h = fixture(); ['a', 'b', 'c'].forEach(id => h.receive(id))
  const { results } = await h.run({ kind: 'ignore', trigger_id: 'a', reason: 'Discussion only' }, { kind: 'stop', trigger_id: 'b' }, h.accept('c'))
  expect(results[0].decision).toBe('ignore'); expect(results[1].refused).toContain('ticket_id'); expect(results[2].decision).toBe('accept')
  expect(h.repo.tickets.list()).toHaveLength(1)
})
it('retains upstream field validation and rejects an oversized routing note', async () => {
  const h = fixture(); h.receive('a')
  expect((await h.run({ ...h.accept('a'), worktree_name: 'Too Many Invalid Words' })).results[0].refused).toContain('worktree_name')
  expect((await h.run({ ...h.accept('a'), note: Array(31).fill('word').join(' ') })).results[0].refused).toContain('note')
  expect(h.launches).toEqual([])
})
it('passes human follow-ups through subscriptions without creating another ticket or rerouting them', async () => {
  const h = fixture(); h.receive('a')
  const id = (await h.run(h.accept('a'))).results[0].ticket.ticket_id
  h.engine.assignmentStarted(id, h.launches[0]); h.receive('followup', 'a')
  expect(h.deliveries).toContain(id)
  const attempt = await h.run(h.accept('followup'))
  expect(attempt.results[0].refused).toBeTruthy(); expect(h.repo.tickets.list()).toHaveLength(1)
})
it('supports attach under the original Engine message ownership rules', async () => {
  const h = fixture(); h.receive('a'); h.receive('b')
  const id = (await h.run(h.accept('a'))).results[0].ticket.ticket_id
  expect((await h.run({ kind: 'attach', trigger_id: 'b', ticket_id: id })).results[0].ticket.ticket_id).toBe(id)
  expect(h.repo.threads.get('local:b')?.subscriptions).toContain(id)
})
it('lets explicit human stop reach its worker but refuses bot-created stop authority', async () => {
  const h = fixture(); h.receive('a')
  const id = (await h.run(h.accept('a'))).results[0].ticket.ticket_id
  h.receive('bot-stop', 'a', false)
  await h.run({ kind: 'stop', trigger_id: 'bot-stop', ticket_id: id })
  expect(h.repo.tickets.get(id)?.ended).toBeUndefined()
  h.receive('human-stop', 'a')
  expect((await h.run({ kind: 'stop', trigger_id: 'human-stop', ticket_id: id })).results[0].decision).toBe('stop')
  expect(h.repo.tickets.get(id)?.ended?.by).toBe('human')
})
it('does not let attach revive a ticket explicitly stopped by a human', async () => {
  const h = fixture(); h.receive('a'); const id = (await h.run(h.accept('a'))).results[0].ticket.ticket_id
  h.engine.stopTicket(id); h.receive('b')
  expect((await h.run({ kind: 'attach', trigger_id: 'b', ticket_id: id })).results[0].refused).toBeTruthy()
})
it('retains the exact routing command/validator fragments from the pinned source', () => {
  const manifest = JSON.parse(readFileSync(new URL('../adapted/router-extraction.json', import.meta.url), 'utf8'))
  const generated = readFileSync(new URL('../adapted/router-tools.ts', import.meta.url), 'utf8')
  const sources = ['main.ts', 'tool.ts'].map(f => readFileSync(new URL('../vendor/dsh/src/app/tools/' + f, import.meta.url), 'utf8'))
  sources.push(readFileSync(new URL('../vendor/dsh/src/app/assessment.ts', import.meta.url), 'utf8'))
  for (const fragment of Object.values(manifest.fragments) as any[]) {
    expect(createHash('sha256').update(fragment.text).digest('hex')).toBe(fragment.sha256)
    expect(sources.some(source => source.includes(fragment.text))).toBe(true)
    expect(generated).toContain(fragment.text)
  }
  expect(manifest.body_modifications).toEqual([])
})
