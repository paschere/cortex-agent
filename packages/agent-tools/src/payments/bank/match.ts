import { nitDv, normalizeNit } from '../../clients/shape';
import { daysBetween } from '../shape';
import { normalizeText } from './format';

/**
 * ¿Qué factura paga este abono?
 *
 * PURO Y SIN BASE DE DATOS: recibe el abono, las facturas abiertas y los
 * clientes, y devuelve candidatas con sus razones en español. Lo usan la vista
 * previa, la importación y la lista de conciliación, así que «por qué Cortex
 * cree que esto es la FV-1043» tiene una sola respuesta.
 *
 * LAS SEÑALES, DE MÁS FUERTE A MÁS DÉBIL:
 *
 *   El número de la factura en la descripción o la referencia («PAGO FV-1043»).
 *   El NIT de quien paga, en una columna o dentro de la glosa, contra el de la
 *     factura o el de su cliente (con o sin dígito de verificación).
 *   El importe: exacto contra el saldo abierto; casi exacto (±1 %); o entre el
 *     85 % y el 99 %, que en Colombia casi siempre es el mismo pago con
 *     retenciones (retefuente, reteICA, reteIVA) descontadas.
 *   El nombre del cliente, aproximado: los bancos lo recortan («TRANSF COLTRANS
 *     EXPR»), así que se comparan palabras y prefijos, sin «S.A.S.» ni «LTDA».
 *   La fecha: un abono anterior a la factura no la paga y la descarta.
 *
 * CUÁNDO SE CONFIRMA SOLO (`matched`) Y POR QUÉ ES TAN ESTRICTO. Sólo cuando hay
 * UNA candidata con importe EXACTO y además una referencia (el número de la
 * factura o el NIT), y nada en la glosa nombra otra factura distinta. Todo lo
 * demás va a «por revisar» con sugerencias y una persona confirma con un clic.
 * La asimetría es la de todo el módulo de pagos: una sugerencia que sobra
 * cuesta un clic; un pago atado a la factura equivocada es una cartera mal en
 * dos facturas a la vez, y ya parece un número plausible.
 */

export interface MatchInvoice {
  /** 'document' = factura leída y confirmada (0076); 'accounting' = traída de Siigo y compañía (0165). */
  kind: 'document' | 'accounting';
  id: string;
  docNumber: string | null;
  clientId: string | null;
  /** El nombre del cliente o el de la contraparte escrita en la factura. */
  clientName: string | null;
  /** Sólo dígitos. */
  nit: string | null;
  currency: string;
  total: number;
  /** Lo que falta por pagar. */
  balance: number;
  issuedOn: string | null;
  dueOn: string | null;
  system?: string | null;
}

export interface MatchClient {
  id: string;
  name: string;
  /** Sólo dígitos, sin dígito de verificación (como `clients.tax_id`). */
  nit: string | null;
}

export interface CreditToMatch {
  amount: number;
  currency: string;
  date: string;
  description: string;
  reference?: string | null;
  nit?: string | null;
  counterparty?: string | null;
}

export type AmountFit = 'exact' | 'near' | 'retention' | 'partial' | 'over';

export interface InvoiceSuggestion {
  invoice: MatchInvoice;
  score: number;
  amountFit: AmountFit;
  invoiceRef: 'full' | 'partial' | null;
  nitMatch: boolean;
  /** De 0 a 1. */
  nameScore: number;
  /** En español, para enseñarse tal cual. */
  reasons: string[];
}

export type MatchStatus = 'matched' | 'suggested' | 'unmatched';

export interface CreditMatch {
  status: MatchStatus;
  /** La que se confirmó sola, o la mejor sugerencia. */
  best: InvoiceSuggestion | null;
  /** Hasta tres, la mejor primero. */
  suggestions: InvoiceSuggestion[];
  /** El cliente que el NIT del abono identificó, aunque no se encuentre factura. */
  clientId: string | null;
  clientNit: string | null;
  /** Por qué quedó así, en una frase. */
  reason: string;
}

