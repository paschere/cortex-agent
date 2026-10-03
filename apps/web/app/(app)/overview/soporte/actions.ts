'use server';

import { sendEmail } from '@/lib/email';
import { requireSupportOperator } from '@/lib/support/operator';
import { addOperatorReply, operatorTicket, setTicketStatus } from '@/lib/support/operator-store';
import { MESSAGE_MAX, isSupportStatus } from '@/lib/support/shape';
import { revalidatePath } from 'next/cache';

/**
 * Lo que hace quien opera soporte: cambiar el estado y contestar. Cada acción
 * vuelve a comprobar la puerta (también lo hace el store): una acción de
 * servidor se puede llamar sin pasar por la página.
 */

export type OperatorResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f-]{36}$/i;
const PATH = '/overview/soporte';

export async function setTicketStatusAction(id: string, status: string): Promise<OperatorResult> {
  try {
    await requireSupportOperator();
    if (!UUID.test(id) || !isSupportStatus(status)) {
      return { ok: false, error: 'Ese estado no existe.' };
    }
    await setTicketStatus(id, status);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'No se pudo.' };
  }
}

export async function replyTicketAction(id: string, body: string): Promise<OperatorResult> {
  try {
    const operator = await requireSupportOperator();
    const text = typeof body === 'string' ? body.trim() : '';
    if (!UUID.test(id)) return { ok: false, error: 'Ese ticket no existe.' };
    if (text.length < 2 || text.length > MESSAGE_MAX) {
      return { ok: false, error: 'Escribe la respuesta.' };
    }
    const ticket = await operatorTicket(id);
    if (!ticket) return { ok: false, error: 'Ese ticket no existe.' };
    await addOperatorReply(ticket, { id: operator.id, email: operator.email }, text);
    // La respuesta también le llega por correo a quien escribió. Si el correo
    // no sale, la respuesta igual queda en su pantalla de soporte.
    if (ticket.created_by_email) {
      await sendEmail({
        to: ticket.created_by_email,
        subject: `Re: [Soporte Cortex #${ticket.number}] ${ticket.subject}`,
        text: `${text}\n\n—\nSoporte de Cortex. También puedes ver esta respuesta en Ayuda → Escribir a soporte.`,
      }).catch(() => undefined);
    }
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'No se pudo.' };
  }
}
