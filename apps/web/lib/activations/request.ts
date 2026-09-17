import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ACTIVATION_LIMITS } from './service';

const Mapping = z
  .object({
    invoiceNumber: z.number().int().min(0).max(499),
    issuer: z.number().int().min(0).max(499),
    amount: z.number().int().min(0).max(499),
    currency: z.number().int().min(0).max(499),
    issuedOn: z.number().int().min(0).max(499),
  })
  .refine(
    (value) => new Set(Object.values(value)).size === 5,
    'Cada campo debe usar una columna distinta.',
  );

const text = (max: number) => z.string().trim().min(1).max(max);
const CaseFields = {
  caseTitle: text(180),
  caseObjective: text(1500),
  caseNextAction: text(1000),
};
export const activationDefinitionSchema = z
  .discriminatedUnion('kind', [
    z.object({
      version: z.literal(1),
      name: text(120),
      kind: z.literal('invoice_duplicates'),
      mapping: Mapping,
      caseTitle: text(180).optional(),
      caseObjective: text(1500).optional(),
      caseNextAction: text(1000).optional(),
    }),
    z.object({
      version: z.literal(1),
      name: text(120),
      kind: z.literal('table_rule'),
      rule: z.enum(['duplicates', 'conditions']),
      conditions: z
        .array(
          z.object({
            column: z.number().int().min(0).max(499),
            operator: z.enum([
              'equals',
              'not_equals',
              'contains',
              'is_empty',
              'gt',
              'gte',
              'lt',
              'lte',
              'before_today',
              'after_today',
            ]),
            value: z.string().max(240).optional(),
          }),
        )
        .max(20),
      match: z.enum(['all', 'any']),
      groupBy: z.array(z.number().int().min(0).max(499)).max(10),
      evidenceColumns: z.array(z.number().int().min(0).max(499)).max(20).optional(),
      ...CaseFields,
    }),
  ])
  .superRefine((value, context) => {
    if (value.kind !== 'table_rule') return;
    if (value.rule === 'duplicates' && value.groupBy.length === 0)
      context.addIssue({
        code: 'custom',
        message: 'Elige columnas para agrupar duplicados.',
        path: ['groupBy'],
      });
    if (value.rule === 'conditions' && value.conditions.length === 0)
      context.addIssue({
        code: 'custom',
        message: 'Añade al menos una condición.',
        path: ['conditions'],
      });
    for (const [index, condition] of value.conditions.entries()) {
      if (
        condition.operator !== 'is_empty' &&
        !condition.value?.trim() &&
        !['before_today', 'after_today'].includes(condition.operator)
      )
        context.addIssue({
          code: 'custom',
          message: 'La condición requiere un valor.',
          path: ['conditions', index, 'value'],
        });
    }
  });

export function validateDefinitionColumns(
  definition: z.infer<typeof activationDefinitionSchema>,
  columnCount: number,
) {
  const columns =
    definition.kind === 'invoice_duplicates'
      ? Object.values(definition.mapping)
      : [
          ...definition.conditions.map((condition) => condition.column),
          ...definition.groupBy,
          ...(definition.evidenceColumns ?? []),
        ];
  return columns.every((column) => column < columnCount);
}

export const activationRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('simulate'),
    sourceId: z.string().uuid(),
    sheetIndex: z
      .number()
      .int()
      .min(0)
      .max(ACTIVATION_LIMITS.maxSheets - 1),
    definition: activationDefinitionSchema,
  }),
  z.object({
    action: z.literal('commit'),
    runId: z.string().uuid(),
    shareConfirmed: z.literal(true),
  }),
]);

export function isSameOrigin(req: Pick<NextRequest, 'headers' | 'nextUrl'>) {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = req.headers.get('origin');
  return !origin || origin === req.nextUrl.origin;
}
