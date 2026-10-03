import type { AlegraClient } from '../../accounting/providers/alegra-client';
import { sameTaxId } from '../../accounting/providers/invoicing';
import type { AccountMap, ResolvedAccount } from './mapping';
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
 * ESCRIBIR EN ALEGRA (migración 0192). Verificado contra la referencia
 * oficial (developer.alegra.com/reference: post_bills, post_payments,
 * listbankaccounts, categoriesindex, listcontacts):
 *
 *   compra          POST /bills      `provider{id}` (el contacto proveedor por
 *                   NIT), `numberTemplate.number` = el número del proveedor (no
 *                   hay `billNumber`), `purchases.categories[]` = cuentas
 *                   contables {id, price, quantity, tax[{id}]}, `retentions[]`
 *                   {id, amount}, `costCenter{id}`.
 *   recibo          POST /payments   `client{id}`, `bankAccount{id}`,
 *                   `paymentMethod`, `invoices[{id, amount}]`.
 *   pago_proveedor  POST /payments   igual, con `bills[{id, amount}]`; el
 *                   proveedor también va en `client` (no hay `provider`).
 *                   `type` sólo se exige al pagar contra categorías.
 *
 * Alegra NO tiene llave de idempotencia. La defensa es la toma única de
 * store.ts y, tras una escritura incierta, `find`: buscar la compra por
 * proveedor y número, o el pago por factura, fecha y valor.
 *
 * Alegra no recibe el código PUC: recibe el id de SU cuenta (categoría). Se
 * busca por código en el catálogo (`GET /categories?format=plain`) y, si no
 * está, por el id que la empresa guardó en /cierre → Cuentas.
 */

type Loose = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

function list(body: unknown): Loose[] {
  if (Array.isArray(body)) return body as Loose[];
  const b = body as { data?: unknown; results?: unknown } | null;
  if (Array.isArray(b?.data)) return b.data as Loose[];
  if (Array.isArray(b?.results)) return b.results as Loose[];
  return [];
}

export interface AlegraWriteCatalog {
  taxes: Array<{ id: string; type: string; percentage: number }>;
  retentions: Array<{ id: string; type: string; percentage: number }>;
  categories: Array<{ id: string; code: string; name: string }>;
  bankAccounts: Array<{ id: string; name: string }>;
}

/** La cuenta de Alegra de una cuenta de Cortex: el id guardado, o por código. */
export function alegraCategoryId(
  acc: ResolvedAccount,
  categories: AlegraWriteCatalog['categories'],
): string | null {
  if (acc.refs.alegra) return acc.refs.alegra;
  const exact = categories.find((c) => c.code === acc.code);
  if (exact) return exact.id;
  // Una subcuenta (6 dígitos) contra auxiliares de Alegra: si hay UNA que empieza así, ésa.
  const under = categories.filter((c) => c.code.startsWith(acc.code));
  return under.length === 1 ? (under[0] as { id: string }).id : null;
}

function findRate<T extends { type: string; percentage: number }>(
  rows: readonly T[],
  match: (type: string) => boolean,
  rate: number,
): T | null {
  const tol = Math.max(0.06, rate * 0.02);
  return (
    rows.find((r) => match(r.type.toLowerCase()) && Math.abs(r.percentage - rate) <= tol) ?? null
  );
}

function rateOf(part: number, base: number): number {
  if (base <= 0) return 0;
  const r = (part / base) * 100;
  return r < 1 ? Math.round(r * 1000) / 1000 : Math.round(r * 100) / 100;
}

