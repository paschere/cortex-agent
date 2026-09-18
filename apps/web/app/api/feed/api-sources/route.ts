import { isSameOrigin } from '@/lib/activations/request';
import { captureApiFeed } from '@/lib/feed/api-source';
import { feedPaginationSchema } from '@/lib/feed/pagination';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type CustomToolRow, SAFE_COLUMNS } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 90;

const Body = z.object({
  toolId: z.string().uuid(),
  pagination: feedPaginationSchema.optional(),
  input: z.record(z.unknown()).default({}),
  name: z.string().trim().min(1).max(240).optional(),
});

export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
    .from('custom_tools')
    .select(SAFE_COLUMNS)
    .eq('enabled', true)
    .eq('http_method', 'GET')
    .order('name')
    .limit(40);
  if (error)
    return NextResponse.json({ error: 'No se pudieron cargar las APIs.' }, { status: 503 });
  return NextResponse.json({
    tools: ((data ?? []) as unknown as CustomToolRow[]).map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      fields: tool.input_schema?.fields ?? [],
    })),
    canConfigure: user.role === 'org_admin',
  });
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json({ error: 'Origen de solicitud inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Revisa la API y sus parámetros.' }, { status: 400 });
  try {
    const captured = await captureApiFeed({
      db: getOrgScopedClient(user.organization.id),
      organizationId: user.organization.id,
      actorId: user.id,
      ...parsed.data,
    });
    return NextResponse.json(captured, { status: captured.deduplicated ? 200 : 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'No se pudo consultar la API.' },
      { status: 422 },
    );
  }
}
