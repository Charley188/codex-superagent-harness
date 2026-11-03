import { z } from 'zod'
const text = n => z.string().min(1).max(n)
const nullable = n => z.string().max(n).nullable()
// Flat and fully-required fields keep Codex structured output compatible; the original routeTool validates route fields again.
export const Action = z.object({ kind: z.enum(['accept','attach','ignore','stop','delegate','note','status','job']),
  trigger_id: nullable(120), ticket_id: nullable(120), key: nullable(32), capability_id: nullable(100),
  title: nullable(200), role: nullable(100), worktree_name: nullable(32), acknowledgement: nullable(600),
  note: nullable(1200), reason: nullable(500), depends_on: z.array(text(32)).max(4), job_profile: nullable(100) }).strict()
export const RouterOutput = z.object({ request_id: z.string().uuid(), snapshot_hash: text(64),
  reply: z.string().max(6000), actions: z.array(Action).max(8) }).strict()
export const WatchOutput = z.object({ request_id: z.string().uuid(), snapshot_hash: text(64),
  assessment: text(2000), concerns: z.array(z.object({ ticket_id: text(120), turn_id: text(120),
    kind: z.enum(['stalled','drift','failure','needs_information']), evidence: text(1500),
    action: z.enum(['observe','request_status','suggest_correction']), instruction: z.string().max(1000) }).strict()).max(8) }).strict()
export const Schemas = { router: RouterOutput, watchdog: WatchOutput }
export const require = (ok, why) => { if (!ok) throw new Error(why) }
