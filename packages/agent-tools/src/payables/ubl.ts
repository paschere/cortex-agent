import {
  type XmlElement,
  XmlError,
  at,
  child,
  children,
  descendants,
  parseXml,
  textAt,
} from './xml';

/**
 * LA FACTURA ELECTRÓNICA DE LA DIAN, LEÍDA DEL XML (UBL 2.1). Puro.
 *
 * Lo que llega por correo de un proveedor es casi siempre un ZIP con un XML y
 * el PDF. El XML viene de dos maneras:
 *
 *   - `AttachedDocument` (el contenedor que exige la DIAN desde 2021): la
 *     factura va como texto dentro de
 *     `Attachment/ExternalReference/Description` (CDATA), y la respuesta de
 *     validación de la DIAN (`ApplicationResponse`) al lado.
 *   - `Invoice` suelto (algunos emisores todavía lo mandan así).
 *
 * De la factura se lee lo que sirve para pagarla bien: CUFE, número, NIT y
 * nombre del emisor (el proveedor) y del adquiriente (nosotros), fechas,
 * subtotal, impuestos (IVA, INC, ICA), retenciones que vengan informadas
 * (ReteIVA, ReteFuente, ReteICA), total a pagar, orden de compra referida y
 * líneas. Las notas crédito y débito se reconocen (`kind`) para que quien
 * llama decida; no se confunden con una factura.
 *
 * Los montos son números en la moneda del documento. Las fechas, AAAA-MM-DD.
 * Si algo esencial falta (número, NIT del emisor, total), `parseUblInvoice`
 * lanza `UblError` diciendo qué.
 */

export type UblKind = 'invoice' | 'credit_note' | 'debit_note';

export interface UblParty {
  name: string | null;
  /** NIT en dígitos, sin dígito de verificación. */
  nit: string | null;
  /** El dígito de verificación que trae el XML, si lo trae. */
  dv: string | null;
}

export interface UblTax {
  /** Código DIAN del tributo: 01 IVA, 03 ICA, 04 INC, 05 ReteIVA, 06 ReteFuente, 07 ReteICA. */
  code: string;
  label: string;
  amount: number;
  /** Porcentaje, si viene. */
  percent: number | null;
  base: number | null;
}

export interface UblLine {
  position: number;
  description: string;
  /** Código del ítem del vendedor o estándar, si viene. */
  code: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  /** Valor de la línea antes de impuestos. */
  amount: number;
}

export interface UblInvoice {
  kind: UblKind;
  /** Código único de factura electrónica (CUFE/CUDE). */
  cufe: string | null;
  number: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  supplier: UblParty;
  customer: UblParty;
  /** Suma de líneas antes de impuestos (LineExtensionAmount). */
  subtotal: number;
  /** Impuestos cargados (IVA, INC, ICA…). */
  taxes: UblTax[];
  /** Retenciones informadas en la factura (si el emisor las calculó). */
  withholdings: UblTax[];
  /** IVA total (código 01). */
  iva: number;
  /** Total a pagar (PayableAmount). */
  total: number;
  /** Número de la orden de compra que la factura cita, si cita una. */
  orderReference: string | null;
  /** Para notas: el número de la factura que corrigen. */
  billingReference: string | null;
  /** Forma de pago: '1' contado, '2' crédito. */
  paymentMeansCode: string | null;
  lines: UblLine[];
  /** Si venía dentro de un AttachedDocument con validación DIAN, su resultado. */
  dianValidation: { accepted: boolean | null; description: string | null } | null;
}

export class UblError extends Error {}

const TAX_LABEL: Record<string, string> = {
  '01': 'IVA',
  '02': 'IC',
  '03': 'ICA',
  '04': 'INC',
  '05': 'ReteIVA',
  '06': 'ReteFuente',
  '07': 'ReteICA',
  ZA: 'IVA e INC',
  ZZ: 'Otro',
};