export function buildAlegraBill(input: {
  src: PurchaseSource;
  map: AccountMap;
  catalog: AlegraWriteCatalog;
  providerId: string | null;
}): { payload: Loose; problems: string[]; warnings: string[] } {
  const { src, map, catalog } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!input.providerId)
    problems.push(
      `${src.supplierName} (NIT ${src.supplierNit ?? 'sin NIT'}) no está como proveedor en Alegra: créalo allá primero.`,
    );
  const expense = map.expense({ supplierId: src.supplierId, category: src.category });
  const categoryId = alegraCategoryId(expense, catalog.categories);
  if (!categoryId)
    problems.push(
      `No encontré en Alegra la cuenta ${expense.code} (${expense.name}): pon su id de Alegra en /cierre → Cuentas.`,
    );
  const tax: Array<{ id: string }> = [];
  if (src.iva > 0) {
    let rate = rateOf(src.iva, src.subtotal);
    for (const r of [19, 5]) if (Math.abs(rate - r) <= 0.6) rate = r;
    const t = findRate(catalog.taxes, (x) => x.includes('iva'), rate);
    if (t) tax.push({ id: t.id });
    else problems.push(`Alegra no tiene un IVA del ${rate} %.`);
  }
  const retentions: Array<{ id: string; amount: number }> = [];
  const want: Array<[number, (t: string) => boolean, number, string]> = [
    [
      src.withholdings.retefuente,
      (t) => t.includes('fuente') || t === 'rtf',
      src.subtotal,
      'retención en la fuente',
    ],
    [src.withholdings.reteiva, (t) => t.includes('iva'), src.iva, 'ReteIVA'],
    [src.withholdings.reteica, (t) => t.includes('ica'), src.subtotal, 'ReteICA'],
  ];
  for (const [amount, match, base, label] of want) {
    if (amount <= 0) continue;
    const rate = rateOf(amount, base);
    const r = findRate(catalog.retentions, match, rate);
    if (r) retentions.push({ id: r.id, amount: round2(amount) });
    else problems.push(`Alegra no tiene una ${label} del ${rate} %.`);
  }
  const base = round2(src.subtotal + src.otherTaxes);
  const lineSum = round2(src.lines.reduce((s, l) => s + l.amount, 0));
  const useLines = src.lines.length > 0 && src.lines.length <= 50 && Math.abs(lineSum - base) <= 1;
  const rows = useLines
    ? src.lines.map((l) => ({ observations: l.description, price: l.amount }))
    : [{ observations: `Factura ${src.docNumber} de ${src.supplierName}`, price: base }];
  const cc = Number(expense.costCenter);
  const payload: Loose = {
    date: src.issueDate,
    dueDate: src.dueDate ?? src.issueDate,
    provider: { id: input.providerId ?? '' },
    numberTemplate: { number: src.docNumber.slice(0, 40) },
    observations: `Causada desde Cortex${src.cufe ? ` · CUFE ${src.cufe.slice(0, 40)}…` : ''}`,
    purchases: {
      categories: rows.map((r) => ({
        id: categoryId ?? '',
        price: round2(r.price),
        quantity: 1,
        observations: r.observations.slice(0, 200),
        ...(tax.length ? { tax } : {}),
      })),
    },
    ...(retentions.length ? { retentions } : {}),
    ...(Number.isInteger(cc) && cc > 0 ? { costCenter: { id: cc } } : {}),
  };
  return { payload, problems, warnings };
}

/** La cuenta de banco de Alegra: la guardada, la del mismo nombre, o la única. */
export function pickAlegraBank(
  accounts: AlegraWriteCatalog['bankAccounts'],
  mapped: string | undefined,
  accountName: string | null,
): { id: string | null; problem: string | null } {
  if (mapped) return { id: mapped, problem: null };
  if (accountName) {
    const words = accountName
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const named = accounts.filter((a) => words.some((w) => a.name.toLowerCase().includes(w)));
    if (named.length === 1) return { id: (named[0] as { id: string }).id, problem: null };
  }
  if (accounts.length === 1) return { id: (accounts[0] as { id: string }).id, problem: null };
  return {
    id: null,
    problem: `Elige en /cierre → Cuentas qué banco de Alegra es la cuenta ${accountName ?? 'del extracto'} (hay ${accounts.length}).`,
  };
}

