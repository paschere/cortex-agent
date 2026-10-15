import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USD_COP,
  type UsageRow,
  bogotaDay,
  costByDay,
  costBySurface,
  costByTask,
  costByUser,
  costLine,
  formatCop,
  parseUsdCopRate,
  rowCostUsd,
  sumUsage,
  topConversations,
  usdToCop,
} from './usage-cost';
import { buildUsageCostData } from './usage-cost-view';

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  userId: 'u1',
  conversationId: 'c1',
  taskId: null,
  surface: 'web',
  source: 'chat',
  model: 'claude-sonnet-5',
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  at: '2026-10-05T15:00:00Z',
  ...over,
});

describe('precio de un turno', () => {
  it('cobra entrada 1x, lectura de caché 0,1x, escritura 1,25x y salida aparte', () => {
    // Sonnet 5 desde septiembre: $3 / $15 por millón.
    const usd = rowCostUsd(
      row({ input: 1_000_000, cacheRead: 10_000_000, cacheWrite: 2_000_000, output: 100_000 }),
    );
    expect(usd).toBeCloseTo(3 + 3 + 7.5 + 1.5, 6);
  });

  it('un chat con buen caché cuesta mucho menos que el mismo prompt sin caché', () => {
    const cached = rowCostUsd(row({ input: 1_000, cacheRead: 99_000, output: 500 })) as number;
    const plain = rowCostUsd(row({ input: 100_000, output: 500 })) as number;
    expect(cached).toBeLessThan(plain * 0.2);
  });

  it('elige la tarifa por la FECHA del consumo (ventana intro de Sonnet 5)', () => {
    const aug = rowCostUsd(row({ input: 1_000_000, at: '2026-08-20T12:00:00Z' })) as number;
    const oct = rowCostUsd(row({ input: 1_000_000, at: '2026-10-05T12:00:00Z' })) as number;
    expect(aug).toBeCloseTo(2, 6);
    expect(oct).toBeCloseTo(3, 6);
  });

  it('un modelo sin tarifa suma tokens pero no precio, y se cuenta aparte', () => {
    const t = sumUsage([
      row({ input: 1_000_000 }),
      row({ model: 'gpt-x', input: 500_000, output: 1_000 }),
    ]);
    expect(t.usd).toBeCloseTo(3, 6);
    expect(t.tokens).toBe(1_501_000);
    expect(t.unpriced).toBe(1);
    expect(t.turns).toBe(2);
  });
});

describe('pesos y la línea de la cabecera', () => {
  it('pesos completos con la tasa configurada o la de por defecto', () => {
    expect(usdToCop(0.31, DEFAULT_USD_COP)).toBe(1240);
    expect(formatCop(0.31, 4000)).toBe('$ 1.240');
    expect(formatCop(0.31, 4200)).toBe('$ 1.302');
  });

  it('«$ 1.240 · 12.400 tokens»', () => {
    const t = sumUsage([row({ input: 100_000, output: 2_000 })]);
    expect(costLine(t, 4000)).toMatch(/^\$ [\d.]+ · 102\.000 tokens$/);
    expect(costLine({ usd: 0.31, tokens: 12_400, turns: 1, unpriced: 0 }, 4000)).toBe(
      '$ 1.240 · 12.400 tokens',
    );
  });

  it('si ningún turno tiene tarifa, no inventa un precio', () => {
    expect(costLine({ usd: 0, tokens: 500, turns: 2, unpriced: 2 }, 4000)).toBe('— · 500 tokens');
  });

  it('valida la tasa que escribe una persona', () => {
    expect(parseUsdCopRate('4.150')).toBe(4150);
    expect(parseUsdCopRate('4150,5')).toBe(4150.5);
    expect(parseUsdCopRate('12')).toBeNull();
    expect(parseUsdCopRate('abc')).toBeNull();
    expect(parseUsdCopRate('99999')).toBeNull();
  });
});

