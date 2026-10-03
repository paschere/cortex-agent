'use server';

/**
 * Aprobar o rechazar solicitudes de acceso. Cada acción vuelve a preguntar si
 * la cuenta opera la plataforma (`requirePlatformOperator`): una acción de
 * servidor es un endpoint con URL propia y se puede invocar sin haber abierto
 * la pantalla.
 */

import {
  type ApproveResult,
  approveAccessRequest,
  rejectAccessRequest,
} from '@/lib/billing/access-requests';
import { requirePlatformOperator } from '@/lib/billing/operators';
import { revalidatePath } from 'next/cache';

const ID_RE = /^[0-9a-f-]{36}$/i;

export async function approveRequest(id: string): Promise<ApproveResult> {
  const { accountId } = await requirePlatformOperator();
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    return { ok: false, message: 'Solicitud no válida.' };
  }
  const result = await approveAccessRequest(id, accountId);
  revalidatePath('/overview/access');
  return result;
}

export async function rejectRequest(
  id: string,
  note: string | null,
): Promise<{ ok: boolean; message: string }> {
  const { accountId } = await requirePlatformOperator();
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    return { ok: false, message: 'Solicitud no válida.' };
  }
  const done = await rejectAccessRequest(id, accountId, typeof note === 'string' ? note : null);
  revalidatePath('/overview/access');
  return done
    ? { ok: true, message: 'Rechazada. No se le envió nada.' }
    : { ok: false, message: 'Esa solicitud ya no se puede rechazar.' };
}
