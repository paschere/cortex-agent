import { describe, expect, it } from 'vitest';
import { type ViewSource, computeView, goalStatus, weekdayHour } from './compute';
import {
  digestSince,
  digestSlotStart,
  isDigestDue,
  selectDueDigests,
  summarizeSources,
} from './digest';
import { viewExportFilename, viewExportSheets } from './export';
import { type CatalogTracker, type ViewDigest, checkSpecAgainst, viewSpecSchema } from './spec';

/**
 * Embudo, mapa de calor, meta con semáforo, resumen periódico y exportación:
 * lo que importa es el orden de las etapas, la zona horaria de Bogotá, los
 * umbrales del semáforo y que «toca enviar» no mande dos veces ni a quien no
 * debe.
 */

const pipeline: CatalogTracker = {
  slug: 'candidatos',
  name: 'Candidatos',
  fields: [
    {
      key: 'etapa',
      label: 'Etapa',
      type: 'select',
      required: true,
      options: ['Postulado', 'Entrevista', 'Oferta', 'Contratado'],
    },
    { key: 'fecha', label: 'Fecha', type: 'date', required: false },
    { key: 'hora', label: 'Hora', type: 'time', required: false },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
  ],
  alertFlag: { field: 'etapa', value: 'Oferta' },
};

const row = (
  id: string,
  values: Record<string, string | number>,
  created = '2026-09-10T15:00:00Z',
  updated = created,
) => ({ id, label: `Fila ${id}`, values, created_at: created, updated_at: updated });

const ROWS = [
  row('1', { etapa: 'Postulado' }),
  row('2', { etapa: 'Postulado' }),
  row('3', { etapa: 'Postulado' }),
  row('4', { etapa: 'Postulado' }),
  row('5', { etapa: 'Entrevista' }),
  row('6', { etapa: 'Entrevista' }),
  row('7', { etapa: 'Contratado' }),
];

function sources(rows = ROWS): Map<string, ViewSource> {
  return new Map([['candidatos', { tracker: pipeline, rows, truncated: false }]]);
}

function spec(block: Record<string, unknown>) {
  return viewSpecSchema.parse({
    version: 1,
    blocks: [{ id: 'b1', width: 'full', tracker: 'candidatos', title: 'Prueba', ...block }],
  });
}

const NOW = new Date('2026-10-05T18:00:00Z'); // lunes 13:00 en Bogotá

describe('embudo', () => {
  it('sigue el orden de las opciones y muestra las etapas vacías en cero', () => {
    const view = computeView(
      spec({ type: 'chart', chart: 'funnel', groupBy: 'etapa', aggregate: 'count' }),
      sources(),
      NOW,
    );
    const block = view.blocks[0];
    if (block?.type !== 'chart') throw new Error('se esperaba un gráfico');
    expect(block.chart).toBe('funnel');
    expect(block.points.map((p) => [p.label, p.value])).toEqual([
      ['Postulado', 4],
      ['Entrevista', 2],
      ['Oferta', 0],
      ['Contratado', 1],
    ]);
  });

  it('exige un campo de opciones al validar contra el catálogo', () => {
    const s = spec({ type: 'chart', chart: 'funnel', groupBy: 'fecha', aggregate: 'count' });
    expect(checkSpecAgainst(s, [pipeline]).join(' ')).toMatch(/campo de opciones/);
  });
});

