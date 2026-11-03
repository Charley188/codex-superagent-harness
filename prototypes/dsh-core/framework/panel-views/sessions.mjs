import { AsyncLocalStorage } from 'node:async_hooks'
const context = new AsyncLocalStorage()
export const withSessions = (resolve, work) => context.run(resolve, work)
// Upstream projections use a DSH-derived ID. Codex uses the persisted actual UUID.
export const workerSessionId = ticketId => context.getStore()?.(ticketId) ?? ''
