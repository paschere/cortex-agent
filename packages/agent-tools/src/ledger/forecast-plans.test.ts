import { describe, expect, it } from 'vitest';
import { forecast } from './forecast';
import { cashRunwayWeeks, hasLedgerCash } from './forecast-explain';
import { AS_OF, accounts, bill, company, invoice, paid } from './forecast.fixtures';
import { matchPayables } from './payables';
import { PAYROLL_CONFIDENTIAL_LABEL, maskPayrollForecast } from './privacy';
import { detectRecurring, mergeRecurring } from './recurring';
import type { MovementRow } from './shape';
import type {
  ForecastInput,
  ForecastItem,
  ForecastResult,
  LedgerMovement,
  RecurringFlow,
} from './types';

/**
 * Lo que la etapa 2 le agregó al motor: lo declarado se suma a lo detectado,
 * lo ignorado sale, las ventas de los clientes regulares se estiman, una
 * factura por pagar muy vencida se pregunta, y la nómina no tiene nombres
 * para quien no administra.
 */

const allItems = (r: ForecastResult): ForecastItem[] => r.weeks.flatMap((w) => w.items);

const base = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  asOf: AS_OF,
  currency: 'COP',
  includeEstimatedSales: false,
  ...company(),
  ...over,
});

describe('lo que se repite: detectado + declarado', () => {
  const detected = detectRecurring(company().movements, AS_OF);

  it('cada detectado trae una llave estable, que no cambia cuando el historial avanza', () => {
    expect(detected.every((f) => f.detectedKey?.startsWith('det-'))).toBe(true);
    expect(new Set(detected.map((f) => f.detectedKey)).size).toBe(detected.length);
    // Sin el primer mes del historial (la ventana se corrió), las llaves siguen.
    const later = detectRecurring(
      company().movements.filter((m) => m.date >= '2026-02-01'),
      AS_OF,
    );
    const rent = (list: RecurringFlow[]) => list.find((f) => f.category === 'arriendo');
    expect(rent(later)?.detectedKey).toBe(rent(detected)?.detectedKey);
  });

  it('lo declarado reemplaza al detectado que habla de lo mismo, y se suma a lo demás', () => {
    const declared: RecurringFlow = {
      id: 'decl-arriendo',
      label: 'Arriendo bodega (nuevo canon)',
      direction: 'out',
      amount: 7_000_000,
      currency: 'COP',
      every: 'month',
      anchor: 6,
      category: 'arriendo',
      counterpartyName: 'Inmobiliaria Los Andes',
      origin: 'declared',
    };
    const credit: RecurringFlow = {
      id: 'decl-credito',
      label: 'Cuota crédito Bancolombia',
      direction: 'out',
      amount: 2_000_000,
      currency: 'COP',
      every: 'month',
      anchor: 28,
      origin: 'declared',
    };
    const merged = mergeRecurring(detected, [declared, credit]);
    expect(merged.filter((f) => f.category === 'arriendo').map((f) => f.id)).toEqual([
      'decl-arriendo',
    ]);
    expect(merged.length).toBe(detected.length + 1);

    const r = forecast(base({ recurring: [declared, credit] }));
    const rent = allItems(r).filter((i) => i.category === 'arriendo' && i.from === 'recurring');
    expect(rent.every((i) => i.amount === 7_000_000)).toBe(true);
    expect(allItems(r).some((i) => i.label === 'Cuota crédito Bancolombia')).toBe(true);
    // La nómina detectada sigue ahí: declarar no apaga la detección.
    expect(allItems(r).some((i) => i.label.startsWith('Pago nómina'))).toBe(true);
    expect(r.assumptions.some((a) => a.includes('declarados (con su monto fijo'))).toBe(true);
  });

  it('un declarado con la llave de un detectado lo reemplaza aunque cambie el día', () => {
    const rent = detected.find((f) => f.category === 'arriendo') as RecurringFlow;
    const merged = mergeRecurring(detected, [
      { ...rent, id: 'corr', origin: 'declared', anchor: 20, amount: 6_800_000 },
    ]);
    expect(merged.filter((f) => f.category === 'arriendo').map((f) => f.id)).toEqual(['corr']);
  });

  it('lo ignorado no entra, y se dice', () => {
    const rent = detected.find((f) => f.category === 'arriendo') as RecurringFlow;
    const r = forecast(base({ ignoredRecurring: [rent.detectedKey as string] }));
    expect(allItems(r).some((i) => i.category === 'arriendo' && i.from === 'recurring')).toBe(
      false,
    );
    expect(r.assumptions).toContain(
      '1 recurrente detectado quedó por fuera porque una persona dijo que no se repite.',
    );
  });

  it('lo confirmado lo dice en su razón', () => {
    const rent = detected.find((f) => f.category === 'arriendo') as RecurringFlow;
    const r = forecast(base({ confirmedRecurring: [rent.detectedKey as string] }));
    const item = allItems(r).find((i) => i.category === 'arriendo' && i.from === 'recurring');
    expect(item?.reason).toContain(', y se confirmó)');
  });
});

