import { buildToolContext } from '@/lib/agent';
import { recommendFeedUse } from '@/lib/feed/intelligence';
import { FEED_COLUMNS, ownedFeed } from '@/lib/feed/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { removeFiles } from '@cortex/agent-tools';
import { attachmentsPromote } from '@cortex/agent-tools/src/attachments/promote';
import { listAgents, loadAgent } from '@cortex/agents';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Params = { params: Promise<{ id: string }> };

async function resolve({ params }: Params) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  if (!z.string().uuid().safeParse(id).success) return { user, db, row: null, error: null };
  const { data: row, error } = await ownedFeed(
    db,
    user.id,
    `${FEED_COLUMNS}, extracted_text, feed_tables, file_path`,
  )
    .eq('id', id)
    .maybeSingle();
  return { user, db, row, error };
}

export async function GET(_req: NextRequest, params: Params) {
  const { row, error } = await resolve(params);
  if (error) return NextResponse.json({ error: 'No se pudo leer la entrada.' }, { status: 500 });
  if (!row)
    return NextResponse.json({ error: 'La entrada no existe o ya venció.' }, { status: 404 });
  const { file_path: _, ...entry } = row;
  return NextResponse.json({
    entry: {
      ...entry,
      recommendation: recommendFeedUse({
        name: entry.filename,
        text: entry.extracted_text,
        tables: entry.feed_tables ?? [],
      }),
    },
  });
}

export async function POST(req: NextRequest, params: Params) {
  const { user, db, row, error } = await resolve(params);
  if (error) return NextResponse.json({ error: 'No se pudo leer la entrada.' }, { status: 500 });
  if (!row)
    return NextResponse.json({ error: 'La entrada no existe o ya venció.' }, { status: 404 });
  const body = z
    .object({
      action: z.enum(['consult', 'promote']),
      space: z.string().min(1).max(200).optional(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Acción inválida.' }, { status: 422 });
  try {
    if (body.data.action === 'promote') {
      const result = await attachmentsPromote.handler(
        { attachmentId: row.id, space: body.data.space },
        buildToolContext({
          organizationId: user.organization.id,
          userId: user.id,
          agentId: user.id,
          surface: 'web',
        }),
      );
      return NextResponse.json({ result });
    }
    const prompt = encodeURIComponent(
      'Analiza esta fuente del Feed. Identifica qué contiene cada pestaña, recomienda en qué áreas puede servir, revisa filas repetidas y datos faltantes. Distingue referencias de datos que podrían afectar Finanzas. Muéstrame la propuesta antes de guardar o aplicar cambios.',
    );
    const chatHref = (id: string) => `/chat/${id}?prompt=${prompt}`;
    if (row.conversation_id) return NextResponse.json({ href: chatHref(row.conversation_id) });
    const agent = await loadAgent(db, listAgents()[0]?.id ?? 'cortex');
    const { data: conversation, error: createError } = await db
      .from('conversations')
      .insert({
        user_id: user.id,
        agent_id: agent.id,
        surface: 'web',
        title: `Feed: ${row.filename}`.slice(0, 60),
      })
      .select('id')
      .single();
    if (createError || !conversation) throw new Error('No se pudo abrir la consulta.');
    const { data: attached, error: attachError } = await db
      .from('chat_attachments')
      .update({ conversation_id: conversation.id })
      .eq('id', row.id)
      .eq('created_by', user.id)
      .is('conversation_id', null)
      .gt('purge_at', new Date().toISOString())
      .select('id')
      .maybeSingle();
    if (attachError || !attached) {
      await db.from('conversations').delete().eq('id', conversation.id).eq('user_id', user.id);
      if (attachError) throw new Error('No se pudo preparar la consulta.');
      const { data: existing, error: readError } = await ownedFeed(db, user.id)
        .eq('id', row.id)
        .maybeSingle();
      if (readError || !existing?.conversation_id)
        throw new Error('La entrada ya no está disponible.');
      return NextResponse.json({ href: chatHref(existing.conversation_id) });
    }
    return NextResponse.json({ href: chatHref(conversation.id) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'No se pudo completar la acción.' },
      { status: 422 },
    );
  }
}

export async function DELETE(_req: NextRequest, params: Params) {
  const { user, db, row, error } = await resolve(params);
  if (error) return NextResponse.json({ error: 'No se pudo leer la entrada.' }, { status: 500 });
  if (!row)
    return NextResponse.json({ error: 'La entrada no existe o ya venció.' }, { status: 404 });
  try {
    if (row.file_path) await removeFiles(db, 'chat-uploads', [row.file_path]);
    const { error: deleteError } = await db
      .from('chat_attachments')
      .delete()
      .eq('id', row.id)
      .eq('created_by', user.id);
    if (deleteError) throw deleteError;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'No se pudo eliminar la entrada.' }, { status: 500 });
  }
}
