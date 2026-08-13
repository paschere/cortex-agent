import { revokeMandate } from '@/lib/mandates/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Revocar un mandato.
 *
 * DELETE y no un borrado: la fila se queda con `revoked_at` y `revoked_by`
 * puestos. Borrarla de verdad dejaría las filas de auditoría apuntando a un
 * mandato que ya no existe, y la pregunta «¿quién autorizó esto y hasta cuándo?»
 * es exactamente la que se hace después, cuando ya no hay mandato.
 *
 * Muerde en el acto: la lectura de mandatos no tiene caché, así que la siguiente
 * llamada que iba a delegarse vuelve a pararse a preguntar.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (user.role !== 'org_admin') {
    return NextResponse.json(
      { error: 'Solo un administrador de la organización puede revocar un mandato.' },
      { status: 403 },
    );
  }

  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  try {
    await revokeMandate(db, id, user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'No se pudo revocar el mandato.' },
      { status: 400 },
    );
  }
}
