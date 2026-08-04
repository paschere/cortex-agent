import type { ToolContext } from '../types';
import { VEHICLE_COLUMNS, type VehicleRow } from './shape';

/**
 * The two database operations every consult tool shares: find the vehicle this
 * user registered, and record that a consult happened.
 *
 * Lookups ALWAYS filter on `ctx.userId`. The tools take a plate, which is a
 * value anybody can type, so the owner is never derived from the input — it is
 * derived from who is asking. Two people tracking the same plate get their own
 * row and never each other's.
 */

export async function findVehicle(ctx: ToolContext, plate: string): Promise<VehicleRow | null> {
  const { data, error } = await ctx.db
    .from('vehicles')
    .select(VEHICLE_COLUMNS)
    .eq('user_id', ctx.userId)
    .eq('plate', plate)
    .maybeSingle();
  if (error) throw error;
  return (data as VehicleRow | null) ?? null;
}

export function notRegisteredReason(plate: string): string {
  return `${plate} is not on your list of vehicles yet, so there is nothing to check it against. Register it first — RUNT also needs the owner's document type and number.`;
}

export function missingOwnerDocReason(plate: string): string {
  return `RUNT will not answer on a plate alone: it wants the owner's document type (CC, CE, NIT or PA) and number, and neither is on file for ${plate}. Register the vehicle again with those and I can check it.`;
}

/**
 * The bitácora row. Written for failures too — a consult that never got an
 * answer is the thing a monitoring routine most needs to be able to see, and
 * it is indistinguishable from "nothing to report" unless it is recorded.
 *
 * Deliberately best-effort: losing the log entry must never turn a successful
 * lookup into a failed tool call.
 */
export async function writeConsult(
  ctx: ToolContext,
  row: {
    vehicleId: string;
    source: 'RUNT' | 'SIMIT';
    status: 'ok' | 'error';
    message?: string | null;
    finesFound?: number;
  },
): Promise<void> {
  const { error } = await ctx.db.from('vehicle_consults').insert({
    vehicle_id: row.vehicleId,
    source: row.source,
    status: row.status,
    message: row.message ?? null,
    fines_found: row.finesFound ?? 0,
  });
  if (error) ctx.logger.warn({ source: row.source }, 'vehicle consult log write failed');
}