export function buildAlegraPayment(input: {
  src: ReceiptSource | SupplierPaymentSource;
  contactId: string | null;
  bankAccountId: string | null;
}): { payload: Loose; problems: string[] } {
  const { src } = input;
  const problems: string[] = [];
  if (!input.contactId)
    problems.push(
      src.kind === 'recibo'
        ? 'No encontré el cliente de esa factura en Alegra.'
        : `No encontré a ${src.supplierName} como proveedor en Alegra.`,
    );
  if (!input.bankAccountId) problems.push('Falta la cuenta de banco de Alegra.');
  const target =
    src.kind === 'recibo'
      ? { invoices: [{ id: src.invoiceExternalId, amount: round2(src.amount) }] }
      : { bills: [{ id: src.purchaseExternalId, amount: round2(src.amount) }] };
  return {
    payload: {
      date: src.date,
      bankAccount: { id: input.bankAccountId ?? '' },
      paymentMethod: 'transfer',
      client: { id: input.contactId ?? '' },
      ...target,
      observations:
        `Registrado desde Cortex${src.reference ? ` · ref. banco ${src.reference}` : ''}`.slice(
          0,
          500,
        ),
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// La sesión
// ---------------------------------------------------------------------------

const NOUN: Record<WritebackSource['kind'], string> = {
  compra: 'la factura de compra',
  recibo: 'el pago recibido',
  pago_proveedor: 'el pago al proveedor',
};

export function alegraWriter(client: AlegraClient): ProviderWriter {
  const findProvider = async (nit: string | null): Promise<string | null> => {
    if (!nit) return null;
    const body = await client.get<unknown>('/contacts', { identification: nit, type: 'provider' });
    // El filtro de Alegra es «contiene»: el NIT se vuelve a comparar aquí.
    const hit = list(body).find((c) => {
      const obj = c.identificationObject as Loose | undefined;
      return sameTaxId(c.identification, nit) || sameTaxId(obj?.number, nit);
    });
    return hit ? str(hit.id) : null;
  };
  const bankAccounts = async () =>
    list(await client.get<unknown>('/bank-accounts', { limit: 30 }))
      .filter((a) => a.status !== 'inactive')
      .map((a) => ({ id: str(a.id), name: str(a.name) }));

  return {
    provider: 'alegra',
    supports: { compra: true, recibo: true, pago_proveedor: true },
    async prepare(src, _entries: EntryLine[], map) {
      if (src.kind === 'compra') {
        const [providerId, taxes, retentions, categories] = await Promise.all([
          findProvider(src.supplierNit),
          client.get<unknown>('/taxes'),
          client.get<unknown>('/retentions').catch(() => []),
          client.get<unknown>('/categories', { format: 'plain' }),
        ]);
        const pct = (r: Loose) => Number(r.percentage) || 0;
        return buildAlegraBill({
          src,
          map,
          providerId,
          catalog: {
            taxes: list(taxes).map((t) => ({
              id: str(t.id),
              type: str(t.type) || str(t.name),
              percentage: pct(t),
            })),
            retentions: list(retentions).map((t) => ({
              id: str(t.id),
              type: `${str(t.type)} ${str(t.name)}`,
              percentage: pct(t),
            })),
            categories: list(categories).map((c) => ({
              id: str(c.id),
              code: str(c.code),
              name: str(c.name),
            })),
            bankAccounts: [],
          },
        });
      }
      const bank = map.bank(src.bankAccount);
      const accounts = await bankAccounts();
      const pick = pickAlegraBank(accounts, bank.refs.alegra, src.bankAccount);
      let contactId: string | null = null;
      if (src.kind === 'recibo') {
        const inv = await client
          .get<Loose>(`/invoices/${encodeURIComponent(src.invoiceExternalId)}`)
          .catch(() => null);
        contactId = str((inv?.client as Loose | undefined)?.id) || null;
      } else {
        const bill = await client
          .get<Loose>(`/bills/${encodeURIComponent(src.purchaseExternalId)}`)
          .catch(() => null);
        contactId =
          str((bill?.provider as Loose | undefined)?.id) || (await findProvider(src.supplierNit));
      }
      const out = buildAlegraPayment({ src, contactId, bankAccountId: pick.id });
      return {
        ...out,
        problems: [...out.problems, ...(pick.problem ? [pick.problem] : [])],
        warnings: [],
      };
    },
    async send(src, payload): Promise<WrittenDocument> {
      const out = await client.post<Loose>(
        src.kind === 'compra' ? '/bills' : '/payments',
        payload,
        {
          noun: NOUN[src.kind],
        },
      );
      const tpl = (out?.numberTemplate ?? null) as Loose | null;
      return {
        id: str(out?.id),
        number: str(tpl?.fullNumber) || str(tpl?.number) || str(out?.number) || null,
        status: str(out?.status) || null,
      };
    },
    async find(src) {
      if (src.kind === 'compra') {
        const body = await client.get<unknown>('/bills', {
          order_field: 'date',
          order_direction: 'DESC',
          limit: 30,
        });
        const hit = list(body).find((b) => {
          const tpl = (b.numberTemplate ?? {}) as Loose;
          return str(tpl.number) === src.docNumber.slice(0, 40) && str(b.date) === src.issueDate;
        });
        return hit ? { id: str(hit.id), number: src.docNumber } : null;
      }
      const body = await client.get<unknown>('/payments', {
        order_field: 'date',
        order_direction: 'DESC',
        limit: 30,
      });
      const target = src.kind === 'recibo' ? src.invoiceExternalId : src.purchaseExternalId;
      const hit = list(body).find((p) => {
        const docs = (src.kind === 'recibo' ? p.invoices : p.bills) as Loose[] | undefined;
        return (
          str(p.date) === src.date &&
          Math.abs(Number(p.amount ?? 0) - src.amount) < 1 &&
          (docs ?? []).some((d) => str(d.id) === target)
        );
      });
      return hit ? { id: str(hit.id), number: str(hit.number) || null } : null;
    },
  };
}
