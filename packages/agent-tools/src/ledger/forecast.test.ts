import { describe, expect, it } from 'vitest';
import { forecast } from './forecast';
import { compareScenarios, explainWeek } from './forecast-explain';
import { formatMoney } from './forecast-shared';
import {
  AS_OF,
  accounts,
  bill,
  company,
  expenseHistory,
  invoice,
  paid,
  receivableHistory,
} from './forecast.fixtures';
import type { ForecastInput, ForecastItem, ForecastResult, Scenario } from './types';

// Las ventas estimadas tienen sus propias pruebas (abajo): aquí se apagan para
// que cada cifra de la empresa de ejemplo salga sólo de su libro.
const base = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  asOf: AS_OF,
  currency: 'COP',
  includeEstimatedSales: false,
  ...company(),
  ...over,
});

const allItems = (r: ForecastResult): ForecastItem[] => r.weeks.flatMap((w) => w.items);
const itemsOf = (r: ForecastResult, movementId: string) =>
  allItems(r).filter((i) => i.movementId === movementId);

function checkArithmetic(r: ForecastResult) {
  let prev = r.startingCash;
  for (const w of r.weeks) {
    expect(w.opening).toBe(prev);
    const ins = w.items
      .filter((i) => i.direction === 'in')
      .reduce((s, i) => s + i.expectedAmount, 0);
    const outs = w.items
      .filter((i) => i.direction === 'out')
      .reduce((s, i) => s + i.expectedAmount, 0);
    expect(w.inflows).toBe(ins);
    expect(w.outflows).toBe(outs);
    expect(w.closing).toBe(w.opening + w.inflows - w.outflows);
    for (const i of w.items) {
      expect(Number.isInteger(i.amount)).toBe(true);
      expect(Number.isInteger(i.expectedAmount)).toBe(true);
      expect(i.reason.length).toBeGreaterThan(10);
      expect(i.expectedDate >= w.start).toBe(true);
      expect(i.expectedDate <= addDaysIso(w.start, 6)).toBe(true);
      expect(i.expectedDate >= r.asOf).toBe(true);
    }
    prev = w.closing;
  }
}

