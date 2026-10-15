import { describe, expect, it } from 'vitest';
import { type CloseCheckData, evaluateCheck, progressOf, taskReady, tasksFor } from './shape';
import { type MovementLite, findUnusualMovements } from './unusual';

const mv = (
  id: string,
  date: string,
  amount: number,
  category: string | null,
  counterparty: string | null = null,
): MovementLite => ({ id, date, amount, direction: 'out', category, counterparty });

describe('conciliación por cuenta: libro vs extracto', () => {
  it('error si la lectura falló, nunca «al día»', () => {
    expect(evaluateCheck('conciliacion_cuentas', {}, '2026-09').state).toBe('error');
  });

  it('sin cuentas del banco no aplica', () => {
    expect(evaluateCheck('conciliacion_cuentas', { accountRecon: [] }, '2026-09').state).toBe(
      'no_aplica',
    );
  });

  it('al día: dice los saldos de fin de mes como evidencia', () => {
    const c = evaluateCheck(
      'conciliacion_cuentas',
      {
        accountRecon: [
          { name: 'Bancolombia', extraCount: 0, extraAmount: 0, balanceAtEnd: 48_250_000 },
        ],
      },
      '2026-09',
    );
    expect(c.state).toBe('ok');
    expect(c.detail).toContain('Bancolombia $ 48.250.000');
  });

  it('pendiente: cuenta y valor de lo del libro sin respaldo en el extracto', () => {
    const c = evaluateCheck(
      'conciliacion_cuentas',
      {
        accountRecon: [
          { name: 'Bancolombia', extraCount: 0, extraAmount: 0, balanceAtEnd: null },
          { name: 'Davivienda', extraCount: 2, extraAmount: 1_380_000, balanceAtEnd: null },
        ],
      },
      '2026-09',
    );
    expect(c).toMatchObject({ state: 'pendiente', count: 2 });
    expect(c.detail).toContain('Davivienda (2, $ 1.380.000)');
  });
});

describe('facturas emitidas vs programa contable', () => {
  const base = {
    cortexCount: 14,
    cortexTotal: 86_450_000,
    programCount: 15,
    programTotal: 91_200_000,
  };

  it('null: nada que comparar', () => {
    expect(evaluateCheck('facturas_emitidas', { issuedInvoices: null }, '2026-09').state).toBe(
      'no_aplica',
    );
  });

  it('pendiente con borradores/errores y con facturas que el programa no muestra', () => {
    const c = evaluateCheck(
      'facturas_emitidas',
      { issuedInvoices: { ...base, problems: 2, missingInProgram: 1 } },
      '2026-09',
    );
    expect(c).toMatchObject({ state: 'pendiente', count: 3 });
    expect(c.detail).toContain('2 facturas en borrador');
    expect(c.detail).toContain('1 factura emitida no aparece');
  });

  it('al día: dice cuántas y por cuánto, y lo que ve el programa', () => {
    const c = evaluateCheck(
      'facturas_emitidas',
      { issuedInvoices: { ...base, problems: 0, missingInProgram: 0 } },
      '2026-09',
    );
    expect(c.state).toBe('ok');
    expect(c.detail).toContain('14 facturas emitidas por $ 86.450.000');
    expect(c.detail).toContain('15 facturas');
  });

  it('sin programa conectado se dice que no hay con qué compararlas', () => {
    const c = evaluateCheck(
      'facturas_emitidas',
      {
        issuedInvoices: {
          cortexCount: 1,
          cortexTotal: 1_000_000,
          programCount: null,
          programTotal: null,
          problems: 0,
          missingInProgram: 0,
        },
      },
      '2026-09',
    );
    expect(c.detail).toContain('sin programa conectado');
  });
});

describe('movimientos inusuales: la revisión del cierre', () => {
  it('sin lectura: error; sin hallazgos: al día; con hallazgos: pendiente y los nombra', () => {
    expect(evaluateCheck('anomalias', {}, '2026-09').state).toBe('error');
    expect(evaluateCheck('anomalias', { unusual: [] }, '2026-09').state).toBe('ok');
    const data: CloseCheckData = {
      unusual: [{ kind: 'monto_alto', label: '$ 6.800.000 en mantenimiento', amount: 6_800_000 }],
    };
    expect(evaluateCheck('anomalias', data, '2026-09')).toMatchObject({
      state: 'pendiente',
      count: 1,
    });
  });

  it('una persona la puede dar por hecha con evidencia', () => {
    const auto = evaluateCheck(
      'anomalias',
      { unusual: [{ kind: 'duplicado', label: 'x', amount: 1 }] },
      '2026-09',
    );
    expect(taskReady({ key: 'anomalias', status: 'pendiente', auto })).toBe(false);
    expect(taskReady({ key: 'anomalias', status: 'hecha', auto })).toBe(true);
    expect(progressOf([{ key: 'anomalias', status: 'hecha', auto }])).toEqual({
      done: 1,
      total: 1,
    });
  });
});

