import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  FEEDBACK_REASONS,
  clearFeedback,
  listConversationFeedback,
  proposeCorrectionFromFeedback,
  saveFeedback,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 20;

/**
 * 👍/👎 sobre una respuesta de Cortex (migración 0219).
 *
 * La conversación tiene que ser DE QUIEN VOTA, no sólo de su empresa: un
 * compañero comparte el tenant, no la conversación. La respuesta se resuelve
 * aquí, en el servidor: el id que conoce el navegador en el turno en vivo lo
 * genera el cliente y todavía no es el de la fila, así que si no es un uuid de
 * un mensaje de esa conversación se toma la última respuesta del asistente (la
 * viva), y es el id REAL el que se guarda. La pregunta y la respuesta se leen
 * de la base, nunca del cuerpo: no se puede fabricar un «caso» con texto ajeno.
 */

const Body = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().min(1).max(200),
  action: z.enum(['rate', 'clear']).default('rate'),
  rating: z.union([z.literal(1), z.literal(-1)]).optional(),
  reason: z.enum(FEEDBACK_REASONS).nullish(),
  comment: z.string().max(1000).nullish(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const user = await requireSession();
  const conversationId = req.nextUrl.searchParams.get('conversationId') ?? '';
  if (!UUID.test(conversationId)) return NextResponse.json({ votes: [] });
  const db = getOrgScopedClient(user.organization.id);
  const { data: owned, error: ownedError } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (ownedError) return NextResponse.json({ votes: [] }, { status: 500 });
  if (!owned) return NextResponse.json({ votes: [] }, { status: 404 });
  try {
    return NextResponse.json({
      votes: await listConversationFeedback(db, user.id, conversationId),
    });
  } catch {
    return NextResponse.json({ votes: [] });
  }
}

export async function POST(req: NextRequest) {
  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 422 });
  const input = parsed.data;
  if (input.action === 'rate' && input.rating === undefined)
    return NextResponse.json({ error: 'Falta el voto.' }, { status: 422 });

  const db = getOrgScopedClient(user.organization.id);

  const { data: owned, error: ownedError } = await db
    .from('conversations')
    .select('id')
    .eq('id', input.conversationId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (ownedError)
    return NextResponse.json({ error: 'No se pudo leer la conversación.' }, { status: 500 });
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // La respuesta votada: la fila exacta si el id es de la base, la última si no.
  type Target = { id: string; content: string; created_at: string };
  let target = null as Target | null;
  if (UUID.test(input.messageId)) {
    const { data, error } = await db
      .from('messages')
      .select('id, content, created_at')
      .eq('id', input.messageId)
      .eq('conversation_id', input.conversationId)
      .eq('role', 'assistant')
      .maybeSingle();
    if (error)
      return NextResponse.json({ error: 'No se pudo leer la conversación.' }, { status: 500 });
    target = (data as Target | null) ?? null;
  }
  if (!target) {
    const { data, error } = await db
      .from('messages')
      .select('id, content, created_at')
      .eq('conversation_id', input.conversationId)
      .eq('role', 'assistant')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error)
      return NextResponse.json({ error: 'No se pudo leer la conversación.' }, { status: 500 });
    target = (data as Target | null) ?? null;
  }
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    if (input.action === 'clear') {
      await clearFeedback(db, user.id, target.id);
      return NextResponse.json({ ok: true, messageId: target.id, rating: null });
    }

    const rating = input.rating as 1 | -1;
    let question: string | null = null;
    if (rating === -1) {
      const { data: asked, error: askedError } = await db
        .from('messages')
        .select('content')
        .eq('conversation_id', input.conversationId)
        .eq('role', 'user')
        .lte('created_at', target.created_at)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (askedError) throw askedError;
      question = typeof asked?.content === 'string' ? asked.content : null;
    }

    const saved = await saveFeedback(db, {
      organizationId: user.organization.id,
      userId: user.id,
      conversationId: input.conversationId,
      messageId: target.id,
      rating,
      reason: input.reason ?? null,
      comment: input.comment ?? null,
      question,
      answer: rating === -1 ? target.content : null,
    });

    // Un comentario que enuncia un hecho o una regla se vuelve una PROPUESTA de
    // memoria (la aprueba una persona con permiso); nunca se escribe solo.
    let proposed = false;
    if (rating === -1) {
      try {
        proposed =
          (await proposeCorrectionFromFeedback(db, {
            userId: user.id,
            conversationId: input.conversationId,
            reason: saved.reason,
            comment: saved.comment,
          })) !== null;
      } catch (err) {
        logger.debug('feedback correction not proposed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return NextResponse.json({ ok: true, messageId: target.id, rating, proposed });
  } catch (err) {
    logger.warn('feedback not saved', {
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'No se pudo guardar tu opinión.' }, { status: 500 });
  }
}
