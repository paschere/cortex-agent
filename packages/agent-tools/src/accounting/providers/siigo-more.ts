import { classifyPayrollAccount } from '../payroll';
import type {
  NormalizedAccountPayable,
  NormalizedPartyBalance,
  NormalizedProduct,
  NormalizedProductPrice,
} from '../types';
import { amount, clip, currencyCode, day } from './common';
import type { ProviderDocumentFormat, ProviderDocumentKind, ProviderDocuments } from '../types';
import { parseAmount } from './reports';
import type { SiigoClient } from './siigo-client';

/**
 * LO DE SIIGO QUE FALTABA (0235). Puro: de la respuesta cruda a la forma común.
 *
 *   cuentas por pagar  GET /v1/accounts-payable (results[].due.prefix|consecutive|
 *                      quote|date|balance, provider.id|identification|name,
 *                      cost_center.code|name, currency.money_code|balance)
 *   saldos por tercero POST /v1/test-balance-report-by-thirdparty → Excel
 *   precios por lista  products[].prices[].price_list[] (position, name, value)
 *   estado DIAN        invoices[].stamp / credit-notes[].stamp
 *                      (status, cufe | cude, observations, errors)
 */

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;

// ---------------------------------------------------------------------------
// Cuentas por pagar
// ---------------------------------------------------------------------------

/** Un vencimiento del reporte oficial. `null` si no dice de qué documento es ni cuánto falta. */
export function normalizeSiigoAccountPayable(r: Raw): NormalizedAccountPayable | null {
  const due = obj(r.due);
  const prefix = clip(due?.prefix, 20);
  const consecutive = clip(due?.consecutive, 40);
  const balance = amount(due?.balance);
  if (!prefix || !consecutive || balance === undefined) return null;
  const quote = clip(due?.quote, 10);
  const provider = obj(r.provider);
  const cc = obj(r.cost_center);
  const currency = obj(r.currency);
  const foreignBalance = amount(currency?.balance);
  return {
    externalId: `${prefix}-${consecutive}-${quote ?? '1'}`,
    document: `${prefix}-${consecutive}`,
    quote,
    supplierExternalId: clip(provider?.id, 60),
    supplierTaxId: clip(provider?.identification, 40)?.replace(/\D/g, '') || undefined,
    supplierName: clip(provider?.name, 200),
    dueDate: day(due?.date),
    balance,
    currency: 'COP',
    foreignCurrency: currencyCode(currency?.money_code),
    foreignBalance: foreignBalance ? foreignBalance : undefined,
    costCenter: clip(cc?.name, 120) ?? clip(cc?.code, 40),
  };
}

// ---------------------------------------------------------------------------
// Precios por lista de precios
// ---------------------------------------------------------------------------

/** Una fila por producto, moneda y lista. Un servicio sin lista no deja filas. */
export function productPriceLines(p: NormalizedProduct): NormalizedProductPrice[] {
  return (p.priceLists ?? [])
    .filter((l) => Number.isFinite(l.value))
    .map((l) => ({
      externalId: `${p.externalId}:${l.currency}:${l.position}`,
      productExternalId: p.externalId,
      productName: p.name,
      productCode: p.code,
      listPosition: l.position,
      listName: l.name,
      currency: l.currency,
      price: l.value,
    }));
}

// ---------------------------------------------------------------------------
// Estado DIAN
// ---------------------------------------------------------------------------

export type EinvoiceState = 'Aceptada' | 'Rechazada' | 'Pendiente' | 'Sin enviar' | 'Otro';

export function einvoiceStateOf(status: string | undefined | null): EinvoiceState | undefined {
  if (!status) return undefined;
  const s = status.toLowerCase().replace(/[\s_-]/g, '');
  if (s === 'accepted') return 'Aceptada';
  if (s === 'rejected') return 'Rechazada';
  if (s === 'pending' || s === 'sent' || s === 'inprocess' || s === 'processing') return 'Pendiente';
  if (s === 'draft' || s === 'notsent' || s === 'unsent' || s === 'no') return 'Sin enviar';
  return 'Otro';
}

/** `stamp` de una factura o nota crédito → estado, CUFE/CUDE y mensaje de la DIAN. */
export function stampInfo(stamp: unknown): {
  status?: EinvoiceState;
  cufe?: string;
  message?: string;
} {
  const s = obj(stamp);
  if (!s) return {};
  const errors = s.errors;
  const errorText = Array.isArray(errors)
    ? errors
        .map((e) => (typeof e === 'string' ? e : clip(obj(e)?.message, 200)))
        .filter(Boolean)
        .join('; ')
    : typeof errors === 'string'
      ? errors
      : '';
  const message = clip([errorText, clip(s.observations, 300)].filter(Boolean).join(' · '), 400);
  return {
    status: einvoiceStateOf(typeof s.status === 'string' ? s.status : undefined),
    cufe: clip(s.cufe ?? s.cude, 200),
    message,
  };
}

