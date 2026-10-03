import { describe, expect, it } from 'vitest';
import { buildWithholdingCertificates } from './certificates';
import {
  DRAFT_DISCLAIMER,
  type DraftFigures,
  type PurchaseDocInput,
  type SaleDocInput,
  allLines,
  lineAmount,
} from './draft-shape';
import {
  buildIcaDraft,
  buildIvaDraft,
  buildRentaDraft,
  buildRetencionDraft,
  buildSimpleAnticipoDraft,
  draftMarkdown,
  draftTargetFor,
} from './drafts';
import { buildExogena, exogenaCsv } from './exogena';
import { patrimonioTest, transferPricingTest, uvtFor, withholdingRate } from './rates-co';

/**
 * Los borradores con un bimestre inventado (septiembre–octubre de 2026):
 * ventas al 19 %, 5 %, 0 % y excluidas, una nota crédito, compras con y sin
 * IVA discriminado, retenciones de varios conceptos.
 */

const P = { from: '2026-09-01', to: '2026-10-31', label: 'Septiembre–octubre 2026' };
const BUILT = '2026-11-02T12:00:00Z';

const sale = (o: Partial<SaleDocInput> & Pick<SaleDocInput, 'id' | 'lines'>): SaleDocInput => ({
  number: o.id.toUpperCase(),
  date: '2026-09-15',
  clientName: 'Comercial Andina',
  clientNit: '800111222',
  kind: 'invoice',
  withholdings: {},
  ...o,
});

const purchase = (
  o: Partial<PurchaseDocInput> & Pick<PurchaseDocInput, 'id' | 'total'>,
): PurchaseDocInput => ({
  number: o.id.toUpperCase(),
  date: '2026-09-20',
  supplierId: 's1',
  supplierName: 'Ferretería Central',
  supplierNit: '900555666',
  kind: 'invoice',
  subtotal: null,
  iva: 0,
  retefuente: 0,
  reteiva: 0,
  reteica: 0,
  concept: null,
  pendingApproval: false,
  ...o,
});

const SALES: SaleDocInput[] = [
  sale({
    id: 'fe-1',
    lines: [
      { rate: 'iva_19', base: 1_000_000, iva: 190_000 },
      { rate: 'iva_5', base: 200_000, iva: 10_000 },
    ],
    withholdings: { retefuentePct: 4, reteivaPct: 15, reteicaPerMil: 9.66 },
  }),
  sale({ id: 'fe-2', date: '2026-10-03', lines: [{ rate: 'iva_0', base: 300_000, iva: 0 }] }),
  sale({ id: 'fe-3', date: '2026-10-10', lines: [{ rate: 'excluido', base: 150_000, iva: 0 }] }),
  // Nota crédito de parte de FE-1: devuelve 100.000 de base al 19 %.
  sale({
    id: 'nc-1',
    kind: 'credit_note',
    date: '2026-10-20',
    lines: [{ rate: 'iva_19', base: 100_000, iva: 19_000 }],
  }),
  // Fuera del periodo: no cuenta.
  sale({
    id: 'fe-0',
    date: '2026-08-30',
    lines: [{ rate: 'iva_19', base: 999_000, iva: 189_810 }],
  }),
];

const PURCHASES: PurchaseDocInput[] = [
  purchase({
    id: 'c-1',
    subtotal: 400_000,
    iva: 76_000,
    total: 476_000,
    retefuente: 10_000,
    reteiva: 11_400,
    concept: 'compras',
  }),
  purchase({
    id: 'c-2',
    supplierName: 'Asesores SAS',
    supplierNit: '901000111',
    subtotal: 1_000_000,
    iva: 190_000,
    total: 1_190_000,
    retefuente: 110_000,
    concept: null, // se deduce por la tarifa (11 % → honorarios)
    reteica: 9_660,
  }),
  // Sin IVA discriminado: falta dato.
  purchase({ id: 'c-3', total: 250_000, supplierName: 'Papelería', supplierNit: '901222333' }),
  // Nota crédito de proveedor: resta IVA descontable.
  purchase({ id: 'nc-p', kind: 'credit_note', subtotal: 50_000, iva: 9_500, total: 59_500 }),
  // Sin aprobar todavía, servicios por encima de la base sin retención.
  purchase({
    id: 'c-4',
    supplierName: 'Aseo Total',
    supplierNit: '901444555',
    subtotal: 2_000_000,
    iva: 380_000,
    total: 2_380_000,
    concept: 'servicios',
    pendingApproval: true,
    date: '2026-10-05',
  }),
];

