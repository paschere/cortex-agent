'use server';

import { openApp } from '@/lib/apps/access';
import { bellForSubmission, notifyViewActivity } from '@/lib/views/activity';
import {
  SubmissionLimitError,
  editAppRow,
  editAppSubmission,
  runAppAction,
  screenFor,
  screenView,
  submitAppForm,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';

/**
 * Las escrituras desde una pantalla de una aplicación: enviar un formulario,
 * corregir un envío, editar una celda o mover una tarjeta, usar un botón.
 *
 * Cada una resuelve el acceso de nuevo (`openApp`: sesión + rol guardado),
 * busca la pantalla con `screenFor` (una ajena no existe) y pasa por la
 * función con rol de packages/agent-tools/src/apps/store.ts, que es la que
 * decide campos, own/all y botones ANTES de llamar a la escritura de la
 * vista. El navegador sólo pide; nunca manda el rol.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  if (err instanceof SubmissionLimitError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 240 && !/[{}]|relation|column|violates/.test(message)
    ? message
    : fallback;
}

async function open(appRef: string, screenRef: string) {
  const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
  const screen = opened ? screenFor(opened.access, screenRef) : null;
  if (!opened || !screen) throw new NotFoundError('Esa pantalla no existe.');
  const view = await screenView(opened.db, screen);
  return { ...opened, screen, view };
}

export async function submitAppFormAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  values: Record<string, string>,
  clientId?: string,
): Promise<
  Result<{
    message: string;
    duplicate?: string | null;
    rowId?: string;
    editToken?: string | null;
    editUntil?: string | null;
  }>
> {
  try {
    const { db, access, view } = await open(appRef, screenRef);
    const res = await submitAppForm(db, access, view, { blockId, values, clientId });
    if (!res.replayed) await bellForSubmission(db, view, blockId, access.user.name);
    return {
      ok: true,
      message: res.message,
      duplicate: res.duplicate,
      rowId: res.rowId,
      editToken: res.editToken,
      editUntil: res.editUntil,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo enviar el formulario.') };
  }
}

export async function editAppSubmissionAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  rowId: string,
  values: Record<string, string>,
): Promise<Result<{ message: string; duplicate?: string | null }>> {
  try {
    const { db, access, view } = await open(appRef, screenRef);
    const res = await editAppSubmission(db, access, view, { blockId, rowId, values });
    return { ok: true, message: 'Corregido.', duplicate: res.duplicate };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo corregir el envío.') };
  }
}

export async function editAppRowAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  rowId: string,
  patch: Record<string, string>,
): Promise<Result<{ message: string }>> {
  try {
    const { db, access, view } = await open(appRef, screenRef);
    const res = await editAppRow(db, access, view, { blockId, rowId, patch });
    return {
      ok: true,
      message: `Guardado en «${res.label}».${res.duplicate ? ` ${res.duplicate}` : ''}`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el cambio.') };
  }
}

export async function runAppActionAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  actionId: string,
  rowId: string,
  reason?: string,
): Promise<Result<{ message: string }>> {
  try {
    const { db, access, view } = await open(appRef, screenRef);
    const res = await runAppAction(db, access, view, { blockId, actionId, rowId, reason });
    if (res.kind === 'notify')
      await notifyViewActivity(db, view, {
        title: `${res.actionLabel}: ${res.label}`,
        body: `${access.user.name} lo pidió desde «${access.app.name}».`,
      });
    return { ok: true, message: res.message };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo ejecutar el botón.') };
  }
}
