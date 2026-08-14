import { describe, expect, it } from 'vitest';
import { STATIC_COMMAND_GROUP } from './chat-palette-shape';
import { type ToolAvailability, toolPaletteGroups, usableToolIds } from './chat-palette-tools';
import {
  DEFAULT_SHORTCUTS,
  MIN_SCORE,
  SHORTCUT_SLOTS,
  isSendable,
  matchShortcut,
  pickShortcuts,
  shortcutCandidates,
} from './chat-shortcuts';

/**
 * Las tres cosas que esta fila puede hacer mal y que no se ven en una captura:
 * ofrecer algo que este espacio de trabajo NO puede ejecutar, dejar de aprender
 * de quien lleva un mes usándola, y mandar media frase de un clic.
 */

const availability = (id: string, extra: Partial<ToolAvailability> = {}): ToolAvailability => ({
  id,
  providers: [],
  missingCredentials: [],
  blockingCredential: true,
  ...extra,
});

/** El camino real: catálogo → lo que este espacio puede correr → candidatos. */
function candidatesFor(
  tools: ToolAvailability[],
  access: { denied?: string[]; granted?: string[]; connected?: string[] } = {},
) {
  const ids = usableToolIds(tools, {
    denied: access.denied ?? [],
    granted: access.granted ?? ['*'],
    connectedProviders: new Set(access.connected ?? []),
  });
  return shortcutCandidates([STATIC_COMMAND_GROUP, ...toolPaletteGroups(ids)]);
}

const CATALOGUE = [
  availability('inbox.overview'),
  availability('approvals.list'),
  availability('payments.receivables'),
  availability('commitments.due_soon'),
  availability('errands.status'),
  availability('gcal.upcoming_meetings', { providers: ['google'] }),
  // Con complemento pendiente: «Busca en Gmail ». No es candidata a nada.
  availability('gmail.search', { providers: ['google'] }),
];

describe('isSendable', () => {
  it('una frase entera se puede mandar de un clic', () => {
    expect(isSendable('¿Cuánto nos deben?')).toBe(true);
  });

  it('una frase que espera un complemento, no', () => {
    // El espacio final es el vocabulario de TOOL_PHRASE para «falta el dato».
    expect(isSendable('Consulta la placa ')).toBe(false);
    expect(isSendable('')).toBe(false);
  });
});

describe('shortcutCandidates', () => {
  it('sólo deja frases enteras, y ninguna de las que piden un complemento', () => {
    const candidates = candidatesFor(CATALOGUE, { connected: ['google'] });
    expect(candidates.every((c) => isSendable(c.phrase))).toBe(true);
    expect(candidates.map((c) => c.id)).not.toContain('gmail.search');
    expect(candidates.map((c) => c.id)).toContain('payments.receivables');
  });

  it('un comando fijo se dice por lo que hace, no por su barra', () => {
    const candidates = candidatesFor([]);
    const vencimientos = candidates.find((c) => c.id === '/vencimientos');
    expect(vencimientos?.label).toBe('Qué se vence y cuándo');
    expect(vencimientos?.phrase).toBe(
      '¿Qué documentos y compromisos se vencen en los próximos 30 días?',
    );
  });

  it('descarta la etiqueta que no cabe en un chip', () => {
    const candidates = shortcutCandidates([
      {
        id: 'encargos',
        heading: 'Encargos',
        icon: 'Telescope',
        items: [
          {
            id: 'e1',
            label: 'Averíguame todo lo que puedas sobre la licitación de transporte escolar',
            hint: null,
            expands: '¿Cómo va el encargo?',
          },
        ],
      },
    ]);
    expect(candidates).toEqual([]);
  });
});

