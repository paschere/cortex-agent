import { z } from 'zod';
import { registerTool } from '../index';

/**
 * cortex.plan / cortex.plan_update — el plan POR ADELANTADO, como el de Manus.
 *
 * ===========================================================================
 * QUÉ ES Y QUÉ NO ES
 * ===========================================================================
 * Antes de una tarea de varios pasos el modelo escribe la lista corta de lo que
 * va a hacer (`cortex.plan`) y la va actualizando a medida que avanza
 * (`cortex.plan_update`). La pantalla la dibuja como una lista de chequeo en el
 * chat y en el panel «la computadora de Cortex», con los pasos que FALTAN
 * todavía en gris — que es lo que el plan derivado de las llamadas no puede
 * enseñar, porque no adivina el futuro.
 *
 * NO HACE NADA. Sin base de datos, sin red, sin aprobación, sin efectos: sólo
 * devuelve lo que recibió, normalizado. El estado vive en los resultados de
 * herramienta que el turno ya guarda; `apps/web/lib/plan-state.ts` lo reduce
 * (resultado tras resultado) al plan vigente. Por eso `plan_update` manda sólo
 * los pasos que cambian y no repite toda la lista.
 *
 * Siempre disponible: la familia `cortex` está en BASE_FAMILIES, así que viaja
 * en el catálogo de cada turno sin pasar por el ranking.
 */

export const PLAN_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'skipped'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

const statusField = z.enum(PLAN_STATUSES);
const idField = z
  .string()
  .min(1)
  .max(24)
  .describe('Id corto y estable del paso: "1", "2", "leer", "crear-tabla".');
const labelField = z
  .string()
  .min(2)
  .max(90)
  .describe('El paso en español, corto y en infinitivo o presente: "Leer el extracto".');
const noteField = z.string().max(160).optional();
const toolsField = z
  .array(
    z
      .string()
      .min(3)
      .max(80)
      .regex(/^[A-Za-z0-9_.-]+$/),
  )
  .max(8)
  .optional()
  .describe(
    'Ids exactos de las herramientas con confirmación que este paso piensa llamar ("trackers.upsert", "views.create"). Con esto la persona aprueba el plan una sola vez. Omítelo si el paso sólo lee.',
  );
const whatField = z
  .string()
  .max(140)
  .optional()
  .describe(
    'Qué cambia este paso, en una frase para la persona: "Crea la tabla Clientes con 5 columnas".',
  );

const MAX_STEPS = 12;

const stepOut = z.object({
  id: z.string(),
  label: z.string(),
  status: statusField,
  note: z.string().optional(),
  tools: z.array(z.string()).optional(),
  what: z.string().optional(),
});

export type PlanStepOut = z.infer<typeof stepOut>;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Pura: normaliza el plan. Ids repetidos se renumeran; el primero queda «en curso» si ninguno lo está. */
export function normalizePlan(input: {
  title: string;
  steps: Array<{
    id: string;
    label: string;
    status?: PlanStatus;
    note?: string | undefined;
    tools?: string[] | undefined;
    what?: string | undefined;
  }>;
}): { title: string; steps: PlanStepOut[] } {
  const seen = new Set<string>();
  const steps: PlanStepOut[] = input.steps.slice(0, MAX_STEPS).map((s, i) => {
    let id = clean(s.id) || String(i + 1);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const note = s.note ? clean(s.note) : '';
    const what = s.what ? clean(s.what) : '';
    const tools = [...new Set((s.tools ?? []).map((t) => t.trim()).filter(Boolean))];
    return {
      id,
      label: clean(s.label),
      status: s.status ?? 'pending',
      ...(note ? { note } : {}),
      ...(what ? { what } : {}),
      ...(tools.length ? { tools } : {}),
    };
  });
  return { title: clean(input.title), steps };
}

export const cortexPlan = registerTool({
  id: 'cortex.plan',
  description:
    'Declara el PLAN de la tarea antes de empezar. Llámala PRIMERO en cualquier trabajo de varios pasos (3 o más) o que cree tablas, vistas o aplicaciones, use el navegador o encadene varias herramientas; NO para una pregunta de un solo paso. Pasa un título corto y los pasos en orden (máximo 12, cada uno en pocas palabras, en español). La persona ve la lista de chequeo en el chat con lo que falta por hacer. Si algún paso va a llamar herramientas que piden confirmación, anótalas en `tools` (ids exactos) y una frase en `what`: la persona verá una tarjeta «Aprobar el plan» y podrá aprobarlo UNA vez (no cubre envíos a terceros, pagos ni borrados: esos siempre preguntan). Esta herramienta no ejecuta nada ni pide aprobación: sólo muestra el plan. Después de cada paso importante llama cortex.plan_update; si el plan cambia de verdad, vuelve a llamar cortex.plan con la lista nueva.',
  inputSchema: z.object({
    title: z.string().min(2).max(80).describe('Qué se va a lograr, en una frase corta.'),
    steps: z
      .array(
        z.object({
          id: idField,
          label: labelField,
          note: noteField,
          tools: toolsField,
          what: whatField,
        }),
      )
      .min(1)
      .max(MAX_STEPS),
  }),
  outputSchema: z.object({
    title: z.string(),
    steps: z.array(stepOut),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => normalizePlan({ title: input.title, steps: input.steps }),
});

export const cortexPlanUpdate = registerTool({
  id: 'cortex.plan_update',
  description:
    'Actualiza el estado de los pasos del plan que declaraste con cortex.plan. Llámala al empezar un paso (in_progress) y al terminarlo (done), o si falla (failed, con una nota corta de por qué) o se descarta (skipped). Puedes cambiar varios pasos en una sola llamada, por ejemplo cerrar uno y abrir el siguiente. `added` agrega pasos nuevos al final cuando surge trabajo que no estaba previsto. No ejecuta nada ni pide aprobación. Al terminar la tarea deja todos los pasos en done, failed o skipped.',
  inputSchema: z.object({
    updates: z
      .array(z.object({ id: idField, status: statusField, note: noteField }))
      .min(1)
      .max(MAX_STEPS),
    added: z
      .array(z.object({ id: idField, label: labelField, status: statusField.optional() }))
      .max(6)
      .optional(),
  }),
  outputSchema: z.object({
    updates: z.array(
      z.object({ id: z.string(), status: statusField, note: z.string().optional() }),
    ),
    added: z.array(stepOut).optional(),
  }),
  rateLimit: { perMinute: 120 },
  handler: async (input) => {
    const updates = input.updates.map((u) => {
      const note = u.note ? clean(u.note) : '';
      return { id: clean(u.id), status: u.status, ...(note ? { note } : {}) };
    });
    const added = (input.added ?? []).map((a) => ({
      id: clean(a.id),
      label: clean(a.label),
      status: a.status ?? ('pending' as const),
    }));
    return { updates, ...(added.length > 0 ? { added } : {}) };
  },
});
