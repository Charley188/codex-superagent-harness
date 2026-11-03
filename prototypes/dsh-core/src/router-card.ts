/** Local read-only view boundary; upstream route logic and ticketStage remain unchanged. */
import { ticketStage, type Ticket } from '../vendor/dsh/src/core/index.ts'
export function ticketCard(ticket: Ticket) {
  return { ticket_id: ticket.id, title: ticket.title, stage: ticketStage(ticket),
    origin: ticket.origin, mandate: ticket.mandate, ended: ticket.ended,
    assignment: ticket.assignments.at(-1), undelivered: ticket.undelivered }
}
