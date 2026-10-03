import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientInvoice } from '../../clients/hub';
import { loadClientInvoices } from '../../clients/hub-read';
import { nitVariants } from '../../clients/identity';
import { nameKey } from '../../clients/shape';
import { bogotaToday } from '../../commitments/shape';
import { queryRows } from '../../trackers/store';
import { upsertWorkItems } from '../../work/store';
import type { OrderFact } from './answers';
import {
  type PhoneContact,
  type PhoneMatch,
  matchPhone,
  normalizeReference,
  sameReference,
} from './classify';
import type {
  CustomerDeps,
  EscalationReason,
  InboundCustomerMessage,
  RecentReply,
} from './handler';
import {
  CONVERSATION_COLUMNS,
  type ConversationRow,
  type ConversationStatus,
  type CustomerSettings,
  MESSAGE_COLUMNS,
  type MessageRow,
  type MessageSource,
  type OrderSource,
  type SettingsPatch,
  adaptSettings,
  displayPhone,
  replyRefusal,
  settingsToRow,
} from './shape';

/**
 * LO QUE TOCA LA BASE. `db` es SIEMPRE un handle con alcance de espacio
 * (createOrgScopedClient): nada de aquí filtra por organization_id a mano, y
 * eso es lo que hace imposible que una consulta de un cliente cruce de
 * empresa. Que no cruce de CLIENTE lo deciden el handler y `verifyClaim`.
 */

const SCAN = 5000;

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export async function loadCustomerSettings(db: SupabaseClient): Promise<CustomerSettings> {
  const { data, error } = await db.from('wa_customer_settings').select('*').maybeSingle();
  if (error) throw error;
  return adaptSettings(data as Record<string, unknown> | null);
}

