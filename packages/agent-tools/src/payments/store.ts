import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { nitDv, normalizeNit } from '../clients/shape';
import { findClientByNit } from '../clients/store';
import { bogotaToday } from '../commitments/shape';
import {
  COUNTED_STATES,
  type ClientMatchState,
  MATCH_DAY_WINDOW,
  type Movement,
  type PaymentKind,
  type PaymentSourceInput,
  type PaymentState,
  currencyBucket,
  daysBetween,
  describeDisagreement,
  movementsAgree,
  paymentSourceColumns,
  requireCurrency,
  signedAmount,
  sourceIdentity,
  sourceLabel,
  weightedAgeDays,
} from './shape';

/**
 * Toda lectura y toda escritura de pagos, en un módulo.
 *
 * DOS PUERTAS DE ESCRITURA, NOMBRADAS EN LA CABECERA DE LA 0098:
 *
 *   `writePayment`          es lo único que inserta o actualiza public.payments.
 *   `recordPaymentReport`   es lo único que inserta public.payment_reports, y
 *                           es además el emparejador entero.
 *
 * `writePayment` tiene exactamente dos llamantes: `recordPaymentReport`, que
 * crea o enlaza, y `resolvePaymentDispute`, que exige una persona. Eso es lo que
 * hace que las cinco reglas de la reconciliación no puedan tener cuatro
 * implementaciones distintas:
 *
 *   dos fuentes que coinciden enlazan y suben la confianza, nunca el importe,
 *   dos que discrepan dejan el pago en disputa y fuera de todas las cifras,
 *   la jerarquía ordena la cola pero no aparece en ninguna escritura,
 *   sólo una persona resuelve,
 *   y las monedas no se cruzan jamás.
 *
 * ESTE MÓDULO NO IMPORTA `../documents/store`, A PROPÓSITO. El puente en el otro
 * sentido sí existe — al confirmar un comprobante se registra su reporte, ver
 * `./receipt.ts` —, así que importarlo aquí cerraría un ciclo entre dos módulos
 * que se escriben el uno al otro. Lo único que se necesitaba de allí es
 * `resolveClientByNit`, y de él vive una copia corta y comentada más abajo.
 *
 * `db` es siempre un handle con alcance de espacio de trabajo (0064). Nada aquí
 * filtra por organization_id a mano y nada aquí debería recibir un cliente
 * crudo.
 */

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

export const PAYMENT_COLUMNS =
  'id, kind, amount, currency, paid_on, client_id, client_nit, client_match_state, extraction_id, invoice_number, state, source_count, disputed_at, dispute_note, resolved_at, resolved_by, resolution_note, created_at, updated_at';

export const REPORT_COLUMNS =
  'id, payment_id, kind, amount, currency, paid_on, client_id, client_nit, client_match_state, extraction_id, invoice_number, reference, note, source_kind, source_system, source_read_at, source_user_id, source_document_id, source_chunk_id, source_quote, source_ref, created_by, created_at';

/** Lo poco que la cartera necesita de una factura ya confirmada (0076). */
const INVOICE_COLUMNS =
  'id, doc_type, review_state, doc_number, client_id, counterparty_name, counterparty_nit, total_amount, currency, issued_on, due_on';

export interface PaymentRow {
  id: string;
  kind: PaymentKind;
  amount: number | string;
  currency: string;
  paid_on: string;
  client_id: string | null;
  client_nit: string | null;
  client_match_state: ClientMatchState;
  extraction_id: string | null;
  invoice_number: string | null;
  state: PaymentState;
  source_count: number;
  disputed_at: string | null;
  dispute_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
  /** Puesto por `hydratePayments`. Nunca se guarda. */
  client_name?: string | null;
}

export interface PaymentReportRow {
  id: string;
  payment_id: string | null;
  kind: PaymentKind;
  amount: number | string;
  currency: string;
  paid_on: string;
  client_id: string | null;
  client_nit: string | null;
  client_match_state: ClientMatchState;
  extraction_id: string | null;
  invoice_number: string | null;
  reference: string | null;
  note: string | null;
  source_kind: 'manual' | 'system' | 'document';
  source_system: string | null;
  source_read_at: string | null;
  source_user_id: string | null;
  source_document_id: string | null;
  source_chunk_id: string | null;
  source_quote: string | null;
  source_ref: string | null;
  created_by: string | null;
  created_at: string;
}

