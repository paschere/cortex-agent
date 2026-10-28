'use server';

import { openApp } from '@/lib/apps/access';
import { buildReportNotice } from '@/lib/block-fix';
import { bellForSubmission, notifyViewActivity } from '@/lib/views/activity';
import {
  RowConflictError,
  SubmissionLimitError,
  editAppRow,
  editAppSubmission,
  pasteAppRows,
  type SheetPasteResult,
  runAppAction,
  saveAppFormRecord,
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

/** Completar un registro que ya existe con el formulario de su ficha (cerrar una atención). */
export async function saveAppFormRecordAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  rowId: string,
  values: Record<string, string>,
): Promise<Result<{ message: string; duplicate?: string | null }>> {
  try {
    const { db, access, view } = await open(appRef, screenRef);
    const res = await saveAppFormRecord(db, access, view, { blockId, rowId, values });
    return { ok: true, message: 'Guardado.', duplicate: res.duplicate };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el registro.') };
  }
}

export async function editAppRowAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  rowId: string,
  patch: Record<string, string>,
  /** Sólo una edición que estuvo en la cola sin señal: lo que la persona vio de cada campo. */
  expect?: Record<string, string>,
): Promise<
  | Result<{ message: string }>
  | { ok: false; error: string; conflict: Array<{ field: string; theirs: string }> }
> {
  try {
    const { db, access, view } = await open(appRef, screenRef);
    const res = await editAppRow(db, access, view, { blockId, rowId, patch, expect });
    return {
      ok: true,
      message: `Guardado en «${res.label}».${res.duplicate ? ` ${res.duplicate}` : ''}`,
    };
  } catch (err) {
    if (err instanceof RowConflictError)
      return { ok: false, error: err.message, conflict: err.conflicts };
    return { ok: false, error: describe(err, 'No se pudo guardar el cambio.') };
  }
}

/** Pegar filas de Excel / Sheets en una hoja de la pantalla; el rol decide qué se puede. */
export async function pasteAppRowsAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  rows: Array<Record<string, string>>,
  apply: boolean,
): Promise<{ ok: true; result: SheetPasteResult } | { ok: false; error: string }> {
  try {
    const { db, access, view } = await open(appRef, screenRef);
    const result = await pasteAppRows(db, access, view, {
      blockId,
      rows: z.array(z.record(z.string(), z.string().max(2000))).max(500).parse(rows),
      apply,
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo pegar.') };
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
        // «Abrir» lleva directo al registro de la pantalla donde se pidió.
        href: `/apps/${appRef}/${screenRef}?fila=${encodeURIComponent(rowId)}`,
      });
    return { ok: true, message: res.message };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo ejecutar el botón.') };
  }
}

/**
 * «Avisar al administrador»: quien NO puede editar la app ve un bloque roto y
 * toca el botón; a quienes administran les llega un aviso con dónde y qué. No
 * escribe nada más. El mismo aviso no se repite (dedupeKey) y el texto lo arma
 * el servidor, no el navegador.
 */
export async function reportAppProblemAction(
  appRef: string,
  screenRef: string | null,
  blockId: string | null,
  message: string,
): Promise<Result<{ message: string }>> {
  try {
    const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
    if (!opened) throw new NotFoundError('Esa aplicación no existe.');
    const screen = screenRef ? screenFor(opened.access, screenRef) : null;
    const view = screen ? await screenView(opened.db, screen) : null;
    const block = view?.spec.blocks.find((b) => b.id === blockId);
    const notice = buildReportNotice(
      {
        appName: opened.access.app.name,
        appRef: opened.access.app.slug,
        screenTitle: screen?.title ?? null,
        screenSlug: screen?.slug ?? null,
        blockId: blockId ?? null,
        blockTitle: block && 'title' in block && typeof block.title === 'string' ? block.title : null,
        message: z.string().trim().min(1).max(600).parse(message),
      },
      opened.access.user.name,
    );
    const anchor = view ?? {
      id: opened.access.app.id,
      slug: opened.access.app.slug,
      name: opened.access.app.name,
      created_by: opened.access.app.created_by,
    };
    await notifyViewActivity(opened.db, anchor, {
      ...notice,
      href: `/apps/${opened.access.app.slug}/edit`,
    });
    return { ok: true, message: 'Listo: le avisé al administrador.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo avisar. Díselo en persona.') };
  }
}

/** ¿Quien mira puede arreglar la app (editarla)? Para decidir entre «Arreglar con Cortex» y «Avisar». */
export async function appCanFixAction(appRef: string): Promise<boolean> {
  try {
    const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
    return Boolean(opened?.viewer.companyAdmin) && !opened?.readOnly;
  } catch {
    return false;
  }
}
