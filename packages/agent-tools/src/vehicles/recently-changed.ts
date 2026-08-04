import { z } from 'zod';
import { registerTool } from '../index';
import { NOT_CONFIGURED_REASON, scraperConfigured } from './client';
import {
  DEFAULT_WARN_DAYS,
  type FineRow,
  VEHICLE_COLUMNS,
  type VehicleRow,
  cop,
  daysUntil,
  plural,
  statusShape,
  whenPhrase,
} from './shape';

/**
 * What has moved across every vehicle this person tracks — the tool a
 * monitoring routine calls and reads out.
 *
 * It consults nothing. The RUNT and SIMIT checks are the expensive half and
 * run on their own schedule; this is the cheap half that turns what they left
 * behind into a report. Two kinds of news:
 *
 *   - fines Cortex SAW for the first time inside the window (`detected_at`,
 *     not `issued_at` — a comparendo from March that surfaces today is today's
 *     news to the person who has to pay it);
 *   - SOAT and RTM that lapse inside the warning window, or already have.
 *
 * The output is written to be reportable as-is: every change carries the plate,
 * a finished sentence and the urgency already worked out, so a routine can post
 * it without the model re-deriving anything from raw dates.
 */

const changeSchema = z.object({
  plate: z.string(),
  label: z.string().nullable().describe('What the owner calls this vehicle, if they said'),
  kind: z
    .enum(['new_fine', 'soat_expiring', 'soat_expired', 'rtm_expiring', 'rtm_expired'])
    .describe('What sort of news this is'),
  urgency: z.enum(['urgent', 'soon']).describe('"urgent" means already lapsed, or money owed now'),
  detail: z.string().describe('A finished sentence, safe to report verbatim'),
  amountCop: z.number().nullable().describe('Set on a fine; null on an expiry'),
  dueAt: z.string().nullable().describe('The expiry date, ISO; null on a fine'),
  daysLeft: z.number().nullable().describe('Negative once the document has already lapsed'),
  detectedAt: z.string().nullable().describe('When Cortex first saw a new fine'),
});

type Change = z.infer<typeof changeSchema>;

const URGENCY_RANK: Record<Change['urgency'], number> = { urgent: 0, soon: 1 };

