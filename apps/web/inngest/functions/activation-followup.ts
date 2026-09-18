import { sameHeaders } from '@/lib/activations/automations';
import { prepareSourceView } from '@/lib/activations/prepare';
import { activationDefinitionSchema } from '@/lib/activations/request';
import {
  ActivationError,
  type PreparedViewRow,
  createSimulation,
  readOwnedPreparedViews,
  readOwnedTableSources,
  sourceSnapshot,
} from '@/lib/activations/service';
import { refreshFeedSource } from '@/lib/feed/api-source';
import { CombinedSourceError } from '@/lib/feed/combined-source';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { checkMeter, isRefused } from '@cortex/agent-tools';
import { z } from 'zod';

// Only due job IDs and tenant IDs cross this install-wide dispatcher.
export const activationDispatchJob: JobHandler = async ({ step }) => {
  const { data, error } = await getSupabaseServiceClient()
    .from('activation_automations')
    .select('id,organization_id')
    .eq('status', 'active')
    .lte('next_run_at', new Date().toISOString())
    .order('next_run_at', { ascending: true })
    .limit(100);
  if (error) throw new Error('No se pudo revisar el seguimiento pendiente.');
  const events = (data ?? []).map((row) => ({
    name: 'activations/run',
    data: { automationId: row.id, organizationId: row.organization_id },
  }));
  if (events.length)
    await (step.sendEventStrict ?? step.sendEvent).call(
      step,
      'dispatch-activation-followup',
      events,
    );
  return { dispatched: events.length };
};
const eventSchema = z.object({
  automationId: z.string().uuid(),
  organizationId: z.string().min(1),
});
export const activationRunJob: JobHandler = async ({ event }) => {
  const input = eventSchema.parse(event.data);
  const db = getOrgScopedClient(input.organizationId);
  const claim = await db.rpc('activation_automation_claim', { p_id: input.automationId });
  if (claim.error) throw new Error('No se pudo reservar la ejecución.');
  const automation = claim.data;
  if (!automation) return { skipped: true };
  let sourceRevision: number | null = null;
  const finish = async (
    result: Record<string, unknown>,
    fingerprint: string | null,
    needsReview = false,
    runId: string | null = null,
  ) => {
    const completed = await db.rpc('activation_automation_finish', {
      p_id: automation.id,
      p_token: automation.lease_token,
      p_fingerprint: fingerprint,
      p_result: result,
      p_needs_review: needsReview,
      p_run_id: runId,
      p_source_revision: sourceRevision,
    });
    if (completed.error)
      throw new Error('La ejecución perdió su autorización o no pudo guardarse.');
    return completed.data;
  };
  try {
    const connection = await db
      .from('feed_sources')
      .select('id,kind,latest_attachment_id,signal_revision')
      .eq('id', automation.source_connection_id)
      .eq('actor_id', automation.actor_id)
      .eq('enabled', true)
      .single();
    if (connection.error || !connection.data)
      throw new ActivationError('Revisa la conexión de la fuente.', 409);
    sourceRevision = connection.data.signal_revision ?? 0;
    if (['api', 'url', 'google_sheet', 'combined'].includes(connection.data.kind))
      await refreshFeedSource(db, automation.actor_id, connection.data.id, input.organizationId);
    const current = await db
      .from('feed_sources')
      .select('latest_attachment_id')
      .eq('id', connection.data.id)
      .eq('actor_id', automation.actor_id)
      .single();
    if (current.error) throw new Error('No se pudo consultar la versión de la fuente.');
    const source = (await readOwnedTableSources(db, automation.actor_id)).find(
      (s) => s.id === current.data?.latest_attachment_id,
    );
    if (!source)
      throw new ActivationError(
        'La captura venció o fue eliminada. Añade una versión desde Feed y revisa la activación.',
        409,
      );
    if (source.feed_truncated)
      throw new ActivationError(
        'La fuente está incompleta. Acota la consulta antes de activar el seguimiento.',
        409,
      );
    // Fingerprints are content based, never capture timestamps or attachment IDs.
    const fingerprint = source.feed_content_hash ?? sourceSnapshot(source);
    const schema = automation.approved_schema as {
      headers: string[];
      sheetIndex: number;
      prompt: string | null;
    };
    let view: PreparedViewRow | undefined;
    if (schema.prompt) {
      const cached = await db
        .from('feed_prepared_views')
        .select('id,source_id,name,table_data,evidence,source_snapshot,created_at')
        .eq('actor_id', automation.actor_id)
        .eq('source_id', source.id)
        .eq('prompt', schema.prompt)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cached.error) throw new Error('No se pudo cargar la lectura aprobada.');
      const candidate = cached.data as PreparedViewRow | null;
      view =
        candidate && sameHeaders(schema.headers, candidate.table_data.rows[0] ?? [])
          ? candidate
          : undefined;
      if (!view) {
        if (isRefused(await checkMeter(db, 'answers')))
          throw new ActivationError(
            'No quedan respuestas disponibles para preparar esta fuente.',
            409,
          );
        const prepared = await prepareSourceView(
          db,
          automation.actor_id,
          source,
          schema.prompt,
          AbortSignal.timeout(90000),
          { approvedHeaders: schema.headers },
        );
        if (prepared.status !== 'ready')
          throw new ActivationError(
            'La nueva versión necesita revisión: no se pudo conservar la lectura aprobada.',
            409,
          );
        view = (await readOwnedPreparedViews(db, automation.actor_id)).find(
          (v) => v.id === prepared.viewId,
        );
      }
      if (!view) throw new ActivationError('No se pudo verificar la lectura de la fuente.', 409);
    }
    const sheet = view?.table_data ?? source.feed_tables?.[schema.sheetIndex];
    if (!sheet || !sameHeaders(schema.headers, sheet.rows[0] ?? []))
      throw new ActivationError(
        'Las columnas cambiaron. Revisa la regla y simula la nueva versión antes de continuar.',
        409,
      );
    // A fingerprint match can skip rule evaluation, but it cannot skip the
    // approved-schema fence: metadata may be stale or have been tampered with.
    if (automation.trigger === 'on_change' && automation.last_fingerprint === fingerprint)
      return await finish({ message: 'La fuente no cambió.', outcome: 'unchanged' }, fingerprint);
    const run = await createSimulation(
      db,
      automation.actor_id,
      source,
      view ? 0 : schema.sheetIndex,
      activationDefinitionSchema.parse(automation.definition),
      { preparedView: view, sourceIdentityOverride: `automation:${automation.id}` },
    );
    const invalid = run.candidates.filter((c) => c.status === 'invalid').length;
    if (invalid)
      return await finish(
        {
          message: 'Hay registros incompletos o incompatibles. Revisa la simulación.',
          outcome: 'needs_review',
          runId: run.id,
          invalid,
        },
        null,
        true,
      );
    const matched = run.candidates.filter((c) => c.status === 'matched').length;
    return await finish(
      {
        message: matched
          ? 'Revisión completada; asuntos preparados con evidencia.'
          : 'Revisión completada sin coincidencias.',
        outcome: 'checked',
        runId: run.id,
        matched,
      },
      fingerprint,
      false,
      run.id,
    );
  } catch (error) {
    // A revoked lease cannot publish or finish. A transient failure remains due
    // next interval; a changed schema requires an explicit fresh authorization.
    const needsReview =
      error instanceof ActivationError ||
      (error instanceof CombinedSourceError && error.status < 500);
    return finish(
      {
        message:
          needsReview && error instanceof Error
            ? error.message
            : 'No se pudo revisar la fuente. Se intentará de nuevo en la próxima revisión.',
        outcome: 'error',
      },
      null,
      needsReview,
    );
  }
};
export const activationDispatch = inngest.createFunction(
  { id: 'activation-followup-dispatch' },
  { cron: '*/5 * * * *' },
  async (ctx) => activationDispatchJob(ctx as unknown as JobContext),
);
export const activationRun = inngest.createFunction(
  { id: 'activation-followup-run', concurrency: 3 },
  { event: 'activations/run' },
  async (ctx) => activationRunJob(ctx as unknown as JobContext),
);
