import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { nitDv, normalizeNit } from '../clients/shape';
import { findClientByNit } from '../clients/store';
// El puente hacia pagos (migración 0098). Va en este sentido a propósito:
// `payments/receipt.ts` no importa nada de este módulo — recibe datos planos —,
// así que no hay ciclo entre dos módulos que se escriben el uno al otro.
import { recordReceiptPayment } from '../payments/receipt';
import type { ExtractionReading } from './extract';
import { type Currency, documentType, fieldLabel, money, typeLabel } from './types';
import { type CanonicalValues, EMPTY_CANONICAL, canonicalFrom, nitDigits } from './verify';

/**
 * Every read and write of an extraction, in one module.
 *
 * The tools, the ingestion job and the review screen all go through here, which
 * is what keeps the three rules that matter from having four implementations:
 *
 *   a field cannot be stored without the sentence it came from,
 *   a field cannot be confirmed without a person's name on it,
 *   and nothing unconfirmed reaches a total.
 *
 * The third is the one that has to be enforced by construction rather than by
 * discipline, because it is the one a caller can break by simply forgetting a
 * filter. So the canonical columns — the only thing the query side reads — are
 * written exclusively by `recomputeCanonical` from confirmed fields, and are
 * empty on every pending row. A query that forgot `review_state = 'confirmed'`
 * would still add up nothing but confirmed money.
 *
 * `db` is always a workspace-scoped handle (0064). Nothing here filters by
 * organization_id by hand, and nothing here should ever be handed a raw client.
 */

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const EXTRACTION_COLUMNS =
  'id, document_id, doc_type, classification_quote, classification_chunk_id, unclassified_reason, client_id, client_nit, client_match_state, review_state, confirmed_at, confirmed_by, rejected_at, rejected_by, doc_number, counterparty_nit, counterparty_name, total_amount, tax_amount, currency, issued_on, due_on, extractor_version, model_id, created_by, error_message, created_at, updated_at';

export const FIELD_COLUMNS =
  'id, extraction_id, field_key, value_text, value_number, value_date, currency, quote, chunk_id, review_state, confirmed_at, confirmed_by, rejected_at, rejected_by, corrected_text, corrected_number, corrected_date, corrected_currency, created_at, updated_at';

export type ReviewState = 'unclassified' | 'pending' | 'confirmed' | 'rejected';
export type ClientMatchState = 'matched' | 'unmatched' | 'ambiguous' | 'no_nit';

export interface ExtractionRow {
  id: string;
  document_id: string;
  doc_type: string | null;
  classification_quote: string | null;
  classification_chunk_id: string | null;
  unclassified_reason: string | null;
  client_id: string | null;
  client_nit: string | null;
  client_match_state: ClientMatchState;
  review_state: ReviewState;
  confirmed_at: string | null;
  confirmed_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  doc_number: string | null;
  counterparty_nit: string | null;
  counterparty_name: string | null;
  total_amount: number | string | null;
  tax_amount: number | string | null;
  currency: string | null;
  issued_on: string | null;
  due_on: string | null;
  extractor_version: string;
  model_id: string | null;
  created_by: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  /** Joined in by callers that need to name the document. Never stored. */
  document_title?: string | null;
  client_name?: string | null;
}

export interface FieldRow {
  id: string;
  extraction_id: string;
  field_key: string;
  value_text: string | null;
  value_number: number | string | null;
  value_date: string | null;
  currency: string | null;
  quote: string;
  chunk_id: string | null;
  review_state: 'pending' | 'confirmed' | 'rejected';
  confirmed_at: string | null;
  confirmed_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  corrected_text: string | null;
  corrected_number: number | string | null;
  corrected_date: string | null;
  corrected_currency: string | null;
  created_at: string;
  updated_at: string;
}

