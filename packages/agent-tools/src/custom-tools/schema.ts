/**
 * A stored field list becomes a zod schema — by CONSTRUCTION, never by
 * evaluation.
 *
 * The tempting shortcut here is to let a creator paste a JSON Schema, or worse
 * a snippet of zod, and turn it into a validator with `new Function`. That
 * would be remote code execution wearing a form: a tool definition is data
 * typed by a user, it is stored in a database, and it is compiled on OUR
 * server. So the definition is a closed list of field descriptors and this file
 * is a switch over five cases. Anything a creator can express, they express by
 * choosing from that list.
 *
 * The schema is also what the model reads. `.describe()` on every field is not
 * decoration: the AI SDK turns it into the parameter description, and a field
 * called `id` with no description is a field the model fills in with something
 * plausible and wrong.
 */

import { z } from 'zod';
import type { CustomToolField, CustomToolInputSchema } from './types';

/** Field names must be safe as both a template placeholder and a JS key. */
export const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

function baseType(field: CustomToolField): z.ZodTypeAny {
  switch (field.type) {
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'string_array':
      return z.array(z.string()).max(200);
    default: {
      if (field.enum && field.enum.length > 0) {
        // A closed set is worth far more than a description: the model cannot
        // invent a status that the ERP has never heard of.
        const [first, ...rest] = field.enum;
        return z.enum([first as string, ...rest]);
      }
      // Capped so a runaway argument cannot become a megabyte-long URL.
      return z.string().max(8_000);
    }
  }
}

/**
 * Build the zod object the tool validates its arguments with.
 *
 * Optional fields are `.optional()` rather than defaulted: "absent" has to stay
 * distinguishable from "empty", because template.ts drops an absent optional
 * from a JSON body instead of sending `null` — and an ERP that receives
 * `{"estado": null}` will often clear the field rather than ignore it.
 */
export function buildInputSchema(schema: CustomToolInputSchema | null | undefined) {
  const fields = schema?.fields ?? [];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    if (!FIELD_NAME_RE.test(field.name)) continue;
    const described = baseType(field).describe(field.description || field.name);
    shape[field.name] = field.required ? described : described.optional();
  }
  // `.strict()` deliberately not used: an extra argument from the model is
  // harmless (nothing unreferenced reaches the request) and rejecting the whole
  // call over one is worse than ignoring it.
  return z.object(shape);
}
