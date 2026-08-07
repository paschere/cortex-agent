/**
 * What Cortex knows how to read, and what it keeps from each thing it reads.
 *
 * THE WHOLE ENGINE IS TYPE-AGNOSTIC. Classification, verification, storage,
 * review and the query tools never mention an invoice or a waybill; they work
 * off the specs in this file. Adding "manifiesto de carga" next quarter is a new
 * object in DOCUMENT_TYPES — a prompt line, a few field specs, a Spanish label —
 * and nothing else: no migration (doc_type is a free-form slug, see 0076), no
 * change to the extractor, no change to the review screen, no change to the
 * aggregation, because all four read the spec.
 *
 * THE CANONICAL SLOTS ARE WHAT MAKES THAT POSSIBLE. Every business document in
 * this trade is the same handful of facts wearing different names: a number, a
 * counterparty with a NIT, an amount, a tax, a date it was issued and a date
 * something falls due. A factura calls them `número`, `NIT del emisor`, `total`;
 * a guía calls them `número de guía`, `remitente`, `valor declarado`, `plazo de
 * entrega`. Each spec maps its own field names onto the shared slots, so
 * "cuánto le facturamos a Coltrans en julio" and "qué guías tienen plazo
 * vencido" are the same query over the same columns.
 *
 * WHY THESE SIX. They are the documents that carry a number, a counterparty and
 * a date in a Colombian postal and customs operation, and they are what actually
 * arrives in Brain Knowledge today:
 *
 *   invoice              The money in and the money out. Nothing else in this
 *                        list is asked about daily.
 *   waybill              The operation itself — the guía is the unit of work,
 *                        and its delivery deadline is the unit of complaint.
 *   customs_declaration  The reason this company exists as a customs agent, and
 *                        the document with the most expensive deadline on it.
 *   origin_certificate   Travels with the import, expires, and its absence
 *                        holds a shipment at the port.
 *   contract             Where the rates and the renewal date live.
 *   insurance_policy     The póliza behind the operation; already a first-class
 *                        `kind` in the commitments module (0069), so the two
 *                        surfaces line up.
 *
 * The seventh outcome is NO TYPE AT ALL, and it is a legitimate answer rather
 * than a fallback. See classification in extract.ts.
 */

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * How a value is read, checked and stored.
 *
 *   text    A string that must appear in the quote (a number, a name).
 *   nit     A Colombian tax id. Compared digit by digit, ignoring the dots and
 *           the dash, because "900.123.456-7" and "9001234567" are the same
 *           number written two ways — and unlike an amount, transcribing the
 *           separators away is not arithmetic.
 *   amount  A figure of money, with the currency read from the same sentence.
 *   date    A calendar day, held to migration 0069's standard: the day, the
 *           month and the year all have to be written in the quote.
 */
export type FieldKind = 'text' | 'nit' | 'amount' | 'date';

/**
 * The six columns on `document_extractions` that every type maps onto, and the
 * only things the query tools know how to filter, group and add.
 */
export type CanonicalSlot =
  | 'doc_number'
  | 'counterparty_nit'
  | 'counterparty_name'
  | 'total_amount'
  | 'tax_amount'
  | 'issued_on'
  | 'due_on';

export interface FieldSpec {
  /** Stored in `document_fields.field_key`. Stable — it is grouped on. */
  key: string;
  /** Spanish (Colombia), for the review screen and for anything Cortex says. */
  label: string;
  kind: FieldKind;
  /** Which shared column this field feeds once a person confirms it. */
  canonical?: CanonicalSlot;
  /** One line for the model: what to look for, in the words the document uses. */
  hint: string;
}

export interface DocumentTypeSpec {
  /** Slug stored in `document_extractions.doc_type`. */
  id: string;
  label: string;
  /** One line for the classifier prompt and for the screen. */
  blurb: string;
  /**
   * Phrases that identify this type on the page, lowercase and without accents
   * stripped. The classifier must quote a sentence CONTAINING one of these, so
   * "this is a factura" is a claim about words that are actually printed rather
   * than an impression. These documents are forms: they say what they are, in
   * bold, at the top. A document that does not say what it is does not get
   * classified.
   */
  cues: string[];
  fields: FieldSpec[];
}

