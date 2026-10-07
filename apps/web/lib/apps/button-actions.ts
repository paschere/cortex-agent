'use server';

import { openApp } from '@/lib/apps/access';
import { fireButton, getAutomation, screenButtons, screenFor } from '@cortex/agent-tools';
import { NotFoundError } from '@cortex/core';
import { z } from 'zod';

type Result = { ok: true; message: string } | { ok: false; error: string };

/**
 * Un botón de acción manual de una pantalla (disparador `button`): encola una
 * corrida de la regla. Resuelve el acceso de nuevo con el rol guardado, exige
 * que la pantalla sea de quien toca y que el botón siga en esa pantalla; no
 * funciona en «Ver como…» (nada se escribe).
 */
export async function pressAppButtonAction(
  appRef: string,
  screenRef: string,
  automationId: string,
): Promise<Result> {
  try {
    const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
    const screen = opened ? screenFor(opened.access, screenRef) : null;
    if (!opened || !screen) throw new NotFoundError('Esa pantalla no existe.');
    if (opened.readOnly) return { ok: false, error: 'En «Ver como…» nada se ejecuta.' };
    const id = z.string().uuid().parse(automationId);
    const buttons = await screenButtons(opened.db, opened.access.app.id, screen.slug);
    if (!buttons.some((b) => b.automationId === id))
      throw new NotFoundError('Ese botón ya no está en esta pantalla.');
    const automation = await getAutomation(opened.db, opened.access.app.id, id);
    if (!automation) throw new NotFoundError('Ese botón ya no está en esta pantalla.');
    const out = await fireButton(opened.db, {
      automation,
      screen: screen.slug,
      actor: { kind: opened.external ? 'app_user' : 'member', id: opened.actor.id },
    });
    return {
      ok: true,
      message: out.queued ? 'Listo, ya se está ejecutando.' : 'Ya lo pediste hace un momento.',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof NotFoundError ? err.message : 'No se pudo ejecutar el botón.',
    };
  }
}
