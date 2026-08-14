import { z } from 'zod';
import { registerTool } from '../index';

/**
 * «¿QUÉ ME ESPERA?» — LA PREGUNTA DE APERTURA, CONTESTADA CON LO QUE HAY DENTRO.
 *
 * ===========================================================================
 * QUÉ SE ARREGLA AQUÍ
 * ===========================================================================
 * Es lo primero que pregunta cualquiera que abre el chat, y hasta hoy la única
 * respuesta posible era un enlace a `/dashboard`: te decíamos que fueras a
 * mirarlo tú. Cortex trabaja de noche —los crons de vencimientos, de acciones y
 * de encargos dejan hallazgos— y todo eso vivía repartido en cuatro pantallas
 * que nadie abre sin motivo. La persona ya está delante del sitio donde se
 * pregunta; mandarla a otra pantalla es exactamente al revés.
 *
 * ===========================================================================
 * NO ES EL CUARTO LECTOR DE LAS CUATRO COLAS
 * ===========================================================================
 * Ya hay tres sitios que saben leer aprobaciones, vencimientos, acciones y
 * encargos: `nav-signals.ts` (los conteos del menú), las cuatro pantallas de
 * destino, y `waiting.ts`, que reúne a los dos. Y el propio `nav-signals.ts`
 * avisa en su cabecera de que duplicar los filtros de cada pantalla ES EL
 * RIESGO: el día que una pantalla cambie su filtro y la copia no, el índice
 * promete trabajo que la cola no tiene.
 *
 * Así que esta herramienta NO CONSULTA LA BASE DE DATOS. Ni una tabla, ni un
 * predicado, ni un horizonte de días. Llama a `readWaitingIndex`, que es la
 * misma lectura que dibuja `/dashboard`, y devuelve lo que le den. Si mañana un
 * filtro cambia, cambia en un sitio y el chat contesta lo mismo que la pantalla.
 *
 * ===========================================================================
 * POR QUÉ LA LECTURA SE REGISTRA EN LUGAR DE IMPORTARSE
 * ===========================================================================
 * `readWaitingIndex` vive en `apps/web/lib/waiting.ts` —necesita el cliente con
 * alcance de espacio, el repositorio de encargos y las frases de confirmación de
 * la web— y UN PAQUETE NO PUEDE IMPORTAR DE UNA APLICACIÓN. Es la misma costura
 * que el parte semanal resuelve inyectando `buildPeopleLoad` con un tipo
 * estructural, sólo que ahí el llamador está en la app y puede pasar el
 * argumento, y aquí quien llama es `runTool`, que no sabe nada de esto.
 *
 * Así que se registra una vez al arrancar, en `apps/web/instrumentation-node.ts`,
 * exactamente como `setDocumentSink`. El tipo es ESTRUCTURAL: describe la forma
 * mínima que esta herramienta necesita, y `WaitingIndex` la cumple sin que
 * ninguno de los dos lados importe al otro.
 *
 * En un proceso donde nadie la registre —el contenedor que maneja Chromium, una
 * prueba— la herramienta existe y se niega a contestar diciendo por qué. La
 * alternativa sería inventarse la lectura aquí, que es justo lo que la sección
 * de arriba prohíbe.
 */

/** Un elemento de una cola, con su asunto real. Nunca un identificador. */
export interface WaitingItemLike {
  id: string;
  title: string;
  detail: string | null;
  /** «redactada hace nueve días», «se venció hace doce días», «expira en 12 min». */
  when: string;
  tone: string;
}

export interface WaitingQueueLike {
  queue: string;
  label: string;
  href: string;
  count: number;
  items: WaitingItemLike[];
  /** Con qué frase se explica que esta cola no se pudo leer. */
  error: string | null;
}

/**
 * Lo MÍNIMO que esta herramienta necesita saber de un índice de espera.
 *
 * Deliberadamente estructural y deliberadamente corto: cuanto menos exija, menos
 * puede romperse el día que `waiting.ts` añada un campo. Los conteos no están
 * porque cada cola ya trae el suyo.
 */
export interface WaitingIndexLike {
  total: number;
  /** Escrita con reglas por `summarizeWaiting`, nunca por un modelo. */
  sentence: string;
  queues: WaitingQueueLike[];
}

export type WaitingReader = (organizationId: string, userId: string) => Promise<WaitingIndexLike>;

let registered: WaitingReader | null = null;

export function setWaitingReader(reader: WaitingReader | null): void {
  registered = reader;
}

export function currentWaitingReader(): WaitingReader | null {
  return registered;
}

export const inboxOverview = registerTool({
  id: 'inbox.overview',
  description:
    'Qué está esperando algo de esta persona AHORA, en las cuatro colas donde el trabajo se para: lo que espera su permiso, los vencimientos encima, los correos que Cortex dejó redactados y sin mandar, y los encargos que se atascaron. Devuelve el asunto real de cada cosa y cuánto lleva esperando, no un conteo. Es la respuesta a «¿qué me espera?», «¿qué tengo pendiente?», «¿en qué voy?» y a un saludo de la mañana. Léelo tal cual: la frase de resumen ya viene escrita y las cuatro colas no se mezclan entre sí.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    total: z.number(),
    /** La frase de arriba, ya redactada. No la reescribas: es una función pura. */
    sentence: z.string(),
    queues: z.array(
      z.object({
        queue: z.string(),
        label: z.string(),
        href: z.string(),
        count: z.number(),
        items: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            detail: z.string().nullable(),
            when: z.string(),
            tone: z.string(),
          }),
        ),
        error: z.string().nullable(),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (_input, ctx) => {
    const read = currentWaitingReader();
    if (!read) {
      throw new Error(
        'Este proceso no tiene registrada la lectura de las colas de espera, así que no puedo ' +
          'decir qué te espera sin inventármelo. Se registra al arrancar la aplicación web ' +
          '(instrumentation-node.ts); desde un contenedor suelto esta pregunta no se puede ' +
          'contestar.',
      );
    }

    const index = await read(ctx.organizationId, ctx.userId);
    const unread = index.queues.filter((q) => q.error !== null);
    const shown = index.queues.reduce((n, q) => n + q.items.length, 0);

    return {
      total: index.total,
      sentence: index.sentence,
      queues: index.queues.map((queue) => ({
        queue: queue.queue,
        label: queue.label,
        href: queue.href,
        count: queue.count,
        items: queue.items.map((item) => ({
          id: item.id,
          title: item.title,
          detail: item.detail,
          when: item.when,
          tone: item.tone,
        })),
        error: queue.error,
      })),
      guidance: [
        index.sentence,
        shown > 0
          ? 'De cada cola vienen los dos o tres más urgentes, con su asunto real: nombra esos, no los conteos.'
          : '',
        index.total > shown && shown > 0
          ? 'El "count" de cada cola es el número exacto; los elementos son sólo una muestra.'
          : '',
        unread.length > 0
          ? `${unread.length} cola(s) no se pudieron leer y traen su motivo en "error": dilo, no las cuentes como vacías.`
          : '',
        'Las cuatro colas no se fusionan: cada una tiene su verbo, su pantalla y su forma. Para actuar sobre una, la herramienta de su familia (approvals.list, commitments.due_soon, actions.list, errands.status).',
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});