export const vehiclesRecentlyChanged = registerTool({
  id: 'vehicles.recently_changed',
  description:
    'What changed across every vehicle this person tracks: traffic fines that appeared since the last look, and SOAT or RTM about to lapse (or already lapsed). This is the vehicle watch report — run it on a schedule, or when someone asks "anything I need to deal with?". It reads stored data only, so it is instant; it reports what the RUNT and SIMIT checks last found, and says so when that is stale.',
  inputSchema: z.object({
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(7)
      .describe('How far back to look for newly detected fines, in days'),
    // Separate from sinceDays on purpose: a week is the right window for "what
    // arrived", and a month is the right one for "what is about to lapse" —
    // an RTM appointment cannot be booked with four days' notice.
    expiringWithinDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(DEFAULT_WARN_DAYS)
      .describe('How far ahead to warn about SOAT and RTM expiring, in days'),
  }),
  outputSchema: z.object({
    ...statusShape,
    changes: z.array(changeSchema),
    changeCount: z.number(),
    vehiclesChecked: z.number(),
    since: z.string().describe('Start of the window, ISO'),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const now = new Date();
    const sinceDays = input.sinceDays ?? 7;
    const warnDays = input.expiringWithinDays ?? DEFAULT_WARN_DAYS;
    const since = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
    const status = scraperConfigured()
      ? { configured: true, reason: null }
      : { configured: false, reason: NOT_CONFIGURED_REASON };

    const { data: vehicleData, error } = await ctx.db
      .from('vehicles')
      .select(VEHICLE_COLUMNS)
      .eq('user_id', ctx.userId)
      .eq('archived', false);
    if (error) throw error;
    const vehicles = (vehicleData ?? []) as VehicleRow[];

    if (!vehicles.length) {
      return {
        ...status,
        changes: [],
        changeCount: 0,
        vehiclesChecked: 0,
        since,
        guidance: 'No vehicles are being tracked, so there is nothing to watch. Nothing to report.',
      };
    }

    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const { data: fineData, error: fineErr } = await ctx.db
      .from('vehicle_fines')
      .select('vehicle_id, code, description, amount_cop, comparendo, status, detected_at')
      .in('vehicle_id', [...byId.keys()])
      .gte('detected_at', since)
      .order('detected_at', { ascending: false });
    if (fineErr) throw fineErr;

    const changes: Change[] = [];
    const name = (v: VehicleRow) => (v.label ? `${v.plate} (${v.label})` : v.plate);

    for (const f of (fineData ?? []) as FineRow[]) {
      const v = byId.get(f.vehicle_id);
      if (!v) continue;
      const amount = f.amount_cop ?? 0;
      const settled = (f.status ?? 'PENDING') !== 'PENDING';
      changes.push({
        plate: v.plate,
        label: v.label,
        kind: 'new_fine',
        urgency: settled ? 'soon' : 'urgent',
        detail: `New fine on ${name(v)}: ${f.code ?? 'unknown code'}${
          f.description ? ` — ${f.description}` : ''
        }, ${cop(amount)}${f.comparendo ? `, comparendo ${f.comparendo}` : ''}${
          settled ? ' (already settled)' : ''
        }.`,
        amountCop: amount,
        dueAt: null,
        daysLeft: null,
        detectedAt: f.detected_at,
      });
    }

    for (const v of vehicles) {
      for (const [doc, date] of [
        ['soat', v.soat_expires_at],
        ['rtm', v.rtm_expires_at],
      ] as const) {
        const daysLeft = daysUntil(date, now);
        // Never checked, so nothing is claimed. The staleness note below is
        // what tells the model these blanks are unknown, not clean.
        if (daysLeft === null || daysLeft > warnDays) continue;
        const expired = daysLeft < 0;
        const label = doc.toUpperCase();
        changes.push({
          plate: v.plate,
          label: v.label,
          kind: expired ? (`${doc}_expired` as const) : (`${doc}_expiring` as const),
          urgency: expired ? 'urgent' : 'soon',
          detail: expired
            ? `${label} on ${name(v)} expired ${whenPhrase(daysLeft)} (${date}) — driving on it risks an immediate fine and an impound.`
            : `${label} on ${name(v)} expires ${whenPhrase(daysLeft)} (${date}).`,
          amountCop: null,
          dueAt: date,
          daysLeft,
          detectedAt: null,
        });
      }
    }

    // Worst first: everything already lapsed or owing, then what is coming.
    // Inside the urgent group, `daysLeft` sorts a lapsed document (negative)
    // ahead of a new fine (null, read as today) on purpose — being unable to
    // legally drive outranks owing money, and both outrank a future date.
    changes.sort(
      (a, b) =>
        URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
        (a.daysLeft ?? 0) - (b.daysLeft ?? 0) ||
        a.plate.localeCompare(b.plate),
    );

    // A vehicle nobody has consulted lately produces no changes, which reads
    // exactly like a vehicle with nothing wrong. Saying so is the difference
    // between a useful watch report and a falsely reassuring one.
    const stale = vehicles.filter((v) => {
      const last = [v.last_runt_sync, v.last_simit_sync].filter(Boolean) as string[];
      if (!last.length) return true;
      const newest = Math.max(...last.map((d) => Date.parse(d)));
      return now.getTime() - newest > 30 * 86_400_000;
    });

    const notes: string[] = [];
    if (!changes.length) {
      notes.push(
        `Nothing changed across ${plural(vehicles.length, 'vehicle')} in the last ${plural(sinceDays, 'day')}, and nothing lapses within ${plural(warnDays, 'day')}.`,
      );
    } else {
      const fines = changes.filter((c) => c.kind === 'new_fine');
      const owed = fines.reduce((sum, c) => sum + (c.amountCop ?? 0), 0);
      if (fines.length) notes.push(`${plural(fines.length, 'new fine')} totalling ${cop(owed)}.`);
      const expiries = changes.length - fines.length;
      if (expiries) notes.push(`${plural(expiries, 'document')} expired or expiring.`);
      notes.push('Report the urgent ones first, by plate; every `detail` is already a sentence.');
    }
    if (stale.length) {
      notes.push(
        `${plural(stale.length, 'vehicle has', 'vehicles have')} not been checked against RUNT or SIMIT in over a month (${stale.map((v) => v.plate).join(', ')}), so a clean result for those means unknown, not clear.`,
      );
    }

    return {
      ...status,
      changes,
      changeCount: changes.length,
      vehiclesChecked: vehicles.length,
      since,
      guidance: notes.join(' '),
    };
  },
});