describe('mapa de calor', () => {
  it('lee día y hora de Bogotá desde created_at', () => {
    // 2026-10-05 (lunes) 02:30 UTC es domingo 4 de octubre 21:30 en Bogotá.
    expect(weekdayHour('2026-10-05T02:30:00Z')).toEqual({ weekday: 6, hour: 21 });
    expect(weekdayHour('2026-10-05T15:00:00Z')).toEqual({ weekday: 0, hour: 10 });
  });

  it('cuenta por día de la semana y hora', () => {
    const rows = [
      row('a', { etapa: 'Postulado' }, '2026-10-05T15:10:00Z'), // lun 10
      row('b', { etapa: 'Postulado' }, '2026-10-05T15:50:00Z'), // lun 10
      row('c', { etapa: 'Postulado' }, '2026-10-06T19:00:00Z'), // mar 14
    ];
    const view = computeView(
      spec({ type: 'chart', chart: 'heatmap', groupBy: 'created_at', aggregate: 'count' }),
      sources(rows),
      NOW,
    );
    const block = view.blocks[0];
    if (block?.type !== 'chart' || !block.heat) throw new Error('se esperaba un mapa de calor');
    expect(block.heat.cells[0]?.[10]?.value).toBe(2);
    expect(block.heat.cells[1]?.[14]?.value).toBe(1);
    expect(block.heat.max).toBe(2);
    expect(block.points).toHaveLength(7);
  });

  it('usa un campo de hora cuando la fecha sólo trae el día', () => {
    const rows = [row('a', { etapa: 'Postulado', fecha: '2026-10-05', hora: '09:15' })];
    const view = computeView(
      spec({
        type: 'chart',
        chart: 'heatmap',
        groupBy: 'fecha',
        hourField: 'hora',
        aggregate: 'count',
      }),
      sources(rows),
      NOW,
    );
    const block = view.blocks[0];
    if (block?.type !== 'chart' || !block.heat) throw new Error('se esperaba un mapa de calor');
    expect(block.heat.cells[0]?.[9]?.value).toBe(1);
  });

  it('avisa si la fecha no trae hora', () => {
    const view = computeView(
      spec({ type: 'chart', chart: 'heatmap', groupBy: 'fecha', aggregate: 'count' }),
      sources(),
      NOW,
    );
    expect(view.blocks[0]?.type).toBe('problem');
  });
});

