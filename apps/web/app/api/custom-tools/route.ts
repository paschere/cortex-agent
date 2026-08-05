import { toColumns, toPublicView, toView } from '@/lib/custom-tools';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type CustomToolRow,
  DefinitionSchema,
  MAX_TOOLS_PER_ORG,
  SAFE_COLUMNS,
} from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const TABLE = 'custom_tools';

/**
 * The tools an organization built for itself.
 *
 * WHO MAY DO WHAT, and why it is not the same for reading and writing:
 *
 *   any member   sees the LIST — name, description, whether it asks for
 *                confirmation. That much is already visible in chat, since the
 *                model announces the tools it has.
 *   org_admin    sees and edits the DEFINITION — URLs, headers, auth mode. That
 *                is a different thing: a definition is a description of a
 *                request our server makes from inside our network, and whoever
 *                can write one can read whatever that network reaches. It is
 *                the same privilege boundary as adding a webhook that posts
 *                internal data outward, and it belongs to admins only.
 *
 * The stored credential is on neither side of that line. It is write-only:
 * nothing in this file selects `auth_secret_encrypted`.
 */
export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const { data, error } = await db
    .from(TABLE)
    .select(SAFE_COLUMNS)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'No se pudieron cargar las herramientas.' }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as CustomToolRow[];
  const isAdmin = user.role === 'org_admin';

  return NextResponse.json({
    tools: isAdmin ? rows.map(toView) : rows.map(toPublicView),
    canManage: isAdmin,
    atCapacity: rows.length >= MAX_TOOLS_PER_ORG,
    maxTools: MAX_TOOLS_PER_ORG,
  });
}

export async function POST(req: NextRequest) {
  const user = await requireSession();
  if (user.role !== 'org_admin') {
    return NextResponse.json(
      {
        error:
          'Solo un administrador de la organización puede crear herramientas: quien las crea puede consultar cualquier cosa que la red de Cortex alcance.',
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 });
  }

  const parsed = DefinitionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const def = parsed.data;

  const { columns, warning, problems } = toColumns(def, { isCreate: true });
  if (def.authType !== 'none' && !def.authSecret) {
    problems.push('Elegiste un método de autenticación pero no ingresaste la llave o contraseña.');
  }
  if (problems.length > 0) {
    return NextResponse.json({ error: 'Definición inválida.', problems }, { status: 422 });
  }

  const db = getOrgScopedClient(user.organization.id);

  const { count } = await db.from(TABLE).select('id', { count: 'exact', head: true });
  if ((count ?? 0) >= MAX_TOOLS_PER_ORG) {
    return NextResponse.json(
      { error: `Ya llegaste al máximo de ${MAX_TOOLS_PER_ORG} herramientas propias.` },
      { status: 422 },
    );
  }

  const { data, error } = await db
    .from(TABLE)
    .insert({ ...columns, created_by: user.id })
    .select(SAFE_COLUMNS)
    .single();

  if (error || !data) {
    // The one collision worth naming: a slug is how a person refers to the tool
    // and is unique inside the workspace (0067).
    const duplicate = (error?.message ?? '').includes('custom_tools_org_slug_idx');
    return NextResponse.json(
      {
        error: duplicate
          ? `Ya existe una herramienta con el identificador "${def.slug}".`
          : 'No se pudo crear la herramienta.',
      },
      { status: duplicate ? 409 : 500 },
    );
  }

  return NextResponse.json(
    { tool: toView(data as unknown as CustomToolRow), warning },
    { status: 201 },
  );
}
