import type { SiigoClient } from '../../accounting/providers/siigo-client';
import type { AccountMap } from './mapping';
import {
  type EntryLine,
  type ProviderWriter,
  type PurchaseSource,
  type ReceiptSource,
  type SupplierPaymentSource,
  type WritebackSource,
  type WrittenDocument,
  round2,
} from './shape';

/**
 * ESCRIBIR EN SIIGO NUBE (migración 0192). Verificado contra el API Blueprint
 * oficial (siigoapi.docs.apiary.io/api-description-document):
 *
 *   compra          POST /v1/purchases          (document FC; items tipo
 *                   «Account» con su cuenta; `taxes` por ítem para IVA y
 *                   retención en la fuente; `retentions` arriba para ReteICA y
 *                   ReteIVA; `payments[]` con la forma de pago a crédito y su
 *                   vencimiento; `provider_invoice` con el número del proveedor)
 *   recibo          POST /v1/vouchers           (document RC, type DebtPayment;
 *                   `items[].due` = la factura de venta «FV-1-68» → prefijo
 *                   «FV-1», consecutivo 68, cuota 1; `payment` en singular)
 *   pago_proveedor  POST /v1/payment-receipts   (document RP, «recibo de pago o
 *                   egreso», type DebtPayment; `items[].due` = la compra «FC-2-22»)
 *
 * Los catálogos que hacen falta (tipos de documento, formas de pago,
 * impuestos) se leen en cada preparación: son tres GET baratos y así una
 * forma de pago desactivada ayer no sale hoy.
 *
 * La cabecera `Idempotency-Key` está documentada para /v1/vouchers (y
 * facturas, notas y comprobantes); para /v1/purchases y /v1/payment-receipts
 * NO lo está. Se manda igual (no estorba), pero la defensa real de esas dos es
 * la toma única de store.ts y, tras una escritura incierta, `find`: buscar la
 * compra por proveedor y número, o el egreso por proveedor, fecha y valor.
 *
 * Puro en lo que arma (`buildSiigo*`); `siigoWriter` sólo agrega las lecturas.
 */

type Loose = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const digits = (v: unknown): string => str(v).replace(/\D/g, '');

function list(body: unknown): Loose[] {
  if (Array.isArray(body)) return body as Loose[];
  const b = body as { results?: unknown } | null;
  return Array.isArray(b?.results) ? (b.results as Loose[]) : [];
}

export interface SiigoTax {
  id: number;
  name: string;
  type: string;
  percentage: number;
}

export interface SiigoPaymentType {
  id: number;
  name: string;
  /** La forma de pago maneja vencimiento (crédito). */
  dueDate: boolean;
}

export interface SiigoWriteCatalog {
  documentId: number | null;
  paymentTypes: SiigoPaymentType[];
  taxes: SiigoTax[];
}

function taxType(t: string): 'iva' | 'retefuente' | 'reteiva' | 'reteica' | 'other' {
  const s = t.toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'iva') return 'iva';
  if (s.includes('reteiva')) return 'reteiva';
  if (s.includes('reteica')) return 'reteica';
  if (s.includes('retefuente') || s.includes('fuente')) return 'retefuente';
  return 'other';
}

/**
 * El impuesto del catálogo con esa clase y tarifa. La tarifa se compara con
 * tolerancia (un ReteICA de 9,66 por mil es 0,966 %), y con dos candidatos de
 * la misma tarifa gana el primero activo: el catálogo de Siigo tiene uno por
 * concepto y la empresa los distingue por nombre.
 */
export function findSiigoTax(
  taxes: readonly SiigoTax[],
  kind: 'iva' | 'retefuente' | 'reteiva' | 'reteica',
  rate: number,
): SiigoTax | null {
  const candidates = taxes.filter((t) => taxType(t.type) === kind);
  const tol = Math.max(0.06, rate * 0.02);
  return candidates.find((t) => Math.abs(t.percentage - rate) <= tol) ?? null;
}

/** «FV-1-68» → { prefix: «FV-1», consecutive: 68 }. */
export function parseSiigoName(
  name: string | null | undefined,
): { prefix: string; consecutive: number } | null {
  const m = str(name).match(/^([A-Za-z]{1,4}-\d{1,6})-(\d{1,12})$/);
  if (!m) return null;
  return { prefix: m[1] as string, consecutive: Number(m[2]) };
}

/** Tarifa redondeada a lo que manejan los catálogos (dos decimales, o tres si es menor que 1). */
function rateOf(part: number, base: number): number {
  if (base <= 0) return 0;
  const r = (part / base) * 100;
  return r < 1 ? Math.round(r * 1000) / 1000 : Math.round(r * 100) / 100;
}

