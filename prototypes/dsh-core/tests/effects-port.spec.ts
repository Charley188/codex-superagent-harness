/** Exercise the unchanged upstream Effects against a minimal real SQLite host port. */
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { Effects, Later } from '../vendor/dsh/src/app/effects.ts'
import { HealthBoard } from '../vendor/dsh/src/infra/health.ts'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE effect(kind TEXT, key TEXT, value TEXT, seq INTEGER, generation INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0, error TEXT DEFAULT '', due INTEGER, since TEXT, PRIMARY KEY(kind,key))`)
  const callbacks: (() => void)[] = []
  const store = { db, afterCommit(fn: () => void) { callbacks.push(fn) } }
  const board = new HealthBoard()
  let now = 1000
  // Only this structural store port is used by Effects at runtime; no DSH service is loaded.
  const effects = new Effects(store as never, board, () => now)
  return { db, effects, board, tick: () => { now += 2000 },
    atomic(fn: () => void) {
      db.exec('BEGIN')
      try { fn(); db.exec('COMMIT'); for (const cb of callbacks.splice(0)) cb() }
      catch (error) { db.exec('ROLLBACK'); callbacks.length = 0; throw error }
    } }
}

it('does not execute a launch rolled back with its command', async () => {
  const h = fixture(), observed: string[] = []
  try {
    h.effects.handle('launch', async (_, key) => { observed.push(key) })
    h.effects.start()
    expect(() => h.atomic(() => { h.effects.enqueue('launch', 'a', { ticketId: 't', assignmentId: 'a' }); throw new Error('rollback') })).toThrow('rollback')
    await h.effects.idle()
    expect(observed).toEqual([])
    expect(h.effects.pending('launch')).toBe(false)
  } finally { await h.effects.drain(); h.db.close() }
})

it('keeps a replacement generation when an older running delivery completes', async () => {
  const h = fixture(), observed: string[] = []
  try {
    h.effects.handle('relay', async payload => {
      observed.push(payload.text)
      if (payload.text === 'old') h.effects.enqueue('relay', 'same', { text: 'new' })
    })
    h.atomic(() => h.effects.enqueue('relay', 'same', { text: 'old' }))
    h.effects.start()
    await h.effects.idle()
    expect(observed).toEqual(['old', 'new'])
    expect(h.effects.pending('relay')).toBe(false)
  } finally { await h.effects.drain(); h.db.close() }
})

it('defers capacity limits without counting them as failures', async () => {
  const h = fixture()
  let capacity = false, calls = 0
  try {
    h.effects.handle('launch', async () => { calls++; if (!capacity) throw new Later('busy') })
    h.effects.enqueue('launch', 'a', { ticketId: 't', assignmentId: 'a' })
    h.effects.start(); await h.effects.idle()
    expect(h.db.prepare('SELECT attempts,due FROM effect').get()).toMatchObject({ attempts: 0, due: 3000 })
    capacity = true; h.tick(); await h.effects.idle()
    expect(calls).toBe(2)
    expect(h.effects.pending('launch')).toBe(false)
  } finally { await h.effects.drain(); h.db.close() }
})

it('persists backoff across an effects host restart', async () => {
  const h = fixture()
  try {
    h.effects.handle('relay', async () => { throw new Error('synthetic offline') })
    h.effects.enqueue('relay', 'retry', { text: 'same request' })
    h.effects.start(); await h.effects.idle(); await h.effects.drain()
    const seen: string[] = []
    const restarted = new Effects({ db: h.db, afterCommit: (f: () => void) => f() } as never, new HealthBoard(), () => 3000)
    restarted.handle('relay', async payload => { seen.push(payload.text) })
    restarted.start(); await restarted.idle(); await restarted.drain()
    expect(seen).toEqual(['same request'])
    expect(h.db.prepare('SELECT count(*) AS n FROM effect').get()).toMatchObject({ n: 0 })
  } finally { h.db.close() }
})
