import { describe, expect, it } from 'vitest';
import {
  MIN_CLOSED_FOR_RATE,
  type PersonCommitment,
  RECORD_WINDOW_DAYS,
  UNASSIGNED_KEY,
  buildPeopleLoad,
  metOnTime,
} from './people';
import { nudge, recordPhrase, recordTone, tallyPhrase } from './wording';

/**
 * La vista por persona, sin base de datos y sin modelo.
 *
 * NADA AQUÍ LLAMA A ANTHROPIC NI PODRÍA: `buildPeopleLoad` es una función pura
 * que recibe filas y un día y devuelve el modelo de la pantalla. Ese es el
 * motivo de que esté separada del componente — el agrupado, el orden y el
 * cumplimiento son las tres cosas que se pueden equivocar en silencio, y las
 * tres se comprueban aquí con aritmética.
 *
 * `TODAY` es un jueves de agosto y todas las fechas del archivo se leen contra
 * él. Ninguna prueba usa `new Date()`: una suite que depende de cuándo se
 * ejecuta es una suite que un día falla sola.
 */

const TODAY = '2026-08-13';

let seq = 0;

function row(over: Partial<PersonCommitment> = {}): PersonCommitment {
  seq += 1;
  return {
    id: `c${seq}`,
    title: `Compromiso ${seq}`,
    kind: 'soat',
    due_on: '2026-09-30',
    notice_days: 30,
    state: 'in_force',
    met_at: null,
    owner_user_id: 'u-ana',
    owner_name: 'Ana Gómez',
    ...over,
  };
}

/** Una promesa entre personas: lo que dijo alguien, no un papel que vence. */
function promise(over: Partial<PersonCommitment> = {}): PersonCommitment {
  return row({ kind: 'internal', notice_days: 1, ...over });
}

/** Un instante UTC a partir de un día de Bogotá y una hora local. */
function bogota(day: string, hour = 10): string {
  return `${day}T${String(hour).padStart(2, '0')}:00:00-05:00`;
}

// ---------------------------------------------------------------------------
// Agrupado
// ---------------------------------------------------------------------------