/** Todo renglón con fuentes vale la suma de sus fuentes. */
function expectTraceable(f: DraftFigures) {
  for (const l of allLines(f)) {
    if (l.derived) {
      expect(l.sources, l.key).toHaveLength(0);
      continue;
    }
    const sum = Math.round(l.sources.reduce((s, x) => s + x.amount, 0) * 100) / 100;
    expect(l.amount, l.key).toBeCloseTo(sum, 2);
  }
  expect(f.disclaimer).toBe(DRAFT_DISCLAIMER);
}

describe('del calendario al periodo del borrador', () => {
  it('lee la llave de cada obligación', () => {
    expect(draftTargetFor({ kind: 'iva', key: 'iva:b5', year: 2026 })?.period).toEqual({
      from: '2026-09-01',
      to: '2026-10-31',
      label: 'Septiembre–octubre 2026',
    });
    expect(draftTargetFor({ kind: 'iva', key: 'iva:c2', year: 2026 })?.period.from).toBe(
      '2026-05-01',
    );
    expect(draftTargetFor({ kind: 'iva', key: 'iva:c2', year: 2026 })?.period.to).toBe(
      '2026-08-31',
    );
    expect(
      draftTargetFor({ kind: 'retencion', key: 'retencion:2026-02', year: 2026 })?.period.to,
    ).toBe('2026-02-28');
    expect(draftTargetFor({ kind: 'ica', key: 'ica:bog-b4', year: 2026 })?.period.from).toBe(
      '2026-07-01',
    );
    expect(draftTargetFor({ kind: 'ica', key: 'ica:med-anual-2025', year: 2026 })?.period.to).toBe(
      '2025-12-31',
    );
    expect(
      draftTargetFor({ kind: 'simple_anticipo', key: 'simple_anticipo:b6', year: 2026 })?.period
        .from,
    ).toBe('2026-11-01');
    expect(draftTargetFor({ kind: 'renta', key: 'renta:pj-dec', year: 2026 })?.period.label).toBe(
      'Año gravable 2025',
    );
    expect(draftTargetFor({ kind: 'pila', key: 'pila:2026-09', year: 2026 })).toBeNull();
    expect(draftTargetFor({ kind: 'exogena', key: 'exogena:anual', year: 2026 })).toBeNull();
  });
});

describe('IVA bimestral', () => {
  const f = buildIvaDraft({
    period: P,
    sales: SALES,
    purchases: PURCHASES,
    accountingSales: [
      {
        id: 'a1',
        number: 'FV-77',
        date: '2026-09-05',
        clientName: 'Otro',
        total: 119_000,
        provider: 'siigo',
      },
    ],
    unrecordedSupplierCreditNotes: 1,
    builtAt: BUILT,
  });

  it('separa las bases por tarifa y resta la nota crédito donde va', () => {
    expect(lineAmount(f, 'base_19')).toBe(900_000);
    expect(lineAmount(f, 'base_5')).toBe(200_000);
    expect(lineAmount(f, 'base_exentas')).toBe(300_000);
    expect(lineAmount(f, 'base_excluidas')).toBe(150_000);
    expect(lineAmount(f, 'total_ingresos')).toBe(1_550_000);
    const nc = allLines(f)
      .find((l) => l.key === 'base_19')
      ?.sources.find((s) => s.kind === 'nota_credito_venta');
    expect(nc?.amount).toBe(-100_000);
  });

  it('calcula el IVA generado, el descontable y el saldo', () => {
    expect(lineAmount(f, 'iva_generado_19')).toBe(171_000);
    expect(lineAmount(f, 'iva_generado_5')).toBe(10_000);
    expect(lineAmount(f, 'total_generado')).toBe(181_000);
    // 76.000 + 190.000 + 380.000 − 9.500 (nota crédito del proveedor)
    expect(lineAmount(f, 'iva_descontable_compras')).toBe(636_500);
    // ReteIVA estimada: 15 % del IVA de FE-1 (200.000).
    expect(lineAmount(f, 'reteiva_clientes')).toBe(30_000);
    expect(f.result.amount).toBe(181_000 - 636_500 - 30_000);
    expect(f.result.direction).toBe('favor');
    expect(f.result.label).toBe('Saldo a favor');
  });

  it('cada renglón cuadra con su detalle', () => expectTraceable(f));

  it('dice qué falta, con las facturas que lo prueban', () => {
    const codes = f.missing.map((m) => m.code);
    expect(codes).toContain('compras_sin_iva');
    expect(f.missing.find((m) => m.code === 'compras_sin_iva')?.message).toMatch(
      /^1 factura de compra sin IVA/,
    );
    expect(f.missing.find((m) => m.code === 'compras_sin_iva')?.refs[0]?.id).toBe('c-3');
    expect(codes).toContain('compras_sin_aprobar');
    expect(codes).toContain('ventas_programa_contable');
    expect(codes).toContain('notas_credito_proveedor');
  });

  it('pide prorratear cuando hubo exentas o excluidas', () => {
    const l = allLines(f).find((x) => x.key === 'iva_descontable_compras');
    expect(l?.needsConfirmation).toBe(true);
    expect(l?.note).toMatch(/art\. 490/);
    expect(f.needsConfirmation).toBe(true);
  });

  it('se cuenta en texto con la advertencia', () => {
    const md = draftMarkdown(f);
    expect(md).toContain('Borrador — tu contador revisa y presenta');
    expect(md).toContain('Saldo a favor');
  });
});

