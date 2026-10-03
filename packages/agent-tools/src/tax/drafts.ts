import {
  type AccountingSaleInput,
  DRAFT_DISCLAIMER,
  type DraftFigures,
  type DraftKind,
  type DraftLine,
  type DraftPeriod,
  type DraftSection,
  type DraftTarget,
  type ForeignDocInput,
  type IvaRateKey,
  type LedgerIncomeInput,
  type MissingItem,
  type PurchaseDocInput,
  type SalaryWithholdingInput,
  type SaleDocInput,
  type SourceRef,
  allLines,
  resultOf,
  round2,
  sumAmounts,
} from './draft-shape';
import {
  RENTA_PJ_RATE,
  TAX_RATES_VERSION,
  WITHHOLDING_CONCEPTS,
  WITHHOLDING_CONCEPT_LABEL,
  type WithholdingConcept,
  conceptFromRate,
  withholdingRate,
} from './rates-co';
import { type ObligationKind, monthLong } from './shape';

/**
 * LOS CONSTRUCTORES DE BORRADORES. PUROS.
 *
 * Reciben lo que draft-sources.ts leyó (ventas, compras, movimientos, meses del
 * estado de resultados) y devuelven `DraftFigures`: secciones, renglones con
 * sus fuentes, el resultado y la lista de «datos que faltan». No leen la base
 * ni el reloj (`builtAt` llega de afuera).
 *
 * Tres reglas:
 *   1. TODO RENGLÓN CON FUENTES VALE LA SUMA DE SUS FUENTES. Un impuesto
 *      calculado (autorretención, ICA, anticipo) se calcula fuente por fuente
 *      y se suma, para que el detalle y el total no difieran por redondeo.
 *   2. LO QUE NO SE PUEDE SUMAR NO SE ADIVINA: va a `missing` con las fuentes
 *      que lo prueban («3 facturas de compra sin IVA discriminado»).
 *   3. LO ESTIMADO SE DICE: un renglón con una tarifa por confirmar o una
 *      retención estimada con el % pactado lleva `needsConfirmation`.
 */

// ---------------------------------------------------------------------------
// Del calendario al periodo
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

