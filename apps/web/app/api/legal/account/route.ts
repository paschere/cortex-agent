import { sendEmail } from '@/lib/email';
import { enqueueJob } from '@/lib/jobs';
import { classifyMemberships, deleteAccount, listMemberships } from '@/lib/legal/account-deletion';
import { currentAccount } from '@/lib/legal/consent-store';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/legal/account — «eliminar mi usuario» (dejando los datos de la empresa).
 *
 *   GET     qué pasaría: qué empresas lo impiden y qué espacios se borran con él.
 *   DELETE  { confirmEmail } lo hace. Confirmación escribiendo el correo propio.
 *
 * Lo que hace y lo que no, en lib/legal/account-deletion.ts. Inmediato: la
 * persona pidió suprimir sus datos; no hay a quién proteger con una gracia (la
 * empresa conserva lo suyo).
 */

const Confirm = z.object({ confirmEmail: z.string().max(320) }).strict();

function json<T>(body: T, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET() {
  const account = await currentAccount();
  if (!account) return json({ error: 'Inicia sesión.' }, 401);
  const { blockers, solo, shared } = classifyMemberships(await listMemberships(account.id));
  return json({
    blockers,
    soloWorkspaces: solo.map((m) => m.organizationName),
    sharedWorkspaces: shared.map((m) => m.organizationName),
  });
}

export async function DELETE(req: Request) {
  const account = await currentAccount();
  if (!account) return json({ error: 'Inicia sesión.' }, 401);
  const parsed = Confirm.safeParse(await req.json().catch(() => null));
  if (
    !parsed.success ||
    parsed.data.confirmEmail.trim().toLowerCase() !== account.email.trim().toLowerCase()
  ) {
    return json({ error: 'Escribe tu correo exactamente para confirmar.' }, 400);
  }

  const result = await deleteAccount({
    accountId: account.id,
    email: account.email,
    name: account.name,
  });
  if (!result.ok) {
    return json(
      {
        error:
          'Eres la única dueña o dueño de una empresa donde hay más personas. Nombra a otra persona como dueña o elimina la empresa antes de borrar tu usuario.',
        blockers: result.blockers,
      },
      409,
    );
  }

  for (const deletionId of result.deletionIds) {
    const queued = await enqueueJob('legal/organization.purge', { deletionId });
    // Si no entra a la cola, el barrido diario la recoge: ya venció su gracia.
    if (!queued) logger.warn('legal: purga de espacio personal no encolada', { deletionId });
  }

  await sendEmail({
    to: account.email,
    subject: 'Eliminamos tu usuario de Cortex',
    text: 'Tu usuario de Cortex quedó eliminado. Revocamos tus conexiones con Google, borramos tus memorias y preferencias, y tu nombre y correo dejaron de aparecer en las empresas donde trabajabas. Lo que creaste dentro de esas empresas (documentos, conversaciones compartidas, registros) les pertenece y lo conservan ellas.\n\nGuardamos sólo una constancia de esta solicitud (tu correo y la fecha) como prueba de que la atendimos.',
  }).catch(() => undefined);

  return json({ ok: true, anonymized: result.anonymized, revoked: result.revoked });
}
