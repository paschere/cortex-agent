import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../types';
import { type WaitingIndexLike, inboxOverview, setWaitingReader } from '../overview';

/**
 * QUE ESTA HERRAMIENTA NO SEA EL CUARTO LECTOR DE LAS CUATRO COLAS.
 *
 * Ya hay tres sitios que saben filtrar aprobaciones, vencimientos, acciones y
 * encargos, y `nav-signals.ts` avisa en su propia cabecera de que duplicar esos
 * filtros ES EL RIESGO. Así que lo que se prueba aquí no es qué devuelve —eso
 * es de `waiting.ts`, que tiene sus pruebas— sino que este archivo NO SABE
 * NADA: el `db` del contexto es una trampa que estalla si alguien lo toca.
 *
 * Y la otra mitad: sin lector registrado no se inventa una respuesta vacía. Un
 * «no te espera nada» falso es peor que un error, porque se cree.
 */

const INDEX: WaitingIndexLike = {
  total: 4,
  sentence: 'Cuatro cosas te esperan y una lleva nueve días.',
  queues: [
    {
      queue: 'approvals',
      label: 'Aprobaciones',
      href: '/approvals',
      count: 1,
      items: [
        {
          id: 'a1',
          title: 'Agregar una fila a la hoja "NOMINA-2026-08"',
          detail: null,
          when: 'expira en 12 min',
          tone: 'amber',
        },
      ],
      error: null,
    },
    {
      queue: 'commitments',
      label: 'Vencimientos',
      href: '/commitments',
      count: 2,
      items: [
        {
          id: 'c1',
          title: 'SOAT ABC123',
          detail: 'SOAT · Coltrans',
          when: 'se venció hace doce días',
          tone: 'rose',
        },
      ],
      error: null,
    },
    {
      queue: 'actions',
      label: 'Acciones',
      href: '/actions',
      count: 1,
      items: [],
      error: 'No se pudo leer los correos redactados: la conexión se cayó',
    },
    { queue: 'errands', label: 'Encargos', href: '/errands', count: 0, items: [], error: null },
  ],
};

/** Un `db` que no se puede usar: cualquier acceso rompe la prueba. */
const TRAP = new Proxy(
  {},
  {
    get() {
      throw new Error(
        'inbox.overview tocó la base de datos. Tiene que leer por `waiting.ts` y no ' +
          'volver a filtrar las colas por su cuenta.',
      );
    },
  },
) as unknown as ToolContext['db'];

function ctx(): ToolContext {
  return {
    organizationId: 'org-a',
    userId: 'user-ana',
    agentId: 'agent-1',
    db: TRAP,
    integrations: {
      getAccessToken: async () => ({ token: '', scopes: [] }),
      hasScopes: async () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ToolContext['logger'],
  };
}

afterEach(() => setWaitingReader(null));

describe('inbox.overview', () => {
  it('lee por el índice de espera y no por la base de datos', async () => {
    let asked: [string, string] | null = null;
    setWaitingReader(async (organizationId, userId) => {
      asked = [organizationId, userId];
      return INDEX;
    });

    const out = await inboxOverview.handler({}, ctx());

    expect(asked).toEqual(['org-a', 'user-ana']);
    expect(out.total).toBe(4);
    // La frase viene escrita por `summarizeWaiting` y se pasa tal cual: es pura
    // y está probada caso por caso, así que reescribirla sólo podría empeorarla.
    expect(out.sentence).toBe(INDEX.sentence);
    expect(out.queues.map((q) => q.queue)).toEqual([
      'approvals',
      'commitments',
      'actions',
      'errands',
    ]);
    // El asunto real, que es lo que hace abrir la cola. Nunca un identificador.
    expect(out.queues[0]?.items[0]?.title).toContain('NOMINA-2026-08');
  });

  it('una cola que no se pudo leer se cuenta como no leída, no como vacía', async () => {
    setWaitingReader(async () => INDEX);
    const out = await inboxOverview.handler({}, ctx());

    const actions = out.queues.find((q) => q.queue === 'actions');
    expect(actions?.error).toContain('No se pudo leer');
    expect(out.guidance).toContain('1 cola(s) no se pudieron leer');
    expect(out.guidance).toContain(INDEX.sentence);
  });

  it('sin lector registrado se niega en vez de contestar que no hay nada', async () => {
    await expect(inboxOverview.handler({}, ctx())).rejects.toThrow(
      /no tiene registrada la lectura de las colas/,
    );
  });
});
