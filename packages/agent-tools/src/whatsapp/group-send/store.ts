import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  GROUP_INBOX_RETENTION_DAYS,
  GROUP_JID_RE,
  GROUP_SEND_MAX_QUEUE_AGE_MS,
  type SendGroupRef,
  capRefusal,
  cleanOutgoingText,
  isRepeat,
  resolveSendGroup,
  textRefusal,
} from './rules';

/**
 * COLA, REGISTRO Y LECTURA DE LOS MENSAJES DE CORTEX A GRUPOS (migración 0213).
 * Todo con el handle de la empresa. Mismo camino que las respuestas a clientes
 * (customer/store.ts): se encola aquí, viaja en el latido del puente, el puente
 * acusa recibo.
 */

const CLAIM_TTL_MS = 2 * 60_000;

export async function listSendGroups(db: SupabaseClient): Promise<SendGroupRef[]> {
  const { data, error } = await db
    .from('whatsapp_groups')
    .select('jid, subject')
    .eq('send_enabled', true)
    .order('subject', { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as SendGroupRef[];
}

export async function groupSendPaused(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db
    .from('whatsapp_sessions')
    .select('group_send_paused')
    .maybeSingle();
  if (error) throw error;
  return (data as { group_send_paused?: boolean } | null)?.group_send_paused === true;
}

async function usage(db: SupabaseClient, jid: string, now: Date) {
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const { data, error } = await db
    .from('wa_group_outbox')
    .select('group_jid, body, created_at, status')
    .gte('created_at', dayAgo)
    .neq('status', 'cancelado')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    group_jid: string;
    body: string;
    created_at: string;
    status: string;
  }>;
  return {
    usage: {
      groupLastHour: rows.filter((r) => r.group_jid === jid && r.created_at >= hourAgo).length,
      orgLastDay: rows.length,
    },
    recent: rows
      .filter((r) => r.group_jid === jid)
      .map((r) => ({ body: r.body, createdAt: r.created_at })),
  };
}

export interface QueuedGroupMessage {
  id: string;
  groupJid: string;
  groupName: string;
}

/**
 * Encola un mensaje a un grupo habilitado. Todas las negativas son
 * `ValidationError` con la frase en español: sin habilitar, apagado general,
 * topes, repetido, texto malo.
 */
export async function queueGroupMessage(
  db: SupabaseClient,
  input: {
    group: string;
    text: string;
    userId: string;
    via: 'chat' | 'automation';
    now?: Date;
  },
): Promise<QueuedGroupMessage> {
  const now = input.now ?? new Date();
  const text = cleanOutgoingText(input.text);
  const bad = textRefusal(text);
  if (bad) throw new ValidationError(bad);

  if (await groupSendPaused(db))
    throw new ValidationError(
      'Los mensajes de Cortex a grupos están apagados (apagado general en Integraciones → WhatsApp).',
    );
  const groups = await listSendGroups(db);
  if (groups.length === 0)
    throw new ValidationError(
      'Ningún grupo permite mensajes de Cortex. Un administrador debe marcar «Permitir mensajes de Cortex» en el grupo (Integraciones → WhatsApp).',
    );
  const res = resolveSendGroup(groups, input.group);
  if (res.kind === 'none')
    throw new NotFoundError(
      `«${input.group}» no es un grupo habilitado para mensajes de Cortex. Habilitados: ${groups.map((g) => g.subject ?? g.jid).join(', ')}.`,
    );
  if (res.kind === 'ambiguous')
    throw new ValidationError(
      `Varios grupos coinciden con «${input.group}»: ${res.candidates.map((g) => g.subject ?? g.jid).join(', ')}. Usa el nombre completo.`,
    );
  const group = res.group;
  if (!GROUP_JID_RE.test(group.jid))
    throw new ValidationError('Sólo se escribe a grupos, nunca a contactos individuales.');

  const used = await usage(db, group.jid, now);
  const capped = capRefusal(used.usage);
  if (capped) throw new ValidationError(capped);
  if (isRepeat(text, used.recent, now))
    throw new ValidationError(
      'Ese mismo mensaje ya se mandó a ese grupo hace pocos minutos; no se repite.',
    );

  const { data, error } = await db
    .from('wa_group_outbox')
    .insert({
      group_jid: group.jid,
      body: text,
      status: 'pendiente',
      requested_by: input.userId,
      via: input.via,
      created_at: now.toISOString(),
    })
    .select('id')
    .single();
  if (error) throw error;
  return {
    id: String((data as { id: string }).id),
    groupJid: group.jid,
    groupName: group.subject ?? group.jid,
  };
}

export interface GroupOutboxItem {
  id: string;
  jid: string;
  text: string;
}

/** Lo que el latido entrega al puente: pendientes (o con reclamo vencido) de grupos aún habilitados. */
export async function claimGroupOutbox(
  db: SupabaseClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<GroupOutboxItem[]> {
  const now = opts.now ?? new Date();
  if (await groupSendPaused(db)) return [];
  const { data, error } = await db
    .from('wa_group_outbox')
    .select('id, group_jid, body, status, claimed_at, created_at')
    .in('status', ['pendiente', 'enviando'])
    .order('created_at', { ascending: true })
    .limit(20);
  if (error) throw error;
  const stale = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  const rows = (
    (data ?? []) as Array<{
      id: string;
      group_jid: string;
      body: string;
      status: string;
      claimed_at: string | null;
      created_at: string;
    }>
  ).filter((r) => r.status === 'pendiente' || (r.claimed_at !== null && r.claimed_at < stale));
  if (rows.length === 0) return [];

  const enabled = new Set((await listSendGroups(db)).map((g) => g.jid));
  const out: GroupOutboxItem[] = [];
  const dead: Array<{ id: string; why: string }> = [];
  for (const r of rows) {
    if (!enabled.has(r.group_jid))
      dead.push({ id: r.id, why: 'El grupo ya no permite mensajes de Cortex.' });
    else if (now.getTime() - Date.parse(r.created_at) > GROUP_SEND_MAX_QUEUE_AGE_MS)
      dead.push({ id: r.id, why: 'Caducó en la cola (más de 30 minutos).' });
    else out.push({ id: r.id, jid: r.group_jid, text: r.body });
  }
  for (const d of dead)
    await db.from('wa_group_outbox').update({ status: 'cancelado', error: d.why }).eq('id', d.id);
  if (out.length === 0) return [];
  const { error: claimError } = await db
    .from('wa_group_outbox')
    .update({ status: 'enviando', claimed_at: now.toISOString() })
    .in(
      'id',
      out.map((o) => o.id),
    );
  if (claimError) throw claimError;
  return out.slice(0, opts.limit ?? 3);
}

/** El puente dice si salió. Sólo se mueve lo que está «enviando». */
export async function ackGroupOutbox(
  db: SupabaseClient,
  input: { id: string; ok: boolean; messageId?: string | null; error?: string | null; now?: Date },
): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  const { data, error } = await db
    .from('wa_group_outbox')
    .update(
      input.ok
        ? { status: 'enviado', sent_at: now, wa_message_id: input.messageId ?? null }
        : { status: 'fallido', error: (input.error ?? 'No se pudo enviar.').slice(0, 300) },
    )
    .eq('id', input.id)
    .eq('status', 'enviando')
    .select('group_jid, body, wa_message_id')
    .maybeSingle();
  if (error) throw error;
  const row = data as { group_jid: string; body: string; wa_message_id: string | null } | null;
  // Lo que Cortex dijo también queda en el hilo que se lee, para ver pregunta y respuesta juntas.
  if (input.ok && row?.wa_message_id) {
    await db.from('wa_group_inbox').upsert(
      {
        group_jid: row.group_jid,
        message_id: row.wa_message_id,
        from_me: true,
        sender_name: 'Cortex',
        sent_at: now,
        body: row.body,
      },
      { onConflict: 'organization_id,group_jid,message_id', ignoreDuplicates: true },
    );
  }
}

export interface IncomingGroupMessage {
  groupJid: string;
  messageId: string;
  senderJid?: string | null;
  senderName?: string | null;
  sentAt: string;
  body: string;
  quotedMessageId?: string | null;
  quotedBody?: string | null;
}

/** Guarda lo dicho en grupos habilitados (segunda llave: se re-verifica aquí). Devuelve cuántos guardó. */
export async function recordGroupMessages(
  db: SupabaseClient,
  messages: IncomingGroupMessage[],
  now: Date = new Date(),
): Promise<number> {
  const enabled = new Set((await listSendGroups(db)).map((g) => g.jid));
  const rows = messages
    .filter((m) => enabled.has(m.groupJid) && m.messageId && m.body.trim() && m.sentAt)
    .slice(0, 200)
    .map((m) => ({
      group_jid: m.groupJid,
      message_id: m.messageId,
      from_me: false,
      sender_jid: m.senderJid ?? null,
      sender_name: m.senderName ?? null,
      sent_at: m.sentAt,
      body: m.body.trim().slice(0, 4000),
      quoted_message_id: m.quotedMessageId ?? null,
      quoted_body: m.quotedBody ? m.quotedBody.slice(0, 500) : null,
    }));
  if (rows.length === 0) return 0;
  const { error } = await db
    .from('wa_group_inbox')
    .upsert(rows, { onConflict: 'organization_id,group_jid,message_id', ignoreDuplicates: true });
  if (error) throw error;
  // Retención: lo viejo se va con cada tanda; no hace falta un barrido aparte.
  const cutoff = new Date(now.getTime() - GROUP_INBOX_RETENTION_DAYS * 86_400_000).toISOString();
  await db.from('wa_group_inbox').delete().lt('sent_at', cutoff);
  return rows.length;
}

export interface GroupMessageView {
  id: string;
  at: string;
  from: string;
  fromCortex: boolean;
  text: string;
  quotesId: string | null;
  quotes: string | null;
}

export async function listGroupMessages(
  db: SupabaseClient,
  input: { group: string; sinceHours: number; contains?: string; limit: number; now?: Date },
): Promise<{ groupName: string; messages: GroupMessageView[] }> {
  const now = input.now ?? new Date();
  const groups = await listSendGroups(db);
  const res = resolveSendGroup(groups, input.group);
  if (res.kind === 'none')
    throw new NotFoundError(
      `«${input.group}» no es un grupo habilitado para Cortex. Habilitados: ${groups.map((g) => g.subject ?? g.jid).join(', ') || 'ninguno'}.`,
    );
  if (res.kind === 'ambiguous')
    throw new ValidationError(
      `Varios grupos coinciden con «${input.group}»: ${res.candidates.map((g) => g.subject ?? g.jid).join(', ')}.`,
    );
  const since = new Date(now.getTime() - input.sinceHours * 3_600_000).toISOString();
  const { data, error } = await db
    .from('wa_group_inbox')
    .select(
      'message_id, from_me, sender_name, sender_jid, sent_at, body, quoted_message_id, quoted_body',
    )
    .eq('group_jid', res.group.jid)
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  let rows = (data ?? []) as Array<{
    message_id: string;
    from_me: boolean;
    sender_name: string | null;
    sender_jid: string | null;
    sent_at: string;
    body: string;
    quoted_message_id: string | null;
    quoted_body: string | null;
  }>;
  if (input.contains?.trim()) {
    const needle = input.contains.trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.body.toLowerCase().includes(needle) ||
        (r.quoted_body ?? '').toLowerCase().includes(needle),
    );
  }
  rows = rows.slice(0, input.limit).reverse();
  return {
    groupName: res.group.subject ?? res.group.jid,
    messages: rows.map((r) => ({
      id: r.message_id,
      at: r.sent_at,
      from: r.from_me ? 'Cortex' : (r.sender_name ?? r.sender_jid?.split('@')[0] ?? 'alguien'),
      fromCortex: r.from_me,
      text: r.body,
      quotesId: r.quoted_message_id,
      quotes: r.quoted_body,
    })),
  };
}
