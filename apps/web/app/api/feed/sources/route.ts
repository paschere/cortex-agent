import { isSameOrigin } from '@/lib/activations/request';
import { refreshFeedSource } from '@/lib/feed/api-source';
import { feedSourceActionSchema, publicFeedSource } from '@/lib/feed/source-management';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 90;

const COLUMNS = 'id,kind,name,latest_attachment_id,status,last_checked_at,error,enabled';

export async function GET() {
  const user = await requireSession();
  const { data, error } = await getOrgScopedClient(user.organization.id)
    .from('feed_sources')
    .select(COLUMNS)
    .eq('actor_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error)
    return NextResponse.json(
      { error: 'No se pudieron cargar las fuentes conectadas.' },
      { status: 503 },
    );
  return NextResponse.json({ sources: (data ?? []).map(publicFeedSource) });
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json({ error: 'Origen de solicitud inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = feedSourceActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'La operación de la fuente no es válida.' }, { status: 400 });
  const db = getOrgScopedClient(user.organization.id);
  try {
    if (parsed.data.action === 'refresh') {
      const result = await refreshFeedSource(db, user.id, parsed.data.id, user.organization.id);
      const refreshed = await db
        .from('feed_sources')
        .select(COLUMNS)
        .eq('id', parsed.data.id)
        .eq('actor_id', user.id)
        .single();
      if (refreshed.error || !refreshed.data)
        return NextResponse.json(
          { error: 'La fuente se actualizó, pero no se pudo releer.' },
          { status: 503 },
        );
      return NextResponse.json({ source: publicFeedSource(refreshed.data), capture: result });
    }
    if (parsed.data.action === 'disable') {
      const now = new Date().toISOString();
      const disabled = await db
        .from('feed_sources')
        .update({ enabled: false, status: 'disabled', error: null, updated_at: now })
        .eq('id', parsed.data.id)
        .eq('actor_id', user.id)
        .select(COLUMNS)
        .maybeSingle();
      if (disabled.error) throw new Error('No se pudo desactivar la fuente.');
      if (!disabled.data)
        return NextResponse.json({ error: 'La fuente no existe.' }, { status: 404 });
      const paused = await db
        .from('activation_automations')
        .update({
          status: 'paused',
          lease_token: null,
          lease_until: null,
          last_result: { message: 'La fuente fue desactivada por su responsable.' },
          updated_at: now,
        })
        .eq('source_connection_id', parsed.data.id)
        .eq('actor_id', user.id);
      if (paused.error)
        return NextResponse.json(
          { error: 'La fuente quedó desactivada, pero no se pudo actualizar su seguimiento.' },
          { status: 503 },
        );
      return NextResponse.json({
        source: publicFeedSource(disabled.data),
        automationsPaused: true,
      });
    }

    const source = await db
      .from('feed_sources')
      .select('id,kind')
      .eq('id', parsed.data.id)
      .eq('actor_id', user.id)
      .maybeSingle();
    if (source.error) throw new Error('No se pudo revisar la fuente.');
    if (!source.data) return NextResponse.json({ error: 'La fuente no existe.' }, { status: 404 });
    if (!['file', 'text'].includes(source.data.kind))
      return NextResponse.json(
        { error: 'Esta fuente se actualiza consultando su conexión, no con una versión manual.' },
        { status: 409 },
      );
    const attachment = await db
      .from('chat_attachments')
      .select('id,feed_kind,purge_at,feed_source_id')
      .eq('id', parsed.data.attachmentId)
      .eq('created_by', user.id)
      .not('feed_kind', 'is', null)
      .gt('purge_at', new Date().toISOString())
      .maybeSingle();
    if (attachment.error) throw new Error('No se pudo revisar la nueva versión.');
    if (!attachment.data)
      return NextResponse.json(
        { error: 'La nueva versión no existe, venció o no es tuya.' },
        { status: 404 },
      );
    if (attachment.data.feed_kind !== source.data.kind)
      return NextResponse.json(
        { error: 'La nueva versión debe ser del mismo tipo.' },
        { status: 409 },
      );
    if (attachment.data.feed_source_id && attachment.data.feed_source_id !== parsed.data.id)
      return NextResponse.json(
        { error: 'Esta captura ya pertenece a otra fuente conectada.' },
        { status: 409 },
      );
    const now = new Date().toISOString();
    const linked = await db
      .from('chat_attachments')
      .update({ feed_source_id: parsed.data.id })
      .eq('id', parsed.data.attachmentId)
      .eq('created_by', user.id);
    if (linked.error) throw new Error('No se pudo enlazar la nueva versión.');
    const updated = await db
      .from('feed_sources')
      .update({
        latest_attachment_id: parsed.data.attachmentId,
        enabled: true,
        status: 'ok',
        error: null,
        last_checked_at: now,
        last_changed_at: now,
        updated_at: now,
      })
      .eq('id', parsed.data.id)
      .eq('actor_id', user.id)
      .select(COLUMNS)
      .single();
    if (updated.error || !updated.data) throw new Error('No se pudo guardar la nueva versión.');
    return NextResponse.json({ source: publicFeedSource(updated.data) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'No se pudo actualizar la fuente.' },
      { status: 503 },
    );
  }
}
