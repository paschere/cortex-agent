import { findSiigoTax, parseSiigoName, pickSiigoBankPayment } from '../../close/writeback/siigo';
import type { SiigoPaymentType, SiigoTax } from '../../close/writeback/siigo';
import {
  type CreditNoteItem,
  type CreditNotePayload,
  type CustomerPayload,
  type ReceiptPayload,
  round2,
  splitPersonName,
} from '../outbound/shape';
import {
  type CreatedProviderDocument,
  type ProviderOutbound,
  ProviderValidationError,
} from '../types';
import type { AlegraClient } from './alegra-client';
import { sameTaxId } from './invoicing';
import type { SiigoClient } from './siigo-client';

/**
 * LA MITAD DE SIIGO (Y ALEGRA) QUE ESCRIBE DESDE LAS APPS (0232).
 *
 * Verificado contra el API Blueprint oficial (siigoapi.docs.apiary.io):
 *
 *   cliente        POST /v1/customers   person_type, id_type (31 NIT, 13 CC),
 *                  identification, name[] (empresa: una sola cadena; persona:
 *                  nombres y apellidos), address{address, city{country_code,
 *                  state_code, city_code}}, phones[], contacts[] (first_name,
 *                  last_name, email) — los cuatro últimos son obligatorios.
 *                  `check_digit` lo calcula Siigo.
 *   recibo de caja POST /v1/vouchers    (RC, DebtPayment): un renglón por
 *                  factura (`due` = «FV-1» + consecutivo + cuota 1).
 *   nota crédito   POST /v1/credit-notes document (NC), date, invoice (id),
 *                  reason (1,2,3,4,6,7 DIAN), items[], payments[]. Para anular
 *                  o devolver TODO se copian las líneas de la factura.
 *
 * Los constructores `buildSiigo*` son puros; las lecturas del catálogo van en
 * `siigoOutbound`. Nada se manda sin que una persona haya aprobado el borrador
 * (apps/automations/outbox.ts).
 */

type Loose = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