/** Los mensajes de `GET /v1/invoices/{id}/stamp/errors` (`{ errors: [{ message }] }`). */
export function stampErrorMessages(body: unknown): string[] {
  const list = obj(body)?.errors;
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (typeof e === 'string' ? clip(e, 300) : clip(obj(e)?.message, 300)))
    .filter((m): m is string => Boolean(m));
}

// ---------------------------------------------------------------------------
// Balance de prueba por tercero (Excel)
// ---------------------------------------------------------------------------

export interface PartyBalanceRow {
  account: string;
  accountName?: string;
  partyTaxId: string;
  partyName?: string;
  initial: number;
  debit: number;
  credit: number;
  final: number;
}

const plain = (v: unknown) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

interface PartyColumns {
  account: number;
  accountName?: number;
  taxId: number;
  partyName?: number;
  initial?: number;
  debit: number;
  credit: number;
  final: number;
}

function matchPartyHeader(cells: string[]): PartyColumns | null {
  const find = (re: RegExp, skip: number[] = []) =>
    cells.findIndex((c, i) => !skip.includes(i) && re.test(c));
  const taxId = find(/identificaci|^nit\b|documento|^id\b/);
  const account = find(/^(codigo|cuenta|c[oó]digo cuenta)\b|codigo de la cuenta|^cuenta contable/, [taxId]);
  const debit = find(/debito/);
  const credit = find(/credito/);
  const initial = find(/saldo inicial|^inicial/);
  let final = find(/saldo final|^final/);
  if (final < 0) final = cells.map((c, i) => (/^saldo$/.test(c) ? i : -1)).filter((i) => i > debit).pop() ?? -1;
  if (taxId < 0 || account < 0 || debit < 0 || credit < 0 || final < 0) return null;
  const nameCols = cells
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => /nombre|tercero|razon/.test(c) && i !== account && i !== taxId);
  const partyName = nameCols.find(({ c }) => /tercero|razon|cliente|proveedor/.test(c))?.i ?? nameCols[nameCols.length - 1]?.i;
  const accountName = nameCols.find(({ c, i }) => /cuenta/.test(c) && i !== partyName)?.i ?? nameCols.find(({ i }) => i !== partyName)?.i;
  return {
    account,
    taxId,
    debit,
    credit,
    final,
    ...(initial >= 0 ? { initial } : {}),
    ...(partyName !== undefined ? { partyName } : {}),
    ...(accountName !== undefined ? { accountName } : {}),
  };
}

/**
 * Las filas del Excel del balance de prueba por tercero. Busca el encabezado
 * (cuenta, identificación del tercero, débito, crédito y saldo final) entre
 * las primeras filas y lee hacia abajo: una fila con identificación es un
 * tercero, y la cuenta es la de su fila o, si el archivo la pone sólo en la
 * fila de título de la cuenta, la última vista. La forma exacta del archivo no
 * está documentada: si no se reconocen las columnas, devuelve `null`.
 */
export function parsePartyBalanceRows(rows: unknown[][]): PartyBalanceRow[] | null {
  let header = -1;
  let col: PartyColumns | null = null;
  const limit = Math.min(rows.length, 40);
  for (let i = 0; i < limit && !col; i++) {
    const cells = (rows[i] ?? []).map(plain);
    const single = matchPartyHeader(cells);
    if (single) {
      header = i;
      col = single;
      break;
    }
    if (i + 1 < rows.length) {
      // Encabezado partido en dos filas («Movimiento» sobre «Débito» y «Crédito»).
      const top = cells;
      const bottom = (rows[i + 1] ?? []).map(plain);
      let carry = '';
      const merged = Array.from({ length: Math.max(top.length, bottom.length) }, (_, c) => {
        if (top[c]) carry = top[c] as string;
        const b = bottom[c] ?? '';
        return [top[c] || (/debito|credito|saldo/.test(b) ? carry : ''), b].filter(Boolean).join(' ');
      });
      const split = matchPartyHeader(merged);
      if (split) {
        header = i + 1;
        col = split;
      }
    }
  }
  if (!col) return null;
  const out: PartyBalanceRow[] = [];
  let lastAccount = '';
  let lastAccountName: string | undefined;
  for (const raw of rows.slice(header + 1)) {
    const cells = raw ?? [];
    const rawAccount = String(cells[col.account] ?? '')
      .replace(/[\s.\-]/g, '')
      .trim();
    if (/^\d{4,16}$/.test(rawAccount)) {
      lastAccount = rawAccount;
      lastAccountName = col.accountName === undefined ? undefined : clip(cells[col.accountName], 120);
    }
    const tax = String(cells[col.taxId] ?? '')
      .replace(/\D/g, '')
      .slice(0, 20);
    if (!tax || !lastAccount) continue;
    const num = (i: number | undefined) => (i === undefined ? 0 : (parseAmount(cells[i]) ?? 0));
    const initial = num(col.initial);
    const debit = num(col.debit);
    const credit = num(col.credit);
    const final = num(col.final);
    if (!initial && !debit && !credit && !final) continue;
    out.push({
      account: lastAccount,
      accountName: lastAccountName,
      partyTaxId: tax,
      partyName: col.partyName === undefined ? undefined : clip(cells[col.partyName], 200),
      initial,
      debit,
      credit,
      final,
    });
  }
  return out;
}