const STOPWORDS = new Set([
  'SAS',
  'SA',
  'LTDA',
  'LIMITADA',
  'CIA',
  'Y',
  'DE',
  'DEL',
  'LA',
  'EL',
  'LOS',
  'LAS',
  'EU',
  'SOCIEDAD',
  'ACCIONES',
  'SIMPLIFICADA',
  'COMPANIA',
  'S',
  'A',
  'E',
  'U',
  'EN',
  'C',
  'SCA',
  'BIC',
]);

/** Las palabras que no dicen nada en una glosa bancaria. */
const BANK_WORDS = new Set([
  'PAGO',
  'PAGOS',
  'TRANSFERENCIA',
  'TRANSF',
  'ABONO',
  'CONSIGNACION',
  'RECAUDO',
  'PSE',
  'ACH',
  'NIT',
  'FACTURA',
  'FACT',
  'CTA',
  'CUENTA',
  'SUC',
  'VIRTUAL',
  'BANCOLOMBIA',
  'DAVIVIENDA',
  'BBVA',
  'BANCO',
  'BOGOTA',
  'NOMINA',
  'PROVEEDORES',
  'INTERBANCARIA',
  'ELECTRONICA',
  'RECIBIDA',
  'DESDE',
]);

function tokens(raw: string): string[] {
  return normalizeText(raw)
    .split(/[^A-Z0-9Ñ]+/)
    .filter((t) => t.length > 0);
}

/** «FV-2-22», «fv 2 22» y «FV2-22» son el mismo número (igual que `docNumberKey`). */
function compactKey(raw: string | null | undefined): string {
  return normalizeText(raw ?? '').replace(/[^A-Z0-9]/g, '');
}

function stripZeros(d: string): string {
  return d.replace(/^0+/, '') || '0';
}

/** Las corridas de dígitos de un texto, sin ceros a la izquierda. */
function digitRuns(text: string): Set<string> {
  return new Set((text.match(/\d+/g) ?? []).map(stripZeros));
}

/** ¿Nombra el texto esta factura? Completa («FV1043»), o sólo su número («1043»). */
export function invoiceRefIn(
  text: string,
  docNumber: string | null | undefined,
): 'full' | 'partial' | null {
  const key = compactKey(docNumber);
  if (!key) return null;
  const hasLetters = /[A-Z]/.test(key);
  const hasDigits = /\d/.test(key);
  if (!hasDigits) return null;
  const runs = digitRuns(text);
  if (!hasLetters) {
    // Un número de factura sólo con dígitos vale si está entero y suelto, y
    // tiene al menos 3 cifras: «22» aparece en cualquier glosa.
    const n = stripZeros(key);
    return n.length >= 3 && runs.has(n) ? 'full' : null;
  }
  if (key.length >= 4 && compactKey(text).includes(key)) return 'full';
  const tail = /(\d+)$/.exec(key)?.[1];
  if (tail) {
    const n = stripZeros(tail);
    if (n.length >= 3 && runs.has(n)) return 'partial';
  }
  return null;
}

/** Los NIT que aparecen en un texto: 900123456, 900.123.456-7, 9001234567. */
export function nitsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{3}){2,3}(?:-\d)?\b/g))
    out.add(normalizeNit(m[0]));
  for (const m of text.matchAll(/\b\d{6,11}(?:-\d)?\b/g)) out.add(normalizeNit(m[0]));
  return [...out].filter((d) => d.length >= 6 && d.length <= 11);
}

/** Mismo NIT, con o sin el dígito de verificación de cualquiera de los dos lados. */
export function nitMatches(candidate: string, nit: string | null | undefined): boolean {
  const a = normalizeNit(candidate);
  const b = normalizeNit(nit ?? '');
  if (a.length < 6 || b.length < 6) return false;
  if (a === b) return true;
  const withDv = (body: string, full: string) =>
    full.length === body.length + 1 &&
    full.startsWith(body) &&
    nitDv(body) === Number(full.slice(-1));
  return withDv(a, b) || withDv(b, a);
}

