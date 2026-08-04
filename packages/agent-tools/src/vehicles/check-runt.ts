import { z } from 'zod';
import { registerTool } from '../index';
import { type DocType, consultRunt } from './client';
import {
  OK_STATUS,
  VEHICLE_COLUMNS,
  type VehicleRow,
  adaptVehicle,
  failureStatus,
  normalizePlate,
  plateField,
  statusShape,
  vehicleSchema,
  whenPhrase,
} from './shape';
import { findVehicle, missingOwnerDocReason, notRegisteredReason, writeConsult } from './store';

/**
 * Consult RUNT — the national vehicle registry — and keep what it says.
 *
 * The consult drives a headless browser through an OCR captcha and takes about
 * eighteen seconds, which is why the rate limit is deliberately tiny and why
 * everything it returns is persisted: nothing here should ever be run twice to
 * answer the same question. `vehicles.get` and `vehicles.list` read the result
 * back for free.
 *
 * RUNT keeps no history, so a value that vanishes from its answer means the
 * registry stopped reporting it, not that the document lapsed. Nulls therefore
 * never overwrite a stored date — a blank from a partial scrape must not read
 * as "no SOAT on file".
 */

const YEAR_KEYS = ['modelo', 'model', 'anioModelo', 'modeloVehiculo'];

/** RUNT's info blob spells the model year several ways; take the first plausible one. */
function modelYearFrom(info: Record<string, unknown> | null | undefined): number | null {
  if (!info) return null;
  for (const key of YEAR_KEYS) {
    const raw = info[key];
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(n) && n >= 1900 && n <= new Date().getFullYear() + 2) return n;
  }
  return null;
}

/** RUNT dates arrive as dd/mm/yyyy as often as ISO. Anything else is dropped. */
function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const dmy = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? (iso[1] as string) : null;
}

export const vehiclesCheckRunt = registerTool({
  id: 'vehicles.check_runt',
  description:
    "Consult RUNT (Colombia's national vehicle registry) for one plate and store what it says: registration status, SOAT expiry, RTM expiry, brand and line. SLOW — the consult takes around twenty seconds because RUNT has to be driven through a captcha, so tell the person it is running before you start and never run it in a loop. The vehicle must already be registered WITH the owner's document type and number; RUNT refuses to answer without them. For fines, use the SIMIT check instead.",
  inputSchema: z.object({ plate: plateField }),
  outputSchema: z.object({
    ...statusShape,
    plate: z.string(),
    checked: z.boolean().describe('False when RUNT could not be consulted at all'),
    vehicle: vehicleSchema.nullable().describe('The stored vehicle, updated with what RUNT said'),
    guidance: z.string(),
  }),
  // Eighteen seconds a call, and every call is a captcha solve on somebody
  // else's server. Five a minute is already generous.
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const plate = normalizePlate(input.plate);
    const now = new Date();
    const base = { plate, checked: false, vehicle: null };

    const row = await findVehicle(ctx, plate);
    if (!row) {
      return {
        ...base,
        configured: true,
        reason: notRegisteredReason(plate),
        guidance: `Register ${plate} first, with the owner's document type and number, then this can run.`,
      };
    }
    if (!row.owner_doc_type || !row.owner_doc_number) {
      return {
        ...base,
        configured: true,
        reason: missingOwnerDocReason(plate),
        vehicle: adaptVehicle(row, now),
        guidance:
          "Ask for the owner's document type (CC, CE, NIT or PA) and number, register the vehicle again with them, then re-run this. The SIMIT fine check works without them.",
      };
    }

    const res = await consultRunt(ctx, {
      plate,
      docType: row.owner_doc_type as DocType,
      docNumber: row.owner_doc_number,
    });
    if (!res.ok) {
      await writeConsult(ctx, {
        vehicleId: row.id,
        source: 'RUNT',
        status: 'error',
        message: res.reason,
      });
      return {
        ...base,
        ...failureStatus(res),
        vehicle: adaptVehicle(row, now),
        guidance: `RUNT did not answer for ${plate}. What is shown is the last known state, which may be out of date — say so rather than presenting it as current.`,
      };
    }

    const runt = res.data;
    const soat = toIsoDate(runt.soatVigenteHasta);
    const rtm = toIsoDate(runt.rtmVigenteHasta);

    // Only fields RUNT actually reported are written. A partial scrape must
    // never erase a date we already hold — see the note at the top of the file.
    const patch: Record<string, unknown> = {
      last_runt_sync: runt.consultedAt || now.toISOString(),
      updated_at: now.toISOString(),
    };
    if (runt.estado) patch.runt_estado = runt.estado;
    if (runt.marca) patch.brand = runt.marca;
    if (runt.linea) patch.line = runt.linea;
    if (soat) patch.soat_expires_at = soat;
    if (rtm) patch.rtm_expires_at = rtm;
    const modelYear = modelYearFrom(runt.info);
    if (modelYear) patch.model_year = modelYear;

    const { data, error } = await ctx.db
      .from('vehicles')
      .update(patch)
      .eq('id', row.id)
      .select(VEHICLE_COLUMNS)
      .single();
    if (error) throw error;

    await writeConsult(ctx, { vehicleId: row.id, source: 'RUNT', status: 'ok' });

    const vehicle = adaptVehicle(data as VehicleRow, now);
    const notes = [`RUNT answered for ${plate}${runt.estado ? `: ${runt.estado}` : ''}.`];
    for (const [doc, exp] of [
      ['SOAT', vehicle.soat],
      ['RTM', vehicle.rtm],
    ] as const) {
      if (exp.status === 'expired')
        notes.push(
          `${doc} expired ${whenPhrase(exp.daysLeft ?? 0)} — driving on it risks an immediate fine and an impound.`,
        );
      else if (exp.status === 'expiring')
        notes.push(`${doc} expires ${whenPhrase(exp.daysLeft ?? 0)}; worth booking now.`);
      else if (exp.status === 'valid') notes.push(`${doc} is valid until ${exp.expiresAt}.`);
      else notes.push(`RUNT reported no ${doc} date, so that one stays unknown.`);
    }
    notes.push('This does not cover fines — the SIMIT check does.');

    return { ...OK_STATUS, plate, checked: true, vehicle, guidance: notes.join(' ') };
  },
});
