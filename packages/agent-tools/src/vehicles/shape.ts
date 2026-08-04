import { z } from 'zod';
import type { VehiclesFailure } from './client';

/**
 * Shared shaping for the vehicles tools.
 *
 * Three jobs:
 *
 * 1. NORMALIZATION. A plate is written a dozen ways by humans ("abc 123",
 *    "ABC-123") and exactly one way by RUNT and SIMIT. Normalizing on the way
 *    in is what makes (user_id, plate) a usable unique key, so registering the
 *    same car twice updates it instead of duplicating it.
 *
 * 2. JUDGEMENT, NOT DATA. RUNT hands back a SOAT expiry date; nobody wants a
 *    date, they want to know whether they can legally drive tomorrow. Every
 *    expiry is projected to `{ expiresAt, status, daysLeft }` so the model
 *    never has to do date arithmetic — which is exactly the arithmetic models
 *    get wrong.
 *
 * 3. STATUS. Every tool carries `configured`/`reason`, so a workspace with no
 *    lookup service still gets a sentence it can say out loud rather than an
 *    empty result it cannot explain.
 */

/** Present on every vehicles tool's output; `reason` is null on success. */
export const statusShape = {
  configured: z.boolean(),
  reason: z.string().nullable(),
};

export const OK_STATUS = { configured: true, reason: null };

export function failureStatus(f: VehiclesFailure): { configured: boolean; reason: string } {
  return { configured: f.configured, reason: f.reason };
}

// ---------------------------------------------------------------------------
// Plates
// ---------------------------------------------------------------------------

/**
 * The one representation stored and sent upstream: uppercase, letters and
 * digits only. Colombian plates run ABC123 (cars), ABC12D (motorcycles) and a
 * handful of longer official formats, so length is checked rather than a shape
 * regex — refusing a legitimate but unusual plate is worse than accepting a
 * typo, which the registry rejects anyway with a clear message.
 */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const plateField = z
  .string()
  .min(5)
  .max(12)
  .describe('Licence plate, e.g. "ABC123" — spaces, dashes and lower case are fine');

export const docTypeField = z
  .enum(['CC', 'CE', 'NIT', 'PA'])
  .describe(
    "The owner's document type: CC (cédula), CE (cédula de extranjería), NIT (company) or PA (passport)",
  );

// ---------------------------------------------------------------------------
// Expiry judgement
// ---------------------------------------------------------------------------

export type ExpiryStatus = 'valid' | 'expiring' | 'expired' | 'unknown';

export const expirySchema = z.object({
  expiresAt: z.string().nullable().describe('ISO date the document stops being valid'),
  status: z
    .enum(['valid', 'expiring', 'expired', 'unknown'])
    .describe(
      '"expiring" means it lapses inside the warning window; "unknown" means never checked',
    ),
  daysLeft: z
    .number()
    .nullable()
    .describe('Whole days until it lapses; negative once it already has'),
});

export type Expiry = z.infer<typeof expirySchema>;

const DAY_MS = 86_400_000;

/**
 * Whole CALENDAR days from today to a date.
 *
 * Both ends are floored to a day boundary first, which is the difference
 * between "expired 2 days ago" and "expired 3 days ago" for the same date —
 * comparing a date-only expiry against the current clock time would otherwise
 * lose most of a day to the floor and misreport it by one.
 */
export function daysUntil(date: string | null | undefined, now: Date): number | null {
  if (!date) return null;
  const t = Date.parse(date.length <= 10 ? `${date}T00:00:00Z` : date);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / DAY_MS) - Math.floor(now.getTime() / DAY_MS);
}

/** Default warning window: a month is enough notice to book an RTM appointment. */
export const DEFAULT_WARN_DAYS = 30;

export function expiryOf(
  date: string | null | undefined,
  now: Date,
  warnDays = DEFAULT_WARN_DAYS,
): Expiry {
  const daysLeft = daysUntil(date, now);
  if (daysLeft === null) return { expiresAt: null, status: 'unknown', daysLeft: null };
  const status: ExpiryStatus =
    daysLeft < 0 ? 'expired' : daysLeft <= warnDays ? 'expiring' : 'valid';
  return { expiresAt: date ?? null, status, daysLeft };
}

// ---------------------------------------------------------------------------
// Rows → model-facing shapes
// ---------------------------------------------------------------------------

/** The vehicles columns every tool reads. Kept in one place so they cannot drift. */
export const VEHICLE_COLUMNS =
  'id, user_id, plate, label, owner_doc_type, owner_doc_number, brand, line, model_year, notes, runt_estado, soat_expires_at, rtm_expires_at, last_runt_sync, last_simit_sync, total_pending_cop, archived';

export interface VehicleRow {
  id: string;
  user_id: string;
  plate: string;
  label: string | null;
  owner_doc_type: string | null;
  owner_doc_number: string | null;
  brand: string | null;
  line: string | null;
  model_year: number | null;
  notes: string | null;
  runt_estado: string | null;
  soat_expires_at: string | null;
  rtm_expires_at: string | null;
  last_runt_sync: string | null;
  last_simit_sync: string | null;
  total_pending_cop: number | null;
  archived: boolean | null;
}

