import { listTools } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_OPENERS,
  FIRST_STEPS,
  GROUNDED_REQUIRES,
  OPENER_LIMIT,
  type OpenerSeeds,
  ageLabel,
  buildOpeners,
  dueLabel,
  longDate,
} from './chat-openers-shape';

/**
 * Lo que se prueba aquí es la SELECCIÓN, que es donde vive todo lo que puede
 * salir mal sin que nadie lo note en una captura de pantalla: una sugerencia
 * ofrecida a quien su equipo le bloqueó la herramienta, seis tarjetas del mismo
 * tema, un vencimiento dicho como una fecha ISO, y —la peor— una pantalla que
 * dice «este espacio está vacío» cuando lo que pasó es que la consulta falló.
 *
 * Nada de esto llama a un modelo, ni aquí ni en producción. `buildOpeners` es
 * una función pura sobre filas, que es justamente por lo que se puede probar
 * así de barato.
 */

/** Un espacio de trabajo sin nada, sobre el que cada prueba pone lo suyo. */
function seeds(over: Partial<OpenerSeeds> = {}): OpenerSeeds {
  return {
    today: '2026-08-13',
    orgName: null,
    documents: [],
    clients: [],
    commitments: [],
    vehicles: [],
    reports: [],
    flows: [],
    routineCount: 0,
    usableToolIds: [],
    connectedProviders: [],
    usedFamilies: [],
    failed: [],
    ...over,
  };
}

/** Todo lo que el catálogo puede pedir, para aislar el filtro cuando no toca. */
const ALL_TOOLS = [
  ...Object.values(GROUNDED_REQUIRES).flat(),
  ...CAPABILITY_OPENERS.flatMap((cap) => cap.requires),
];

// ---------------------------------------------------------------------------

describe('cómo se dicen las fechas', () => {
  it('cuenta los días en vez de escupir un ISO', () => {
    expect(dueLabel('2026-08-13', '2026-08-13')).toBe('se vence hoy');
    expect(dueLabel('2026-08-14', '2026-08-13')).toBe('se vence mañana');
    expect(dueLabel('2026-08-20', '2026-08-13')).toBe('se vence en 7 días');
  });

  it('un vencimiento que ya pasó se dice en pasado, no se esconde', () => {
    expect(dueLabel('2026-08-12', '2026-08-13')).toBe('se venció ayer');
    expect(dueLabel('2026-08-03', '2026-08-13')).toBe('se venció hace 10 días');
  });

  it('lejos deja de contar días y da la fecha', () => {
    expect(dueLabel('2026-10-14', '2026-08-13')).toBe('se vence el 14 de octubre');
    expect(longDate('2026-01-05')).toBe('5 de enero');
  });

  it('la antigüedad de un documento se dice en gordo', () => {
    const now = Date.parse('2026-08-13T15:00:00Z');
    expect(ageLabel('2026-08-13T09:00:00Z', now)).toBe('de hoy');
    expect(ageLabel('2026-08-12T09:00:00Z', now)).toBe('de ayer');
    expect(ageLabel('2026-08-08T09:00:00Z', now)).toBe('de hace 5 días');
  });
});

// ---------------------------------------------------------------------------

