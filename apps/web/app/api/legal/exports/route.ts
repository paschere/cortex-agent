import { enqueueJob } from '@/lib/jobs';
import { currentAccount } from '@/lib/legal/consent-store';
import { canExportCompany } from '@/lib/legal/permissions';
import { getOptionalSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/legal/exports — «descargar todos los datos».
 *
 *   GET   las exportaciones visibles para quien pregunta: las de la empresa si
 *         es dueño o administrador, y siempre las suyas personales.
 *   POST  { scope: 'empresa' | 'personal' } crea la fila y encola el trabajo
 *         (legal/export.run). Una en curso por persona y alcance: el índice
 *         único de la 0188 lo garantiza y aquí se traduce a 409.
 */

const Create = z.object({ scope: z.enum(['empresa', 'personal']) }).strict();

const COLUMNS =
  'id, scope, status, size_bytes, tables_count, rows_count, files_count, error, created_at, completed_at, expires_at, requested_by_account';

function json<T>(body: T, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET() {
  const user = await getOptionalSession();
  const account = await currentAccount();
  if (!user || !account) return json({ error: 'Inicia sesión.' }, 401);
  const db = getOrgScopedClient(user.organization.id);
  let query = db
    .from('data_exports')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(20);
  if (!canExportCompany(user.organization.role))
    query = query.eq('requested_by_account', account.id);
  const { data, error } = await query;
  if (error) return json({ error: 'No se pudieron leer las exportaciones.' }, 500);
  return json({ exports: data ?? [] });
}

export async function POST(req: Request) {
  const user = await getOptionalSession();
  const account = await currentAccount();
  if (!user || !account) return json({ error: 'Inicia sesión.' }, 401);
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Solicitud inválida.' }, 400);
  const { scope } = parsed.data;
  if (scope === 'empresa' && !canExportCompany(user.organization.role)) {
    return json(
      { error: 'Sólo el dueño o un administrador pueden exportar los datos de la empresa.' },
      403,
    );
  }

  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
    .from('data_exports')
    .insert({
      organization_id: user.organization.id,
      scope,
      requested_by: user.id,
      requested_by_account: account.id,
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') {
      return json(
        { error: 'Ya hay una exportación en curso. Te avisamos cuando esté lista.' },
        409,
      );
    }
    return json({ error: 'No se pudo crear la exportación.' }, 500);
  }
  const id = (data as { id: string }).id;
  const queued = await enqueueJob('legal/export.run', { exportId: id });
  if (!queued) {
    await db
      .from('data_exports')
      .update({ status: 'fallida', error: 'No se pudo encolar.' })
      .eq('id', id);
    return json(
      { error: 'No se pudo poner en cola la exportación. Inténtalo en unos minutos.' },
      503,
    );
  }
  return json({ id }, 202);
}
