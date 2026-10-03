/**
 * LA FACTURA QUE SE LE MANDA AL PROGRAMA CONTABLE, ARMADA (migración 0182).
 *
 * Módulo puro: recibe el documento de Cortex, el catálogo del programa
 * (`InvoicingCatalog`) y el cliente encontrado allá, y devuelve tres cosas:
 *
 *   - `payload`: el cuerpo EXACTO del POST (Siigo `/v1/invoices`, Alegra
 *     `/invoices`), que es lo que la persona aprueba y lo que queda guardado;
 *   - `problems`: lo que impide emitir, en español y con qué hacer («la línea
 *     "Flete" no tiene un producto de Siigo: elígelo del catálogo»). Con un
 *     solo problema no se manda nada;
 *   - `notes`: lo que conviene saber y no impide (qué tipo de documento se
 *     eligió, que las retenciones no van en la factura…).
 *
 * Los campos salen de la documentación oficial:
 *   Siigo `InvoiceIn`: document.id, date, customer.identification +
 *     branch_office, seller, observations, items[code, description, quantity,
 *     price (antes de impuestos), discount (valor o % según el tipo de
 *     documento), taxes[{id}]], payments[{id, value, due_date}] cuya suma
 *     «debe coincidir con el total de la factura», stamp.send, mail.send.
 *   Alegra `POST /invoices`: date, dueDate, client.id, items[id, price,
 *     quantity, discount (%), tax[{id}], description], paymentForm
 *     CASH/CREDIT (obligatorio con facturación electrónica), paymentMethod
 *     (obligatorio con CASH), numberTemplate.id, stamp.generateStamp, status.
 *
 * RETENCIONES. No van en la factura: las practica el cliente al pagar y se
 * registran en el recibo de caja. Así la suma de los pagos es el total de la
 * factura, que es lo que Siigo exige, y el neto estimado sigue en Cortex.
 */

import type { InvoicingCatalog } from '../accounting/types';
import type { SalesDocumentRow, SalesLineRow } from './shape';
import { documentNumber } from './shape';
import { TAX_RATE_PERCENT, type TaxRate, documentTotals, formatMoney, roundCents } from './totals';

export interface EinvoiceChoices {
  documentTypeId?: string;
  sellerId?: string;
  paymentTypeId?: string;
  /** Siigo: que el programa le mande la factura al correo del cliente. Por defecto sí. */
  sendEmail?: boolean;
}

export interface EinvoiceLineSummary {
  description: string;
  code: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  tax: string;
  total: number;
}

export interface EinvoiceDraft {
  provider: 'siigo' | 'alegra';
  payload: Record<string, unknown>;
  problems: string[];
  notes: string[];
  summary: {
    documentType: string | null;
    seller: string | null;
    payment: string;
    date: string;
    dueDate: string;
    customer: string;
    lines: EinvoiceLineSummary[];
    subtotal: number;
    iva: number;
    total: number;
  };
}

type Doc = Pick<
  SalesDocumentRow,
  | 'kind'
  | 'number'
  | 'client_name'
  | 'client_tax_id'
  | 'issue_date'
  | 'due_date'
  | 'payment_form'
  | 'payment_days'
  | 'notes'
  | 'currency'
  | 'withholding_total'
> & { reference?: string };

type Line = Pick<
  SalesLineRow,
  | 'description'
  | 'product_ref'
  | 'product_code'
  | 'quantity'
  | 'unit_price'
  | 'discount_pct'
  | 'tax_rate'
>;

const PROVIDER_NAME = { siigo: 'Siigo', alegra: 'Alegra' } as const;

