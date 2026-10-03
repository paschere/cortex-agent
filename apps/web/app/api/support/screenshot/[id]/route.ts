import { getFileDirect } from '@/lib/files-db';
import { SupportOperatorError } from '@/lib/support/operator';
import { operatorTicket } from '@/lib/support/operator-store';
import { SUPPORT_BUCKET } from '@/lib/support/store';
import { UnauthorizedError } from '@cortex/core';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * El pantallazo de un ticket, para quien opera soporte. `operatorTicket` exige
 * la puerta de operación; la ruta del archivo sale de la fila, nunca de la URL.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return new Response('No existe', { status: 404 });
  try {
    const ticket = await operatorTicket(id);
    if (!ticket?.screenshot_path) return new Response('No existe', { status: 404 });
    const file = await getFileDirect(SUPPORT_BUCKET, ticket.screenshot_path);
    if (!file) return new Response('No existe', { status: 404 });
    return new Response(new Uint8Array(file.content), {
      headers: {
        'Content-Type': ticket.screenshot_type ?? file.contentType ?? 'image/png',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
      },
    });
  } catch (err) {
    if (err instanceof SupportOperatorError) return new Response('Sin acceso', { status: 403 });
    if (err instanceof UnauthorizedError) return new Response('Sin sesión', { status: 401 });
    return new Response('Error', { status: 500 });
  }
}