describe('findUnusualMovements', () => {
  const prior = [
    ...['2026-06-10', '2026-07-10', '2026-08-10', '2026-08-25', '2026-06-25'].map((d, i) =>
      mv(`p${i}`, d, 900_000, 'mantenimiento'),
    ),
  ];

  it('marca un monto de 3 veces la mediana de su categoría', () => {
    const out = findUnusualMovements(
      [mv('a', '2026-09-12', 3_300_000, 'mantenimiento', 'Taller Rápido')],
      prior,
    );
    const high = out.filter((u) => u.kind === 'monto_alto');
    expect(high).toHaveLength(1);
    expect(high[0]).toMatchObject({ kind: 'monto_alto', amount: 3_300_000 });
    expect(high[0]?.label).toContain('3,7 veces lo habitual');
  });

  it('no alarma sin historia suficiente ni por montos chicos', () => {
    expect(findUnusualMovements([mv('a', '2026-09-12', 9_000_000, 'nuevo_rubro')], prior)).toEqual(
      [],
    );
    const cheap = Array.from({ length: 5 }, (_, i) =>
      mv(`c${i}`, '2026-08-01', 10_000, 'papeleria'),
    );
    expect(findUnusualMovements([mv('b', '2026-09-02', 90_000, 'papeleria')], cheap)).toEqual([]);
  });

  it('encuentra un posible duplicado: misma contraparte y valor en pocos días', () => {
    const out = findUnusualMovements(
      [
        mv('d1', '2026-09-12', 1_190_000, 'papeleria', 'Papelería El Cóndor'),
        mv('d2', '2026-09-14', 1_190_000, 'papeleria', 'papeleria el condor'),
        mv('d3', '2026-09-28', 1_190_000, 'papeleria', 'Papelería El Cóndor'),
      ],
      [],
    );
    expect(out.filter((u) => u.kind === 'duplicado')).toHaveLength(1);
    expect(out[0]?.ids).toEqual(['d1', 'd2']);
  });

  it('marca una categoría disparada contra el promedio de los meses anteriores', () => {
    const hist = [
      mv('h1', '2026-07-05', 1_000_000, 'mercadeo'),
      mv('h2', '2026-08-05', 1_000_000, 'mercadeo'),
    ];
    const out = findUnusualMovements(
      [
        mv('m1', '2026-09-03', 1_500_000, 'mercadeo'),
        mv('m2', '2026-09-20', 1_600_000, 'mercadeo'),
      ],
      hist,
    );
    expect(out.map((u) => u.kind)).toContain('categoria_disparada');
    expect(out.find((u) => u.kind === 'categoria_disparada')?.label).toContain(
      '$ 3.100.000 este mes contra $ 1.000.000 en promedio',
    );
  });

  it('ignora entradas de plata', () => {
    const inc: MovementLite = { ...mv('i', '2026-09-03', 90_000_000, 'ventas'), direction: 'in' };
    expect(findUnusualMovements([inc], prior)).toEqual([]);
  });
});

describe('la lista nueva', () => {
  it('trae las tres revisiones nuevas y respeta módulos apagados', () => {
    const all = tasksFor(new Set(['finance', 'payables', 'sales'])).map((t) => t.key);
    expect(all).toEqual(
      expect.arrayContaining(['conciliacion_cuentas', 'facturas_emitidas', 'anomalias']),
    );
    const noSales = tasksFor(new Set(['finance'])).map((t) => t.key);
    expect(noSales).not.toContain('facturas_emitidas');
    const noFinance = tasksFor(new Set()).map((t) => t.key);
    expect(noFinance).not.toContain('anomalias');
    expect(noFinance).toContain('conciliacion_cuentas');
  });

  it('cada tarea tiene su «Pídeselo a Cortex» con una frase lista', () => {
    for (const t of tasksFor(
      new Set(['finance', 'payables', 'sales', 'payroll', 'taxes', 'inventory']),
    ))
      expect(t.fix.prompt.length).toBeGreaterThan(10);
  });
});
