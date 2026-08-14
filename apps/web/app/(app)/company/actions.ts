'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  UnknownCompanySectionError,
  deleteCompanyFact,
  writeCompanyFact,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from './_components/types';

/**
 * Lo que la pantalla puede escribir: guardar un hecho y borrarlo.
 *
 * ===========================================================================
 * LAS DOS COMPRUEBAN EL ROL, Y NO ES REDUNDANTE
 * ===========================================================================
 * La página se puede ABRIR sin ser admin —a propósito: la ficha es lo que
 * explica las respuestas que recibe cualquiera— y no está bajo `/admin/*`, así
 * que no hereda el `notFound()` de aquel layout. Una acción de servidor es una
 * ruta HTTP propia con su URL: esconder el botón no esconde la acción, y una
 * pantalla que sólo se protege escondiendo controles es una pantalla sin
 * protección.
 *
 * ===========================================================================
 * NINGUNA DE LAS DOS DECIDE SI EL DATO CABE
 * ===========================================================================
 * Eso lo decide `writeCompanyFact`, que vuelve a pesar el presupuesto contra lo
 * que hay guardado aunque el medidor de la pantalla ya lo hubiera hecho. El
 * medidor es cortesía; la puerta de escritura es la regla. Una pestaña abierta
 * desde ayer, dos personas escribiendo a la vez, o un formulario manipulado dan
 * todos el mismo error con la misma frase y la misma cifra.
 */

const PATH = '/company';

const saveSchema = z.object({
  id: z.string().uuid().nullish(),
  section: z.string().min(3).max(40),
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(2000),
  sort: z.number().int().min(0).max(9999).nullish(),
});

const deleteSchema = z.object({ id: z.string().uuid() });

function describe(err: unknown, fallback: string): string {
  if (err instanceof UnknownCompanySectionError) return err.message;
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * Los topes del esquema de aquí son MÁS ANCHOS que los de verdad (200 y 2000
 * frente a 60 y 300), y es deliberado. Este zod sólo descarta lo absurdo; el
 * límite real lo aplica `writeCompanyFact`, que devuelve una frase que dice
 * cuánto sobra. Ponerlos iguales daría dos rechazos para el mismo caso y el de
 * aquí —«Faltan datos»— es el que no ayuda.
 */
export async function saveFact(input: unknown): Promise<ActionResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin')
    return {
      ok: false,
      error: 'Sólo un administrador puede cambiar la ficha de la empresa. Puedes verla completa.',
    };

  const parsed = saveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: 'Faltan datos: un dato necesita un nombre y un contenido.' };

  try {
    const db = getOrgScopedClient(user.organization.id);
    const fact = await writeCompanyFact(db, {
      id: parsed.data.id ?? null,
      section: parsed.data.section,
      label: parsed.data.label,
      value: parsed.data.value,
      sort: parsed.data.sort ?? 0,
      // Quien lo escribe es quien está en la sesión y no un campo del
      // formulario: `updated_by` tiene que ser quien de verdad lo dijo.
      updatedBy: user.id,
    });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `«${fact.label}» ya está en la ficha. Cortex lo sabe desde su próxima respuesta, en el chat, en Google Chat y en las rutinas.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el dato.') };
  }
}

export async function removeFact(input: unknown): Promise<ActionResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin')
    return { ok: false, error: 'Sólo un administrador puede cambiar la ficha de la empresa.' };

  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: 'No se pudo identificar el dato que hay que borrar.' };

  try {
    await deleteCompanyFact(getOrgScopedClient(user.organization.id), parsed.data.id);
    revalidatePath(PATH);
    return { ok: true, note: 'Borrado. Cortex deja de saberlo desde su próxima respuesta.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo borrar el dato.') };
  }
}
