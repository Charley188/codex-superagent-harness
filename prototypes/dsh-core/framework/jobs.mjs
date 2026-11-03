import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash } from '../src/durable-runtime.mjs'
import { latestAssignment } from '../vendor/dsh/src/core/index.ts'
import { require } from './contracts.mjs'

/** Local adaptation of DSH background ownership: a model turn is not the lifetime of its jobs. */
export class Jobs {
  constructor(agent, directory, { capacity = 2, launch = launchJob } = {}) {
    this.agent = agent; this.store = agent.store; this.directory = directory; this.capacity = capacity; this.launch = launch; this.running = new Map()
    mkdirSync(directory, { recursive: true })
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS sa_job(id TEXT PRIMARY KEY, ticket TEXT, assignment TEXT, project TEXT, profile TEXT, dedupe TEXT UNIQUE, state TEXT, request TEXT, digest TEXT, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS sa_job_relay(id TEXT PRIMARY KEY)`)
    agent.activeJobs = ticket => this.rows(ticket).some(j => ['queued','running','uncertain'].includes(j.state))
    agent.jobStatus = ticket => this.rows(ticket).map(({id,profile,state,result,error}) => ({id,profile,state,result: result && JSON.parse(result),error}))
    agent.enqueueJob = (...args) => this.enqueue(...args)
    agent.cancelJobs = ticket => this.cancel(ticket)
  }
  rows(ticket) { return ticket ? this.store.db.prepare('SELECT * FROM sa_job WHERE ticket=?').all(ticket) : this.store.db.prepare('SELECT * FROM sa_job ORDER BY rowid').all() }
  folder(id) { require(/^[a-f0-9-]{36}$/i.test(id), 'Invalid job ID'); return join(this.directory, id) }
  enqueue(project, ticketId, profileId, callId) {
    this.agent.owns(project, ticketId)
    const ticket = this.store.tickets.get(ticketId), assignment = latestAssignment(ticket)
    require(!ticket.ended && assignment?.state !== 'ended', 'Task no longer active')
    const binding=this.agent.runtime.binding(assignment.id), last=binding?.current_turn && this.agent.runtime.turn(binding.current_turn)
    require(last?.state==='completed','Wait for the worker output before starting its registered tool job')
    const profile = this.agent.project(project).jobs?.find(p => p.id === profileId)
    require(profile && profile.argv?.length && profile.artifacts?.every(p => !p.includes('..') && !/^[\\/]|:/.test(p)), 'Unknown/invalid registered job profile')
    const dedupe = callId + ':' + ticketId + ':' + profileId, old = this.store.db.prepare('SELECT id FROM sa_job WHERE dedupe=?').get(dedupe)
    if (old) return { job: old.id }
    const id = randomUUID(), request = { id, profile, workspace: this.agent.workspace?.(ticketId) }, encoded = JSON.stringify(request)
    this.store.db.prepare("INSERT INTO sa_job VALUES (?,?,?,?,?,?,'queued',?,?,NULL,NULL)").run(id,ticketId,assignment.id,project,profileId,dedupe,encoded,hash(encoded))
    return { job: id }
  }
  receipt(id) { const path = join(this.folder(id),'result.json'); return existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : null }
  complete(row, result) {
    require(result.id === row.id && result.request_hash === row.digest && ['completed','failed','cancelled'].includes(result.status), 'Job receipt mismatch')
    return this.store.atomic(() => {
      const fresh = this.store.db.prepare('SELECT * FROM sa_job WHERE id=?').get(row.id)
      if (!['running','uncertain'].includes(fresh.state)) { require(fresh.result === JSON.stringify(result), 'Job result conflict'); return }
      this.store.db.prepare('UPDATE sa_job SET state=?,result=?,error=NULL WHERE id=?').run(result.status,JSON.stringify(result),row.id)
      if (!this.store.db.prepare('SELECT 1 FROM sa_job_relay WHERE id=?').get(row.id)) {
        this.agent.message('job:' + row.id,row.project,'job',{ticket_id:row.ticket,job_id:row.id,...result})
        if (this.agent.runtime.current(row.ticket,row.assignment)) this.agent.runtime.engine.note(row.ticket,'Registered background job ended: ' + JSON.stringify(result))
        this.store.db.prepare('INSERT INTO sa_job_relay VALUES (?)').run(row.id)
      }
    })
  }
  recover() {
    for (const row of this.rows().filter(r => ['running','uncertain'].includes(r.state) && !this.running.has(r.id))) {
      try {
        const result = this.receipt(row.id)
        if (result) this.complete(row,result)
        else this.store.db.prepare("UPDATE sa_job SET state='uncertain',error='No receipt; resource retained' WHERE id=?").run(row.id)
      } catch (error) { this.store.db.prepare("UPDATE sa_job SET state='uncertain',error=? WHERE id=?").run(String(error),row.id) }
    }
  }
  pump() {
    this.recover()
    if (this.store.get('sa.paused')) return
    for (const row of this.rows().filter(r => r.state === 'queued')) {
      if (this.rows().filter(r => ['running','uncertain'].includes(r.state)).length >= this.capacity) break
      if (!this.agent.runtime.current(row.ticket,row.assignment)) { this.store.db.prepare("UPDATE sa_job SET state='cancelled' WHERE id=?").run(row.id); continue }
      const binding = this.agent.runtime.binding(row.assignment), turn = binding?.current_turn && this.agent.runtime.turn(binding.current_turn)
      if (['running','uncertain'].includes(turn?.state) || this.rows(row.ticket).some(r => ['running','uncertain'].includes(r.state))) continue
      if (!this.agent.dependenciesReady(row.ticket)) continue
      this.store.db.prepare("UPDATE sa_job SET state='running' WHERE id=?").run(row.id)
      const work = this.launch(this.folder(row.id), row.request).then(result => this.complete(row,result))
        .catch(error => this.store.db.prepare("UPDATE sa_job SET state='uncertain',error=? WHERE id=?").run(String(error),row.id))
        .finally(() => this.running.delete(row.id))
      this.running.set(row.id,work)
    }
  }
  cancel(ticket) {
    for (const row of this.rows(ticket)) {
      if (row.state === 'queued') this.store.db.prepare("UPDATE sa_job SET state='cancelled' WHERE id=?").run(row.id)
      if (['running','uncertain'].includes(row.state)) { mkdirSync(this.folder(row.id), {recursive:true}); writeFileSync(join(this.folder(row.id),'cancel'),'cancel') }
    }
  }
  reconcileStopped(id,{confirmedStopped,evidence}={}) {
    const row=this.store.db.prepare('SELECT * FROM sa_job WHERE id=?').get(id)
    require(row?.state==='uncertain' && confirmedStopped===true && typeof evidence==='string' && evidence.trim(),'Verified job stop evidence required')
    this.agent.runtime.audit({type:'job.reconciled',id,evidence})
    this.complete(row,{id,request_hash:row.digest,status:'failed',reason:'Operator verified stopped: '+evidence,artifacts:[]})
  }
  cancelRunning() {
    for(const row of this.rows().filter(r=>['running','uncertain'].includes(r.state))){
      mkdirSync(this.folder(row.id),{recursive:true});writeFileSync(join(this.folder(row.id),'cancel'),'cancel')
    }
  }
  async close() { for (const r of this.rows()) if (['queued','running','uncertain'].includes(r.state)) this.cancel(r.ticket); await Promise.allSettled(this.running.values()) }
}
export async function launchJob(folder, encoded) {
  mkdirSync(folder,{recursive:true}); writeFileSync(join(folder,'request.json'),encoded,{flag:'wx'})
  const heartbeat = () => writeFileSync(join(folder,'heartbeat'),String(Date.now()))
  heartbeat(); const timer = setInterval(heartbeat,1000)
  try {
    await new Promise((done,reject) => {
      const child = spawn('python',['-B',fileURLToPath(new URL('./job_worker.py',import.meta.url)),'--request',join(folder,'request.json')],{windowsHide:true,stdio:['ignore','ignore','pipe']})
      let error=''; child.stderr.on('data', b => {error=(error+b).slice(-8000)})
      child.once('error',reject); child.once('close',code => code === 0 ? done() : reject(new Error(error || 'Job runner exit '+code)))
    })
    return JSON.parse(readFileSync(join(folder,'result.json'),'utf8'))
  } finally {clearInterval(timer)}
}
