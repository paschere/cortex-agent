import { sendEmail } from '@/lib/email';
import { currentAccount } from '@/lib/legal/consent-store';
import {
  COMPANY_DELETION_GRACE_DAYS,
  canDeleteCompany,
  confirmsCompanyName,
} from '@/lib/legal/permissions';
import { getOptionalSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/legal/organization-deletion — «eliminar la cuenta de la empresa».
 *
 *   GET     el borrado vivo de esta empresa, si hay uno.
 *   POST    { confirmName } programa el borrado: sólo el dueño, escribiendo el
 *           nombre de la empresa tal cual (segunda confirmación; la primera es
 *           el diálogo). Gracia de 30 días: hasta entonces nada se borra y se
 *           puede cancelar.
 *   DELETE  cancela un borrado programado (sólo el dueño, durante la gracia).
 *
 * La purga la hace el cron diario legal/dispatch → legal/organization.purge.
 */

const Schedule = z.object({ confirmName: z.string().max(300) }).strict();

const COLUMNS = 'id, status, requested_at, purge_after, requested_by_email, cancelled_at';

function json<T>(body: T, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET() {
  const user = await getOptionalSession();
  if (!user) return json({ error: 'Inicia sesión.' }, 401);
  const { data, error } = await getOrgScopedClient(user.organization.id)
    .from('organization_deletions')
    .select(COLUMNS)
    .in('status', ['programada', 'purgando'])
    .maybeSingle();
  if (error) return json({ error: 'No se pudo leer el estado.' }, 500);
  return json({ deletion: data ?? null });
}

export async function POST(req: Request) {
  const user = await getOptionalSession();
  const account = await currentAccount();
  if (!user || !account) return json({ error: 'Inicia sesión.' }, 401);
  if (!canDeleteCompany(user.organization.role)) {
    return json({ error: 'Sólo el dueño de la empresa puede eliminarla.' }, 403);
  }
  const parsed = Schedule.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !confirmsCompanyName(parsed.data.confirmName, user.organization.name)) {
    return json({ error: 'Escribe el nombre de la empresa exactamente como aparece.' }, 400);
  }

  const purgeAfter = new Date(Date.now() + COMPANY_DELETION_GRACE_DAYS * 86_400_000);
  const { data, error } = await getOrgScopedClient(user.organization.id)
    .from('organization_deletions')
    .insert({
      organization_id: user.organization.id,
      organization_name: user.organization.name,
      requested_by_account: account.id,
      requested_by_email: account.email,
      reason: 'empresa',
      purge_after: purgeAfter.toISOString(),
    })
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') return json({ error: 'El borrado ya está programado.' }, 409);
    return json({ error: 'No se pudo programar el borrado.' }, 500);
  }

  const day = purgeAfter.toISOString().slice(0, 10);
  await sendEmail({
    to: account.email,
    subject: `Programaste la eliminación de ${user.organization.name} en Cortex`,
    text: `Pediste eliminar la empresa «${user.organization.name}» y todos sus datos en Cortex.\n\nNo se borra nada todavía: el ${day} empezará el borrado definitivo. Hasta ese día puedes cancelarlo en Ajustes › Privacidad y datos. Si quieres conservar una copia, descarga antes todos los datos de la empresa desde la misma pantalla.\n\nSi no fuiste tú, cancélalo y cambia tu contraseña.`,
  }).catch(() => undefined);

  return json({ deletion: data }, 201);
}

export async function DELETE() {
  const user = await getOptionalSession();
  const account = await currentAccount();
  if (!user || !account) return json({ error: 'Inicia sesión.' }, 401);
  if (!canDeleteCompany(user.organization.role)) {
    return json({ error: 'Sólo el dueño de la empresa puede cancelar el borrado.' }, 403);
  }
  const { data, error } = await getOrgScopedClient(user.organization.id)
    .from('organization_deletions')
    .update({
      status: 'cancelada',
      cancelled_at: new Date().toISOString(),
      cancelled_by_email: account.email,
    })
    .eq('status', 'programada')
    .select('id');
  if (error) return json({ error: 'No se pudo cancelar.' }, 500);
  if (!data || data.length === 0) {
    return json({ error: 'No hay un borrado que se pueda cancelar (quizá ya empezó).' }, 409);
  }
  return json({ ok: true });
}
