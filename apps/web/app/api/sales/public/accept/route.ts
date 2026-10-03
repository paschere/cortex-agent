import { notify } from '@/lib/notifications/notify';
import { openPublicQuote } from '@/lib/sales/public';
import {
  acceptSalesQuote,
  rejectSalesQuote,
  salesDocumentNumber,
  toolErrorMessage,
} from '@cortex/agent-tools';
import { formatMoney } from '@cortex/agent-tools/src/sales/totals';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Aceptar cotización» (o «No me interesa») desde el enlace público (0182).
 *
 * El token es la credencial, como en la página. Aceptar dos veces da lo mismo
 * que una (la segunda no cambia nada); una cotización vencida, anulada o ya
 * convertida no se acepta. Quien la creó recibe el aviso en la campana con el
 * enlace a la ficha en /ventas.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fail = (error: string, status = 400) =>
  NextResponse.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    token?: unknown;
    name?: unknown;
    action?: unknown;
    reason?: unknown;
  } | null;
  const token = typeof body?.token === 'string' ? body.token : '';
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const action = body?.action === 'reject' ? 'reject' : 'accept';
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  const opened = token ? await openPublicQuote(token) : null;
  if (!opened) return fail('Este enlace ya no está disponible.', 404);
  if (name.length < 2) return fail('Escribe tu nombre para confirmar.');

  const { doc, db } = opened;
  const number = salesDocumentNumber(doc);
  try {
    const before = doc.status;
    const next =
      action === 'accept'
        ? await acceptSalesQuote(db, doc, { name })
        : await rejectSalesQuote(db, doc, { name, reason: reason || null });
    if (next.status !== before && doc.created_by) {
      await notify(db, {
        userId: doc.created_by,
        kind: 'view_activity',
        tone: action === 'accept' ? 'good' : 'warning',
        title:
          action === 'accept'
            ? `${doc.client_name} aceptó la cotización ${number}`
            : `${doc.client_name} rechazó la cotización ${number}`,
        body:
          action === 'accept'
            ? `${name} la aceptó desde el enlace, por ${formatMoney(doc.total, doc.currency)}. Conviértela en pedido o factúrala desde Ventas.`
            : `${name} dijo que no${reason ? `: «${reason}»` : ''}.`,
        href: `/ventas/${doc.id}`,
        groupKey: `sales:${doc.id}`,
      }).catch(() => null);
    }
    return NextResponse.json(
      { ok: true, status: next.status },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return fail(toolErrorMessage(err));
  }
}