/** PostgREST hands `numeric` back as a number or a string depending on driver. */
export function num(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The value that stands today: the correction if a person made one, else the reading. */
export function standingValue(row: FieldRow): {
  text: string | null;
  number: number | null;
  date: string | null;
  currency: string | null;
  corrected: boolean;
} {
  const corrected =
    row.corrected_text != null ||
    row.corrected_number != null ||
    row.corrected_date != null ||
    row.corrected_currency != null;
  return {
    text: row.corrected_text ?? row.value_text,
    number: num(row.corrected_number) ?? num(row.value_number),
    date: row.corrected_date ?? row.value_date,
    currency: row.corrected_currency ?? row.currency,
    corrected,
  };
}

/** How a field reads on a screen or in a sentence, whatever its type. */
export function displayValue(row: FieldRow): string {
  const value = standingValue(row);
  if (value.number != null) return money(value.number, value.currency);
  if (value.date) return value.date;
  return value.text ?? '—';
}

// ---------------------------------------------------------------------------
// Writing what was read
// ---------------------------------------------------------------------------

export interface SaveReadingInput {
  documentId: string;
  reading: ExtractionReading;
  /** Null when the ingestion pipeline produced it, which is the normal case. */
  createdBy?: string | null;
}

/**
 * Store one reading of one document, replacing whatever was there before.
 *
 * REPLACING, NOT APPENDING. Two readings of the same invoice are two totals,
 * and any aggregation that counted both would double it. The unique index on
 * (organization_id, document_id) makes that impossible in the database; this
 * function makes re-running the extractor a normal, safe operation rather than
 * something to be careful about.
 *
 * Everything written here is `pending`. There is no argument to this function
 * that would make it otherwise.
 */
export async function saveReading(
  db: SupabaseClient,
  input: SaveReadingInput,
): Promise<ExtractionRow> {
  const { documentId, reading } = input;
  const classified = reading.docType != null;

  // The NIT is recorded; THE LINK IS NOT MADE. A client_id written here would
  // be a link nobody earned — migration 0075's first rule — and it would be
  // visible on the client card before anybody had checked the digits it rests
  // on. The link is made in `settleExtraction`, out of a NIT a person confirmed.
  const nit = classified ? readNit(reading) : null;
  const match = await describeNitMatch(db, nit);

  const header: Record<string, unknown> = {
    document_id: documentId,
    doc_type: reading.docType,
    classification_quote: reading.classificationQuote,
    classification_chunk_id: reading.classificationChunkId,
    unclassified_reason: reading.unclassifiedReason,
    client_id: null,
    client_nit: nit,
    client_match_state: match,
    // A document nobody could classify is not "pending review of its fields" —
    // there are no fields. It is its own state, and the screen asks a different
    // question about it: not "is this right" but "what is this".
    review_state: classified ? 'pending' : 'unclassified',
    // A re-run wipes the previous verdict: these are readings of a new pass.
    confirmed_at: null,
    confirmed_by: null,
    rejected_at: null,
    rejected_by: null,
    ...EMPTY_CANONICAL,
    extractor_version: reading.extractorVersion,
    model_id: reading.modelId,
    created_by: input.createdBy ?? null,
    error_message: null,
    updated_at: new Date().toISOString(),
  };

  const existing = await findByDocument(db, documentId);
  let row: ExtractionRow;
  if (existing) {
    const { data, error } = await db
      .from('document_extractions')
      .update(header)
      .eq('id', existing.id)
      .select(EXTRACTION_COLUMNS)
      .single();
    if (error) throw error;
    row = data as ExtractionRow;
    await db.from('document_fields').delete().eq('extraction_id', existing.id);
  } else {
    const { data, error } = await db
      .from('document_extractions')
      .insert(header)
      .select(EXTRACTION_COLUMNS)
      .single();
    if (error) throw error;
    row = data as ExtractionRow;
  }

  if (reading.fields.length > 0) {
    const { error } = await db.from('document_fields').insert(
      reading.fields.map((f) => ({
        extraction_id: row.id,
        field_key: f.fieldKey,
        value_text: f.valueText,
        value_number: f.valueNumber,
        value_date: f.valueDate,
        currency: f.currency,
        quote: f.quote,
        chunk_id: f.chunkId,
        review_state: 'pending',
      })),
    );
    if (error) throw error;
  }

  return row;
}

export async function findByDocument(
  db: SupabaseClient,
  documentId: string,
): Promise<ExtractionRow | null> {
  const { data, error } = await db
    .from('document_extractions')
    .select(EXTRACTION_COLUMNS)
    .eq('document_id', documentId)
    .maybeSingle();
  if (error) throw error;
  return (data as ExtractionRow | null) ?? null;
}

export async function getExtraction(db: SupabaseClient, id: string): Promise<ExtractionRow | null> {
  const { data, error } = await db
    .from('document_extractions')
    .select(EXTRACTION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ExtractionRow | null) ?? null;
}

export async function listFields(
  db: SupabaseClient,
  extractionIds: string[],
): Promise<Map<string, FieldRow[]>> {
  const byExtraction = new Map<string, FieldRow[]>();
  if (extractionIds.length === 0) return byExtraction;
  const { data, error } = await db
    .from('document_fields')
    .select(FIELD_COLUMNS)
    .in('extraction_id', extractionIds)
    .limit(5000);
  if (error) throw error;
  for (const row of (data ?? []) as FieldRow[]) {
    const list = byExtraction.get(row.extraction_id) ?? [];
    list.push(row);
    byExtraction.set(row.extraction_id, list);
  }
  return byExtraction;
}

// ---------------------------------------------------------------------------
// Which client this belongs to
// ---------------------------------------------------------------------------

/**
 * Whether this NIT WOULD match a client, without linking anything.
 *
 * Stored on the pending row so the review screen can say "el NIT 900123456 es
 * de Coltrans, confírmalo y queda vinculado" — a suggestion the reviewer can
 * act on, rather than a link they never made.
 */
async function describeNitMatch(
  db: SupabaseClient,
  nit: string | null,
): Promise<ClientMatchState> {
  if (!nit) return 'no_nit';
  return (await resolveClientByNit(db, nit)).state;
}

/**
 * The NIT this document names, if it names one legibly.
 *
 * Only ever the field the type's spec marks as `counterparty_nit`. A number
 * that looks like a NIT somewhere else on the page is not the counterparty's
 * NIT — an invoice carries the issuer's, the buyer's, and often the carrier's.
 */
export function readNit(reading: Pick<ExtractionReading, 'docType' | 'fields'>): string | null {
  const spec = documentType(reading.docType);
  if (!spec) return null;
  const field = reading.fields.find(
    (f) => spec.fields.find((s) => s.key === f.fieldKey)?.canonical === 'counterparty_nit',
  );
  const digits = field?.valueText ? nitDigits(field.valueText) : '';
  return digits.length >= 5 ? digits : null;
}

/**
 * Which client a NIT belongs to — BY NIT AND BY NOTHING ELSE.
 *
 * The NIT is the one identifier a Colombian company cannot share with another,
 * and it is printed on every document in this list. A name is not: "Coltrans
 * S.A.S.", "COLTRANS", "Coltrans Express Ltda." and "Coltrans Zona Franca" are
 * four strings, some of which are one company and some of which are not, and no
 * amount of fuzzy matching tells you which — it tells you a confidence, and a
 * confidence is how half a month's invoices end up filed under the wrong client
 * in a table people report from. Migration 0075's header makes the same
 * argument for the same reason; this module simply refuses to be the exception.
 *
 * `clients.tax_id` holds the digits WITHOUT the verification digit (0075). A
 * document usually prints it WITH. So a NIT that does not match on the nose is
 * retried without its last digit, and only when that last digit is the one the
 * rest of the number implies — `nitDv` says so. That is a checksum agreeing,
 * not a guess: "9001234567" becomes "900123456" only because 7 is exactly what
 * 900123456 computes to. A trailing digit that fails the check is left alone,
 * because then it is part of the number and dropping it would invent a
 * different company.
 *
 * Tolerates a `clients` table that is not there. An extraction that cannot
 * reach it is an extraction with no client link, which is the same outcome as
 * an extraction whose NIT matched nothing — and neither is worth failing an
 * ingestion over.
 */
export async function resolveClientByNit(
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
      // Table absent, or two rows carrying the same tax id — neither is
      // something to resolve by picking a row.
      return { clientId: null, state: 'unmatched' };
    }
  }
  return { clientId: null, state: 'unmatched' };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface FieldDecision {
  fieldKey: string;
  action: 'confirm' | 'reject';
  /** Present only when the reviewer changed the value while confirming it. */
  text?: string | null;
  number?: number | null;
  date?: string | null;
  currency?: string | null;
}

