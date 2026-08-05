import type { SupabaseClient } from '@supabase/supabase-js';
import { COMMITMENT_COLUMNS, type CommitmentRow } from './shape';
import { createCommitment, isUniqueViolation } from './store';

/**
 * The fleet's paperwork, turned into watched commitments automatically.
 *
 * WHY THIS ONE IS ALLOWED TO CREATE ROWS WITH NO HUMAN IN THE LOOP. Everything
 * else that produces a commitment without somebody typing it goes to review
 * first, because the date came out of a model. These did not: RUNT — the
 * national vehicle registry — publishes the SOAT and tecnomecánica expiry for a
 * plate, `vehicles.check_runt` stores exactly what it said, and this function
 * copies that value across with `source_kind='system'`, the registry named, and
 * the moment it was read. Nothing infers anything. It is the cleanest source of
 * dates in the whole product, and sending it through a review queue would teach
 * people that the queue is a formality.
 *
 * WHAT IT REFUSES TO DO. It never rolls a SOAT forward. `recurrence` is
 * `from_source`: the next year's expiry arrives here when RUNT reports it after
 * the renewal, and until then there is no next commitment. See the migration
 * header — a fabricated date wearing a RUNT label is the specific failure this
 * module is built to prevent.
 *
 * IDEMPOTENCY. Keyed on (vehicle, kind, due date), so running this every night
 * against an unchanged registry answer writes nothing at all. When a NEWER date
 * appears, the previous occurrence is closed as met — the renewal happened,
 * that is what a new expiry date means — and the old row stays with its own
 * history rather than being overwritten.
 */

interface VehicleRow {
  id: string;
  user_id: string;
  plate: string;
  label: string | null;
  soat_expires_at: string | null;
  rtm_expires_at: string | null;
  last_runt_sync: string | null;
  archived: boolean | null;
}

const VEHICLE_COLUMNS =
  'id, user_id, plate, label, soat_expires_at, rtm_expires_at, last_runt_sync, archived';

/** What each document is called where a person can read it. */
const DOCUMENTS = [
  {
    kind: 'soat' as const,
    column: 'soat_expires_at' as const,
    title: 'SOAT',
    detail: 'Seguro obligatorio. Sin él, el vehículo no puede rodar y la multa es inmediata.',
  },
  {
    kind: 'rtm' as const,
    column: 'rtm_expires_at' as const,
    title: 'Tecnomecánica',
    detail: 'Revisión técnico-mecánica. Agendar con tiempo: los CDA se llenan a fin de mes.',
  },
];

export interface FleetSyncResult {
  vehicles: number;
  created: number;
  superseded: number;
  skippedNoReadTime: number;
}

/**
 * @param db a workspace-scoped handle
 * @param createdBy the user id to attribute the row to — the watcher passes the
 *   vehicle's owner, so the commitment lands on the plate of whoever registered
 *   the truck rather than of whoever happened to trigger the sweep.
 */
export async function syncFleetCommitments(db: SupabaseClient): Promise<FleetSyncResult> {
  const { data, error } = await db
    .from('vehicles')
    .select(VEHICLE_COLUMNS)
    .eq('archived', false)
    .limit(2000);
  if (error) throw error;

  const vehicles = (data ?? []) as VehicleRow[];
  const result: FleetSyncResult = {
    vehicles: vehicles.length,
    created: 0,
    superseded: 0,
    skippedNoReadTime: 0,
  };

  for (const vehicle of vehicles) {
    for (const doc of DOCUMENTS) {
      const dueOn = vehicle[doc.column];
      if (!dueOn) continue;

      // No read timestamp means we cannot say WHEN the registry said this, and
      // "read from RUNT" without a moment is not a provenance, it is a claim.
      // Such a row would also fail the source constraint in 0069, so refusing
      // here is the same rule stated earlier and more legibly.
      if (!vehicle.last_runt_sync) {
        result.skippedNoReadTime += 1;
        continue;
      }

      const { data: existing } = await db
        .from('commitments')
        .select('id, due_on, state')
        .eq('vehicle_id', vehicle.id)
        .eq('kind', doc.kind)
        .order('due_on', { ascending: false })
        .limit(20);
      const rows = (existing ?? []) as Array<{ id: string; due_on: string; state: string }>;

      if (rows.some((r) => r.due_on === dueOn)) continue;

      const name = vehicle.label ? `${vehicle.plate} (${vehicle.label})` : vehicle.plate;
      try {
        await createCommitment(db, {
          title: `${doc.title} · ${name}`,
          detail: doc.detail,
          kind: doc.kind,
          dueOn,
          ownerUserId: vehicle.user_id,
          vehicleId: vehicle.id,
          recurrence: 'from_source',
          source: { kind: 'system', system: 'RUNT', readAt: vehicle.last_runt_sync },
          createdBy: vehicle.user_id,
        });
        result.created += 1;
      } catch (err) {
        // Another pass got there first. The index did its job; nothing to fix.
        if (!isUniqueViolation(err)) throw err;
        continue;
      }

      // A newer expiry date IS the renewal. Close the earlier open occurrences
      // so the screen does not show a lapsed SOAT next to its own replacement.
      const stale = rows.filter(
        (r) => r.due_on < dueOn && r.state !== 'met' && r.state !== 'dropped',
      );
      for (const old of stale) {
        await db
          .from('commitments')
          .update({
            state: 'met',
            met_at: new Date().toISOString(),
            met_note: `Renovado: RUNT reporta vigencia hasta ${dueOn}.`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', old.id);
        result.superseded += 1;
      }
    }
  }

  return result;
}

/** Fleet commitments for one plate, newest first. Used by the vehicle detail view. */
export async function commitmentsForVehicle(
  db: SupabaseClient,
  vehicleId: string,
): Promise<CommitmentRow[]> {
  const { data, error } = await db
    .from('commitments')
    .select(COMMITMENT_COLUMNS)
    .eq('vehicle_id', vehicleId)
    .order('due_on', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as CommitmentRow[];
}