describe('meta con semáforo', () => {
  it('piso: verde al llegar, ámbar desde el 70 %, rojo debajo', () => {
    expect(goalStatus(100, 100, 'up')).toBe('good');
    expect(goalStatus(70, 100, 'up')).toBe('warn');
    expect(goalStatus(69, 100, 'up')).toBe('bad');
  });

  it('techo: verde mientras no la pase, ámbar hasta +20 %, rojo más allá', () => {
    expect(goalStatus(5, 5, 'down')).toBe('good');
    expect(goalStatus(6, 5, 'down')).toBe('warn');
    expect(goalStatus(7, 5, 'down')).toBe('bad');
  });

  it('sin valor no hay semáforo', () => {
    expect(goalStatus(null, 10, 'up')).toBeNull();
  });

  it('la cifra trae su estado y su dirección', () => {
    const view = computeView(
      spec({ type: 'metric', aggregate: 'count', goal: 5, goalDirection: 'down' }),
      sources(),
      NOW,
    );
    const block = view.blocks[0];
    if (block?.type !== 'metric') throw new Error('se esperaba una cifra');
    expect(block.value).toBe(7);
    expect(block.goal).toMatchObject({ direction: 'down', status: 'bad' });
  });

  it('goalDirection sin meta no pasa el contrato', () => {
    const parsed = viewSpecSchema.safeParse({
      version: 1,
      blocks: [
        {
          id: 'b1',
          type: 'metric',
          tracker: 'candidatos',
          title: 'X',
          aggregate: 'count',
          goalDirection: 'down',
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('selección de vistas para el resumen', () => {
  const daily: ViewDigest = { cadence: 'daily', hour: 8, recipients: ['u1'] };
  const weekly: ViewDigest = { cadence: 'weekly', hour: 8, weekday: 1, recipients: ['u1'] };

  it('diario: toca desde la hora elegida y una sola vez', () => {
    const before = new Date('2026-10-05T12:00:00Z'); // 07:00 en Bogotá
    expect(isDigestDue(daily, null, before)).toBe(false);
    expect(isDigestDue(daily, null, NOW)).toBe(true);
    // ya enviado hoy a las 08:05 Bogotá
    expect(isDigestDue(daily, new Date('2026-10-05T13:05:00Z'), NOW)).toBe(false);
    // enviado ayer: toca de nuevo
    expect(isDigestDue(daily, new Date('2026-10-04T13:05:00Z'), NOW)).toBe(true);
  });

  it('semanal: sólo el día elegido', () => {
    const tuesday = new Date('2026-10-06T18:00:00Z');
    expect(isDigestDue(weekly, null, NOW)).toBe(true);
    expect(isDigestDue(weekly, null, tuesday)).toBe(false);
    expect(digestSlotStart(weekly, tuesday)).toBeNull();
    expect(isDigestDue({ ...weekly, weekday: 2 }, null, tuesday)).toBe(true);
  });

  it('selectDueDigests deja pasar sólo las que tocan y conserva sus campos', () => {
    const due = selectDueDigests(
      [
        { id: 'a', digest: daily, lastSentAt: null, org: 'o1' },
        { id: 'b', digest: daily, lastSentAt: new Date('2026-10-05T14:00:00Z'), org: 'o2' },
        { id: 'c', digest: { ...daily, recipients: [] }, lastSentAt: null, org: 'o3' },
      ],
      NOW,
    );
    expect(due.map((d) => [d.id, d.org])).toEqual([['a', 'o1']]);
  });

  it('las novedades cuentan desde el último envío, o un período atrás', () => {
    const last = new Date('2026-10-04T13:00:00Z');
    expect(digestSince(daily, last, NOW)).toEqual(last);
    expect(digestSince(daily, null, NOW).toISOString()).toBe('2026-10-04T18:00:00.000Z');
    expect(digestSince(weekly, null, NOW).toISOString()).toBe('2026-09-28T18:00:00.000Z');
  });

  it('resume lo nuevo, lo cambiado y los duplicados; no lee lo bloqueado', () => {
    const since = new Date('2026-10-04T00:00:00Z');
    const rows = [
      row('n', { etapa: 'Postulado' }, '2026-10-05T10:00:00Z'),
      row('c', { etapa: 'Oferta' }, '2026-09-01T10:00:00Z', '2026-10-05T10:00:00Z'),
      row('v', { etapa: 'Postulado' }, '2026-09-01T10:00:00Z'),
    ];
    const blocked: ViewSource = {
      tracker: { slug: 'cortex.x', name: 'Interna', fields: [] },
      rows,
      truncated: false,
      blocked: 'interna',
    };
    const out = summarizeSources(new Map([...sources(rows), ['cortex.x', blocked]]), since);
    expect(out).toEqual([
      { name: 'Candidatos', added: 1, changed: 1, flagged: 1, sample: ['Fila n'] },
    ]);
  });
});

describe('exportación', () => {
  it('una hoja por tabla y gráfico, con las cifras aparte, sin bloques bloqueados', () => {
    const s = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'm',
          tracker: 'candidatos',
          type: 'metric',
          title: 'Total',
          aggregate: 'count',
          goal: 10,
        },
        {
          id: 't',
          tracker: 'candidatos',
          type: 'table',
          title: 'Candidatos',
          columns: ['label', 'etapa'],
        },
        {
          id: 'f',
          tracker: 'candidatos',
          type: 'chart',
          chart: 'funnel',
          title: 'Embudo',
          groupBy: 'etapa',
        },
        { id: 'x', tracker: 'cortex.ventas', type: 'metric', title: 'Interna', aggregate: 'count' },
      ],
    });
    const view = computeView(s, sources(), NOW);
    const sheets = viewExportSheets(view);
    expect(sheets.map((x) => x.name)).toEqual(['Cifras', 'Candidatos', 'Embudo']);
    expect(sheets[1]?.rows).toHaveLength(7);
    expect(sheets[0]?.rows.map((r) => r[0])).toEqual(['Total']);
  });

  it('nombres de archivo seguros', () => {
    expect(viewExportFilename('Ventas / Año 2026', '2026-10-05', 'xlsx')).toBe(
      'ventas-ano-2026-2026-10-05.xlsx',
    );
  });
});
