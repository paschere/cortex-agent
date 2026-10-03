import { sendEmail } from '@/lib/email';
import { legalEntity } from '@/lib/legal/config';
import { currentAccount } from '@/lib/legal/consent-store';
import {
  LEGAL_RIGHTS,
  LEGAL_RIGHT_LABEL,
  createLegalRequest,
  listLegalRequests,
} from '@/lib/legal/requests-store';
import { getOptionalSession } from '@/lib/session';
import { logger } from '@cortex/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/legal/requests — consultas y reclamos del titular.
 *
 *   GET   las suyas, con estado y fecha límite.
 *   POST  radica una nueva. El plazo legal se calcula al recibir; se avisa por
 *         correo al responsable (LEGAL_CORREO) y a la persona, con el radicado.
 */

const Create = z
  .object({
    right: z.enum(LEGAL_RIGHTS),
    message: z.string().trim().min(10).max(5000),
  })
  .strict();

function json<T>(body: T, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function GET() {
  const account = await currentAccount();
  if (!account) return json({ error: 'Inicia sesión.' }, 401);
  return json({ requests: await listLegalRequests(account.id) });
}

export async function POST(req: Request) {
  const account = await currentAccount();
  if (!account) return json({ error: 'Inicia sesión.' }, 401);
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: 'Cuéntanos tu solicitud en al menos 10 caracteres.' }, 400);
  }
  const session = await getOptionalSession();
  const row = await createLegalRequest({
    accountId: account.id,
    organizationId: session?.organization.id ?? null,
    email: account.email,
    name: account.name,
    right: parsed.data.right,
    message: parsed.data.message,
  });

  const entity = legalEntity();
  const radicado = row.id.slice(0, 8).toUpperCase();
  const summary = [
    `Radicado: ${radicado}`,
    `Tipo: ${row.kind} — ${LEGAL_RIGHT_LABEL[row.right_invoked]}`,
    `Recibida: ${new Date(row.received_at).toISOString()}`,
    `Fecha límite legal: ${row.due_on}`,
  ].join('\n');

  // Los dos correos son aviso, no el registro: la fila ya está guardada.
  const notices: Promise<unknown>[] = [
    sendEmail({
      to: account.email,
      subject: `Recibimos tu ${row.kind} sobre datos personales (${radicado})`,
      text: `Hola${account.name ? ` ${account.name}` : ''},\n\nRecibimos tu solicitud y la responderemos a más tardar el ${row.due_on} (días hábiles, según la Ley 1581 de 2012).\n\n${summary}\n\nPuedes ver su estado en Cortex, en Ajustes › Privacidad y datos.`,
    }),
  ];
  if (!entity.missing.includes('[CORREO DE CONTACTO]')) {
    notices.push(
      sendEmail({
        to: entity.correo,
        subject: `[Datos personales] Nueva ${row.kind} ${radicado} — vence ${row.due_on}`,
        text: `${summary}\n\nTitular: ${account.name ?? ''} <${account.email}>\nEspacio: ${session?.organization.name ?? '—'}\n\n${parsed.data.message}`,
      }),
    );
  }
  await Promise.allSettled(notices).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn('legal: no salió un aviso de consulta/reclamo', { error: String(r.reason) });
      }
    }
  });

  return json({ request: row }, 201);
}
