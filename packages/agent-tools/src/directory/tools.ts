import { z } from 'zod';
import { registerTool } from '../index';
import {
  type DirectoryPerson,
  type LineNode,
  buildOrgLine,
  chainAbove,
  managerMapOf,
  personLabel,
} from './line';
import { adaptDirectoryPerson, listDirectory } from './store';

/**
 * PREGUNTARLE A CORTEX QUIÉN LE RESPONDE A QUIÉN — Y UNA SOLA HERRAMIENTA.
 *
 * ===========================================================================
 * PRIMERO: ¿POR QUÉ NO ES UN CAMPO MÁS EN `people.search`?
 * ===========================================================================
 * Porque `people.search` no lee este producto. Lee la API de Google People —el
 * directorio de Google Workspace y los contactos personales de quien pregunta—
 * y su propia descripción lo dice en voz alta: «no client placement, NO MANAGER,
 * no hire date, no pay». Añadirle el jefe significaría que una misma respuesta
 * mezcla dos fuentes que no coinciden: el nombre y el correo saldrían de Google,
 * y la línea de mando de `public.users`, sin que nadie pueda decir cuál manda
 * cuando discrepan. Son dos preguntas distintas con dos fuentes distintas y
 * merecen dos herramientas.
 *
 * (`payroll.employee_profile` tampoco: es un sistema externo, y su descripción
 * también dice explícitamente que el jefe no está entre lo que devuelve.)
 *
 * ===========================================================================
 * SEGUNDO, Y ES LA DECISIÓN DEL ARCHIVO: NO HAY HERRAMIENTA DE ESCRITURA
 * ===========================================================================
 * Cortex no puede cambiar quién le responde a quién. Es la misma decisión que
 * `company.facts` y por una razón más afilada todavía: esta columna decide A
 * QUIÉN LE ESCRIBE CORTEX POR ENCIMA DE TU CABEZA. Una herramienta
 * `directory.set_manager` sería una herramienta con la que una frase en un
 * correo puede cambiar quién se entera de que alguien no cumple — y, al revés,
 * puede desconectar a alguien de su jefe sin que ninguna pantalla se ponga roja.
 *
 * Se cambia en «Personas», que es de admin, y se VE en «Datos de la empresa»,
 * que es de todos. Esa asimetría es la guarda del módulo entero: nadie puede
 * tener en Cortex un jefe que no pueda ver.
 *
 * ===========================================================================
 * LO QUE ESTA HERRAMIENTA NO ES, Y LO DICE EN SU PROPIA RESPUESTA
 * ===========================================================================
 * NO ES EL ORGANIGRAMA DE LA EMPRESA. Es quién le responde a quién ENTRE LA
 * GENTE QUE TIENE CUENTA EN CORTEX. Es exactamente la misma trampa que el módulo
 * de la ficha de empresa ya esquivó al negarse a contar empleados desde `users`:
 * ocho cuentas en una empresa de cuarenta es una cifra exacta y una respuesta
 * falsa. Aquí sería peor, porque un árbol se lee como completo — nadie mira un
 * organigrama preguntándose a quién le falta. Así que la respuesta lleva siempre
 * cuánta gente hay, y la palabra «organigrama» no aparece en ninguna parte.
 */

/** Una rama, aplanada a texto. Dos espacios por escalón. */
function renderNode(node: LineNode, level: number, out: string[]): void {
  const suffix = node.broken ? ' — su jefe forma un círculo, revísalo' : '';
  out.push(`${'  '.repeat(level)}- ${personLabel(node.person)}${suffix}`);
  for (const child of node.reports) renderNode(child, level + 1, out);
}

function matches(person: DirectoryPerson, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return false;
  return person.email.toLowerCase().includes(q) || (person.name ?? '').toLowerCase().includes(q);
}