/**
 * La edad de un documento se calcula contra el RELOJ, no contra el `today` de
 * las semillas —`ageLabel` recibe `Date.now()`—, así que una fecha fija aquí es
 * una prueba con fecha de caducidad: pasa el día que se escribe y falla al
 * siguiente. Estas dos se cuentan hacia atrás desde ahora para que lo que se
 * afirma sea la frase y no el calendario.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe('un espacio con datos', () => {
  const full = seeds({
    orgName: 'Coltrans',
    usableToolIds: ALL_TOOLS,
    documents: [
      {
        id: 'd1',
        title: 'Contrato Coltrans 2026',
        createdAt: daysAgo(1),
        mediaKind: 'text',
      },
      {
        id: 'd2',
        title: 'Comité comercial del martes',
        createdAt: daysAgo(2),
        mediaKind: 'meeting',
      },
    ],
    clients: [
      { id: 'c1', name: 'Coltrans S.A.S.', city: 'Buenaventura' },
      { id: 'c2', name: 'Andina Cargo', city: null },
    ],
    commitments: [
      { id: 'v1', title: 'SOAT ABC123', dueOn: '2026-08-20', kind: 'soat', counterparty: null },
    ],
    vehicles: [{ id: 'p1', plate: 'ABC123', label: 'Camión rojo' }],
  });

  it('la primera tarjeta nombra el documento más reciente por su nombre real', () => {
    const out = buildOpeners(full);
    expect(out.blank).toBe(false);
    expect(out.openers[0]?.text).toContain('Contrato Coltrans 2026');
    expect(out.openers[0]?.kind).toBe('grounded');
    expect(out.openers[0]?.hint).toContain('de ayer');
  });

  it('una reunión no se pregunta como un contrato', () => {
    const out = buildOpeners(full);
    const meeting = out.openers.find((o) => o.text.includes('Comité comercial del martes'));
    expect(meeting?.text).toContain('¿En qué quedamos');
    expect(meeting?.icon).toBe('Mic');
  });

  it('nombra al cliente, la placa y el vencimiento con su fecha en palabras', () => {
    const texts = buildOpeners(full).openers.map((o) => o.text);
    expect(texts.some((t) => t.includes('Coltrans S.A.S.'))).toBe(true);
    expect(texts.some((t) => t.includes('ABC123'))).toBe(true);
    expect(texts.some((t) => t.includes('«SOAT ABC123» se vence en 7 días'))).toBe(true);
  });

  it('un vencimiento que ya pasó no se pregunta en futuro', () => {
    const vencido = buildOpeners(
      seeds({
        usableToolIds: ALL_TOOLS,
        connectedProviders: ['google'],
        commitments: [
          { id: 'v1', title: 'SOAT ABC123', dueOn: '2026-08-06', kind: 'soat', counterparty: null },
        ],
      }),
    );
    const card = vencido.openers.find((o) => o.text.includes('SOAT ABC123'));
    expect(card?.text).toContain('se venció hace 7 días');
    expect(card?.text).toContain('qué hago ahora');
    expect(card?.text).not.toContain('qué tengo que hacer antes');
    // Rojo, no ámbar: ya no es un aviso, es un problema.
    expect(card?.tone).toBe('rose');
  });

  it('reparte por temas antes de repetir uno: ninguna familia sale dos veces seguidas', () => {
    const icons = buildOpeners(full).openers.map((o) => o.icon);
    expect(icons.length).toBe(OPENER_LIMIT);
    for (let i = 1; i < icons.length; i++) expect(icons[i]).not.toBe(icons[i - 1]);
  });

  it('nunca pasa del tope, por muchos datos que haya', () => {
    expect(buildOpeners(full).openers.length).toBeLessThanOrEqual(OPENER_LIMIT);
    expect(buildOpeners(full, 3).openers.length).toBe(3);
  });

  it('todas las sugerencias son preguntas completas, listas para mandar', () => {
    for (const opener of buildOpeners(full).openers) {
      expect(opener.text.trim()).toBe(opener.text);
      expect(opener.text.length).toBeGreaterThan(20);
      expect(opener.text).not.toContain('{empresa}');
    }
  });

  it('los ids no se repiten — React los usa de llave', () => {
    const ids = buildOpeners(full).openers.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------

describe('un espacio recién creado', () => {
  it('lo dice y ofrece el primer paso, en vez de fingir seis ideas', () => {
    // Con TODAS las herramientas concedidas: un espacio nuevo casi siempre
    // puede ejecutar dos o tres que no dependen de nada, y dibujarlas sería
    // aparentar un producto en marcha.
    const out = buildOpeners(seeds({ usableToolIds: ALL_TOOLS }));
    expect(out.blank).toBe(true);
    expect(out.openers).toEqual([]);
    expect(out.firstSteps).toEqual(FIRST_STEPS);
    expect(out.notice).toBeNull();
  });

  it('el primer paso lleva a una pantalla, no a una frase de chat', () => {
    const out = buildOpeners(seeds({ usableToolIds: ALL_TOOLS }));
    expect(out.firstSteps[0]?.href).toBe('/integrations');
    for (const step of out.firstSteps) expect(step.href.startsWith('/')).toBe(true);
  });

  it('con una fuente conectada ya no está en blanco, aunque no haya filas', () => {
    const out = buildOpeners(seeds({ usableToolIds: ALL_TOOLS, connectedProviders: ['google'] }));
    expect(out.blank).toBe(false);
    expect(out.openers.length).toBeGreaterThan(0);
    expect(out.openers.every((o) => o.kind === 'capability')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('nunca ofrecer algo que va a fallar', () => {
  it('sin la integración conectada, la sugerencia que la necesita no existe', () => {
    const connected = buildOpeners(
      seeds({ usableToolIds: ALL_TOOLS, connectedProviders: ['google'] }),
    );
    expect(connected.openers.some((o) => o.id === 'cap:agenda')).toBe(true);

    // `usableToolIds` es lo que ya sale de `usableToolIds()` en
    // chat-palette-tools: sin Google conectado, `gcal.*` no está en la lista.
    const withoutGoogle = buildOpeners(
      seeds({
        usableToolIds: ALL_TOOLS.filter((id) => !id.startsWith('gcal.')),
        connectedProviders: ['slack'],
      }),
    );
    expect(withoutGoogle.openers.some((o) => o.id === 'cap:agenda')).toBe(false);
  });

  it('un cliente con `clients.overview` bloqueada no se ofrece, aunque exista', () => {
    const base = {
      clients: [{ id: 'c1', name: 'Coltrans S.A.S.', city: 'Cali' }],
      connectedProviders: ['google'],
    };
    expect(
      buildOpeners(seeds({ ...base, usableToolIds: ALL_TOOLS })).openers.some((o) =>
        o.text.includes('Coltrans S.A.S.'),
      ),
    ).toBe(true);
    expect(
      buildOpeners(
        seeds({
          ...base,
          usableToolIds: ALL_TOOLS.filter((id) => id !== 'clients.overview'),
        }),
      ).openers.some((o) => o.text.includes('Coltrans S.A.S.')),
    ).toBe(false);
  });

  it('sin herramienta ninguna, no se dibuja ni una sola tarjeta', () => {
    const out = buildOpeners(
      seeds({
        usableToolIds: [],
        connectedProviders: ['google'],
        documents: [
          { id: 'd1', title: 'Póliza 2026', createdAt: '2026-08-12T10:00:00Z', mediaKind: 'text' },
        ],
      }),
    );
    expect(out.openers).toEqual([]);
    expect(out.blank).toBe(false);
  });

  it('no propone el informe de vencimientos en un espacio sin un solo vencimiento', () => {
    const sin = buildOpeners(seeds({ usableToolIds: ALL_TOOLS, connectedProviders: ['google'] }));
    expect(sin.openers.some((o) => o.id === 'cap:report')).toBe(false);

    const con = buildOpeners(
      seeds({
        usableToolIds: ['reports.generate'],
        connectedProviders: ['google'],
        commitments: [
          { id: 'v1', title: 'Póliza', dueOn: '2026-09-01', kind: 'policy', counterparty: null },
        ],
      }),
    );
    expect(con.openers.some((o) => o.id === 'cap:report')).toBe(true);
  });

  it('no propone crear la primera rutina a quien ya tiene rutinas', () => {
    const virgen = buildOpeners(
      seeds({ usableToolIds: ['schedule.create'], connectedProviders: ['google'] }),
    );
    expect(virgen.openers.some((o) => o.id === 'cap:routine')).toBe(true);

    const conRutinas = buildOpeners(
      seeds({
        usableToolIds: ['schedule.create'],
        connectedProviders: ['google'],
        routineCount: 3,
      }),
    );
    expect(conRutinas.openers.some((o) => o.id === 'cap:routine')).toBe(false);
  });

  it('sin nombre de empresa no se ofrece la búsqueda que lo necesita', () => {
    const anónima = buildOpeners(
      seeds({ usableToolIds: ['web.search'], connectedProviders: ['google'] }),
    );
    expect(anónima.openers.some((o) => o.id === 'cap:market')).toBe(false);

    const conNombre = buildOpeners(
      seeds({ usableToolIds: ['web.search'], connectedProviders: ['google'], orgName: 'Coltrans' }),
    );
    expect(conNombre.openers[0]?.text).toContain('Coltrans');
  });
});

// ---------------------------------------------------------------------------

describe('lo que ya se usó pasa al final, no desaparece', () => {
  const base = {
    usableToolIds: ALL_TOOLS,
    connectedProviders: ['google'],
    orgName: 'Coltrans',
  };

  it('una capacidad sin estrenar se dibuja antes que una ya usada', () => {
    const dos = { ...base, usableToolIds: ['inbox.priorities', 'gcal.upcoming_meetings'] };
    // Sin historia, mandan el orden del catálogo.
    expect(buildOpeners(seeds(dos)).openers.map((o) => o.id)).toEqual(['cap:inbox', 'cap:agenda']);
    // Con la bandeja ya estrenada, la agenda se adelanta — y la bandeja sigue
    // ahí, porque quedaba hueco.
    expect(
      buildOpeners(seeds({ ...dos, usedFamilies: ['inbox'] })).openers.map((o) => o.id),
    ).toEqual(['cap:agenda', 'cap:inbox']);
  });

  it('pero una capacidad usada sigue apareciendo si hay hueco', () => {
    const usadas = CAPABILITY_OPENERS.flatMap((cap) => cap.requires).map(
      (id) => id.split('.')[0] as string,
    );
    const out = buildOpeners(seeds({ ...base, usedFamilies: usadas }));
    expect(out.openers.length).toBe(OPENER_LIMIT);
  });
});

// ---------------------------------------------------------------------------

describe('una consulta que falla no es un espacio vacío', () => {
  it('lo dice con todas las letras y NO dibuja la pantalla de bienvenida', () => {
    const out = buildOpeners(seeds({ usableToolIds: ALL_TOOLS, failed: ['los documentos'] }));
    expect(out.blank).toBe(false);
    expect(out.firstSteps).toEqual([]);
    expect(out.notice).toBe('No pude leer los documentos, así que puede que falten sugerencias.');
  });

  it('varias fallas se enumeran en una frase, no en una lista', () => {
    const out = buildOpeners(
      seeds({
        usableToolIds: ALL_TOOLS,
        failed: ['los documentos', 'los clientes', 'los vehículos'],
      }),
    );
    expect(out.notice).toBe(
      'No pude leer los documentos, los clientes y los vehículos, así que puede que falten sugerencias.',
    );
  });

  it('cuando todo se leyó bien no hay aviso', () => {
    expect(buildOpeners(seeds({ usableToolIds: ALL_TOOLS })).notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * El único desajuste que este archivo no puede detectar solo: una herramienta
 * renombrada deja una tarjeta que se dibuja y no se puede ejecutar, que es
 * exactamente la regla 3 rota en silencio.
 */