export async function saveCustomerSettings(
  db: SupabaseClient,
  patch: SettingsPatch,
  userId: string,
): Promise<CustomerSettings> {
  const row = {
    ...settingsToRow(patch),
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from('wa_customer_settings')
    .upsert(row, { onConflict: 'organization_id' })
    .select('*')
    .single();
  if (error) throw error;
  return adaptSettings(data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Conversaciones y mensajes
// ---------------------------------------------------------------------------

function adaptConversation(row: Record<string, unknown>): ConversationRow {
  return {
    ...(row as unknown as ConversationRow),
    verify_attempts: Number(row.verify_attempts ?? 0),
    opted_out: row.opted_out === true,
  };
}

function adaptMessage(row: Record<string, unknown>): MessageRow {
  return {
    ...(row as unknown as MessageRow),
    sources: Array.isArray(row.sources) ? (row.sources as MessageSource[]) : [],
  };
}

/** La conversación viva de este número, o una nueva. Una carrera entre dos mensajes la resuelve el índice único. */
export async function openConversation(
  db: SupabaseClient,
  input: Pick<InboundCustomerMessage, 'phone' | 'jid' | 'pushName'>,
): Promise<ConversationRow> {
  const live = async () => {
    const { data, error } = await db
      .from('wa_customer_conversations')
      .select(CONVERSATION_COLUMNS)
      .eq('phone', input.phone)
      .neq('status', 'cerrada')
      .maybeSingle();
    if (error) throw error;
    return data ? adaptConversation(data as Record<string, unknown>) : null;
  };
  const found = await live();
  if (found) return found;

  // ¿Se había dado de baja en una conversación anterior? La baja es del
  // número, no de la conversación: se hereda.
  const { data: prior, error: priorError } = await db
    .from('wa_customer_conversations')
    .select('opted_out, opted_out_at')
    .eq('phone', input.phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (priorError) throw priorError;

  const { data, error } = await db
    .from('wa_customer_conversations')
    .insert({
      phone: input.phone,
      jid: input.jid,
      push_name: input.pushName?.trim().slice(0, 120) || null,
      opted_out: prior?.opted_out === true,
      opted_out_at: prior?.opted_out === true ? (prior.opted_out_at as string | null) : null,
    })
    .select(CONVERSATION_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const again = await live();
      if (again) return again;
    }
    throw error;
  }
  return adaptConversation(data as Record<string, unknown>);
}

export async function recordInbound(
  db: SupabaseClient,
  conv: ConversationRow,
  msg: { text: string; intent: string; waMessageId: string | null; pushName?: string | null },
): Promise<'ok' | 'duplicate'> {
  const now = new Date().toISOString();
  const { error } = await db.from('wa_customer_messages').insert({
    conversation_id: conv.id,
    direction: 'in',
    body: msg.text.slice(0, 4000),
    intent: msg.intent,
    wa_message_id: msg.waMessageId || null,
  });
  if (error) {
    if ((error as { code?: string }).code === '23505') return 'duplicate';
    throw error;
  }
  const { error: upError } = await db
    .from('wa_customer_conversations')
    .update({
      last_message_at: now,
      last_inbound_at: now,
      updated_at: now,
      ...(msg.pushName?.trim() ? { push_name: msg.pushName.trim().slice(0, 120) } : {}),
    })
    .eq('id', conv.id);
  if (upError) throw upError;
  return 'ok';
}

export async function recordBotReply(
  db: SupabaseClient,
  conv: ConversationRow,
  msg: { text: string; intent: string; sources: MessageSource[] },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from('wa_customer_messages').insert({
    conversation_id: conv.id,
    direction: 'out',
    body: msg.text.slice(0, 4000),
    intent: msg.intent,
    answered_by: 'bot',
    sources: msg.sources.slice(0, 40),
  });
  if (error) throw error;
  const { error: upError } = await db
    .from('wa_customer_conversations')
    .update({ last_message_at: now, updated_at: now })
    .eq('id', conv.id);
  if (upError) throw upError;
}

export async function patchConversation(
  db: SupabaseClient,
  id: string,
  patch: Partial<ConversationRow>,
): Promise<void> {
  const { id: _id, created_at: _c, ...rest } = patch as Partial<ConversationRow>;
  const { error } = await db
    .from('wa_customer_conversations')
    .update({ ...rest, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function botRepliesSince(
  db: SupabaseClient,
  conversationId: string,
  sinceIso: string,
): Promise<RecentReply[]> {
  const { data, error } = await db
    .from('wa_customer_messages')
    .select('intent, created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'out')
    .eq('answered_by', 'bot')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as RecentReply[];
}

// ---------------------------------------------------------------------------
// Quién es
// ---------------------------------------------------------------------------

export async function clientByPhone(db: SupabaseClient, phone: string): Promise<PhoneMatch> {
  const { data, error } = await db
    .from('client_contacts')
    .select('id, client_id, phone, status')
    .not('phone', 'is', null)
    .limit(SCAN);
  if (error) throw error;
  return matchPhone((data ?? []) as PhoneContact[], phone);
}

/**
 * NIT + número de factura → el cliente, sólo si las DOS cosas son del mismo.
 * Un NIT solo no basta: está en el RUT, en cada factura y en la web de la
 * DIAN. Una factura sola tampoco: viaja por correo a medio mundo. Las dos
 * juntas, contra los datos de la empresa, sí. Si dos clientes cuadran (un
 * duplicado sin unir), no es ninguno.
 */
export async function verifyClaim(
  db: SupabaseClient,
  nit: string,
  invoice: string,
): Promise<{ clientId: string } | null> {
  const variants = nitVariants(nit);
  if (variants.length === 0 || !normalizeReference(invoice)) return null;
  const { data: clients, error } = await db
    .from('clients')
    .select('id')
    .in('tax_id', variants)
    .limit(10);
  if (error) throw error;
  const ids = ((clients ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (ids.length === 0) return null;

  const [acc, docs] = await Promise.all([
    db.from('accounting_invoices').select('client_id, doc_number').in('client_id', ids).limit(SCAN),
    db
      .from('document_extractions')
      .select('client_id, doc_number')
      .in('client_id', ids)
      .eq('doc_type', 'invoice')
      .eq('review_state', 'confirmed')
      .limit(SCAN),
  ]);
  if (acc.error) throw acc.error;
  if (docs.error) throw docs.error;
  const owners = new Set<string>();
  for (const row of [...(acc.data ?? []), ...(docs.data ?? [])] as Array<{
    client_id: string;
    doc_number: string | null;
  }>) {
    if (sameReference(invoice, row.doc_number)) owners.add(row.client_id);
  }
  return owners.size === 1 ? { clientId: [...owners][0] as string } : null;
}

export async function customerClientName(
  db: SupabaseClient,
  clientId: string,
): Promise<string | null> {
  const { data, error } = await db.from('clients').select('name').eq('id', clientId).maybeSingle();
  if (error) throw error;
  return (data?.name as string | undefined) ?? null;
}

export function customerInvoices(db: SupabaseClient, clientId: string): Promise<ClientInvoice[]> {
  return loadClientInvoices(db, clientId, { today: bogotaToday() });
}

/** ¿El valor de la columna «cliente» de una fila es este cliente? Por NIT o por nombre. */
export function rowIsClient(
  value: unknown,
  client: { name: string; tax_id: string | null } | null,
): boolean {
  if (!client || value === null || value === undefined || value === '') return false;
  const text = String(value);
  if (client.tax_id) {
    const variants = new Set(nitVariants(text));
    if (variants.has(client.tax_id)) return true;
  }
  const key = nameKey(text);
  return !!key && key === nameKey(client.name);
}

/**
 * El estado de una guía o pedido. Busca el número exacto en cada tabla
 * configurada (y, si no aparece así, sin signos: «GU-123» = «gu123»). Devuelve
 * sólo estado, fecha estimada y fecha de actualización — nunca la fila.
 */
export async function findOrder(
  db: SupabaseClient,
  sources: readonly OrderSource[],
  number: string,
  clientId: string | null,
): Promise<OrderFact | null> {
  let client: { name: string; tax_id: string | null } | null = null;
  if (clientId) {
    const { data, error } = await db
      .from('clients')
      .select('name, tax_id')
      .eq('id', clientId)
      .maybeSingle();
    if (error) throw error;
    client = (data as { name: string; tax_id: string | null } | null) ?? null;
  }
  const wanted = normalizeReference(number);
  if (!wanted) return null;

  for (const source of sources) {
    let rows = await queryRows(db, {
      trackerId: source.trackerId,
      equals: { key: source.numberField, value: number },
      limit: 5,
    });
    if (rows.length === 0) {
      const { data, error } = await db
        .from('tracker_rows')
        .select('id, tracker_id, label, values, created_by, created_at, updated_at')
        .eq('tracker_id', source.trackerId)
        .order('updated_at', { ascending: false })
        .limit(SCAN);
      if (error) throw error;
      rows = (
        (data ?? []) as Array<{ id: string; values: Record<string, unknown>; updated_at: string }>
      )
        .filter((r) => normalizeReference(String(r.values?.[source.numberField] ?? '')) === wanted)
        .slice(0, 5) as typeof rows;
    }
    for (const row of rows) {
      const values = (row.values ?? {}) as Record<string, unknown>;
      if (normalizeReference(String(values[source.numberField] ?? '')) !== wanted) continue;
      // Con la columna de cliente y alguien ya identificado: si la fila es de
      // otro cliente, para este cliente no existe.
      if (source.clientField && client && !rowIsClient(values[source.clientField], client)) {
        continue;
      }
      const status = String(values[source.statusField] ?? '').trim();
      const eta = source.etaField ? String(values[source.etaField] ?? '').trim() : '';
      return {
        sourceLabel: source.label,
        rowId: row.id,
        number: String(values[source.numberField]),
        status: status || 'sin estado registrado todavía',
        eta: eta || null,
        updatedAt: row.updated_at ?? null,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pasar a una persona
// ---------------------------------------------------------------------------

const REASON_TEXT: Record<EscalationReason, string> = {
  cotizacion: 'pide una cotización',
  queja: 'tiene una queja',
  persona: 'pidió hablar con una persona',
  otro: 'preguntó algo que el bot no contesta',
  limite: 'llegó al límite de respuestas automáticas',
  verificacion: 'no pudo verificar su identidad',
  no_compartido: 'pidió algo que no se comparte por WhatsApp',
  error: 'el bot no pudo consultar los datos',
};

export interface EscalationResult {
  assigneeId: string | null;
  workItemId: string | null;
  title: string;
  who: string;
}

/**
 * La conversación pasa a una persona: queda `escalada`, asignada a quien la
 * empresa eligió, y entra como trabajo al registro (0174) — así aparece en
 * «Equipo» con su responsable y su fecha, y se cierra cuando se cierra la
 * conversación. El aviso de campana lo escribe la app (notify vive allí).
 */
export async function escalateConversation(
  db: SupabaseClient,
  conv: ConversationRow,
  input: { reason: EscalationReason; settings: CustomerSettings; now?: Date },
): Promise<EscalationResult> {
  const now = input.now ?? new Date();
  const assigneeId = conv.assigned_to ?? input.settings.escalationUserId;
  const clientName = conv.client_id ? await customerClientName(db, conv.client_id) : null;
  const who = clientName ?? conv.push_name ?? displayPhone(conv.phone);
  const title = `Responder por WhatsApp a ${who}: ${REASON_TEXT[input.reason]}`.slice(0, 300);

  let workItemId: string | null = conv.work_item_id;
  try {
    const result = await upsertWorkItems(db, [
      {
        assigneeId,
        assigneeLabel: assigneeId ? null : (input.settings.escalationTeam ?? 'Atención al cliente'),
        workType: 'atención al cliente',
        title,
        status: 'open',
        openedAt: now.toISOString(),
        // Un cliente esperando por WhatsApp no espera días: vence en 4 horas.
        dueAt: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
        lastActivityAt: now.toISOString(),
        team: input.settings.escalationTeam,
        source: { kind: 'whatsapp', system: 'atencion', ref: conv.id },
      },
    ]);
    workItemId = result.ids.values().next().value ?? workItemId;
  } catch {
    // El registro de trabajo es la segunda copia del pendiente; la primera es
    // la conversación escalada, y esa sí se escribe.
  }

  await patchConversation(db, conv.id, {
    status: 'escalada',
    assigned_to: assigneeId,
    escalated_at: now.toISOString(),
    escalation_reason: REASON_TEXT[input.reason],
    work_item_id: workItemId,
  });
  return { assigneeId, workItemId, title, who };
}

// ---------------------------------------------------------------------------
// Una persona contesta, y el puente entrega
// ---------------------------------------------------------------------------

export async function getConversation(
  db: SupabaseClient,
  id: string,
): Promise<ConversationRow | null> {
  const { data, error } = await db
    .from('wa_customer_conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptConversation(data as Record<string, unknown>) : null;
}

/**
 * Deja la respuesta de una persona en la cola del puente. Sólo dentro de una
 * conversación abierta en la que el cliente escribió en las últimas 24 h:
 * así «responder como persona» nunca es escribir primero.
 */
export async function queueHumanReply(
  db: SupabaseClient,
  input: { conversationId: string; text: string; userId: string; now?: Date },
): Promise<{ messageId: string; conversation: ConversationRow }> {
  const text = input.text.trim();
  if (!text) throw new ValidationError('Escribe la respuesta.');
  if (text.length > 3000) throw new ValidationError('La respuesta es muy larga (máximo 3000).');
  const conv = await getConversation(db, input.conversationId);
  if (!conv) throw new NotFoundError('No encuentro esa conversación.');
  const refusal = replyRefusal(conv, input.now ?? new Date());
  if (refusal) throw new ValidationError(refusal);

  const now = (input.now ?? new Date()).toISOString();
  const { data, error } = await db
    .from('wa_customer_messages')
    .insert({
      conversation_id: conv.id,
      direction: 'out',
      body: text,
      answered_by: 'persona',
      author_id: input.userId,
      delivery: 'pendiente',
    })
    .select('id')
    .single();
  if (error) throw error;
  // Desde que una persona contesta, la conversación es de una persona: el bot
  // no vuelve a meterse hasta que se cierre.
  await patchConversation(db, conv.id, {
    status: 'escalada',
    assigned_to: conv.assigned_to ?? input.userId,
    escalated_at: conv.escalated_at ?? now,
    last_message_at: now,
  });
  return { messageId: String(data.id), conversation: conv };
}

export async function closeConversation(
  db: SupabaseClient,
  input: { conversationId: string; userId: string },
): Promise<void> {
  const conv = await getConversation(db, input.conversationId);
  if (!conv) throw new NotFoundError('No encuentro esa conversación.');
  if (conv.status === 'cerrada') return;
  const now = new Date().toISOString();
  const { error } = await db
    .from('wa_customer_conversations')
    .update({ status: 'cerrada', closed_at: now, closed_by: input.userId, updated_at: now })
    .eq('id', conv.id);
  if (error) throw error;
  if (conv.work_item_id) {
    const { error: workError } = await db
      .from('work_items')
      .update({ status: 'done', done_at: now, last_activity_at: now, updated_at: now })
      .eq('id', conv.work_item_id)
      .eq('status', 'open');
    if (workError) throw workError;
  }
}

export interface OutboxItem {
  id: string;
  jid: string;
  text: string;
}

/** Cuánto se espera a que el puente confirme antes de volver a ofrecer un mensaje. */
const CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Lo que una persona escribió y el puente todavía no entregó. Se marca
 * `enviando` al entregarlo, así un latido que llega dos veces no lo manda dos
 * veces. Lo que lleva más de 24 h esperando se da por fallido: entregarlo
 * ahora ya sería escribir en frío. Si el cliente se dio de baja mientras
 * esperaba, tampoco sale.
 */
export async function claimOutbox(
  db: SupabaseClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<OutboxItem[]> {
  const now = opts.now ?? new Date();
  const staleClaim = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  const { data, error } = await db
    .from('wa_customer_messages')
    .select('id, conversation_id, body, delivery, claimed_at, created_at')
    .in('delivery', ['pendiente', 'enviando'])
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    conversation_id: string;
    body: string;
    delivery: string;
    claimed_at: string | null;
    created_at: string;
  }>;
  const ready = rows.filter(
    (r) => r.delivery === 'pendiente' || (r.claimed_at !== null && r.claimed_at < staleClaim),
  );
  if (ready.length === 0) return [];

  const { data: convs, error: convError } = await db
    .from('wa_customer_conversations')
    .select('id, jid, opted_out, last_inbound_at')
    .in('id', [...new Set(ready.map((r) => r.conversation_id))]);
  if (convError) throw convError;
  const byId = new Map(
    (
      (convs ?? []) as Array<{
        id: string;
        jid: string;
        opted_out: boolean;
        last_inbound_at: string | null;
      }>
    ).map((c) => [c.id, c]),
  );

  const out: OutboxItem[] = [];
  const failed: string[] = [];
  for (const r of ready) {
    const conv = byId.get(r.conversation_id);
    const age = now.getTime() - Date.parse(r.created_at);
    if (!conv || conv.opted_out || age > 24 * 60 * 60 * 1000) {
      failed.push(r.id);
      continue;
    }
    if (out.length < (opts.limit ?? 5)) out.push({ id: r.id, jid: conv.jid, text: r.body });
  }
  if (failed.length > 0) {
    const { error: failError } = await db
      .from('wa_customer_messages')
      .update({ delivery: 'fallido' })
      .in('id', failed);
    if (failError) throw failError;
  }
  if (out.length > 0) {
    const { error: claimError } = await db
      .from('wa_customer_messages')
      .update({ delivery: 'enviando', claimed_at: now.toISOString() })
      .in(
        'id',
        out.map((o) => o.id),
      );
    if (claimError) throw claimError;
  }
  return out;
}

export async function ackOutbox(
  db: SupabaseClient,
  input: { id: string; ok: boolean },
): Promise<void> {
  const { error } = await db
    .from('wa_customer_messages')
    .update(
      input.ok
        ? { delivery: 'enviado', sent_at: new Date().toISOString() }
        : { delivery: 'fallido' },
    )
    .eq('id', input.id)
    .eq('delivery', 'enviando');
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Lectura para la pantalla y la herramienta
// ---------------------------------------------------------------------------

export interface ConversationListItem extends ConversationRow {
  client_name: string | null;
  assignee_name: string | null;
  last_body: string | null;
  last_direction: 'in' | 'out' | null;
  last_answered_by: 'bot' | 'persona' | null;
}

export async function listCustomerConversations(
  db: SupabaseClient,
  opts: { status?: ConversationStatus | 'activas'; clientId?: string; limit?: number } = {},
): Promise<ConversationListItem[]> {
  let q = db
    .from('wa_customer_conversations')
    .select(CONVERSATION_COLUMNS)
    .order('last_message_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 50, 200));
  if (opts.status === 'activas') q = q.neq('status', 'cerrada');
  else if (opts.status) q = q.eq('status', opts.status);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = ((data ?? []) as Record<string, unknown>[]).map(adaptConversation);
  if (rows.length === 0) return [];

  const clientIds = [...new Set(rows.map((r) => r.client_id).filter(Boolean))] as string[];
  const userIds = [...new Set(rows.map((r) => r.assigned_to).filter(Boolean))] as string[];
  const [clients, users, msgs] = await Promise.all([
    clientIds.length
      ? db.from('clients').select('id, name').in('id', clientIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? db.from('users').select('id, name, email').in('id', userIds)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('wa_customer_messages')
      .select('conversation_id, body, direction, answered_by, created_at')
      .in(
        'conversation_id',
        rows.map((r) => r.id),
      )
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);
  if (clients.error) throw clients.error;
  if (users.error) throw users.error;
  if (msgs.error) throw msgs.error;
  const clientName = new Map(
    ((clients.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );
  const userName = new Map(
    ((users.data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
      u.id,
      u.name || u.email,
    ]),
  );
  const last = new Map<
    string,
    { body: string; direction: 'in' | 'out'; answered_by: 'bot' | 'persona' | null }
  >();
  for (const m of (msgs.data ?? []) as Array<{
    conversation_id: string;
    body: string;
    direction: 'in' | 'out';
    answered_by: 'bot' | 'persona' | null;
  }>) {
    if (!last.has(m.conversation_id)) last.set(m.conversation_id, m);
  }
  return rows.map((r) => ({
    ...r,
    client_name: r.client_id ? (clientName.get(r.client_id) ?? null) : null,
    assignee_name: r.assigned_to ? (userName.get(r.assigned_to) ?? null) : null,
    last_body: last.get(r.id)?.body ?? null,
    last_direction: last.get(r.id)?.direction ?? null,
    last_answered_by: last.get(r.id)?.answered_by ?? null,
  }));
}

export async function listConversationMessages(
  db: SupabaseClient,
  conversationId: string,
): Promise<MessageRow[]> {
  const { data, error } = await db
    .from('wa_customer_messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(adaptMessage);
}

// ---------------------------------------------------------------------------
// Las dependencias del handler, armadas sobre un handle
// ---------------------------------------------------------------------------

/**
 * `onEscalated` lo pone la app: avisa en la campana (notify vive en apps/web).
 */
export function customerDeps(
  db: SupabaseClient,
  opts: {
    onEscalated?: (result: EscalationResult, conv: ConversationRow) => Promise<void>;
    now?: () => Date;
  } = {},
): CustomerDeps {
  let cached: CustomerSettings | null = null;
  const settings = async () => {
    cached ??= await loadCustomerSettings(db);
    return cached;
  };
  return {
    now: opts.now ?? (() => new Date()),
    settings,
    conversation: (input) => openConversation(db, input),
    recordInbound: (conv, msg) => recordInbound(db, conv, msg),
    recordOutbound: (conv, msg) => recordBotReply(db, conv, msg),
    patchConversation: (id, patch) => patchConversation(db, id, patch),
    botRepliesSince: (id, since) => botRepliesSince(db, id, since),
    clientByPhone: (phone) => clientByPhone(db, phone),
    verifyClaim: (nit, invoice) => verifyClaim(db, nit, invoice),
    clientName: (id) => customerClientName(db, id),
    invoices: (id) => customerInvoices(db, id),
    findOrder: (sources, number, clientId) => findOrder(db, sources, number, clientId),
    escalate: async (conv, input) => {
      const result = await escalateConversation(db, conv, {
        reason: input.reason,
        settings: await settings(),
      });
      if (opts.onEscalated) await opts.onEscalated(result, conv).catch(() => undefined);
    },
  };
}