function lastDay(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(d)}`;
}

function monthsPeriod(year: number, fromMonth: number, toMonth: number): DraftPeriod {
  const label =
    fromMonth === toMonth
      ? `${cap(monthLong(fromMonth))} ${year}`
      : `${cap(monthLong(fromMonth))}–${monthLong(toMonth)} ${year}`;
  return { from: `${year}-${pad(fromMonth)}-01`, to: lastDay(year, toMonth), label };
}

function cap(s: string): string {
  return s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s;
}

/**
 * Qué borrador sale de una obligación del calendario, y de qué periodo. Lee la
 * llave natural que arma el motor (engine.ts): «iva:b5», «retencion:2026-09»,
 * «ica:bog-b4», «simple_anticipo:b3», «renta:pj-dec». null = esa obligación no
 * tiene borrador (exógena, PILA, Cámara de Comercio…).
 */
export function draftTargetFor(o: {
  kind: ObligationKind;
  key: string;
  year: number;
}): DraftTarget | null {
  const [, code = ''] = o.key.split(':');
  const bim = code.match(/(?:^|-)b(\d)$/);
  if (o.kind === 'iva') {
    if (code === 'simple-anual') return { kind: 'iva', period: monthsPeriod(o.year - 1, 1, 12) };
    const c = code.match(/^c(\d)$/);
    if (c) {
      const n = Number(c[1]);
      return { kind: 'iva', period: monthsPeriod(o.year, 4 * n - 3, 4 * n) };
    }
    if (bim) {
      const n = Number(bim[1]);
      return { kind: 'iva', period: monthsPeriod(o.year, 2 * n - 1, 2 * n) };
    }
    return null;
  }
  if (o.kind === 'retencion') {
    const m = code.match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const month = Number(m[2]);
    return { kind: 'retencion', period: monthsPeriod(Number(m[1]), month, month) };
  }
  if (o.kind === 'simple_anticipo') {
    if (!bim) return null;
    const n = Number(bim[1]);
    return { kind: 'simple_anticipo', period: monthsPeriod(o.year, 2 * n - 1, 2 * n) };
  }
  if (o.kind === 'ica') {
    if (bim) {
      const n = Number(bim[1]);
      return { kind: 'ica', period: monthsPeriod(o.year, 2 * n - 1, 2 * n) };
    }
    const anual = code.match(/anual-(\d{4})$/);
    if (anual) return { kind: 'ica', period: monthsPeriod(Number(anual[1]), 1, 12) };
    return null;
  }
  if (o.kind === 'renta') {
    return {
      kind: 'renta',
      period: { ...monthsPeriod(o.year - 1, 1, 12), label: `Año gravable ${o.year - 1}` },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

const money = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;

function saleRef(doc: SaleDocInput, amount: number): SourceRef {
  const credit = doc.kind === 'credit_note';
  return {
    kind: credit ? 'nota_credito_venta' : 'venta',
    id: doc.id,
    label: `${credit ? 'Nota crédito ' : ''}${doc.number} · ${doc.clientName}`,
    date: doc.date,
    amount: round2(credit ? -Math.abs(amount) : amount),
    path: doc.path ?? null,
  };
}

function purchaseRef(doc: PurchaseDocInput, amount: number): SourceRef {
  const credit = doc.kind === 'credit_note';
  return {
    kind: credit ? 'nota_credito_compra' : 'compra',
    id: doc.id,
    label: `${credit ? 'Nota crédito ' : ''}${doc.number} · ${doc.supplierName}`,
    date: doc.date,
    amount: round2(credit ? -Math.abs(amount) : amount),
    path: doc.path ?? null,
  };
}

function line(
  key: string,
  label: string,
  sources: SourceRef[],
  extra: Partial<DraftLine> = {},
): DraftLine {
  const kept = sources.filter((s) => Math.abs(s.amount) > 0.004);
  return { key, label, amount: sumAmounts(kept), sources: kept, ...extra };
}

function derived(key: string, label: string, amount: number, formula: string): DraftLine {
  return { key, label, amount: round2(amount), sources: [], derived: true, formula };
}

function missing(
  code: string,
  message: string,
  refs: SourceRef[],
  count = refs.length,
): MissingItem {
  return { code, message, count, refs };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** La base de una venta para una tarifa (suma de sus líneas de esa tarifa). */
function saleBase(doc: SaleDocInput, rate?: IvaRateKey): number {
  return round2(doc.lines.filter((l) => !rate || l.rate === rate).reduce((s, l) => s + l.base, 0));
}

function saleIva(doc: SaleDocInput, rate?: IvaRateKey): number {
  return round2(doc.lines.filter((l) => !rate || l.rate === rate).reduce((s, l) => s + l.iva, 0));
}

/** Base sin IVA de una compra: el subtotal, o total − IVA si no viene. */
function purchaseBase(doc: PurchaseDocInput): number {
  return round2(doc.subtotal ?? Math.max(0, doc.total - doc.iva));
}

function inPeriod<T extends { date: string }>(rows: T[], p: DraftPeriod): T[] {
  return rows.filter((r) => r.date >= p.from && r.date <= p.to);
}

function frame(
  kind: DraftKind,
  title: string,
  period: DraftPeriod,
  basis: string,
  builtAt: string,
  sections: DraftSection[],
  result: DraftFigures['result'],
  missingItems: MissingItem[],
  notes: string[],
): DraftFigures {
  const sectionsKept = sections.filter((s) => s.lines.length > 0);
  return {
    kind,
    title,
    period,
    currency: 'COP',
    rulesVersion: TAX_RATES_VERSION,
    disclaimer: DRAFT_DISCLAIMER,
    basis,
    sections: sectionsKept,
    result,
    missing: missingItems.filter((m) => m.count > 0),
    notes,
    needsConfirmation: allLines({ sections: sectionsKept }).some((l) => l.needsConfirmation),
    builtAt,
  };
}

/** Lo que es común a casi todos: compras sin IVA, ventas del programa, otra moneda… */
export interface CommonGaps {
  accountingSales?: AccountingSaleInput[];
  ledgerIncomeWithoutInvoice?: LedgerIncomeInput[];
  foreign?: ForeignDocInput[];
  uncertainSales?: Array<{ id: string; label: string; date: string; amount: number }>;
}

function commonMissing(gaps: CommonGaps, period: DraftPeriod): MissingItem[] {
  const out: MissingItem[] = [];
  const acc = inPeriod(gaps.accountingSales ?? [], period);
  if (acc.length)
    out.push(
      missing(
        'ventas_programa_contable',
        `${plural(acc.length, 'factura de venta', 'facturas de venta')} del programa contable sin IVA discriminado (${money(sumAmounts(acc.map((a) => ({ amount: a.total }))))} en total): no están sumadas; tómalas del reporte de IVA del programa.`,
        acc.map((a) => ({
          kind: 'contable',
          id: a.id,
          label: `${a.number}${a.clientName ? ` · ${a.clientName}` : ''} (${a.provider})`,
          date: a.date,
          amount: a.total,
        })),
      ),
    );
  const led = inPeriod(gaps.ledgerIncomeWithoutInvoice ?? [], period);
  if (led.length)
    out.push(
      missing(
        'ingresos_sin_factura',
        `${plural(led.length, 'ingreso', 'ingresos')} en el banco o el libro sin factura (${money(sumAmounts(led))}): si son ventas, falta facturarlas o registrarlas.`,
        led.map((m) => ({
          kind: 'libro',
          id: m.id,
          label: `${m.description}${m.counterparty ? ` · ${m.counterparty}` : ''}`,
          date: m.date,
          amount: m.amount,
        })),
      ),
    );
  const fx = inPeriod(gaps.foreign ?? [], period);
  if (fx.length)
    out.push(
      missing(
        'otra_moneda',
        `${plural(fx.length, 'documento', 'documentos')} en otra moneda no se sumaron: hay que convertirlos con la TRM de su fecha.`,
        fx.map((d) => ({
          kind: 'compra',
          id: d.id,
          label: `${d.label} (${d.currency})`,
          date: d.date,
          amount: d.amount,
        })),
      ),
    );
  const unc = inPeriod(gaps.uncertainSales ?? [], period);
  if (unc.length)
    out.push(
      missing(
        'ventas_sin_confirmar',
        `${plural(unc.length, 'factura de venta', 'facturas de venta')} sin emisión confirmada ante la DIAN (error o en proceso): no se sumaron.`,
        unc.map((u) => ({
          kind: 'venta',
          id: u.id,
          label: u.label,
          date: u.date,
          amount: u.amount,
        })),
      ),
    );
  return out;
}

// ---------------------------------------------------------------------------
// IVA
// ---------------------------------------------------------------------------

export interface IvaDraftInput extends CommonGaps {
  period: DraftPeriod;
  sales: SaleDocInput[];
  purchases: PurchaseDocInput[];
  /** Notas crédito de proveedores que llegaron por correo y no se anotaron. */
  unrecordedSupplierCreditNotes?: number;
  builtAt: string;
}

const RATE_LINES: Array<{ rate: IvaRateKey; key: string; label: string }> = [
  { rate: 'iva_19', key: 'base_19', label: 'Ventas gravadas al 19 %' },
  { rate: 'iva_5', key: 'base_5', label: 'Ventas gravadas al 5 %' },
  { rate: 'iva_0', key: 'base_exentas', label: 'Ventas exentas (0 %)' },
  { rate: 'excluido', key: 'base_excluidas', label: 'Ventas excluidas (no causan IVA)' },
];

export function buildIvaDraft(input: IvaDraftInput): DraftFigures {
  const p = input.period;
  const sales = inPeriod(input.sales, p);
  const purchases = inPeriod(input.purchases, p);

  const bases = RATE_LINES.map((r) =>
    line(
      r.key,
      r.label,
      sales.map((d) => saleRef(d, saleBase(d, r.rate))),
    ),
  );
  const totalBases = round2(bases.reduce((s, l) => s + l.amount, 0));
  const ingresos: DraftSection = {
    key: 'ingresos',
    label: 'Ingresos del periodo (bases, netas de notas crédito)',
    lines: [...bases, derived('total_ingresos', 'Total ingresos', totalBases, 'Suma de las bases')],
  };

  const gen19 = line(
    'iva_generado_19',
    'IVA generado al 19 %',
    sales.map((d) => saleRef(d, saleIva(d, 'iva_19'))),
    { base: bases[0]?.amount ?? 0, rate: 19 },
  );
  const gen5 = line(
    'iva_generado_5',
    'IVA generado al 5 %',
    sales.map((d) => saleRef(d, saleIva(d, 'iva_5'))),
    { base: bases[1]?.amount ?? 0, rate: 5 },
  );
  const totalGen = round2(gen19.amount + gen5.amount);
  const generado: DraftSection = {
    key: 'generado',
    label: 'IVA generado',
    lines: [gen19, gen5, derived('total_generado', 'Total IVA generado', totalGen, '19 % + 5 %')],
  };

  const descontableLine = line(
    'iva_descontable_compras',
    'IVA de compras y gastos (facturas de proveedor)',
    purchases.map((d) => purchaseRef(d, d.iva)),
  );
  const exemptOrExcluded = (bases[2]?.amount ?? 0) + (bases[3]?.amount ?? 0);
  if (exemptOrExcluded > 0 && descontableLine.amount > 0) {
    descontableLine.needsConfirmation = true;
    descontableLine.note =
      'Hubo ventas exentas o excluidas: el IVA de compras comunes se prorratea (art. 490 ET). Tu contador decide la proporción.';
  }
  const descontable: DraftSection = {
    key: 'descontable',
    label: 'IVA descontable',
    lines: [
      descontableLine,
      derived(
        'total_descontable',
        'Total IVA descontable',
        descontableLine.amount,
        'IVA de compras',
      ),
    ],
  };

  const reteiva = line(
    'reteiva_clientes',
    'Retenciones de IVA que te practicaron los clientes (estimadas)',
    sales
      .filter((d) => (d.withholdings.reteivaPct ?? 0) > 0)
      .map((d) => saleRef(d, (saleIva(d) * (d.withholdings.reteivaPct ?? 0)) / 100)),
    {
      needsConfirmation: true,
      note: 'Estimadas con el % pactado en cada factura. Confírmalas con los certificados de tus clientes.',
    },
  );
  const retenciones: DraftSection = {
    key: 'retenciones',
    label: 'Retenciones de IVA a tu favor',
    lines: reteiva.sources.length ? [reteiva] : [],
  };

  const saldo = totalGen - descontableLine.amount - reteiva.amount;
  const result = resultOf(saldo >= 0 ? 'Saldo a pagar' : 'Saldo a favor', saldo);

  const miss: MissingItem[] = [];
  const noIva = purchases.filter((d) => d.subtotal === null && d.iva === 0 && d.kind === 'invoice');
  miss.push(
    missing(
      'compras_sin_iva',
      `${plural(noIva.length, 'factura de compra', 'facturas de compra')} sin IVA discriminado: si tenían IVA, falta descontarlo.`,
      noIva.map((d) => purchaseRef(d, d.total)),
    ),
  );
  const pending = purchases.filter((d) => d.pendingApproval);
  miss.push(
    missing(
      'compras_sin_aprobar',
      `${plural(pending.length, 'factura de compra', 'facturas de compra')} todavía sin aprobar (sí están sumadas): confirma que se recibieron.`,
      pending.map((d) => purchaseRef(d, d.iva)),
    ),
  );
  if ((input.unrecordedSupplierCreditNotes ?? 0) > 0)
    miss.push(
      missing(
        'notas_credito_proveedor',
        (input.unrecordedSupplierCreditNotes ?? 0) === 1
          ? '1 nota crédito de un proveedor llegó por correo y no se anotó: su IVA resta del descontable.'
          : `${input.unrecordedSupplierCreditNotes} notas crédito de proveedores llegaron por correo y no se anotaron: su IVA resta del descontable.`,
        [],
        input.unrecordedSupplierCreditNotes,
      ),
    );
  miss.push(...commonMissing(input, p));

  return frame(
    'iva',
    `IVA — ${p.label}`,
    p,
    'Causación: por la fecha de la factura',
    input.builtAt,
    [ingresos, generado, descontable, retenciones],
    result,
    miss,
    [
      'Las notas crédito restan en el renglón de su tarifa y aparecen en el detalle con signo negativo.',
      'No incluye IVA de importaciones, IVA asumido en régimen simple ni ajustes de periodos anteriores.',
    ],
  );
}

// ---------------------------------------------------------------------------
// Retención en la fuente (mensual)
// ---------------------------------------------------------------------------

export interface RetencionDraftInput {
  period: DraftPeriod;
  purchases: PurchaseDocInput[];
  /** Ventas del mes: base de la autorretención especial. */
  sales: SaleDocInput[];
  /** Retención por salarios, si la nómina está en Cortex. */
  salaries: SalaryWithholdingInput | null;
  /** La empresa tiene empleados (PILA o nómina electrónica en el perfil). */
  hasEmployees: boolean;
  /** Tarifa de autorretención especial (%) del perfil, o null. */
  autorretencionRate: number | null;
  /** UVT del año, para la base mínima. */
  uvt: number | null;
  builtAt: string;
}

export function resolveConcept(d: PurchaseDocInput): {
  concept: WithholdingConcept | null;
  inferred: boolean;
} {
  if (d.concept) return { concept: d.concept, inferred: false };
  const base = purchaseBase(d);
  if (d.retefuente > 0 && base > 0) {
    const guess = conceptFromRate((d.retefuente / base) * 100);
    if (guess) return { concept: guess, inferred: true };
  }
  return { concept: null, inferred: false };
}

export function buildRetencionDraft(input: RetencionDraftInput): DraftFigures {
  const p = input.period;
  const purchases = inPeriod(input.purchases, p).filter((d) => d.kind === 'invoice');
  const withRf = purchases.filter((d) => d.retefuente > 0);
  const resolved = withRf.map((d) => ({ d, ...resolveConcept(d) }));

  const rentaLines: DraftLine[] = [];
  for (const concept of WITHHOLDING_CONCEPTS) {
    const rows = resolved.filter((r) => r.concept === concept);
    if (!rows.length) continue;
    const rate = withholdingRate(concept, p.to);
    const inferred = rows.filter((r) => r.inferred).length;
    rentaLines.push(
      line(
        `rf_${concept}`,
        WITHHOLDING_CONCEPT_LABEL[concept],
        rows.map((r) => purchaseRef(r.d, r.d.retefuente)),
        {
          base: round2(rows.reduce((s, r) => s + purchaseBase(r.d), 0)),
          rate: rate?.rate ?? null,
          needsConfirmation: true,
          note: [
            rate
              ? `Tarifa de referencia ${String(rate.rate).replace('.', ',')} %${rate.rateNoDeclarante ? ` (${String(rate.rateNoDeclarante).replace('.', ',')} % a no declarantes)` : ''}, base mínima ${rate.baseUvt} UVT: por confirmar.`
              : null,
            inferred
              ? `${plural(inferred, 'factura tiene', 'facturas tienen')} el concepto deducido por la tarifa: confírmalo en el proveedor.`
              : null,
          ]
            .filter(Boolean)
            .join(' '),
        },
      ),
    );
  }
  const noConcept = resolved.filter((r) => r.concept === null);
  if (noConcept.length)
    rentaLines.push(
      line(
        'rf_sin_concepto',
        'Retenciones sin concepto',
        noConcept.map((r) => purchaseRef(r.d, r.d.retefuente)),
        {
          base: round2(noConcept.reduce((s, r) => s + purchaseBase(r.d), 0)),
          needsConfirmation: true,
          note: 'Ponle el concepto de retención al proveedor (compras, servicios, honorarios…) para ubicarlas.',
        },
      ),
    );

  const miss: MissingItem[] = [];
  if (input.salaries) {
    rentaLines.push(
      line(
        'rf_salarios',
        'Salarios y pagos laborales',
        [
          {
            kind: 'nomina',
            id: `nomina:${p.from}`,
            label: `Nómina de ${p.label}${input.salaries.employees ? ` (${plural(input.salaries.employees, 'persona', 'personas')})` : ''} — total; el detalle por persona es confidencial`,
            date: p.to,
            amount: input.salaries.total,
          },
        ],
        { base: input.salaries.base, note: `Fuente: ${input.salaries.source}.` },
      ),
    );
  } else if (input.hasEmployees) {
    miss.push(
      missing(
        'retencion_salarios',
        'La retención por salarios sale de la nómina, que no está en Cortex: tu contador la suma del software de nómina.',
        [],
        1,
      ),
    );
  }

  if (input.autorretencionRate && input.autorretencionRate > 0) {
    const rate = input.autorretencionRate;
    const sales = inPeriod(input.sales, p);
    rentaLines.push(
      line(
        'autorretencion_especial',
        'Autorretención especial de renta',
        sales.map((d) => saleRef(d, (saleBase(d) * rate) / 100)),
        {
          base: round2(
            sales.reduce((s, d) => s + (d.kind === 'credit_note' ? -1 : 1) * saleBase(d), 0),
          ),
          rate,
          needsConfirmation: true,
          note: 'Sobre los ingresos brutos del mes, con la tarifa del perfil (depende del CIIU; cambió el 1 de julio de 2026).',
        },
      ),
    );
  }

  const totalRenta = round2(rentaLines.reduce((s, l) => s + l.amount, 0));
  const renta: DraftSection = {
    key: 'renta',
    label: 'Retención a título de renta',
    lines: rentaLines.length
      ? [
          ...rentaLines,
          derived('total_renta', 'Total retención de renta', totalRenta, 'Suma de los conceptos'),
        ]
      : [],
  };

  const reteivaLine = line(
    'reteiva_practicada',
    'Retención de IVA practicada a proveedores',
    purchases.filter((d) => d.reteiva > 0).map((d) => purchaseRef(d, d.reteiva)),
  );
  const iva: DraftSection = {
    key: 'iva',
    label: 'Retención a título de IVA',
    lines: reteivaLine.sources.length ? [reteivaLine] : [],
  };

  // Facturas por encima de la base mínima sin retención anotada.
  if (input.uvt) {
    const uvt = input.uvt;
    const skipped = purchases.filter((d) => {
      if (d.retefuente > 0 || !d.concept) return false;
      const rate = withholdingRate(d.concept, d.date);
      return rate !== null && purchaseBase(d) >= rate.baseUvt * uvt;
    });
    miss.push(
      missing(
        'sin_retencion',
        `${plural(skipped.length, 'factura de proveedor', 'facturas de proveedor')} por encima de la base mínima sin retención anotada: o no se practicó, o falta anotarla.`,
        skipped.map((d) => purchaseRef(d, purchaseBase(d))),
      ),
    );
  }
  const noBase = withRf.filter((d) => d.subtotal === null);
  miss.push(
    missing(
      'retencion_sin_base',
      `${plural(noBase.length, 'factura', 'facturas')} con retención pero sin base discriminada (se usó total − IVA).`,
      noBase.map((d) => purchaseRef(d, d.retefuente)),
    ),
  );

  const reteica = purchases.filter((d) => d.reteica > 0);
  const notes = [
    'Se toma la fecha de la factura (causación). Si alguna se pagó antes de recibir la factura, la retención va en el mes del pago.',
    reteica.length
      ? `ReteICA practicada: ${money(sumAmounts(reteica.map((d) => ({ amount: d.reteica }))))} en ${plural(reteica.length, 'factura', 'facturas')}. Va en la declaración de ICA del municipio, no en ésta.`
      : null,
    input.autorretencionRate
      ? null
      : 'Si la empresa es autorretenedora de renta (autorretención especial), escribe la tarifa de su CIIU en el perfil tributario.',
  ].filter(Boolean) as string[];

  return frame(
    'retencion',
    `Retención en la fuente — ${p.label}`,
    p,
    'Causación: por la fecha de la factura del proveedor',
    input.builtAt,
    [renta, iva],
    resultOf('Total a pagar', totalRenta + reteivaLine.amount),
    miss,
    notes,
  );
}

// ---------------------------------------------------------------------------
// ICA
// ---------------------------------------------------------------------------

export interface IcaActivity {
  code: string;
  label: string;
  /** Tarifa por mil (11,04 = 11,04 ‰). */
  ratePerMil: number;
}

export interface IcaDraftInput extends CommonGaps {
  period: DraftPeriod;
  sales: SaleDocInput[];
  activities: IcaActivity[];
  cityLabel: string | null;
  builtAt: string;
}

export function buildIcaDraft(input: IcaDraftInput): DraftFigures {
  const p = input.period;
  const sales = inPeriod(input.sales, p);
  const ingresos = line(
    'ingresos_brutos',
    'Ingresos brutos del periodo',
    sales.map((d) => saleRef(d, saleBase(d))),
  );
  const miss: MissingItem[] = [];
  const actLines: DraftLine[] = [];
  if (input.activities.length === 1) {
    const a = input.activities[0] as IcaActivity;
    actLines.push(
      line(
        `ica_${a.code}`,
        `ICA — ${a.label} (${a.code})`,
        sales.map((d) => saleRef(d, (saleBase(d) * a.ratePerMil) / 1000)),
        {
          base: ingresos.amount,
          rate: a.ratePerMil / 10,
          needsConfirmation: true,
          note: `Tarifa ${String(a.ratePerMil).replace('.', ',')} por mil, escrita en el perfil.`,
        },
      ),
    );
  } else if (input.activities.length === 0) {
    miss.push(
      missing(
        'ica_sin_actividad',
        'Falta la actividad de ICA y su tarifa por mil en el perfil tributario: sin ella no calculo el impuesto.',
        [],
        1,
      ),
    );
  } else {
    miss.push(
      missing(
        'ica_varias_actividades',
        `La empresa tiene ${input.activities.length} actividades de ICA: hay que repartir los ingresos por actividad (Cortex no sabe qué venta es de cuál).`,
        [],
        1,
      ),
    );
  }
  const totalIca = round2(actLines.reduce((s, l) => s + l.amount, 0));
  const reteica = line(
    'reteica_clientes',
    'ReteICA que te practicaron los clientes (estimada)',
    sales
      .filter((d) => (d.withholdings.reteicaPerMil ?? 0) > 0)
      .map((d) => saleRef(d, (saleBase(d) * (d.withholdings.reteicaPerMil ?? 0)) / 1000)),
    {
      needsConfirmation: true,
      note: 'Estimada con la tarifa pactada en cada factura: confírmala con los certificados.',
    },
  );
  miss.push(
    missing(
      'ica_deducciones',
      'No se restaron ingresos de otros municipios, exportaciones, ni actividades exentas o no sujetas: revísalo con tu contador.',
      [],
      1,
    ),
  );
  miss.push(...commonMissing(input, p));
  return frame(
    'ica',
    `ICA${input.cityLabel ? ` ${input.cityLabel}` : ''} — ${p.label}`,
    p,
    'Causación: por la fecha de la factura',
    input.builtAt,
    [
      { key: 'ingresos', label: 'Base gravable', lines: [ingresos] },
      {
        key: 'impuesto',
        label: 'Impuesto de industria y comercio',
        lines: actLines.length
          ? [
              ...actLines,
              derived('total_ica', 'Total ICA', totalIca, 'Base × tarifa por actividad'),
            ]
          : [],
      },
      {
        key: 'retenciones',
        label: 'Retenciones a tu favor',
        lines: reteica.sources.length ? [reteica] : [],
      },
    ],
    // Sin tarifa no hay impuesto: un «saldo a favor» del puro reteICA engañaría.
    actLines.length
      ? resultOf(
          totalIca - reteica.amount >= 0 ? 'Saldo a pagar' : 'Saldo a favor',
          totalIca - reteica.amount,
        )
      : resultOf('Sin calcular: falta la tarifa de ICA', 0),
    miss,
    ['No incluye avisos y tableros ni la sobretasa bomberil: dependen del municipio.'],
  );
}

// ---------------------------------------------------------------------------
// Régimen Simple: anticipo bimestral
// ---------------------------------------------------------------------------

export interface SimpleDraftInput extends CommonGaps {
  period: DraftPeriod;
  sales: SaleDocInput[];
  /** Tarifa SIMPLE consolidada (%) del perfil, o null. */
  simpleRate: number | null;
  builtAt: string;
}

export function buildSimpleAnticipoDraft(input: SimpleDraftInput): DraftFigures {
  const p = input.period;
  const sales = inPeriod(input.sales, p);
  const ingresos = line(
    'ingresos_brutos',
    'Ingresos brutos del bimestre',
    sales.map((d) => saleRef(d, saleBase(d))),
  );
  const miss: MissingItem[] = [];
  const lines: DraftLine[] = [];
  if (input.simpleRate && input.simpleRate > 0) {
    const rate = input.simpleRate;
    lines.push(
      line(
        'anticipo',
        'Anticipo (ingresos × tarifa SIMPLE consolidada)',
        sales.map((d) => saleRef(d, (saleBase(d) * rate) / 100)),
        {
          base: ingresos.amount,
          rate,
          needsConfirmation: true,
          note: 'Con la tarifa escrita en el perfil (art. 908 ET, según el grupo de la empresa).',
        },
      ),
    );
  } else {
    miss.push(
      missing(
        'tarifa_simple',
        'Falta la tarifa SIMPLE consolidada de la empresa en el perfil tributario (depende del grupo de actividad y de los ingresos, art. 908 ET): pídesela a tu contador.',
        [],
        1,
      ),
    );
  }
  miss.push(
    missing(
      'simple_descuentos',
      'No se restaron los aportes a pensión de empleados (art. 912 ET) ni el componente de ICA ya pagado: los resta tu contador.',
      [],
      1,
    ),
  );
  miss.push(...commonMissing(input, p));
  const anticipo = lines[0]?.amount ?? 0;
  return frame(
    'simple_anticipo',
    `Anticipo del Régimen Simple — ${p.label}`,
    p,
    'Causación: por la fecha de la factura',
    input.builtAt,
    [
      { key: 'ingresos', label: 'Ingresos', lines: [ingresos] },
      { key: 'anticipo', label: 'Anticipo', lines },
    ],
    resultOf('Anticipo a pagar', anticipo),
    miss,
    [
      'En el Régimen Simple no te practican retención en la fuente de renta; las de IVA e ICA sí cuentan y las revisa tu contador.',
    ],
  );
}

// ---------------------------------------------------------------------------
// Renta: el estimado anual
// ---------------------------------------------------------------------------

export interface RentaMonthInput {
  /** `YYYY-MM`. */
  month: string;
  ingresos: number;
  otrosIngresos: number;
  costo: number;
  /** Gastos variables + fijos + financieros (sin la clase «impuestos»). */
  gastos: number;
}

export interface RentaProviderPnl {
  provider: string;
  from: string;
  to: string;
  revenue: number;
  otherIncome: number;
  costOfSales: number;
  operatingExpenses: number;
  otherExpenses: number;
}

export interface RentaDraftInput {
  /** El año gravable. */
  year: number;
  period: DraftPeriod;
  personType: 'juridica' | 'natural';
  /** Los 12 meses del estado de resultados de caja (0191). */
  months: RentaMonthInput[];
  /** El estado de resultados del programa contable (causación), si lo hay: manda. */
  providerPnl: RentaProviderPnl | null;
  /** Ventas del año con retención pactada: las retenciones a favor (estimadas). */
  sales: SaleDocInput[];
  builtAt: string;
}

export function buildRentaDraft(input: RentaDraftInput): DraftFigures {
  const p = input.period;
  const pnl = input.providerPnl;
  const ref = (key: string, label: string, amount: number): SourceRef => ({
    kind: 'estados',
    id: key,
    label,
    date: p.to,
    amount,
  });
  const monthRefs = (pick: (m: RentaMonthInput) => number, what: string) =>
    input.months.map((m) =>
      ref(
        `${m.month}:${what}`,
        `${cap(monthLong(Number(m.month.slice(5, 7))))} ${m.month.slice(0, 4)}`,
        pick(m),
      ),
    );
  const src = pnl ? `Programa contable (${pnl.provider})` : null;
  const ingresos = line(
    'ingresos',
    'Ingresos operacionales',
    pnl
      ? [ref('pnl:revenue', `${src}: ingresos`, pnl.revenue)]
      : monthRefs((m) => m.ingresos, 'ingresos'),
  );
  const otros = line(
    'otros_ingresos',
    'Otros ingresos',
    pnl
      ? [ref('pnl:other', `${src}: otros ingresos`, pnl.otherIncome)]
      : monthRefs((m) => m.otrosIngresos, 'otros'),
  );
  const costos = line(
    'costos',
    'Costos',
    pnl
      ? [ref('pnl:cost', `${src}: costo de ventas`, pnl.costOfSales)]
      : monthRefs((m) => m.costo, 'costo'),
  );
  const gastos = line(
    'gastos',
    'Gastos (deducciones)',
    pnl
      ? [
          ref('pnl:opex', `${src}: gastos operacionales`, pnl.operatingExpenses),
          ref('pnl:otherexp', `${src}: otros gastos`, pnl.otherExpenses),
        ]
      : monthRefs((m) => m.gastos, 'gastos'),
  );
  const rentaLiquida = round2(ingresos.amount + otros.amount - costos.amount - gastos.amount);
  const miss: MissingItem[] = [];
  const impuestoLines: DraftLine[] = [];
  let impuesto = 0;
  if (input.personType === 'juridica') {
    impuesto = round2((Math.max(0, rentaLiquida) * RENTA_PJ_RATE) / 100);
    impuestoLines.push({
      ...derived(
        'impuesto',
        `Impuesto de renta (${RENTA_PJ_RATE} %)`,
        impuesto,
        `${RENTA_PJ_RATE} % de la renta líquida estimada, si es positiva`,
      ),
      base: Math.max(0, rentaLiquida),
      rate: RENTA_PJ_RATE,
    });
  } else {
    miss.push(
      missing(
        'renta_persona_natural',
        'Para persona natural la renta va por cédulas y con la tabla progresiva (art. 241 ET): este estimado no calcula el impuesto.',
        [],
        1,
      ),
    );
  }
  const sales = inPeriod(input.sales, p);
  const retenciones = line(
    'retenciones_a_favor',
    'Retenciones que te practicaron (estimadas)',
    sales
      .filter((d) => (d.withholdings.retefuentePct ?? 0) > 0)
      .map((d) => saleRef(d, (saleBase(d) * (d.withholdings.retefuentePct ?? 0)) / 100)),
    {
      needsConfirmation: true,
      note: 'Estimadas con el % pactado en las facturas de Cortex: confírmalas con los certificados de tus clientes.',
    },
  );
  miss.push(
    missing(
      'anticipos',
      'El anticipo liquidado el año anterior (que resta) y el anticipo del año siguiente (que suma, art. 807 ET) los calcula tu contador.',
      [],
      1,
    ),
  );
  if (!pnl && !input.months.some((m) => m.ingresos || m.costo || m.gastos))
    miss.push(
      missing(
        'sin_datos',
        `No hay movimientos de ${input.year} en el libro: no hay con qué estimar.`,
        [],
        1,
      ),
    );
  const saldo = impuesto - retenciones.amount;
  return frame(
    'renta',
    `Renta ${input.year} — estimado`,
    p,
    pnl
      ? `Causación: estado de resultados del programa contable (${pnl.provider})`
      : 'Caja: estado de resultados del libro de plata (lo que entró y salió)',
    input.builtAt,
    [
      { key: 'ingresos', label: 'Ingresos', lines: [ingresos, otros] },
      { key: 'costos_gastos', label: 'Costos y gastos', lines: [costos, gastos] },
      {
        key: 'renta',
        label: 'Renta líquida e impuesto',
        lines: [
          derived(
            'renta_liquida',
            'Renta líquida estimada',
            rentaLiquida,
            'Ingresos + otros ingresos − costos − gastos',
          ),
          ...impuestoLines,
        ],
      },
      {
        key: 'retenciones',
        label: 'Retenciones a favor',
        lines: retenciones.sources.length ? [retenciones] : [],
      },
    ],
    resultOf(saldo >= 0 ? 'Saldo estimado a pagar' : 'Saldo estimado a favor', saldo),
    miss,
    [
      'Es un estimado: no incluye ajustes fiscales (conciliación fiscal, formato 2516), gastos no deducibles, rentas exentas, descuentos tributarios ni la tasa mínima de tributación del 15 %.',
      'Los impuestos pagados en el año (clase «impuestos» del estado de resultados) no se restaron como gasto: el ICA sí es deducible y lo ajusta tu contador.',
    ],
  );
}

// ---------------------------------------------------------------------------
// Para el chat
// ---------------------------------------------------------------------------

/** El borrador en texto corto, para que el modelo lo cuente tal cual. */
export function draftMarkdown(f: DraftFigures, opts: { maxLines?: number } = {}): string {
  const out = [`**${f.title}** — _${f.disclaimer}_`, `Base: ${f.basis}.`];
  for (const s of f.sections) {
    out.push(`\n${s.label}:`);
    for (const l of s.lines.slice(0, opts.maxLines ?? 12)) {
      const rate = l.rate != null ? ` (${String(l.rate).replace('.', ',')} %)` : '';
      const flag = l.needsConfirmation ? ' · por confirmar' : '';
      const count = l.sources.length
        ? ` · ${plural(l.sources.length, 'documento', 'documentos')}`
        : '';
      out.push(`- ${l.label}${rate}: ${money(l.amount)}${count}${flag}`);
    }
  }
  out.push(`\n**${f.result.label}: ${money(Math.abs(f.result.amount))}**`);
  if (f.missing.length) {
    out.push('\nDatos que faltan:');
    for (const m of f.missing) out.push(`- ${m.message}`);
  }
  return out.join('\n');
}