describe('Retención en la fuente mensual', () => {
  const sep = { from: '2026-09-01', to: '2026-09-30', label: 'Septiembre 2026' };
  const f = buildRetencionDraft({
    period: sep,
    purchases: PURCHASES,
    sales: SALES,
    salaries: { total: 845_000, base: 12_000_000, employees: 4, source: 'Nómina de Cortex' },
    hasEmployees: true,
    autorretencionRate: 0.8,
    uvt: uvtFor(2026),
    builtAt: BUILT,
  });

  it('agrupa por concepto, deduciendo el que falta por la tarifa', () => {
    expect(lineAmount(f, 'rf_compras')).toBe(10_000);
    expect(lineAmount(f, 'rf_honorarios')).toBe(110_000);
    const hon = allLines(f).find((l) => l.key === 'rf_honorarios');
    expect(hon?.note).toMatch(/deducido por la tarifa/);
    expect(lineAmount(f, 'rf_salarios')).toBe(845_000);
    // 0,8 % de 1.200.000 (FE-1 en septiembre); FE-2 y la NC son de octubre.
    expect(lineAmount(f, 'autorretencion_especial')).toBe(9_600);
    expect(lineAmount(f, 'total_renta')).toBe(10_000 + 110_000 + 845_000 + 9_600);
    expect(lineAmount(f, 'reteiva_practicada')).toBe(11_400);
    expect(f.result.amount).toBe(10_000 + 110_000 + 845_000 + 9_600 + 11_400);
  });

  it('la nómina va como un solo total, sin detalle por persona', () => {
    const l = allLines(f).find((x) => x.key === 'rf_salarios');
    expect(l?.sources).toHaveLength(1);
    expect(l?.sources[0]?.kind).toBe('nomina');
    expect(l?.sources[0]?.label).toMatch(/confidencial/);
  });

  it('cada renglón cuadra con su detalle', () => expectTraceable(f));

  it('el reteICA no entra al 350 pero se nombra', () => {
    expect(f.notes.join(' ')).toMatch(/ReteICA practicada: \$ 9\.660/);
  });

  it('sin nómina en Cortex lo dice como dato faltante', () => {
    const g = buildRetencionDraft({
      period: { from: '2026-10-01', to: '2026-10-31', label: 'Octubre 2026' },
      purchases: PURCHASES,
      sales: SALES,
      salaries: null,
      hasEmployees: true,
      autorretencionRate: null,
      uvt: uvtFor(2026),
      builtAt: BUILT,
    });
    expect(g.missing.map((m) => m.code)).toContain('retencion_salarios');
    // Aseo Total: servicios por 2.000.000 (> 2 UVT) sin retención anotada.
    const skipped = g.missing.find((m) => m.code === 'sin_retencion');
    expect(skipped?.refs.map((r) => r.id)).toEqual(['c-4']);
    expectTraceable(g);
  });
});