export const vehicleSchema = z.object({
  plate: z.string().describe('Normalized plate — uppercase, no separators'),
  label: z.string().nullable().describe('What the owner calls it, if they said'),
  brand: z.string().nullable(),
  line: z.string().nullable().describe('Model line as RUNT spells it'),
  modelYear: z.number().nullable(),
  runtEstado: z.string().nullable().describe('Registration status RUNT reports, e.g. ACTIVO'),
  soat: expirySchema.describe('Mandatory insurance — driving without it is an immediate fine'),
  rtm: expirySchema.describe('Roadworthiness test (revisión técnico-mecánica)'),
  totalPendingCop: z.number().describe('Outstanding fines in Colombian pesos, as SIMIT reports'),
  lastRuntCheck: z.string().nullable().describe('When RUNT was last consulted, ISO'),
  lastSimitCheck: z.string().nullable().describe('When SIMIT was last consulted, ISO'),
  // Never the document NUMBER — knowing whether one is on file is enough to
  // decide whether a RUNT consult can run, and the number itself has no
  // business being repeated back into a chat transcript.
  ownerDocOnFile: z.boolean().describe('Whether a RUNT consult can run for this vehicle'),
  archived: z.boolean(),
});

export type Vehicle = z.infer<typeof vehicleSchema>;

export function adaptVehicle(row: VehicleRow, now: Date, warnDays = DEFAULT_WARN_DAYS): Vehicle {
  return {
    plate: row.plate,
    label: row.label,
    brand: row.brand,
    line: row.line,
    modelYear: row.model_year,
    runtEstado: row.runt_estado,
    soat: expiryOf(row.soat_expires_at, now, warnDays),
    rtm: expiryOf(row.rtm_expires_at, now, warnDays),
    totalPendingCop: row.total_pending_cop ?? 0,
    lastRuntCheck: row.last_runt_sync,
    lastSimitCheck: row.last_simit_sync,
    ownerDocOnFile: !!(row.owner_doc_type && row.owner_doc_number),
    archived: !!row.archived,
  };
}

export interface FineRow {
  id: string;
  vehicle_id: string;
  code: string | null;
  description: string | null;
  amount_cop: number | null;
  issued_at: string | null;
  status: string | null;
  location: string | null;
  secretaria: string | null;
  comparendo: string | null;
  detected_at: string | null;
}

export const FINE_COLUMNS =
  'id, vehicle_id, code, description, amount_cop, issued_at, status, location, secretaria, comparendo, detected_at';

export const fineSchema = z.object({
  comparendo: z
    .string()
    .nullable()
    .describe('Citation number — the reference to quote when paying'),
  code: z.string().describe('Infraction code, e.g. C14'),
  description: z.string(),
  amountCop: z.number().describe('Amount owed in Colombian pesos, interest included'),
  issuedAt: z.string().nullable().describe('When the ticket was issued, ISO'),
  status: z.string().describe('PENDING, PAID or DISPUTED as SIMIT reports it'),
  location: z.string().nullable(),
  secretaria: z.string().nullable().describe('Traffic authority that issued it'),
  detectedAt: z.string().nullable().describe('When Cortex first saw it — not when it was issued'),
});

export type Fine = z.infer<typeof fineSchema>;

export function adaptFine(row: FineRow): Fine {
  return {
    comparendo: row.comparendo,
    code: row.code ?? '',
    description: row.description ?? '',
    amountCop: row.amount_cop ?? 0,
    issuedAt: row.issued_at,
    status: row.status ?? 'PENDING',
    location: row.location,
    secretaria: row.secretaria,
    detectedAt: row.detected_at,
  };
}

/**
 * Dedupe key for a fine. The comparendo number is the real identity and is what
 * the partial unique index enforces; when a scrape loses it, the infraction code
 * plus the day it was issued is the closest stable substitute — the same pair
 * twice on one plate on one day is, in practice, one ticket seen twice.
 */
export function fineKey(f: {
  comparendo?: string | null;
  code?: string | null;
  issuedAt?: string | null;
}): string {
  if (f.comparendo) return `c:${f.comparendo}`;
  return `k:${f.code ?? ''}#${(f.issuedAt ?? '').slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Prose helpers
// ---------------------------------------------------------------------------

/** COP amounts run to millions; grouped digits are the difference between
 *  "1250000" and a number a person can read aloud. */
export function cop(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CO')} COP`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "in 4 days" / "12 days ago" / "today" — the phrasing a person would use. */
export function whenPhrase(daysLeft: number): string {
  if (daysLeft === 0) return 'today';
  if (daysLeft > 0) return `in ${plural(daysLeft, 'day')}`;
  return `${plural(-daysLeft, 'day')} ago`;
}
