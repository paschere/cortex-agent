'use server';

import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  COMPANY_SECTIONS,
  UnknownCompanySectionError,
  deleteCompanyFact,
  listCompanyFacts,
  writeCompanyFact,
} from '@cortex/agent-tools';
import { NotFoundError, type UUID, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult, ProposeResult } from './_components/types';
import { gatherCandidates } from './_lib/gather';
import { selectProposal } from './_lib/proposal';

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

// ---------------------------------------------------------------------------
// «Que lo busque Cortex»
// ---------------------------------------------------------------------------

const proposeSchema = z.object({
  name: z.string().min(2).max(120),
  site: z.string().max(200).nullish(),
});

/**
 * BUSCA, PROPONE Y NO ESCRIBE NADA.
 *
 * ===========================================================================
 * LO QUE ESTA ACCIÓN NO HACE, QUE ES LO QUE LA DEFINE
 * ===========================================================================
 * No toca `company_facts`. No crea filas en estado «sugerido». No deja nada
 * detrás. Devuelve un borrador que vive en la pantalla, y cada valor que
 * sobreviva a la revisión entra por `saveFact` — la MISMA acción que usa el
 * formulario de a mano, con su mismo control de rol y su mismo presupuesto.
 *
 * Es la única forma de cumplir a la vez las dos cosas que se decidieron antes:
 * que Cortex ayude a llenar la ficha, y que Cortex no pueda escribir la ficha
 * (`company/tools.ts`, cuya última sección es «Lo que no» y por tanto es el
 * límite que lo gobierna). Proponer no amplía el límite porque entre la
 * propuesta y la fila hay una persona que aprobó campo por campo.
 *
 * Y por eso tampoco es una herramienta del agente: es un botón de la pantalla.
 * Una `company.propose` invocable desde el chat sería una superficie por la que
 * el modelo genera propuestas por su cuenta, y la distancia entre eso y que
 * alguien las apruebe en bloque un martes por la tarde es más corta de lo que
 * parece.
 *
 * ===========================================================================
 * PROPONER TAMBIÉN ES DE ADMIN, Y NO POR SIMETRÍA
 * ===========================================================================
 * Ver la ficha es de todos y eso no cambia. Pero buscar cuesta: lee el cerebro,
 * sale a internet y consume la cuota de las herramientas del espacio. Y sobre
 * todo, sólo un admin puede aceptar lo que salga — así que a cualquier otro le
 * devolvería una lista bonita con la que no puede hacer absolutamente nada, que
 * es una función que parece que sirve y no sirve. Se comprueba aquí y no sólo
 * escondiendo el botón: una acción de servidor es una ruta HTTP con su URL.
 */
export async function proposeFacts(input: unknown): Promise<ProposeResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin')
    return {
      ok: false,
      error:
        'Sólo un administrador puede rellenar la ficha, así que sólo él puede buscar los datos.',
    };

  const parsed = proposeSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error:
        'Escribe el nombre de la empresa: es lo que Cortex usa para saber cuál de las empresas que salen en tus documentos eres tú.',
    };

  const db = getOrgScopedClient(user.organization.id);

  // El agente hace falta para salir a la web, y sólo para eso. Si no está
  // configurado, `gatherCandidates` se lo encuentra en null y sigue con las
  // fuentes de dentro — la parte determinista no depende de esto.
  let ctx = null;
  try {
    const { data, error } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
    if (!error && data?.id)
      ctx = buildToolContext({
        userId: user.id as UUID,
        agentId: data.id as UUID,
        organizationId: user.organization.id,
      });
  } catch {
    // Igual que arriba: sin agente se busca en casa y se dice en `notes`.
  }

  try {
    const [written, gathered] = await Promise.all([
      listCompanyFacts(db),
      gatherCandidates({
        db,
        ctx,
        userId: user.id,
        typedName: parsed.data.name,
        site: parsed.data.site ?? null,
      }),
    ]);

    const proposal = selectProposal(gathered.candidates, {
      written: written.map((r) => ({ section: r.section, label: r.label, value: r.value })),
      sectionNames: Object.fromEntries(COMPANY_SECTIONS.map((s) => [s.key, s.name])),
      sectionOrder: COMPANY_SECTIONS.map((s) => s.key),
      suggested: Object.fromEntries(COMPANY_SECTIONS.map((s) => [s.key, [...s.suggested]])),
    });

    return { ok: true, proposal, notes: gathered.notes };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo buscar la información de la empresa.') };
  }
}

const acceptSchema = z.object({
  facts: z
    .array(
      z.object({
        section: z.string().min(3).max(40),
        label: z.string().min(1).max(200),
        value: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(40),
});

/**
 * Guardar lo que la persona marcó, uno por uno y por la misma puerta.
 *
 * ===========================================================================
 * ES UN BUCLE SOBRE `writeCompanyFact`, Y ESO ES A PROPÓSITO
 * ===========================================================================
 * Nada de una inserción en bloque. Cada valor pasa por la única puerta de
 * escritura que existe, con su comprobación de sección, sus topes de longitud,
 * su límite de filas y su presupuesto REPESADO contra lo que hay guardado en
 * ese momento. Si el sexto no cabe, los cinco anteriores están guardados y el
 * sexto devuelve la frase que dice cuánto sobra — que es exactamente lo que
 * pasaría escribiéndolos a mano de uno en uno, porque es lo mismo.
 *
 * NO ES UNA TRANSACCIÓN, y no debería serlo: deshacer cinco datos correctos
 * porque el sexto es largo convierte un aviso en una pérdida de trabajo.
 *
 * `updated_by` es quien está en la sesión y no «Cortex». Lo escribió una
 * persona: la que lo leyó, lo miró y pulsó. Eso es lo que la ficha tiene que
 * poder decir dentro de seis meses.
 */
export async function acceptFacts(input: unknown): Promise<ActionResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin')
    return { ok: false, error: 'Sólo un administrador puede cambiar la ficha de la empresa.' };

  const parsed = acceptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'No se pudo leer lo que marcaste.' };

  const db = getOrgScopedClient(user.organization.id);
  let saved = 0;
  const failures: string[] = [];

  for (const fact of parsed.data.facts) {
    try {
      await writeCompanyFact(db, { ...fact, updatedBy: user.id });
      saved += 1;
    } catch (err) {
      failures.push(describe(err, `No se pudo guardar «${fact.label}».`));
    }
  }

  revalidatePath(PATH);

  if (saved === 0) return { ok: false, error: failures[0] ?? 'No se guardó nada.' };
  const note = `${saved} ${saved === 1 ? 'dato guardado' : 'datos guardados'}. Cortex los sabe desde su próxima respuesta, en el chat, en Google Chat y en las rutinas.`;
  return failures.length === 0
    ? { ok: true, note }
    : { ok: false, error: `${note} ${failures.join(' ')}` };
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