function list(body: unknown): Loose[] {
  if (Array.isArray(body)) return body as Loose[];
  const b = body as { results?: unknown } | null;
  return Array.isArray(b?.results) ? (b.results as Loose[]) : [];
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export function buildSiigoCustomer(p: CustomerPayload): Loose {
  const words = p.name.split(/\s+/).filter(Boolean);
  const first = words[0] ?? p.name;
  const last = words.slice(1).join(' ') || first;
  return {
    type: 'Customer',
    person_type: p.personType,
    id_type: p.idType,
    identification: p.taxId,
    ...(p.dv ? { check_digit: p.dv } : {}),
    name: p.personType === 'Company' ? [p.name] : splitPersonName(p.name),
    vat_responsible: p.vatResponsible,
    address: {
      address: p.address ?? '',
      city: {
        country_code: 'Co',
        state_code: p.city?.stateCode ?? '',
        city_code: p.city?.cityCode ?? '',
      },
    },
    phones: [{ number: p.phone ?? '' }],
    contacts: [{ first_name: first, last_name: last, email: p.email ?? '' }],
  };
}

// ---------------------------------------------------------------------------
// Recibo de caja con varias facturas
// ---------------------------------------------------------------------------

export function buildSiigoVoucherMulti(input: {
  payload: ReceiptPayload;
  documentId: number | null;
  payment: SiigoPaymentType | null;
}): { body: Loose; problems: string[] } {
  const { payload } = input;
  const problems: string[] = [];
  if (!input.documentId)
    problems.push('Siigo no tiene un tipo de documento de recibo de caja (RC) activo.');
  const items = payload.applications.map((a) => {
    const due = parseSiigoName(a.invoiceNumber);
    if (!due)
      problems.push(
        `No reconozco el número de la factura «${a.invoiceNumber}» como uno de Siigo (FV-1-68).`,
      );
    return {
      due: {
        prefix: due?.prefix ?? '',
        consecutive: due?.consecutive ?? 0,
        quote: 1,
        date: a.invoiceDate ?? payload.date,
      },
      value: round2(a.amount),
    };
  });
  const total = round2(payload.applications.reduce((s, a) => s + a.amount, 0));
  return {
    body: {
      document: { id: input.documentId ?? 0 },
      date: payload.date,
      type: 'DebtPayment',
      customer: { identification: payload.customerTaxId, branch_office: 0 },
      items,
      payment: { id: input.payment?.id ?? 0, value: total },
      observations:
        `Registrado desde Cortex${payload.reference ? ` · ref. ${payload.reference}` : ''}`.slice(
          0,
          4000,
        ),
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// Nota crédito
// ---------------------------------------------------------------------------

const IVA_RATE: Record<CreditNoteItem['taxRate'], number | null> = {
  iva_19: 19,
  iva_5: 5,
  iva_0: 0,
  excluido: null,
};

export interface SiigoInvoiceDetail {
  id: string;
  total: number;
  items: Array<{
    code: string;
    description: string;
    quantity: number;
    price: number;
    taxes: Array<{ id: number }>;
  }>;
}

/** Las líneas de la factura, tal como Siigo las devuelve, listas para copiarlas a la nota. */
export function readSiigoInvoiceDetail(raw: Loose | null): SiigoInvoiceDetail | null {
  if (!raw || !raw.id) return null;
  const items = (Array.isArray(raw.items) ? (raw.items as Loose[]) : []).map((it) => {
    const quantity = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    const discount = Number(it.discount) || 0;
    // Siigo devuelve el descuento en valor o en porcentaje según el tipo de
    // documento; el neto por unidad sale del `total` de la línea (sin impuestos).
    const lineTotal = Number(it.total);
    const net =
      discount > 0 && quantity > 0 && Number.isFinite(lineTotal) ? lineTotal / quantity : price;
    return {
      code: str(it.code),
      description: str(it.description).slice(0, 200),
      quantity,
      price: round2(net),
      taxes: (Array.isArray(it.taxes) ? (it.taxes as Loose[]) : [])
        .map((t) => ({ id: Number(t.id) }))
        .filter((t) => Number.isInteger(t.id) && t.id > 0),
    };
  });
  return { id: str(raw.id), total: Number(raw.total) || 0, items };
}

export function buildSiigoCreditNote(input: {
  payload: CreditNotePayload;
  invoice: SiigoInvoiceDetail | null;
  documentId: number | null;
  payment: SiigoPaymentType | null;
  taxes: readonly SiigoTax[];
  stamp?: boolean;
}): { body: Loose; problems: string[]; total: number } {
  const { payload } = input;
  const problems: string[] = [];
  if (!input.documentId)
    problems.push('Siigo no tiene un tipo de documento de nota crédito (NC) activo.');
  if (!input.invoice)
    problems.push(`No encontré la factura ${payload.invoiceNumber} en Siigo para afectarla.`);
  let items: Loose[] = [];
  let total = 0;
  if (payload.mode === 'total') {
    for (const it of input.invoice?.items ?? []) {
      items.push({
        code: it.code,
        description: it.description,
        quantity: it.quantity,
        price: it.price,
        ...(it.taxes.length ? { taxes: it.taxes } : {}),
      });
    }
    total = round2(input.invoice?.total ?? 0);
    if (input.invoice && !items.length) problems.push('La factura no trae líneas para copiar.');
  } else {
    items = payload.items.map((it) => {
      const rate = IVA_RATE[it.taxRate];
      let taxes: Array<{ id: number }> = [];
      if (rate && rate > 0) {
        const tax = findSiigoTax(input.taxes, 'iva', rate);
        if (tax) taxes = [{ id: tax.id }];
        else problems.push(`Siigo no tiene un IVA del ${rate} %.`);
      }
      total += it.quantity * it.unitPrice * (1 + (rate ?? 0) / 100);
      return {
        code: it.productCode ?? '',
        description: it.description.slice(0, 200),
        quantity: it.quantity,
        price: round2(it.unitPrice),
        ...(taxes.length ? { taxes } : {}),
      };
    });
    total = round2(total);
  }
  const payment = input.payment;
  return {
    body: {
      document: { id: input.documentId ?? 0 },
      date: payload.date,
      ...(input.invoice ? { invoice: input.invoice.id } : {}),
      reason: payload.reason,
      observations: payload.observations.slice(0, 4000),
      items,
      payments: [
        {
          id: payment?.id ?? 0,
          value: total,
          ...(payment?.dueDate ? { due_date: payload.date } : {}),
        },
      ],
      ...(input.stamp ? { stamp: { send: true } } : {}),
    },
    problems,
    total,
  };
}

// ---------------------------------------------------------------------------
// La sesión
// ---------------------------------------------------------------------------

export function siigoOutbound(client: SiigoClient): ProviderOutbound {
  const docAndPayments = async (code: 'RC' | 'NC') => {
    const [docs, payments] = await Promise.all([
      client.get<unknown>('/v1/document-types', { type: code }),
      client.get<unknown>('/v1/payment-types', { document_type: code }),
    ]);
    const active = (r: Loose) => r.active !== false;
    const doc = list(docs).find(active);
    return {
      documentId: doc ? Number(doc.id) || null : null,
      paymentTypes: list(payments)
        .filter(active)
        .map((p) => ({ id: Number(p.id), name: str(p.name), dueDate: p.due_date === true })),
    };
  };
  const pickPayment = (
    types: SiigoPaymentType[],
    chosen: string | undefined,
    account: string | null,
  ): { type: SiigoPaymentType | null; problem: string | null } => {
    if (chosen) {
      const hit = types.find((t) => String(t.id) === chosen);
      return hit
        ? { type: hit, problem: null }
        : { type: null, problem: `La forma de pago ${chosen} de Siigo ya no existe o está inactiva.` };
    }
    return pickSiigoBankPayment(types, undefined, account);
  };

  const findInvoice = async (payload: CreditNotePayload): Promise<SiigoInvoiceDetail | null> => {
    if (payload.invoiceExternalId) {
      const raw = await client
        .get<Loose>(`/v1/invoices/${encodeURIComponent(payload.invoiceExternalId)}`)
        .catch(() => null);
      const d = readSiigoInvoiceDetail(raw);
      if (d) return d;
    }
    const found = list(await client.get<unknown>('/v1/invoices', { name: payload.invoiceNumber }))[0];
    if (!found?.id) return null;
    const raw = await client.get<Loose>(`/v1/invoices/${encodeURIComponent(str(found.id))}`);
    return readSiigoInvoiceDetail(raw);
  };

  return {
    async upsertCustomer(payload, opts) {
      const existing = list(
        await client.get<unknown>('/v1/customers', { identification: payload.taxId }),
      ).find((c) => sameTaxId(c.identification, payload.taxId));
      if (existing) {
        const name = Array.isArray(existing.name)
          ? (existing.name as unknown[]).map(str).join(' ')
          : str(existing.name);
        return { id: str(existing.id), name: name || null, created: false };
      }
      try {
        const out = await client.post<Loose>('/v1/customers', buildSiigoCustomer(payload), {
          idempotencyKey: opts.idempotencyKey,
          noun: 'el cliente',
        });
        const name = Array.isArray(out?.name)
          ? (out.name as unknown[]).map(str).join(' ')
          : str(out?.name);
        return { id: str(out?.id), name: name || payload.name, created: true };
      } catch (err) {
        // Otro proceso (o la misma llave) lo creó entre la búsqueda y el POST.
        if (err instanceof ProviderValidationError && err.details.some((d) => /already_exists/i.test(d)))
          return { id: '', name: payload.name, created: false };
        throw err;
      }
    },
    async createReceipt(payload, opts): Promise<CreatedProviderDocument> {
      const cat = await docAndPayments('RC');
      const pick = pickPayment(cat.paymentTypes, opts.paymentTypeId, payload.bankAccount);
      const built = buildSiigoVoucherMulti({
        payload,
        documentId: cat.documentId,
        payment: pick.type,
      });
      const problems = [...built.problems, ...(pick.problem ? [pick.problem] : [])];
      if (problems.length)
        throw new ProviderValidationError(`No se pudo armar el recibo: ${problems.join(' ')}`, problems);
      const out = await client.post<Loose>('/v1/vouchers', built.body, {
        idempotencyKey: opts.idempotencyKey,
        noun: 'el recibo de caja',
      });
      return {
        id: str(out?.id),
        number: str(out?.name) || (out?.number ? str(out.number) : null),
        total: Number.isFinite(Number(out?.total ?? out?.payment)) ? Number(out?.total) : null,
      };
    },
    async createCreditNote(payload, opts): Promise<CreatedProviderDocument> {
      const [cat, taxes, invoice] = await Promise.all([
        docAndPayments('NC'),
        payload.mode === 'items' ? client.get<unknown>('/v1/taxes') : Promise.resolve([]),
        findInvoice(payload),
      ]);
      const pick = pickPayment(cat.paymentTypes, opts.paymentTypeId, null);
      const built = buildSiigoCreditNote({
        payload,
        invoice,
        documentId: opts.documentTypeId ? Number(opts.documentTypeId) : cat.documentId,
        payment: pick.type,
        taxes: list(taxes).map((t) => ({
          id: Number(t.id),
          name: str(t.name),
          type: str(t.type),
          percentage: Number(t.percentage) || 0,
        })),
        stamp: opts.stamp,
      });
      const problems = [...built.problems, ...(pick.problem ? [pick.problem] : [])];
      if (problems.length)
        throw new ProviderValidationError(
          `No se pudo armar la nota crédito: ${problems.join(' ')}`,
          problems,
        );
      const out = await client.post<Loose>('/v1/credit-notes', built.body, {
        idempotencyKey: opts.idempotencyKey,
        noun: 'la nota crédito',
      });
      const stamp = (out?.stamp ?? null) as Loose | null;
      return {
        id: str(out?.id),
        number: str(out?.name) || (out?.number ? str(out.number) : null),
        total: Number.isFinite(Number(out?.total)) ? Number(out?.total) : built.total,
        einvoiceStatus: stamp?.status ? str(stamp.status) : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Alegra: sólo el cliente (el recibo y la nota crédito van por el cierre
// contable / todavía no se escriben desde las apps)
// ---------------------------------------------------------------------------

export function buildAlegraContact(p: CustomerPayload): Loose {
  return {
    name: p.name,
    identificationObject: { type: p.idType === '31' ? 'NIT' : 'CC', number: p.taxId, ...(p.dv ? { dv: p.dv } : {}) },
    kindOfPerson: p.personType === 'Company' ? 'LEGAL_ENTITY' : 'PERSON_ENTITY',
    type: ['client'],
    ...(p.email ? { email: p.email } : {}),
    ...(p.phone ? { phonePrimary: p.phone } : {}),
    address: { ...(p.address ? { address: p.address } : {}), ...(p.city ? { city: p.city.name } : {}) },
  };
}

export function alegraOutbound(client: AlegraClient): ProviderOutbound {
  return {
    async upsertCustomer(payload, opts) {
      void opts;
      const body = await client.get<unknown>('/contacts', { identification: payload.taxId, type: 'client' });
      const hit = list(body).find((c) => {
        const obj = c.identificationObject as Loose | undefined;
        return sameTaxId(c.identification, payload.taxId) || sameTaxId(obj?.number, payload.taxId);
      });
      if (hit) return { id: str(hit.id), name: str(hit.name) || null, created: false };
      const out = await client.post<Loose>('/contacts', buildAlegraContact(payload), {
        noun: 'el cliente',
      });
      return { id: str(out?.id), name: str(out?.name) || payload.name, created: true };
    },
  };
}
