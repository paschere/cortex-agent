import { describe, expect, it } from 'vitest';
import { personStats, teamBaselines } from './metrics';
import {
  ANDRES,
  AS_OF,
  CARLOS,
  CUR_DAYS,
  JULIAN,
  LAURA,
  PERIOD,
  PREVIOUS,
  PREV_DAYS,
  SOFIA,
  VALENTINA,
  closed,
  item,
  team,
  workItems,
} from './metrics.fixtures';
import { buildTeamReport } from './report';
import { detectSignals } from './signals';
import type { WorkItem, WorkPerson, WorkSignal } from './types';

const report = () =>
  buildTeamReport({ items: workItems(), people: team(), period: PERIOD, asOf: AS_OF });

const find = (signals: WorkSignal[], kind: WorkSignal['kind'], personId?: string | null) =>
  signals.filter((s) => s.kind === kind && (personId === undefined || s.personId === personId));

/** Todo número escrito (leído a la colombiana y tal cual). */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const raw of text.match(/\d[\d.,]*\d|\d/g) ?? []) {
    out.push(Number(raw.replace(/\./g, '').replace(',', '.')));
    out.push(Number(raw.replace(/,/g, '')));
  }
  return out.filter(Number.isFinite);
}

/** Los números de la frase que NO están en la evidencia (vacío = bien fundada). */
function ungrounded(signal: WorkSignal): string[] {
  const numeric = Object.values(signal.evidence).filter((v): v is number => typeof v === 'number');
  const textual = Object.values(signal.evidence)
    .filter((v): v is string => typeof v === 'string')
    .flatMap(numbersIn);
  const known = [...numeric, ...textual];
  const missing: string[] = [];
  for (const text of [signal.message, signal.suggestion ?? '']) {
    for (const raw of text.match(/\d[\d.,]*\d|\d/g) ?? []) {
      const options = numbersIn(raw);
      if (!options.some((n) => known.some((k) => Math.abs(k - n) < 1e-9))) missing.push(raw);
    }
  }
  return missing;
}

/** Un equipo pequeño de despachos para casos puntuales. */
function crew(): WorkPerson[] {
  return [
    { id: 'a', name: 'Ana' },
    { id: 'b', name: 'Beto' },
    { id: 'c', name: 'Camila' },
  ];
}

function signalsFor(items: WorkItem[], people: WorkPerson[]): WorkSignal[] {
  return buildTeamReport({ items, people, period: PERIOD, asOf: AS_OF }).signals;
}

