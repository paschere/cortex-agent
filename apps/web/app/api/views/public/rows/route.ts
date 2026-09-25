import { isSameOrigin } from '@/lib/activations/request';
import { notifyViewActivity } from '@/lib/views/activity';
import { isUnlocked, openPublicView, unlockCookieName } from '@/lib/views/public';
import { ViewWriteLimitError, editViewRow, runViewAction } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Editar o usar un botón desde una vista compartida, sin cuenta. Sólo si la
 * vista lo permite (`editing: 'public'`), con la contraseña ya escrita si la
 * pide, sobre tablas propias y dentro del tope por hora. Qué campos se pueden
 * tocar y qué valor escribe un botón lo decide el SPEC, nunca este cuerpo.
 */

export const runtime = 'nodejs';

const input = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('edit'),
    token: z.string().min(32).max(64),
    blockId: z.string().min(1).max(40),
    rowId: z.string().uuid(),
    patch: z.record(z.string().max(400)).refine((v) => Object.keys(v).length <= 10),
  }),
  z.object({
    op: z.literal('action'),
    token: z.string().min(32).max(64),
    blockId: z.string().min(1).max(40),
    rowId: z.string().uuid(),
    actionId: z.string().min(1).max(40),
  }),
]);

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
    if (parsed.data.op === 'edit') {
      const res = await editViewRow(db, view, {
        blockId: parsed.data.blockId,
        rowId: parsed.data.rowId,
        patch: parsed.data.patch,
        actor: null,
      });
      return NextResponse.json({ message: `Guardado en «${res.label}».` });
    }
    const res = await runViewAction(db, view, {
      blockId: parsed.data.blockId,
      actionId: parsed.data.actionId,
      rowId: parsed.data.rowId,
      actor: null,
    });
    if (res.kind === 'notify')
      await notifyViewActivity(db, view, {
        title: `${res.actionLabel}: ${res.label}`,
        body: `Alguien con el enlace de «${view.name}» lo pidió.`,
      });
    return NextResponse.json({ message: res.message });
  } catch (err) {
    if (err instanceof ViewWriteLimitError)
      return NextResponse.json({ error: err.message }, { status: 429 });
    if (err instanceof ValidationError || err instanceof NotFoundError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(
      { error: 'No se pudo guardar. Inténtalo más tarde.' },
      { status: 503 },
    );
  }
}
