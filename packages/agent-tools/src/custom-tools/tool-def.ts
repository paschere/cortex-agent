/**
 * A `custom_tools` row, dressed as an ordinary `ToolDef`.
 *
 * THE WHOLE POINT OF THIS FILE is that everything downstream of it stops caring
 * where the tool came from. A custom tool is handed to `runTool` exactly like
 * `gmail.send_draft` is, and therefore inherits — without any of it being
 * re-implemented here — input validation, the risk classifier, the confirmation
 * gate, the rate limiter, the audit row, the security-event row, and the
 * `_security` notice that travels back with a flagged result. The alternative,
 * a bespoke execution path next to the registry, is how a feature ships with
 * "we'll add auditing later" and never does.
 *
 * WHAT THE RISK MODEL MAKES OF IT. `custom` is not in `FAMILY_SENSITIVITY`, so
 * `sensitivityOf` falls through to the default — `client` — which is the
 * conservative answer and the right one: we have no idea what a customer
 * pointed this at, and assuming "public" would be a guess in the dangerous
 * direction. Blast radius cannot be inferred from the id the way it is for
 * built-ins (`custom.consultar_guia` reads like a read whatever its HTTP method
 * is), so the definition states it instead: `requiresConfirmation` is set from
 * the stored flag, which the API forces true for every write method.
 */

import { z } from 'zod';
import type { ToolDef } from '../types';
import { executeCustomTool } from './execute';
import type { HostResolver } from './guard';
import { buildInputSchema } from './schema';
import { type CustomToolResult, type CustomToolRow, customToolId } from './types';

/**
 * Deliberately permissive. The handler returns exactly this shape and nothing
 * else, but `runTool` validates output and throws `ValidationError` on a
 * mismatch — and a schema that could reject our own soft-failure envelope would
 * turn "the ERP is down" back into a thrown error, which is the one outcome
 * this whole design exists to avoid.
 */
const OutputSchema: z.ZodType<CustomToolResult> = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  data: z.unknown().optional(),
  truncated: z.boolean().optional(),
  message: z.string().optional(),
});

export interface CustomToolDefOptions {
  /** Test seam for the DNS half of the destination check. */
  resolve?: HostResolver;
}

export function customToolDef(
  row: CustomToolRow,
  opts: CustomToolDefOptions = {},
): ToolDef<Record<string, unknown>, CustomToolResult> {
  return {
    id: customToolId(row.slug),
    // The description is what the model reads to decide whether to reach for
    // this tool, and what tool-selection embeds to decide whether to offer it
    // at all. It is stored verbatim; the panel is where creators are coached to
    // write it prescriptively.
    description: row.description,
    inputSchema: buildInputSchema(row.input_schema) as unknown as z.ZodType<
      Record<string, unknown>
    >,
    outputSchema: OutputSchema,
    requiresConfirmation: row.requires_confirmation,
    rateLimit: { perMinute: row.rate_limit_per_minute },
    handler: async (input, ctx) => {
      const { result } = await executeCustomTool(row, input ?? {}, {
        signal: ctx.signal,
        resolve: opts.resolve,
      });
      return result;
    },
  };
}
