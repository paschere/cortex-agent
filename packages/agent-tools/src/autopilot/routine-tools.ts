import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { modelClassifier } from '../ledger/categorize';
import { categorizePending } from '../ledger/store';
import { resolvePerson } from '../work/shape';
import { workDirectory } from '../work/store';

/**
 * LAS HERRAMIENTAS RUTINARIAS DEL PILOTO: pequeñas, internas y que se pueden
 * repetir sin daño. El piloto las usa por `runTool` como cualquier otra (con su
 * auditoría, su puerta de seguridad y su guardia de repetición), y también
 * sirven en el chat:
 *
 *   autopilot.remind           recordarle algo a alguien del equipo, en su
 *                              campana. Nunca sale de la empresa.
 *   trackers.retry_sync        volver a correr ya una carpeta de Drive o una
 *                              sincronización de tabla que falló.
 *   ledger.categorize_pending  ponerle categoría a lo que no tiene en el libro
 *                              de plata (nunca cambia una que ya tenga).
 *
 * Las tres van en `ROUTINE_TOOL_IDS` (policy.ts): con el área en «hacer», el
 * piloto las hace sin mandato.
 */

const INTERNAL_HREF = z
  .string()
  .trim()
  .max(400)
  .refine(
    (v) => v.startsWith('/') && !v.startsWith('//'),
    'Usa una ruta interna, como /commitments.',
  );

export const autopilotRemind = registerTool({
  id: 'autopilot.remind',
  description:
    'Remind a teammate of something in their Cortex notification bell («recuérdale a Laura que el SOAT del camión vence el jueves», «avísale a Andrés que tiene que aprobar el cobro»). Internal only: it never emails or messages anyone outside the company, and only reaches people in this workspace. Pass the person (name, email or id), a one-line title, and optionally a body and the internal page it is about.',
  inputSchema: z.object({
    person: z.string().trim().min(1).max(160).describe('Name, email or user id of the teammate'),
    title: z.string().trim().min(3).max(160).describe('What to remind them, in one line'),
    body: z.string().trim().max(600).optional(),
    href: INTERNAL_HREF.optional().describe('Internal page it is about, e.g. /commitments'),
    key: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe('Stable id of the thing reminded about, so the same reminder is not repeated'),
  }),
  outputSchema: z.object({
    queued: z.boolean(),
    person: z.string(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const people = await workDirectory(ctx.db);
    const match = resolvePerson(people, input.person);
    if (match.kind === 'ambiguous')
      throw new ValidationError(
        `«${match.label}» puede ser ${match.candidates.map((c) => c.label).join(' o ')}. ¿A quién?`,
      );
    if (match.kind !== 'found')
      throw new NotFoundError(`No encuentro a «${input.person}» en el equipo de esta empresa.`);
    const key =
      input.key ??
      createHash('sha256')
        .update(`${match.id}|${input.title}|${input.body ?? ''}`)
        .digest('hex')
        .slice(0, 32);
    const queued = Boolean(
      await ctx.enqueueJob?.('autopilot/remind', {
        organizationId: ctx.organizationId,
        userId: match.id,
        title: input.title,
        body: input.body ?? null,
        href: input.href ?? null,
        dedupeKey: `autopilot:remind:${key}`.slice(0, 200),
        by: ctx.userId,
      }),
    );
    if (!queued)
      throw new Error('No pude dejar el recordatorio en la cola. Intenta de nuevo en un momento.');
    return {
      queued,
      person: match.label,
      markdown: `Listo: le dejé el recordatorio a ${match.label} en su campana.`,
    };
  },
});

export const trackersRetrySync = registerTool({
  id: 'trackers.retry_sync',
  description:
    'Run again, right now, a Google Drive folder reading or a table synchronization that failed or is waiting («vuelve a leer la carpeta de facturas», «reintenta la sincronización de la tabla de despachos»). Use trackers.drive_syncs or trackers.syncs first to get the id. It does not change the configuration; for an accounting program use accounting.sync_now.',
  inputSchema: z.object({
    kind: z.enum(['drive_folder', 'table_sync']),
    syncId: z.string().uuid(),
  }),
  outputSchema: z.object({ queued: z.boolean(), markdown: z.string() }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const table = input.kind === 'drive_folder' ? 'drive_folder_syncs' : 'tracker_syncs';
    const { data, error } = await ctx.db
      .from(table)
      .update({ next_run_at: new Date().toISOString() })
      .eq('id', input.syncId)
      .eq('enabled', true)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data)
      throw new NotFoundError(
        'No encuentro esa sincronización activa en esta empresa (o está en pausa).',
      );
    const queued = Boolean(
      await ctx.enqueueJob?.(input.kind === 'drive_folder' ? 'drive-table/run' : 'table-sync/run', {
        organizationId: ctx.organizationId,
        syncId: input.syncId,
      }),
    );
    return {
      queued,
      markdown: queued
        ? 'Listo: la estoy corriendo otra vez. Si vuelve a fallar, te aviso en la campana.'
        : 'La dejé marcada para la próxima vuelta del trabajo programado (como mucho en unos minutos).',
    };
  },
});

export const ledgerCategorizePending = registerTool({
  id: 'ledger.categorize_pending',
  description:
    'Put a category on the money-ledger movements that still have none («categoriza lo que falta en el libro», «ordena los movimientos sin categoría»): first the company rules, then what was already decided for the same counterparty, then the model for the rest (at most 40 per call). It never changes a movement that already has a category — to correct one use ledger.recategorize.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    byRule: z.number(),
    byMemory: z.number(),
    byModel: z.number(),
    pending: z.number(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 4 },
  handler: async (_input, ctx) => {
    const r = await categorizePending(ctx.db, { classifier: modelClassifier, maxModelItems: 40 });
    const done = r.byRule + r.byMemory + r.byModel;
    return {
      byRule: r.byRule,
      byMemory: r.byMemory,
      byModel: r.byModel,
      pending: r.pending,
      markdown:
        done === 0
          ? r.pending > 0
            ? `No pude categorizar ninguno: quedan ${r.pending} sin categoría.${r.modelError ? ` (${r.modelError})` : ''}`
            : 'No había movimientos sin categoría.'
          : `Categoricé ${done} (${r.byRule} por regla, ${r.byMemory} por lo ya decidido y ${r.byModel} con el modelo).${r.pending > 0 ? ` Quedan ${r.pending} sin categoría.` : ''}`,
    };
  },
});