describe('las señales de Logística Andina', () => {
  it('Laura está sobrecargada: crítica, con a quién pasarle cuántos', () => {
    const [s] = find(report().signals, 'overloaded', LAURA);
    expect(s).toBeDefined();
    expect(s?.severity).toBe('critical');
    expect(s?.workType).toBe('despacho');
    expect(s?.message).toBe(
      'Laura Gómez tiene 16 despachos abiertos, 7 vencidos; la mediana del equipo en despachos es 4.',
    );
    expect(s?.suggestion).toBe(
      'Reasignar 5 a Andrés Restrepo (tiene 3 despachos pendientes) y 3 a Sofía Martínez (tiene 4).',
    );
    expect(s?.evidence).toMatchObject({ openNow: 16, reassign: 8, threshold: 9 });
    expect(s?.itemIds).toHaveLength(16);
    // Nadie más está sobrecargado.
    expect(find(report().signals, 'overloaded')).toHaveLength(1);
  });

  it('Carlos tiene vencidos mientras está de vacaciones: se pide cubrirlo, no se le reclama', () => {
    const [s] = find(report().signals, 'overdue_pile', CARLOS);
    expect(s?.severity).toBe('warn');
    expect(s?.message).toBe('Carlos Ruiz tiene 3 vencidos de 5 abiertos (60%), y hoy está fuera.');
    expect(s?.suggestion).toContain('Mientras Carlos Ruiz está fuera');
    expect(s?.itemIds).toEqual(['car-open-1', 'car-open-2', 'car-open-3']);
    // Sin días trabajables no hay «bajó»: las vacaciones no cuentan en contra.
    expect(find(report().signals, 'slowing', CARLOS)).toHaveLength(0);
  });

  it('Laura también tiene pila de vencidos (7 de 16)', () => {
    const [s] = find(report().signals, 'overdue_pile', LAURA);
    expect(s?.evidence).toMatchObject({ overdueNow: 7, openNow: 16, overduePct: 44 });
  });

  it('Julián bajó en casos: se pregunta, sin acusar', () => {
    const [s] = find(report().signals, 'slowing', JULIAN);
    expect(s?.severity).toBe('info');
    expect(s?.workType).toBe('caso');
    expect(s?.message).toContain('bajaron de 2 a 0,8 por día trabajable');
    expect(s?.message).toMatch(/¿Hay algo frenando a Julián Pérez\?$/);
    expect(s?.message).not.toMatch(/bajo rendimiento|malo|flojo|no rinde/i);
    // En cobros sigue igual: no hay señal de cobros.
    expect(find(report().signals, 'slowing').map((x) => x.workType)).toEqual(['caso']);
  });

  it('Sofía mejoró contra su propia historia (y no se repite como «destaca»)', () => {
    const [s] = find(report().signals, 'improving', SOFIA);
    expect(s?.workType).toBe('despacho');
    expect(s?.evidence).toMatchObject({
      donePerDayBefore: 1.6,
      donePerDayNow: 2.6,
      onTimePctBefore: 75,
      onTimePctNow: 100,
    });
    expect(find(report().signals, 'standout', SOFIA)).toHaveLength(0);
  });

  it('Valentina es nueva: ninguna comparación con ella', () => {
    const mine = report().signals.filter((s) => s.personId === VALENTINA);
    expect(mine).toEqual([]);
  });

  it('las 7 solicitudes sin responsable se reparten entre quienes las conocen', () => {
    const [s] = find(report().signals, 'unassigned_pile');
    expect(s?.message).toBe(
      'Hay 7 solicitudes sin responsable, 2 ya vencidas; la más vieja lleva 10 días abierta.',
    );
    expect(s?.suggestion).toBe(
      'Repartirlas: 4 a Andrés Restrepo (tiene 0 solicitudes pendientes) y 3 a Sofía Martínez (tiene 0).',
    );
    expect(s?.itemIds).toHaveLength(7);
  });

  it('lo quieto, por tipo, con los más quietos primero', () => {
    const stale = find(report().signals, 'stale_item');
    expect(stale.map((s) => s.workType)).toEqual(['cobro', 'despacho', 'solicitud']);
    const despacho = stale.find((s) => s.workType === 'despacho');
    expect(despacho?.message).toBe(
      '8 despachos llevan más de 48 horas sin moverse (cerrar uno suele tardar 24 horas); el más quieto, 17 días.',
    );
    expect(despacho?.itemIds?.[0]).toBe('lau-open-1');
    // Con movimiento reciente no es «quieto», aunque sea viejo.
    expect(despacho?.itemIds).not.toContain('lau-open-8');
    // Los casos de Julián tuvieron movimiento hoy: no aparecen.
    expect(stale.some((s) => s.workType === 'caso')).toBe(false);
  });

  it('el orden: gravedad, luego tipo de señal, luego persona', () => {
    const kinds = report().signals.map((s) => `${s.severity}:${s.kind}`);
    expect(kinds).toEqual([
      'critical:overloaded',
      'warn:overdue_pile',
      'warn:overdue_pile',
      'warn:unassigned_pile',
      'warn:stale_item',
      'warn:stale_item',
      'warn:stale_item',
      'info:slowing',
      'info:improving',
    ]);
  });

  it('cada señal trae su evidencia y una sugerencia', () => {
    for (const s of report().signals) {
      expect(s.message.length, s.kind).toBeGreaterThan(20);
      expect(Object.keys(s.evidence).length, s.kind).toBeGreaterThan(2);
      expect(s.suggestion, s.kind).toBeTruthy();
    }
  });

  it('cada número de cada frase está en su evidencia', () => {
    for (const s of report().signals) expect(ungrounded(s), s.message).toEqual([]);
  });
});

