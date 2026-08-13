import { ValidationError } from '@cortex/core';

/**
 * El vocabulario de los pagos, y toda la aritmética que no toca la base de
 * datos.
 *
 * Este módulo no importa nada del paquete salvo los errores, a propósito: es el
 * sitio donde viven las reglas que hay que poder probar sin una base de datos —
 * el signo de una anulación, cuándo dos fuentes coinciden, qué manda en la cola
 * de revisión, y cómo se envejece una cartera sin mezclar monedas.
 *
 * LO QUE NO ESTÁ AQUÍ ES TAN IMPORTANTE COMO LO QUE ESTÁ. No hay ninguna
 * función que, dadas dos fuentes que discrepan, devuelva un importe. Ni una
 * media, ni un máximo, ni "la del banco gana". Esa función no existe en este
 * repositorio, y su ausencia es la regla 4: la única autoridad que resuelve una
 * disputa es una persona.
 */

// ---------------------------------------------------------------------------
// Vocabulario
// ---------------------------------------------------------------------------

export const PAYMENT_KINDS = ['payment', 'reversal', 'adjustment'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_STATES = ['reported', 'confirmed', 'disputed', 'discarded'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * Los estados que entran en un total. Los otros dos no son cifras menores: NO
 * ESTÁN EN LA CIFRA.
 *
 * Se exporta como constante y no se pasa nunca por parámetro. Un `includeAll`
 * opcional acaba pasado por algo que sólo quería más filas — es exactamente el
 * argumento con el que `queryRecords` se niega a exponer su `review_state`.
 */
export const COUNTED_STATES: readonly PaymentState[] = ['reported', 'confirmed'];

export type ClientMatchState = 'matched' | 'unmatched' | 'ambiguous' | 'no_nit';

export const KIND_LABEL: Record<PaymentKind, string> = {
  payment: 'Abono',
  reversal: 'Anulación',
  adjustment: 'Ajuste',
};

export const STATE_LABEL: Record<PaymentState, string> = {
  reported: 'Reportado',
  confirmed: 'Confirmado',
  disputed: 'En disputa',
  discarded: 'Descartado',
};

/** Los tonos del sistema de diseño: ámbar es "una persona tiene que mirar". */
export const STATE_TONE: Record<PaymentState, 'primary' | 'emerald' | 'amber' | 'neutral'> = {
  reported: 'primary',
  confirmed: 'emerald',
  disputed: 'amber',
  discarded: 'neutral',
};

// ---------------------------------------------------------------------------
// El signo
// ---------------------------------------------------------------------------

/**
 * Lo que este movimiento le hace al saldo.
 *
 * `amount` es siempre positivo en la base de datos y el signo lo pone `kind`.
 * Un único sitio, porque dos convenios de signo en dos módulos es cómo una
 * anulación acaba sumando en la pantalla y restando en el informe.
 */
export function signedAmount(kind: PaymentKind, amount: number): number {
  return kind === 'reversal' ? -amount : amount;
}

// ---------------------------------------------------------------------------
// Monedas
// ---------------------------------------------------------------------------

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Tres letras, o nada.
 *
 * NO HAY DEFAULT Y NO LO HABRÁ. Un pago sin moneda se rechaza aquí, con una
 * frase que dice qué hacer, antes de que la CHECK de la 0098 lo rechace con el
 * nombre de una constraint. Asumir COP es el error más caro disponible en este
 * producto: un abono contra una factura de importación en dólares, leído como
 * pesos, está mal por un factor de cuatro mil, y sigue pareciendo un número
 * plausible.
 */
export function requireCurrency(value: string | null | undefined): string {
  const code = (value ?? '').trim().toUpperCase();
  if (!CURRENCY.test(code)) {
    throw new ValidationError(
      'Un pago necesita su moneda escrita en tres letras (COP, USD, EUR). No se asume ninguna: un abono en dólares contado como pesos está mal por cuatro mil veces y sigue pareciendo una cifra normal.',
    );
  }
  return code;
}

/**
 * La disciplina `${clave}#${moneda}` de `aggregateRecords`, con nombre.
 *
 * Sumar 3.000 USD a 12.000.000 COP produce 12.003.000 de nada. Toda agregación
 * de este módulo agrupa por esta clave y no por la clave sola.
 */
export function currencyBucket(key: string, currency: string | null): string {
  return `${key}#${currency ?? 'sin-moneda'}`;
}

// ---------------------------------------------------------------------------
// Procedencia — el vocabulario de la 0069, sin inventar valores
// ---------------------------------------------------------------------------

export type SourceKind = 'manual' | 'system' | 'document';

export type PaymentSourceInput =
  | { kind: 'manual'; userId: string }
  | { kind: 'system'; system: string; readAt: string }
  | { kind: 'document'; documentId: string; chunkId?: string | null; quote: string };

export interface SourceColumns {
  source_kind: SourceKind;
  source_system: string | null;
  source_read_at: string | null;
  source_user_id: string | null;
  source_document_id: string | null;
  source_chunk_id: string | null;
  source_quote: string | null;
}

export class MissingPaymentSourceError extends Error {
  constructor(detail: string) {
    super(
      `Un pago no se puede registrar sin una fuente verificable: ${detail}. Todo importe que Cortex cuenta tiene que ser rastreable hasta la persona que lo escribió, el sistema del que se leyó, o la frase del comprobante de la que se citó — ver la migración 0098.`,
    );
    this.name = 'MissingPaymentSourceError';
  }
}

/**
 * Convertir una fuente en las columnas que satisfacen las tres CHECK de la
 * 0098 — y negarse, en TypeScript, a lo que no las satisfaría.
 *
 * La base de datos ya rechaza una fila sin fuente; esto existe para que la
 * negativa llegue con una frase accionable en vez del nombre de una constraint,
 * y para que la regla se escriba UNA vez en lugar de recordarse en cada
 * importador. Es deliberadamente el gemelo de `sourceColumns` en
 * commitments/shape.ts: mismo vocabulario, mismas tres ramas, mismo suelo de
 * ocho caracteres para la cita.
 */
export function paymentSourceColumns(source: PaymentSourceInput): SourceColumns {
  const base = {
    source_system: null,
    source_read_at: null,
    source_user_id: null,
    source_document_id: null,
    source_chunk_id: null,
    source_quote: null,
  };

  switch (source.kind) {
    case 'manual': {
      if (!source.userId) {
        throw new MissingPaymentSourceError(
          'un pago escrito a mano necesita la persona que lo escribió',
        );
      }
      return { ...base, source_kind: 'manual', source_user_id: source.userId };
    }
    case 'system': {
      if (!source.system || !source.readAt) {
        throw new MissingPaymentSourceError(
          'un pago importado necesita el sistema del que salió y el momento en que se leyó',
        );
      }
      return {
        ...base,
        source_kind: 'system',
        source_system: source.system.trim().slice(0, 60),
        source_read_at: source.readAt,
      };
    }
    case 'document': {
      if (!source.documentId || !source.quote || source.quote.trim().length < 8) {
        throw new MissingPaymentSourceError(
          'un pago leído de un comprobante necesita el documento y la frase literal de la que se leyó el importe',
        );
      }
      return {
        ...base,
        source_kind: 'document',
        source_document_id: source.documentId,
        source_chunk_id: source.chunkId ?? null,
        source_quote: source.quote.trim().slice(0, 600),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// La jerarquía, que ordena y no decide
// ---------------------------------------------------------------------------

/**
 * Los `source_system` que son un banco. Sólo cambia el ORDEN de la cola.
 *
 * Se compara en minúsculas y por inclusión porque un importador escribirá
 * "bancolombia-extracto" y otro "Bancolombia". Un sistema que no esté en esta
 * lista simplemente entra como sistema contable, que es un rango más abajo, y
 * el único efecto es que aparece más tarde en una lista.
 */
const BANK_SYSTEMS = ['bancolombia', 'davivienda', 'bbva', 'banco', 'bancario', 'extracto'];

/**
 * Banco > sistema contable > comprobante > manual.
 *
 * LO QUE ESTE NÚMERO PUEDE HACER: ordenar la cola de revisión, y preseleccionar
 * el valor por defecto en la pantalla de disputa.
 *
 * LO QUE NO PUEDE HACER NUNCA: decidir. No hay ninguna llamada a esta función
 * en el camino de escritura — `recordPaymentReport` no la usa, y no debe
 * usarla. En el momento en que el rango resuelve solo, un extracto que
 * malinterpreta una reversión sobreescribe al contable en silencio, y nadie
 * vuelve a auditar un número que ya parece plausible. Por eso tampoco hay una
 * columna en la 0098 que lo guarde: si no está en la tabla, ninguna consulta
 * puede ordenarse por él y llamarlo resolución.
 */
export function sourceRank(sourceKind: SourceKind, sourceSystem: string | null): number {
  if (sourceKind === 'system') {
    const name = (sourceSystem ?? '').toLowerCase();
    return BANK_SYSTEMS.some((b) => name.includes(b)) ? 4 : 3;
  }
  if (sourceKind === 'document') return 2;
  return 1;
}

/** Cómo se nombra una fuente en una frase o en un chip, en español. */
export function sourceLabel(sourceKind: SourceKind, sourceSystem: string | null): string {
  switch (sourceKind) {
    case 'system':
      return sourceSystem ?? 'un sistema externo';
    case 'document':
      return 'un comprobante';
    default:
      return 'una persona';
  }
}

/**
 * Qué cuenta como "otra fuente".
 *
 * Dos filas del mismo extracto de Bancolombia son la misma fuente hablando dos
 * veces; el extracto y el contable son dos. `source_count` cuenta identidades
 * distintas, no reportes: si contara reportes, reimportar un fichero dos veces
 * — cosa que el índice único ya impide, pero por si acaso — parecería una
 * confirmación independiente.
 */
export function sourceIdentity(row: {
  source_kind: string;
  source_system: string | null;
  source_user_id: string | null;
  source_document_id: string | null;
}): string {
  switch (row.source_kind) {
    case 'system':
      return `system:${(row.source_system ?? '').toLowerCase()}`;
    case 'document':
      return `document:${row.source_document_id ?? '?'}`;
    default:
      return `manual:${row.source_user_id ?? '?'}`;
  }
}

// ---------------------------------------------------------------------------
// Coincidir y discrepar
// ---------------------------------------------------------------------------

/** Días de holgura entre la fecha que dice una fuente y la que dice otra. */
export const MATCH_DAY_WINDOW = 5;

const DAY_MS = 86_400_000;

export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

export interface Movement {
  kind: PaymentKind;
  amount: number;
  currency: string;
  paidOn: string;
}

/**
 * ¿Dos fuentes están hablando del mismo dinero?
 *
 * Al céntimo, porque el dinero se compara al céntimo. Un importe "más o menos
 * igual" es justo el fallo que este módulo existe para evitar: es el único
 * número equivocado que nunca se detecta, porque ya parece la respuesta.
 *
 * La fecha lleva holgura: el banco fecha el 3 y el contable apunta el 4, y eso
 * es el mismo abono. El importe no lleva ninguna.
 */
export function movementsAgree(a: Movement, b: Movement): boolean {
  if (a.currency !== b.currency) return false;
  if (a.kind !== b.kind) return false;
  if (Math.abs(a.amount - b.amount) >= 0.005) return false;
  const gap = daysBetween(a.paidOn, b.paidOn);
  return gap != null && Math.abs(gap) <= MATCH_DAY_WINDOW;
}

/**
 * La frase que se le enseña a quien tiene que resolver una disputa.
 *
 * Dice QUÉ dijo cada fuente y no qué debería creerse. Es la regla 3 escrita en
 * prosa: la jerarquía ordena la lista y preselecciona una casilla, y la última
 * palabra la tiene quien está leyendo esto.
 */
export function describeDisagreement(
  standing: Movement & { sourceLabel: string },
  incoming: Movement & { sourceLabel: string },
): string {
  const left = `${standing.sourceLabel} dice ${standing.amount.toFixed(2)} ${standing.currency} el ${standing.paidOn}`;
  const right = `${incoming.sourceLabel} dice ${incoming.amount.toFixed(2)} ${incoming.currency} el ${incoming.paidOn}`;
  return `${left}; ${right}. No se promedian ni gana ninguna por ser quien es: hasta que una persona decida, este pago no entra en ninguna cifra.`;
}

// ---------------------------------------------------------------------------
// Envejecer una cartera
// ---------------------------------------------------------------------------

export interface AgeItem {
  /** Lo que queda por cobrar. Sólo cuentan los positivos. */
  balance: number;
  /** El día desde el que se cuenta: la expedición de la factura. */
  since: string | null;
}

/**
 * La edad media de una cartera, ponderada por dinero.
 *
 * Ponderada y no simple: veinte facturas de cien mil pesos con tres días y una
 * de doscientos millones con noventa no son una cartera de siete días. Una
 * factura sin fecha de expedición no envejece nada — no aporta ni peso ni días,
 * y quien la lea sabrá por el conteo que se quedó fuera.
 *
 * Se llama por moneda, nunca sobre la mezcla.
 */
export function weightedAgeDays(items: AgeItem[], today: string): number | null {
  let weight = 0;
  let acc = 0;
  for (const item of items) {
    if (item.balance <= 0 || !item.since) continue;
    const age = daysBetween(item.since, today);
    if (age == null || age < 0) continue;
    weight += item.balance;
    acc += item.balance * age;
  }
  if (weight <= 0) return null;
  return Math.round(acc / weight);
}