function num(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDay(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function digits(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length >= 3 ? d : null;
}

/**
 * El NIT de una parte. `CompanyID` lleva el NIT sin DV y el DV en el atributo
 * `schemeID`; algunos emisores lo escriben con guion («900123456-7»).
 */
function readParty(party: XmlElement | null): UblParty {
  if (!party) return { name: null, nit: null, dv: null };
  const scheme = child(party, 'PartyTaxScheme');
  const legal = child(party, 'PartyLegalEntity');
  const idEl =
    child(scheme, 'CompanyID') ??
    child(legal, 'CompanyID') ??
    at(party, 'PartyIdentification/ID') ??
    null;
  let raw = idEl?.text.trim() ?? '';
  let dv = idEl?.attrs.schemeID?.trim() || null;
  const dash = raw.match(/^([\d.\s]+)-\s*(\d)$/);
  if (dash) {
    raw = dash[1] as string;
    dv = dv ?? (dash[2] as string);
  }
  const name =
    textAt(scheme, 'RegistrationName') ??
    textAt(legal, 'RegistrationName') ??
    textAt(party, 'PartyName/Name') ??
    null;
  return { name, nit: digits(raw), dv: dv && /^\d$/.test(dv) ? dv : null };
}

function readTaxTotals(root: XmlElement, name: 'TaxTotal' | 'WithholdingTaxTotal'): UblTax[] {
  const out: UblTax[] = [];
  for (const total of children(root, name)) {
    const subs = children(total, 'TaxSubtotal');
    if (!subs.length) {
      const amount = num(textAt(total, 'TaxAmount'));
      if (amount == null) continue;
      out.push({ code: 'ZZ', label: TAX_LABEL.ZZ as string, amount, percent: null, base: null });
      continue;
    }
    for (const sub of subs) {
      const amount = num(textAt(sub, 'TaxAmount'));
      if (amount == null) continue;
      const code = textAt(sub, 'TaxCategory/TaxScheme/ID') ?? 'ZZ';
      out.push({
        code,
        label: TAX_LABEL[code] ?? textAt(sub, 'TaxCategory/TaxScheme/Name') ?? code,
        amount,
        percent: num(textAt(sub, 'TaxCategory/Percent') ?? textAt(sub, 'Percent')),
        base: num(textAt(sub, 'TaxableAmount')),
      });
    }
  }
  return out;
}

function readLines(root: XmlElement, kind: UblKind): UblLine[] {
  const lineName =
    kind === 'credit_note'
      ? 'CreditNoteLine'
      : kind === 'debit_note'
        ? 'DebitNoteLine'
        : 'InvoiceLine';
  const qtyName =
    kind === 'credit_note'
      ? 'CreditedQuantity'
      : kind === 'debit_note'
        ? 'DebitedQuantity'
        : 'InvoicedQuantity';
  return children(root, lineName).map((line, i) => {
    const qtyEl = child(line, qtyName);
    const item = child(line, 'Item');
    const description =
      children(item, 'Description')
        .map((d) => d.text.trim())
        .filter(Boolean)
        .join(' ') ||
      textAt(item, 'Name') ||
      `Línea ${i + 1}`;
    return {
      position: num(textAt(line, 'ID')) ?? i + 1,
      description: description.replace(/\s+/g, ' ').slice(0, 300),
      code:
        textAt(item, 'SellersItemIdentification/ID') ??
        textAt(item, 'StandardItemIdentification/ID') ??
        null,
      quantity: num(qtyEl?.text),
      unit: qtyEl?.attrs.unitCode ?? null,
      unitPrice: num(textAt(line, 'Price/PriceAmount')),
      amount: num(textAt(line, 'LineExtensionAmount')) ?? 0,
    };
  });
}

/** El documento de verdad dentro de un AttachedDocument (o el mismo si no lo es). */
function unwrap(root: XmlElement): {
  doc: XmlElement;
  validation: UblInvoice['dianValidation'];
} {
  if (root.name !== 'AttachedDocument') return { doc: root, validation: null };
  let doc: XmlElement | null = null;
  let validation: UblInvoice['dianValidation'] = null;
  for (const desc of descendants(root, 'Description')) {
    const raw = desc.text.trim();
    if (!raw.startsWith('<')) continue;
    let parsed: XmlElement;
    try {
      parsed = parseXml(raw);
    } catch {
      continue;
    }
    if (parsed.name === 'Invoice' || parsed.name === 'CreditNote' || parsed.name === 'DebitNote') {
      doc = doc ?? parsed;
    } else if (parsed.name === 'ApplicationResponse') {
      const code = textAt(parsed, 'DocumentResponse/Response/ResponseCode');
      validation = {
        // 02 = documento validado por la DIAN; 04 = rechazado.
        accepted: code === '02' ? true : code === '04' ? false : null,
        description: textAt(parsed, 'DocumentResponse/Response/Description'),
      };
    }
  }
  if (!doc) throw new UblError('El AttachedDocument no trae la factura adentro.');
  return { doc, validation };
}

/** ¿Este texto parece un XML de factura electrónica? Barato, sin parsear. */
export function looksLikeUbl(text: string): boolean {
  const head = text.slice(0, 4000);
  return (
    /<(\w+:)?(Invoice|AttachedDocument|CreditNote|DebitNote)[\s>]/.test(head) &&
    /oasis|dian|ubl/i.test(head)
  );
}

/** Leer una factura electrónica (o su AttachedDocument). Lanza `UblError`. */
export function parseUblInvoice(xml: string): UblInvoice {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (err) {
    throw new UblError(
      `El XML no se pudo leer: ${err instanceof XmlError ? err.message : 'mal formado'}`,
    );
  }
  const { doc, validation } = unwrap(root);
  const kind: UblKind | null =
    doc.name === 'Invoice'
      ? 'invoice'
      : doc.name === 'CreditNote'
        ? 'credit_note'
        : doc.name === 'DebitNote'
          ? 'debit_note'
          : null;
  if (!kind) throw new UblError(`El XML es un «${doc.name}», no una factura.`);

  const number = textAt(doc, 'ID');
  if (!number) throw new UblError('La factura no trae número.');
  const issueDate = isoDay(textAt(doc, 'IssueDate'));
  if (!issueDate) throw new UblError('La factura no trae fecha de emisión.');
  const supplier = readParty(at(doc, 'AccountingSupplierParty/Party'));
  if (!supplier.nit) throw new UblError('La factura no trae el NIT del proveedor.');
  const customer = readParty(at(doc, 'AccountingCustomerParty/Party'));

  const totals = child(doc, 'LegalMonetaryTotal') ?? child(doc, 'RequestedMonetaryTotal');
  const total = num(textAt(totals, 'PayableAmount'));
  if (total == null) throw new UblError('La factura no trae el total a pagar.');
  const subtotal =
    num(textAt(totals, 'LineExtensionAmount')) ?? num(textAt(totals, 'TaxExclusiveAmount')) ?? 0;

  const taxes = readTaxTotals(doc, 'TaxTotal');
  const withholdings = readTaxTotals(doc, 'WithholdingTaxTotal');
  const iva = round2(taxes.filter((t) => t.code === '01').reduce((s, t) => s + t.amount, 0));

  const cufeEl = child(doc, 'UUID');
  const dueDate =
    isoDay(textAt(doc, 'DueDate')) ?? isoDay(textAt(doc, 'PaymentMeans/PaymentDueDate')) ?? null;

  return {
    kind,
    cufe: cufeEl?.text.trim() || null,
    number: number.slice(0, 120),
    issueDate,
    dueDate,
    currency: (textAt(doc, 'DocumentCurrencyCode') ?? 'COP').toUpperCase().slice(0, 3),
    supplier,
    customer,
    subtotal: round2(subtotal),
    taxes,
    withholdings,
    iva,
    total: round2(total),
    orderReference: textAt(doc, 'OrderReference/ID'),
    billingReference: textAt(doc, 'BillingReference/InvoiceDocumentReference/ID'),
    paymentMeansCode: textAt(doc, 'PaymentMeans/ID'),
    lines: readLines(doc, kind),
    dianValidation: validation,
  };
}

/** Suma de las retenciones informadas, por tipo. */
export function withholdingTotals(inv: Pick<UblInvoice, 'withholdings'>): {
  retefuente: number;
  reteiva: number;
  reteica: number;
} {
  const sum = (code: string) =>
    round2(inv.withholdings.filter((w) => w.code === code).reduce((s, w) => s + w.amount, 0));
  return { retefuente: sum('06'), reteiva: sum('05'), reteica: sum('07') };
}