/** El IVA colombiano es 19 %, 5 % o 0: una tarifa calculada se lleva a la más cercana. */
function snapIva(rate: number): number {
  for (const r of [19, 5]) if (Math.abs(rate - r) <= 0.6) return r;
  return rate;
}

function costCenterId(raw: string | null | undefined): number | undefined {
  const n = Number(str(raw));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Compra
// ---------------------------------------------------------------------------

export function buildSiigoPurchase(input: {
  src: PurchaseSource;
  entries: EntryLine[];
  map: AccountMap;
  catalog: SiigoWriteCatalog;
}): { payload: Loose; problems: string[]; warnings: string[] } {
  const { src, map, catalog } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  const expense = map.expense({ supplierId: src.supplierId, category: src.category });
  if (!catalog.documentId)
    problems.push('Siigo no tiene un tipo de documento de factura de compra (FC) activo.');
  const credit = catalog.paymentTypes.find((p) => p.dueDate) ?? null;
  if (!credit)
    problems.push(
      'Siigo no tiene una forma de pago a crédito para facturas de compra: créala en Siigo (Configuración → Formas de pago) o pásala a mano.',
    );
  const base = round2(src.subtotal + src.otherTaxes);
  const taxes: Array<{ id: number }> = [];
  if (src.iva > 0) {
    const rate = snapIva(rateOf(src.iva, src.subtotal));
    const iva = findSiigoTax(catalog.taxes, 'iva', rate);
    if (iva) taxes.push({ id: iva.id });
    else problems.push(`Siigo no tiene un IVA de compras del ${rate} %.`);
  }
  if (src.withholdings.retefuente > 0) {
    const rate = rateOf(src.withholdings.retefuente, src.subtotal);
    const rf = findSiigoTax(catalog.taxes, 'retefuente', rate);
    if (rf) taxes.push({ id: rf.id });
    else problems.push(`Siigo no tiene una retención en la fuente del ${rate} %.`);
  }
  const retentions: Array<{ id: number }> = [];
  if (src.withholdings.reteiva > 0) {
    // El ReteIVA es un porcentaje del IVA (15 % casi siempre), no de la base.
    const rate = rateOf(src.withholdings.reteiva, src.iva);
    const t = findSiigoTax(catalog.taxes, 'reteiva', rate);
    if (t) retentions.push({ id: t.id });
    else problems.push(`Siigo no tiene un ReteIVA del ${rate} % del IVA.`);
  }
  if (src.withholdings.reteica > 0) {
    const rate = rateOf(src.withholdings.reteica, src.subtotal);
    const t = findSiigoTax(catalog.taxes, 'reteica', rate);
    if (t) retentions.push({ id: t.id });
    else problems.push(`Siigo no tiene un ReteICA del ${rate} % (${round2(rate * 10)} por mil).`);
  }

  // Una línea por renglón de la factura si los renglones suman la base; si
  // no, una sola por la base (la factura vino sin detalle o con descuentos).
  const lineSum = round2(src.lines.reduce((s, l) => s + l.amount, 0));
  const useLines = src.lines.length > 0 && src.lines.length <= 50 && Math.abs(lineSum - base) <= 1;
  const items = (
    useLines
      ? src.lines.map((l) => ({ description: l.description, price: l.amount }))
      : [{ description: `Factura ${src.docNumber} de ${src.supplierName}`, price: base }]
  ).map((l) => ({
    type: 'Account',
    code: expense.code,
    description: l.description.slice(0, 200),
    quantity: 1,
    price: round2(l.price),
    ...(taxes.length ? { taxes } : {}),
  }));
  if (expense.code.length < 8)
    warnings.push(
      `Siigo suele pedir la cuenta AUXILIAR (8 dígitos o más) y ${expense.code} es de ${expense.code.length}: si Siigo la rechaza, pon la auxiliar en /cierre → Cuentas.`,
    );

  const net = round2(
    src.total - src.withholdings.retefuente - src.withholdings.reteiva - src.withholdings.reteica,
  );
  const due = src.dueDate ?? src.issueDate;
  const [prefix, number] = splitSupplierNumber(src.docNumber);
  const cc = costCenterId(expense.costCenter);
  const payload: Loose = {
    document: { id: catalog.documentId ?? 0 },
    date: src.issueDate,
    supplier: { identification: digits(src.supplierNit), branch_office: 0 },
    ...(cc ? { cost_center: cc } : {}),
    provider_invoice: { prefix, number },
    observations:
      `Causada desde Cortex${src.cufe ? ` · CUFE ${src.cufe.slice(0, 40)}…` : ''}`.slice(0, 4000),
    items,
    ...(retentions.length ? { retentions } : {}),
    payments: [{ id: credit?.id ?? 0, value: net, due_date: due }],
  };
  return { payload, problems, warnings };
}

/** «FEPA-451» → [«FEPA», «451»]; «12345» → [«», «12345»]. Lo que pide `provider_invoice`. */
export function splitSupplierNumber(raw: string): [string, string] {
  const t = raw.trim().toUpperCase();
  const m = t.match(/^([A-Z]+)[-\s]*0*(\d+)$/);
  if (m) return [m[1] as string, m[2] as string];
  return ['', t.replace(/[^A-Z0-9]/g, '').slice(0, 30)];
}

// ---------------------------------------------------------------------------
// Recibo de caja y egreso
// ---------------------------------------------------------------------------

/** La forma de pago del banco: la que la empresa eligió para esa cuenta, o la única que hay. */
export function pickSiigoBankPayment(
  types: readonly SiigoPaymentType[],
  mapped: string | undefined,
  accountName: string | null,
): { type: SiigoPaymentType | null; problem: string | null } {
  if (mapped) {
    const hit = types.find((t) => String(t.id) === mapped);
    return hit
      ? { type: hit, problem: null }
      : {
          type: null,
          problem: `La forma de pago ${mapped} de Siigo ya no existe o está inactiva.`,
        };
  }
  const cash = types.filter((t) => !t.dueDate);
  if (accountName) {
    const words = accountName
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const named = cash.filter((t) => words.some((w) => t.name.toLowerCase().includes(w)));
    if (named.length === 1) return { type: named[0] as SiigoPaymentType, problem: null };
  }
  if (cash.length === 1) return { type: cash[0] as SiigoPaymentType, problem: null };
  return {
    type: null,
    problem: `Elige en /cierre → Cuentas qué forma de pago de Siigo es la cuenta ${accountName ?? 'del banco'} (hay ${cash.length}).`,
  };
}

export function buildSiigoVoucher(input: {
  src: ReceiptSource;
  documentId: number | null;
  payment: SiigoPaymentType | null;
  dueDate: string;
  costCenter?: string | null;
}): { payload: Loose; problems: string[] } {
  const { src } = input;
  const problems: string[] = [];
  if (!input.documentId)
    problems.push('Siigo no tiene un tipo de documento de recibo de caja (RC) activo.');
  if (!src.customerNit)
    problems.push(`${src.customerName ?? 'El cliente'} no tiene NIT en Cortex.`);
  const due = parseSiigoName(src.invoiceNumber);
  if (!due)
    problems.push(
      `No reconozco el número de la factura «${src.invoiceNumber}» como uno de Siigo (FV-1-68).`,
    );
  const cc = costCenterId(input.costCenter);
  return {
    payload: {
      document: { id: input.documentId ?? 0 },
      date: src.date,
      type: 'DebtPayment',
      customer: { identification: digits(src.customerNit), branch_office: 0 },
      ...(cc ? { cost_center: cc } : {}),
      items: [
        {
          due: {
            prefix: due?.prefix ?? '',
            consecutive: due?.consecutive ?? 0,
            quote: 1,
            date: input.dueDate,
          },
          value: round2(src.amount),
        },
      ],
      payment: { id: input.payment?.id ?? 0, value: round2(src.amount) },
      observations:
        `Registrado desde Cortex${src.reference ? ` · ref. banco ${src.reference}` : ''}`.slice(
          0,
          4000,
        ),
    },
    problems,
  };
}

export function buildSiigoPaymentReceipt(input: {
  src: SupplierPaymentSource;
  documentId: number | null;
  payment: SiigoPaymentType | null;
  purchaseName: string | null;
  dueDate: string;
}): { payload: Loose; problems: string[] } {
  const { src } = input;
  const problems: string[] = [];
  if (!input.documentId)
    problems.push('Siigo no tiene un tipo de documento de recibo de pago o egreso (RP) activo.');
  if (!src.supplierNit) problems.push(`${src.supplierName} no tiene NIT en Cortex.`);
  const due = parseSiigoName(input.purchaseName);
  if (!due) problems.push('No encontré en Siigo el número de la compra que este pago salda.');
  return {
    payload: {
      document: { id: input.documentId ?? 0 },
      date: src.date,
      type: 'DebtPayment',
      supplier: { identification: digits(src.supplierNit), branch_office: 0 },
      items: [
        {
          due: {
            prefix: due?.prefix ?? '',
            consecutive: due?.consecutive ?? 0,
            quote: 1,
            date: input.dueDate,
          },
          value: round2(src.amount),
        },
      ],
      payment: { id: input.payment?.id ?? 0, value: round2(src.amount) },
      observations:
        `Registrado desde Cortex${src.reference ? ` · ref. banco ${src.reference}` : ''}`.slice(
          0,
          4000,
        ),
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// La sesión
// ---------------------------------------------------------------------------

const DOC_TYPE: Record<WritebackSource['kind'], string> = {
  compra: 'FC',
  recibo: 'RC',
  pago_proveedor: 'RP',
};

const NOUN: Record<WritebackSource['kind'], string> = {
  compra: 'la factura de compra',
  recibo: 'el recibo de caja',
  pago_proveedor: 'el recibo de egreso',
};

const PATH: Record<WritebackSource['kind'], string> = {
  compra: '/v1/purchases',
  recibo: '/v1/vouchers',
  pago_proveedor: '/v1/payment-receipts',
};

export function siigoWriter(client: SiigoClient): ProviderWriter {
  const catalog = async (kind: WritebackSource['kind']): Promise<SiigoWriteCatalog> => {
    const code = DOC_TYPE[kind];
    const [docs, payments, taxes] = await Promise.all([
      client.get<unknown>('/v1/document-types', { type: code }),
      client.get<unknown>('/v1/payment-types', { document_type: code }),
      kind === 'compra' ? client.get<unknown>('/v1/taxes') : Promise.resolve([]),
    ]);
    const active = (r: Loose) => r.active !== false;
    const doc = list(docs).find(active);
    return {
      documentId: doc ? Number(doc.id) || null : null,
      paymentTypes: list(payments)
        .filter(active)
        .map((p) => ({ id: Number(p.id), name: str(p.name), dueDate: p.due_date === true })),
      taxes: list(taxes)
        .filter(active)
        .map((t) => ({
          id: Number(t.id),
          name: str(t.name),
          type: str(t.type),
          percentage: Number(t.percentage) || 0,
        })),
    };
  };

  return {
    provider: 'siigo',
    supports: { compra: true, recibo: true, pago_proveedor: true },
    async prepare(src, _entries, map) {
      const cat = await catalog(src.kind);
      if (src.kind === 'compra') {
        return buildSiigoPurchase({ src, entries: _entries, map, catalog: cat });
      }
      const bank = map.bank(src.bankAccount);
      const pick = pickSiigoBankPayment(cat.paymentTypes, bank.refs.siigo, src.bankAccount);
      if (src.kind === 'recibo') {
        const out = buildSiigoVoucher({
          src,
          documentId: cat.documentId,
          payment: pick.type,
          dueDate: src.invoiceDate ?? src.date,
          costCenter: bank.costCenter,
        });
        return {
          ...out,
          problems: [...out.problems, ...(pick.problem ? [pick.problem] : [])],
          warnings: [],
        };
      }
      // El egreso apunta al vencimiento de la compra: su nombre (FC-2-22) y su fecha.
      const purchase = await client
        .get<Loose>(`/v1/purchases/${encodeURIComponent(src.purchaseExternalId)}`)
        .catch(() => null);
      const dues = (Array.isArray(purchase?.payments) ? (purchase?.payments as Loose[]) : [])
        .map((p) => str(p.due_date).slice(0, 10))
        .filter(Boolean)
        .sort();
      const out = buildSiigoPaymentReceipt({
        src,
        documentId: cat.documentId,
        payment: pick.type,
        purchaseName: str(purchase?.name) || src.purchaseNumber,
        dueDate: dues[dues.length - 1] ?? src.date,
      });
      return {
        ...out,
        problems: [...out.problems, ...(pick.problem ? [pick.problem] : [])],
        warnings: [],
      };
    },
    async send(src, payload, opts): Promise<WrittenDocument> {
      const out = await client.post<Loose>(PATH[src.kind], payload, {
        idempotencyKey: opts.idempotencyKey,
        noun: NOUN[src.kind],
      });
      return {
        id: str(out?.id),
        number: str(out?.name) || (out?.number ? str(out.number) : null),
        status: out?.total !== undefined ? `total ${str(out.total)}` : null,
      };
    },
    async find(src) {
      // Sólo compra y egreso: el recibo de caja tiene Idempotency-Key documentada.
      if (src.kind === 'recibo') return null;
      const date = src.kind === 'compra' ? src.issueDate : src.date;
      const body = await client.get<unknown>(PATH[src.kind], {
        date_start: date,
        date_end: date,
        page: 1,
        page_size: 100,
      });
      const nit = digits(src.supplierNit);
      const hit = list(body).find((r) => {
        const supplier = (r.supplier ?? {}) as Loose;
        if (nit && digits(supplier.identification) !== nit) return false;
        if (src.kind === 'compra') {
          const pi = (r.provider_invoice ?? {}) as Loose;
          const [prefix, number] = splitSupplierNumber(src.docNumber);
          return str(pi.number) === number && str(pi.prefix).toUpperCase() === prefix;
        }
        return Math.abs(Number(r.total ?? r.value ?? 0) - src.amount) < 1;
      });
      return hit ? { id: str(hit.id), number: str(hit.name) || null } : null;
    },
  };
}
