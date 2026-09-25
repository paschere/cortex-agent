import { isSameOrigin } from '@/lib/activations/request';
import { bellForSubmission } from '@/lib/views/activity';
import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import { SubmissionLimitError, submitViewForm } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * El formulario de una vista compartida, enviado por alguien sin cuenta.
 *
 * Lo que se puede escribir lo decide el BLOQUE, no el cuerpo de la petición:
 * `submitViewForm` sólo toma los campos que ese formulario pide, los valida con
 * el esquema de la tabla y descarta el resto. Tope de envíos por hora por
 * vista, contado en `custom_view_submissions`. Si la vista pide contraseña, el
 * envío también: la cookie de desbloqueo tiene que estar.
 */

export const runtime = 'nodejs';

const input = z.object({
  token: z.string().min(32).max(64),
  blockId: z.string().min(1).max(40),
  values: z.record(z.string().max(400)).refine((v) => Object.keys(v).length <= 30),
});

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Revisa los datos del formulario.' }, { status: 400 });
  const opened = await openPublicView(parsed.data.token);
  if (!opened)
    return NextResponse.json({ error: 'Este enlace ya no está disponible.' }, { status: 404 });
  const { view, db } = opened;
  if (
    view.visibility === 'password' &&
    !(await isUnlocked(db, view.id, req.cookies.get(unlockCookieName(view.id))?.value))
  )
    return NextResponse.json(
      { error: 'Vuelve a escribir la contraseña de la vista.' },
      { status: 401 },
    );

  try {
    const res = await submitViewForm(db, view, {
      blockId: parsed.data.blockId,
      values: parsed.data.values,
      submittedBy: null,
    });
    await bellForSubmission(db, view, parsed.data.blockId, 'Alguien con el enlace');
    return NextResponse.json({ message: res.message });
  } catch (err) {
    if (err instanceof SubmissionLimitError)
      return NextResponse.json({ error: err.message }, { status: 429 });
    if (err instanceof ValidationError || err instanceof NotFoundError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: 'No se pudo enviar. Inténtalo más tarde.' }, { status: 503 });
  }
}
