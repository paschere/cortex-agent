import { isSameOrigin } from '@/lib/activations/request';
import { refreshFeedSource } from '@/lib/feed/api-source';
import {
  CombinedSourceConfigSchema,
  CombinedSourceError,
  listCombinedSources,
  previewCombinedSource,
  refreshCombinedSource,
  saveCombinedSource,
} from '@/lib/feed/combined-source';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 90;

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), config: CombinedSourceConfigSchema }),
  z.object({
    action: z.literal('save'),
    name: z.string().trim().min(1).max(240),
    config: CombinedSourceConfigSchema,
  }),
  z.object({ action: z.literal('refresh'), id: z.string().uuid() }),
]);

function errorResponse(error: unknown) {
  if (error instanceof CombinedSourceError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: 'No se pudo procesar la fuente combinada.' }, { status: 503 });
}

export async function GET() {
  const user = await requireSession();
  try {
    const sources = await listCombinedSources(
      getOrgScopedClient(user.organization.id),
      user.id,
      user.organization.id,
    );
    return NextResponse.json({ sources }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json({ error: 'Origen de solicitud inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Revisa la acción y las claves explícitas de la combinación.' },
      { status: 400 },
    );
  const db = getOrgScopedClient(user.organization.id);
  try {
    if (parsed.data.action === 'preview') {
      const preview = await previewCombinedSource(
        db,
        user.id,
        user.organization.id,
        parsed.data.config,
      );
      return NextResponse.json({ preview });
    }
    if (parsed.data.action === 'save') {
      const result = await saveCombinedSource(
        db,
        user.id,
        user.organization.id,
        parsed.data.name,
        parsed.data.config,
      );
      return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
    }
    const result = await refreshCombinedSource(
      db,
      user.id,
      parsed.data.id,
      user.organization.id,
      async (dependencyId) => {
        const dependency = await db
          .from('feed_sources')
          .select('id,kind')
          .eq('id', dependencyId)
          .eq('actor_id', user.id)
          .eq('organization_id', user.organization.id)
          .maybeSingle();
        if (dependency.error)
          throw new CombinedSourceError('No se pudo revisar una dependencia.', 503);
        if (!dependency.data || !['url', 'google_sheet', 'api'].includes(dependency.data.kind))
          return null;
        return refreshFeedSource(db, user.id, dependencyId, user.organization.id);
      },
    );
    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