/** PostgREST devuelve `numeric` como número o como cadena según el driver. */
export function num(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function amountOf(row: { amount: number | string }): number {
  return num(row.amount) ?? 0;
}

function movementOf(row: {
  kind: PaymentKind;
  amount: number | string;
  currency: string;
  paid_on: string;
}): Movement {
  return {
    kind: row.kind,
    amount: amountOf(row),
    currency: row.currency,
    paidOn: row.paid_on,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// La única puerta a public.payments
// ---------------------------------------------------------------------------

/**
 * Insertar o actualizar un pago. NADA MÁS ESCRIBE EN ESTA TABLA.
 *
 * No es una comodidad: es dónde vive la garantía. Mientras esta función sea el
 * único sitio con un `.from('payments').insert(` o `.update(`, la pregunta
 * "¿puede algo mover un importe sin dejar rastro de qué fuente lo dijo?" se
 * responde leyendo sus dos llamantes, y no auditando el paquete entero.
 */
async function writePayment(
  db: SupabaseClient,
  input: { id: string | null; values: Record<string, unknown> },
): Promise<PaymentRow> {
  const values = { ...input.values, updated_at: new Date().toISOString() };
  if (input.id) {
    const { data, error } = await db
      .from('payments')
      .update(values)
      .eq('id', input.id)
      .select(PAYMENT_COLUMNS)
      .single();
    if (error) throw error;
    return data as PaymentRow;
  }
  const { data, error } = await db.from('payments').insert(values).select(PAYMENT_COLUMNS).single();
  if (error) throw error;
  return data as PaymentRow;
}

// ---------------------------------------------------------------------------
// Qué cliente es, por NIT y por nada más
// ---------------------------------------------------------------------------

/**
 * Gemelo corto de `resolveClientByNit` en documents/store.ts.
 *
 * Existe aquí, y no importado de allí, porque documents/store importa este
 * módulo por el puente del comprobante y el ciclo sería real. La lógica es la
 * misma y la razón también: el NIT es el único identificador que una empresa
 * colombiana no comparte con otra, y un nombre no lo es. Emparejar "Coltrans
 * S.A.S." con "Coltrans Express Ltda." no produce un hueco visible, produce el
 * saldo de un cliente cargado a otro.
 *
 * `clients.tax_id` guarda los dígitos SIN el de verificación (0075) y un
 * documento suele imprimirlo CON él, así que se reintenta sin el último dígito
 * sólo cuando ese dígito es exactamente el que el resto del número implica. Eso
 * es un checksum que cuadra, no una suposición.
 */
async function resolveNitToClient(
  db: SupabaseClient,
  nit: string,
): Promise<{ clientId: string | null; state: ClientMatchState }> {
  const digits = normalizeNit(nit);
  if (digits.length < 5) return { clientId: null, state: 'no_nit' };

  const candidates = [digits];
  const body = digits.slice(0, -1);
  if (body.length >= 4 && nitDv(body) === Number(digits.slice(-1))) candidates.push(body);

  for (const candidate of candidates) {
    try {
      const hit = await findClientByNit(db, candidate);
      if (hit) return { clientId: hit.id, state: 'matched' };
    } catch {
      // Tabla ausente, o dos filas con el mismo NIT: ninguna de las dos se
      // resuelve eligiendo una.
      return { clientId: null, state: 'unmatched' };
    }
  }
  return { clientId: null, state: 'unmatched' };
}

// ---------------------------------------------------------------------------
// Registrar lo que dice una fuente
// ---------------------------------------------------------------------------

export interface RecordPaymentReportInput {
  source: PaymentSourceInput;
  kind?: PaymentKind;
  amount: number;
  /** Tres letras. Sin default y sin excepciones. */
  currency: string;
  /** El día del abono, YYYY-MM-DD. */
  paidOn: string;
  /** Sólo si ya viene resuelto (la pantalla eligió el cliente de la lista). */
  clientId?: string | null;
  /** En cualquier formato; se compara dígito a dígito. */
  clientNit?: string | null;
  /** La factura que paga, cuando se sabe cuál. */
  extractionId?: string | null;
  invoiceNumber?: string | null;
  reference?: string | null;
  note?: string | null;
  /** El identificador que la fuente le dio al movimiento. La clave de reimportación. */
  sourceRef?: string | null;
  createdBy?: string | null;
}

export type RecordOutcome = 'duplicate' | 'created' | 'agreed' | 'disputed';

export interface RecordPaymentReportResult {
  outcome: RecordOutcome;
  /** Nulo sólo cuando el reporte ya estaba: no se escribió nada. */
  report: PaymentReportRow | null;
  payment: PaymentRow | null;
  /** Qué pasó, en español, para decírselo a quien lo pidió. */
  note: string;
}

/**
 * Una fuente dice que entró dinero. LA ÚNICA PUERTA A public.payment_reports, y
 * el emparejador entero.
 *
 * El orden importa y es el de las cinco reglas:
 *
 *   0. Un reporte con el mismo `source_ref` de la misma fuente YA ESTÁ. No se
 *      escribe nada y no se cuenta nada: reimportar el mismo mes de Siigo es un
 *      no-op. Se comprueba antes y lo respalda el índice único de la 0098, que
 *      es quien gana cuando dos importaciones corren a la vez.
 *
 *   1. Si ya hay un pago del que este reporte está hablando, SE ENLAZA. Sube
 *      `source_count` y el importe no se toca. Sin esto, el día que se conecte
 *      el banco encima del contable la cartera se duplica en silencio.
 *
 *   2. Si lo que dice no coincide con lo que ya estaba, el pago pasa a
 *      `disputed` y sale de todas las cifras. No se promedia, no se elige por
 *      rango, no se corrige el importe: es un hecho pendiente, no un número
 *      aproximado.
 *
 *   3. `sourceRank` no aparece en ninguna línea de esta función, y es a
 *      propósito.
 *
 *   5. Nunca se cruza una moneda con otra: `currency` entra en la identidad del
 *      movimiento antes que cualquier otra cosa.
 */
export async function recordPaymentReport(
  db: SupabaseClient,
  input: RecordPaymentReportInput,
): Promise<RecordPaymentReportResult> {
  const kind: PaymentKind = input.kind ?? 'payment';
  const currency = requireCurrency(input.currency);
  const amount = input.amount;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ValidationError(
      'Un pago necesita un importe: un número mayor o igual que cero. Si lo que hubo fue una devolución, regístralo como anulación y el signo lo pone Cortex.',
    );
  }
  if (!ISO_DATE.test(input.paidOn ?? '')) {
    throw new ValidationError(
      'Un pago necesita el día en que se pagó, en formato AAAA-MM-DD. El día que se leyó del sistema no sirve: son dos fechas distintas y sólo una es la del dinero.',
    );
  }
  const source = paymentSourceColumns(input.source);
  const sourceRef = input.sourceRef?.trim().slice(0, 200) || null;

  // --- 0. ¿Ya lo sabíamos? -------------------------------------------------
  if (sourceRef) {
    const existing = await findReportBySourceRef(
      db,
      source.source_kind,
      source.source_system,
      sourceRef,
    );
    if (existing) {
      return {
        outcome: 'duplicate',
        report: null,
        payment: existing.payment_id ? await getPayment(db, existing.payment_id) : null,
        note: `Ese movimiento ya estaba registrado (${sourceRef}). No se duplicó nada.`,
      };
    }
  }

  // --- A quién ------------------------------------------------------------
  let clientId = input.clientId ?? null;
  let clientNit = input.clientNit ? normalizeNit(input.clientNit) : null;
  let clientMatch: ClientMatchState = clientId ? 'matched' : 'no_nit';
  if (!clientId && clientNit) {
    const resolved = await resolveNitToClient(db, clientNit);
    clientId = resolved.clientId;
    clientMatch = resolved.state;
  }
  if (clientId && !clientNit) clientNit = null;

  const movement: Movement = { kind, amount, currency, paidOn: input.paidOn };

  // --- 1 y 2. ¿De qué pago está hablando? ---------------------------------
  const candidate = await findCandidatePayment(db, {
    movement,
    clientId,
    extractionId: input.extractionId ?? null,
    invoiceNumber: input.invoiceNumber ?? null,
    sourceIdentityKey: sourceIdentity({
      source_kind: source.source_kind,
      source_system: source.source_system,
      source_user_id: source.source_user_id,
      source_document_id: source.source_document_id,
    }),
  });

  let payment: PaymentRow;
  let outcome: RecordOutcome;
  let note: string;

  if (!candidate) {
    payment = await writePayment(db, {
      id: null,
      values: {
        kind,
        amount,
        currency,
        paid_on: input.paidOn,
        client_id: clientId,
        client_nit: clientNit,
        client_match_state: clientMatch,
        extraction_id: input.extractionId ?? null,
        invoice_number: input.invoiceNumber?.slice(0, 120) ?? null,
        state: 'reported',
        source_count: 1,
      },
    });
    outcome = 'created';
    note = `Registrado como pago nuevo, dicho por ${sourceLabel(source.source_kind, source.source_system)}. Cuenta desde ya, y contará más el día que una segunda fuente lo confirme.`;
  } else if (movementsAgree(movementOf(candidate.payment), movement)) {
    // REGLA 1. Dos fuentes que coinciden suman confianza, NO importe. Se enlaza
    // y se sube el contador de fuentes; `amount` no aparece en este update.
    payment = await writePayment(db, {
      id: candidate.payment.id,
      values: {
        source_count: candidate.distinctSources + 1,
        state: candidate.payment.state === 'disputed' ? 'disputed' : 'confirmed',
        // Lo que la segunda fuente sí puede aportar es lo que faltaba: la
        // factura o el cliente que la primera no supo nombrar. Rellenar un
        // hueco no es sobreescribir un dato.
        ...(candidate.payment.extraction_id == null && input.extractionId
          ? { extraction_id: input.extractionId }
          : {}),
        ...(candidate.payment.client_id == null && clientId
          ? { client_id: clientId, client_nit: clientNit, client_match_state: clientMatch }
          : {}),
      },
    });
    outcome = 'agreed';
    note = `Coincide con un pago que ya estaba: ahora lo dicen ${candidate.distinctSources + 1} fuentes distintas. El importe no cambió — dos fuentes que coinciden suman confianza, no dinero.`;
  } else {
    // REGLA 2. Discrepan. Ni media, ni rango, ni "gana el banco": fuera de toda
    // cifra hasta que una persona mire las dos versiones.
    const disagreement = describeDisagreement(
      { ...movementOf(candidate.payment), sourceLabel: candidate.standingSourceLabel },
      { ...movement, sourceLabel: sourceLabel(source.source_kind, source.source_system) },
    );
    payment = await writePayment(db, {
      id: candidate.payment.id,
      values: {
        state: 'disputed',
        disputed_at: new Date().toISOString(),
        dispute_note: disagreement.slice(0, 1000),
        source_count: candidate.distinctSources + 1,
        // Ni el importe, ni la moneda, ni la fecha se tocan. Lo que estaba
        // escrito sigue escrito; lo que llegó está en su reporte.
      },
    });
    outcome = 'disputed';
    note = `Dos fuentes dicen cosas distintas, así que este pago queda EN DISPUTA y no entra en ninguna cifra hasta que alguien decida. ${disagreement}`;
  }

  // --- El reporte, siempre, diga lo que diga ------------------------------
  const { data, error } = await db
    .from('payment_reports')
    .insert({
      payment_id: payment.id,
      kind,
      amount,
      currency,
      paid_on: input.paidOn,
      client_id: clientId,
      client_nit: clientNit,
      client_match_state: clientMatch,
      extraction_id: input.extractionId ?? null,
      invoice_number: input.invoiceNumber?.slice(0, 120) ?? null,
      reference: input.reference?.slice(0, 200) ?? null,
      note: input.note?.slice(0, 1000) ?? null,
      source_ref: sourceRef,
      created_by: input.createdBy ?? null,
      ...source,
    })
    .select(REPORT_COLUMNS)
    .single();

  if (error) {
    // El índice único de la 0098 llegó primero: otra importación escribió este
    // mismo movimiento mientras esta corría. Es el resultado correcto, no un
    // fallo — pero el pago que acabamos de tocar ya no le pertenece a nadie
    // nuevo, así que se devuelve tal cual quedó.
    if ((error as { code?: string }).code === '23505') {
      return {
        outcome: 'duplicate',
        report: null,
        payment: await getPayment(db, payment.id),
        note: `Ese movimiento ya estaba registrado (${sourceRef ?? 'misma referencia'}). No se duplicó nada.`,
      };
    }
    throw error;
  }

  return { outcome, report: data as PaymentReportRow, payment, note };
}

async function findReportBySourceRef(
  db: SupabaseClient,
  sourceKind: string,
  sourceSystem: string | null,
  sourceRef: string,
): Promise<PaymentReportRow | null> {
  let q = db
    .from('payment_reports')
    .select(REPORT_COLUMNS)
    .eq('source_kind', sourceKind)
    .eq('source_ref', sourceRef);
  q = sourceSystem == null ? q.is('source_system', null) : q.eq('source_system', sourceSystem);
  const { data, error } = await q.limit(1);
  if (error) throw error;
  return ((data ?? []) as PaymentReportRow[])[0] ?? null;
}

export async function getPayment(db: SupabaseClient, id: string): Promise<PaymentRow | null> {
  const { data, error } = await db
    .from('payments')
    .select(PAYMENT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as PaymentRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// ¿De qué pago está hablando esta fuente?
// ---------------------------------------------------------------------------

interface Candidate {
  payment: PaymentRow;
  /** Cuántas fuentes distintas hablan ya de él. */
  distinctSources: number;
  /** Cómo se llama la fuente que sostiene el importe actual, para la frase. */
  standingSourceLabel: string;
}

/**
 * El pago existente del que este reporte está hablando, o nada.
 *
 * LA IDENTIDAD DE UN MOVIMIENTO NO INCLUYE SU IMPORTE, y ese es el detalle del
 * que depende toda la regla 2. Si dos reportes sólo se consideraran "el mismo
 * pago" cuando sus importes coinciden, una discrepancia nunca produciría una
 * disputa: produciría dos pagos, y la cartera quedaría mal por la diferencia,
 * en silencio, que es exactamente el fallo que este esquema existe para evitar.
 *
 * Así que la identidad es: la misma moneda, la misma clase de movimiento, el
 * mismo cliente (o la misma factura, cuando no hay cliente), un día cercano, y
 * que NO SE CONTRADIGAN sobre qué factura pagan. Que una fuente nombre la
 * factura y la otra calle no es una contradicción — es lo normal: el extracto
 * del banco trae una referencia y el asiento del contable trae el número de
 * factura, y hablan del mismo abono.
 *
 * CUANDO LA DUDA ES REAL, SE ELIGE LA DISPUTA Y NO EL PAGO NUEVO. Dos abonos
 * distintos del mismo cliente, la misma semana, en la misma moneda, vistos por
 * dos fuentes distintas, se marcan como desacuerdo y una persona los separa.
 * La asimetría es deliberada: una disputa es un hueco VISIBLE que alguien mira
 * en un minuto, y un pago duplicado es una cartera equivocada que no mira
 * nadie, porque ya parece un número plausible.
 *
 * Y NUNCA SE EMPAREJA CON UN PAGO DEL QUE LA MISMA FUENTE YA HABLÓ. Siigo
 * diciendo dos cosas del mismo día son dos movimientos suyos, no una fuente
 * contradiciéndose; para eso está `source_ref`.
 */
async function findCandidatePayment(
  db: SupabaseClient,
  input: {
    movement: Movement;
    clientId: string | null;
    extractionId: string | null;
    invoiceNumber: string | null;
    sourceIdentityKey: string;
  },
): Promise<Candidate | null> {
  const { movement } = input;
  const from = shiftDays(movement.paidOn, -MATCH_DAY_WINDOW);
  const to = shiftDays(movement.paidOn, MATCH_DAY_WINDOW);
  if (!from || !to) return null;

  let q = db
    .from('payments')
    .select(PAYMENT_COLUMNS)
    .eq('currency', movement.currency)
    .eq('kind', movement.kind)
    .in('state', ['reported', 'confirmed', 'disputed'])
    .gte('paid_on', from)
    .lte('paid_on', to);

  // El cliente es la red más ancha de las dos y por eso va primero: una fuente
  // que nombra la factura y otra que sólo nombra al cliente tienen que poder
  // encontrarse. Sin cliente queda la factura; sin ninguno de los dos no hay
  // identidad que emparejar y el reporte crea su propio pago.
  if (input.clientId) q = q.eq('client_id', input.clientId);
  else if (input.extractionId) q = q.eq('extraction_id', input.extractionId);
  else return null;

  const { data, error } = await q.limit(50);
  if (error) throw error;
  const rows = (data ?? []) as PaymentRow[];
  if (rows.length === 0) return null;

  const reportsBy = await reportsFor(
    db,
    rows.map((r) => r.id),
  );

  const scored: Candidate[] = [];
  for (const payment of rows) {
    const reports = reportsBy.get(payment.id) ?? [];
    const identities = new Set(reports.map((r) => sourceIdentity(r)));
    if (identities.has(input.sourceIdentityKey)) continue;

    // La única forma de descartar un candidato por la factura es que las dos
    // partes nombren una Y NO SEA LA MISMA. El silencio de una de ellas no
    // contradice nada.
    const extractionConflict =
      input.extractionId != null &&
      payment.extraction_id != null &&
      payment.extraction_id !== input.extractionId;
    const invoiceConflict =
      input.invoiceNumber != null &&
      payment.invoice_number != null &&
      payment.invoice_number !== input.invoiceNumber;
    if (extractionConflict || invoiceConflict) continue;

    scored.push({
      payment,
      distinctSources: Math.max(identities.size, payment.source_count ?? 1),
      standingSourceLabel: standingLabel(reports),
    });
  }

  if (scored.length === 0) return null;
  // Uno que coincida exacto antes que uno que discrepe: enlazar es siempre
  // mejor noticia que abrir una disputa, y si hay dos candidatos y uno cuadra,
  // el que cuadra es del que está hablando.
  return scored.find((c) => movementsAgree(movementOf(c.payment), movement)) ?? scored[0] ?? null;
}

function standingLabel(reports: PaymentReportRow[]): string {
  const first = reports[0];
  if (!first) return 'lo ya registrado';
  return sourceLabel(first.source_kind, first.source_system);
}

function shiftDays(date: string, days: number): string | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

export async function reportsFor(
  db: SupabaseClient,
  paymentIds: string[],
): Promise<Map<string, PaymentReportRow[]>> {
  const out = new Map<string, PaymentReportRow[]>();
  if (paymentIds.length === 0) return out;
  const { data, error } = await db
    .from('payment_reports')
    .select(REPORT_COLUMNS)
    .in('payment_id', paymentIds)
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw error;
  for (const row of (data ?? []) as PaymentReportRow[]) {
    if (!row.payment_id) continue;
    const list = out.get(row.payment_id) ?? [];
    list.push(row);
    out.set(row.payment_id, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolver, que sólo hace una persona
// ---------------------------------------------------------------------------

export interface ResolveDisputeInput {
  paymentId: string;
  /** Quién decide. Sin esto no hay fila posible: `payments_resolved_needs_human`. */
  userId: string;
  decision: 'settle' | 'discard';
  /** El importe que la persona da por bueno. Sólo para 'settle'. */
  amount?: number | null;
  currency?: string | null;
  paidOn?: string | null;
  note?: string | null;
}

/**
 * Una persona mira las dos versiones y dice cuál vale.
 *
 * ES EL ÚNICO CAMINO FUERA DE `disputed`. No hay trabajo nocturno que lo haga,
 * no hay regla que lo haga al llegar una tercera fuente, y no hay jerarquía que
 * lo haga: `sourceRank` sólo ordenó la lista que esta persona está mirando y
 * marcó una casilla por defecto. Todo lo demás sería un número que nadie
 * volvería a auditar porque ya parece plausible.
 */
export async function resolvePaymentDispute(
  db: SupabaseClient,
  input: ResolveDisputeInput,
): Promise<PaymentRow> {
  if (!input.userId) {
    throw new ValidationError(
      'Resolver una disputa tiene que llevar el nombre de quien la resolvió.',
    );
  }
  const payment = await getPayment(db, input.paymentId);
  if (!payment) throw new NotFoundError('Ese pago ya no existe.');

  const now = new Date().toISOString();
  if (input.decision === 'discard') {
    return writePayment(db, {
      id: payment.id,
      values: {
        state: 'discarded',
        resolved_at: now,
        resolved_by: input.userId,
        resolution_note: input.note?.slice(0, 1000) ?? null,
      },
    });
  }

  const values: Record<string, unknown> = {
    state: 'confirmed',
    resolved_at: now,
    resolved_by: input.userId,
    resolution_note: input.note?.slice(0, 1000) ?? null,
    disputed_at: null,
    dispute_note: null,
  };
  // Sólo lo que la persona escribió a mano cambia el dinero. Un campo omitido
  // deja lo que había: resolver no es reescribir el pago entero.
  if (input.amount != null) {
    if (!Number.isFinite(input.amount) || input.amount < 0) {
      throw new ValidationError(
        'El importe con el que se resuelve tiene que ser un número no negativo.',
      );
    }
    values.amount = input.amount;
  }
  if (input.currency != null) values.currency = requireCurrency(input.currency);
  if (input.paidOn != null) {
    if (!ISO_DATE.test(input.paidOn)) {
      throw new ValidationError('La fecha con la que se resuelve va en formato AAAA-MM-DD.');
    }
    values.paid_on = input.paidOn;
  }
  return writePayment(db, { id: payment.id, values });
}

// ---------------------------------------------------------------------------
// Leerlo
// ---------------------------------------------------------------------------

export interface PaymentFilters {
  state?: PaymentState | PaymentState[];
  clientId?: string;
  extractionId?: string;
  currency?: string;
  paidFrom?: string;
  paidTo?: string;
  limit?: number;
}

export async function listPayments(
  db: SupabaseClient,
  filters: PaymentFilters = {},
): Promise<PaymentRow[]> {
  let q = db.from('payments').select(PAYMENT_COLUMNS);
  if (Array.isArray(filters.state)) q = q.in('state', filters.state);
  else if (filters.state) q = q.eq('state', filters.state);
  if (filters.clientId) q = q.eq('client_id', filters.clientId);
  if (filters.extractionId) q = q.eq('extraction_id', filters.extractionId);
  if (filters.currency) q = q.eq('currency', filters.currency);
  if (filters.paidFrom) q = q.gte('paid_on', filters.paidFrom);
  if (filters.paidTo) q = q.lte('paid_on', filters.paidTo);
  const { data, error } = await q
    .order('paid_on', { ascending: false })
    .limit(Math.min(filters.limit ?? 100, 1000));
  if (error) throw error;
  return (data ?? []) as PaymentRow[];
}

/** Los reportes que llegaron y todavía no son de ningún pago. */
export async function listWaitingReports(
  db: SupabaseClient,
  limit = 50,
): Promise<PaymentReportRow[]> {
  const { data, error } = await db
    .from('payment_reports')
    .select(REPORT_COLUMNS)
    .is('payment_id', null)
    .order('created_at', { ascending: true })
    .limit(Math.min(limit, 500));
  if (error) throw error;
  return (data ?? []) as PaymentReportRow[];
}

/**
 * Ponerle el nombre al cliente. Mismo razonamiento que
 * `documents/store.ts#hydrate`: un saldo sólo es citable si se puede decir en
 * voz alta, y "el pago 8f3c-…-a1" no lo es. Un cliente que no sea visible aquí
 * deja un hueco en vez de filtrar un nombre.
 */
export async function hydratePayments(
  db: SupabaseClient,
  rows: PaymentRow[],
): Promise<PaymentRow[]> {
  const ids = [...new Set(rows.map((r) => r.client_id).filter(Boolean))] as string[];
  if (ids.length === 0) return rows.map((r) => ({ ...r, client_name: null }));
  let names = new Map<string, string>();
  try {
    const { data, error } = await db.from('clients').select('id, name').in('id', ids);
    if (!error) {
      names = new Map(
        ((data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
      );
    }
  } catch {
    // Sin tabla de clientes, un pago sigue siendo un pago.
  }
  return rows.map((r) => ({
    ...r,
    client_name: r.client_id ? (names.get(r.client_id) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------
// La cartera
// ---------------------------------------------------------------------------

export interface ReceivablesCurrency {
  currency: string;
  /** Facturas confirmadas con saldo pendiente. */
  openInvoices: number;
  invoiced: number;
  paid: number;
  outstanding: number;
  /** Edad media ponderada por dinero, en días. Nula si nada tiene fecha. */
  ageDays: number | null;
  overdue: number;
  overdueInvoices: number;
}

export interface ReceivablesResult {
  today: string;
  byCurrency: ReceivablesCurrency[];
  /** Sobre cuántas facturas confirmadas está hecha la cifra. */
  confirmedInvoices: number;
  /** Facturas leídas que nadie ha revisado. NO están en la cifra. */
  pendingExcluded: number;
  /** Confirmadas pero sin moneda escrita: no se pueden restar contra nada. */
  withoutCurrency: number;
  /** Pagos en disputa, que no están en ninguna de estas cifras. */
  disputedPayments: number;
  disputedAmount: number;
  /** Pagos que no se pudieron atribuir a una factura, y por tanto no restan. */
  unappliedPayments: number;
  unappliedAmount: number;
  truncated: boolean;
  /** La frase honesta, lista para decirse tal cual. */
  sentence: string;
}

const SCAN_LIMIT = 1000;

/**
 * Cuánto se debe, sobre qué base, y qué se quedó fuera.
 *
 * SE CALCULA SOBRE FACTURAS CONFIRMADAS Y LO DICE EN LA CARA. Es la misma
 * disciplina que `aggregateRecords` y el mismo vocabulario, `pendingExcluded`:
 * «Cartera a 38 días sobre 62 facturas confirmadas; hay 41 sin revisar que no
 * entran en la cifra». Decir sólo la primera mitad enseñaría a leer un total
 * incompleto como si fuera completo — y decir las dos crea el incentivo
 * correcto, que es que alguien revise las 41.
 *
 * SE AGREGA EN JS SOBRE COMO MUCHO 1000 FILAS, y NUNCA se mezclan monedas: cada
 * moneda es su propia cifra, con su propia edad. Sumar 3.000 USD a 12.000.000
 * COP produce 12.003.000 de nada.
 *
 * Un pago en disputa no resta aquí. No es una cifra menor: no está en la cifra,
 * y el resultado dice cuántos son para que nadie confunda "no debe" con "no
 * sabemos".
 */
export async function receivables(
  db: SupabaseClient,
  opts: { clientId?: string; today?: string } = {},
): Promise<ReceivablesResult> {
  const today = opts.today ?? bogotaToday();

  let invoiceQuery = db
    .from('document_extractions')
    .select(INVOICE_COLUMNS)
    .eq('review_state', 'confirmed')
    .eq('doc_type', 'invoice');
  if (opts.clientId) invoiceQuery = invoiceQuery.eq('client_id', opts.clientId);
  const invoicesRead = await invoiceQuery.limit(SCAN_LIMIT);
  if (invoicesRead.error) throw invoicesRead.error;
  const invoices = (invoicesRead.data ?? []) as Array<{
    id: string;
    client_id: string | null;
    total_amount: number | string | null;
    currency: string | null;
    issued_on: string | null;
    due_on: string | null;
  }>;

  const payments = await listPayments(db, {
    state: [...COUNTED_STATES],
    clientId: opts.clientId,
    limit: SCAN_LIMIT,
  });
  const disputed = await listPayments(db, {
    state: 'disputed',
    clientId: opts.clientId,
    limit: SCAN_LIMIT,
  });

  // Lo abonado contra cada factura, por factura. Un pago sin factura no se
  // reparte entre las abiertas: adivinar a cuál iba es exactamente el tipo de
  // suposición que este módulo no hace.
  const appliedTo = new Map<string, number>();
  let unappliedPayments = 0;
  let unappliedAmount = 0;
  for (const p of payments) {
    const signed = signedAmount(p.kind, amountOf(p));
    if (p.extraction_id) {
      appliedTo.set(p.extraction_id, (appliedTo.get(p.extraction_id) ?? 0) + signed);
    } else {
      unappliedPayments += 1;
      unappliedAmount += signed;
    }
  }

  interface Bucket extends ReceivablesCurrency {
    ages: Array<{ balance: number; since: string | null }>;
  }
  const buckets = new Map<string, Bucket>();
  let withoutCurrency = 0;

  for (const invoice of invoices) {
    const total = num(invoice.total_amount);
    if (total == null) continue;
    if (!invoice.currency) {
      withoutCurrency += 1;
      continue;
    }
    const key = currencyBucket('cartera', invoice.currency);
    const bucket = buckets.get(key) ?? {
      currency: invoice.currency,
      openInvoices: 0,
      invoiced: 0,
      paid: 0,
      outstanding: 0,
      ageDays: null,
      overdue: 0,
      overdueInvoices: 0,
      ages: [],
    };
    const paid = appliedTo.get(invoice.id) ?? 0;
    const balance = total - paid;
    bucket.invoiced += total;
    bucket.paid += paid;
    if (balance > 0.005) {
      bucket.openInvoices += 1;
      bucket.outstanding += balance;
      bucket.ages.push({ balance, since: invoice.issued_on });
      const days = invoice.due_on ? daysBetween(invoice.due_on, today) : null;
      if (days != null && days > 0) {
        bucket.overdue += balance;
        bucket.overdueInvoices += 1;
      }
    }
    buckets.set(key, bucket);
  }

  const byCurrency: ReceivablesCurrency[] = [...buckets.values()]
    .map(({ ages, ...rest }) => ({ ...rest, ageDays: weightedAgeDays(ages, today) }))
    .sort((a, b) => b.outstanding - a.outstanding);

  const pendingRead = await db
    .from('document_extractions')
    .select('id', { count: 'exact', head: true })
    .eq('review_state', 'pending')
    .eq('doc_type', 'invoice');
  const pendingExcluded = pendingRead.error ? 0 : (pendingRead.count ?? 0);

  const disputedAmount = disputed.reduce((sum, p) => sum + signedAmount(p.kind, amountOf(p)), 0);

  return {
    today,
    byCurrency,
    confirmedInvoices: invoices.length,
    pendingExcluded,
    withoutCurrency,
    disputedPayments: disputed.length,
    disputedAmount,
    unappliedPayments,
    unappliedAmount,
    truncated: invoices.length >= SCAN_LIMIT || payments.length >= SCAN_LIMIT,
    sentence: describeReceivables({
      byCurrency,
      confirmedInvoices: invoices.length,
      pendingExcluded,
      withoutCurrency,
      disputedPayments: disputed.length,
      unappliedPayments,
    }),
  };
}

/**
 * La frase, y todo lo que la frase tiene que confesar.
 *
 * Cada advertencia de aquí es un hueco real en la cifra. Ninguna es una nota al
 * pie: la de "sin revisar" es lo que hace que el número sea honesto, y la de
 * "en disputa" es lo que impide que "no aparece" se lea como "no existe".
 */
export function describeReceivables(input: {
  byCurrency: ReceivablesCurrency[];
  confirmedInvoices: number;
  pendingExcluded: number;
  withoutCurrency: number;
  disputedPayments: number;
  unappliedPayments: number;
}): string {
  if (input.byCurrency.length === 0) {
    return input.pendingExcluded > 0
      ? `No hay cartera que calcular todavía: ninguna factura confirmada tiene saldo. Hay ${input.pendingExcluded} factura(s) leída(s) sin revisar, y ésas no entran en ninguna cifra hasta que alguien las confirme.`
      : 'No hay cartera que calcular: no hay ninguna factura confirmada con saldo pendiente.';
  }

  const parts = input.byCurrency.map((c) => {
    const age = c.ageDays == null ? 'sin edad calculable' : `a ${c.ageDays} días`;
    return `${formatAmount(c.outstanding)} ${c.currency} ${age} en ${c.openInvoices} factura(s)`;
  });

  const lines = [
    `Cartera ${parts.join('; ')}, sobre ${input.confirmedInvoices} factura(s) confirmada(s).`,
  ];
  const caveats: string[] = [];
  if (input.pendingExcluded > 0) {
    caveats.push(`hay ${input.pendingExcluded} factura(s) sin revisar que no entran en la cifra`);
  }
  if (input.disputedPayments > 0) {
    caveats.push(
      `${input.disputedPayments} pago(s) están en disputa entre dos fuentes y no restan de nada hasta que alguien decida`,
    );
  }
  if (input.unappliedPayments > 0) {
    caveats.push(
      `${input.unappliedPayments} pago(s) no se pudieron atribuir a una factura concreta, así que tampoco restan`,
    );
  }
  if (input.withoutCurrency > 0) {
    caveats.push(`${input.withoutCurrency} factura(s) confirmada(s) no dicen su moneda`);
  }
  if (caveats.length > 0) lines.push(`Ojo: ${caveats.join('; ')}.`);
  return lines.join(' ');
}

function formatAmount(value: number): string {
  return `$${value.toLocaleString('es-CO', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
