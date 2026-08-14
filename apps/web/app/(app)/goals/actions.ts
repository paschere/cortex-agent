'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { MetricUnavailableError, archiveGoal, writeGoal } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from './_components/types';

/**
 * Lo que la pantalla de Metas puede escribir, que son exactamente dos cosas:
 * fijar una meta y retirarla.
 *
 * NINGUNA DE LAS DOS DECIDE SI LA MÉTRICA SE PUEDE MEDIR. Eso lo decide
 * `writeGoal`, que vuelve a ejecutar `available(db)` aunque el selector ya lo
 * hubiera hecho — el selector es cortesía y esto es la regla. Un formulario
 * manipulado, una pestaña abierta desde ayer, o una métrica que dejó de estar
 * disponible entre medias dan todos el mismo error con la misma frase que dice
 * qué falta.
 *
 * `nullish()` y no `optional()` en el cuerpo: un campo que el navegador manda
 * como `null` y un campo ausente son la misma cosa aquí, y `optional()` sólo
 * acepta el segundo.
 */

const PATH = '/goals';

const createSchema = z.object({
  metricKey: z.string().min(3).max(40),
  cadence: z.enum(['week', 'month']),
  targetValue: z.number().finite(),
  label: z.string().max(120).nullish(),
});

function describe(err: unknown, fallback: string): string {
  if (err instanceof MetricUnavailableError) return err.message;
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export async function createGoal(input: unknown): Promise<ActionResult> {
  const user = await requireSession();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Faltan datos para fijar la meta: elige una métrica y un número.' };
  }
  try {
    const db = getOrgScopedClient(user.organization.id);
    const goal = await writeGoal(db, {
      metricKey: parsed.data.metricKey,
      cadence: parsed.data.cadence,
      targetValue: parsed.data.targetValue,
      label: parsed.data.label ?? null,
      // Quien la fija es quien está en la sesión, y no un campo del formulario:
      // `created_by` tiene que ser quien de verdad lo declaró.
      createdBy: user.id,
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `«${goal.label}» queda fijada bajo tu nombre. La primera lectura se congela cuando cierre el período; mientras tanto verás cómo va el que está en curso.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo fijar la meta.') };
  }
}

const archiveSchema = z.object({ goalId: z.string().min(1) });

export async function retireGoal(input: unknown): Promise<ActionResult> {
  const user = await requireSession();
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'No se dijo qué meta retirar.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    await archiveGoal(db, parsed.data.goalId, user.id);
    revalidatePath(PATH);
    return {
      ok: true,
      note: 'Retirada bajo tu nombre. Sus lecturas siguen guardadas tal como se congelaron: son lo que pasó, y borrarlas dejaría un hueco sin explicación.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo retirar la meta.') };
  }
}
