import { randomUUID } from 'node:crypto'
import { hash } from '../src/durable-runtime.mjs'
import { WatchOutput, require } from './contracts.mjs'

/** Local extension: upstream public source has health/idle/retry primitives, no complete independent Watchdog. */
export class Watchdog {
  constructor(agent, control, { budget = 8, intervalMs = 120000, now = () => Date.now() } = {}) {
    this.agent = agent; this.store = agent.store; this.control = control; this.budget = budget; this.intervalMs = intervalMs; this.now = now; this.busy = false
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS sa_watch(id TEXT PRIMARY KEY,project TEXT,state TEXT,request TEXT,digest TEXT,response TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS sa_correction(ticket TEXT,turn TEXT,kind TEXT,PRIMARY KEY(ticket,turn,kind))`)
  }
  context(project) {
    const tickets = this.agent.tickets(project).map(t=>({...t,elapsed_minutes:['running','uncertain'].includes(t.turn_state)&&t.turn_started_at?Math.floor((this.now()-Date.parse(t.turn_started_at))/60000):null}))
    return { projects: this.agent.project(project).capabilities.map(c => ({repo_id:c.repo_id})), tickets,
      recent_events: this.store.db.prepare('SELECT value FROM codex_event ORDER BY seq DESC LIMIT 40').all().map(r => JSON.parse(r.value)),
      policy: { direction_only:true, require_current_turn_evidence:true, restart_allowed:false },
      calls: this.store.db.prepare('SELECT state,error FROM sa_call WHERE project=? ORDER BY rowid DESC LIMIT 3').all(project) }
  }
  accept(row, response) {
    const request = JSON.parse(row.request)
    require(response.request_id === row.id && response.request_hash === row.digest && response.status === 'completed', 'Invalid Watchdog receipt')
    const output = WatchOutput.parse(response.output)
    require(output.request_id === row.id && output.snapshot_hash === request.snapshot_hash, 'Watchdog identity mismatch')
    return this.store.atomic(() => {
      if (this.store.db.prepare('SELECT state FROM sa_watch WHERE id=?').get(row.id).state === 'applied') return 'applied'
      const current = this.agent.tickets(row.project)
      for (const c of output.concerns) {
        const original = request.context.tickets.find(t => t.ticket_id === c.ticket_id && t.turn_id === c.turn_id)
        require(original, 'Watchdog cited an unknown ticket or turn')
        const live = current.find(t => t.ticket_id === c.ticket_id && t.turn_id === c.turn_id && !t.ended)
        if (!live || c.action === 'observe') continue
        if (this.store.db.prepare('SELECT 1 FROM sa_correction WHERE ticket=? AND turn=? AND kind=?').get(c.ticket_id,c.turn_id,c.action)) continue
        if (c.action === 'request_status') {
          if (['running','uncertain'].includes(live.turn_state)) continue
          this.agent.runtime.engine.requestStatus(c.ticket_id)
        } else {
          // Router receives evidence and bounded guidance; Watchdog cannot change a mandate, scope or permissions.
          this.agent.message('watch:' + row.id + ':' + c.ticket_id,row.project,'watchdog',{
            ticket_id:c.ticket_id,turn_id:c.turn_id,evidence:c.evidence,suggestion:c.instruction,
            text:'Check this suggestion against the original mandate before giving bounded guidance to the worker.'})
        }
        this.store.db.prepare('INSERT INTO sa_correction VALUES (?,?,?)').run(c.ticket_id,c.turn_id,c.action)
      }
      this.store.db.prepare("UPDATE sa_watch SET state='applied',response=? WHERE id=?").run(JSON.stringify(response),row.id)
      return 'applied'
    })
  }
  settle(row, response) {
    try { return this.accept(row,response) }
    catch (error) {this.store.db.prepare("UPDATE sa_watch SET state='invalid',error=?,response=? WHERE id=?").run(String(error),JSON.stringify(response),row.id); return 'invalid'}
  }
  async once(force = false) {
    if (this.busy || this.store.get('sa.paused')) return 'idle'
    this.busy = true
    try {
      for (const row of this.store.db.prepare("SELECT * FROM sa_watch WHERE state IN ('running','uncertain')").all()) {
        const result = await this.control.result(row.id)
        if (result) this.settle(row,result)
        else this.store.db.prepare("UPDATE sa_watch SET state='uncertain' WHERE id=?").run(row.id)
      }
      if (this.budget <= 0) return 'budget'
      for (const project of this.agent.projects) {
        if (this.store.db.prepare("SELECT 1 FROM sa_watch WHERE project=? AND state IN ('running','uncertain','invalid')").get(project.id)) continue
        const context = this.context(project.id), fingerprint = hash(JSON.stringify(context.tickets))
        if (!context.tickets.some(t => t.turn_id && !t.ended)) continue
        if (!force && (this.now() - (this.store.get('watch.at.'+project.id) ?? 0) < this.intervalMs || this.store.get('watch.hash.'+project.id) === fingerprint)) continue
          const id = randomUUID(), request = {kind:'watchdog',prompt:this.agent.prompts.snapshot('watchdog'),request_id:id,session_id:null,snapshot_hash:fingerprint,context}, encoded=JSON.stringify(request)
        const row = {id,project:project.id,request:encoded,digest:hash(encoded)}
        this.store.db.prepare("INSERT INTO sa_watch VALUES (?,?,'running',?,?,NULL,NULL)").run(id,project.id,encoded,row.digest)
        this.store.set('watch.at.'+project.id,this.now()); this.store.set('watch.hash.'+project.id,fingerprint); this.budget--
        try { return this.settle(row,await this.control.execute(request,row.digest)) }
        catch (error) { this.store.db.prepare("UPDATE sa_watch SET state='uncertain',error=? WHERE id=?").run(String(error),id); return 'uncertain' }
      }
      return 'idle'
    } finally {this.busy=false}
  }
}
