import { createHash, randomBytes } from 'node:crypto';
import { isSameOrigin } from '@/lib/activations/request';
import { refreshFeedSource } from '@/lib/feed/api-source';
import { sourceHealth } from '@/lib/feed/health';
import { feedSourceActionSchema, publicFeedSource } from '@/lib/feed/source-management';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 90;

const COLUMNS =
  'id,kind,name,latest_attachment_id,status,last_checked_at,error,enabled,freshness_minutes,webhook_enabled,last_webhook_at';

export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
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
  const rows = data ?? [];
  if (!rows.length) return NextResponse.json({ sources: [] });
  const captureIds = rows.map((s) => s.latest_attachment_id).filter(Boolean);
  const [captures, automations] = await Promise.all([
    captureIds.length
      ? db
          .from('chat_attachments')
          .select('id,purge_at,feed_truncated')
          .eq('created_by', user.id)
          .in('id', captureIds)
          .limit(100)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('activation_automations')
      .select('source_connection_id,status,name')
      .eq('actor_id', user.id)
      .in(
        'source_connection_id',
        rows.map((s) => s.id),
      )
      .limit(1000),
  ]);
  if (captures.error || automations.error)
    return NextResponse.json(
      { error: 'No se pudo comprobar la salud de las fuentes.' },
      { status: 503 },
    );
  return NextResponse.json({
    sources: rows.map((row) => ({
      ...publicFeedSource(row),
      health: sourceHealth(
        row,
        captures.data?.find((c) => c.id === row.latest_attachment_id) ?? null,
        (automations.data ?? []).filter((a) => a.source_connection_id === row.id),
      ),
    })),
    impactTruncated: (automations.data?.length ?? 0) >= 1000,
  });
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
    const body = parsed.data;
    if (body.action === 'freshness' || body.action === 'webhook') {
      const owned = await db
        .from('feed_sources')
        .select('id,kind')
        .eq('id', body.id)
        .eq('actor_id', user.id)
        .maybeSingle();
      if (owned.error || !owned.data)
        return NextResponse.json({ error: 'La fuente no está disponible.' }, { status: 404 });
      if (
        body.action === 'webhook' &&
        !['api', 'url', 'google_sheet', 'combined'].includes(owned.data.kind)
      )
        return NextResponse.json(
          { error: 'Los archivos y textos se actualizan añadiendo una versión.' },
          { status: 409 },
        );
      const token =
        body.action === 'webhook' && body.enabled ? randomBytes(32).toString('base64url') : null;
      const patch =
        body.action === 'freshness'
          ? { freshness_minutes: body.minutes }
          : {
              webhook_enabled: body.enabled,
              webhook_token_hash: token ? createHash('sha256').update(token).digest('hex') : null,
            };
      const saved = await db
        .from('feed_sources')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', body.id)
        .eq('actor_id', user.id)
        .select(COLUMNS)
        .single();
      if (saved.error || !saved.data) throw new Error('No se pudo guardar la configuración.');
      return NextResponse.json(
        {
          source: publicFeedSource(saved.data),
          ...(token
            ? {
                webhook: {
                  token,
                  path: `/api/webhooks/feed/${encodeURIComponent(user.organization.id)}/${body.id}`,
                  header: 'x-cortex-hook-token',
                  eventHeader: 'x-cortex-event-id',
                  timestampHeader: 'x-cortex-timestamp',
                },
              }
            : {}),
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (body.action === 'reconnect') {
      const owned = await db
        .from('feed_sources')
        .select('id,kind,latest_attachment_id')
        .eq('id', body.id)
        .eq('actor_id', user.id)
        .maybeSingle();
      if (owned.error || !owned.data)
        return NextResponse.json({ error: 'La fuente no está disponible.' }, { status: 404 });
      const enabled = await db
        .from('feed_sources')
        .update({
          enabled: true,
          status: 'ready',
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', body.id)
        .eq('actor_id', user.id);
      if (enabled.error) throw new Error('No se pudo reconectar la fuente.');
      let capture: Awaited<ReturnType<typeof refreshFeedSource>> | undefined;
      if (['api', 'url', 'google_sheet', 'combined'].includes(owned.data.kind))
        capture = await refreshFeedSource(db, user.id, body.id, user.organization.id);
      const checked = await db
        .from('feed_sources')
        .select(COLUMNS)
        .eq('id', body.id)
        .eq('actor_id', user.id)
        .single();
      if (checked.error || !checked.data) throw new Error('No se pudo comprobar la conexión.');
      return NextResponse.json({
        source: publicFeedSource(checked.data),
        capture,
        automationsResumed: false,
      });
    }
    if (body.action === 'refresh') {
      const result = await refreshFeedSource(db, user.id, body.id, user.organization.id);
      const refreshed = await db
        .from('feed_sources')
        .select(COLUMNS)
        .eq('id', body.id)
        .eq('actor_id', user.id)
        .single();
      if (refreshed.error || !refreshed.data)
        return NextResponse.json(
          { error: 'La fuente se actualizó, pero no se pudo releer.' },
          { status: 503 },
        );
      return NextResponse.json({ source: publicFeedSource(refreshed.data), capture: result });
    }
    if (body.action === 'disable') {
      const now = new Date().toISOString();
      const disabled = await db
        .from('feed_sources')
        .update({ enabled: false, status: 'disabled', error: null, updated_at: now })
        .eq('id', body.id)
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
        .eq('source_connection_id', body.id)
        .eq('actor_id', user.id)
        .in('status', ['active', 'paused']);
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
      .eq('id', body.id)
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
      .eq('id', body.attachmentId)
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
    if (attachment.data.feed_source_id && attachment.data.feed_source_id !== body.id)
      return NextResponse.json(
        { error: 'Esta captura ya pertenece a otra fuente conectada.' },
        { status: 409 },
      );
    const now = new Date().toISOString();
    const linked = await db
      .from('chat_attachments')
      .update({ feed_source_id: body.id })
      .eq('id', body.attachmentId)
      .eq('created_by', user.id);
    if (linked.error) throw new Error('No se pudo enlazar la nueva versión.');
    const updated = await db
      .from('feed_sources')
      .update({
        latest_attachment_id: body.attachmentId,
        enabled: true,
        status: 'ok',
        error: null,
        last_checked_at: now,
        last_changed_at: now,
        updated_at: now,
      })
      .eq('id', body.id)
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
