'use server';

import { openApp } from '@/lib/apps/access';
import {
  describeWouldSave,
  previewAppForm,
  screenFor,
  screenView,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';

/**
 * EL «MODO PRUEBA» DE UN FORMULARIO («Ver como…» con datos de prueba).
 *
 * Quien administra mira la app con los ojos de un rol y llena un formulario: el
 * servidor pasa por las mismas comprobaciones del envío de verdad (el rol puede
 * registrar en esa tabla, los campos que puede escribir, las reglas de cada
 * campo, los campos ocultos, las relaciones) y contesta «se habría guardado
 * esto», sin escribir la fila, el registro del envío, las automatizaciones ni
 * el uso. Si algo se rechazaría de verdad, se rechaza igual y con el mismo texto.
 */

export type DryRunResult =
  | { ok: true; message: string; rowId: string }
  | { ok: false; error: string };

export async function dryRunAppFormAction(
  appRef: string,
  screenRef: string,
  roleKey: string,
  blockId: string,
  values: Record<string, string>,
): Promise<DryRunResult> {
  try {
    const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef), {
      as: z.string().trim().min(1).max(40).parse(roleKey),
    });
    // Sólo cuenta si el servidor aceptó el rol pedido (quien administra): para
    // cualquier otra persona `readOnly` es falso y no hay modo prueba.
    if (!opened || !opened.readOnly)
      return { ok: false, error: 'El modo prueba es sólo de quien administra la empresa.' };
    const screen = screenFor(opened.access, screenRef);
    if (!screen) throw new NotFoundError('Esa pantalla no existe.');
    const view = await screenView(opened.db, screen);
    const { values: shaped, tracker } = await previewAppForm(opened.db, opened.access, view, {
      blockId,
      values,
    });
    return {
      ok: true,
      rowId: 'prueba',
      message: `Modo prueba: no se guardó nada. Se habría guardado esto: ${describeWouldSave(tracker.fields, shaped)}.`,
    };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError)
      return { ok: false, error: `Modo prueba: así se rechazaría de verdad. ${err.message}` };
    return { ok: false, error: 'No se pudo probar el formulario.' };
  }
}
