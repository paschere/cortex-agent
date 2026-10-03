import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  PAIRING_REQUEST_TTL_MS,
  heldByLiveBridge,
  parsePairingCommand,
} from '@/lib/whatsapp/pairing';
import { wipeWhatsappSession } from '@/lib/whatsapp/wipe';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Quiero vincular el número»: lo único que hace que el puente hable con
 * WhatsApp mientras no tiene sesión.
 *
 * Antes el puente sin sesión pedía QR en bucle aunque nadie mirara, y cuando
 * alguien por fin abría la pantalla casi nunca había uno vigente. Ahora espera
 * quieto, y esta ruta deja la petición en `whatsapp_sessions` para que el
 * siguiente latido del puente (≤ 15 s) la recoja. Ver lib/whatsapp/pairing.ts.
 *
 *   { mode: 'qr' }                  — mostrar un QR.
 *   { mode: 'code', phone }         — pedir un código de 8 caracteres para
 *                                     «Vincular con el número de teléfono».
 *   { mode: 'keepalive' }           — la pantalla sigue abierta; renueva una
 *                                     petición VIVA, nunca revive una vencida.
 *   { mode: 'cancel' }              — ya no.
 *   { mode: 'unlink' }              — «Desvincular» (0189): el puente cierra el
 *                                     dispositivo en WhatsApp y borra la sesión;
 *                                     sin puente vivo, se borra aquí.
 *
 * CADA EMPRESA VINCULA EL SUYO (0189). Ya no hace falta que el puente haya
 * «reportado» para esta empresa: pedir vincular crea la fila, y el puente
 * multiempresa abre una conexión para ella en la siguiente vuelta (≤ 15 s).
 * Un número que ya es de OTRA empresa se rechaza con una explicación.
 *
 * SOLO ADMINISTRADORES. Vincular decide qué teléfono es «el número de la
 * empresa» — el que lee los grupos y contesta con las herramientas de cada
 * persona —, la misma clase de decisión que vincular números a personas.
 *
 * Todo con el cliente acotado al espacio de trabajo de quien pide: la fila es la
 * de su empresa, y la del puente de otra empresa no se ve ni se toca.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await requireSession();
  if (session.role !== 'org_admin') {
    return NextResponse.json(
      {
        error:
          'Solo un administrador puede vincular el número de WhatsApp de la empresa. Pídeselo a uno.',
      },
      { status: 403 },
    );
  }

  const parsed = parsePairingCommand(await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { command } = parsed;

  const db = getOrgScopedClient(session.organization.id);
  const now = new Date();

  if (command.mode === 'keepalive') {
    // Only a request that is still alive is renewed. A screen left open in a
    // background tab after somebody pressed «Cancelar» elsewhere must not bring
    // it back.
    const renewed = await db
      .from('whatsapp_sessions')
      .update({ pairing_requested_at: now.toISOString() })
      .gt('pairing_requested_at', new Date(now.getTime() - PAIRING_REQUEST_TTL_MS).toISOString())
      .select('organization_id');
    if (renewed.error) {
      logger.error(`whatsapp: could not renew a pairing request — ${renewed.error.message}`);
      return NextResponse.json({ error: 'No se pudo mantener el intento.' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, alive: (renewed.data ?? []).length > 0 });
  }

  if (command.mode === 'cancel') {
    const cancelled = await db.from('whatsapp_sessions').update({
      pairing_requested_at: null,
      pairing_phone: null,
      pairing_code: null,
      pairing_code_expires_at: null,
      updated_at: now.toISOString(),
    });
    if (cancelled.error) {
      logger.error(`whatsapp: could not cancel a pairing request — ${cancelled.error.message}`);
      return NextResponse.json({ error: 'No se pudo cancelar.' }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      note: 'Listo. El servicio deja de pedir códigos en menos de un minuto.',
    });
  }

  if (command.mode === 'unlink') return unlink(db, session.id, now);

  const current = await db
    .from('whatsapp_sessions')
    .select('status, pairing_phone, last_seen_at')
    .maybeSingle();
  if (current.error) {
    logger.error(`whatsapp: could not read the session for pairing — ${current.error.message}`);
    return NextResponse.json(
      { error: 'No se pudo leer el estado de WhatsApp. Intenta de nuevo en un momento.' },
      { status: 500 },
    );
  }

  if (current.data?.status === 'connected') {
    return NextResponse.json(
      { error: 'El número ya está vinculado y en línea. No hace falta volver a vincularlo.' },
      { status: 409 },
    );
  }

  const phone = command.mode === 'code' ? command.phone : null;

  // Un número, una empresa. Dicho ahora, antes de que alguien escriba un código
  // en el teléfono para un vínculo que se va a deshacer solo.
  if (phone) {
    const taken = await db.rpc('whatsapp_phone_taken', { p_phone: phone });
    if (taken.error) {
      logger.error(`whatsapp: could not check the number — ${taken.error.message}`);
      return NextResponse.json({ error: 'No se pudo revisar el número.' }, { status: 500 });
    }
    if (taken.data === true) {
      return NextResponse.json(
        {
          error:
            'Ese número ya está vinculado a otro espacio de trabajo en Cortex. Un número atiende a una sola empresa: usa otro número dedicado.',
        },
        { status: 409 },
      );
    }
  }

  const row: Record<string, unknown> = {
    pairing_requested_at: now.toISOString(),
    pairing_phone: phone,
    updated_at: now.toISOString(),
  };
  // A code belongs to the number it was issued for. Switching mode or number
  // retires the one on screen at once instead of leaving a dead code to type.
  if (((current.data?.pairing_phone as string | null) ?? null) !== phone) {
    row.pairing_code = null;
    row.pairing_code_expires_at = null;
  }

  // Sin fila, ésta es la primera vez que la empresa vincula: se crea aquí, y el
  // puente multiempresa la recoge en su siguiente vuelta.
  const saved = current.data
    ? await db.from('whatsapp_sessions').update(row)
    : await db
        .from('whatsapp_sessions')
        .upsert({ ...row, status: 'waiting' }, { onConflict: 'organization_id' });
  if (saved.error) {
    logger.error(`whatsapp: could not store a pairing request — ${saved.error.message}`);
    return NextResponse.json({ error: 'No se pudo pedir el código.' }, { status: 500 });
  }

  logger.info(`whatsapp: pairing requested (${command.mode}) by ${session.id}`);
  return NextResponse.json({
    ok: true,
    note:
      command.mode === 'code'
        ? 'Pidiendo el código a WhatsApp. Aparece aquí en unos segundos.'
        : 'Pidiendo el código QR. Aparece aquí en unos segundos.',
  });
}

/**
 * «Desvincular». Si un puente tiene la sesión ahora, se le pide a él: sólo él
 * puede cerrar el dispositivo en WhatsApp para que «Cortex» desaparezca de la
 * lista del teléfono. Si no hay puente que la tenga, se borra aquí — y se dice
 * que en el teléfono queda una entrada que conviene quitar a mano.
 */
async function unlink(
  db: ReturnType<typeof getOrgScopedClient>,
  actorId: string,
  now: Date,
): Promise<NextResponse> {
  const current = await db
    .from('whatsapp_sessions')
    .select('status, paired, owner_instance, lease_expires_at, last_seen_at')
    .maybeSingle();
  if (current.error) {
    logger.error(`whatsapp: could not read the session to unlink — ${current.error.message}`);
    return NextResponse.json({ error: 'No se pudo leer el estado de WhatsApp.' }, { status: 500 });
  }
  if (!current.data) {
    return NextResponse.json({ ok: true, note: 'No había ningún número vinculado.' });
  }

  if (heldByLiveBridge(current.data, now)) {
    const asked = await db.from('whatsapp_sessions').update({
      unlink_requested_at: now.toISOString(),
      pairing_requested_at: null,
      pairing_phone: null,
      updated_at: now.toISOString(),
    });
    if (asked.error) {
      logger.error(`whatsapp: could not request an unlink — ${asked.error.message}`);
      return NextResponse.json({ error: 'No se pudo desvincular.' }, { status: 500 });
    }
    logger.info(`whatsapp: unlink requested by ${actorId}`);
    return NextResponse.json({
      ok: true,
      note: 'Desvinculando. En unos segundos el número sale de Cortex y del teléfono.',
    });
  }

  const wiped = await wipeWhatsappSession(db, 'unlink', now);
  if (wiped.error) {
    logger.error(`whatsapp: could not wipe the session — ${wiped.error}`);
    return NextResponse.json({ error: 'No se pudo desvincular.' }, { status: 500 });
  }
  logger.info(`whatsapp: session wiped by ${actorId} (no live bridge held it)`);
  return NextResponse.json({
    ok: true,
    note:
      current.data.paired === true
        ? 'Listo, la sesión se borró de Cortex. En el teléfono, quita también «Cortex» de Dispositivos vinculados.'
        : 'Listo, no queda ningún número vinculado.',
  });
}
