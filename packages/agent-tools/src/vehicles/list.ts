import { z } from 'zod';
import { registerTool } from '../index';
import { NOT_CONFIGURED_REASON, scraperConfigured } from './client';
import {
  DEFAULT_WARN_DAYS,
  VEHICLE_COLUMNS,
  type VehicleRow,
  adaptVehicle,
  cop,
  plural,
  statusShape,
  vehicleSchema,
  whenPhrase,
} from './shape';

/**
 * The whole list, with the answer already worked out.
 *
 * This reads only what is already stored — it never consults RUNT or SIMIT, so
 * it is instant and free. That is the point: the expensive scrapes run on a
 * schedule, and every ordinary question ("is anything expired?", "what do I
 * owe?") is answered from what they left behind.
 */

const rowSchema = vehicleSchema.extend({
  pendingFines: z.number().describe('How many fines are still outstanding on this vehicle'),
});

export const vehiclesList = registerTool({
  id: 'vehicles.list',
  description:
    'List the vehicles this person is tracking, each with its SOAT and RTM status (valid, expiring soon or already expired, and how many days that is), what it owes in traffic fines, and when it was last checked. Answers "is anything about to expire?" and "what do I owe?" instantly from what is already stored — it does not consult RUNT or SIMIT, so run the checks first if the stored dates look stale.',
  inputSchema: z.object({
    includeArchived: z
      .boolean()
      .default(false)
      .describe('Include vehicles that were archived, e.g. a car that was sold'),
    warnDays: z
      .number()
      .int()
      .min(1)
      .max(180)
      .default(DEFAULT_WARN_DAYS)
      .describe('How far ahead counts as "expiring soon", in days'),
  }),
  outputSchema: z.object({
    ...statusShape,
    vehicles: z.array(rowSchema),
    count: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const now = new Date();
    const warnDays = input.warnDays ?? DEFAULT_WARN_DAYS;

    let query = ctx.db.from('vehicles').select(VEHICLE_COLUMNS).eq('user_id', ctx.userId);
    if (!input.includeArchived) query = query.eq('archived', false);
    const { data, error } = await query.order('plate', { ascending: true });
    if (error) throw error;

    const rows = (data ?? []) as VehicleRow[];
    const status = scraperConfigured()
      ? { configured: true, reason: null }
      : { configured: false, reason: NOT_CONFIGURED_REASON };

    if (!rows.length) {
      return {
        ...status,
        vehicles: [],
        count: 0,
        guidance:
          "No vehicles are being tracked yet. Ask for the plate and the owner's document type and number, then register it.",
      };
    }

    // One query for every vehicle's outstanding fines rather than one per
    // vehicle — the count is a headline number, not a reason to fan out.
    const ids = rows.map((r) => r.id);
    const { data: fineRows, error: fineErr } = await ctx.db
      .from('vehicle_fines')
      .select('vehicle_id, status')
      .in('vehicle_id', ids);
    if (fineErr) throw fineErr;

    const pendingByVehicle = new Map<string, number>();
    for (const f of (fineRows ?? []) as { vehicle_id: string; status: string | null }[]) {
      if ((f.status ?? 'PENDING') !== 'PENDING') continue;
      pendingByVehicle.set(f.vehicle_id, (pendingByVehicle.get(f.vehicle_id) ?? 0) + 1);
    }

    const vehicles = rows.map((row) => ({
      ...adaptVehicle(row, now, warnDays),
      pendingFines: pendingByVehicle.get(row.id) ?? 0,
    }));

    // The guidance is the report. Whatever is wrong is said first, by plate,
    // so the model never has to re-derive urgency from a table of dates.
    const urgent: string[] = [];
    for (const v of vehicles) {
      const name = v.label ? `${v.plate} (${v.label})` : v.plate;
      for (const [doc, exp] of [
        ['SOAT', v.soat],
        ['RTM', v.rtm],
      ] as const) {
        if (exp.status === 'expired')
          urgent.push(`${name}: ${doc} expired ${whenPhrase(exp.daysLeft ?? 0)}`);
        else if (exp.status === 'expiring')
          urgent.push(`${name}: ${doc} expires ${whenPhrase(exp.daysLeft ?? 0)}`);
      }
      if (v.totalPendingCop > 0) urgent.push(`${name}: ${cop(v.totalPendingCop)} owed in fines`);
    }

    const never = vehicles.filter((v) => !v.lastRuntCheck && !v.lastSimitCheck).length;
    const notes = [`${plural(vehicles.length, 'vehicle')} tracked.`];
    if (urgent.length) notes.push(`Needs attention — ${urgent.join('; ')}.`);
    else notes.push('Nothing is expired, expiring soon or owing money.');
    if (never) {
      notes.push(
        `${plural(never, 'vehicle has', 'vehicles have')} never been checked, so the blanks are unknown rather than clean.`,
      );
    }

    return { ...status, vehicles, count: vehicles.length, guidance: notes.join(' ') };
  },
});
