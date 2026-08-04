import { z } from 'zod';
import { registerTool } from '../index';
import { consultSimit } from './client';
import {
  FINE_COLUMNS,
  type Fine,
  type FineRow,
  OK_STATUS,
  adaptFine,
  cop,
  failureStatus,
  fineKey,
  fineSchema,
  normalizePlate,
  plateField,
  plural,
  statusShape,
} from './shape';
import { findVehicle, notRegisteredReason, writeConsult } from './store';

/**
 * Consult SIMIT — the national traffic-fine registry — and merge what it says
 * into what we already had.
 *
 * SIMIT reports a snapshot: every fine currently on the plate, with no notion
 * of which ones are new. The whole value of this tool is the diff, and the diff
 * only exists because previous snapshots were stored. That is why a fine is
 * written once and then updated in place: `detected_at` records when WE first
 * saw it, which is the date a person cares about ("a ticket showed up on
 * Tuesday"), not the date it was issued months earlier.
 *
 * Deduplication is by comparendo (citation number), matching the unique index
 * in migration 0054. Scrapes occasionally lose that number, so those rows fall
 * back to (code, day issued) — see `fineKey`.
 */

/** SIMIT lists everything ever issued; a plate with real history can carry dozens. */
const MAX_FINES_RETURNED = 50;

export const vehiclesCheckSimit = registerTool({
  id: 'vehicles.check_simit',
  description:
    'Consult SIMIT for one plate and store the traffic fines it reports. Needs only the plate — no owner document. Returns which fines are NEW since the last time this ran, which is the answer to "did I get a ticket?", plus the total outstanding. Faster than the RUNT check but still a scrape of a government site, so it is not instant. For SOAT and RTM validity, use the RUNT check instead.',
  inputSchema: z.object({ plate: plateField }),
  outputSchema: z.object({
    ...statusShape,
    plate: z.string(),
    checked: z.boolean().describe('False when SIMIT could not be consulted at all'),
    newFines: z.array(fineSchema).describe('Fines that were not on record before this check'),
    newCount: z.number(),
    fines: z.array(fineSchema).describe('Everything outstanding on the plate right now'),
    totalPendingCop: z.number().describe('What SIMIT says is owed in total, in Colombian pesos'),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const plate = normalizePlate(input.plate);
    const now = new Date();
    const base = {
      plate,
      checked: false,
      newFines: [] as Fine[],
      newCount: 0,
      fines: [] as Fine[],
      totalPendingCop: 0,
    };

    const row = await findVehicle(ctx, plate);
    if (!row) {
      return {
        ...base,
        configured: true,
        reason: notRegisteredReason(plate),
        guidance: `Register ${plate} first, then this can run — SIMIT itself only needs the plate.`,
      };
    }

    const res = await consultSimit(ctx, plate);
    if (!res.ok) {
      await writeConsult(ctx, {
        vehicleId: row.id,
        source: 'SIMIT',
        status: 'error',
        message: res.reason,
      });
      return {
        ...base,
        ...failureStatus(res),
        totalPendingCop: row.total_pending_cop ?? 0,
        guidance: `SIMIT did not answer for ${plate}, so nothing was updated. Do not report "no fines" — report that the check failed.`,
      };
    }

    const reported = res.data.fines ?? [];

    const { data: existingData, error: existingErr } = await ctx.db
      .from('vehicle_fines')
      .select(FINE_COLUMNS)
      .eq('vehicle_id', row.id);
    if (existingErr) throw existingErr;
    const existing = (existingData ?? []) as FineRow[];
    // Keyed through `adaptFine` rather than off the raw row: the fallback key
    // reads `issuedAt`, and a snake_case row would silently key as an empty
    // date — which turns every comparendo-less fine into a new one, forever.
    const byKey = new Map(existing.map((f) => [fineKey(adaptFine(f)), f]));

    const fresh: Record<string, unknown>[] = [];
    const newFines: Fine[] = [];
    for (const f of reported) {
      const key = fineKey(f);
      const prior = byKey.get(key);
      if (!prior) {
        fresh.push({
          vehicle_id: row.id,
          code: f.code ?? '',
          description: f.description ?? '',
          amount_cop: Math.round(f.amountCop ?? 0),
          issued_at: f.issuedAt || null,
          status: f.status ?? 'PENDING',
          location: f.location ?? null,
          secretaria: f.secretaria ?? null,
          comparendo: f.comparendo ?? null,
          detected_at: now.toISOString(),
        });
        continue;
      }
      // Already known. Status and amount both move (a fine gets paid, interest
      // accrues), so they are refreshed — but detected_at is never touched.
      const amount = Math.round(f.amountCop ?? 0);
      const status = f.status ?? 'PENDING';
      if (prior.status !== status || (prior.amount_cop ?? 0) !== amount) {
        const { error } = await ctx.db
          .from('vehicle_fines')
          .update({ status, amount_cop: amount })
          .eq('id', prior.id);
        if (error) throw error;
      }
    }

    if (fresh.length) {
      // onConflict mirrors the partial unique index: two checks racing on the
      // same plate must merge, not collide. Rows with no comparendo are outside
      // that index and were already deduped in memory above.
      const { data, error } = await ctx.db
        .from('vehicle_fines')
        .upsert(fresh, { onConflict: 'vehicle_id,comparendo', ignoreDuplicates: true })
        .select(FINE_COLUMNS);
      if (error) throw error;
      for (const inserted of (data ?? []) as FineRow[]) newFines.push(adaptFine(inserted));
    }

    const totalPendingCop = Math.round(res.data.totalPendingCop ?? 0);
    const { error: vehErr } = await ctx.db
      .from('vehicles')
      .update({
        total_pending_cop: totalPendingCop,
        last_simit_sync: res.data.consultedAt || now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('id', row.id);
    if (vehErr) throw vehErr;

    await writeConsult(ctx, {
      vehicleId: row.id,
      source: 'SIMIT',
      status: 'ok',
      finesFound: reported.length,
    });

    const outstanding = reported
      .filter((f) => (f.status ?? 'PENDING') === 'PENDING')
      .map((f) => ({
        comparendo: f.comparendo ?? null,
        code: f.code ?? '',
        description: f.description ?? '',
        amountCop: Math.round(f.amountCop ?? 0),
        issuedAt: f.issuedAt || null,
        status: f.status ?? 'PENDING',
        location: f.location ?? null,
        secretaria: f.secretaria ?? null,
        detectedAt: byKey.get(fineKey(f))?.detected_at ?? now.toISOString(),
      }))
      .slice(0, MAX_FINES_RETURNED);

    const notes: string[] = [];
    if (newFines.length) {
      const newTotal = newFines.reduce((sum, f) => sum + f.amountCop, 0);
      notes.push(
        `${plural(newFines.length, 'NEW fine')} on ${plate} since the last check, ${cop(newTotal)}. Lead with these — they are the news.`,
      );
    } else {
      notes.push(`Nothing new on ${plate} since the last check.`);
    }
    notes.push(
      outstanding.length
        ? `${plural(outstanding.length, 'fine')} outstanding, ${cop(totalPendingCop)} owed in total.`
        : 'Nothing outstanding — the plate is clear.',
    );
    if (reported.length > MAX_FINES_RETURNED) {
      notes.push(
        `Only the first ${MAX_FINES_RETURNED} are listed; the total above covers them all.`,
      );
    }

    return {
      ...OK_STATUS,
      plate,
      checked: true,
      newFines,
      newCount: newFines.length,
      fines: outstanding,
      totalPendingCop,
      guidance: notes.join(' '),
    };
  },
});