export interface ConfirmResult {
  extraction: ExtractionRow;
  confirmed: number;
  corrected: number;
  rejected: number;
  /**
   * Qué pasó con el pago, cuando el documento era un comprobante. Null para
   * todo lo demás. Ver `payments/receipt.ts`.
   */
  paymentNote: string | null;
}

/**
 * A person vouches for what was read, correcting it where it was wrong.
 *
 * THIS IS THE ONLY DOOR. Nothing else in this codebase sets `review_state =
 * 'confirmed'`, and migration 0076 will not store a confirmed field without the
 * name of whoever confirmed it, so there is no path from a model's output to a
 * reported figure that does not pass through a human here.
 *
 * `decisions` is a list because the unit of review is a DOCUMENT, not a field:
 * a reviewer looking at a factura confirms eight fields in one gesture, and the
 * screen sends them as one call. Twenty invoices is twenty calls, not a hundred
 * and sixty.
 *
 * A correction is recorded twice on purpose — as `corrected_*` beside the
 * untouched proposal, so the screen can show both forever, and as a row in
 * `document_field_corrections`, so "which field do we always have to fix" is a
 * group-by rather than a scan.
 */
export async function confirmExtraction(
  db: SupabaseClient,
  input: { extractionId: string; userId: string; decisions: FieldDecision[] },
): Promise<ConfirmResult> {
  if (!input.userId) throw new ValidationError('A confirmation has to name the person making it.');
  const extraction = await getExtraction(db, input.extractionId);
  if (!extraction) throw new NotFoundError('That extraction no longer exists.');
  if (extraction.review_state === 'unclassified') {
    throw new ValidationError(
      'That document has no recognised type yet, so there is nothing to confirm. Say what it is first.',
    );
  }

  const fields = (await listFields(db, [extraction.id])).get(extraction.id) ?? [];
  const byKey = new Map(fields.map((f) => [f.field_key, f]));
  const now = new Date().toISOString();

  let confirmed = 0;
  let corrected = 0;
  let rejected = 0;
  const corrections: Array<Record<string, unknown>> = [];

  for (const decision of input.decisions) {
    const field = byKey.get(decision.fieldKey);
    if (!field) continue;

    if (decision.action === 'reject') {
      await db
        .from('document_fields')
        .update({
          review_state: 'rejected',
          rejected_at: now,
          rejected_by: input.userId,
          updated_at: now,
        })
        .eq('id', field.id);
      corrections.push(correctionRow(extraction, field, null, input.userId, 'rejected'));
      rejected += 1;
      field.review_state = 'rejected';
      continue;
    }

    const patch: Record<string, unknown> = {
      review_state: 'confirmed',
      confirmed_at: now,
      confirmed_by: input.userId,
      updated_at: now,
    };

    const change = diff(field, decision);
    if (change) {
      Object.assign(patch, change.columns);
      corrections.push(
        correctionRow(extraction, field, change.display, input.userId, 'corrected'),
      );
      corrected += 1;
      Object.assign(field, change.columns);
    }

    await db.from('document_fields').update(patch).eq('id', field.id);
    field.review_state = 'confirmed';
    confirmed += 1;
  }

  if (corrections.length > 0) {
    await db.from('document_field_corrections').insert(corrections);
  }

  const updated = await settleExtraction(db, extraction, fields, input.userId, now);

  // UN COMPROBANTE DE PAGO CONFIRMADO ES UN PAGO REPORTADO (migración 0098).
  //
  // Va aquí, dentro de la única puerta que existe hacia `confirmed`, y no en el
  // tool ni en la acción de la pantalla, precisamente por la lección de la
  // 0064: una tabla escrita desde dos sitios acaba teniendo uno que se olvidó,
  // y nadie se entera porque la lectura sigue funcionando. `recordReceiptPayment`
  // no lanza nunca — devuelve la frase — así que esta línea no puede deshacer
  // una revisión que una persona ya hizo.
  const payment = await recordReceiptPayment(db, {
    extraction: {
      id: updated.id,
      documentId: updated.document_id,
      docType: updated.doc_type,
      reviewState: updated.review_state,
      clientId: updated.client_id,
      clientNit: updated.client_nit,
      clientMatchState: updated.client_match_state,
      totalAmount: num(updated.total_amount),
      currency: updated.currency,
      issuedOn: updated.issued_on,
    },
    fields: fields.map((f) => {
      const value = standingValue(f);
      return {
        fieldKey: f.field_key,
        reviewState: f.review_state,
        text: value.text,
        number: value.number,
        date: value.date,
        currency: value.currency,
        quote: f.quote,
        chunkId: f.chunk_id,
      };
    }),
    userId: input.userId,
  });

  return { extraction: updated, confirmed, corrected, rejected, paymentNote: payment.reason };
}