describe('ICA, Simple y renta', () => {
  it('ICA con una actividad: base × tarifa por mil, menos el reteICA estimado', () => {
    const f = buildIcaDraft({
      period: P,
      sales: SALES,
      activities: [{ code: '4711', label: 'Comercio al por menor', ratePerMil: 11.04 }],
      cityLabel: 'Bogotá',
      builtAt: BUILT,
    });
    expect(lineAmount(f, 'ingresos_brutos')).toBe(1_550_000);
    expect(lineAmount(f, 'total_ica')).toBeCloseTo(1_550_000 * 0.01104, 0);
    expect(lineAmount(f, 'reteica_clientes')).toBeCloseTo(1_200_000 * 0.00966, 2);
    expectTraceable(f);
  });

  it('ICA sin actividad: no inventa la tarifa', () => {
    const f = buildIcaDraft({
      period: P,
      sales: SALES,
      activities: [],
      cityLabel: null,
      builtAt: BUILT,
    });
    expect(f.missing.map((m) => m.code)).toContain('ica_sin_actividad');
    expect(f.result.amount).toBe(0);
  });

  it('Simple: sin tarifa no hay anticipo; con tarifa sí', () => {
    const none = buildSimpleAnticipoDraft({
      period: P,
      sales: SALES,
      simpleRate: null,
      builtAt: BUILT,
    });
    expect(none.missing.map((m) => m.code)).toContain('tarifa_simple');
    const f = buildSimpleAnticipoDraft({
      period: P,
      sales: SALES,
      simpleRate: 5.9,
      builtAt: BUILT,
    });
    expect(f.result.amount).toBeCloseTo(1_550_000 * 0.059, 0);
    expectTraceable(f);
  });

  it('Renta PJ: 35 % de la renta líquida estimada menos retenciones estimadas', () => {
    const months = Array.from({ length: 12 }, (_, i) => ({
      month: `2025-${String(i + 1).padStart(2, '0')}`,
      ingresos: 10_000_000,
      otrosIngresos: 0,
      costo: 4_000_000,
      gastos: 3_000_000,
    }));
    const f = buildRentaDraft({
      year: 2025,
      period: { from: '2025-01-01', to: '2025-12-31', label: 'Año gravable 2025' },
      personType: 'juridica',
      months,
      providerPnl: null,
      sales: [
        sale({
          id: 'fe-r',
          date: '2025-06-01',
          lines: [{ rate: 'iva_19', base: 5_000_000, iva: 950_000 }],
          withholdings: { retefuentePct: 4 },
        }),
      ],
      builtAt: BUILT,
    });
    expect(lineAmount(f, 'renta_liquida')).toBe(36_000_000);
    expect(lineAmount(f, 'impuesto')).toBe(12_600_000);
    expect(lineAmount(f, 'retenciones_a_favor')).toBe(200_000);
    expect(f.result.amount).toBe(12_400_000);
    expect(allLines(f).find((l) => l.key === 'ingresos')?.sources).toHaveLength(12);
    expect(f.missing.map((m) => m.code)).toContain('anticipos');
    expectTraceable(f);
  });

  it('Renta con el programa contable: manda su estado de resultados', () => {
    const f = buildRentaDraft({
      year: 2025,
      period: { from: '2025-01-01', to: '2025-12-31', label: 'Año gravable 2025' },
      personType: 'natural',
      months: [],
      providerPnl: {
        provider: 'siigo',
        from: '2025-01-01',
        to: '2025-12-31',
        revenue: 100,
        otherIncome: 0,
        costOfSales: 40,
        operatingExpenses: 20,
        otherExpenses: 10,
      },
      sales: [],
      builtAt: BUILT,
    });
    expect(lineAmount(f, 'renta_liquida')).toBe(30);
    expect(f.basis).toMatch(/siigo/);
    expect(f.missing.map((m) => m.code)).toContain('renta_persona_natural');
    expectTraceable(f);
  });
});

