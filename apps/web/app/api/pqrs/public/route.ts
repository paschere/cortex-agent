import { openPublicPqrsForm } from '@/lib/compliance/public';
import { notify } from '@/lib/notifications/notify';
import { PQRS_KINDS, type PqrsKind, createPqrs, toolErrorMessage } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Radicar una PQRS desde el formulario público (0195). El token es la
 * credencial; el formulario apagado o un token rotado responden 404. Quien la
 * tiene asignada (o el responsable del perfil) recibe el aviso en la campana.
 *
 * Contra robots: un campo trampa que una persona no ve (`website`) y límites
 * de largo en todo. La autorización de tratamiento de datos es obligatoria.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fail = (error: string, status = 400) =>
  NextResponse.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail('Solicitud inválida.');
  const opened = await openPublicPqrsForm(str(body.token, 80));
  if (!opened) return fail('Este formulario ya no está disponible.', 404);
  // El campo trampa: una persona no lo ve ni lo llena.
  if (str(body.website, 200)) return NextResponse.json({ ok: true, radicado: null });
  const kind = str(body.kind, 20) as PqrsKind;
  if (!(PQRS_KINDS as readonly string[]).includes(kind))
    return fail('Elige qué quieres presentar.');
  if (body.consent !== true)
    return fail('Para radicarla tienes que autorizar el tratamiento de tus datos.');
  try {
    const row = await createPqrs(
      opened.db,
      {
        channel: 'formulario',
        kind,
        matter:
          body.matter === 'datos_personales'
            ? 'datos_personales'
            : body.matter === 'consumo'
              ? 'consumo'
              : 'general',
        subject: str(body.subject, 200),
        body: str(body.body, 8000),
        requesterName: str(body.name, 160),
        requesterEmail: str(body.email, 200) || null,
        requesterPhone: str(body.phone, 40) || null,
        requesterIdNumber: str(body.idNumber, 40) || null,
        consentAccepted: true,
      },
      { userId: null, profile: opened.profile },
    );
    const owner = row.assigned_user_id ?? opened.profile.ownerUserId;
    if (owner) {
      await notify(opened.db, {
        userId: owner,
        kind: 'view_activity',
        tone: 'warning',
        title: `Nueva PQRS ${row.radicado}`,
        body: `${row.requester_name}: «${row.subject}». Plazo legal: ${row.due_on}.`,
        href: `/cumplimiento?tab=pqrs&pqrs=${row.id}`,
        groupKey: `pqrs:${row.id}`,
      }).catch(() => null);
    }
    return NextResponse.json(
      { ok: true, radicado: row.radicado, dueOn: row.due_on },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return fail(toolErrorMessage(err));
  }
}