describe('pickShortcuts — sin uso todavía', () => {
  it('dibuja unos pocos por defecto, no el catálogo entero', () => {
    const candidates = candidatesFor(CATALOGUE, { connected: ['google'] });
    const picked = pickShortcuts(candidates, {});

    expect(picked).toHaveLength(SHORTCUT_SLOTS);
    expect(picked.length).toBeLessThan(candidates.length);
    // Y en el orden escrito, que es el orden que alguien argumentó.
    expect(picked.map((c) => c.id)).toEqual(
      DEFAULT_SHORTCUTS.filter((id) => candidates.some((c) => c.id === id)).slice(
        0,
        SHORTCUT_SLOTS,
      ),
    );
  });

  it('un candidato que nadie ha pedido nunca no ocupa un hueco libre', () => {
    // Sólo dos por defecto disponibles, y una tercera frase que no lo es.
    const candidates = candidatesFor([
      availability('inbox.overview'),
      availability('approvals.list'),
      availability('payroll.team_assignments'),
    ]);
    const picked = pickShortcuts(candidates, {});
    expect(picked.map((c) => c.id)).toEqual(['inbox.overview', '/vencimientos', 'approvals.list']);
  });
});

describe('pickShortcuts — con uso', () => {
  const candidates = candidatesFor(
    [...CATALOGUE, availability('payroll.team_assignments'), availability('vehicles.list')],
    { connected: ['google'] },
  );

  it('lo que se pide de verdad sube, incluso si no era de los por defecto', () => {
    const picked = pickShortcuts(candidates, {
      'payroll.team_assignments': 9,
      'vehicles.list': 4,
    });
    expect(picked[0]?.id).toBe('payroll.team_assignments');
    expect(picked[1]?.id).toBe('vehicles.list');
    // Los huecos que sobran siguen siendo de los por defecto.
    expect(picked.slice(2).every((c) => DEFAULT_SHORTCUTS.includes(c.id as never))).toBe(true);
    expect(picked).toHaveLength(SHORTCUT_SLOTS);
  });

  it('una petición suelta no reordena nada — hace falta repetición', () => {
    const once = pickShortcuts(candidates, { 'vehicles.list': MIN_SCORE - 0.6 });
    expect(once.map((c) => c.id)).toEqual(pickShortcuts(candidates, {}).map((c) => c.id));
  });

  it('nunca dibuja lo mismo dos veces', () => {
    const picked = pickShortcuts(candidates, { 'inbox.overview': 12 });
    expect(new Set(picked.map((c) => c.id)).size).toBe(picked.length);
    expect(picked[0]?.id).toBe('inbox.overview');
  });
});

describe('pickShortcuts — una herramienta que el espacio no puede ejecutar', () => {
  it('no se ofrece aunque sea de los por defecto', () => {
    // Google sin conectar: la agenda no existe para esta persona.
    const candidates = candidatesFor(CATALOGUE, { connected: [] });
    expect(candidates.map((c) => c.id)).not.toContain('gcal.upcoming_meetings');
    expect(pickShortcuts(candidates, {}).map((c) => c.id)).not.toContain('gcal.upcoming_meetings');
  });

  it('no se ofrece aunque sea LO MÁS PEDIDO — el uso no concede permisos', () => {
    // Se usó cien veces… y desde entonces el equipo bloqueó la cartera.
    const candidates = candidatesFor(CATALOGUE, {
      denied: ['payments.*'],
      connected: ['google'],
    });
    const picked = pickShortcuts(candidates, { 'payments.receivables': 100 });
    expect(picked.map((c) => c.id)).not.toContain('payments.receivables');
    expect(picked).toHaveLength(SHORTCUT_SLOTS);
  });
});

describe('matchShortcut', () => {
  const candidates = candidatesFor(CATALOGUE, { connected: ['google'] });

  it('reconoce la frase mandada venga del chip, del menú o de una tarjeta', () => {
    expect(matchShortcut('¿Cuánto nos deben?', candidates)).toBe('payments.receivables');
    expect(matchShortcut('  ¿cuanto nos deben?  ', candidates)).toBe('payments.receivables');
  });

  it('una pregunta retocada a mano ya no es la misma pregunta', () => {
    expect(matchShortcut('¿Cuánto nos deben en septiembre?', candidates)).toBeNull();
    expect(matchShortcut('', candidates)).toBeNull();
  });
});