describe('certificados de retención', () => {
  it('uno por proveedor, con las facturas detrás y la nota crédito restando', () => {
    const extra = purchase({
      id: 'c-5',
      date: '2026-03-10',
      subtotal: 500_000,
      iva: 95_000,
      total: 595_000,
      retefuente: 12_500,
      concept: 'compras',
    });
    const certs = buildWithholdingCertificates([...PURCHASES, extra], {
      kind: 'renta',
      year: 2026,
    });
    const fc = certs.find((c) => c.supplierNit === '900555666');
    expect(fc?.withheld).toBe(22_500);
    expect(fc?.base).toBe(900_000);
    expect(fc?.sources.map((s) => s.docNumber)).toEqual(['C-5', 'C-1']);
    const ases = certs.find((c) => c.supplierNit === '901000111');
    expect(ases?.concept).toBe('Honorarios');
    const iva = buildWithholdingCertificates(PURCHASES, { kind: 'iva', year: 2026, period: 5 });
    expect(iva).toHaveLength(1);
    expect(iva[0]?.withheld).toBe(11_400);
    expect(iva[0]?.concept).toBe('15 % del IVA');
    expect(
      buildWithholdingCertificates(PURCHASES, { kind: 'iva', year: 2026, period: 4 }),
    ).toHaveLength(0);
  });
});

describe('exógena', () => {
  it('arma 1001, 1007, 1008 y 1009 por tercero', () => {
    const formats = buildExogena({
      year: 2026,
      purchases: PURCHASES.map((p) => ({ ...p, paidAt: p.id === 'c-1' ? '2026-10-01' : null })),
      sales: SALES,
      receivables: [
        {
          id: 'r1',
          thirdNit: '800111222',
          thirdName: 'Comercial Andina',
          date: '2026-11-01',
          amount: 500_000,
          settledAt: null,
        },
        {
          id: 'r2',
          thirdNit: '800111222',
          thirdName: 'Comercial Andina',
          date: '2026-11-02',
          amount: 300_000,
          settledAt: '2026-12-15',
        },
      ],
    });
    const by = Object.fromEntries(formats.map((f) => [f.code, f]));
    const honorarios = by['1001']?.rows.find((r) => r[2] === '901000111');
    expect(honorarios?.[0]).toBe('5002');
    expect(honorarios?.[7]).toBe(110_000);
    const andina = by['1007']?.rows.find((r) => r[2] === '800111222');
    // 1.200.000 + 300.000 + 150.000 + 999.000 (agosto también es del año); devoluciones 100.000.
    expect(andina?.[5]).toBe(2_649_000);
    expect(andina?.[6]).toBe(100_000);
    expect(by['1008']?.total).toBe(500_000);
    // c-1 se pagó; quedan c-2, c-3 y c-4 netos de retenciones.
    expect(by['1009']?.rows).toHaveLength(3);
    const csv = exogenaCsv(by['1001'] as NonNullable<(typeof by)['1001']>);
    expect(csv).toContain('por confirmar');
    expect(csv).toContain('Borrador — tu contador revisa y presenta');
  });
});

describe('tarifas y topes', () => {
  it('la tabla de retención cambia por fecha (Decreto 572 y su suspensión) y siempre va por confirmar', () => {
    expect(withholdingRate('compras', '2026-05-20')?.baseUvt).toBe(27);
    expect(withholdingRate('compras', '2026-07-15')?.baseUvt).toBe(10);
    expect(withholdingRate('servicios', '2026-09-30')?.needsConfirmation).toBe(true);
    expect(uvtFor(2026)).toBe(52_374);
    expect(uvtFor(2019)).toBeNull();
  });

  it('patrimonio y precios de transferencia: prueba de aplicabilidad, por confirmar', () => {
    expect(
      patrimonioTest({ personType: 'natural', patrimonioLiquido: 4_000_000_000, year: 2026 })
        .applies,
    ).toBe(true);
    expect(
      patrimonioTest({ personType: 'juridica', patrimonioLiquido: 1, year: 2026 }).applies,
    ).toBeNull();
    expect(
      transferPricingTest({
        vinculadosExterior: false,
        patrimonioBruto: null,
        ingresosBrutos: null,
        year: 2026,
      }).applies,
    ).toBe(false);
    expect(
      transferPricingTest({
        vinculadosExterior: true,
        patrimonioBruto: null,
        ingresosBrutos: 3_500_000_000,
        year: 2026,
      }).applies,
    ).toBe(true);
  });
});
