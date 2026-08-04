import { z } from "zod";
import { registerTool } from "../index";
import { bambooFetch } from "./client";
import {
  DATASET,
  OK_STATUS,
  failureStatus,
  sourceOf,
  sourceSchema,
  statusShape,
  str,
} from "./shape";

/**
 * What BambooHR actually tracks about people at Cortex.
 *
 * Cortex's instance carries ~294 fields and 33 historical tables, most of them
 * custom and invisible from the outside. Without this, the only way to find out
 * whether something is recorded — a visa expiry, an equity grant, a bill rate —
 * is to ask a person. With it, Cortex can answer "do we track X?" honestly, and
 * say no when the answer is no.
 *
 * Names and types only. Numeric field ids are internal plumbing and are never
 * returned; nobody outside this package has a use for "field 4631".
 */

interface RawField {
  id?: number | string;
  name?: string;
  type?: string;
  alias?: string;
}

interface RawTable {
  alias?: string;
  fields?: RawField[];
}

// Fields BambooHR exposes that carry identity or bank details. They are named
// so Cortex can say the category exists, but this family provides no tool that
// reads their values — see the security policy's PERSONAL_ID_RE for why.
const RESTRICTED_RE =
  /ssn|social security|passport|bank|clabe|iban|swift|account number|visa #|driver license|national id|birth date|date of birth/i;

const fieldSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  /** True when Cortex added it rather than BambooHR shipping it. */
  custom: z.boolean(),
  /** True when it holds identity or banking data no tool here will read. */
  restricted: z.boolean(),
});

const MAX_FIELDS = 300;

export const bambooDescribeFields = registerTool({
  id: "bamboo.describe_fields",
  description:
    'List what BambooHR records about people at Cortex — every field on an employee record and every historical table (job history, compensation history, bill rate history, visas, assets, education and so on), including the custom ones Cortex added. Use it to answer "do we track X in BambooHR?" before assuming something is or is not recorded. Returns field names only, never anybody\'s values.',
  inputSchema: z.object({
    search: z
      .string()
      .max(80)
      .optional()
      .describe(
        'Only fields whose name matches, e.g. "rate", "visa", "manager"',
      ),
    includeTables: z
      .boolean()
      .default(true)
      .describe("Also list the historical tables and what each one holds"),
    limit: z.number().int().min(1).max(MAX_FIELDS).default(80),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    fields: z.array(fieldSchema),
    totalFields: z.number(),
    tables: z.array(
      z.object({ name: z.string(), fields: z.array(z.string()) }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.fields),
      fields: [] as z.infer<typeof fieldSchema>[],
      totalFields: 0,
      tables: [] as Array<{ name: string; fields: string[] }>,
      guidance: "",
    };

    const [fieldsRes, tablesRes] = await Promise.all([
      bambooFetch<RawField[]>(ctx, "GET", "/meta/fields"),
      input.includeTables === false
        ? Promise.resolve(null)
        : bambooFetch<RawTable[]>(ctx, "GET", "/meta/tables"),
    ]);
    if (!fieldsRes.ok) return { ...empty, ...failureStatus(fieldsRes) };

    const raw = Array.isArray(fieldsRes.data) ? fieldsRes.data : [];
    const seen = new Set<string>();
    const all: z.infer<typeof fieldSchema>[] = [];
    for (const f of raw) {
      const name = str(f.name);
      // BambooHR splits currency fields into "X" and "X - Currency code"; the
      // companion row is noise once the money parser handles both halves.
      if (!name || / - Currency code$/.test(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      all.push({
        name,
        type: str(f.type),
        custom: !str(f.alias),
        restricted: RESTRICTED_RE.test(name),
      });
    }

    const matched = input.search
      ? all.filter((f) =>
          f.name.toLowerCase().includes(input.search?.toLowerCase() as string),
        )
      : all;

    const tables = (
      tablesRes?.ok && Array.isArray(tablesRes.data) ? tablesRes.data : []
    )
      .map((t) => ({
        name: str(t.alias) ?? "",
        fields: (t.fields ?? [])
          .map((f) => str(f.name))
          .filter((n): n is string => !!n),
      }))
      .filter((t) => t.name)
      .filter(
        (t) =>
          !input.search ||
          JSON.stringify(t).toLowerCase().includes(input.search.toLowerCase()),
      );

    const restricted = matched.filter((f) => f.restricted).length;
    const notes = [
      `BambooHR holds ${all.length} fields on an employee record here${tables.length ? ` and ${tables.length} historical tables` : ""}.`,
    ];
    if (!matched.length && input.search) {
      notes.push(
        `Nothing matches "${input.search}" — worth saying plainly that BambooHR does not appear to track that, rather than guessing.`,
      );
    }
    if (restricted) {
      notes.push(
        `${restricted} of these hold identity or banking details; I can tell you the field exists but I have no tool that reads what is in it.`,
      );
    }

    return {
      ...OK_STATUS,
      ...empty,
      fields: matched.slice(0, input.limit ?? 80),
      totalFields: matched.length,
      tables,
      guidance: notes.join(" "),
    };
  },
});
