import { describe, expect, it } from 'vitest';
import {
  closedOnTime,
  cycleHours,
  isHoliday,
  isOpenAt,
  isOverdueAt,
  personStats,
  previousPeriod,
  teamBaselines,
  weekdaysIn,
  workingDaysFor,
} from './metrics';
import { ANDRES, AS_OF, PERIOD, PREVIOUS, at, item, team, workItems } from './metrics.fixtures';
import type { WorkPerson } from './types';

const ana: WorkPerson = { id: 'u-ana', name: 'Ana' };

describe('días trabajables', () => {
  it('lunes a domingo sin festivos son 5', () => {
    expect(workingDaysFor(ana, PREVIOUS)).toBe(5);
    expect(weekdaysIn('2026-09-21', '2026-09-27')).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ]);
  });

  it('descuenta el festivo del 12 oct 2026 (Día de la Raza, lunes)', () => {
    const week = { from: '2026-10-12', to: '2026-10-18' };
    expect(workingDaysFor(ana, week)).toBe(4);
    expect(workingDaysFor(ana, week, { holidays: false })).toBe(5);
  });

  it('conoce los festivos de Colombia 2025–2027 (fijos, Emiliani y Pascua)', () => {
    for (const day of [
      '2025-01-06', // Reyes, ya en lunes
      '2025-04-17', // Jueves Santo
      '2025-04-18', // Viernes Santo
      '2025-08-07', // Batalla de Boyacá
      '2026-01-12', // Reyes (6 ene, martes → lunes 12)
      '2026-10-12', // Día de la Raza
      '2026-12-08', // Inmaculada
      '2027-01-11', // Reyes (6 ene, miércoles → lunes 11)
      '2027-03-25', // Jueves Santo
      '2027-03-26', // Viernes Santo
      '2027-07-20', // Independencia
    ]) {
      expect(isHoliday(day), day).toBe(true);
    }
    expect(isHoliday('2026-10-13')).toBe(false);
    expect(isHoliday('2026-01-06')).toBe(false); // se corrió al lunes
  });

  it('descuenta días fuera sólo si eran trabajables (ni sábados ni festivos dos veces)', () => {
    const week = { from: '2026-10-12', to: '2026-10-18' };
    const away: WorkPerson = {
      ...ana,
      awayDays: ['2026-10-12', '2026-10-13', '2026-10-17', '2026-10-13T10:00:00-05:00'],
    };
    // 4 trabajables (festivo el 12) − 1 (el 13; el 12 ya era festivo, el 17 es sábado).
    expect(workingDaysFor(away, week)).toBe(3);
  });

  it('con `asOf` a mitad de semana, cuenta sólo hasta ese día', () => {
    expect(workingDaysFor(ana, PERIOD, { asOf: '2026-09-30' })).toBe(3);
    expect(workingDaysFor(ana, PERIOD, { asOf: AS_OF })).toBe(5);
    expect(workingDaysFor(ana, PERIOD, { asOf: '2026-09-20' })).toBe(0);
  });

  it('vacaciones toda la semana: 0 días, nada cuenta en contra', () => {
    const carlos = team().find((p) => p.name === 'Carlos Ruiz');
    expect(carlos).toBeDefined();
    if (carlos) expect(workingDaysFor(carlos, PERIOD, { asOf: AS_OF })).toBe(0);
  });
});