describe('las herramientas que se prometen existen de verdad', () => {
  const registered = new Set(listTools().map((tool) => tool.id));

  it('las de las sugerencias sembradas', () => {
    const orphans = Object.values(GROUNDED_REQUIRES)
      .flat()
      .filter((id) => !registered.has(id));
    expect(orphans).toEqual([]);
  });

  it('las del catálogo de capacidades', () => {
    const orphans = CAPABILITY_OPENERS.flatMap((cap) => cap.requires).filter(
      (id) => !registered.has(id),
    );
    expect(orphans).toEqual([]);
  });
});

/**
 * EL NOMBRE DEL ARCHIVO NO ES EL NOMBRE DE LA REUNIÓN.
 *
 * La primera tarjeta de la primera pantalla del producto decía, entera:
 * «¿En qué quedamos en "Grabación — Aug 12, 2026, 8:57 PM.webm"?». Tres
 * renglones, dos ocupados por lo que le puso el grabador — mes en inglés, hora
 * en formato de doce y la extensión del contenedor de vídeo.
 *
 * Lo que se defiende aquí es sobre todo el LÍMITE de ese arreglo: un título que
 * escribió una persona no se toca jamás. Sustituir «Acta comité de compras» por
 * «la reunión de ayer» sería tirar la única palabra que distingue una reunión
 * de otra, y eso es peor que el nombre feo que esto vino a quitar.
 */