describe('ventas estimadas de los clientes regulares', () => {
  // Factura el 5 de cada mes desde abril, a 30 días, y paga a tiempo.
  const regular = (): LedgerMovement[] =>
    ['04', '05', '06', '07', '08', '09'].map((m) =>
      invoice(`reg-${m}`, 'Cliente Regular S.A.S.', 10_000_000, `2026-${m}-05`, `2026-${m}-30`, {
        status: 'settled',
        settledAt: `2026-${m}-30`,
      }),
    );
  const input = (
    movements: LedgerMovement[],
    over: Partial<ForecastInput> = {},
  ): ForecastInput => ({
    asOf: AS_OF,
    currency: 'COP',
    accounts: accounts(),
    movements,
    ...over,
  });

  it('se proyecta lo que falta facturar, con su plazo y menos probabilidad', () => {
    const r = forecast(input(regular()));
    const est = allItems(r).filter((i) => i.from === 'estimate');
    // Octubre se factura el 5 y se cobra a 25 días; noviembre igual; diciembre
    // se cobraría en enero (fuera del horizonte).
    expect(est.map((i) => i.expectedDate)).toEqual(['2026-10-30', '2026-11-30']);
    expect(est[0]).toMatchObject({
      label: 'Ventas estimadas a Cliente Regular',
      direction: 'in',
      amount: 10_000_000,
      category: 'ventas',
      counterpartyName: 'Cliente Regular S.A.S.',
    });
    expect(est[0]?.probability).toBeLessThanOrEqual(0.6);
    expect(est[0]?.reason).toContain('factura casi todos los meses (6 de los últimos 6');
    expect(est[0]?.reason).toContain('Es una estimación, no una factura');
    expect(r.assumptions.some((a) => a.startsWith('Se estiman las ventas que todavía no'))).toBe(
      true,
    );
  });

  it('lo ya facturado este mes se descuenta', () => {
    const r = forecast(
      input([
        ...regular(),
        invoice('reg-10', 'Cliente Regular S.A.S.', 4_000_000, '2026-10-01', '2026-10-31'),
      ]),
    );
    const oct = allItems(r).find((i) => i.from === 'estimate' && i.expectedDate < '2026-11-15');
    expect(oct?.amount).toBe(6_000_000);
    expect(oct?.reason).toContain('este mes ya van $ 4 M');
  });

  it('con menos de 3 meses no se estima nada; y se puede apagar', () => {
    const two = regular().slice(-2);
    expect(allItems(forecast(input(two))).some((i) => i.from === 'estimate')).toBe(false);
    const off = forecast(input(regular(), { includeEstimatedSales: false }));
    expect(allItems(off).some((i) => i.from === 'estimate')).toBe(false);
    expect(off.assumptions).toContain(
      'No se proyectan ventas que todavía no se han facturado, salvo ingresos que se repiten.',
    );
  });

  it('un escenario que pierde al cliente también quita sus ventas estimadas', () => {
    const r = forecast(
      input(regular(), {
        scenario: {
          id: 's',
          label: 'Sin el regular',
          adjustments: [{ kind: 'drop_counterparty', counterpartyName: 'Cliente Regular' }],
        },
      }),
    );
    expect(allItems(r).some((i) => i.from === 'estimate')).toBe(false);
  });
});

describe('facturas por pagar muy vencidas', () => {
  it('más de 60 días sin pago que coincida: «¿ya la pagaste?» y cuenta a medias', () => {
    const r = forecast({
      asOf: AS_OF,
      currency: 'COP',
      accounts: accounts(),
      movements: [bill('vieja', 'Ferretería Central', 1_000_000, '2026-07-01')],
    });
    const [item] = allItems(r);
    expect(item?.reason).toMatch(/^¿ya la pagaste\? lleva 93 días vencida/);
    // 0,5 · 0,5^((93 − 60) / 60)
    expect(item?.probability).toBe(0.342);
    expect(item?.expectedAmount).toBe(342_000);
    expect(r.assumptions.some((a) => a.includes('más de 60 días vencida'))).toBe(true);
  });
});

describe('semanas de caja', () => {
  it('cuenta las semanas antes de bajar del mínimo; null si no baja', () => {
    const r = forecast(base());
    expect(r.minimumCash).toBeGreaterThan(0);
    const weeks = cashRunwayWeeks(r);
    const firstBelow = r.weeks.findIndex((w) => w.closing < (r.minimumCash ?? 0));
    expect(weeks).toBe(firstBelow === -1 ? null : firstBelow);
    expect(cashRunwayWeeks(forecast(base({ minimumCash: 0 })))).toBeNull();
  });

  it('sin libro no hay caja que mostrar', () => {
    const empty = forecast({ asOf: AS_OF, currency: 'COP', accounts: [], movements: [] });
    expect(hasLedgerCash(empty)).toBe(false);
    expect(hasLedgerCash(forecast(base()))).toBe(true);
  });
});

