import { mergeIntoDefinition, toColumns, toView } from '@/lib/custom-tools';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type CustomToolRow,
  DefinitionPatchSchema,
  EXECUTION_COLUMNS,
  SAFE_COLUMNS,
} from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const TABLE = 'custom_tools';

const FORBIDDEN = {
  error:
    'Solo un administrador de la organización puede ver o cambiar la configuración de una herramienta propia.',
};

/** The full definition of one tool. Admin only — see the note in ../route.ts. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (user.role !== 'org_admin') return NextResponse.json(FORBIDDEN, { status: 403 });

  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  const { data, error } = await db.from(TABLE).select(SAFE_COLUMNS).eq('id', id).maybeSingle();
  if (error || !data) {
    return NextResponse.json({ error: 'No existe esa herramienta.' }, { status: 404 });
  }
  return NextResponse.json({ tool: toView(data as unknown as CustomToolRow) });
}

/**
 * Edit a tool.
 *
 * The patch is merged onto the stored row and the RESULT is validated whole.
 * Checking a patch on its own would let a request delete the `guia` field while
 * the URL template still says `{{guia}}`, and the tool would go on being
 * offered to the model with a hole in it.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (user.role !== 'org_admin') return NextResponse.json(FORBIDDEN, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 });
  }

  const parsed = DefinitionPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const db = getOrgScopedClient(user.organization.id);

  // `EXECUTION_COLUMNS` here, and only to learn whether a secret exists: a
  // patch that switches auth on without supplying a key must be refused, and
  // one that edits a URL while leaving auth alone must keep the stored key.
  const { data: existing } = await db
    .from(TABLE)
    .select(EXECUTION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: 'No existe esa herramienta.' }, { status: 404 });
  }
  const row = existing as unknown as CustomToolRow;

  const merged = mergeIntoDefinition(row, parsed.data);
  const { columns, warning, problems } = toColumns(merged, { isCreate: false });

  const keepsExistingSecret =
    merged.authType !== 'none' && merged.authType === row.auth_type && !!row.auth_secret_encrypted;
  if (merged.authType !== 'none' && !merged.authSecret && !keepsExistingSecret) {
    problems.push('Cambiaste el método de autenticación, así que hay que ingresar la llave nueva.');
  }
  if (problems.length > 0) {
    return NextResponse.json({ error: 'Definición inválida.', problems }, { status: 422 });
  }

  const { data, error } = await db
    .from(TABLE)
    .update(columns)
    .eq('id', id)
    .select(SAFE_COLUMNS)
    .single();

  if (error || !data) {
    const duplicate = (error?.message ?? '').includes('custom_tools_org_slug_idx');
    return NextResponse.json(
      {
        error: duplicate
          ? `Ya existe otra herramienta con el identificador "${merged.slug}".`
          : 'No se pudo guardar la herramienta.',
      },
      { status: duplicate ? 409 : 500 },
    );
  }

  return NextResponse.json({ tool: toView(data as unknown as CustomToolRow), warning });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (user.role !== 'org_admin') return NextResponse.json(FORBIDDEN, { status: 403 });

  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  const { data: existing } = await db.from(TABLE).select('id').eq('id', id).maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: 'No existe esa herramienta.' }, { status: 404 });
  }

  const { error } = await db.from(TABLE).delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: 'No se pudo borrar la herramienta.' }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