describe('un nombre de archivo dicho como lo diría una persona', () => {
  const withDoc = (title: string, mediaKind: 'meeting' | 'text', days = 1) =>
    buildOpeners(
      seeds({
        usableToolIds: ALL_TOOLS,
        documents: [{ id: 'd1', title, createdAt: daysAgo(days), mediaKind }],
      }),
    ).openers[0];

  it('una grabación automática se nombra por cuándo fue, no por su archivo', () => {
    const card = withDoc('Grabación — Aug 12, 2026, 8:57 PM.webm', 'meeting');
    expect(card?.text).toContain('la reunión de ayer');
    expect(card?.text).not.toContain('.webm');
    expect(card?.text).not.toContain('Aug');
  });

  it('pero el archivo real no se pierde: baja a la procedencia', () => {
    const card = withDoc('Grabación — Aug 12, 2026, 8:57 PM.webm', 'meeting');
    expect(card?.hint).toContain('Grabación — Aug 12, 2026, 8:57 PM');
    expect(card?.hint).toContain('Brain Knowledge');
  });

  it('un título puesto a mano se respeta entero', () => {
    const card = withDoc('Acta comité de compras', 'meeting');
    expect(card?.text).toContain('«Acta comité de compras»');
    expect(card?.text).not.toContain('la reunión de');
  });

  it('la extensión se cae también en un documento normal', () => {
    const card = withDoc('Contrato Coltrans 2026.pdf', 'text');
    expect(card?.text).toContain('«Contrato Coltrans 2026»');
    expect(card?.text).not.toContain('.pdf');
  });

  it('sin edad que decir vale más el nombre feo que ninguno', () => {
    const out = buildOpeners(
      seeds({
        usableToolIds: ALL_TOOLS,
        documents: [
          {
            id: 'd1',
            title: 'Grabación 2026-08-13.webm',
            createdAt: 'no es una fecha',
            mediaKind: 'meeting',
          },
        ],
      }),
    );
    expect(out.openers[0]?.text).toContain('«Grabación 2026-08-13»');
  });
});