// ---------------------------------------------------------------------------
// The types
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES: readonly DocumentTypeSpec[] = [
  {
    id: 'invoice',
    label: 'Factura',
    blurb: 'Factura de venta o de compra, electrónica o en papel.',
    cues: [
      'factura electrónica',
      'factura electronica',
      'factura de venta',
      'factura de compra',
      'factura no',
      'factura n°',
      'factura nro',
      'cufe',
      'nota crédito',
      'nota credito',
    ],
    fields: [
      {
        key: 'invoice_number',
        label: 'Número de factura',
        kind: 'text',
        canonical: 'doc_number',
        hint: 'El consecutivo de la factura, tal como está impreso (ej. "FE-4471").',
      },
      {
        key: 'issuer_nit',
        label: 'NIT del emisor',
        kind: 'nit',
        canonical: 'counterparty_nit',
        hint: 'El NIT de quien expide la factura, con o sin dígito de verificación.',
      },
      {
        key: 'issuer_name',
        label: 'Razón social del emisor',
        kind: 'text',
        canonical: 'counterparty_name',
        hint: 'El nombre de la empresa que expide la factura.',
      },
      {
        key: 'issued_on',
        label: 'Fecha de expedición',
        kind: 'date',
        canonical: 'issued_on',
        hint: 'La fecha en que se expidió la factura.',
      },
      {
        key: 'due_on',
        label: 'Fecha de vencimiento',
        kind: 'date',
        canonical: 'due_on',
        hint: 'La fecha límite de pago, sólo si está escrita como fecha.',
      },
      {
        key: 'total',
        label: 'Total a pagar',
        kind: 'amount',
        canonical: 'total_amount',
        hint: 'El total de la factura, con la moneda si el documento la dice.',
      },
      {
        key: 'iva',
        label: 'IVA',
        kind: 'amount',
        canonical: 'tax_amount',
        hint: 'El valor del IVA en dinero, no el porcentaje.',
      },
      {
        key: 'withholding',
        label: 'Retenciones',
        kind: 'amount',
        hint: 'Retefuente, reteIVA o reteICA, en dinero, si aparecen.',
      },
      {
        key: 'cufe',
        label: 'CUFE',
        kind: 'text',
        hint: 'El código único de la factura electrónica, si aparece.',
      },
    ],
  },
  {
    id: 'waybill',
    label: 'Guía de transporte',
    blurb: 'Guía, remesa terrestre de carga o manifiesto de envío.',
    cues: [
      'guía de transporte',
      'guia de transporte',
      'guía no',
      'guia no',
      'número de guía',
      'numero de guia',
      'remesa terrestre',
      'remesa de carga',
      'manifiesto de carga',
      'guía de envío',
      'guia de envio',
    ],
    fields: [
      {
        key: 'waybill_number',
        label: 'Número de guía',
        kind: 'text',
        canonical: 'doc_number',
        hint: 'El número de la guía o de la remesa, tal como está impreso.',
      },
      {
        key: 'shipper_name',
        label: 'Remitente',
        kind: 'text',
        canonical: 'counterparty_name',
        hint: 'Quien envía la carga.',
      },
      {
        key: 'shipper_nit',
        label: 'NIT del remitente',
        kind: 'nit',
        canonical: 'counterparty_nit',
        hint: 'El NIT del remitente, si aparece.',
      },
      {
        key: 'consignee_name',
        label: 'Destinatario',
        kind: 'text',
        hint: 'Quien recibe la carga.',
      },
      {
        key: 'issued_on',
        label: 'Fecha de expedición',
        kind: 'date',
        canonical: 'issued_on',
        hint: 'La fecha en que se expidió la guía.',
      },
      {
        key: 'delivery_due_on',
        label: 'Plazo de entrega',
        kind: 'date',
        canonical: 'due_on',
        hint: 'La fecha límite de entrega, sólo si está escrita como fecha.',
      },
      {
        key: 'declared_value',
        label: 'Valor declarado',
        kind: 'amount',
        canonical: 'total_amount',
        hint: 'El valor declarado de la mercancía, con su moneda si la dice.',
      },
      {
        key: 'freight_charge',
        label: 'Valor del flete',
        kind: 'amount',
        hint: 'Lo que se cobra por el transporte, si aparece.',
      },
    ],
  },
  {
    id: 'customs_declaration',
    label: 'Declaración de importación o exportación',
    blurb: 'Declaración ante la DIAN, de importación o de exportación.',
    cues: [
      'declaración de importación',
      'declaracion de importacion',
      'declaración de exportación',
      'declaracion de exportacion',
      'declaración andina',
      'declaracion andina',
      'dian',
      'formulario 500',
      'formulario 600',
      'levante',
    ],
    fields: [
      {
        key: 'declaration_number',
        label: 'Número de declaración',
        kind: 'text',
        canonical: 'doc_number',
        hint: 'El número de la declaración o de la autoadhesiva.',
      },
      {
        key: 'importer_nit',
        label: 'NIT del importador o exportador',
        kind: 'nit',
        canonical: 'counterparty_nit',
        hint: 'El NIT del declarante o del importador.',
      },
      {
        key: 'importer_name',
        label: 'Importador o exportador',
        kind: 'text',
        canonical: 'counterparty_name',
        hint: 'La razón social del importador o exportador.',
      },
      {
        key: 'filed_on',
        label: 'Fecha de presentación',
        kind: 'date',
        canonical: 'issued_on',
        hint: 'La fecha en que se presentó la declaración.',
      },
      {
        key: 'payment_due_on',
        label: 'Plazo de pago de tributos',
        kind: 'date',
        canonical: 'due_on',
        hint: 'La fecha límite para pagar los tributos, sólo si está escrita.',
      },
      {
        key: 'customs_value',
        label: 'Valor en aduana',
        kind: 'amount',
        canonical: 'total_amount',
        hint: 'El valor en aduana o el valor FOB/CIF, con su moneda.',
      },
      {
        key: 'duties_total',
        label: 'Total tributos aduaneros',
        kind: 'amount',
        canonical: 'tax_amount',
        hint: 'La suma de arancel e IVA que liquida la declaración, si está escrita.',
      },
      {
        key: 'tariff_heading',
        label: 'Subpartida arancelaria',
        kind: 'text',
        hint: 'La subpartida (10 dígitos), si aparece.',
      },
    ],
  },
  {
    id: 'origin_certificate',
    label: 'Certificado de origen',
    blurb: 'Certificado de origen de la mercancía.',
    cues: [
      'certificado de origen',
      'certificate of origin',
      'declaración juramentada de origen',
      'declaracion juramentada de origen',
      'criterio de origen',
    ],
    fields: [
      {
        key: 'certificate_number',
        label: 'Número del certificado',
        kind: 'text',
        canonical: 'doc_number',
        hint: 'El número del certificado.',
      },
      {
        key: 'exporter_name',
        label: 'Exportador',
        kind: 'text',
        canonical: 'counterparty_name',
        hint: 'La razón social del exportador.',
      },
      {
        key: 'exporter_nit',
        label: 'NIT del exportador',
        kind: 'nit',
        canonical: 'counterparty_nit',
        hint: 'El NIT del exportador, si aparece.',
      },
      {
        key: 'issued_on',
        label: 'Fecha de expedición',
        kind: 'date',
        canonical: 'issued_on',
        hint: 'La fecha en que se expidió el certificado.',
      },
      {
        key: 'expires_on',
        label: 'Fecha de vencimiento',
        kind: 'date',
        canonical: 'due_on',
        hint: 'La fecha hasta la cual es válido, sólo si está escrita.',
      },
      {
        key: 'country_of_origin',
        label: 'País de origen',
        kind: 'text',
        hint: 'El país declarado como origen de la mercancía.',
      },
    ],
  },
  {
    id: 'contract',
    label: 'Contrato',
    blurb: 'Contrato de prestación de servicios, transporte o suministro.',
    cues: [
      'contrato de prestación',
      'contrato de prestacion',
      'contrato de transporte',
      'contrato de suministro',
      'entre las partes',
      'cláusula primera',
      'clausula primera',
      'otrosí',
      'otrosi',
    ],
    fields: [
      {
        key: 'contract_number',
        label: 'Número del contrato',
        kind: 'text',
        canonical: 'doc_number',
        hint: 'El número o código del contrato, si lo tiene.',
      },
      {
        key: 'counterparty_name',
        label: 'Contraparte',
        kind: 'text',
        canonical: 'counterparty_name',
        hint: 'La otra parte del contrato.',
      },
      {
        key: 'counterparty_nit',
        label: 'NIT de la contraparte',
        kind: 'nit',
        canonical: 'counterparty_nit',
        hint: 'El NIT de la otra parte, si aparece.',
      },
      {
        key: 'signed_on',
        label: 'Fecha de firma',
        kind: 'date',
        canonical: 'issued_on',
        hint: 'La fecha de firma, sólo si está escrita como fecha.',
      },
      {
        key: 'expires_on',
        label: 'Fecha de terminación',
        kind: 'date',
        canonical: 'due_on',
        hint: 'La fecha en que termina la vigencia, sólo si está escrita como fecha. Si el contrato dice "doce meses desde…", NO la calcules.',
      },
      {
        key: 'contract_value',
        label: 'Valor del contrato',
        kind: 'amount',
        canonical: 'total_amount',
        hint: 'El valor total pactado, con su moneda.',
      },
    ],
  },
  {
    id: 'insurance_policy',
    label: 'Póliza',
    blurb: 'Póliza de seguro: transporte, cumplimiento, responsabilidad civil.',
    cues: [
      'póliza',
      'poliza',
      'certificado de seguro',
      'amparo',
      'asegurado',
      'tomador',
      'valor asegurado',
    ],
    fields: [
      {
        key: 'policy_number',
        label: 'Número de póliza',
        kind: 'text',
        canonical: 'doc_number',
        hint: 'El número de la póliza.',
      },
      {
        key: 'insurer_name',
        label: 'Aseguradora',
        kind: 'text',
        canonical: 'counterparty_name',
        hint: 'La compañía de seguros.',
      },
      {
        key: 'insurer_nit',
        label: 'NIT de la aseguradora',
        kind: 'nit',
        canonical: 'counterparty_nit',
        hint: 'El NIT de la aseguradora, si aparece.',
      },
      {
        key: 'starts_on',
        label: 'Inicio de vigencia',
        kind: 'date',
        canonical: 'issued_on',
        hint: 'La fecha en que empieza la vigencia.',
      },
      {
        key: 'expires_on',
        label: 'Fin de vigencia',
        kind: 'date',
        canonical: 'due_on',
        hint: 'La fecha en que termina la vigencia, sólo si está escrita como fecha.',
      },
      {
        key: 'insured_amount',
        label: 'Valor asegurado',
        kind: 'amount',
        canonical: 'total_amount',
        hint: 'El valor asegurado, con su moneda.',
      },
      {
        key: 'premium',
        label: 'Prima',
        kind: 'amount',
        hint: 'La prima que se paga por la póliza, si aparece.',
      },
    ],
  },
] as const;