/**
 * What the reviewer changed, as columns and as a sentence.
 *
 * Returns null when nothing changed, so a straight confirmation writes no
 * correction row. That distinction is the entire value of the corrections
 * table: if every confirmation logged a "correction", the statistics would say
 * every field is always wrong.
 */
function diff(
  field: FieldRow,
  decision: FieldDecision,
): { columns: Record<string, unknown>; display: string } | null {
  const current = standingValue(field);
  const columns: Record<string, unknown> = {};
  let changed = false;

  if (decision.text !== undefined && (decision.text ?? null) !== current.text) {
    columns.corrected_text = decision.text ?? null;
    changed = true;
  }
  if (decision.number !== undefined && (decision.number ?? null) !== current.number) {
    columns.corrected_number = decision.number ?? null;
    changed = true;
  }
  if (decision.date !== undefined && (decision.date ?? null) !== current.date) {
    columns.corrected_date = decision.date ?? null;
    changed = true;
  }
  if (decision.currency !== undefined && (decision.currency ?? null) !== current.currency) {
    columns.corrected_currency = decision.currency ?? null;
    changed = true;
  }
  if (!changed) return null;

  const after = {
    ...field,
    ...columns,
  } as FieldRow;
  return { columns, display: displayValue(after) };
}

function correctionRow(
  extraction: ExtractionRow,
  field: FieldRow,
  correctedDisplay: string | null,
  userId: string,
  outcome: 'corrected' | 'rejected',
): Record<string, unknown> {
  return {
    field_id: field.id,
    extraction_id: extraction.id,
    doc_type: extraction.doc_type,
    field_key: field.field_key,
    proposed_display: displayProposal(field).slice(0, 400),
    corrected_display: correctedDisplay?.slice(0, 400) ?? null,
    outcome,
    corrected_by: userId,
  };
}