describe('la nómina sin nombres', () => {
  it('cada línea de nómina queda «Nómina (confidencial)», también en las alertas; las cifras no cambian', () => {
    const movements = [
      bill('nom-ana', 'Ana Ruiz', 50_000_000, '2026-10-15', { category: 'nomina' }),
      paid('x', '2026-09-01', 1, {}),
    ];
    const r = forecast({ asOf: AS_OF, currency: 'COP', accounts: accounts(), movements });
    const masked = maskPayrollForecast(r);
    const item = allItems(masked).find((i) => i.movementId === 'nom-ana');
    expect(item?.label).toBe(PAYROLL_CONFIDENTIAL_LABEL);
    expect(item?.counterpartyName).toBeNull();
    expect(JSON.stringify(masked)).not.toContain('Ana Ruiz');
    expect(masked.weeks.map((w) => w.closing)).toEqual(r.weeks.map((w) => w.closing));
  });
});

describe('qué salida del banco paga qué factura', () => {
  const row = (over: Partial<MovementRow>): MovementRow => ({
    id: 'x',
    direction: 'out',
    kind: 'expense',
    status: 'settled',
    amount: 0,
    currency: 'COP',
    date: '2026-09-10',
    due_date: null,
    settled_at: null,
    outstanding: null,
    counterparty_name: null,
    counterparty_tax_id: null,
    category: null,
    category_source: null,
    category_rule_id: null,
    description: 'Salida',
    doc_number: null,
    account_id: null,
    source_kind: 'bank',
    source_system: 'extracto · bancolombia',
    source_ref: 'd:1',
    link_key: null,
    duplicate_of: null,
    excluded_reason: null,
    recorded_by: null,
    settled_by: null,
    settled_by_outstanding: null,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    ...over,
  });
  const payable = (over: Partial<MovementRow>) =>
    row({
      kind: 'payable',
      status: 'expected',
      source_kind: 'document',
      date: '2026-09-01',
      due_date: '2026-09-30',
      ...over,
    });

  it('por nombre en la descripción, valor ±1% y después de emitida', () => {
    const p = payable({
      id: 'p1',
      amount: 6_500_000,
      counterparty_name: 'Inmobiliaria Los Andes S.A.S.',
    });
    const d = row({
      id: 'd1',
      amount: 6_520_000,
      date: '2026-09-29',
      description: 'PAGO PROV INMOBILIARIA LOS ANDES',
    });
    expect(matchPayables([p], [d])).toEqual([
      { payableId: 'p1', debitId: 'd1', date: '2026-09-29', outstanding: 6_500_000 },
    ]);
  });

  it('no: otro valor, antes de la emisión, otra contraparte, o que no viene del banco', () => {
    const p = payable({ id: 'p1', amount: 1_000_000, counterparty_tax_id: '900123456' });
    const ok = { counterparty_tax_id: '900123456', amount: 1_000_000, date: '2026-09-20' };
    expect(matchPayables([p], [row({ id: 'a', ...ok, amount: 1_020_000 })])).toEqual([]);
    expect(matchPayables([p], [row({ id: 'b', ...ok, date: '2026-08-20' })])).toEqual([]);
    expect(matchPayables([p], [row({ id: 'c', ...ok, counterparty_tax_id: '800999999' })])).toEqual(
      [],
    );
    expect(matchPayables([p], [row({ id: 'd', ...ok, source_kind: 'chat' })])).toEqual([]);
    expect(matchPayables([p], [row({ id: 'e', ...ok })], new Set(['e']))).toEqual([]);
    expect(matchPayables([p], [row({ id: 'f', ...ok })])).toHaveLength(1);
  });

  it('cada salida paga una sola factura; la más cercana al vencimiento', () => {
    const a = payable({
      id: 'pa',
      amount: 2_000_000,
      counterparty_name: 'EPM',
      due_date: '2026-09-20',
    });
    const b = payable({
      id: 'pb',
      amount: 2_000_000,
      counterparty_name: 'EPM',
      due_date: '2026-10-20',
    });
    const d1 = row({ id: 'd1', amount: 2_000_000, counterparty_name: 'EPM', date: '2026-09-21' });
    expect(matchPayables([b, a], [d1])).toEqual([
      { payableId: 'pa', debitId: 'd1', date: '2026-09-21', outstanding: 2_000_000 },
    ]);
  });

  it('sin facturas o sin salidas, nada', () => {
    expect(matchPayables([], [])).toEqual([]);
  });
});