const BY_ID = new Map(DOCUMENT_TYPES.map((t) => [t.id, t]));

export function documentType(id: string | null | undefined): DocumentTypeSpec | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

export function documentTypeIds(): string[] {
  return DOCUMENT_TYPES.map((t) => t.id);
}

/**
 * The Spanish name of a type, including for a slug this build no longer knows.
 *
 * Rows outlive code. A type removed from the list above still has rows pointing
 * at it, and a screen that renders "undefined" over somebody's confirmed
 * invoices is worse than one that renders the slug.
 */
export function typeLabel(id: string | null | undefined): string {
  if (!id) return 'Sin clasificar';
  return BY_ID.get(id)?.label ?? id;
}

export function fieldSpec(typeId: string | null, key: string): FieldSpec | null {
  const spec = documentType(typeId);
  return spec?.fields.find((f) => f.key === key) ?? null;
}

export function fieldLabel(typeId: string | null, key: string): string {
  return fieldSpec(typeId, key)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

export const CURRENCIES = ['COP', 'USD', 'EUR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * How an amount is written out in Colombian Spanish.
 *
 * A null currency is rendered as "sin moneda" rather than assumed to be pesos.
 * That assumption is the single most expensive one available here: an import
 * invoice priced in dollars, read as pesos, is off by a factor of four thousand
 * in the direction that still looks like a plausible number.
 */
export function money(amount: number | null, currency: string | null): string {
  if (amount == null) return '—';
  const figure = amount.toLocaleString('es-CO', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  if (!currency) return `$${figure} (sin moneda)`;
  return `$${figure} ${currency}`;
}