/** What the model originally said, ignoring any correction on top of it. */
function displayProposal(field: FieldRow): string {
  const n = num(field.value_number);
  if (n != null) return money(n, field.currency);
  if (field.value_date) return field.value_date;
  return field.value_text ?? '—';
}

/**
 * Roll the document's own state up from its fields, and recompute the columns
 * the query side reads.
 *
 * A document is confirmed once nothing is left pending and at least one field
 * survived. If every field was thrown out, the reading was wrong rather than
 * unreviewed, and the row says so — that is a different fact and the review
 * queue should not show it again.
 */
async function settleExtraction(
  db: SupabaseClient,
  extraction: ExtractionRow,
  fields: FieldRow[],
  userId: string,
  now: string,
): Promise<ExtractionRow> {
  const pending = fields.filter((f) => f.review_state === 'pending').length;
  const confirmed = fields.filter((f) => f.review_state === 'confirmed').length;

  const canonical = canonicalFrom(
    extraction.doc_type,
    fields.map((f) => {
      const value = standingValue(f);
      return {
        fieldKey: f.field_key,
        reviewState: f.review_state,
        text: value.text,
        number: value.number,
        date: value.date,
        currency: value.currency,
      };
    }),
  );

  const patch: Record<string, unknown> = { ...canonical, updated_at: now };

  if (pending === 0) {
    if (confirmed > 0) {
      patch.review_state = 'confirmed';
      patch.confirmed_at = now;
      patch.confirmed_by = userId;
    } else {
      patch.review_state = 'rejected';
      patch.rejected_at = now;
      patch.rejected_by = userId;
    }
  }

  // The client link is re-derived from the NIT AS IT NOW STANDS: a reviewer who
  // fixed a misread digit has, in that one gesture, also filed the document
  // under the right client.
  if (canonical.counterparty_nit) {
    const resolved = await resolveClientByNit(db, canonical.counterparty_nit);
    patch.client_id = resolved.clientId;
    patch.client_match_state = resolved.state;
    patch.client_nit = canonical.counterparty_nit;
  }

  const { data, error } = await db
    .from('document_extractions')
    .update(patch)
    .eq('id', extraction.id)
    .select(EXTRACTION_COLUMNS)
    .single();
  if (error) throw error;
  return data as ExtractionRow;
}

/** Throw the whole reading out: wrong type, unreadable scan, duplicate. */
export async function rejectExtraction(
  db: SupabaseClient,
  input: { extractionId: string; userId: string; reason?: string | null },
): Promise<ExtractionRow> {
  const now = new Date().toISOString();
  await db
    .from('document_fields')
    .update({ review_state: 'rejected', rejected_at: now, rejected_by: input.userId })
    .eq('extraction_id', input.extractionId);

  const { data, error } = await db
    .from('document_extractions')
    .update({
      review_state: 'rejected',
      rejected_at: now,
      rejected_by: input.userId,
      error_message: input.reason?.slice(0, 500) ?? null,
      // Anything already denormalised comes back out. A rejected reading must
      // not leave a total behind it.
      ...EMPTY_CANONICAL,
      updated_at: now,
    })
    .eq('id', input.extractionId)
    .select(EXTRACTION_COLUMNS)
    .single();
  if (error) throw error;
  return data as ExtractionRow;
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

export interface ListExtractionsOptions {
  reviewState?: ReviewState | ReviewState[];
  docType?: string;
  limit?: number;
}

export async function listExtractions(
  db: SupabaseClient,
  opts: ListExtractionsOptions = {},
): Promise<ExtractionRow[]> {
  let q = db.from('document_extractions').select(EXTRACTION_COLUMNS);
  if (Array.isArray(opts.reviewState)) q = q.in('review_state', opts.reviewState);
  else if (opts.reviewState) q = q.eq('review_state', opts.reviewState);
  if (opts.docType) q = q.eq('doc_type', opts.docType);
  const { data, error } = await q
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 200);
  if (error) throw error;
  return (data ?? []) as ExtractionRow[];
}

