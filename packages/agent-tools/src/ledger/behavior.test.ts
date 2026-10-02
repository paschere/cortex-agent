import { describe, expect, it } from 'vitest';
import { behaviorFromHistory, companyBehavior } from './behavior';
import { AS_OF, invoice, receivableHistory } from './forecast.fixtures';
import { openItems } from './forecast.fixtures';

const history = () => [...receivableHistory(), ...openItems()];

function byName(name: string) {
  const found = behaviorFromHistory(history(), { asOf: AS_OF }).find((b) =>
    b.counterpartyName.startsWith(name),
  );
  if (!found) throw new Error(`sin comportamiento para ${name}`);
  return found;
}

describe('cómo paga cada cliente', () => {
  it('Nexa paga ~12 días tarde, siempre; con y sin NIT es el mismo cliente', () => {
    const all = behaviorFromHistory(history(), { asOf: AS_OF });
    expect(all.filter((b) => b.counterpartyName.startsWith('Nexa'))).toHaveLength(1);
    expect(byName('Nexa')).toEqual({
      counterpartyName: 'Nexa Logística S.A.S.',
      counterpartyTaxId: '901234567-1',
      typicalDelayDays: 12,
      // 6 de 6 pagadas, suavizado con 3 facturas promedio: no es certeza.
      collectionRate: 0.98,
      sample: 6,
    });
  });

  it('pagar antes del vencimiento cuenta como a tiempo (0), nunca negativo', () => {
    expect(byName('Coltrans').typicalDelayDays).toBe(0);
    expect(byName('Coltrans').sample).toBe(5);
  });

  it('una vencida hace más de 90 días cuenta como no cobrada; una anulada no dice nada', () => {
    const sol = byName('Distribuidora El Sol');
    // sol-1 y sol-2 pagadas, FV-1101 vencida desde el 15 may. sol-3 anulada:
    // una nota crédito no es un mal pagador, así que no cuenta para nada.
    // FV-1190 vencida hace 22 días todavía no dice nada.
    expect(sol.sample).toBe(3);
    // (2 cobradas + 3 × 0,94) / (3 + 3)
    expect(sol.collectionRate).toBe(0.8);
  });

  it('con poca historia el atraso se encoge hacia el promedio de la empresa', () => {
    const avg = companyBehavior(history(), { asOf: AS_OF });
    expect(avg).toEqual({ typicalDelayDays: 12, collectionRate: 0.94, sample: 15 });
    // Agro: una factura 20 días tarde → (1·20 + 3·12) / 4 = 14.
    expect(byName('Agro').typicalDelayDays).toBe(14);
    expect(byName('Agro').sample).toBe(1);
    // El Sol: 45 y 60 días (mediana 52,5) → (2·52,5 + 3·12) / 5 ≈ 28.
    expect(byName('Distribuidora El Sol').typicalDelayDays).toBe(28);
  });

  it('sin historia: nada por cliente, y el promedio asume a tiempo y 95%', () => {
    expect(behaviorFromHistory([], { asOf: AS_OF })).toEqual([]);
    expect(companyBehavior([], { asOf: AS_OF })).toEqual({
      typicalDelayDays: 0,
      collectionRate: 0.95,
      sample: 0,
    });
  });

  it('una factura abierta que vence hace poco no cuenta todavía', () => {
    const open = [invoice('x', 'Nuevo', 1_000_000, '2026-08-01', '2026-09-01')];
    expect(behaviorFromHistory(open, { asOf: AS_OF })).toEqual([]);
    // Pasados 90 días ya cuenta como perdida. Sin más historia, el promedio de
    // la empresa es (0 + 3 × 0,95) / 4 = 0,71 y el cliente (0 + 3 × 0,71) / 4.
    expect(behaviorFromHistory(open, { asOf: '2026-12-15' })[0]).toMatchObject({
      sample: 1,
      collectionRate: 0.53,
    });
  });

  it('fechas con hora se leen en día de Bogotá (UTC−5, sin horario de verano)', () => {
    // 03:00 UTC del 1 may es todavía 30 abr en Bogotá: pagó a tiempo.
    const m = invoice('t', 'Reloj', 1_000_000, '2026-04-01', '2026-04-30', {
      status: 'settled',
      settledAt: '2026-05-01T03:00:00Z',
    });
    const late = invoice('t2', 'Reloj', 1_000_000, '2026-04-01', '2026-04-30', {
      status: 'settled',
      settledAt: '2026-05-01T06:00:00Z',
    });
    expect(behaviorFromHistory([m], { asOf: AS_OF })[0]?.typicalDelayDays).toBe(0);
    // Sólo historia de este cliente: el promedio es él mismo.
    expect(companyBehavior([late], { asOf: AS_OF }).typicalDelayDays).toBe(1);
  });

  it('sin asOf usa el día más reciente del historial; el orden de entrada no importa', () => {
    const h = history();
    expect(behaviorFromHistory(h)).toEqual(behaviorFromHistory([...h].reverse()));
    expect(behaviorFromHistory(h, { asOf: AS_OF })).toEqual(
      behaviorFromHistory([...h].reverse(), { asOf: AS_OF }),
    );
  });

  it('ignora lo que no es por cobrar (gastos, pagos a proveedores)', () => {
    const only = openItems().filter((m) => m.kind === 'payable');
    expect(behaviorFromHistory(only, { asOf: AS_OF })).toEqual([]);
  });
});