/**
 * Los saldos de un mes como filas de la tabla. Las cuentas de nómina (5105,
 * 2505…) pierden al tercero —una persona— y se suman por cuenta, igual que en
 * los movimientos contables.
 */
export function partyBalanceLines(
  period: string,
  rows: readonly PartyBalanceRow[],
  inProgress: boolean,
): NormalizedPartyBalance[] {
  const byKey = new Map<string, NormalizedPartyBalance>();
  for (const r of rows) {
    const confidential = classifyPayrollAccount(r.account) !== null;
    const tax = confidential ? 'nomina' : r.partyTaxId;
    const key = `party|${period}|${r.account}|${tax}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.initial = Math.round((prev.initial + r.initial) * 100) / 100;
      prev.debit = Math.round((prev.debit + r.debit) * 100) / 100;
      prev.credit = Math.round((prev.credit + r.credit) * 100) / 100;
      prev.final = Math.round((prev.final + r.final) * 100) / 100;
      continue;
    }
    byKey.set(key, {
      externalId: key,
      period,
      account: r.account,
      accountName: r.accountName,
      partyTaxId: confidential ? 'nomina' : r.partyTaxId,
      partyName: confidential ? 'Nómina (confidencial)' : r.partyName,
      initial: r.initial,
      debit: r.debit,
      credit: r.credit,
      final: r.final,
      inProgress,
    });
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// PDF y XML bajo demanda
// ---------------------------------------------------------------------------

const DOCUMENT_PATH: Record<ProviderDocumentKind, string> = {
  invoice: '/v1/invoices',
  credit_note: '/v1/credit-notes',
};

/**
 * PDF y XML de un documento electrónico, pedidos a Siigo cada vez (no se
 * guardan). Siigo responde JSON `{ id, base64 }`. El XML sólo está documentado
 * para facturas; el de una nota crédito se intenta y, si Siigo no lo da,
 * se dice con claridad.
 */
export function siigoDocuments(client: Pick<SiigoClient, 'get'>): ProviderDocuments {
  return {
    async fetch(kind: ProviderDocumentKind, externalId: string, format: ProviderDocumentFormat) {
      if (!/^[A-Za-z0-9-]{1,80}$/.test(externalId)) throw new Error('El documento no es válido.');
      let body: { base64?: string } | null;
      try {
        body = await client.get<{ base64?: string } | null>(
          `${DOCUMENT_PATH[kind]}/${externalId}/${format}`,
        );
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 400)
          throw new Error(
            format === 'xml' && kind === 'credit_note'
              ? 'Siigo no entrega el XML de las notas crédito por API.'
              : `Siigo no encontró el ${format.toUpperCase()} de este documento (puede no estar enviado a la DIAN todavía).`,
          );
        throw err;
      }
      const b64 = body?.base64;
      if (!b64) throw new Error(`Siigo no devolvió el ${format.toUpperCase()} del documento.`);
      const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
      if (!bytes.length) throw new Error(`El ${format.toUpperCase()} que dio Siigo está vacío.`);
      return {
        bytes,
        contentType: format === 'pdf' ? 'application/pdf' : 'application/xml; charset=utf-8',
      };
    },
    async stampErrors(externalId: string) {
      if (!/^[A-Za-z0-9-]{1,80}$/.test(externalId)) return [];
      const body = await client.get<unknown>(`/v1/invoices/${externalId}/stamp/errors`);
      return stampErrorMessages(body);
    },
  };
}