describe('agregaciones', () => {
  const rows = [
    row({ input: 200_000, at: '2026-10-05T14:00:00Z' }),
    row({ conversationId: 'c2', userId: 'u2', input: 600_000, at: '2026-10-05T03:00:00Z' }), // 4 oct en Bogotá
    row({ conversationId: 'c2', userId: 'u2', input: 100_000, at: '2026-10-04T20:00:00Z' }),
    row({
      conversationId: 'c3',
      userId: 'u1',
      taskId: 't1',
      surface: 'task',
      source: 'task',
      input: 50_000,
      cacheRead: 400_000,
      at: '2026-10-03T12:00:00Z',
    }),
  ];

  it('el día es el de Bogotá (UTC−5)', () => {
    expect(bogotaDay('2026-10-05T03:00:00Z')).toBe('2026-10-04');
    expect(bogotaDay('2026-10-05T05:00:00Z')).toBe('2026-10-05');
  });

  it('una serie por día, con ceros en los días sin consumo', () => {
    const days = costByDay(rows, 4, '2026-10-05');
    expect(days.map((d) => d.day)).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
    expect(days[0]?.usd).toBe(0);
    expect(days[2]?.usd).toBeCloseTo((600_000 + 100_000) * 3e-6, 9);
    expect(days[3]?.tokens).toBe(200_000);
  });

  it('por persona, por superficie y por tarea, de lo más caro a lo más barato', () => {
    expect(costByUser(rows).map((g) => g.key)).toEqual(['u2', 'u1']);
    expect(costBySurface(rows).map((g) => g.key)).toEqual(['web', 'task']);
    expect(costByTask(rows).map((g) => g.key)).toEqual(['t1']);
  });

  it('las conversaciones más caras, con tope', () => {
    expect(topConversations(rows, 2).map((g) => g.key)).toEqual(['c2', 'c1']);
    expect(topConversations(rows).length).toBe(3);
  });

  it('arma lo que pinta /admin/usage, en pesos y con nombres', () => {
    const data = buildUsageCostData(rows, {
      rate: 4000,
      customRate: false,
      days: 7,
      chartDays: 10,
      today: '2026-10-05',
      userNames: new Map([
        ['u1', 'Ana'],
        ['u2', 'Luis'],
      ]),
      conversationTitles: new Map([['c2', 'Cierre de septiembre']]),
      taskTitles: new Map([['t1', 'Informe semanal']]),
      truncated: false,
      canEditRate: true,
    });
    expect(data.totals.conversations).toBe(3);
    expect(data.totals.cop).toBe(Math.round(sumUsage(rows).usd * 4000));
    expect(data.daily).toHaveLength(10);
    expect(data.perUser[0]).toMatchObject({ label: 'Luis' });
    expect(data.perSurface.map((s) => s.label)).toEqual(['App web', 'Tareas en segundo plano']);
    expect(data.topConversations[0]).toMatchObject({
      id: 'c2',
      title: 'Cierre de septiembre',
      person: 'Luis',
      turns: 2,
      href: '/chat/c2',
    });
    expect(data.topConversations[1]?.href).toBeNull();
    expect(data.topTasks[0]).toMatchObject({ title: 'Informe semanal', href: '/tareas/t1' });
  });

  it('las listas sólo cuentan la ventana; el gráfico trae más días', () => {
    const old = [
      ...rows,
      row({ conversationId: 'c9', input: 9_000_000, at: '2026-08-01T12:00:00Z' }),
    ];
    const data = buildUsageCostData(old, {
      rate: 4000,
      customRate: true,
      days: 7,
      chartDays: 90,
      today: '2026-10-05',
      userNames: new Map(),
      conversationTitles: new Map(),
      taskTitles: new Map(),
      truncated: false,
      canEditRate: false,
    });
    expect(data.topConversations.some((c) => c.id === 'c9')).toBe(false);
    expect(data.daily.some((d) => d.date === '2026-08-01' && d.value > 0)).toBe(true);
  });
});