function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe('la proyección de 13 semanas de Transportes del Valle', () => {
  const r = forecast(base());

  it('13 semanas de lunes, desde el lunes de esta semana', () => {
    expect(r.weeks).toHaveLength(13);
    expect(r.weeks[0]?.start).toBe('2026-09-28');
    expect(r.weeks[12]?.start).toBe('2026-12-21');
    expect(r.weeks.every((w) => new Date(`${w.start}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
  });

  it('caja inicial: sólo las cuentas en pesos; la de dólares queda por fuera y se dice', () => {
    expect(r.startingCash).toBe(60_500_000);
    expect(r.assumptions).toContain(
      'Caja inicial $ 60,5 M: 2 cuentas en COP (Bancolombia corriente, Davivienda ahorros).',
    );
    expect(r.assumptions).toContain(
      'Quedaron por fuera 1 cuenta en otra moneda (12.000 USD): la proyección es sólo en COP, sin convertir.',
    );
  });

  it('las cuentas cuadran semana a semana, en pesos enteros', () => {
    checkArithmetic(r);
  });

  it('cada cobro dice por qué está en esa semana', () => {
    const coltrans = itemsOf(r, 'FV-1215');
    expect(coltrans).toHaveLength(1);
    expect(coltrans[0]).toMatchObject({
      expectedDate: '2026-10-15',
      amount: 12_000_000,
      probability: 0.98,
      expectedAmount: 11_760_000,
      reason: 'vence el 15 oct; Coltrans suele pagar a tiempo (5 facturas); se cuenta el 98%',
      counterpartyName: 'Coltrans S.A.S.',
      from: 'movement',
    });
    // FV-1225 viene sin NIT y con el nombre corto: igual es Nexa.
    const nexa = itemsOf(r, 'FV-1225')[0];
    expect(nexa?.expectedDate).toBe('2026-11-15');
    expect(nexa?.reason).toBe(
      'vence el 3 nov; Nexa Logística suele pagar 12 días tarde (6 facturas); se cuenta el 98%',
    );
  });

  it('cliente con poca historia: se dice que se acercó al promedio', () => {
    expect(itemsOf(r, 'FV-1230')[0]?.reason).toBe(
      'vence el 30 oct; Agro Pacífico suele pagar 14 días tarde (1 factura; poca historia: se acercó al promedio de la empresa); se cuenta el 96%',
    );
  });

  it('cliente nuevo: el cliente promedio de la empresa', () => {
    expect(itemsOf(r, 'FV-1240')[0]).toMatchObject({
      expectedDate: '2026-12-02',
      probability: 0.94,
      reason:
        'vence el 20 nov; sin historia de pagos de Constructora Bolívar: se usó el cliente promedio de la empresa (suele pagar 12 días tarde); se cuenta el 94%',
    });
  });

  it('vencida dentro del atraso típico: se espera cuando el cliente suele pagar, por su saldo', () => {
    // FV-1190: venció el 10 sep, El Sol suele demorarse 28 días → 8 oct. Pagó la mitad.
    expect(itemsOf(r, 'FV-1190')).toEqual([
      expect.objectContaining({ expectedDate: '2026-10-08', amount: 3_000_000, probability: 0.8 }),
    ]);
  });

  it('vencida hace rato: se reparte en semanas y pierde probabilidad', () => {
    const chunks = itemsOf(r, 'FV-1101');
    // 140 días vencida, 112 más que su atraso típico → 6 semanas, 0,8 · 0,5^(112/90).
    expect(chunks).toHaveLength(6);
    expect(chunks.reduce((s, i) => s + i.amount, 0)).toBe(8_000_000);
    expect(chunks.map((i) => i.expectedDate)).toEqual([
      '2026-10-02',
      '2026-10-09',
      '2026-10-16',
      '2026-10-23',
      '2026-10-30',
      '2026-11-06',
    ]);
    expect(chunks.every((i) => i.probability === 0.338)).toBe(true);
    expect(chunks[0]?.reason).toContain('se reparte en 6 semanas (1 de 6) y se cuenta el 34%');
  });

  it('pagos: el día que vencen; los vencidos, esta semana con nota', () => {
    expect(itemsOf(r, 'LL-88')[0]).toMatchObject({
      expectedDate: '2026-10-09',
      expectedAmount: 7_000_000,
      reason: 'vence el 9 oct; se asume que se paga ese día',
    });
    expect(itemsOf(r, 'TALLER-12')[0]).toMatchObject({
      expectedDate: '2026-10-02',
      reason: 'venció el 20 sep (hace 12 días) y sigue sin pagar: se cuenta esta semana',
    });
  });

  it('lo recurrente se proyecta, salvo la ocurrencia que ya es factura', () => {
    const arriendo = allItems(r).filter((i) => i.category === 'arriendo' && i.from === 'recurring');
    // Octubre ya está como factura (ARR-OCT): sólo noviembre y diciembre.
    expect(arriendo.map((i) => i.expectedDate)).toEqual(['2026-11-05', '2026-12-05']);
    expect(itemsOf(r, 'ARR-OCT')).toHaveLength(1);
    const nomina = allItems(r).filter((i) => i.label.startsWith('Pago nómina'));
    expect(nomina.map((i) => i.expectedDate)).toEqual([
      '2026-10-15',
      '2026-10-30',
      '2026-11-15',
      '2026-11-30',
      '2026-12-15',
    ]);
    expect(nomina[0]?.reason).toBe(
      'se repite cada mes hacia el día 15 (9 veces en el historial); monto: la mediana de las últimas',
    );
    const terpel = allItems(r).filter((i) => i.label === 'Transporte · Terpel');
    expect(terpel).toHaveLength(12);
    expect(terpel[0]?.expectedDate).toBe('2026-10-05');
    expect(r.assumptions).toContain(
      '1 ocurrencia de lo que se repite ya está como factura en el libro: no se cuenta dos veces.',
    );
  });

  it('la semana más baja y sus alertas', () => {
    expect(r.lowest).toEqual({ week: '2026-12-14', closing: 22_896_002 });
    expect(r.alerts.map((a) => [a.kind, a.severity, a.week ?? null])).toEqual([
      ['low_cash', 'warn', '2026-12-14'],
      ['concentration', 'warn', null],
      ['late_payer', 'warn', null],
      ['big_outflow', 'info', '2026-11-23'],
    ]);
    expect(r.alerts[0]?.message).toBe(
      'La caja baja a $ 22,9 M la semana del 14 dic, por debajo de $ 35,8 M (un mes de gastos fijos).',
    );
    expect(r.alerts[1]?.message).toContain('Almacenes Éxito es el 65% de lo que se espera cobrar');
    // El Sol ya no es «mal pagador» (una anulada no cuenta como no cobrada),
    // pero su factura vencida hace 140 días sí se avisa.
    expect(r.alerts[2]?.message).toContain(
      'Distribuidora El Sol tiene $ 8 M vencidos hace 140 días que se cuentan al 34%',
    );
    expect(r.alerts[3]?.message).toBe(
      'Pago grande: Pago a Autonorte · Cuota inicial camión, $ 60 M el 25 nov.',
    );
  });

  it('los supuestos se dicen en palabras', () => {
    expect(r.assumptions[0]).toBe(
      'Semanas de lunes a domingo en días de Bogotá, del 28 sep al 27 dic; la primera cuenta desde hoy, 2 oct.',
    );
    expect(r.assumptions).toContain('Caja mínima: $ 35,8 M, un mes de los gastos que se repiten.');
    expect(r.assumptions).toContain(
      'No se proyectan ventas que todavía no se han facturado, salvo ingresos que se repiten.',
    );
    expect(r.assumptions.some((a) => a.includes('90 días después cuenta la mitad'))).toBe(true);
  });

  it('determinista: la misma entrada da exactamente lo mismo, en cualquier orden', () => {
    expect(forecast(base())).toEqual(r);
    const shuffled = base();
    shuffled.movements = [...shuffled.movements].reverse();
    shuffled.accounts = [...shuffled.accounts];
    expect(forecast(shuffled).weeks).toEqual(r.weeks);
    expect(forecast(shuffled).alerts).toEqual(r.alerts);
  });
});

describe('casos de borde', () => {
  it('sin cuentas: arranca en 0 y lo dice', () => {
    const r = forecast(base({ accounts: [] }));
    expect(r.startingCash).toBe(0);
    expect(r.weeks[0]?.opening).toBe(0);
    expect(r.assumptions).toContain(
      'No hay cuentas con saldo: la caja arranca en $ 0 y la tabla muestra sólo lo que entra y sale.',
    );
  });

  it('sin nada de nada: 13 semanas planas en 0, sin alertas', () => {
    const r = forecast({ asOf: AS_OF, currency: 'COP', accounts: [], movements: [] });
    expect(r.weeks).toHaveLength(13);
    expect(r.weeks.every((w) => w.closing === 0 && w.items.length === 0)).toBe(true);
    expect(r.alerts).toEqual([]);
    expect(r.lowest).toEqual({ week: '2026-09-28', closing: 0 });
    expect(r.assumptions).toContain('Sin caja mínima: sólo se avisa si la caja queda en rojo.');
    expect(r.assumptions.some((a) => a.startsWith('No se detectaron gastos que se repitan'))).toBe(
      true,
    );
  });

  it('historial vacío pero con facturas: clientes a tiempo y al 95%', () => {
    const r = forecast({
      asOf: AS_OF,
      currency: 'COP',
      accounts: accounts(),
      movements: [invoice('n1', 'Nuevo', 10_000_000, '2026-10-01', '2026-10-31')],
    });
    expect(itemsOf(r, 'n1')[0]).toMatchObject({
      expectedDate: '2026-10-31',
      probability: 0.95,
      expectedAmount: 9_500_000,
      reason:
        'vence el 31 oct; sin historia de cobros: se asume que paga a tiempo; se cuenta el 95%',
    });
    expect(r.assumptions).toContain(
      'No hay historia de cobros: se asume que los clientes pagan a tiempo y se cuenta el 95%.',
    );
  });

  it('todo vencido: los pagos caen esta semana y la caja queda en rojo → crítica', () => {
    const r = forecast({
      asOf: AS_OF,
      currency: 'COP',
      accounts: accounts()
        .slice(0, 1)
        .map((a) => ({ ...a, balance: 5_000_000 })),
      movements: [
        bill('p1', 'Proveedor A', 4_000_000, '2026-08-10'),
        bill('p2', 'Proveedor B', 3_000_000, '2026-09-15'),
        invoice('c1', 'Cliente C', 6_000_000, '2026-06-01', '2026-07-01'),
      ],
    });
    expect(r.weeks[0]?.outflows).toBe(7_000_000);
    expect(r.weeks[0]?.closing).toBeLessThan(0);
    expect(r.alerts[0]).toMatchObject({
      kind: 'negative_cash',
      severity: 'critical',
      week: '2026-09-28',
    });
    expect(r.alerts.some((a) => a.kind === 'low_cash')).toBe(false);
    // El cobro vencido hace 93 días se reparte y pierde probabilidad dos veces:
    // ya cuenta como perdido en la tasa del cliente (0,53) y además decae por
    // edad (0,5^(93/90)). Prudente a propósito.
    const c1 = itemsOf(r, 'c1');
    expect(c1).toHaveLength(5);
    expect(c1[0]?.probability).toBe(0.259);
    checkArithmetic(r);
  });

  it('varias monedas: proyectar en USD usa sólo lo de USD y escribe la moneda', () => {
    const movements = [
      ...company().movements,
      invoice('EXP-1', 'Importador Miami', 4_000, '2026-10-01', '2026-10-31', { currency: 'USD' }),
    ];
    const cop = forecast(base({ movements }));
    expect(itemsOf(cop, 'EXP-1')).toEqual([]);
    expect(cop.assumptions).toContain('1 movimiento abierto en otra moneda quedó por fuera.');

    const usd = forecast({ asOf: AS_OF, currency: 'usd', accounts: accounts(), movements });
    expect(usd.currency).toBe('USD');
    expect(usd.startingCash).toBe(12_000);
    expect(itemsOf(usd, 'EXP-1')).toHaveLength(1);
    expect(usd.assumptions.some((a) => a.includes('$ 60,5 M'))).toBe(true);
    expect(formatMoney(usd.weeks[12]?.closing ?? 0, 'USD')).toMatch(/ USD$/);
  });

  it('una factura sin vencimiento se asume a 30 días', () => {
    const r = forecast({
      asOf: AS_OF,
      currency: 'COP',
      accounts: [],
      movements: [bill('sv', 'Sin fecha', 1_000_000, '2026-10-01', { dueDate: null })],
    });
    expect(itemsOf(r, 'sv')[0]?.expectedDate).toBe('2026-10-31');
    expect(r.assumptions).toContain(
      '1 factura no trae vencimiento: se asumió 30 días desde la emisión.',
    );
  });

  it('bordes de semana: domingo es el último día; lunes abre la siguiente', () => {
    const r = forecast({
      asOf: '2026-10-04', // domingo
      currency: 'COP',
      accounts: [],
      movements: [bill('dom', 'A', 100, '2026-10-04'), bill('lun', 'B', 200, '2026-10-05')],
    });
    expect(r.weeks[0]?.start).toBe('2026-09-28');
    expect(r.weeks[0]?.items.map((i) => i.movementId)).toEqual(['dom']);
    expect(r.weeks[1]?.items.map((i) => i.movementId)).toEqual(['lun']);
  });

  it('hoy con hora UTC se lee como día de Bogotá', () => {
    // 03:00 UTC del 5 oct = domingo 4 oct en Bogotá → la semana empieza el 28 sep.
    const r = forecast({
      asOf: '2026-10-05T03:00:00Z',
      currency: 'COP',
      accounts: [],
      movements: [],
    });
    expect(r.asOf).toBe('2026-10-04');
    expect(r.weeks[0]?.start).toBe('2026-09-28');
  });

  it('horizonte más corto: lo que cae después no entra y se dice', () => {
    const r = forecast(base({ horizonWeeks: 4 }));
    expect(r.weeks).toHaveLength(4);
    expect(itemsOf(r, 'CAMION-1')).toEqual([]);
    expect(r.assumptions.some((a) => a.includes('después del 25 oct'))).toBe(true);
    checkArithmetic(r);
  });

  it('un gasto fijo que debía pasar hace pocos días y no aparece: esta semana', () => {
    // 7 oct: el arriendo (día 5) no está pagado ni facturado.
    const movements = [...expenseHistory()];
    const r = forecast({ asOf: '2026-10-07', currency: 'COP', accounts: accounts(), movements });
    const missed = allItems(r).find(
      (i) => i.category === 'arriendo' && i.expectedDate === '2026-10-07',
    );
    expect(missed?.reason).toContain('debía pasar el 5 oct y todavía no aparece pagado');
    // Si ya se pagó, no.
    const paidRent = paid('arr-10', '2026-10-05', 6_500_000, {
      category: 'arriendo',
      counterpartyName: 'Inmobiliaria Los Andes S.A.S.',
    });
    const r2 = forecast({
      asOf: '2026-10-07',
      currency: 'COP',
      accounts: accounts(),
      movements: [...movements, paidRent],
    });
    expect(
      allItems(r2).some((i) => i.category === 'arriendo' && i.expectedDate === '2026-10-07'),
    ).toBe(false);
  });

  it('recurrentes declarados sin detección: sólo la lista', () => {
    const r = forecast(
      base({
        detectRecurring: false,
        recurring: [
          {
            id: 'decl-1',
            label: 'Cuota crédito Bancolombia',
            direction: 'out',
            amount: 2_000_000,
            currency: 'COP',
            every: 'month',
            anchor: 28,
            origin: 'declared',
          },
        ],
      }),
    );
    const rec = allItems(r).filter((i) => i.from === 'recurring');
    // El 28 dic ya cae después del domingo 27 dic.
    expect(rec.map((i) => i.expectedDate)).toEqual(['2026-10-28', '2026-11-28']);
    expect(rec[0]?.reason).toBe('se declaró que pasa cada mes hacia el día 28');
    expect(r.assumptions).toContain('Caja mínima: $ 2 M, un mes de los gastos que se repiten.');
  });

  it('caja mínima fijada: el umbral decide la alerta', () => {
    const r = forecast(base());
    const below = forecast(base({ minimumCash: r.lowest.closing + 1 }));
    expect(below.alerts.find((a) => a.kind === 'low_cash')?.message).toContain(
      '(el mínimo fijado)',
    );
    const at = forecast(base({ minimumCash: r.lowest.closing }));
    expect(at.alerts.some((a) => a.kind === 'low_cash')).toBe(false);
  });

  it('concentración: más de 40% de un solo cliente, no 40% exacto', () => {
    const at40 = forecast({
      asOf: AS_OF,
      currency: 'COP',
      accounts: [],
      movements: [
        invoice('a', 'Uno', 4_000_000, '2026-10-01', '2026-10-20'),
        invoice('b', 'Dos', 3_000_000, '2026-10-01', '2026-10-20'),
        invoice('c', 'Tres', 3_000_000, '2026-10-01', '2026-10-20'),
      ],
    });
    expect(at40.alerts.some((a) => a.kind === 'concentration')).toBe(false);
    const over40 = forecast({
      asOf: AS_OF,
      currency: 'COP',
      accounts: [],
      movements: [
        invoice('a', 'Uno', 4_100_000, '2026-10-01', '2026-10-20'),
        invoice('b', 'Dos', 3_000_000, '2026-10-01', '2026-10-20'),
        invoice('c', 'Tres', 3_000_000, '2026-10-01', '2026-10-20'),
      ],
    });
    expect(over40.alerts.filter((a) => a.kind === 'concentration')).toHaveLength(1);
    expect(over40.alerts[0]?.message).toContain('Uno es el 41%');
  });
});

describe('escenarios', () => {
  const nexaLate: Scenario = {
    id: 'nexa-30',
    label: 'Nexa se atrasa un mes',
    adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'Nexa', days: 30 }],
  };

  it('Nexa 30 días tarde: la frase y el delta por semana', () => {
    const b = forecast(base());
    const s = forecast(base({ scenario: nexaLate }));
    expect(s.scenario).toEqual(nexaLate);
    expect(s.assumptions).toContain(
      'Escenario «Nexa se atrasa un mes»: Nexa paga 30 días más tarde.',
    );
    const cmp = compareScenarios(b, s);
    expect(cmp.summary).toBe(
      'Si Nexa paga 30 días más tarde, la caja más baja pasa de $ 22,9 M (semana del 14 dic) a $ 16,3 M en la semana del 23 nov.',
    );
    expect(cmp.weeks).toHaveLength(13);
    for (const w of cmp.weeks) expect(w.delta).toBe(w.scenarioClosing - w.baseClosing);
    // FV-1210 (17,64 M esperados) pasa del 1 nov al 1 dic: desde la semana del 26 oct falta.
    expect(cmp.weeks.find((w) => w.start === '2026-10-26')?.delta).toBe(-17_640_000);
    // En diciembre ya entraron las dos: se recupera todo.
    expect(cmp.weeks.find((w) => w.start === '2026-12-14')?.delta).toBe(0);
    expect(cmp.lowest.delta).toBe(s.lowest.closing - b.lowest.closing);
    checkArithmetic(s);
  });

  it('se pierde Nexa: nada de Nexa en la proyección', () => {
    const s = forecast(
      base({
        scenario: {
          id: 'x',
          label: 'Sin Nexa',
          adjustments: [{ kind: 'drop_counterparty', counterpartyName: 'Nexa Logística' }],
        },
      }),
    );
    expect(allItems(s).some((i) => i.counterpartyName?.startsWith('Nexa'))).toBe(false);
  });

  it('pago único grande que pone la caja en rojo: crítica y comparación', () => {
    const b = forecast(base());
    const s = forecast(
      base({
        scenario: {
          id: 'y',
          label: 'Camión de contado',
          adjustments: [
            {
              kind: 'one_off',
              label: 'Saldo camión',
              direction: 'out',
              amount: 50_000_000,
              date: '2026-12-01',
            },
          ],
        },
      }),
    );
    expect(s.alerts[0]).toMatchObject({
      kind: 'negative_cash',
      severity: 'critical',
      week: '2026-11-30',
    });
    expect(s.alerts.find((a) => a.message.includes('Saldo camión'))).toMatchObject({
      kind: 'big_outflow',
      severity: 'warn',
    });
    expect(compareScenarios(b, s).summary).toBe(
      'Si sale un pago único de $ 50 M el 1 dic («Saldo camión»), la caja más baja pasa de $ 22,9 M a −$ 27,1 M en la semana del 14 dic, y queda en rojo desde la semana del 30 nov.',
    );
  });

  it('un escenario sin efecto lo dice', () => {
    const b = forecast(base());
    const s = forecast(
      base({
        scenario: {
          id: 'z',
          label: 'Nada',
          adjustments: [{ kind: 'delay_counterparty', counterpartyName: 'Fantasma', days: 10 }],
        },
      }),
    );
    expect(s.assumptions).toContain(
      'El escenario corre a «Fantasma», pero no hay nada suyo en la proyección.',
    );
    expect(compareScenarios(b, s).summary).toBe(
      'Si Fantasma paga 10 días más tarde, la caja más baja no cambia: $ 22,9 M la semana del 14 dic.',
    );
  });

  it('nómina +10% y un vendedor nuevo: más salida cada semana que toca', () => {
    const b = forecast(base());
    const s = forecast(
      base({
        scenario: {
          id: 'w',
          label: 'Crecer equipo',
          adjustments: [
            { kind: 'scale_category', category: 'nomina', factor: 1.1 },
            {
              kind: 'add_recurring',
              label: 'Vendedor nuevo',
              direction: 'out',
              amount: 3_500_000,
              every: 'month',
              start: '2026-10-30',
            },
          ],
        },
      }),
    );
    const cmp = compareScenarios(b, s);
    expect(cmp.weeks.every((w) => w.delta <= 0)).toBe(true);
    // 5 quincenas (+940 mil c/u) y 3 PILA (+420 mil c/u) en el horizonte + 2 sueldos nuevos (30 oct, 30 nov).
    expect(cmp.weeks[12]?.delta).toBe(-(5 * 940_000 + 3 * 420_000 + 2 * 3_500_000));
  });
});

describe('explicar una semana', () => {
  const r = forecast(base());

  it('la semana del camión, en una frase y con lo que más pesa primero', () => {
    const e = explainWeek(r, '2026-11-25'); // miércoles: cualquier día sirve
    expect(e.weekStart).toBe('2026-11-23');
    expect(e.items[0]?.movementId).toBe('CAMION-1');
    expect(e.items.map((i) => i.expectedAmount)).toEqual(
      [...e.items.map((i) => i.expectedAmount)].sort((a, b) => b - a),
    );
    expect(e.summary).toBe(
      'La semana del 23 nov abre con $ 71,8 M, entran $ 38 M y salen $ 61,3 M (lo que más pesa: Pago a Autonorte · Cuota inicial camión, salen $ 60 M) y cierra con $ 48,6 M.',
    );
  });

  it('fuera del horizonte lo dice', () => {
    expect(explainWeek(r, '2027-03-01').summary).toBe(
      'La semana del 1 mar está fuera de la proyección (va de la semana del 28 sep a la del 21 dic).',
    );
  });

  it('semana sin movimientos', () => {
    const empty = forecast({ asOf: AS_OF, currency: 'COP', accounts: accounts(), movements: [] });
    expect(explainWeek(empty, '2026-10-12').summary).toBe(
      'La semana del 12 oct no tiene cobros ni pagos esperados: abre y cierra con $ 60,5 M.',
    );
  });
});
