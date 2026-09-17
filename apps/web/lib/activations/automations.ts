import { z } from 'zod';
import type { ActivationDefinition } from './types';

export const automationInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    runId: z.string().uuid(),
    trigger: z.enum(['on_change', 'scheduled']),
    intervalMinutes: z.union([z.literal(60), z.literal(360), z.literal(1440), z.literal(10080)]),
    shareConfirmed: z.literal(true),
  }),
  z.object({ action: z.literal('pause'), id: z.string().uuid() }),
  z.object({ action: z.literal('resume'), id: z.string().uuid() }),
]);
export function recurringDefinitionError(definition: ActivationDefinition): string | null {
  if (
    definition.kind === 'table_rule' &&
    definition.rule === 'conditions' &&
    !definition.identityColumns?.length
  )
    return 'Elige las columnas que identifican cada registro para evitar asuntos repetidos entre versiones.';
  return null;
}
export function sameHeaders(approved: string[], current: unknown[]): boolean {
  return (
    approved.length === current.length &&
    approved.every((header, index) => header === String(current[index] ?? '').trim())
  );
}
export function automationSummary(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    trigger: row.trigger,
    intervalMinutes: row.interval_minutes,
    lastCheckedAt: row.last_checked_at,
    lastResult: row.last_result,
    nextRunAt: row.next_run_at,
    sourceConnectionId: row.source_connection_id,
  };
}