describe('buildPeopleLoad · el nombre como fila', () => {
  it('junta lo de cada persona bajo su nombre real, no bajo su uuid', () => {
    const load = buildPeopleLoad({
      open: [
        promise({ owner_user_id: 'u-ana', owner_name: 'Ana Gómez', due_on: '2026-08-20' }),
        row({ owner_user_id: 'u-ana', owner_name: 'Ana Gómez', due_on: '2026-08-25' }),
        row({ owner_user_id: 'u-carlos', owner_name: 'Carlos Ruiz', due_on: '2026-08-30' }),
      ],
      closed: [],
      today: TODAY,
    });

    expect(load.pending.map((p) => p.name)).toEqual(['Ana Gómez', 'Carlos Ruiz']);
    expect(load.pending[0]?.key).toBe('u-ana');
    expect(load.pending[0]?.items).toHaveLength(2);
  });

  it('NO suma promesas con papeles: son dos cuentas y se quedan aparte', () => {
    // La regla que da sentido a la pantalla. «Ana: 3 cosas» no distingue entre
    // tres promesas sin cumplir y las pólizas de la flota a su nombre.
    const load = buildPeopleLoad({
      open: [
        promise({ due_on: '2026-08-10' }),
        row({ kind: 'soat', due_on: '2026-08-01' }),
        row({ kind: 'policy', due_on: '2026-09-01' }),
      ],
      closed: [],
      today: TODAY,
    });

    const ana = load.pending[0];
    expect(ana?.promises).toEqual({ open: 1, overdue: 1 });
    expect(ana?.papers).toEqual({ open: 2, overdue: 1 });
    expect(ana?.items).toHaveLength(3);
  });

  it('lo que no tiene responsable va a su propia fila y siempre de última', () => {
    const load = buildPeopleLoad({
      open: [
        // Cuatro vencidos sin dueño contra uno de Carlos: aun así Carlos va
        // primero, porque a una fila sin nombre no se le puede preguntar nada.
        row({ owner_user_id: null, owner_name: null, due_on: '2026-07-01' }),
        row({ owner_user_id: null, owner_name: null, due_on: '2026-07-02' }),
        row({ owner_user_id: null, owner_name: null, due_on: '2026-07-03' }),
        row({ owner_user_id: null, owner_name: null, due_on: '2026-07-04' }),
        row({ owner_user_id: 'u-carlos', owner_name: 'Carlos Ruiz', due_on: '2026-08-01' }),
      ],
      closed: [],
      today: TODAY,
    });

    expect(load.pending.map((p) => p.key)).toEqual(['u-carlos', UNASSIGNED_KEY]);
    expect(load.pending.at(-1)?.unassigned).toBe(true);
    expect(load.pending.at(-1)?.name).toBe('Sin responsable');
  });

  it('nombra a la cuenta borrada en vez de imprimir un uuid', () => {
    const load = buildPeopleLoad({
      open: [row({ owner_user_id: 'u-fantasma', owner_name: null, due_on: '2026-08-01' })],
      closed: [],
      today: TODAY,
    });
    expect(load.pending[0]?.name).toBe('Alguien que ya no está');
    expect(load.pending[0]?.unassigned).toBe(false);
  });

  it('no cuenta lo cumplido ni lo descartado como carga abierta', () => {
    const load = buildPeopleLoad({
      open: [
        row({ state: 'met', met_at: bogota('2026-08-01'), due_on: '2026-08-02' }),
        row({ state: 'dropped', due_on: '2026-08-02' }),
      ],
      closed: [],
      today: TODAY,
    });
    expect(load.pending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orden
// ---------------------------------------------------------------------------

describe('buildPeopleLoad · quién tiene más encima', () => {
  it('ordena por atrasos, no alfabéticamente', () => {
    const load = buildPeopleLoad({
      open: [
        row({ owner_user_id: 'u-ana', owner_name: 'Ana Gómez', due_on: '2026-09-30' }),
        row({ owner_user_id: 'u-zoe', owner_name: 'Zoe Prada', due_on: '2026-08-01' }),
        row({ owner_user_id: 'u-zoe', owner_name: 'Zoe Prada', due_on: '2026-08-02' }),
      ],
      closed: [],
      today: TODAY,
    });

    expect(load.pending.map((p) => p.name)).toEqual(['Zoe Prada', 'Ana Gómez']);
  });

  it('empatados en atrasos, arriba quien tiene la fecha más cerca', () => {
    const load = buildPeopleLoad({
      open: [
        row({ owner_user_id: 'u-ana', owner_name: 'Ana Gómez', due_on: '2026-08-30' }),
        row({ owner_user_id: 'u-beto', owner_name: 'Beto Salas', due_on: '2026-08-14' }),
      ],
      closed: [],
      today: TODAY,
    });

    expect(load.pending.map((p) => p.name)).toEqual(['Beto Salas', 'Ana Gómez']);
  });

  it('dentro de una persona, lo más vencido primero y luego lo más próximo', () => {
    const load = buildPeopleLoad({
      open: [
        row({ title: 'En dos semanas', due_on: '2026-08-27' }),
        row({ title: 'Vencido hace mucho', due_on: '2026-06-01' }),
        row({ title: 'Es hoy', due_on: TODAY }),
      ],
      closed: [],
      today: TODAY,
    });

    expect(load.pending[0]?.items.map((i) => i.title)).toEqual([
      'Vencido hace mucho',
      'Es hoy',
      'En dos semanas',
    ]);
    // `items[0]` es lo que la pantalla imprime como «Lo primero».
    expect(load.pending[0]?.items[0]?.daysLeft).toBeLessThan(0);
    expect(load.pending[0]?.items[0]?.state).toBe('overdue');
  });

  it('marca la promesa como promesa dentro de la fila', () => {
    const load = buildPeopleLoad({
      open: [promise({ title: 'Mandar el informe', due_on: '2026-08-14' })],
      closed: [],
      today: TODAY,
    });
    const item = load.pending[0]?.items[0];
    expect(item?.internal).toBe(true);
    expect(item?.kindLabel).toBe('Compromiso interno');
    // notice_days 1 ⇒ mañana ya está dentro de la ventana de aviso.
    expect(item?.state).toBe('due_soon');
  });
});

// ---------------------------------------------------------------------------
// Cumplimiento
// ---------------------------------------------------------------------------

describe('metOnTime · a tiempo se mide en días de Bogotá', () => {
  it('cumplido antes de la fecha es a tiempo', () => {
    expect(metOnTime({ met_at: bogota('2026-08-10'), due_on: '2026-08-12' })).toBe(true);
  });

  it('cumplido el mismo día es a tiempo, aunque sean las ocho de la noche', () => {
    // 20:00 en Bogotá ya es el día siguiente en UTC. Comparar el instante crudo
    // contra `due_on` haría llegar tarde, todas las noches y en silencio, a
    // quien entregó a tiempo.
    expect(metOnTime({ met_at: bogota('2026-08-12', 20), due_on: '2026-08-12' })).toBe(true);
  });

  it('cumplido al día siguiente es tarde', () => {
    expect(metOnTime({ met_at: bogota('2026-08-13', 8), due_on: '2026-08-12' })).toBe(false);
  });

  it('sin fecha de cumplido no dice ni sí ni no', () => {
    // `null` es «no se sabe», que no es lo mismo que «tarde». Una fila así no
    // entra en el cálculo en vez de contar contra la persona.
    expect(metOnTime({ met_at: null, due_on: '2026-08-12' })).toBeNull();
    expect(metOnTime({ met_at: 'no es una fecha', due_on: '2026-08-12' })).toBeNull();
  });
});

describe('buildPeopleLoad · quién cumple', () => {
  const closedPromises = (results: Array<{ due: string; met: string }>) =>
    results.map((r) => promise({ state: 'met', due_on: r.due, met_at: bogota(r.met) }));

  it('cuenta ocho de nueve a tiempo, que es la frase que hacía falta', () => {
    const closed = [
      ...closedPromises(
        Array.from({ length: 8 }, (_, i) => ({
          due: `2026-08-${String(i + 1).padStart(2, '0')}`,
          met: `2026-08-${String(i + 1).padStart(2, '0')}`,
        })),
      ),
      ...closedPromises([{ due: '2026-08-09', met: '2026-08-11' }]),
    ];

    const load = buildPeopleLoad({ open: [], closed, today: TODAY });
    const ana = load.clear[0];

    expect(ana?.promiseRecord.closed).toBe(9);
    expect(ana?.promiseRecord.onTime).toBe(8);
    expect(ana?.promiseRecord.rate).toBeCloseTo(8 / 9, 5);
    expect(recordPhrase(ana?.promiseRecord ?? { closed: 0, onTime: 0, rate: null })).toBe(
      '8 de 9 a tiempo',
    );
    expect(load.closedInWindow).toBe(9);
  });

  it('lleva el historial de promesas aparte del de papeles', () => {
    const load = buildPeopleLoad({
      open: [],
      closed: [
        ...closedPromises([
          { due: '2026-08-01', met: '2026-08-05' },
          { due: '2026-08-02', met: '2026-08-06' },
          { due: '2026-08-03', met: '2026-08-07' },
        ]),
        row({ kind: 'soat', state: 'met', due_on: '2026-08-01', met_at: bogota('2026-07-30') }),
        row({ kind: 'soat', state: 'met', due_on: '2026-08-02', met_at: bogota('2026-07-31') }),
        row({ kind: 'soat', state: 'met', due_on: '2026-08-03', met_at: bogota('2026-08-01') }),
      ],
      today: TODAY,
    });

    const ana = load.clear[0];
    expect(ana?.promiseRecord).toEqual({ closed: 3, onTime: 0, rate: 0 });
    expect(ana?.paperRecord).toEqual({ closed: 3, onTime: 3, rate: 1 });
  });

  it('no da porcentaje con poco historial: dice que todavía no sabe', () => {
    const load = buildPeopleLoad({
      open: [],
      closed: closedPromises([{ due: '2026-08-01', met: '2026-08-05' }]),
      today: TODAY,
    });

    const record = load.clear[0]?.promiseRecord;
    expect(MIN_CLOSED_FOR_RATE).toBeGreaterThan(1);
    expect(record?.closed).toBe(1);
    expect(record?.rate).toBeNull();
    expect(recordPhrase(record ?? { closed: 0, onTime: 0, rate: null })).toBe(
      'cerró 1, todavía es pronto para una cifra',
    );
  });

  it('olvida lo que se cerró antes de la ventana', () => {
    const old = '2025-01-15';
    const load = buildPeopleLoad({
      open: [],
      closed: [
        ...closedPromises([
          { due: '2026-08-01', met: '2026-08-01' },
          { due: '2026-08-02', met: '2026-08-02' },
          { due: '2026-08-03', met: '2026-08-03' },
        ]),
        // Una entrega tarde de hace más de medio año: ya no define a nadie.
        promise({ state: 'met', due_on: '2025-01-01', met_at: bogota(old) }),
      ],
      today: TODAY,
    });

    expect(RECORD_WINDOW_DAYS).toBe(180);
    expect(load.clear[0]?.promiseRecord).toEqual({ closed: 3, onTime: 3, rate: 1 });
    expect(load.closedInWindow).toBe(3);
  });

  it('lo descartado no cuenta como incumplido', () => {
    // Descartar es mantener la lista limpia. Contarlo contra la persona
    // enseñaría a no descartar nunca nada.
    const load = buildPeopleLoad({
      open: [],
      closed: [
        ...closedPromises([
          { due: '2026-08-01', met: '2026-08-01' },
          { due: '2026-08-02', met: '2026-08-02' },
          { due: '2026-08-03', met: '2026-08-03' },
        ]),
        promise({ state: 'dropped', due_on: '2026-07-01', met_at: null }),
      ],
      today: TODAY,
    });

    expect(load.clear[0]?.promiseRecord).toEqual({ closed: 3, onTime: 3, rate: 1 });
  });
});

// ---------------------------------------------------------------------------
// Quién sale y quién no
// ---------------------------------------------------------------------------

describe('buildPeopleLoad · a quién se enseña sin nada pendiente', () => {
  it('deja fuera a quien no tiene nada Y tampoco tiene historial', () => {
    // Una lista donde todo el mundo sale en verde entrena a no mirarla, y un
    // nombre con dos ceros al lado no distingue a quien cumple de quien nunca
    // ha tenido nada asignado.
    const load = buildPeopleLoad({
      open: [],
      closed: [row({ state: 'met', met_at: null, due_on: '2026-08-01' })],
      today: TODAY,
    });
    expect(load.pending).toEqual([]);
    expect(load.clear).toEqual([]);
  });

  it('saca en «al día» a quien cerró cosas y no tiene nada abierto', () => {
    const load = buildPeopleLoad({
      open: [row({ owner_user_id: 'u-zoe', owner_name: 'Zoe Prada', due_on: '2026-08-20' })],
      closed: [
        row({
          owner_user_id: 'u-ana',
          owner_name: 'Ana Gómez',
          state: 'met',
          met_at: bogota('2026-08-01'),
          due_on: '2026-08-02',
        }),
      ],
      today: TODAY,
    });

    expect(load.pending.map((p) => p.name)).toEqual(['Zoe Prada']);
    expect(load.clear.map((p) => p.name)).toEqual(['Ana Gómez']);
  });

  it('quien tiene algo abierto sale en la lista de arriba, aunque tenga historial', () => {
    const load = buildPeopleLoad({
      open: [row({ due_on: '2026-08-20' })],
      closed: [row({ state: 'met', met_at: bogota('2026-08-01'), due_on: '2026-08-02' })],
      today: TODAY,
    });

    expect(load.pending.map((p) => p.name)).toEqual(['Ana Gómez']);
    expect(load.clear).toEqual([]);
    expect(load.pending[0]?.paperRecord.closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cómo se dice
// ---------------------------------------------------------------------------

describe('wording · la pantalla dice quién no cumplió sin sonar a expediente', () => {
  it('cuenta lo cumplido, nunca lo fallado', () => {
    expect(recordPhrase({ closed: 9, onTime: 8, rate: 8 / 9 })).toBe('8 de 9 a tiempo');
    expect(recordPhrase({ closed: 4, onTime: 1, rate: 0.25 })).toBe('1 de 4 a tiempo');
  });

  it('no dice nada de quien no ha cerrado nada, en vez de escribir un cero', () => {
    expect(recordPhrase({ closed: 0, onTime: 0, rate: null })).toBeNull();
  });

  it('NUNCA pinta a una persona de rojo', () => {
    // El rojo de este producto significa «esta fecha pasó», que es un hecho.
    // Sobre un nombre significaría otra cosa. Ni el peor historial lo cruza.
    for (const rate of [0, 0.1, 0.25, 0.49, 0.5, 0.79, 0.8, 1]) {
      expect(recordTone({ closed: 10, onTime: Math.round(rate * 10), rate })).not.toBe('rose');
    }
    expect(recordTone({ closed: 10, onTime: 0, rate: 0 })).toBe('amber');
    expect(recordTone({ closed: 10, onTime: 9, rate: 0.9 })).toBe('emerald');
    expect(recordTone({ closed: 2, onTime: 0, rate: null })).toBe('neutral');
  });

  it('las promesas se atrasan y los papeles se vencen, hasta en el adjetivo', () => {
    expect(tallyPhrase({ open: 2, overdue: 1 }, 'promise')).toBe('2 promesas, 1 atrasada');
    expect(tallyPhrase({ open: 3, overdue: 2 }, 'paper')).toBe(
      '3 vencimientos a su nombre, 2 vencidos',
    );
    expect(tallyPhrase({ open: 1, overdue: 0 }, 'promise')).toBe('1 promesa');
    expect(tallyPhrase({ open: 0, overdue: 0 }, 'paper')).toBeNull();
  });

  it('lo que sigue a un atraso es una pregunta, no un reproche', () => {
    const line = nudge({ open: 2, overdue: 1 }, { open: 0, overdue: 0 });
    expect(line).toContain('preguntar');
    for (const word of ['incumpl', 'falló', 'falla', 'responsable de']) {
      expect(line.toLowerCase()).not.toContain(word);
    }
  });
});