/** De 0 a 1: cuántas palabras del nombre aparecen (o empiezan) en la glosa. */
export function nameScore(text: string, name: string | null | undefined): number {
  if (!name) return 0;
  const nameTokens = tokens(name).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (nameTokens.length === 0) return 0;
  const textTokens = tokens(text).filter((t) => t.length >= 3 && !BANK_WORDS.has(t));
  if (textTokens.length === 0) return 0;
  let hits = 0;
  let strongHit = false;
  for (const nt of nameTokens) {
    const hit = textTokens.some(
      (tt) =>
        tt === nt || (tt.length >= 4 && nt.startsWith(tt)) || (nt.length >= 5 && tt.startsWith(nt)),
    );
    if (hit) {
      hits += 1;
      if (nt.length >= 4) strongHit = true;
    }
  }
  if (!strongHit) return 0;
  return hits / nameTokens.length;
}

function fitOf(amount: number, balance: number): AmountFit {
  if (Math.abs(amount - balance) < 0.01) return 'exact';
  if (balance <= 0) return 'over';
  const ratio = amount / balance;
  if (Math.abs(1 - ratio) <= 0.01) return 'near';
  if (ratio >= 0.85 && ratio < 0.99) return 'retention';
  if (ratio < 0.85) return 'partial';
  return 'over';
}

const AMOUNT_POINTS: Record<AmountFit, number> = {
  exact: 50,
  near: 35,
  retention: 15,
  partial: 5,
  over: 0,
};

const MIN_SCORE = 30;

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

export interface MatchContext {
  invoices: MatchInvoice[];
  clients?: MatchClient[];
}

/** El cliente que el NIT del abono identifica, si exactamente uno lo tiene. */
function clientByNit(nits: string[], clients: MatchClient[]): MatchClient | null {
  const hits = clients.filter((c) => c.nit && nits.some((n) => nitMatches(n, c.nit)));
  return hits.length === 1 ? (hits[0] as MatchClient) : null;
}

export function scoreInvoice(
  credit: CreditToMatch,
  invoice: MatchInvoice,
  ctx: { nits: string[]; text: string; client: MatchClient | null },
): InvoiceSuggestion | null {
  if (invoice.currency !== credit.currency) return null;
  if (invoice.balance <= 0.004) return null;
  if (invoice.issuedOn) {
    const gap = daysBetween(invoice.issuedOn, credit.date);
    if (gap != null && gap < 0) return null;
  }
  const reasons: string[] = [];
  const amountFit = fitOf(credit.amount, invoice.balance);
  let score = AMOUNT_POINTS[amountFit];
  if (amountFit === 'exact') reasons.push('el valor es exactamente el saldo de la factura');
  else if (amountFit === 'near') reasons.push('el valor es casi el saldo (±1 %)');
  else if (amountFit === 'retention') {
    reasons.push(
      `el valor es ${Math.round((credit.amount / invoice.balance) * 100)} % del saldo: puede ser el pago con retenciones`,
    );
  } else if (amountFit === 'partial') reasons.push('puede ser un abono parcial');

  const invoiceRef = invoiceRefIn(ctx.text, invoice.docNumber);
  if (invoiceRef === 'full') {
    score += 40;
    reasons.push(`la descripción nombra la factura ${invoice.docNumber}`);
  } else if (invoiceRef === 'partial') {
    score += 25;
    reasons.push(`la descripción trae el número de la factura ${invoice.docNumber}`);
  }

  const nitMatch =
    (invoice.nit != null && ctx.nits.some((n) => nitMatches(n, invoice.nit))) ||
    (ctx.client != null && invoice.clientId === ctx.client.id);
  if (nitMatch) {
    score += 35;
    reasons.push('el NIT de quien paga es el del cliente de la factura');
  }

  const names = nameScore(ctx.text, invoice.clientName);
  if (!nitMatch && names >= 0.5) {
    score += Math.round(25 * names);
    reasons.push(`el nombre en la descripción se parece a «${invoice.clientName}»`);
  }

  if (invoice.dueOn) {
    const gap = daysBetween(invoice.dueOn, credit.date);
    if (gap != null && Math.abs(gap) <= 15) score += 3;
  }

  const hasSignal =
    amountFit === 'exact' || amountFit === 'near' || invoiceRef != null || nitMatch || names >= 0.5;
  if (!hasSignal || score < MIN_SCORE) return null;
  return { invoice, score, amountFit, invoiceRef, nitMatch, nameScore: names, reasons };
}