export function addDaysIso(iso: string, days: number): string {
  const t = Date.parse(`${iso}T12:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** El impuesto de IVA del programa para una tarifa, o null («excluido» no lleva ninguno). */
export function ivaTaxFor(
  catalog: InvoicingCatalog,
  rate: TaxRate,
): { id: string; name: string } | null | 'missing' {
  if (rate === 'excluido') return null;
  const pct = TAX_RATE_PERCENT[rate];
  const hit = catalog.taxes.find((t) => t.kind === 'iva' && Math.abs(t.percentage - pct) < 0.001);
  return hit ? { id: hit.id, name: hit.name } : 'missing';
}

function common(provider: 'siigo' | 'alegra', doc: Doc, lines: Line[], today: string) {
  const name = PROVIDER_NAME[provider];
  const problems: string[] = [];
  const notes: string[] = [];
  if (!lines.length) problems.push('El documento no tiene líneas.');
  if (doc.currency !== 'COP')
    problems.push(
      `La factura está en ${doc.currency}: por ahora Cortex sólo emite facturas en pesos. Hazla directamente en ${name}.`,
    );
  if (!doc.client_tax_id)
    problems.push(
      `Falta el NIT de ${doc.client_name}: ${name} identifica al cliente por su NIT. Agrégalo en la ficha del cliente o en el documento.`,
    );
  const totals = documentTotals(
    lines.map((l) => ({
      quantity: Number(l.quantity),
      unitPrice: Number(l.unit_price),
      discountPct: Number(l.discount_pct),
      taxRate: l.tax_rate,
    })),
  );
  if (lines.length && totals.total <= 0) problems.push('El total de la factura es cero.');
  const dueDate =
    doc.payment_form === 'contado'
      ? today
      : doc.due_date && doc.due_date >= today
        ? doc.due_date
        : addDaysIso(today, doc.payment_days || 0);
  if (doc.withholding_total > 0)
    notes.push(
      `Las retenciones estimadas (${formatMoney(doc.withholding_total)}) no van en la factura: el cliente las practica al pagar y se registran en el recibo de caja.`,
    );
  const reference = doc.reference ?? documentNumber({ kind: doc.kind, number: doc.number });
  const observations = [doc.notes?.trim(), `Ref. Cortex ${reference}`]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
  return { name, problems, notes, totals, dueDate, observations };
}

function lineSummary(line: Line, taxName: string, total: number): EinvoiceLineSummary {
  return {
    description: line.description,
    code: line.product_code ?? line.product_ref ?? null,
    quantity: Number(line.quantity),
    unitPrice: Number(line.unit_price),
    discountPct: Number(line.discount_pct),
    tax: taxName,
    total,
  };
}

export function buildSiigoInvoice(input: {
  doc: Doc;
  lines: Line[];
  catalog: InvoicingCatalog;
  customerFound: boolean;
  choices?: EinvoiceChoices;
  today: string;
}): EinvoiceDraft {
  const { doc, lines, catalog, today } = input;
  const choices = input.choices ?? {};
  const base = common('siigo', doc, lines, today);
  const { problems, notes } = base;

  if (doc.client_tax_id && !input.customerFound)
    problems.push(
      `${doc.client_name} (NIT ${doc.client_tax_id}) no está creado en Siigo. Créalo en Siigo (Clientes → Crear) y vuelve a intentar.`,
    );

  const electronic = catalog.documentTypes.filter((d) => d.electronic);
  const documentType =
    catalog.documentTypes.find((d) => d.id === choices.documentTypeId) ?? electronic[0] ?? null;
  if (!documentType)
    problems.push(
      'Siigo no tiene un tipo de factura electrónica activo (FV). Actívalo en Siigo con la resolución de la DIAN.',
    );
  else if (!documentType.electronic)
    problems.push(`El tipo de documento «${documentType.name}» no es de factura electrónica.`);
  else if (!choices.documentTypeId && electronic.length > 1)
    notes.push(
      `Siigo tiene ${electronic.length} tipos de factura electrónica; se usa «${documentType.name}».`,
    );

  const seller =
    catalog.sellers.find((s) => s.id === choices.sellerId) ?? catalog.sellers[0] ?? null;
  if (!seller) problems.push('Siigo exige un vendedor y la cuenta no tiene ninguno activo.');

  const wantsCredit = doc.payment_form === 'credito';
  const payment =
    catalog.paymentTypes.find((p) => p.id === choices.paymentTypeId) ??
    catalog.paymentTypes.find((p) => p.credit === wantsCredit) ??
    null;
  if (!payment)
    problems.push(
      `Siigo no tiene una forma de pago ${wantsCredit ? 'a crédito' : 'de contado'} activa para facturas de venta.`,
    );

  const byValue = documentType?.discountType === 'value';
  const items = lines.map((line, i) => {
    const code = line.product_code?.trim();
    if (!code)
      problems.push(
        `La línea ${i + 1} («${line.description.slice(0, 60)}») no tiene un producto de Siigo: elígelo del catálogo.`,
      );
    const tax = ivaTaxFor(catalog, line.tax_rate);
    if (tax === 'missing')
      problems.push(
        `Siigo no tiene configurado el ${TAX_RATE_PERCENT[line.tax_rate] === 0 ? 'IVA 0 % (exento)' : `IVA ${TAX_RATE_PERCENT[line.tax_rate]} %`} que usa la línea ${i + 1}.`,
      );
    const lt = base.totals.lines[i];
    const discount = byValue ? (lt?.discount ?? 0) : Number(line.discount_pct);
    return {
      item: {
        code: code ?? '',
        description: line.description.slice(0, 500),
        quantity: Number(line.quantity),
        price: roundCents(Number(line.unit_price)),
        ...(discount > 0 ? { discount } : {}),
        ...(tax && tax !== 'missing' ? { taxes: [{ id: Number(tax.id) || tax.id }] } : {}),
      },
      summary: lineSummary(
        line,
        tax === null ? 'Excluido' : tax === 'missing' ? 'Sin configurar' : tax.name,
        lt?.lineTotal ?? 0,
      ),
    };
  });

  const payload: Record<string, unknown> = {
    document: { id: Number(documentType?.id) || documentType?.id || null },
    date: today,
    customer: { identification: doc.client_tax_id ?? '', branch_office: 0 },
    seller: Number(seller?.id) || seller?.id || null,
    observations: base.observations,
    items: items.map((x) => x.item),
    payments: [
      {
        id: Number(payment?.id) || payment?.id || null,
        value: base.totals.total,
        ...(payment?.credit ? { due_date: base.dueDate } : {}),
      },
    ],
    stamp: { send: true },
    mail: { send: choices.sendEmail !== false },
  };
  if (choices.sendEmail !== false)
    notes.push('Siigo le manda la factura al correo del cliente registrado en Siigo.');

  return {
    provider: 'siigo',
    payload,
    problems: [...new Set(problems)],
    notes,
    summary: {
      documentType: documentType?.name ?? null,
      seller: seller?.name ?? null,
      payment: payment?.name ?? (wantsCredit ? 'Crédito' : 'Contado'),
      date: today,
      dueDate: base.dueDate,
      customer: `${doc.client_name}${doc.client_tax_id ? ` · NIT ${doc.client_tax_id}` : ''}`,
      lines: items.map((x) => x.summary),
      subtotal: base.totals.taxBase,
      iva: base.totals.ivaTotal,
      total: base.totals.total,
    },
  };
}

export function buildAlegraInvoice(input: {
  doc: Doc;
  lines: Line[];
  catalog: InvoicingCatalog;
  customerId: string | null;
  choices?: EinvoiceChoices;
  today: string;
}): EinvoiceDraft {
  const { doc, lines, catalog, today } = input;
  const choices = input.choices ?? {};
  const base = common('alegra', doc, lines, today);
  const { problems, notes } = base;

  if (doc.client_tax_id && !input.customerId)
    problems.push(
      `${doc.client_name} (NIT ${doc.client_tax_id}) no está creado en Alegra. Créalo en Alegra (Contactos → Nuevo) y vuelve a intentar.`,
    );

  const template =
    catalog.documentTypes.find((d) => d.id === choices.documentTypeId) ??
    catalog.documentTypes.find((d) => d.electronic) ??
    null;
  if (!template) notes.push('Se usa la numeración de facturas que Alegra tenga como preferida.');
  else if (!template.electronic)
    problems.push(`La numeración «${template.name}» no es de factura electrónica.`);

  const seller = catalog.sellers.find((s) => s.id === choices.sellerId) ?? null;
  const credit = doc.payment_form === 'credito';

  const items = lines.map((line, i) => {
    const ref = line.product_ref?.trim();
    if (!ref)
      problems.push(
        `La línea ${i + 1} («${line.description.slice(0, 60)}») no tiene un producto de Alegra: elígelo del catálogo.`,
      );
    const tax = ivaTaxFor(catalog, line.tax_rate);
    if (tax === 'missing')
      problems.push(
        `Alegra no tiene configurado el ${TAX_RATE_PERCENT[line.tax_rate] === 0 ? 'IVA 0 % (exento)' : `IVA ${TAX_RATE_PERCENT[line.tax_rate]} %`} que usa la línea ${i + 1}.`,
      );
    const discount = Number(line.discount_pct);
    return {
      item: {
        id: Number(ref) || ref || null,
        description: line.description.slice(0, 500),
        quantity: Number(line.quantity),
        price: roundCents(Number(line.unit_price)),
        ...(discount > 0 ? { discount } : {}),
        tax: tax && tax !== 'missing' ? [{ id: Number(tax.id) || tax.id }] : [],
      },
      summary: lineSummary(
        line,
        tax === null ? 'Excluido' : tax === 'missing' ? 'Sin configurar' : tax.name,
        base.totals.lines[i]?.lineTotal ?? 0,
      ),
    };
  });

  const payload: Record<string, unknown> = {
    date: today,
    dueDate: base.dueDate,
    client: { id: Number(input.customerId) || input.customerId },
    items: items.map((x) => x.item),
    paymentForm: credit ? 'CREDIT' : 'CASH',
    ...(credit ? {} : { paymentMethod: 'transfer' }),
    ...(template ? { numberTemplate: { id: Number(template.id) || template.id } } : {}),
    ...(seller ? { seller: Number(seller.id) || seller.id } : {}),
    observations: base.observations,
    ...(doc.notes ? { anotation: doc.notes.slice(0, 500) } : {}),
    stamp: { generateStamp: true },
    status: 'open',
  };
  if (!credit) notes.push('De contado: Alegra pide el medio de pago; se marca «transferencia».');

  return {
    provider: 'alegra',
    payload,
    problems: [...new Set(problems)],
    notes,
    summary: {
      documentType: template?.name ?? null,
      seller: seller?.name ?? null,
      payment: credit ? 'Crédito' : 'Contado',
      date: today,
      dueDate: base.dueDate,
      customer: `${doc.client_name}${doc.client_tax_id ? ` · NIT ${doc.client_tax_id}` : ''}`,
      lines: items.map((x) => x.summary),
      subtotal: base.totals.taxBase,
      iva: base.totals.ivaTotal,
      total: base.totals.total,
    },
  };
}

/**
 * La llave de idempotencia de una factura: la misma empresa y el mismo
 * documento dan siempre la misma llave. Alfanumérica y de 30 caracteres, como
 * la pide Siigo (`Idempotency-Key`). `hash` la pasa quien llama (sha256 en
 * hexadecimal) para que este módulo siga sin depender de node:crypto.
 */
export function idempotencyKeyFrom(hexDigest: string): string {
  return `CTX${hexDigest.replace(/[^a-f0-9]/gi, '').slice(0, 27)}`;
}
