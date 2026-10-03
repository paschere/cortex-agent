import 'server-only';
import { getSupabaseServiceClient } from '../supabase/service';
import { requireSupportOperator } from './operator';
import type { SupportStatus } from './shape';
import type { TicketMessageRow } from './store';

/**
 * La bandeja de soporte de la plataforma: los tickets de TODAS las empresas.
 *
 * Es el único sitio que lee `support_tickets` sin la empresa clavada, y por
 * eso cada función empieza por `requireSupportOperator()` — no basta con que
 * la página lo haya comprobado: una acción de servidor se puede llamar sola.
 * Está en la lista de `lib/tenancy-guard.test.ts` con su razón.
 */

export interface OperatorTicket {
  id: string;
  number: number;
  organization_id: string;
  organization_name: string | null;
  created_by_email: string | null;
  subject: string;
  status: SupportStatus;
  route: string | null;
  user_agent: string | null;
  context: Record<string, unknown>;
  screenshot_path: string | null;
  email_sent_at: string | null;
  email_error: string | null;
  created_at: string;
  updated_at: string;
}

export async function listAllTickets(
  filter: { status?: SupportStatus | 'abiertos' } = {},
  limit = 100,
): Promise<OperatorTicket[]> {
  await requireSupportOperator();
  const db = getSupabaseServiceClient();
  let query = db
    .from('support_tickets')
    .select(
      'id, number, organization_id, created_by_email, subject, status, route, user_agent, context, screenshot_path, email_sent_at, email_error, created_at, updated_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (filter.status === 'abiertos') {
    query = query.in('status', ['abierto', 'en_curso', 'esperando_cliente']);
  } else if (filter.status) {
    query = query.eq('status', filter.status);
  }
  const { data, error } = await query;
  if (error) throw new Error(`No pude leer los tickets: ${error.message}`);
  const rows = (data ?? []) as Omit<OperatorTicket, 'organization_name'>[];

  const orgIds = [...new Set(rows.map((r) => r.organization_id))];
  const names = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgs, error: orgError } = await db
      .from('ba_organization')
      .select('id, name')
      .in('id', orgIds);
    if (orgError) throw new Error(`No pude leer las empresas: ${orgError.message}`);
    for (const o of (orgs ?? []) as Array<{ id: string; name: string }>) names.set(o.id, o.name);
  }
  return rows.map((r) => ({ ...r, organization_name: names.get(r.organization_id) ?? null }));
}

export async function operatorTicketMessages(ticketIds: string[]): Promise<TicketMessageRow[]> {
  await requireSupportOperator();
  if (ticketIds.length === 0) return [];
  const { data, error } = await getSupabaseServiceClient()
    .from('support_ticket_messages')
    .select('id, ticket_id, author_kind, author_email, body, created_at')
    .in('ticket_id', ticketIds)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`No pude leer los mensajes: ${error.message}`);
  return (data ?? []) as TicketMessageRow[];
}

/** Un ticket por id, con su empresa y quién lo escribió. */
export async function operatorTicket(id: string): Promise<{
  id: string;
  number: number;
  organization_id: string;
  created_by_email: string | null;
  subject: string;
  screenshot_path: string | null;
  screenshot_type: string | null;
} | null> {
  await requireSupportOperator();
  const { data, error } = await getSupabaseServiceClient()
    .from('support_tickets')
    .select(
      'id, number, organization_id, created_by_email, subject, screenshot_path, screenshot_type',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`No pude leer el ticket: ${error.message}`);
  return data as Awaited<ReturnType<typeof operatorTicket>>;
}

export async function setTicketStatus(id: string, status: SupportStatus): Promise<void> {
  await requireSupportOperator();
  const now = new Date().toISOString();
  const { error } = await getSupabaseServiceClient()
    .from('support_tickets')
    .update({
      status,
      updated_at: now,
      resolved_at: status === 'resuelto' || status === 'cerrado' ? now : null,
    })
    .eq('id', id);
  if (error) throw new Error(`No pude cambiar el estado: ${error.message}`);
}

/** La respuesta de soporte entra al hilo con la empresa DEL TICKET, no otra. */
export async function addOperatorReply(
  ticket: { id: string; organization_id: string },
  author: { id: string; email: string },
  body: string,
): Promise<void> {
  await requireSupportOperator();
  const db = getSupabaseServiceClient();
  const { error } = await db.from('support_ticket_messages').insert({
    organization_id: ticket.organization_id,
    ticket_id: ticket.id,
    author_kind: 'soporte',
    // El operador puede no tener fila en el directorio de ESA empresa.
    author_user_id: null,
    author_email: author.email,
    body: body.trim(),
  });
  if (error) throw new Error(`No pude guardar la respuesta: ${error.message}`);
  const { error: upError } = await db
    .from('support_tickets')
    .update({ status: 'esperando_cliente', updated_at: new Date().toISOString() })
    .eq('id', ticket.id);
  if (upError) throw new Error(`No pude actualizar el ticket: ${upError.message}`);
}