function isStrong(s: InvoiceSuggestion): boolean {
  return s.amountFit === 'exact' && (s.invoiceRef != null || s.nitMatch);
}

/** La frase que acompaña la factura en la lista. */
export function invoiceLabel(invoice: MatchInvoice): string {
  const number = invoice.docNumber ? `Factura ${invoice.docNumber}` : 'Factura sin número';
  const who = invoice.clientName ? ` · ${invoice.clientName}` : '';
  return `${number}${who} · saldo ${money(invoice.balance, invoice.currency)}`;
}

/** Un abono contra todas las facturas abiertas. */
export function matchCredit(credit: CreditToMatch, ctx: MatchContext): CreditMatch {
  const text = [credit.description, credit.reference, credit.counterparty]
    .filter(Boolean)
    .join(' ');
  const nits = [...(credit.nit ? [normalizeNit(credit.nit)] : []), ...nitsIn(text)].filter(
    (n) => n.length >= 6,
  );
  const client = clientByNit(nits, ctx.clients ?? []);
  const nameText = [text, credit.counterparty].filter(Boolean).join(' ');

  const scored = ctx.invoices
    .map((inv) => scoreInvoice(credit, inv, { nits, text: nameText, client }))
    .filter((s): s is InvoiceSuggestion => s != null)
    .sort((a, b) => b.score - a.score || a.invoice.balance - b.invoice.balance);

  const clientNit = client?.nit ?? null;
  const base = { clientId: client?.id ?? null, clientNit };

  if (scored.length === 0) {
    return {
      status: 'unmatched',
      best: null,
      suggestions: [],
      ...base,
      reason: client
        ? 'Es de un cliente conocido, pero ninguna factura abierta cuadra con el valor.'
        : 'No encontré una factura abierta que cuadre por valor, número, NIT ni nombre.',
    };
  }

  const strong = scored.filter(isStrong);
  const top = strong[0];
  // Otra factura nombrada entera en la glosa, distinta de la elegida: dudoso.
  const otherNamed =
    top != null &&
    scored.some((s) => s !== top && s.invoiceRef === 'full' && top.invoiceRef !== 'full');
  if (strong.length === 1 && top && !otherNamed) {
    return {
      status: 'matched',
      best: top,
      suggestions: [top],
      ...base,
      reason: `Confirmado solo: ${top.reasons.join(' y ')}.`,
    };
  }

  const suggestions = scored.slice(0, 3);
  return {
    status: 'suggested',
    best: suggestions[0] ?? null,
    suggestions,
    ...base,
    reason:
      strong.length > 1
        ? `Hay ${strong.length} facturas que cuadran igual de bien; escoge cuál es.`
        : 'Hay una factura probable, pero no hay señal suficiente para confirmarla sola.',
  };
}

/**
 * Todos los abonos de un extracto. Si dos abonos se confirman solos contra la
 * MISMA factura, ninguno de los dos se queda confirmado: es exactamente la duda
 * que tiene que mirar una persona.
 */
export function matchCredits(credits: CreditToMatch[], ctx: MatchContext): CreditMatch[] {
  const results = credits.map((c) => matchCredit(c, ctx));
  const claims = new Map<string, number>();
  for (const r of results) {
    if (r.status !== 'matched' || !r.best) continue;
    const key = `${r.best.invoice.kind}:${r.best.invoice.id}`;
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  return results.map((r) => {
    if (r.status !== 'matched' || !r.best) return r;
    const key = `${r.best.invoice.kind}:${r.best.invoice.id}`;
    if ((claims.get(key) ?? 0) <= 1) return r;
    return {
      ...r,
      status: 'suggested',
      reason: 'Otro abono del mismo extracto apunta a la misma factura; confirma cuál la paga.',
    };
  });
}
