import { z } from 'zod';
import { registerTool } from '../index';
import { NOT_CONFIGURED_REASON, scraperConfigured } from './client';
import {
  DEFAULT_WARN_DAYS,
  FINE_COLUMNS,
  type FineRow,
  adaptFine,
  adaptVehicle,
  cop,
  fineSchema,
  normalizePlate,
  plateField,
  plural,
  statusShape,
  vehicleSchema,
  whenPhrase,
} from './shape';
import { findVehicle, notRegisteredReason } from './store';

/**
 * Everything stored about one plate, fines included.
 *
 * Like the list, this consults nothing — it reports the last known state and
 * says how old it is, so the model can decide whether a fresh RUNT or SIMIT
 * check is worth the wait rather than guessing.
 */

const STALE_DAYS = 30;

export const vehiclesGet = registerTool({
  id: 'vehicles.get',
  description:
    'Show everything stored about one vehicle by its plate — brand and line, registration status, SOAT and RTM validity, every traffic fine on record with its citation number and amount, and when each source was last consulted. Use it when the question is about one specific car. Reads stored data only; it does not consult RUNT or SIMIT.',
  inputSchema: z.object({
    plate: plateField,
    includePaidFines: z
      .boolean()
      .default(false)
      .describe('Include fines already settled — off by default, since only what is owed matters'),
  }),
  outputSchema: z.object({
    ...statusShape,
    found: z.boolean(),
    vehicle: vehicleSchema.nullable(),
    fines: z.array(fineSchema),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const plate = normalizePlate(input.plate);
    const now = new Date();
    const status = scraperConfigured()
      ? { configured: true, reason: null }
      : { configured: false, reason: NOT_CONFIGURED_REASON };

    const row = await findVehicle(ctx, plate);
    if (!row) {
      return {
        configured: status.configured,
        reason: notRegisteredReason(plate),
        found: false,
        vehicle: null,
        fines: [],
        guidance: `Nothing is tracked for ${plate}. Register it first if this is one of theirs.`,
      };
    }

    const { data, error } = await ctx.db
      .from('vehicle_fines')
      .select(FINE_COLUMNS)
      .eq('vehicle_id', row.id)
      .order('issued_at', { ascending: false });
    if (error) throw error;

    const all = ((data ?? []) as FineRow[]).map(adaptFine);
    const fines = input.includePaidFines ? all : all.filter((f) => f.status === 'PENDING');
    const vehicle = adaptVehicle(row, now, DEFAULT_WARN_DAYS);

    const notes: string[] = [];
    for (const [doc, exp] of [
      ['SOAT', vehicle.soat],
      ['RTM', vehicle.rtm],
    ] as const) {
      if (exp.status === 'expired') notes.push(`${doc} expired ${whenPhrase(exp.daysLeft ?? 0)}.`);
      else if (exp.status === 'expiring')
        notes.push(`${doc} expires ${whenPhrase(exp.daysLeft ?? 0)}.`);
      else if (exp.status === 'unknown') notes.push(`${doc} has never been checked.`);
    }

    const owed = fines.filter((f) => f.status === 'PENDING');
    notes.push(
      owed.length
        ? `${plural(owed.length, 'fine')} outstanding, ${cop(vehicle.totalPendingCop)} in total — quote the comparendo number when paying.`
        : 'No outstanding fines on record.',
    );

    // Stale data is worse than missing data, because it reads as reassurance.
    const staleness = (last: string | null) =>
      last === null ? null : Math.floor((now.getTime() - Date.parse(last)) / 86_400_000);
    const runtAge = staleness(vehicle.lastRuntCheck);
    const simitAge = staleness(vehicle.lastSimitCheck);
    if (runtAge === null || runtAge > STALE_DAYS || simitAge === null || simitAge > STALE_DAYS) {
      notes.push(
        'Some of this is stale or was never checked, so treat it as the last known state rather than the truth — offer to re-check RUNT (about twenty seconds) or SIMIT.',
      );
    }

    return { ...status, found: true, vehicle, fines, guidance: notes.join(' ') };
  },
});
