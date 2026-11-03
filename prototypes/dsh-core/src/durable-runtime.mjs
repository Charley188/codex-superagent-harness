import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Store } from '../adapted/store.ts'
import { Engine, latestAssignment, liveTicket } from '../vendor/dsh/src/core/index.ts'
import { Effects, Later } from '../vendor/dsh/src/app/effects.ts'
import { HealthBoard } from '../vendor/dsh/src/infra/health.ts'
import {LIMITS} from '../vendor/dsh/src/limits.ts'
import {Versions} from '../vendor/dsh/src/app/versions.ts'
import {family} from '../vendor/dsh/src/kv.ts'

export const hash = text => createHash('sha256').update(text).digest('hex')
const check = (ok, message) => { if (!ok) throw new Error(message) }
const parsed = row => row && { ...row, request: JSON.parse(row.request), result: row.result && JSON.parse(row.result) }

/** Finite host around the original Engine/Store/Effects. No model routing, external sources or daemon. */
export class DurableRuntime {
  constructor({ directory, transport, capacity = 2, maxTurns = 8, now = () => Date.now() }) {
    this.capacity=capacity
    check(Number.isInteger(maxTurns) && maxTurns >= 0 && maxTurns <= 20, 'Finite turn budget required')
    mkdirSync(directory, { recursive: true })
    // A separate SQLite transaction is an OS-released process lock, without stale-PID guessing.
    this.guard = new DatabaseSync(join(directory, 'host-lock.sqlite'))
    try { this.guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
    catch (error) { this.guard.close(); throw new Error('Another host owns this state directory', { cause: error }) }
    try {
      this.store = new Store(join(directory, 'orchestrator.sqlite'))
      this.store.atomic(() => {
        const version = this.store.get('codex.schema')
        check(version === undefined || version === 1, 'Unsupported Codex binding schema')
        this.store.db.exec(`
          CREATE TABLE IF NOT EXISTS codex_binding(assignment_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL,
            contract TEXT NOT NULL, session_id TEXT, current_turn TEXT);
          CREATE TABLE IF NOT EXISTS codex_turn(id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
            repo_id TEXT NOT NULL, state TEXT NOT NULL, request_hash TEXT NOT NULL, request TEXT NOT NULL,
            result TEXT, error TEXT, created_at TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS codex_repo_busy ON codex_turn(repo_id) WHERE state IN ('running','uncertain');
          CREATE TABLE IF NOT EXISTS codex_review(turn_id TEXT PRIMARY KEY, state TEXT NOT NULL, result_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS codex_event(seq INTEGER PRIMARY KEY, value TEXT NOT NULL);
        `)
        this.store.set('codex.schema', 1)
      })
      const saved=new Versions(this.store,'codex.panel.settings.revision',family('codex.panel.settings.version:')).current()
      if(saved)this.capacity=saved.value.maxWorkers
    } catch (error) { this.store?.close(); this.guard.close(); throw error }
    this.transport = transport
    this.remaining = maxTurns
    this.dispatching = false
    this.running = false
    this.effects = new Effects(this.store, new HealthBoard(), now)
    const policy = { version: 'local-explicit-v1', paused: false, evalTimeoutMs: 60_000,
      gate: trigger => trigger.source === 'local' && trigger.human && trigger.actor.id === 'local-user'
        ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
        : { admissible: false, reason: 'notLocalUser' }, revalidate: () => true, admitsInferred: () => false }
    this.engine = new Engine({ repo: this.store, policy: () => policy,
      scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request() {} },
      executor: {
        start: (ticket, assignment) => {
          const contract = this.store.get('codex.contract.' + ticket.id) ?? this.pendingContract
          check(contract, 'Missing host-owned execution contract')
          this.store.set('codex.contract.' + ticket.id, contract)
          this.store.db.prepare('INSERT OR IGNORE INTO codex_binding(assignment_id,ticket_id,contract) VALUES (?,?,?)')
            .run(assignment.id, ticket.id, JSON.stringify(contract))
          this.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
        },
        deliver: ticket => this.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }),
        stop: (ticket, assignment) => {
          this.effects.cancel('launch', assignment.id)
          this.effects.cancel('delivery', ticket.id)
          const binding = this.binding(assignment.id)
          if (binding?.current_turn) this.store.afterCommit(() => this.transport.cancel(binding.current_turn))
        },
      },
      outbox: { send() { throw new Error('External channels are not configured') }, status() {}, withdraw() {} },
      emit: event => this.audit(event),
    })
    this.effects.handle('launch', async ({ ticketId, assignmentId }) => {
      if (this.current(ticketId, assignmentId)) this.store.atomic(() => {
        this.engine.assignmentStarted(ticketId, assignmentId)
        this.effects.enqueue('delivery', ticketId, { ticketId }) // Initial origin is separate from undelivered Inputs upstream.
      })
    }, { limit: () => this.dispatching ? 1 : 0 })
    this.effects.handle('delivery', payload => this.deliver(payload.ticketId), { limit: () => this.dispatching ? this.capacity : 0 })
  }
  get capacity(){return this._capacity}
  set capacity(value){check(Number.isInteger(value)&&value>=LIMITS.maxWorkers.min&&value<=LIMITS.maxWorkers.max,'Capacity must be 1..16');this._capacity=value}
  audit(value) { this.store.db.prepare('INSERT INTO codex_event(value) VALUES (?)').run(JSON.stringify(value)) }
  binding(id) { return this.store.db.prepare('SELECT * FROM codex_binding WHERE assignment_id=?').get(id) }
  turn(id) { return parsed(this.store.db.prepare('SELECT * FROM codex_turn WHERE id=?').get(id)) }
  turns() { return this.store.db.prepare('SELECT * FROM codex_turn ORDER BY rowid').all().map(parsed) }
  current(ticketId, assignmentId) {
    const ticket = this.store.tickets.get(ticketId)
    return !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.id === assignmentId && latestAssignment(ticket)?.state !== 'ended'
  }
  /** Local explicit intake. Role text is arbitrary; permission and data scope are fixed by the host contract. */
  submit(eventId, contract) {
    check(typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 100, 'Invalid event ID')
    check(contract && Object.keys(contract).sort().join(',') === 'inputs,objective,permission,repo_id,worker_role', 'Invalid contract fields')
    for (const name of ['repo_id', 'worker_role', 'objective']) check(typeof contract[name] === 'string' && contract[name].trim().length > 0 && contract[name].length <= (name === 'objective' ? 1500 : 100), 'Invalid ' + name)
    check(contract.permission === 'read-only' && Array.isArray(contract.inputs) && contract.inputs.length > 0 && contract.inputs.length <= 20, 'Invalid input/permission scope')
    for (const input of contract.inputs) check(typeof input.path === 'string' && /^[a-f0-9]{64}$/.test(input.sha256), 'Input snapshot required')
    const serialized = JSON.stringify(contract)
    return this.store.atomic(() => {
      const previous = this.store.get('codex.submission.' + eventId)
      if (previous) { check(previous.contract === serialized, 'Event ID reused with different content'); return previous.ticketId }
      const trigger = { id: eventId, source: 'local', threads: [{ source: 'local', id: eventId }],
        actor: { source: 'local', id: 'local-user' }, human: true, at: new Date().toISOString(), text: contract.objective, meta: {} }
      this.engine.receive(trigger)
      // The core creates the ticket and calls executor.start within this same transaction.
      this.pendingContract = contract
      let decision
      try { decision = this.engine.decide(eventId, { kind: 'accept', title: contract.worker_role, scope: contract.objective, reason: 'Explicit local request' }) }
      finally { this.pendingContract = undefined }
      this.store.set('codex.submission.' + eventId, { contract: serialized, ticketId: decision.ticketId })
      return decision.ticketId
    })
  }
  async deliver(ticketId) {
    if (this.canDispatch && !this.canDispatch(ticketId)) throw new Later('Dependency or host dispatch hold')
    const ticket = this.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    if (!assignment || !this.current(ticketId, assignment.id)) return
    const binding = this.binding(assignment.id)
    check(binding, 'Missing assignment binding')
    const previous = binding.current_turn && this.turn(binding.current_turn)
    if (previous && ['running', 'uncertain'].includes(previous.state)) throw new Later('Unresolved turn requires reconciliation')
    if (previous && ['failed', 'cancelled'].includes(previous.state)) return // Only an explicit new Assignment may retry.
    if (previous && !ticket.undelivered.length) return
    if (this.remaining <= 0) throw new Later('Finite turn budget exhausted')
    const contract = JSON.parse(binding.contract)
    const resource = this.resourceKey?.(ticket, contract) ?? contract.repo_id
    const busy = this.store.db.prepare("SELECT repo_id FROM codex_turn WHERE state IN ('running','uncertain')").all()
    if (busy.length >= this.capacity || busy.some(row => row.repo_id === resource)) throw new Later('Capacity or repository held')
    const request = { version: 1, ticket_id: ticketId, assignment_id: assignment.id, turn_id: randomUUID(),
      session_id: binding.session_id ?? null, contract,
      origin: ticket.origin.triggerIds.map(id => this.store.triggers.get(id)),
      inputs: ticket.inputs.filter(input => ticket.undelivered.includes(input.id)).map(input => ({ ...input,
        ...(input.kind === 'trigger' ? { trigger: this.store.triggers.get(input.triggerId) } : {}) })) }
    this.enrichRequest?.(request)
    const encoded = JSON.stringify(request), requestHash = hash(encoded)
    this.store.atomic(() => {
      this.store.db.prepare('INSERT INTO codex_turn VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(request.turn_id, ticketId, assignment.id, resource, 'running', requestHash, encoded, null, null, new Date().toISOString())
      this.store.db.prepare('UPDATE codex_binding SET current_turn=? WHERE assignment_id=?').run(request.turn_id, assignment.id)
    })
    this.remaining--
    try {
      const response = await this.transport.execute(request, requestHash)
      this.complete(request.turn_id, response)
    } catch (error) {
      this.store.db.prepare("UPDATE codex_turn SET state='uncertain',error=? WHERE id=? AND state='running'").run(String(error), request.turn_id)
      this.audit({ type: 'codex.turn.uncertain', turnId: request.turn_id, error: String(error) })
      // Never allow Effects' ordinary retry to cause another external execution.
    }
  }
  complete(turnId, response) {
    return this.store.atomic(() => {
      const turn = this.turn(turnId)
      check(turn, 'Unknown turn')
      for (const field of ['ticket_id', 'assignment_id', 'turn_id']) check(response[field] === turn.request[field], 'Result identity mismatch: ' + field)
      check(response.request_hash === turn.request_hash, 'Result request hash mismatch')
      check(['completed', 'failed', 'cancelled'].includes(response.status), 'Invalid terminal result')
      const binding = this.binding(turn.assignment_id)
      if (response.status === 'completed') {
        check(typeof response.session_id === 'string' && /^[a-f0-9-]{36}$/i.test(response.session_id), 'Missing explicit session ID')
        check(!binding.session_id || binding.session_id === response.session_id, 'Session changed during resume')
        check(response.report?.task_id === turn.ticket_id && response.report?.attempt_id === turn.id && typeof response.report?.summary === 'string', 'Invalid report identity')
      }
      if (!['running', 'uncertain'].includes(turn.state)) {
        check(JSON.stringify(turn.result) === JSON.stringify(response), 'Conflicting terminal callback')
        return turn.state
      }
      const active = binding.current_turn === turn.id && this.current(turn.ticket_id, turn.assignment_id)
      const state = active ? response.status : 'stale'
      this.store.db.prepare('UPDATE codex_turn SET state=?, result=?, error=NULL WHERE id=?').run(state, JSON.stringify(response), turn.id)
      if (active) {
        if (response.status === 'completed') {
          this.store.db.prepare('UPDATE codex_binding SET session_id=? WHERE assignment_id=?').run(response.session_id, turn.assignment_id)
          this.engine.inputsDelivered(turn.ticket_id, turn.assignment_id, turn.request.inputs.map(i => i.id))
          // CLI proves completion of supplied input, not an exact live model-read timestamp.
          this.engine.inputsRead(turn.ticket_id, turn.request.inputs.map(i => i.id))
          this.store.db.prepare("INSERT INTO codex_review VALUES (?, 'pending', ?)").run(turn.id, hash(JSON.stringify(response.report)))
          this.engine.report(turn.ticket_id, { state: 'waiting', summary: response.report.summary })
        } else this.engine.report(turn.ticket_id, { state: 'failed', summary: response.error ?? response.status })
        this.engine.turnEnded(turn.ticket_id, turn.assignment_id)
      }
      this.audit({ type: 'codex.turn.' + state, turnId })
      return state
    })
  }
  /** Adopt a durable terminal receipt, otherwise hold capacity. No startup auto-relaunch. */
  async recover() {
    check(!this.dispatching, 'Cannot recover while this host is dispatching')
    for (const turn of this.turns().filter(t => ['running', 'uncertain'].includes(t.state))) {
      try {
        const result = await this.transport.result(turn.id)
        if (result) this.complete(turn.id, result)
        else this.store.db.prepare("UPDATE codex_turn SET state='uncertain',error='No terminal receipt; capacity retained' WHERE id=?").run(turn.id)
      } catch (error) {
        this.store.db.prepare("UPDATE codex_turn SET state='uncertain',error=? WHERE id=?").run(String(error), turn.id)
      }
    }
  }
  /** Explicit operator action only: the caller must verify the old process tree has stopped first. */
  reconcileStopped(turnId, { confirmedStopped, evidence, operator } = {}) {
    check(confirmedStopped === true && typeof evidence === 'string' && evidence.trim().length > 0
      && typeof operator === 'string' && operator.trim().length > 0, 'Verified stop evidence and operator are required')
    const turn = this.turn(turnId)
    check(turn?.state === 'uncertain', 'Only an uncertain turn can be reconciled')
    return this.store.atomic(() => {
      this.audit({ type: 'codex.turn.reconciled', turnId, evidence, operator })
      return this.complete(turnId, { ticket_id: turn.ticket_id, assignment_id: turn.assignment_id, turn_id: turn.id,
        request_hash: turn.request_hash, status: 'failed', error: 'Operator confirmed process tree stopped: ' + evidence })
    })
  }
  async run() {
    check(!this.running, 'A finite dispatch is already running')
    this.running = true
    try {
      await this.recover(); await this.transport.preflight?.()
      this.dispatching = true
      this.effects.start(); await this.effects.idle(); return this.turns()
    } finally { this.dispatching = false; this.running = false }
  }
  async close() { await this.effects.drain(); this.store.close(); this.guard.close() }
}
