import { describe, expect, it } from 'vitest';
import {
  type AnomalySource,
  arrivalsOf,
  collectAnomalias,
  detectDrop,
  detectStall,
  humanDuration,
} from './anomalies';
import { collectAll } from './collectors';

// Bogotá = UTC-5. Miércoles 2026-10-07 15:00 en Bogotá = 20:00 UTC.
const NOW = new Date('2026-10-07T20:00:00Z');

/** Llegadas cada `everyMin` minutos entre las `fromH` y `toH` (hora de Bogotá), en N días hacia atrás. */
function weekdayRows(opts: {
  days: number;
  fromH: number;
  toH: number;
  everyMin: number;
  until?: Date;
  perArrival?: number;
}): string[] {
  const out: string[] = [];
  for (let d = 0; d <= opts.days; d++) {
    const dayStart = new Date(NOW.getTime() - d * 86_400_000);
    const dow = new Date(dayStart.getTime() - 5 * 3_600_000).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const midnightBogota = Date.UTC(
      dayStart.getUTCFullYear(),
      dayStart.getUTCMonth(),
      dayStart.getUTCDate(),
      5,
    );
    // El día de Bogotá de `dayStart`: si son antes de las 05:00 UTC cae en el día anterior.
    const base = dayStart.getUTCHours() < 5 ? midnightBogota - 86_400_000 : midnightBogota;
    for (let m = opts.fromH * 60; m <= opts.toH * 60; m += opts.everyMin) {
      const t = base + m * 60_000;
      if (opts.until && t > opts.until.getTime()) continue;
      for (let i = 0; i < (opts.perArrival ?? 1); i++)
        out.push(new Date(t + i * 1000).toISOString());
    }
  }
  return out.sort().reverse();
}

describe('anomalías: fuente que se calla', () => {
  it('una hoja que llegaba cada 40 min y lleva 9 h callada en horario hábil, se marca', () => {
    // Ritmo: 06:00-16:00 cada 40 min. Hoy dejó de llegar a las 06:00 (9 h antes de las 15:00).
    const rows = weekdayRows({
      days: 12,
      fromH: 6,
      toH: 16,
      everyMin: 40,
      until: new Date('2026-10-07T11:00:00Z'),
    });
    const found = detectStall(rows, NOW);
    expect(found).not.toBeNull();
    expect(found?.usualMinutes).toBe(40);
    expect(found?.silentMinutes).toBeGreaterThanOrEqual(8 * 60);
  });

  it('llegando con normalidad no se marca nada', () => {
    const rows = weekdayRows({ days: 12, fromH: 6, toH: 16, everyMin: 40, until: NOW });
    expect(detectStall(rows, NOW)).toBeNull();
  });

  it('antes de que empiece su horario de siempre no se marca (la noche no es un silencio)', () => {
    // 06:10 de Bogotá: la última llegada fue ayer a las 16:00 (14 h), pero el horario empieza a las 06:00.
    const early = new Date('2026-10-07T11:10:00Z');
    const rows = weekdayRows({ days: 12, fromH: 6, toH: 16, everyMin: 40, until: early });
    expect(detectStall(rows, early)).toBeNull();
  });

  it('un domingo no se marca aunque no llegue nada', () => {
    const sunday = new Date('2026-10-11T17:00:00Z'); // domingo 12:00 Bogotá
    const rows = weekdayRows({ days: 12, fromH: 6, toH: 16, everyMin: 40, until: sunday });
    expect(detectStall(rows, sunday)).toBeNull();
  });

  it('sin historia suficiente no hay línea base y no se dice nada', () => {
    const rows = ['2026-10-06T15:00:00Z', '2026-10-06T16:00:00Z', '2026-10-06T17:00:00Z'];
    expect(detectStall(rows, NOW)).toBeNull();
  });

  it('un lote cuenta como una sola llegada', () => {
    const rows = [
      '2026-10-07T12:00:00Z',
      '2026-10-07T12:00:20Z',
      '2026-10-07T12:00:40Z',
      '2026-10-07T13:00:00Z',
    ];
    expect(arrivalsOf(rows)).toHaveLength(2);
  });
});

describe('anomalías: bajón de conteos diarios', () => {
  it('ayer trajo mucho menos de lo habitual: se marca', () => {
    // Hoy miércoles; ayer martes. Lunes a viernes anteriores: 40 filas/día; ayer sólo 4.
    const rows: string[] = [];
    for (let d = 2; d <= 14; d++) {
      const t = NOW.getTime() - d * 86_400_000;
      const dow = new Date(t - 5 * 3_600_000).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      for (let i = 0; i < 40; i++) rows.push(new Date(t - i * 60_000).toISOString());
    }
    for (let i = 0; i < 4; i++)
      rows.push(new Date(NOW.getTime() - 86_400_000 - i * 60_000).toISOString());
    const drop = detectDrop(rows, NOW);
    expect(drop).toMatchObject({ day: '2026-10-06', count: 4, usualCount: 40 });
  });

  it('una fuente chica (menos de 20 filas diarias) no dispara el bajón', () => {
    const rows: string[] = [];
    for (let d = 2; d <= 14; d++)
      for (let i = 0; i < 5; i++)
        rows.push(new Date(NOW.getTime() - d * 86_400_000 - i * 60_000).toISOString());
    expect(detectDrop(rows, NOW)).toBeNull();
  });
});

describe('anomalías: el colector', () => {
  const stalled: AnomalySource = {
    kind: 'table_sync',
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Despachos',
    rowTimes: weekdayRows({
      days: 12,
      fromH: 6,
      toH: 16,
      everyMin: 40,
      until: new Date('2026-10-07T11:00:00Z'),
    }),
  };

  it('dice la frase con horas y ritmo, y propone reintentar (seguro)', () => {
    const [item] = collectAnomalias([stalled], NOW);
    expect(item?.area).toBe('procesos');
    expect(item?.why).toMatch(
      /«Despachos» lleva \d+ h sin filas nuevas \(normalmente llegan cada 40 min\)/,
    );
    expect(item?.proposedAction).toEqual({
      toolId: 'trackers.retry_sync',
      input: { kind: 'table_sync', syncId: stalled.id },
    });
    expect(item?.effect).toBe('internal_write');
    expect(item?.risk).toBe('low');
  });

  it('sin fuentes o sin anomalías, nada', () => {
    expect(collectAnomalias(undefined, NOW)).toEqual([]);
    const ok: AnomalySource = {
      ...stalled,
      rowTimes: weekdayRows({ days: 12, fromH: 6, toH: 16, everyMin: 40, until: NOW }),
    };
    expect(collectAnomalias([ok], NOW)).toEqual([]);
  });

  it('entra al plan por collectAll sin tumbar a los demás', () => {
    const { items, errors } = collectAll({ today: '2026-10-07', anomalySources: [stalled] }, NOW);
    expect(errors).toEqual([]);
    expect(items.some((i) => i.dedupeKey.startsWith('anomalia:parada:table_sync:'))).toBe(true);
  });

  it('formatea duraciones', () => {
    expect(humanDuration(40)).toBe('40 min');
    expect(humanDuration(540)).toBe('9 h');
    expect(humanDuration(3 * 1440)).toBe('3 días');
  });
});