describe('reglas puntuales', () => {
  it('destaca contra la mediana del equipo sólo con muestra suficiente', () => {
    const items = [
      ...closed('a', 'a', 'despacho', CUR_DAYS, 15, { cycleHours: 10 }),
      ...closed('b', 'b', 'despacho', CUR_DAYS, 6, { cycleHours: 20 }),
      ...closed('c', 'c', 'despacho', CUR_DAYS, 5, { cycleHours: 20 }),
    ];
    const signals = signalsFor(items, crew());
    const [s] = find(signals, 'standout', 'a');
    expect(s?.message).toBe(
      'Ana cerró 3 despachos por día trabajable (15 en total); la mediana del equipo es 1,2, con 100% a tiempo.',
    );
    expect(ungrounded(s as WorkSignal)).toEqual([]);

    // Con 7 cerrados no se destaca a nadie: muestra chica.
    const few = [
      ...closed('a', 'a', 'despacho', CUR_DAYS, 7, { cycleHours: 10 }),
      ...closed('b', 'b', 'despacho', CUR_DAYS, 2, { cycleHours: 20 }),
      ...closed('c', 'c', 'despacho', CUR_DAYS, 2, { cycleHours: 20 }),
    ];
    expect(find(signalsFor(few, crew()), 'standout')).toHaveLength(0);
  });

  it('no destaca más cerrados si a tiempo quedó por debajo del equipo', () => {
    const items = [
      ...closed('a', 'a', 'despacho', CUR_DAYS, 15, { cycleHours: 10, late: 8 }),
      ...closed('b', 'b', 'despacho', CUR_DAYS, 6, { cycleHours: 20 }),
      ...closed('c', 'c', 'despacho', CUR_DAYS, 5, { cycleHours: 20 }),
    ];
    expect(find(signalsFor(items, crew()), 'standout')).toHaveLength(0);
  });

  it('«bajó» necesita ≥ 8 cerrados antes y algo esperando', () => {
    const seven = [
      ...closed('p', 'a', 'caso', PREV_DAYS, 7, { cycleHours: 5 }),
      ...closed('n', 'a', 'caso', CUR_DAYS, 1, { cycleHours: 5 }),
      item('o', 'a', 'caso', '2026-10-01'),
    ];
    expect(find(signalsFor(seven, crew()), 'slowing')).toHaveLength(0);

    const nothingWaiting = [
      ...closed('p', 'a', 'caso', PREV_DAYS, 10, { cycleHours: 5 }),
      ...closed('n', 'a', 'caso', CUR_DAYS, 2, { cycleHours: 5 }),
    ];
    expect(find(signalsFor(nothingWaiting, crew()), 'slowing')).toHaveLength(0);

    const waiting = [...nothingWaiting, item('o', 'a', 'caso', '2026-10-01')];
    expect(find(signalsFor(waiting, crew()), 'slowing')).toHaveLength(1);
  });

  it('los días fuera se descuentan antes de comparar por día', () => {
    // 10 en 5 días antes; 4 en 2 días ahora (3 de vacaciones) = 2 por día: igual.
    const items = [
      ...closed('p', 'a', 'caso', PREV_DAYS, 10, { cycleHours: 5 }),
      ...closed('n', 'a', 'caso', ['2026-10-01', '2026-10-02'], 4, { cycleHours: 5 }),
      item('o', 'a', 'caso', '2026-10-01'),
    ];
    const people = crew().map((p) =>
      p.id === 'a' ? { ...p, awayDays: ['2026-09-28', '2026-09-29', '2026-09-30'] } : p,
    );
    // Con 2 días trabajables tampoco se compara (mínimo 3).
    expect(find(signalsFor(items, people), 'slowing')).toHaveLength(0);
    const r = buildTeamReport({ items, people, period: PERIOD, asOf: AS_OF });
    expect(r.people.find((e) => e.person.id === 'a')?.current.workingDays).toBe(2);
  });

  it('sobrecarga: el piso de «mediana + 5» evita alarmas con números chicos', () => {
    const items = [
      item('a1', 'a', 'cobro', '2026-09-30'),
      item('a2', 'a', 'cobro', '2026-09-30'),
      item('a3', 'a', 'cobro', '2026-09-30'),
      item('a4', 'a', 'cobro', '2026-09-30'),
      item('b1', 'b', 'cobro', '2026-09-30'),
      item('c1', 'c', 'cobro', '2026-09-30'),
    ];
    // 4 abiertos contra mediana 1: el doble sí, pero no llega a 1 + 5.
    expect(find(signalsFor(items, crew()), 'overloaded')).toHaveLength(0);
  });

  it('pila de vencidos por proporción: 3 de 5 sí, 2 de 2 no', () => {
    const mk = (id: string, who: string, due: string | null) =>
      item(id, who, 'cobro', '2026-09-01', { dueAt: due });
    const items = [
      mk('a1', 'a', '2026-09-20'),
      mk('a2', 'a', '2026-09-20'),
      mk('a3', 'a', '2026-09-20'),
      mk('a4', 'a', '2026-10-20'),
      mk('a5', 'a', null),
      mk('b1', 'b', '2026-09-20'),
      mk('b2', 'b', '2026-09-20'),
    ];
    const piles = find(signalsFor(items, crew()), 'overdue_pile');
    expect(piles.map((s) => s.personId)).toEqual(['a']);
  });

  it('con 4 sin responsable no hay pila; con 5 sí', () => {
    const pile = (n: number) =>
      Array.from({ length: n }, (_, k) => item(`s${k}`, null, 'solicitud', '2026-09-30'));
    expect(find(signalsFor(pile(4), crew()), 'unassigned_pile')).toHaveLength(0);
    const [s] = find(signalsFor(pile(5), crew()), 'unassigned_pile');
    // Nadie del equipo ha tenido solicitudes: no se inventa a quién.
    expect(s?.suggestion).toBe(
      'Nadie en el equipo ha tenido solicitudes: definir quién responde por ellas.',
    );
  });

  it('sin cifras no hay señales', () => {
    expect(
      detectSignals({ current: [], previous: [], baselines: [], items: [], people: [] }),
    ).toEqual([]);
  });

  it('detectSignals también se puede llamar sin el reporte', () => {
    const items = workItems();
    const people = team();
    const types = ['despacho', 'cobro', 'caso', 'solicitud'];
    const cur = people.flatMap((p) =>
      ['all', ...types].map((t) => personStats(items, p, PERIOD, t, { asOf: AS_OF })),
    );
    const prev = people.flatMap((p) =>
      ['all', ...types].map((t) => personStats(items, p, PREVIOUS, t)),
    );
    const signals = detectSignals({
      current: cur,
      previous: prev,
      baselines: teamBaselines(cur),
      items,
      people,
      asOf: AS_OF,
    });
    expect(signals).toEqual(report().signals);
    expect(find(signals, 'overloaded', ANDRES)).toHaveLength(0);
  });
});
