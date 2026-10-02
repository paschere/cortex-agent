import { describe, expect, it } from 'vitest';
import { AS_OF, company, expenseHistory, mv, paid } from './forecast.fixtures';
import { detectRecurring } from './recurring';

const summary = (flows: ReturnType<typeof detectRecurring>) =>
  flows.map((f) => [f.label, f.direction, f.every, f.anchor, f.amount, f.sample]);

describe('lo que se repite', () => {
  it('encuentra nómina quincenal, PILA, arriendo, EPM, combustible semanal y el contrato', () => {
    const flows = detectRecurring(company().movements, AS_OF);
    expect(summary(flows)).toEqual([
      ['Pago nómina quincena (día 15)', 'out', 'month', 15, 9_400_000, 9],
      ['Pago nómina quincena (día 30)', 'out', 'month', 30, 9_400_000, 9],
      ['Arriendo · Inmobiliaria Los Andes S.A.S.', 'out', 'month', 5, 6_500_000, 9],
      ['Pago PILA aportes', 'out', 'month', 10, 4_200_000, 9],
      ['Transporte · Terpel', 'out', 'week', 1, 1_250_000, 13],
      ['Servicios públicos · EPM', 'out', 'month', 20, 906_000, 9],
      ['Ventas · Almacenes Éxito S.A.', 'in', 'month', 25, 38_000_000, 9],
    ]);
    const arriendo = flows.find((f) => f.category === 'arriendo');
    expect(arriendo).toMatchObject({
      counterpartyName: 'Inmobiliaria Los Andes S.A.S.',
      origin: 'detected',
      currency: 'COP',
    });
  });

  it('el monto es la mediana reciente: la nómina subió en julio', () => {
    const nomina = detectRecurring(expenseHistory(), AS_OF).find((f) => f.anchor === 15);
    expect(nomina?.amount).toBe(9_400_000);
  });

  it('NO proyecta lo bimestral (IVA), lo que dejó de pasar (Siigo) ni lo irregular', () => {
    const labels = detectRecurring(expenseHistory(), AS_OF).map((f) => f.label);
    expect(labels.some((l) => l.includes('DIAN') || l.includes('IVA'))).toBe(false);
    expect(labels.some((l) => l.includes('Siigo'))).toBe(false);
    expect(labels.some((l) => l.includes('Repuestos'))).toBe(false);
  });

  it('exige al menos 3 veces', () => {
    const two = [
      paid('a1', '2026-08-05', 2_000_000, { counterpartyName: 'Bodega' }),
      paid('a2', '2026-09-05', 2_000_000, { counterpartyName: 'Bodega' }),
    ];
    expect(detectRecurring(two, AS_OF)).toEqual([]);
    expect(detectRecurring(two, AS_OF, { minOccurrences: 1 })).toEqual([]);
    const three = [...two, paid('a0', '2026-07-06', 2_000_000, { counterpartyName: 'Bodega' })];
    expect(detectRecurring(three, AS_OF)).toHaveLength(1);
  });

  it('el 30, el 31 y el 1 son el mismo «fin de mes», también en febrero', () => {
    const endOfMonth = [
      paid('e1', '2026-01-31', 3_000_000, { counterpartyName: 'Contador' }),
      paid('e2', '2026-02-28', 3_000_000, { counterpartyName: 'Contador' }),
      paid('e3', '2026-04-01', 3_000_000, { counterpartyName: 'Contador' }),
      paid('e4', '2026-04-30', 3_000_000, { counterpartyName: 'Contador' }),
      paid('e5', '2026-05-29', 3_000_000, { counterpartyName: 'Contador' }),
      paid('e6', '2026-07-01', 3_000_000, { counterpartyName: 'Contador' }),
      paid('e7', '2026-07-31', 3_000_000, { counterpartyName: 'Contador' }),
      paid('e8', '2026-08-31', 3_000_000, { counterpartyName: 'Contador' }),
      paid('e9', '2026-09-30', 3_000_000, { counterpartyName: 'Contador' }),
    ];
    const flows = detectRecurring(endOfMonth, AS_OF);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ every: 'month', anchor: 30, sample: 9, label: 'Contador' });
  });

  it('montos que saltan demasiado no son recurrentes', () => {
    const amounts = [2_700_000, 1_000_000, 5_300_000, 1_400_000, 3_800_000, 1_950_000];
    const wild = amounts.map((amount, i) =>
      paid(`w${i}`, `2026-0${i + 4}-10`, amount, { counterpartyName: 'Variable' }),
    );
    // Encadenados quedan en una misma banda, pero sólo 2 de 6 están a ±35% de la mediana.
    expect(detectRecurring(wild, AS_OF)).toEqual([]);
  });

  it('dos cosas de la misma contraparte con montos distintos son dos flujos', () => {
    const epm = [6, 7, 8, 9].flatMap((m) => [
      paid(`en${m}`, `2026-0${m}-20`, 900_000, {
        counterpartyName: 'EPM',
        category: 'servicios_publicos',
      }),
      paid(`ag${m}`, `2026-0${m}-20`, 250_000, {
        counterpartyName: 'EPM',
        category: 'servicios_publicos',
      }),
    ]);
    expect(detectRecurring(epm, AS_OF).map((f) => f.amount)).toEqual([900_000, 250_000]);
  });

  it('traslados entre cuentas propias y facturas por cobrar no cuentan', () => {
    const moves = [6, 7, 8, 9].flatMap((m) => [
      mv({
        id: `t${m}`,
        direction: 'out',
        kind: 'transfer',
        status: 'settled',
        amount: 5_000_000,
        date: `2026-0${m}-01`,
        description: 'Traslado a ahorros',
      }),
      mv({
        id: `r${m}`,
        direction: 'in',
        kind: 'receivable',
        status: 'settled',
        amount: 5_000_000,
        date: `2026-0${m}-01`,
        settledAt: `2026-0${m}-02`,
        counterpartyName: 'Cliente fijo',
        description: 'Factura',
      }),
    ]);
    expect(detectRecurring(moves, AS_OF)).toEqual([]);
  });

  it('semanal: el día de la semana más común', () => {
    const weekly = ['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30'].map(
      (d, i) =>
        paid(`w${i}`, d, 300_000, { description: 'Aseo oficina', category: 'mantenimiento' }),
    );
    expect(detectRecurring(weekly, AS_OF)).toMatchObject([
      { every: 'week', anchor: 3, label: 'Aseo oficina', amount: 300_000 },
    ]);
  });

  it('es determinista: mismos ids y mismo orden sin importar el orden de entrada', () => {
    const m = company().movements;
    const a = detectRecurring(m, AS_OF);
    const b = detectRecurring([...m].reverse(), AS_OF);
    expect(b).toEqual(a);
    expect(new Set(a.map((f) => f.id)).size).toBe(a.length);
  });

  it('no mira el futuro ni más de ~13 meses atrás', () => {
    const future = [10, 11, 12].map((m) =>
      paid(`f${m}`, `2026-${m}-05`, 1_000_000, { counterpartyName: 'Futuro' }),
    );
    expect(detectRecurring(future, AS_OF)).toEqual([]);
  });
});