describe('períodos y bordes de semana', () => {
  it('el anterior es el del mismo largo inmediatamente antes', () => {
    expect(previousPeriod(PERIOD)).toEqual(PREVIOUS);
    expect(previousPeriod({ from: '2026-09-16', to: '2026-09-30' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-15',
    });
    expect(previousPeriod({ from: '2026-03-01', to: '2026-03-01' })).toEqual({
      from: '2026-02-28',
      to: '2026-02-28',
    });
  });

  it('un cierre del domingo a las 11:30 p. m. de Bogotá es de esa semana, no de la siguiente', () => {
    const sunday = item('x1', ana.id, 'despacho', at('2026-09-27', 9), {
      doneAt: '2026-09-28T04:30:00Z', // 27 sep 23:30 en Bogotá
    });
    const monday = item('x2', ana.id, 'despacho', at('2026-09-27', 9), {
      doneAt: '2026-09-28T05:00:00Z', // 28 sep 00:00 en Bogotá
    });
    const prev = personStats([sunday, monday], ana, PREVIOUS);
    const cur = personStats([sunday, monday], ana, PERIOD);
    expect(prev.done).toBe(1);
    expect(cur.done).toBe(1);
    // Al cierre de la semana anterior, el del lunes seguía abierto.
    expect(prev.openNow).toBe(1);
  });
});

describe('estado de un ítem en una fecha', () => {
  const base = item('i', ana.id, 'cobro', '2026-09-10', { dueAt: '2026-09-25' });

  it('vencido: abierto con vencimiento ANTES del día de corte', () => {
    expect(isOverdueAt(base, '2026-09-25')).toBe(false);
    expect(isOverdueAt(base, '2026-09-26')).toBe(true);
    expect(isOpenAt(base, '2026-09-09')).toBe(false);
  });

  it('cerrado después del corte cuenta como abierto en ese corte', () => {
    const done = { ...base, status: 'done' as const, doneAt: '2026-09-30T10:00:00-05:00' };
    expect(isOpenAt(done, '2026-09-27')).toBe(true);
    expect(isOpenAt(done, '2026-09-30')).toBe(false);
  });

  it('cancelado y hecho-sin-fecha no cuentan', () => {
    expect(isOpenAt({ ...base, status: 'cancelled' }, '2026-09-27')).toBe(false);
    expect(isOpenAt({ ...base, status: 'done', doneAt: null }, '2026-09-27')).toBe(false);
  });

  it('horas de ciclo: fecha sola es medianoche de Bogotá; instante sin zona, hora de Bogotá', () => {
    expect(cycleHours({ ...base, openedAt: '2026-09-10', doneAt: '2026-09-12' })).toBe(48);
    expect(
      cycleHours({ ...base, openedAt: '2026-09-10T08:00:00', doneAt: '2026-09-10T13:00:00Z' }),
    ).toBe(0);
    expect(
      cycleHours({ ...base, openedAt: '2026-09-10T08:00:00', doneAt: '2026-09-10T15:30:00Z' }),
    ).toBe(2.5);
    expect(cycleHours(base)).toBeNull();
  });

  it('a tiempo: el mismo día del vencimiento sí; al día siguiente no; sin fecha, no se mide', () => {
    expect(closedOnTime({ ...base, doneAt: '2026-09-25T23:00:00-05:00' })).toBe(true);
    expect(closedOnTime({ ...base, doneAt: '2026-09-26T00:30:00-05:00' })).toBe(false);
    expect(closedOnTime({ ...base, dueAt: null, doneAt: '2026-09-25' })).toBeNull();
  });
});

describe('personStats', () => {
  it('las cifras de Andrés en despachos esta semana', () => {
    const andres = team().find((p) => p.id === ANDRES) as WorkPerson;
    const s = personStats(workItems(), andres, PERIOD, 'despacho', { asOf: AS_OF });
    expect(s).toMatchObject({
      openNow: 3,
      overdueNow: 0,
      done: 10,
      onTimeRate: 1,
      medianCycleHours: 22,
      workingDays: 5,
      sample: 13,
      withDue: 10,
    });
    expect(s.output).toEqual({ guías: 265 });
  });

  it('sin vencimientos: tasa a tiempo nula (no cero) y base cero', () => {
    const items = [1, 2, 3].map((n) =>
      item(`c${n}`, ana.id, 'caso', at('2026-09-28', 8), { doneAt: at('2026-09-29', 8) }),
    );
    const s = personStats(items, ana, PERIOD);
    expect(s.onTimeRate).toBeNull();
    expect(s.withDue).toBe(0);
    expect(s.medianCycleHours).toBe(24);
  });

  it('a tiempo mezclado: sólo cuentan los que tenían fecha', () => {
    const items = [
      item('a', ana.id, 'cobro', '2026-09-20', { doneAt: '2026-09-29', dueAt: '2026-09-30' }),
      item('b', ana.id, 'cobro', '2026-09-20', { doneAt: '2026-09-29', dueAt: '2026-09-28' }),
      item('c', ana.id, 'cobro', '2026-09-20', { doneAt: '2026-09-29' }),
    ];
    const s = personStats(items, ana, PERIOD);
    expect(s.done).toBe(3);
    expect(s.withDue).toBe(2);
    expect(s.onTimeRate).toBe(0.5);
  });

  it('suma lo producido por unidad; sin unidad, «unidades»', () => {
    const items = [
      item('a', ana.id, 'cobro', '2026-09-20', {
        doneAt: '2026-09-29',
        quantity: 1_200_000,
        unit: 'COP',
      }),
      item('b', ana.id, 'cobro', '2026-09-20', {
        doneAt: '2026-09-30',
        quantity: 800_000,
        unit: 'COP',
      }),
      item('c', ana.id, 'cobro', '2026-09-20', { doneAt: '2026-09-30', quantity: 3 }),
      item('d', ana.id, 'cobro', '2026-09-20', { quantity: 99, unit: 'COP' }), // abierto
    ];
    expect(personStats(items, ana, PERIOD).output).toEqual({ COP: 2_000_000, unidades: 3 });
  });

  it('no cuenta lo de otros, lo cancelado ni otro tipo', () => {
    const items = [
      item('a', ana.id, 'cobro', '2026-09-20'),
      item('b', 'otra', 'cobro', '2026-09-20'),
      item('c', ana.id, 'cobro', '2026-09-20', { status: 'cancelled' }),
      item('d', ana.id, 'caso', '2026-09-20'),
    ];
    expect(personStats(items, ana, PERIOD, 'cobro').openNow).toBe(1);
    expect(personStats(items, ana, PERIOD, 'all').openNow).toBe(2);
  });
});

describe('teamBaselines', () => {
  it('mediana por tipo sólo entre quienes tuvieron ese trabajo; «all» primero', () => {
    const items = workItems();
    const stats = team().flatMap((p) =>
      ['all', 'despacho', 'cobro', 'caso', 'solicitud'].map((t) =>
        personStats(items, p, PERIOD, t, { asOf: AS_OF }),
      ),
    );
    const baselines = teamBaselines(stats);
    expect(baselines.map((b) => b.workType)).toEqual([
      'all',
      'caso',
      'cobro',
      'despacho',
      'solicitud',
    ]);
    const despacho = baselines.find((b) => b.workType === 'despacho');
    expect(despacho).toMatchObject({ people: 3, medianOpen: 4, medianDonePerDay: 2 });
    // Carlos (de vacaciones) está en cobros, pero sin días: no entra en cerrados por día.
    const cobro = baselines.find((b) => b.workType === 'cobro');
    expect(cobro).toMatchObject({ people: 2, medianOpen: 4, medianDonePerDay: 1 });
  });
});
