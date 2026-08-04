import { z } from 'zod';
import { registerTool } from '../index';
import { NOT_CONFIGURED_REASON, scraperConfigured } from './client';
import {
  VEHICLE_COLUMNS,
  type VehicleRow,
  adaptVehicle,
  docTypeField,
  normalizePlate,
  plateField,
  statusShape,
  vehicleSchema,
} from './shape';
import { findVehicle } from './store';

/**
 * Put a plate on this person's list.
 *
 * Idempotent by design. "Register my car" is a sentence people repeat, and the
 * unique index on (user_id, plate) means the second attempt is an update, not
 * an error the model has to apologise for. Fields that were not supplied are
 * left alone: re-registering to add a label must not wipe the owner document
 * that makes RUNT consults possible.
 */

const NOTES_MAX = 500;

export const vehiclesRegister = registerTool({
  id: 'vehicles.register',
  description:
    "Add a vehicle to the person's list so Cortex can watch its SOAT, its RTM and its traffic fines. Takes the plate and — because RUNT refuses to answer without them — the owner's document type and number. Registering the same plate again updates it instead of duplicating it, so it is safe to re-run. Registering stores nothing from RUNT or SIMIT by itself; run the RUNT and SIMIT checks afterwards to fill in the details.",
  inputSchema: z.object({
    plate: plateField,
    ownerDocType: docTypeField.optional(),
    ownerDocNumber: z
      .string()
      .min(4)
      .max(20)
      .optional()
      .describe("The owner's document number, digits only — RUNT will not run without it"),
    label: z
      .string()
      .max(80)
      .optional()
      .describe('What the owner calls it, e.g. "the red Mazda" — used when reporting back'),
    notes: z.string().max(NOTES_MAX).optional().describe('Anything worth remembering about it'),
  }),
  outputSchema: z.object({
    ...statusShape,
    vehicle: vehicleSchema,
    created: z.boolean().describe('False when the plate was already on the list and was updated'),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const plate = normalizePlate(input.plate);
    const now = new Date();
    const existing = await findVehicle(ctx, plate);

    // Only the fields the caller actually supplied are written. A partial
    // re-registration is the normal way people add a label later.
    const patch: Record<string, unknown> = { updated_at: now.toISOString() };
    if (input.ownerDocType) patch.owner_doc_type = input.ownerDocType;
    if (input.ownerDocNumber)
      patch.owner_doc_number = input.ownerDocNumber.replace(/[^\dA-Za-z]/g, '');
    if (input.label !== undefined) patch.label = input.label;
    if (input.notes !== undefined) patch.notes = input.notes;

    let row: VehicleRow;
    if (existing) {
      const { data, error } = await ctx.db
        .from('vehicles')
        .update(patch)
        .eq('id', existing.id)
        .select(VEHICLE_COLUMNS)
        .single();
      if (error) throw error;
      row = data as VehicleRow;
    } else {
      const { data, error } = await ctx.db
        .from('vehicles')
        .insert({ user_id: ctx.userId, plate, ...patch })
        .select(VEHICLE_COLUMNS)
        .single();
      if (error) throw error;
      row = data as VehicleRow;
    }

    const vehicle = adaptVehicle(row, now);
    const created = !existing;
    const notes = [
      created
        ? `${plate} is now on the list.`
        : `${plate} was already on the list, so I updated it rather than adding a second copy.`,
    ];
    if (!vehicle.ownerDocOnFile) {
      notes.push(
        "There is no owner document on file, so the RUNT check (SOAT and RTM) cannot run yet — ask for the owner's document type and number. The SIMIT check for fines works on the plate alone.",
      );
    } else if (!vehicle.lastRuntCheck && !vehicle.lastSimitCheck) {
      notes.push(
        'Nothing is known about it yet. Run the RUNT check for SOAT and RTM, and the SIMIT check for fines. The RUNT one takes around twenty seconds — say so before starting it.',
      );
    }

    return {
      // The record is saved either way; `configured` reports whether the
      // follow-up lookups can actually run, which is what the model needs to
      // know before promising one.
      configured: scraperConfigured(),
      reason: scraperConfigured() ? null : NOT_CONFIGURED_REASON,
      vehicle,
      created,
      guidance: notes.join(' '),
    };
  },
});
