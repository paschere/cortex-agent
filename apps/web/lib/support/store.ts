import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupportContext, SupportStatus } from './shape';

/**
 * Tickets de soporte y votos de la ayuda, DESDE LA EMPRESA (migración 0190).
 *
 * Todo con el cliente de la empresa (`getOrgScopedClient`): una empresa sólo
 * ve y escribe sus propios tickets. La bandeja que ve todos los tickets de la
 * plataforma está aparte, en `operator-store.ts`, con su puerta.
 */

export const SUPPORT_BUCKET = 'support';

export interface TicketRow {
  id: string;
  number: number;
  subject: string;
  status: SupportStatus;
  route: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface TicketMessageRow {
  id: string;
  ticket_id: string;
  author_kind: 'cliente' | 'soporte';
  author_email: string | null;
  body: string;
  created_at: string;
}

export async function createTicket(
  db: SupabaseClient,
  input: {
    userId: string;
    email: string;
    subject: string;
    message: string;
    context: SupportContext & { organizationName?: string };
    screenshot: { path: string; type: string } | null;
  },
): Promise<{ id: string; number: number }> {
  const { route, userAgent, ...rest } = input.context;
  const { data, error } = await db
    .from('support_tickets')
    .insert({
      created_by: input.userId,
      created_by_email: input.email,
      subject: input.subject.trim(),
      route: route ?? null,
      user_agent: userAgent ?? null,
      context: rest,
      screenshot_path: input.screenshot?.path ?? null,
      screenshot_type: input.screenshot?.type ?? null,
    })
    .select('id, number')
    .single();
  if (error) throw new Error(`No pude guardar el mensaje a soporte: ${error.message}`);
  const ticket = data as { id: string; number: number };

  const { error: msgError } = await db.from('support_ticket_messages').insert({
    ticket_id: ticket.id,
    author_kind: 'cliente',
    author_user_id: input.userId,
    author_email: input.email,
    body: input.message.trim(),
  });
  if (msgError) throw new Error(`No pude guardar el mensaje a soporte: ${msgError.message}`);
  return ticket;
}

/** Deja constancia del aviso por correo (o de por qué no salió). */
export async function markTicketEmail(
  db: SupabaseClient,
  ticketId: string,
  outcome: { sent: boolean; reason?: string },
): Promise<void> {
  const { error } = await db
    .from('support_tickets')
    .update(
      outcome.sent
        ? { email_sent_at: new Date().toISOString(), email_error: null }
        : { email_error: (outcome.reason ?? 'no se envió').slice(0, 300) },
    )
    .eq('id', ticketId);
  if (error) throw new Error(`No pude anotar el correo del ticket: ${error.message}`);
}

/** Los tickets que escribió esta persona, el más nuevo primero. */
export async function listMyTickets(
  db: SupabaseClient,
  userId: string,
  limit = 20,
): Promise<TicketRow[]> {
  const { data, error } = await db
    .from('support_tickets')
    .select('id, number, subject, status, route, created_at, updated_at, resolved_at')
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`No pude leer tus mensajes a soporte: ${error.message}`);
  return (data ?? []) as TicketRow[];
}

/** El hilo de unos tickets de la empresa. */
export async function listTicketMessages(
  db: SupabaseClient,
  ticketIds: string[],
): Promise<TicketMessageRow[]> {
  if (ticketIds.length === 0) return [];
  const { data, error } = await db
    .from('support_ticket_messages')
    .select('id, ticket_id, author_kind, author_email, body, created_at')
    .in('ticket_id', ticketIds)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`No pude leer las respuestas de soporte: ${error.message}`);
  return (data ?? []) as TicketMessageRow[];
}

/** «¿Te sirvió?»: un voto por persona y artículo; votar de nuevo lo cambia. */
export async function saveHelpFeedback(
  db: SupabaseClient,
  input: {
    userId: string;
    slug: string;
    helpful: boolean;
    comment?: string | null;
    route?: string | null;
  },
): Promise<void> {
  const { error } = await db.from('help_feedback').upsert(
    {
      user_id: input.userId,
      article_slug: input.slug,
      helpful: input.helpful,
      comment: input.comment?.trim().slice(0, 1000) || null,
      route: input.route?.slice(0, 300) ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,user_id,article_slug' },
  );
  if (error) throw new Error(`No pude guardar tu voto: ${error.message}`);
}

/** El voto que ya dejó esta persona en un artículo, si alguno. */
export async function readHelpFeedback(
  db: SupabaseClient,
  userId: string,
  slug: string,
): Promise<boolean | null> {
  const { data, error } = await db
    .from('help_feedback')
    .select('helpful')
    .eq('user_id', userId)
    .eq('article_slug', slug)
    .maybeSingle();
  if (error) return null;
  return (data as { helpful: boolean } | null)?.helpful ?? null;
}
