import { isSameOrigin } from '@/lib/activations/request';
import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import { ViewWriteLimitError, editViewSubmission } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Corregir lo que se envió por el formulario de una vista compartida. Sin
 * cuenta, la credencial es el token de edición que devolvió el envío (el
 * navegador lo guarda): el servidor valida token, vista, bloque, fila y que la
 * ventana del formulario (`editWindowMinutes`) siga abierta.
 */

export const runtime = 'nodejs';

const input = z.object({
  token: z.string().min(32).max(64),
  blockId: z.string().min(1).max(40),
  rowId: z.string().uuid(),
  editToken: z.string().min(16).max(64),
  values: z.record(z.string().max(4000)).refine((v) => Object.keys(v).length <= 30),
});

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
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
    const res = await editViewSubmission(db, view, {
      blockId: parsed.data.blockId,
      rowId: parsed.data.rowId,
      values: parsed.data.values,
      token: parsed.data.editToken,
      actor: null,
    });
    return NextResponse.json({ message: 'Corregido.', duplicate: res.duplicate });
  } catch (err) {
    if (err instanceof ViewWriteLimitError)
      return NextResponse.json({ error: err.message }, { status: 429 });
    if (err instanceof ValidationError || err instanceof NotFoundError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(
      { error: 'No se pudo corregir. Inténtalo más tarde.' },
      { status: 503 },
    );
  }
}
