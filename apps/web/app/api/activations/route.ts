import { createHash } from 'node:crypto';
import { activationRequestSchema, isSameOrigin } from '@/lib/activations/request';
import {
  ACTIVATION_LIMITS,
  ActivationError,
  type PreparedViewRow,
  type StoredRun,
  activationSource,
  attachPreparedEvidence,
  createSimulation,
  mapRun,
  readOwnedPreparedViews,
  readOwnedTableSources,
  simulateDefinition,
  sourceSnapshot,
  textSourceSnapshot,
} from '@/lib/activations/service';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function responseError(error: unknown) {
  if (error instanceof ActivationError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: 'No se pudo completar la activación.' }, { status: 503 });
}

export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const [sources, runs, views] = await Promise.all([
      readOwnedTableSources(db, user.id),
      db
        .from('activation_runs')
        .select(
          'id,source_id,source_name,prepared_view_id,identity_namespace,sheet_index,sheet_name,definition,mapping,candidates,status,created_at,committed_at,case_ids',
        )
        .eq('actor_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50),
      readOwnedPreparedViews(db, user.id),
    ]);
    if (runs.error) throw new ActivationError('No se pudo cargar el historial.', 503);
    const preparedViews = views;
    return NextResponse.json({
      sources: sources.map((source) => activationSource(source, preparedViews)),
      runs: ((runs.data ?? []) as StoredRun[])
        .filter((run) => sources.some((source) => source.id === run.source_id))
        .map(mapRun),
      limits: ACTIVATION_LIMITS,
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json({ error: 'Origen de solicitud inválido.' }, { status: 403 });
  const user = await requireSession();
  const parsed = activationRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'La solicitud de activación no es válida.' },
      { status: 400 },
    );
  const db = getOrgScopedClient(user.organization.id);
  const body = parsed.data;
  try {
    if (body.action === 'simulate') {
      const sources = await readOwnedTableSources(db, user.id);
      const source = sources.find((item) => item.id === body.sourceId);
      if (!source)
        throw new ActivationError('La fuente no existe, venció o pertenece a otra persona.', 404);
      let view: PreparedViewRow | null = null;
      if (body.viewId) {
        const selected = await db
          .from('feed_prepared_views')
          .select('id,source_id,name,table_data,evidence,source_snapshot,created_at')
          .eq('id', body.viewId)
          .eq('source_id', source.id)
          .eq('actor_id', user.id)
          .maybeSingle();
        if (selected.error) throw new ActivationError('No se pudo abrir la vista preparada.', 503);
        if (!selected.data)
          throw new ActivationError('La vista preparada no está disponible.', 404);
        view = selected.data as PreparedViewRow;
      }
      const run = await createSimulation(
        db,
        user.id,
        source,
        body.viewId ? 0 : body.sheetIndex,
        body.definition,
        { preparedView: view },
      );
      return NextResponse.json({ run }, { status: 201 });
    }
    return await commitRun(db, user.id, body.runId);
  } catch (error) {
    return responseError(error);
  }
}

async function commitRun(
  db: ReturnType<typeof getOrgScopedClient>,
  actorId: string,
  runId: string,
) {
  const selected = await db
    .from('activation_runs')
    .select(
      'id,source_id,source_name,source_snapshot,prepared_view_id,identity_namespace,sheet_index,sheet_name,definition,mapping,mapping_snapshot,candidates,status,created_at,committed_at,case_ids',
    )
    .eq('id', runId)
    .eq('actor_id', actorId)
    .maybeSingle();
  if (selected.error) throw new ActivationError('No se pudo abrir la simulación.', 503);
  if (!selected.data)
    throw new ActivationError('La simulación no existe en esta empresa o para esta persona.', 404);
  const run = selected.data as StoredRun & { source_snapshot: string; mapping_snapshot: string };
  if (run.status === 'committed')
    return NextResponse.json({ run: mapRun(run), created: 0, reused: run.case_ids?.length ?? 0 });

  const sources = await readOwnedTableSources(db, actorId);
  const source = sources.find((item) => item.id === run.source_id);
  if (!source)
    throw new ActivationError('La fuente venció o dejó de estar disponible. Simula otra vez.', 409);
  let sheet = source.feed_tables?.[run.sheet_index];
  let preparedView: PreparedViewRow | null = null;
  let identity = run.identity_namespace ?? source.feed_content_hash ?? sourceSnapshot(source);
  if (run.prepared_view_id) {
    const selectedView = await db
      .from('feed_prepared_views')
      .select('id,source_id,name,table_data,evidence,source_snapshot,created_at')
      .eq('id', run.prepared_view_id)
      .eq('source_id', source.id)
      .eq('actor_id', actorId)
      .maybeSingle();
    if (selectedView.error)
      throw new ActivationError('No se pudo revisar la vista preparada.', 503);
    if (!selectedView.data)
      throw new ActivationError('La vista preparada dejó de estar disponible.', 409);
    const view = selectedView.data as PreparedViewRow;
    preparedView = view;
    if (
      view.source_snapshot !== run.source_snapshot ||
      textSourceSnapshot(source) !== run.source_snapshot
    )
      throw new ActivationError(
        'El texto original cambió. Prepara otra vista antes de compartir.',
        409,
      );
    sheet = view.table_data;
    identity = run.identity_namespace ?? view.source_snapshot;
  } else if (sourceSnapshot(source) !== run.source_snapshot) {
    throw new ActivationError('La fuente cambió. Simula otra vez antes de compartir.', 409);
  }
  if (digest(run.definition) !== run.mapping_snapshot)
    throw new ActivationError('La regla cambió. Simula otra vez antes de compartir.', 409);
  if (!sheet) throw new ActivationError('La hoja dejó de estar disponible. Simula otra vez.', 409);
  const simulated = simulateDefinition(identity, sheet, run.definition);
  const current = preparedView ? attachPreparedEvidence(simulated, preparedView) : simulated;
  if (digest(current) !== digest(run.candidates))
    throw new ActivationError('Los datos cambiaron. Revisa una simulación nueva.', 409);

  const committed = await db.rpc('activation_commit_run', {
    p_actor_id: actorId,
    p_run_id: run.id,
    p_expected_source_snapshot: run.source_snapshot,
  });
  if (committed.error)
    throw new ActivationError(
      committed.error.code === 'P0001'
        ? committed.error.message
        : 'No se pudieron crear los asuntos.',
      committed.error.message?.includes('No hay filas válidas') ? 422 : 503,
    );
  const result = committed.data as { caseIds: string[]; created: number; reused: number };
  const updated = {
    ...run,
    status: 'committed' as const,
    committed_at: new Date().toISOString(),
    case_ids: result.caseIds,
  };
  return NextResponse.json({
    run: mapRun(updated),
    created: result.created,
    reused: result.reused,
  });
}
