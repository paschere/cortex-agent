import { z } from 'zod';
import { registerTool } from '../index';
import { COMPANY_SECTIONS, companyFactsBudget } from './shape';
import { hydrateCompanyFacts, listCompanyFacts } from './store';

/**
 * LA FICHA DE LA EMPRESA, DICHA EN VOZ ALTA — Y UNA SOLA HERRAMIENTA.
 *
 * ===========================================================================
 * PRIMERO: ¿PARA QUÉ UNA HERRAMIENTA DE LECTURA SI EL BLOQUE YA VA EN EL PROMPT?
 * ===========================================================================
 * Es la objeción correcta y tiene respuesta. El bloque inyectado lleva LO QUE SE
 * SABE. Esta herramienta lleva además LO QUE FALTA, y las dos cosas no pueden ir
 * en el mismo sitio:
 *
 *   En el prompt, los huecos serían ruido pagado en cada turno de cada
 *   superficie — cuarenta renglones diciendo «Régimen tributario: (sin poner)»
 *   compiten con los hechos de verdad por el mismo presupuesto y no ayudan a
 *   contestar nada.
 *
 *   En una respuesta a «¿qué sabes de nosotros?», los huecos son LA MITAD ÚTIL.
 *   Quien pregunta eso está auditando a Cortex, y «no me han dicho el plazo de
 *   pago» es más accionable que cualquiera de las líneas que sí están.
 *
 * Y hay un segundo motivo, más aburrido y más real: sin herramienta no hay
 * tarjeta en el chat, y sin tarjeta la pantalla sólo la abre quien ya sabe que
 * existe. Es literalmente el argumento con el que se escribió `goals.list`.
 *
 * ===========================================================================
 * SEGUNDO, Y ES LA DECISIÓN DEL ARCHIVO: NO HAY HERRAMIENTA DE ESCRITURA
 * ===========================================================================
 * Cortex no puede escribir la ficha de la empresa. No es una omisión pendiente,
 * es la decisión, y es la misma que el repositorio ya tomó en `approvals.decide`
 * y en los mandatos (0099): UNA SUPERFICIE NO AMPLÍA SU PROPIO LÍMITE.
 *
 * El bloque de esta ficha va en el prompt de cada turno de cada superficie, y su
 * última sección se llama «Lo que no». Una herramienta `company.set_fact` sería,
 * literalmente, una herramienta con la que el modelo puede reescribir las
 * instrucciones que lo gobiernan en el siguiente turno — con una frase de un
 * cliente en un hilo de correo bastaría. No hay ningún reparto de permisos que
 * arregle eso, porque el agujero no está en quién puede llamarla sino en que el
 * objeto que edita ES el límite.
 *
 * `cortex.remember` sí escribe sin aprobación y no es una contradicción: escribe
 * sobre UNA persona, la que está delante, que puede leer y borrar sus memorias
 * en su propia pantalla, y su descripción dice explícitamente que los hechos de
 * empresa NO van ahí. El radio de un error es una persona. Aquí sería todo el
 * mundo, para siempre, en silencio.
 *
 * LO QUE SÍ PUEDE HACER CORTEX cuando alguien le dicta un dato de empresa está
 * en `guidance`: decirlo, dictar el texto exacto y mandar a la pantalla. Un
 * camino de treinta segundos con una persona al final, que es la diferencia
 * entre un producto que se deja auditar y uno que se cree a sí mismo.
 *
 * (La versión intermedia —Cortex PROPONE y alguien aprueba en pantalla— es
 * defendible y está descartada por ahora por una razón de producto y no de
 * seguridad: la ficha todavía no existe para nadie. Una bandeja de propuestas
 * sobre una ficha vacía es una cola que nadie mira. Cuando haya fichas escritas
 * y se vea qué se dicta por chat, la mesa ya está puesta: `writeCompanyFact` es
 * la única puerta y aceptaría un estado `suggested` sin tocar nada más.)
 */

export const companyFacts = registerTool({
  id: 'company.facts',
  description:
    'Lo que está escrito sobre esta empresa: identidad y NIT, cómo entra la plata y cómo se cobra, quién decide qué, cómo se trabaja aquí, y lo que no debes hacer por tu cuenta. Devuelve además LO QUE FALTA por escribir en cada sección. Úsala cuando te pregunten qué sabes de la empresa, qué información tienes de ellos, o cuando quieran revisar o corregir esa ficha. No la necesitas para responder con estos datos —ya los tienes delante en cada conversación—: sirve para enseñarlos, para señalar los huecos y para mandar a la pantalla a quien quiera cambiarlos. TÚ NO PUEDES ESCRIBIRLOS: si te dictan un dato de la empresa, dícteselo de vuelta ya redactado y dile que lo guarde en «Datos de la empresa», en el menú de la izquierda.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    sections: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        blurb: z.string(),
        facts: z.array(
          z.object({
            label: z.string(),
            value: z.string(),
            /** Quién lo dejó escrito. Null cuando esa persona ya no está. */
            updatedBy: z.string().nullable(),
            updatedOn: z.string(),
          }),
        ),
        /** Campos sugeridos que esta empresa todavía no ha respondido. */
        missing: z.array(z.string()),
      }),
    ),
    total: z.number().int(),
    /** Cuánto del presupuesto del prompt se lleva usado la ficha. */
    charsUsed: z.number().int(),
    charsBudget: z.number().int(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const rows = await hydrateCompanyFacts(ctx.db, await listCompanyFacts(ctx.db));
    const budget = companyFactsBudget(rows);

    const sections = COMPANY_SECTIONS.map((section) => {
      const own = rows.filter((r) => r.section === section.key);
      const written = new Set(own.map((r) => r.label.trim().toLowerCase()));
      return {
        key: section.key,
        name: section.name,
        blurb: section.blurb,
        facts: own.map((r) => ({
          label: r.label,
          value: r.value,
          updatedBy: r.updated_by_name ?? null,
          updatedOn: r.updated_at.slice(0, 10),
        })),
        missing: section.suggested.filter((s) => !written.has(s.trim().toLowerCase())),
      };
    });

    // Dos frases distintas para dos situaciones distintas. La de la ficha vacía
    // es la que más se va a leer, y tiene que ser una invitación con una ruta —
    // no un aviso de que falta algo.
    const guidance =
      rows.length === 0
        ? 'Nadie ha escrito todavía nada sobre esta empresa, así que no sabes su NIT, ni a qué se dedica, ni cómo cobra, ni qué no debes hacer. Dilo así de claro y ofrece ayudar: pregúntale las tres o cuatro cosas que más te harían falta, y cuando te las diga, redáctaselas en el formato «Nombre del dato: valor» y dile que las pegue en «Datos de la empresa», en el menú de la izquierda. No puedes guardarlas tú.'
        : `Esto es lo que hay escrito, y ya lo tienes delante en cada conversación sin pedirlo. Lo que sale en «missing» es lo que nadie ha respondido: menciónalo si viene al caso, sin recitar la lista entera. Si te dictan una corrección, redáctala tal cual habría que guardarla y manda a «Datos de la empresa» en el menú de la izquierda: tú no puedes escribir esta ficha. La ficha ocupa ${budget.used} de ${budget.limit} caracteres del espacio que llevas en cada respuesta.`;

    return {
      sections,
      total: rows.length,
      charsUsed: budget.used,
      charsBudget: budget.limit,
      guidance,
    };
  },
});