export const directoryLine = registerTool({
  id: 'directory.line',
  description:
    'Quién le responde a quién dentro de esta empresa: el jefe de alguien, quiénes dependen de esa persona, y la cadena completa hacia arriba. Úsala cuando pregunten de quién depende alguien, quién es el jefe de quién, quién tiene gente a cargo, a quién hay que avisarle si alguien no cumple, o quién recibiría un escalado. Sin nombre devuelve la línea entera. OJO: sólo cubre a quien tiene cuenta en Cortex, así que no es el organigrama de la empresa y no debes presentarlo como tal — para quién decide qué (incluida gente sin cuenta) está la sección «Quién es quién» de los datos de la empresa. Tú no puedes cambiarla: eso se hace en «Personas».',
  inputSchema: z.object({
    person: z
      .string()
      .max(160)
      .optional()
      .describe('Nombre o correo de una persona. Vacío para ver la línea entera.'),
  }),
  outputSchema: z.object({
    /** Cuando se preguntó por alguien y se resolvió a una sola persona. */
    person: z
      .object({
        name: z.string(),
        email: z.string(),
        /** Su jefe, o null si no tiene puesto. */
        manager: z.string().nullable(),
        /** Toda la cadena hacia arriba, del jefe al más alto. */
        above: z.array(z.string()),
        /** Quiénes le responden directamente. */
        reports: z.array(z.string()),
      })
      .nullable(),
    /** Cuando el nombre casó con varias personas. */
    ambiguous: z.array(z.string()),
    /** Cuántas cuentas hay en el espacio, y cuántas sin jefe puesto. */
    total: z.number().int(),
    unmanaged: z.number().int(),
    markdown: z.string(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const people = (await listDirectory(ctx.db)).map(adaptDirectoryPerson);
    const line = buildOrgLine(people);
    const managers = managerMapOf(people.map((p) => ({ id: p.id, managerId: p.managerId })));
    const byId = new Map(people.map((p) => [p.id, p]));
    const nameOf = (id: string) => {
      const found = byId.get(id);
      return found ? personLabel(found) : 'alguien que ya no está';
    };

    // Siempre en la respuesta, y no sólo cuando la ficha está vacía: es lo que
    // impide que un árbol de ocho nombres se lea como una empresa de ocho
    // personas. Ver la cabecera.
    const scope =
      `Esto cubre a las ${people.length} personas con cuenta en Cortex, que puede ser menos ` +
      'gente de la que trabaja en la empresa. No es el organigrama.';

    if (input.person?.trim()) {
      const hits = people.filter((p) => matches(p, input.person as string));
      if (hits.length === 0) {
        return {
          person: null,
          ambiguous: [],
          total: people.length,
          unmanaged: line.unmanaged,
          markdown: `Nadie con cuenta en Cortex se llama «${input.person}» ni tiene ese correo.`,
          guidance: `${scope} Si es alguien de la empresa sin cuenta, dilo así en vez de suponer.`,
        };
      }
      if (hits.length > 1) {
        const names = hits.map((p) => `${personLabel(p)} (${p.email})`);
        return {
          person: null,
          ambiguous: names,
          total: people.length,
          unmanaged: line.unmanaged,
          markdown: `«${input.person}» casa con varias personas:\n${names.map((n) => `- ${n}`).join('\n')}`,
          guidance: 'Pregúntale a quién se refiere antes de contestar.',
        };
      }

      const [target] = hits as [DirectoryPerson];
      const chain = chainAbove(managers, target.id);
      const reports = people
        .filter((p) => p.managerId === target.id)
        .map(personLabel)
        .sort((a, b) => a.localeCompare(b, 'es'));
      const above = chain.above.map(nameOf);

      const lines = [
        above.length > 0
          ? `**${personLabel(target)}** le responde a **${above[0]}**${above.length > 1 ? `, y por encima: ${above.slice(1).join(' → ')}` : ''}.`
          : `**${personLabel(target)}** no tiene jefe puesto en Cortex, así que un escalado suyo llega al primer administrador del espacio.`,
        reports.length > 0
          ? `Le responden ${reports.length}: ${reports.join(', ')}.`
          : 'Nadie le responde a esta persona.',
      ];
      if (chain.cycle) {
        lines.push('La cadena hacia arriba se muerde la cola. Hay que corregirla en «Personas».');
      }

      return {
        person: {
          name: personLabel(target),
          email: target.email,
          manager: above[0] ?? null,
          above,
          reports,
        },
        ambiguous: [],
        total: people.length,
        unmanaged: line.unmanaged,
        markdown: lines.join('\n\n'),
        guidance: scope,
      };
    }

    const out: string[] = [];
    for (const root of line.roots) renderNode(root, 0, out);

    return {
      person: null,
      ambiguous: [],
      total: people.length,
      unmanaged: line.unmanaged,
      markdown:
        out.length > 0
          ? out.join('\n')
          : 'Todavía no hay nadie con cuenta en este espacio de trabajo.',
      guidance:
        line.unmanaged === people.length && people.length > 0
          ? `${scope} Nadie tiene jefe puesto todavía, así que TODO escalado cae en el primer administrador. Se arregla en «Personas», en el menú de la izquierda.`
          : line.unmanaged > 0
            ? `${scope} ${line.unmanaged} ${line.unmanaged === 1 ? 'persona no tiene' : 'personas no tienen'} jefe puesto: sus escalados caen en el primer administrador.`
            : scope,
    };
  },
});