/**
 * Put the names back on: the document's title, and the client's.
 *
 * Same reasoning as `commitments/store.ts#hydrate` — a source is only citable
 * if it can be said out loud, and "extracción 8f3c-…-a1 del documento
 * 2b7e-…-99" cannot. Two small `.in()` lookups rather than PostgREST embeds,
 * because the embed would route the join through tables whose tenancy the
 * scoped client pins differently, and because a client row that is not visible
 * here should leave a blank rather than leak a name.
 */
export async function hydrate(
  db: SupabaseClient,
  rows: ExtractionRow[],
): Promise<ExtractionRow[]> {
  if (rows.length === 0) return rows;
  const docIds = [...new Set(rows.map((r) => r.document_id))];
  const clientIds = [...new Set(rows.map((r) => r.client_id).filter(Boolean))] as string[];

  const [docs, clients] = await Promise.all([
    docIds.length
      ? db.from('kb_documents').select('id, title').in('id', docIds)
      : Promise.resolve({ data: [] }),
    clientIds.length ? safeClients(db, clientIds) : Promise.resolve({ data: [] }),
  ]);

  const titles = new Map(
    ((docs.data ?? []) as Array<{ id: string; title: string }>).map((d) => [d.id, d.title]),
  );
  const names = new Map(
    ((clients.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );

  return rows.map((r) => ({
    ...r,
    document_title: titles.get(r.document_id) ?? null,
    client_name: r.client_id ? (names.get(r.client_id) ?? null) : null,
  }));
}

async function safeClients(
  db: SupabaseClient,
  ids: string[],
): Promise<{ data: Array<{ id: string; name: string }> }> {
  try {
    const { data, error } = await db.from('clients').select('id, name').in('id', ids);
    if (error) return { data: [] };
    return { data: (data ?? []) as Array<{ id: string; name: string }> };
  } catch {
    return { data: [] };
  }
}

// ---------------------------------------------------------------------------
// The point of the whole module: reading it as data
// ---------------------------------------------------------------------------

export interface RecordFilters {
  docType?: string;
  clientId?: string;
  /** Any format; compared digit by digit. */
  nit?: string;
  /** Substring of the counterparty name, case-insensitive, matched in memory. */
  counterparty?: string;
  issuedFrom?: string;
  issuedTo?: string;
  dueFrom?: string;
  dueTo?: string;
  /** Only what has a due date already past `today`. */
  overdueOnly?: boolean;
  minAmount?: number;
  limit?: number;
  today?: string;
}

export interface ExtractionRecord {
  id: string;
  documentId: string;
  documentTitle: string | null;
  docType: string | null;
  docTypeLabel: string;
  docNumber: string | null;
  clientId: string | null;
  clientName: string | null;
  counterpartyName: string | null;
  counterpartyNit: string | null;
  totalAmount: number | null;
  taxAmount: number | null;
  currency: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  daysToDue: number | null;
  overdue: boolean;
  confirmedAt: string | null;
}

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

export function adaptRecord(row: ExtractionRow, today: string): ExtractionRecord {
  const dueOn = row.due_on;
  const daysToDue = dueOn ? daysBetween(today, dueOn) : null;
  return {
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title ?? null,
    docType: row.doc_type,
    docTypeLabel: typeLabel(row.doc_type),
    docNumber: row.doc_number,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    counterpartyName: row.counterparty_name,
    counterpartyNit: row.counterparty_nit,
    totalAmount: num(row.total_amount),
    taxAmount: num(row.tax_amount),
    currency: row.currency,
    issuedOn: row.issued_on,
    dueOn,
    daysToDue,
    overdue: daysToDue != null && daysToDue < 0,
    confirmedAt: row.confirmed_at,
  };
}

/**
 * The confirmed documents matching a filter — the query surface that did not
 * exist before this module.
 *
 * `review_state = 'confirmed'` is applied here and is not a parameter. There is
 * no caller that wants "the totals including the ones nobody has checked", and
 * offering it as an option is how it eventually gets passed by something that
 * only wanted "more rows".
 */
export async function queryRecords(
  db: SupabaseClient,
  filters: RecordFilters = {},
): Promise<ExtractionRecord[]> {
  const today = filters.today ?? bogotaToday();
  let q = db
    .from('document_extractions')
    .select(EXTRACTION_COLUMNS)
    .eq('review_state', 'confirmed');

  if (filters.docType) q = q.eq('doc_type', filters.docType);
  if (filters.clientId) q = q.eq('client_id', filters.clientId);
  if (filters.nit) q = q.eq('counterparty_nit', nitDigits(filters.nit));
  if (filters.issuedFrom) q = q.gte('issued_on', filters.issuedFrom);
  if (filters.issuedTo) q = q.lte('issued_on', filters.issuedTo);
  if (filters.dueFrom) q = q.gte('due_on', filters.dueFrom);
  if (filters.dueTo) q = q.lte('due_on', filters.dueTo);
  if (filters.overdueOnly) q = q.lt('due_on', today);

  const { data, error } = await q
    .order('issued_on', { ascending: false })
    .limit(Math.min(filters.limit ?? 200, 1000));
  if (error) throw error;

  let rows = await hydrate(db, (data ?? []) as ExtractionRow[]);
  if (filters.counterparty) {
    const needle = filters.counterparty.toLowerCase();
    rows = rows.filter(
      (r) =>
        (r.counterparty_name ?? '').toLowerCase().includes(needle) ||
        (r.client_name ?? '').toLowerCase().includes(needle),
    );
  }
  if (filters.minAmount != null) {
    const floor = filters.minAmount;
    rows = rows.filter((r) => (num(r.total_amount) ?? 0) >= floor);
  }
  return rows.map((r) => adaptRecord(r, today));
}

export type GroupBy = 'client' | 'doc_type' | 'month' | 'currency';
export type Metric = 'total_amount' | 'tax_amount' | 'count';

export interface AggregateGroup {
  key: string;
  label: string;
  currency: string | null;
  count: number;
  total: number;
  documents: string[];
}

export interface AggregateResult {
  today: string;
  groups: AggregateGroup[];
  /** Documents that matched the filter but are still waiting for a person. */
  pendingExcluded: number;
  /** Confirmed documents that matched but carry no amount at all. */
  withoutAmount: number;
}

/**
 * Sum, count and group — with an explicit account of what was left out.
 *
 * `pendingExcluded` is not a footnote, it is part of the answer. "Le facturamos
 * $84.500.000 a Coltrans en julio" is a different statement from the same
 * figure followed by "y hay 6 facturas más sin revisar", and a tool that
 * reported only the first would be quietly training people to treat an
 * incomplete total as a complete one. The tools relay it in the sentence.
 *
 * GROUPS ARE SPLIT BY CURRENCY, always. Adding 3 000 USD to 12 000 000 COP
 * produces 12 003 000 of nothing. A group with a null currency is reported as
 * "sin moneda" and stays its own bucket.
 */
export async function aggregateRecords(
  db: SupabaseClient,
  input: { filters?: RecordFilters; groupBy: GroupBy; metric?: Metric },
): Promise<AggregateResult> {
  const filters = input.filters ?? {};
  const today = filters.today ?? bogotaToday();
  const metric = input.metric ?? 'total_amount';
  const records = await queryRecords(db, { ...filters, today, limit: 1000 });

  const groups = new Map<string, AggregateGroup>();
  let withoutAmount = 0;

  for (const r of records) {
    const amount = metric === 'tax_amount' ? r.taxAmount : r.totalAmount;
    if (metric !== 'count' && amount == null) withoutAmount += 1;

    const { key, label } = groupKey(r, input.groupBy);
    const currency = metric === 'count' ? null : r.currency;
    const bucket = `${key}#${currency ?? 'none'}`;
    const group = groups.get(bucket) ?? {
      key,
      label,
      currency,
      count: 0,
      total: 0,
      documents: [],
    };
    group.count += 1;
    group.total += metric === 'count' ? 1 : (amount ?? 0);
    if (group.documents.length < 25) group.documents.push(r.documentTitle ?? r.docNumber ?? r.id);
    groups.set(bucket, group);
  }

  const pendingExcluded = await countPending(db, filters);

  return {
    today,
    groups: [...groups.values()].sort((a, b) => b.total - a.total),
    pendingExcluded,
    withoutAmount,
  };
}

function groupKey(record: ExtractionRecord, groupBy: GroupBy): { key: string; label: string } {
  switch (groupBy) {
    case 'client': {
      const label = record.clientName ?? record.counterpartyName ?? 'Sin cliente identificado';
      return { key: record.clientId ?? record.counterpartyNit ?? 'unknown', label };
    }
    case 'doc_type':
      return { key: record.docType ?? 'unknown', label: record.docTypeLabel };
    case 'month': {
      const month = record.issuedOn?.slice(0, 7) ?? 'sin-fecha';
      return { key: month, label: month };
    }
    default:
      return { key: record.currency ?? 'none', label: record.currency ?? 'Sin moneda' };
  }
}

/**
 * How many documents the same filter would have matched if unreviewed readings
 * counted. Only the date and type filters apply — a pending row has no
 * canonical columns to filter on, which is the whole design.
 */
async function countPending(db: SupabaseClient, filters: RecordFilters): Promise<number> {
  let q = db
    .from('document_extractions')
    .select('id', { count: 'exact', head: true })
    .eq('review_state', 'pending');
  if (filters.docType) q = q.eq('doc_type', filters.docType);
  const { count, error } = await q;
  if (error) return 0;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Where the extractor is wrong
// ---------------------------------------------------------------------------

export interface CorrectionStat {
  docType: string | null;
  docTypeLabel: string;
  fieldKey: string;
  fieldLabel: string;
  corrected: number;
  rejected: number;
  confirmed: number;
  /** Corrections and rejections over everything a person ever resolved. */
  errorRate: number;
  examples: Array<{ proposed: string | null; corrected: string | null }>;
}

/**
 * Which fields people always have to fix.
 *
 * Nothing here retrains anything, and it is not meant to. It answers the one
 * question that tells you where to spend an afternoon: a field corrected in
 * four readings out of five is a bug in a prompt or a spec, and it is invisible
 * from anywhere else in the product, because the corrected value looks right
 * the moment it is saved.
 */
export async function correctionStats(
  db: SupabaseClient,
  opts: { docType?: string; limit?: number } = {},
): Promise<CorrectionStat[]> {
  const [corrections, resolved] = await Promise.all([
    db
      .from('document_field_corrections')
      .select('doc_type, field_key, outcome, proposed_display, corrected_display')
      .limit(5000),
    db.from('document_fields').select('field_key, review_state, extraction_id').limit(5000),
  ]);

  if (corrections.error) throw corrections.error;

  const stats = new Map<string, CorrectionStat>();
  const keyOf = (docType: string | null, fieldKey: string) => `${docType ?? '—'}#${fieldKey}`;

  for (const raw of (corrections.data ?? []) as Array<{
    doc_type: string | null;
    field_key: string;
    outcome: string;
    proposed_display: string | null;
    corrected_display: string | null;
  }>) {
    if (opts.docType && raw.doc_type !== opts.docType) continue;
    const key = keyOf(raw.doc_type, raw.field_key);
    const stat = stats.get(key) ?? {
      docType: raw.doc_type,
      docTypeLabel: typeLabel(raw.doc_type),
      fieldKey: raw.field_key,
      fieldLabel: fieldLabel(raw.doc_type, raw.field_key),
      corrected: 0,
      rejected: 0,
      confirmed: 0,
      errorRate: 0,
      examples: [],
    };
    if (raw.outcome === 'rejected') stat.rejected += 1;
    else stat.corrected += 1;
    if (stat.examples.length < 3) {
      stat.examples.push({ proposed: raw.proposed_display, corrected: raw.corrected_display });
    }
    stats.set(key, stat);
  }

  // Confirmed-as-read counts are what turn "corrected 12 times" into a rate.
  // Without them a field that is read 500 times and fixed 12 looks identical to
  // one that is read 12 times and fixed 12.
  const confirmedByKey = new Map<string, number>();
  for (const row of (resolved.data ?? []) as Array<{ field_key: string; review_state: string }>) {
    if (row.review_state !== 'confirmed') continue;
    confirmedByKey.set(row.field_key, (confirmedByKey.get(row.field_key) ?? 0) + 1);
  }

  const out = [...stats.values()].map((stat) => {
    const confirmed = confirmedByKey.get(stat.fieldKey) ?? 0;
    const resolvedTotal = confirmed + stat.rejected;
    return {
      ...stat,
      confirmed,
      errorRate: resolvedTotal === 0 ? 1 : (stat.corrected + stat.rejected) / resolvedTotal,
    };
  });

  out.sort((a, b) => b.corrected + b.rejected - (a.corrected + a.rejected));
  return out.slice(0, opts.limit ?? 25);
}

// ---------------------------------------------------------------------------

export type { Currency, CanonicalValues };
