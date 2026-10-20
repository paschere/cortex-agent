'use server';

import { openApp } from '@/lib/apps/access';
import { screenFor, screenView, undoAppRowChange } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';

/**
 * «Deshacer este cambio» del historial de un registro, desde una pantalla de una
 * app. Resuelve el acceso de nuevo (sesión + rol guardado, nunca el rol que
 * mande el navegador) y pasa por `undoAppRowChange`: edita la tabla, sólo lo
 * suyo si es «own», sólo los campos que su rol escribe, y un campo que cambió
 * después no se pisa. En «Ver como…» no se deshace nada.
 */

type Result = { ok: true; message: string } | { ok: false; error: string };

export async function undoRowChangeAction(
  appRef: string,
  screenRef: string,
  blockId: string,
  rowId: string,
  entryId: string,
): Promise<Result> {
  try {
    const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
    const screen = opened ? screenFor(opened.access, screenRef) : null;
    if (!opened || !screen) throw new NotFoundError('Esa pantalla no existe.');
    if (opened.readOnly) return { ok: false, error: 'En «Ver como…» nada se deshace.' };
    const view = await screenView(opened.db, screen);
    const res = await undoAppRowChange(opened.db, opened.access, view, {
      blockId: z.string().max(80).parse(blockId),
      rowId: z.string().uuid().parse(rowId),
      entryId: z.string().max(80).parse(entryId),
    });
    return { ok: true, message: `Cambio deshecho en «${res.label}».` };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError)
      return { ok: false, error: err.message };
    const message = err instanceof Error ? err.message : '';
    return {
      ok: false,
      error:
        message && message.length < 240 && !/[{}]|relation|column|violates/.test(message)
          ? message
          : 'No se pudo deshacer el cambio.',
    };
  }
}
